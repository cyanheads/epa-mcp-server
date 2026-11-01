/**
 * @fileoverview EJScreen environmental-justice service. Wraps the community-maintained
 * EJAM API (`api.ejanalysis.com`), run by Public Environmental Data Partners, which
 * rehosts EJScreen after EPA discontinued public access in 2025; it serves EJAM's
 * ACS 2018–2022 release, built with the EJScreen 2.3 method. Calls `POST {base}/data`
 * with a point + buffer and normalizes the ~683-column row.
 * @module services/ejscreen/ejscreen-service
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
  EjDemographicIndicator,
  EjEnvironmentalIndicator,
  EjIndexValue,
  EjscreenResult,
  RawEjamRow,
} from './types.js';

/** Provenance + vintage string surfaced on every result and in user-facing copy. */
export const EJSCREEN_DATA_SOURCE =
  "EJScreen indicators from EJAM's ACS 2018–2022 release (EJScreen 2.3 method), served by the community-maintained EJAM API (api.ejanalysis.com, Public Environmental Data Partners), which rehosts EJScreen after EPA discontinued public access in 2025.";

/** The largest buffer radius, in miles, the EJAM API accepts. */
export const EJAM_MAX_BUFFER_MILES = 15;

/**
 * Budget for one EJAM lookup — every attempt and backoff — kept under the 60 s default request
 * timeout of MCP SDK clients with room for transport.
 */
const REQUEST_DEADLINE_MS = 55_000;

/**
 * EJAM's Island Area bounding boxes (`islandareas`, EJAM `data-raw/datacreate_islandareas.R`):
 * Guam, the Northern Mariana Islands, the U.S. Virgin Islands, and American Samoa.
 */
const ISLAND_AREA_BOXES: ReadonlyArray<{
  south: number;
  north: number;
  west: number;
  east: number;
}> = [
  { south: 12.951558, north: 13.7783567, west: 144.21516, east: 145.05135 },
  { south: 14.0129859, north: 15.39699, west: 145.067686, east: 145.9186 },
  { south: 17.611087, north: 18.45958, west: -65.0974, east: -64.52 },
  { south: -15.811126, north: -9.74635292, west: -173.4898, east: -168 },
];

/**
 * Whether EJAM accepts the point, by its own check (`latlon_is.valid()`, EJAM
 * `R/latlon_is.valid.R`): inside its rough box around the states, DC, and Puerto Rico
 * (latitude 17.5–71.5, longitude outside −64…172), or inside an Island Area box. A single-site
 * lookup outside both fails at EJAM with an R error, so the service answers it without one.
 */
function withinEjamBounds(latitude: number, longitude: number): boolean {
  const inCoreBox = latitude >= 17.5 && latitude <= 71.5 && (longitude <= -64 || longitude >= 172);
  return (
    inCoreBox ||
    ISLAND_AREA_BOXES.some(
      (box) =>
        latitude > box.south &&
        latitude < box.north &&
        longitude > box.west &&
        longitude < box.east,
    )
  );
}

const OUT_OF_BOUNDS_NOTE =
  'The point is outside the bounds EJScreen accepts, which enclose the 50 states, DC, Puerto Rico, and the U.S. Island Areas, so no EJScreen lookup was made. If the point should be in the US, check its latitude and longitude.';

const NOT_COVERED_EXAMPLES =
  'such as open water or a place outside the 50 states, DC, and Puerto Rico';

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

/**
 * Build one composite index (Demographic Index / Supplemental) from its column family. The
 * national average sits beside it; `state.avg.<code>` averages the state-normalized index
 * (`<code>.State`), not this one, so it is never read.
 */
function buildIndex(row: RawEjamRow, code: string): EjIndexValue | undefined {
  const value = num(row, code);
  if (value === undefined) return;
  const index: EjIndexValue = { value };
  const usAverage = num(row, `avg.${code}`);
  const usPercentile = num(row, `pctile.${code}`);
  const statePercentile = num(row, `state.pctile.${code}`);
  if (usAverage !== undefined) index.usAverage = usAverage;
  if (usPercentile !== undefined) index.usPercentile = usPercentile;
  if (statePercentile !== undefined) index.statePercentile = statePercentile;
  return index;
}

/**
 * Why EJAM returned no indicators for the buffer, from the shape it answered with. A larger
 * distance is suggested only while one is still available.
 */
