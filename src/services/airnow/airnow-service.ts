/**
 * @fileoverview AirNow API service for current observations and issued forecasts.
 * Wraps the 2026 www.airnowapi.org/aq web services `observation/current/ziplatlong/`
 * and `forecast/current/`. Responses cached at ~1 hour TTL per the AirNow API's
 * recommendation to avoid rate-limiting.
 * @module services/airnow/airnow-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  serializationError,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  AirNowLocation,
  AirQualityArea,
  AirQualityLookup,
  RawForecast,
  RawObservation,
} from './types.js';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** The six AirNow AQI descriptors (lowercased) and their category numbers. */
const AQI_CATEGORY_NUMBERS = new Map([
  ['good', 1],
  ['moderate', 2],
  ['unhealthy for sensitive groups', 3],
  ['unhealthy', 4],
  ['very unhealthy', 5],
  ['hazardous', 6],
]);

/** A parsed AirNow body: an array of records, or AirNow's own explanation of why there are none. */
type AirNowBody = { rows: unknown[] } | { noDataMessage: string };

/** The message(s) of an `{"WebServiceError":[{"Message":…}]}` body; undefined for any other shape. */
function webServiceErrorMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('WebServiceError' in body)) return;
  const entries = body.WebServiceError;
  if (!Array.isArray(entries)) return;
  const messages = entries.flatMap((entry) =>
    typeof entry?.Message === 'string' && entry.Message.trim() !== '' ? [entry.Message] : [],
  );
  return messages.length > 0 ? messages.join(' ') : undefined;
}

/** Classify a 200 body. Anything but a record array or a WebServiceError message fails loudly. */
function parseBody(text: string): AirNowBody {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (cause) {
    throw serializationError('AirNow returned a response that is not JSON.', undefined, { cause });
  }
  if (Array.isArray(body)) return { rows: body };
  const noDataMessage = webServiceErrorMessage(body);
  if (noDataMessage !== undefined) return { noDataMessage };
  throw serializationError(
    'AirNow returned an unrecognized response: expected an array of records or a WebServiceError message.',
  );
}

