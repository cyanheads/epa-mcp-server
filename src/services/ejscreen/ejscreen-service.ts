/**
 * @fileoverview EJScreen environmental-justice service. Wraps the community-maintained
 * EJAM API (`api.ejanalysis.com`), run by Public Environmental Data Partners, which
 * rehosts EJScreen v2.2 (2022) data after EPA discontinued public access in 2025.
 * Calls `POST {base}/data` with a point + buffer and normalizes the ~683-column row.
 * @module services/ejscreen/ejscreen-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  EjDemographicIndicator,
  EjEnvironmentalIndicator,
  EjIndexValue,
  EjscreenResult,
  RawEjamRow,
} from './types.js';

/** Provenance + vintage string surfaced on every result and in user-facing copy. */
export const EJSCREEN_DATA_SOURCE =
  'EJScreen v2.2 (2022 data) via the community-maintained EJAM API (api.ejanalysis.com, Public Environmental Data Partners), which rehosts EJScreen after EPA discontinued public access in 2025.';

/** The 13 EJScreen environmental indicators, in report order, with display units. */
const ENV_INDICATORS: ReadonlyArray<{ code: string; label: string; unit: string }> = [
  { code: 'pm', label: 'PM2.5', unit: 'µg/m³' },
  { code: 'o3', label: 'Ozone', unit: 'ppb' },
  { code: 'dpm', label: 'Diesel particulate matter', unit: 'µg/m³' },
  { code: 'no2', label: 'Nitrogen dioxide (NO2)', unit: 'ppb' },
  {
    code: 'pctpre1960',
    label: 'Lead paint (pre-1960 housing)',
    unit: 'fraction of housing built pre-1960',
  },
  {
    code: 'traffic.score',
    label: 'Traffic proximity & volume',
    unit: 'daily traffic count / distance',
  },
  { code: 'proximity.npl', label: 'Superfund (NPL) proximity', unit: 'site count / km' },
  { code: 'proximity.rmp', label: 'RMP facility proximity', unit: 'facility count / km' },
  {
    code: 'proximity.tsdf',
    label: 'Hazardous-waste (TSDF) proximity',
    unit: 'facility count / km',
  },
  { code: 'proximity.npdes', label: 'Wastewater discharge (NPDES) proximity', unit: 'score' },
  { code: 'ust', label: 'Underground storage tanks', unit: 'count / area' },
  { code: 'drinking', label: 'Drinking-water non-compliance', unit: 'score' },
  { code: 'rsei', label: 'Toxic releases to air (RSEI)', unit: 'score' },
];

/** The 6 core EJScreen demographic indicators, in report order. */
const DEMOG_INDICATORS: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'pctmin', label: 'People of color' },
  { code: 'pctlowinc', label: 'Low income' },
  { code: 'pctlingiso', label: 'Limited English (linguistically isolated)' },
  { code: 'pctlths', label: 'Less than high school education' },
  { code: 'pctunder5', label: 'Under age 5' },
  { code: 'pctover64', label: 'Over age 64' },
];

/** Read a numeric column, returning undefined for null/empty/NaN (preserves upstream sparsity). */
function num(row: RawEjamRow, key: string): number | undefined {
  const v = row[key];
  if (v === undefined || v === null || v === '') return;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Read a non-empty string column, trimmed. */
function str(row: RawEjamRow, key: string): string | undefined {
  const v = row[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/** Convert an upstream fraction (0–1) to a percentage rounded to hundredths. */
function toPercent(fraction: number): number {
  return Math.round(fraction * 10000) / 100;
}

/** Extract the href URL from the `EJAM Report` anchor-tag column. */
function extractReportUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return;
  const match = raw.match(/href="([^"]+)"/i);
  return match?.[1];
}

/** Parse the EJAM 400 error body shape `{"error":["message"]}`. */
function parseApiError(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const err = (parsed as { error: unknown }).error;
      if (Array.isArray(err) && typeof err[0] === 'string') return err[0];
      if (typeof err === 'string') return err;
    }
  } catch {
    // Non-JSON body — fall through to undefined.
  }
  return;
}