function noDataNote(
  row: RawEjamRow,
  found: { blocks: boolean; population: number | undefined },
  bufferMiles: number,
): string {
  const canGrow = bufferMiles < EJAM_MAX_BUFFER_MILES;
  if (!found.blocks) {
    return canGrow
      ? `EJScreen found no Census block within the buffer. Either none lies this close to the point, and a larger distance (up to ${EJAM_MAX_BUFFER_MILES} miles) may reach one, or the point is somewhere EJScreen does not cover, ${NOT_COVERED_EXAMPLES}.`
      : `EJScreen found no Census block within the buffer, which is already at the ${EJAM_MAX_BUFFER_MILES}-mile maximum. Either none lies within ${EJAM_MAX_BUFFER_MILES} miles of the point, or the point is somewhere EJScreen does not cover, ${NOT_COVERED_EXAMPLES}.`;
  }
  if (found.population === 0) {
    const note =
      'EJScreen found Census blocks within the buffer but no residents, so it has no population-weighted indicators to report.';
    return canGrow
      ? `${note} A larger distance (up to ${EJAM_MAX_BUFFER_MILES} miles) may reach populated blocks.`
      : note;
  }
  const reason = str(row, 'invalid_msg');
  return `EJScreen reported no indicators for this buffer${reason ? ` (EJAM: "${reason}")` : ''}.`;
}

/**
 * Normalize a raw EJAM row into the domain result. A row without indicators — EJAM's `{}`
 * (no Census block in the buffer) or a `valid: false` row (blocks but no residents) — keeps
 * whatever location context it carries and gets a coverage note; zeros are never fabricated.
 */
export function normalizeEjscreen(
  row: RawEjamRow,
  params: { latitude: number; longitude: number; bufferMiles: number },
): EjscreenResult {
  const state = str(row, 'ST');
  const stateName = str(row, 'statename');
  const population = num(row, 'pop');
  const blockGroupCount = num(row, 'bgcount_near_site');

  // A buffer holding Census blocks returns identity/context columns (block groups, population,
  // state), even when EJAM marks it invalid; `{}` means EJAM found no block at all.
  const hasContext =
    blockGroupCount !== undefined || population !== undefined || state !== undefined;
  const valid = row.valid !== false && hasContext;

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
    coverage: valid
      ? { valid: true }
      : {
          valid: false,
          note: noDataNote(row, { blocks: hasContext, population }, params.bufferMiles),
        },
    dataSource: EJSCREEN_DATA_SOURCE,
  };
}

export class EjscreenService {
  private readonly baseUrl: string;

  constructor(_config: AppConfig, _storage: StorageService) {
    this.baseUrl = getServerConfig().ejscreenBaseUrl;
  }

  /**
   * Fetch and normalize EJScreen indicators for a point + buffer (miles). A point outside
   * EJAM's bounds gets a coverage result without a request.
   */
  async getIndicators(
    params: { latitude: number; longitude: number; bufferMiles: number },
    ctx: Context,
  ): Promise<EjscreenResult> {
    if (!withinEjamBounds(params.latitude, params.longitude)) {
      return {
        location: {
          latitude: params.latitude,
          longitude: params.longitude,
          bufferMiles: params.bufferMiles,
        },
        environmental: [],
        demographic: [],
        coverage: { valid: false, note: OUT_OF_BOUNDS_NOTE },
        dataSource: EJSCREEN_DATA_SOURCE,
      };
    }
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
      async ({ signal }) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sites: [{ lat: params.latitude, lon: params.longitude }],
            buffer: params.bufferMiles,
          }),
          signal,
        });
        if (!response.ok) {
          /*
           * EJAM returns every R error inside its analysis as HTTP 400 `{"error":[…]}`. Only
           * points inside its bounds are sent, so a 400 here is EJAM failing on one it accepts:
           * deterministic, not retried. Its R message goes in `data` for diagnosis, never into
           * caller text.
           */
          if (response.status === 400) {
            const upstreamMessage = parseApiError(await response.text());
            throw validationError(
              'EJAM rejected a lookup for a point inside the bounds it accepts (HTTP 400).',
              {
                reason: 'upstream_rejected',
                status: 400,
                ...(upstreamMessage !== undefined && { upstreamMessage }),
              },
            );
          }
          throw await httpErrorFromResponse(response, { service: 'EJAM' });
        }
        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable(
            'EJAM API returned HTML instead of JSON — likely unavailable or rate-limited.',
          );
        }

        // A fully read body that is not JSON will not parse on a retry: fail it once.
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (cause) {
          throw serializationError('EJAM API returned a response that is not JSON.', undefined, {
            cause,
          });
        }
        const first = Array.isArray(parsed) ? parsed[0] : parsed;
        if (first === undefined || first === null || typeof first !== 'object') {
          throw serviceUnavailable('EJAM API returned an empty response.');
        }
        return first as RawEjamRow;
      },
      {
        operation: 'EJAM request',
        baseDelayMs: 1000,
        signal: ctx.signal,
        deadlineMs: REQUEST_DEADLINE_MS,
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
