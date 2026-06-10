/**
 * @fileoverview AirNow API service for real-time and forecast air quality data.
 * Wraps www.airnowapi.org/aq endpoints. Responses cached at ~1 hour TTL per the
 * AirNow API's recommendation to avoid rate-limiting.
 * @module services/airnow/airnow-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type { AirQualityResult, RawAirNowRecord } from './types.js';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Normalize raw AirNow records (grouped by reporting area) into AirQualityResult[]. */
function normalizeRecords(records: RawAirNowRecord[]): AirQualityResult[] {
  // Group by reporting area + date/hour
  const grouped = new Map<string, AirQualityResult>();

  for (const r of records) {
    const key = `${r.ReportingArea ?? ''}|${r.DateObserved ?? ''}|${r.HourObserved ?? ''}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        ...(r.ReportingArea && { reportingArea: r.ReportingArea.trim() }),
        ...(r.StateCode && { stateCode: r.StateCode }),
        ...(r.Latitude !== undefined && { latitude: r.Latitude }),
        ...(r.Longitude !== undefined && { longitude: r.Longitude }),
        ...(r.DateObserved && { dateObserved: r.DateObserved.trim() }),
        ...(r.HourObserved !== undefined && { hourObserved: r.HourObserved }),
        ...(r.LocalTimeZone && { localTimeZone: r.LocalTimeZone }),
        readings: [],
      });
    }
    const entry = grouped.get(key)!;
    if (r.ParameterName && r.AQI !== undefined) {
      entry.readings.push({
        parameterName: r.ParameterName,
        aqi: r.AQI,
        ...(r.Category?.Number !== undefined && { categoryNumber: r.Category.Number }),
        ...(r.Category?.Name && { categoryName: r.Category.Name }),
      });
    }
  }

  return Array.from(grouped.values());
}

export class AirNowService {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(_config: AppConfig, _storage: StorageService) {
    const serverConfig = getServerConfig();
    this.baseUrl = serverConfig.airNowBaseUrl;
    this.apiKey = serverConfig.airNowApiKey;
  }

  private buildUrl(path: string, params: Record<string, string | number | undefined>): string {
    const url = new URL(`${this.baseUrl}/${path}`);
    url.searchParams.set('format', 'application/json');
    url.searchParams.set('API_KEY', this.apiKey);
    for (const [key, val] of Object.entries(params)) {
      if (val !== undefined && val !== '') {
        url.searchParams.set(key, String(val));
      }
    }
    return url.toString();
  }

  private cacheKey(kind: string, params: Record<string, string | number | undefined>): string {
    const stable = Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}-${String(v).replace(/[^a-zA-Z0-9_.\-/]/g, '_')}`)
      .join('_');
    // Use '/' as segment separator and replace ':' in kind to keep within [a-zA-Z0-9_.\-/]
    const safeKind = kind.replace(/:/g, '/');
    return `airnow/${safeKind}/${stable}`;
  }

  private async fetchWithCache(
    url: string,
    cacheKey: string,
    ctx: Context,
  ): Promise<RawAirNowRecord[]> {
    // Try cache first
    const cached = await ctx.state.get<{ data: RawAirNowRecord[]; expiresAt: number }>(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      ctx.log.debug('AirNow cache hit', { cacheKey });
      return cached.data;
    }

    const data = await withRetry(
      async () => {
        const response = await fetch(url, { signal: ctx.signal });
        if (!response.ok) {
          throw await httpErrorFromResponse(response, { service: 'AirNow', data: { url } });
        }
        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable(
            'AirNow API returned HTML instead of JSON — likely rate-limited.',
            { url },
          );
        }
        const parsed = JSON.parse(text) as unknown;
        return Array.isArray(parsed) ? (parsed as RawAirNowRecord[]) : [];
      },
      {
        operation: 'AirNowService.fetch',
        baseDelayMs: 2000,
        signal: ctx.signal,
      },
    );

    // Store in cache
    await ctx.state.set(cacheKey, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    return data;
  }

  /** Get current air quality by ZIP code. */
  async getCurrentByZip(
    params: {
      zipCode: string;
      distanceMiles?: number;
    },
    ctx: Context,
  ): Promise<AirQualityResult[]> {
    const qparams = { zipCode: params.zipCode, distance: params.distanceMiles ?? 25 };
    const url = this.buildUrl('observation/zipCode/current/', qparams);
    const ck = this.cacheKey('current:zip', qparams);
    ctx.log.debug('AirNow current by ZIP', { zipCode: params.zipCode });
    const records = await this.fetchWithCache(url, ck, ctx);
    return normalizeRecords(records);
  }

  /** Get current air quality by lat/lng. */
  async getCurrentByLatLng(
    params: {
      latitude: number;
      longitude: number;
      distanceMiles?: number;
    },
    ctx: Context,
  ): Promise<AirQualityResult[]> {
    const qparams = {
      latitude: params.latitude,
      longitude: params.longitude,
      distance: params.distanceMiles ?? 25,
    };
    const url = this.buildUrl('observation/latLong/current/', qparams);
    const ck = this.cacheKey('current:latlng', qparams);
    ctx.log.debug('AirNow current by lat/lng', { lat: params.latitude, lng: params.longitude });
    const records = await this.fetchWithCache(url, ck, ctx);
    return normalizeRecords(records);
  }

  /** Get air quality forecast by ZIP code. */
  async getForecastByZip(
    params: {
      zipCode: string;
      date: string;
      distanceMiles?: number;
    },
    ctx: Context,
  ): Promise<AirQualityResult[]> {
    const qparams = {
      zipCode: params.zipCode,
      date: params.date,
      distance: params.distanceMiles ?? 25,
    };
    const url = this.buildUrl('forecast/zipCode/', qparams);
    const ck = this.cacheKey('forecast:zip', qparams);
    ctx.log.debug('AirNow forecast by ZIP', { zipCode: params.zipCode, date: params.date });
    const records = await this.fetchWithCache(url, ck, ctx);
    return normalizeRecords(records);
  }

  /** Get air quality forecast by lat/lng. */
  async getForecastByLatLng(
    params: {
      latitude: number;
      longitude: number;
      date: string;
      distanceMiles?: number;
    },
    ctx: Context,
  ): Promise<AirQualityResult[]> {
    const qparams = {
      latitude: params.latitude,
      longitude: params.longitude,
      date: params.date,
      distance: params.distanceMiles ?? 25,
    };
    const url = this.buildUrl('forecast/latLong/', qparams);
    const ck = this.cacheKey('forecast:latlng', qparams);
    ctx.log.debug('AirNow forecast by lat/lng', {
      lat: params.latitude,
      lng: params.longitude,
      date: params.date,
    });
    const records = await this.fetchWithCache(url, ck, ctx);
    return normalizeRecords(records);
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