/** Build the environmental indicators present in the row (absent columns skipped). */
function buildEnvironmental(row: RawEjamRow): EjEnvironmentalIndicator[] {
  const out: EjEnvironmentalIndicator[] = [];
  for (const { code, label, unit } of ENV_INDICATORS) {
    const value = num(row, code);
    if (value === undefined) continue;
    const indicator: EjEnvironmentalIndicator = { code, label, value, unit };
    const usPercentile = num(row, `pctile.${code}`);
    const statePercentile = num(row, `state.pctile.${code}`);
    const ejIndex = num(row, `EJ.DISPARITY.${code}.eo`);
    const ejIndexUsPercentile = num(row, `pctile.EJ.DISPARITY.${code}.eo`);
    const ejIndexStatePercentile = num(row, `state.pctile.EJ.DISPARITY.${code}.eo`);
    if (usPercentile !== undefined) indicator.usPercentile = usPercentile;
    if (statePercentile !== undefined) indicator.statePercentile = statePercentile;
    if (ejIndex !== undefined) indicator.ejIndex = ejIndex;
    if (ejIndexUsPercentile !== undefined) indicator.ejIndexUsPercentile = ejIndexUsPercentile;
    if (ejIndexStatePercentile !== undefined) {
      indicator.ejIndexStatePercentile = ejIndexStatePercentile;
    }
    out.push(indicator);
  }
  return out;
}

/** Build the demographic indicators present in the row (absent columns skipped). */
function buildDemographic(row: RawEjamRow): EjDemographicIndicator[] {
  const out: EjDemographicIndicator[] = [];
  for (const { code, label } of DEMOG_INDICATORS) {
    const fraction = num(row, code);
    if (fraction === undefined) continue;
    const indicator: EjDemographicIndicator = { code, label, percent: toPercent(fraction) };
    const usPercentile = num(row, `pctile.${code}`);
    const statePercentile = num(row, `state.pctile.${code}`);
    if (usPercentile !== undefined) indicator.usPercentile = usPercentile;
    if (statePercentile !== undefined) indicator.statePercentile = statePercentile;
    out.push(indicator);
  }
  return out;
}

/** Build one composite index (Demographic Index / Supplemental) from its column family. */
function buildIndex(row: RawEjamRow, code: string): EjIndexValue | undefined {
  const value = num(row, code);
  if (value === undefined) return;
  const index: EjIndexValue = { value };
  const usPercentile = num(row, `pctile.${code}`);
  const statePercentile = num(row, `state.pctile.${code}`);
  if (usPercentile !== undefined) index.usPercentile = usPercentile;
  if (statePercentile !== undefined) index.statePercentile = statePercentile;
  return index;
}

/**
 * Normalize a raw EJAM row into the domain result. When the upstream flags the
 * point out of coverage (`valid: false`), indicators are omitted and the
 * `invalid_msg` is surfaced as a coverage note — zeros are never fabricated.
 */