/** An AQI value, or undefined when upstream sent none (forecasts use -1 for category-only). */
function validAqi(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Group observation records by reporting area and observed hour; one reading per pollutant. */
function normalizeObservations(rows: RawObservation[]): AirQualityArea[] {
  const areas = new Map<string, AirQualityArea>();
  for (const r of rows) {
    const aqi = validAqi(r.nowcastAQI);
    if (!r.parameterName || (aqi === undefined && !r.aqiCategoryName)) continue;
    const key = [r.reportingAreaName, r.dateObserved, r.hourObserved, r.localTimeZone].join('|');
    let area = areas.get(key);
    if (!area) {
      area = {
        ...(r.reportingAreaName && { reportingArea: r.reportingAreaName }),
        ...(r.dateObserved && { dateObserved: r.dateObserved }),
        ...(r.hourObserved && { hourObserved: r.hourObserved }),
        ...(r.localTimeZone && { localTimeZone: r.localTimeZone }),
        readings: [],
      };
      areas.set(key, area);
    }
    const categoryNumber = r.aqiCategoryName
      ? AQI_CATEGORY_NUMBERS.get(r.aqiCategoryName.trim().toLowerCase())
      : undefined;
    area.readings.push({
      parameterName: r.parameterName,
      ...(aqi !== undefined && { aqi }),
      ...(r.aqiCategoryName && { categoryName: r.aqiCategoryName }),
      ...(categoryNumber !== undefined && { categoryNumber }),
      ...(r.siteName && { siteName: r.siteName }),
      ...(r.siteID && { siteID: r.siteID }),
      ...(r.reportingAgency && { reportingAgency: r.reportingAgency }),
    });
  }
  return [...areas.values()];
}

/** Group forecast records by reporting area; one reading per pollutant per valid date. */
function normalizeForecasts(rows: RawForecast[]): AirQualityArea[] {
  const areas = new Map<string, AirQualityArea>();
  for (const r of rows) {
    const aqi = validAqi(r.aqi);
    if (
      !r.parameterName ||
      (aqi === undefined && !r.categoryName && r.categoryNumber === undefined)
    ) {
      continue;
    }
    const key = r.reportingAreaCode ?? r.reportingArea ?? '';
    let area = areas.get(key);
    if (!area) {
      area = {
        ...(r.reportingArea && { reportingArea: r.reportingArea }),
        ...(r.reportingAreaCode && { reportingAreaCode: r.reportingAreaCode }),
        ...(r.stateCode && { stateCode: r.stateCode }),
        readings: [],
      };
      areas.set(key, area);
    }
    // AirNow repeats the area's discussion on every row; keep it once, verbatim.
    if (!area.discussion && r.discussion) area.discussion = r.discussion;
    area.readings.push({
      parameterName: r.parameterName,
      ...(aqi !== undefined && { aqi }),
      ...(r.categoryNumber !== undefined && { categoryNumber: r.categoryNumber }),
      ...(r.categoryName && { categoryName: r.categoryName }),
      ...(r.dateIssue && { dateIssue: r.dateIssue }),
      ...(r.dateValid && { dateValid: r.dateValid }),
      ...(r.forecastAgency && { forecastAgency: r.forecastAgency }),
      ...(typeof r.actionDay === 'boolean' && { actionDay: r.actionDay }),
    });
  }
  return [...areas.values()];
}

export class AirNowService {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(_config: AppConfig, _storage: StorageService) {
    const serverConfig = getServerConfig();
    // initAirNowService() is only wired up when the key is configured (see index.ts).
    // Assert the invariant here so the type narrows and any misuse fails loudly.
    if (!serverConfig.airNowApiKey) {
      throw new Error(
        'AirNowService requires AIRNOW_API_KEY — initAirNowService() must only run when the key is configured.',
      );
    }
    this.baseUrl = serverConfig.airNowBaseUrl;
    this.apiKey = serverConfig.airNowApiKey;
  }

  /** Current hourly observations: per pollutant, the closest monitor within AirNow's 50-mile boundary. */
  async getCurrent(location: AirNowLocation, ctx: Context): Promise<AirQualityLookup> {
    const body = await this.fetchBody('observation', location, ctx);
    return 'noDataMessage' in body
      ? { areas: [], noDataMessage: body.noDataMessage }
      : { areas: normalizeObservations(body.rows as RawObservation[]) };
  }

  /** Every forecast day the location's reporting area has issued. */
  async getForecast(location: AirNowLocation, ctx: Context): Promise<AirQualityLookup> {
    const body = await this.fetchBody('forecast', location, ctx);
    return 'noDataMessage' in body
      ? { areas: [], noDataMessage: body.noDataMessage }
      : { areas: normalizeForecasts(body.rows as RawForecast[]) };
  }

  private buildUrl(path: string, params: Record<string, string | number>): string {
    const url = new URL(`${this.baseUrl}/${path}`);
    url.searchParams.set('format', 'application/json');
    url.searchParams.set('API_KEY', this.apiKey);
    for (const [key, val] of Object.entries(params)) {
      url.searchParams.set(key, String(val));
    }
    return url.toString();
  }

  private cacheKey(kind: string, params: Record<string, string | number>): string {
    const stable = Object.entries(params)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}-${String(v).replace(/[^a-zA-Z0-9_.\-/]/g, '_')}`)
      .join('_');
    // Use '/' as segment separator and replace ':' in kind to keep within [a-zA-Z0-9_.\-/]
    const safeKind = kind.replace(/:/g, '/');
    return `airnow/${safeKind}/${stable}`;
  }

  private async fetchBody(
    service: 'observation' | 'forecast',
    location: AirNowLocation,
    ctx: Context,
  ): Promise<AirNowBody> {
    const params =
      location.kind === 'zip'
        ? { zipCode: location.zipCode }
        : { latitude: location.latitude, longitude: location.longitude };
    const cacheKey = this.cacheKey(`${service}:${location.kind}`, params);

    const cached = await ctx.state.get<{ body: AirNowBody; expiresAt: number }>(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      ctx.log.debug('AirNow cache hit', { cacheKey });
      return cached.body;
    }

    const path =
      service === 'observation' ? 'observation/current/ziplatlong/' : 'forecast/current/';
    const url = this.buildUrl(path, params);
    ctx.log.debug('AirNow request', { service, ...params });

    const body = await withRetry(
      async () => {
        const response = await fetch(url, { signal: ctx.signal });
        // A ZIP is the only caller-supplied input on a ZIP request, so a 400 rejects it.
        if (response.status === 400 && location.kind === 'zip') {
          const upstream = await response.text();
          let detail: string | undefined;
          try {
            detail = webServiceErrorMessage(JSON.parse(upstream));
          } catch {
            // Non-JSON 400 body: report the status alone.
          }
          throw validationError(
            `AirNow rejected zip_code "${location.zipCode}": ${detail ?? 'HTTP 400'}.`,
            { reason: 'invalid_zip_code', zipCode: location.zipCode },
          );
        }
        if (!response.ok) {
          throw await httpErrorFromResponse(response, { service: 'AirNow' });
        }
        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable(
            'AirNow API returned HTML instead of JSON — likely rate-limited.',
          );
        }
        return parseBody(text);
      },
      {
        operation: 'AirNowService.fetch',
        baseDelayMs: 2000,
        signal: ctx.signal,
      },
    );

    await ctx.state.set(cacheKey, { body, expiresAt: Date.now() + CACHE_TTL_MS });
    return body;
  }
}

// --- Init/accessor pattern ---

let _service: AirNowService | undefined;

export function initAirNowService(config: AppConfig, storage: StorageService): void {
  _service = new AirNowService(config, storage);
}

export function getAirNowService(): AirNowService {
  if (!_service) {
    throw new Error('AirNowService not initialized — call initAirNowService() in setup()');
  }
  return _service;
}