export function normalizeEjscreen(
  row: RawEjamRow,
  params: { latitude: number; longitude: number; bufferMiles: number },
): EjscreenResult {
  const state = str(row, 'ST');
  const stateName = str(row, 'statename');
  const population = num(row, 'pop');
  const blockGroupCount = num(row, 'bgcount_near_site');

  // A covered US point returns identity/context columns (block groups, population, state).
  // Out-of-coverage points return either an explicit valid:false (+ invalid_msg) or an
  // empty/dataless object — treat both as no coverage rather than reporting valid-but-empty.
  const hasContext =
    blockGroupCount !== undefined || population !== undefined || state !== undefined;
  const valid = row.valid !== false && hasContext;
  const note = valid
    ? undefined
    : (str(row, 'invalid_msg') ??
      'EJScreen returned no data for this location — it is likely outside US coverage (EJScreen covers US locations only).');

  const location: EjscreenResult['location'] = {
    latitude: params.latitude,
    longitude: params.longitude,
    bufferMiles: params.bufferMiles,
    ...(state !== undefined && { state }),
    ...(stateName !== undefined && { stateName }),
    ...(population !== undefined && { population }),
    ...(blockGroupCount !== undefined && { blockGroupCount }),
  };

  const environmental = valid ? buildEnvironmental(row) : [];
  const demographic = valid ? buildDemographic(row) : [];
  const demographicIndex = valid ? buildIndex(row, 'Demog.Index') : undefined;
  const supplementalDemographicIndex = valid ? buildIndex(row, 'Demog.Index.Supp') : undefined;
  const reportUrl = valid ? extractReportUrl(row['EJAM Report']) : undefined;

  return {
    location,
    environmental,
    demographic,
    ...(demographicIndex && { demographicIndex }),
    ...(supplementalDemographicIndex && { supplementalDemographicIndex }),
    ...(reportUrl && { reportUrl }),
    coverage: { valid, ...(note && { note }) },
    dataSource: EJSCREEN_DATA_SOURCE,
  };
}

export class EjscreenService {
  private readonly baseUrl: string;

  constructor(_config: AppConfig, _storage: StorageService) {
    this.baseUrl = getServerConfig().ejscreenBaseUrl;
  }

  /** Fetch and normalize EJScreen indicators for a point + buffer (miles). */
  async getIndicators(
    params: { latitude: number; longitude: number; bufferMiles: number },
    ctx: Context,
  ): Promise<EjscreenResult> {
    const row = await this.fetchData(params, ctx);
    return normalizeEjscreen(row, params);
  }

  /** POST the point + buffer to the EJAM `/data` endpoint and return the single row. */
  // biome-ignore lint/suspicious/useAwait: delegates to withRetry() which returns a Promise — async typing is correct
  private async fetchData(
    params: { latitude: number; longitude: number; bufferMiles: number },
    ctx: Context,
  ): Promise<RawEjamRow> {
    const url = `${this.baseUrl}/data`;
    return withRetry(
      async () => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sites: [{ lat: params.latitude, lon: params.longitude }],
            buffer: params.bufferMiles,
          }),
          signal: ctx.signal,
        });
        const text = await response.text();

        if (!response.ok) {
          // Bad input (e.g. invalid coordinates) returns HTTP 400 with {"error":[...]}. This is
          // deterministic — surface it as a validation failure rather than retrying.
          if (response.status === 400) {
            throw validationError(
              `EJAM API rejected the request: ${parseApiError(text) ?? 'HTTP 400'}`,
              { reason: 'upstream_rejected', status: 400, ...ctx.recoveryFor('upstream_rejected') },
            );
          }
          throw serviceUnavailable(`EJAM API returned HTTP ${response.status}.`, {
            status: response.status,
            url,
          });
        }
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable(
            'EJAM API returned HTML instead of JSON — likely unavailable or rate-limited.',
            { url },
          );
        }

        const parsed = JSON.parse(text) as unknown;
        const first = Array.isArray(parsed) ? parsed[0] : parsed;
        if (first === undefined || first === null || typeof first !== 'object') {
          throw serviceUnavailable('EJAM API returned an empty response.', { url });
        }
        return first as RawEjamRow;
      },
      {
        operation: 'EjscreenService.fetchData',
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );
  }
}

// --- Init/accessor pattern ---

let _service: EjscreenService | undefined;

export function initEjscreenService(config: AppConfig, storage: StorageService): void {
  _service = new EjscreenService(config, storage);
}

export function getEjscreenService(): EjscreenService {
  if (!_service) {
    throw new Error('EjscreenService not initialized — call initEjscreenService() in setup()');
  }
  return _service;
}
