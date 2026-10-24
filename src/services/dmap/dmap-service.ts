/**
 * @fileoverview Envirofacts DMAP REST service for TRI, Superfund, and drinking water data.
 * Wraps data.epa.gov/dmapservice REST endpoints.
 * @module services/dmap/dmap-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  JsonRpcErrorCode,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { type CallBudget, callBudget } from '@/services/call-budget.js';
import type {
  RawSdwisViolation,
  RawSdwisWaterSystem,
  RawSemsSite,
  RawTriFacility,
  RawTriReleaseQty,
  RawTriReportingForm,
  SuperfundSite,
  TriRelease,
  WaterSystem,
} from './types.js';

/**
 * One DMAP URL filter: `{column}/{operator}/{value}`. `literal` is set on a `contains` filter
 * whose value had characters replaced by DMAP's wildcard (containsFilter); rows must contain it.
 */
type DmapFilter = { column: string; operator: string; value: string; literal?: string };

/**
 * Characters DMAP reads literally in a `contains` value. Live (2026-10-16), its path parser
 * answers any other punctuation and every non-ASCII letter with HTTP 500 "The query could not be
 * parsed" (apostrophes, brackets, parentheses, periods, slashes, Greek letters), `%` draws an nginx
 * HTTP 403, a comma ends the value (`contains/1,3-Butadiene` matches every name containing "1"),
 * and `_` and `?` match any one character.
 */
const CONTAINS_LITERAL = /^[A-Za-z0-9 -]$/;

/** Characters DMAP reads literally in an `equals` or `in` value, where `_` and `?` are not wildcards. */
const EXACT_LITERAL = /^[A-Za-z0-9 _?@-]$/;

/**
 * `value` without slashes at either end, unless it is nothing but slashes. DMAP decodes its path
 * before splitting it and drops empty segments, so an end slash never reached a filter: live
 * (2026-10-16), `equals/98108THBNG7500E%2F`, `equals/%2F98108THBNG7500E`, and
 * `contains/Seattle%2F` answer exactly as the bare values do. A slash inside a value shifts the
 * path apart and is still rejected.
 */
function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '/') start++;
  while (end > start && value[end - 1] === '/') end--;
  return start === end ? value : value.slice(start, end);
}

/**
 * A `contains` filter DMAP can carry. Each character it cannot read literally becomes `_`, its
 * one-character wildcard, and `literal` keeps the text as given so fetchMatchingRows keeps only
 * the rows that contain it; a `_` the caller wrote is a wildcard too, so it gets the same pass.
 * Across all 860 TRI chemical names and every TRI county name, the wildcard form of a name
 * matches no other name; Superfund city names carry spelling variants (COEUR D ALENE beside
 * COEUR D'ALENE) that the exact pass drops.
 */
function containsFilter(column: string, text: string): DmapFilter {
  const value = trimSlashes(text);
  const characters = Array.from(value);
  if (characters.every((c) => CONTAINS_LITERAL.test(c))) {
    return { column, operator: 'contains', value };
  }
  const pattern = characters.map((c) => (CONTAINS_LITERAL.test(c) ? c : '_')).join('');
  if (!/[A-Za-z0-9]/.test(pattern)) {
    throw validationError(
      `"${value}" has no letter or digit to search on. EPA's DMAP service matches text by its letters, digits, spaces, and hyphens.`,
      { value },
    );
  }
  return { column, operator: 'contains', value: pattern, literal: value };
}

/**
 * An `equals` or `in` filter as DMAP reads it: end slashes dropped (trimSlashes), and a value
 * carrying a character DMAP cannot match rejected before any request.
 */
function exactFilter(filter: DmapFilter): DmapFilter {
  if (filter.operator === 'contains') return filter;
  const exact = { ...filter, value: trimSlashes(filter.value) };
  const values = exact.operator === 'in' ? exact.value.split(',') : [exact.value];
  for (const value of values) {
    for (const character of value) {
      if (!EXACT_LITERAL.test(character)) {
        const recovery = character === ',' ? 'Pass one value per call.' : 'Remove it and retry.';
        throw validationError(
          `"${value}" contains "${character}", a character EPA's DMAP service cannot match in an exact-value filter. ${recovery}`,
          { value, character },
        );
      }
    }
  }
  return exact;
}

/** Rows read per page while a wildcard filter's exact matches are collected. */
const EXACT_TEXT_PAGE_ROWS = 100;

/**
 * Pages read for a wildcard filter before returning what matched. Reaching it takes hundreds of
 * near-variant rows ahead of the exact ones in DMAP's order.
 */
const EXACT_TEXT_MAX_PAGES = 3;

/** DMAP's front end refuses a longer request line with HTTP 400 "Request Line is too large". */
const DMAP_REQUEST_LINE_LIMIT = 4094;

/**
 * Bytes of the client's request line DMAP leaves out of that count: live (2026-10-16), a
 * 4,105-byte line is answered and a 4,106-byte one is refused as "(4095 > 4094)".
 */
const DMAP_UNCOUNTED_BYTES = 11;

/** One DMAP sort key. `column` is table-qualified (`tri.tri_reporting_form.reporting_year`). */
type DmapSortKey = { column: string; direction: 'asc' | 'desc' };

/**
 * Newest reporting year first, then submission number, so a row range pages deterministically.
 * Keys must be table-qualified: DMAP resolves a bare column against the first table of a join
 * (`reporting_year` there is HTTP 500). Without the doc_ctrl_num tiebreak, AK rows `1:50` and
 * `51:100` shared 36 records.
 */
const NEWEST_FIRST: DmapSortKey[] = [
  { column: 'tri.tri_reporting_form.reporting_year', direction: 'desc' },
  { column: 'tri.tri_reporting_form.doc_ctrl_num', direction: 'asc' },
];

/**
 * Request-line budget for a batched `in` list, under DMAP_REQUEST_LINE_LIMIT. DMAP counts 11 bytes
 * fewer than the client sends, and the budget leaves a further ~300 bytes of margin.
 */
const IN_LIST_REQUEST_LINE_BUDGET = 3800;

/**
 * Breakdown chunks in flight at once. An uncached tri.tri_release_qty request takes ~18 s however
 * many submissions it names, so chunks run side by side: getTriReleases' 500 forms make at most
 * three chunks, one wave.
 */
const BREAKDOWN_CONCURRENCY = 3;

/**
 * One budget for every DMAP request a service call chains — a TRI search and its breakdown chunks,
 * a ZIP's system read and its violation checks, every retry and backoff — so the call settles
 * under the 60 s request timeout of MCP SDK clients. An expiry names how to narrow the call.
 */
const CALL_DEADLINE_MS = 50_000;

const dmapBudget = (task: string, narrow: string) =>
  callBudget('DMAP', task, CALL_DEADLINE_MS, narrow);

/** Max tri.tri_release_qty rows read per submission (live submissions carry about 10). */
const RELEASE_QTY_ROWS_PER_SUBMISSION = 30;

/** The HTTP/1.1 request line a GET of `url` sends: method, path and query, protocol. */
function requestLineBytes(url: string): number {
  const { pathname, search } = new URL(url);
  return Buffer.byteLength(`GET ${pathname}${search} HTTP/1.1`);
}

/** Parse a numeric field, returning undefined if absent/NaN. */
function parseNum(val: string | number | undefined): number | undefined {
  if (val === undefined || val === null || val === '') return;
  const n = Number(val);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * Round a computed TRI quantity to 12 significant digits. TRI reports at most 7, so this keeps
 * every reported digit while dropping the binary-float noise a sum or unit conversion adds
 * (0.000894 + 0.000014 = 0.0009080000000000001 → 0.000908). formatLbs renders the same 12 digits,
 * so structuredContent and text carry one value.
 */
function roundQuantity(n: number): number {
  return Number(n.toPrecision(12));
}

/**
 * tri_chem_id of dioxin and dioxin-like compounds. EPA's TRI program has facilities report this
 * category in grams and every other chemical in pounds (TRI Basic Data Files documentation,
 * UNIT_OF_MEASURE). The reporting-form and release-quantity tables carry no unit column, so the
 * chemical ID is the marker on their rows (tri.tri_chem_info.unit_of_measure records Grams for
 * N150, the only gram-reported chemical).
 */
const GRAM_REPORTED_CHEM_ID = 'N150';

/** Grams per avoirdupois pound, exact by definition. */
const GRAMS_PER_POUND = 453.59237;

function gramsToPounds(grams: number): number {
  return roundQuantity(grams / GRAMS_PER_POUND);
}

/** Normalize a raw TRI reporting form row; a gram-reported chemical's quantity becomes pounds. */
function normalizeTriRelease(raw: RawTriReportingForm): TriRelease {
  const inGrams = raw.tri_chem_id === GRAM_REPORTED_CHEM_ID;
  const result: TriRelease = {
    facilityId: raw.tri_facility_id ?? '',
    // tri_reporting_form uses cas_chem_name, not chemical_name_text
    chemicalName: raw.cas_chem_name ?? '',
    reportingYear: Number(raw.reporting_year ?? 0),
    ...(inGrams && { reportedUnit: 'grams' as const }),
  };
  // one_time_release_qty is the only release qty in tri_reporting_form; the per-medium routine
  // breakdown lives in tri.tri_release_qty and is merged in by the callers through
  // fetchReleaseBreakdown (always for getTriReleases, opt-in for searchTriReleases).
  const oneTime = parseNum(raw.one_time_release_qty);
  if (oneTime !== undefined) result.totalReleasesInLbs = inGrams ? gramsToPounds(oneTime) : oneTime;
  return result;
}

/** Per-medium routine-release sums for one TRI submission, in the unit the form was reported in. */
type MediumBreakdown = Pick<
  TriRelease,
  | 'releasesToAirInLbs'
  | 'releasesToWaterInLbs'
  | 'releasesToLandInLbs'
  | 'releasesToUndergroundInjectionInLbs'
>;

/** Merge a submission's per-medium sums into its release, converting a gram-reported form to pounds. */
function withBreakdown<T extends TriRelease>(
  release: T,
  breakdown: MediumBreakdown | undefined,
): T {
  if (!breakdown) return release;
  if (release.reportedUnit !== 'grams') return { ...release, ...breakdown };
  const pounds: MediumBreakdown = {};
  for (const [field, grams] of Object.entries(breakdown) as Array<
    [keyof MediumBreakdown, number]
  >) {
    pounds[field] = gramsToPounds(grams);
  }
  return { ...release, ...pounds };
}

/**
 * Map each tri.tri_release_qty environmental_medium code to the TriRelease field its quantity
 * rolls up into, following EPA's on-site release taxonomy: air (fugitive + stack), water, land
 * (landfills / treatment / impoundment / other disposal), and underground injection. Codes absent
 * from this map (non-release sub-metrics, unknown codes) contribute nothing.
 */
const RELEASE_FIELD_BY_MEDIUM: Record<string, keyof MediumBreakdown> = {
  'AIR FUG': 'releasesToAirInLbs',
  'AIR STACK': 'releasesToAirInLbs',
  WATER: 'releasesToWaterInLbs',
  'RCRA C': 'releasesToLandInLbs',
  'OTH LANDF': 'releasesToLandInLbs',
  'LAND TREA': 'releasesToLandInLbs',
  'SURF IMP': 'releasesToLandInLbs',
  'OTH DISP': 'releasesToLandInLbs',
  LANDF8795: 'releasesToLandInLbs',
  'UNINJ I': 'releasesToUndergroundInjectionInLbs',
  'UNINJ IIV': 'releasesToUndergroundInjectionInLbs',
  UNINJ8795: 'releasesToUndergroundInjectionInLbs',
};

/** sdwis.violation rows read to find a state's violating water systems. */
const VIOLATION_SCAN_ROWS = 1000;

/**
 * sdwis.violation compliance_status_code values for a violation still open. Live rows carry four
 * codes: K and O have no rtc_date (unresolved); R has an rtc_date and resolving enforcement
 * (returned to compliance); I has rtc_date equal to the system's pws_deactivation_date (resolved
 * when the system closed).
 */
const OPEN_VIOLATION_FILTER: DmapFilter = {
  column: 'compliance_status_code',
  operator: 'in',
  value: 'K,O',
};

/** PWSIDs per `pwsid in` request — a ~2,500-character URL. */
const PWSID_CHUNK_SIZE = 200;

/**
 * sdwis.water_system rows read for a ZIP violation check. Live ZIPs hold well under 200 systems
 * (98104: 8, 59901: 194), so one read covers the ZIP and a check is at most
 * 1 + ZIP_SYSTEM_SCAN_ROWS / PWSID_CHUNK_SIZE = 6 requests.
 */
const ZIP_SYSTEM_SCAN_ROWS = 1000;

/** The distinct PWSIDs named by a set of sdwis.violation rows. */
function pwsidSet(violations: RawSdwisViolation[]): Set<string> {
  return new Set(
    violations.map((r) => r.pwsid).filter((id): id is string => typeof id === 'string'),
  );
}

/** Normalize a raw SEMS envirofacts_site record. */
function normalizeSemsSite(raw: RawSemsSite): SuperfundSite {
  const lat = parseNum(raw.primary_latitude_decimal_val);
  const lng = parseNum(raw.primary_longitude_decimal_val);
  return {
    siteId: raw.site_id ?? '',
    // actual field is `name`, not `site_name` (site_name is null in SEMS)
    name: raw.name ?? '',
    // actual field is `street_addr_txt`, not `street_address_1`
    ...(raw.street_addr_txt && { street: raw.street_addr_txt as string }),
    ...(raw.city_name && { city: raw.city_name as string }),
    ...(raw.fk_ref_state_code && { state: raw.fk_ref_state_code as string }),
    ...(raw.zip_code && { zip: raw.zip_code as string }),
    ...(raw.county_name && { county: raw.county_name as string }),
    // actual field is `fips_code`, not `county_fips_code`
    ...(raw.fips_code && { fipsCode: raw.fips_code as string }),
    ...(raw.npl_status_code && { nplStatus: raw.npl_status_code as string }),
    ...(raw.cleanup_status && { cleanupStatus: raw.cleanup_status as string }),
    ...(lat !== undefined && { latitude: lat }),
    ...(lng !== undefined && { longitude: lng }),
  };
}

/** Normalize a raw SDWIS water system record. */
function normalizeSdwisWaterSystem(
  raw: RawSdwisWaterSystem,
  violatingPwsids?: Set<string>,
): WaterSystem {
  const pop = parseNum(raw.population_served_count);
  const pwsid = raw.pwsid ?? '';
  return {
    pwsid,
    name: raw.pws_name ?? '',
    ...(raw.primacy_agency_code && { state: raw.primacy_agency_code as string }),
    // actual field is city_name, not city_served
    ...(raw.city_name && { city: raw.city_name as string }),
    ...(raw.zip_code && { zip: raw.zip_code as string }),
    ...(raw.pws_type_code && { type: raw.pws_type_code as string }),
    ...(raw.primary_source_code && { primarySourceCode: raw.primary_source_code as string }),
    ...(pop !== undefined && { populationServed: pop }),
    ...(violatingPwsids !== undefined && { hasViolation: violatingPwsids.has(pwsid) }),
    // actual field is pws_activity_code, not active_flag; 'A' = active
    ...(raw.pws_activity_code !== undefined && { isActive: raw.pws_activity_code === 'A' }),
  };
}

/**
 * Compute the Haversine distance in miles between two lat/lng points.
 */
function haversineDistanceMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Conservative signed integer-degree coordinate prefixes intersecting an interval. DMAP compares
 * coordinates as text, so prefixes intentionally overfetch (9 also matches 90). Both signed
 * zero prefixes are needed at the equator; exact integer coordinates need no decimal suffix.
 */
function coordinatePrefixes(low: number, high: number, maximum: number): string[] {
  const prefixes: string[] = [];
  for (let degree = -maximum; degree <= maximum; degree++) {
    const bottom = degree < 0 ? degree - 1 : degree;
    const top = degree < 0 ? degree : degree + 1;
    if (bottom <= high && top >= low) prefixes.push(String(degree));
  }
  if (low <= 0 && high >= -1) prefixes.push('-0');
  return prefixes;
}

/**
 * Spherical radius bounds, expressed as text prefixes because DMAP compares coordinates as
 * strings. A circle touching a pole covers every longitude; otherwise its longitudinal
 * extremum is asin(sin(angular radius) / cos(latitude)), with date-line intervals wrapped.
 */
function proximityPrefixes(latitude: number, longitude: number, radiusMiles: number) {
  const angularRadius = radiusMiles / 3958.8;
  const degrees = angularRadius * (180 / Math.PI);
  const low = Math.max(-90, latitude - degrees);
  const high = Math.min(90, latitude + degrees);
  const latitudes = coordinatePrefixes(low, high, 90);
  if (low <= -90 || high >= 90) return { latitudes, longitudes: [undefined] };
  const width =
    Math.asin(Math.min(1, Math.sin(angularRadius) / Math.cos((latitude * Math.PI) / 180))) *
    (180 / Math.PI);
  const center = ((((longitude + 180) % 360) + 360) % 360) - 180;
  const left = center - width;
  const right = center + width;
  const intervals: [number, number][] =
    left <= -180
      ? [
          [left + 360, 180],
          [-180, right],
        ]
      : right >= 180
        ? [
            [left, 180],
            [-180, right - 360],
          ]
        : [[left, right]];
  return {
    latitudes,
    longitudes: [
      ...new Set(intervals.flatMap(([start, end]) => coordinatePrefixes(start, end, 180))),
    ],
  };
}

export class DmapService {
  private readonly baseUrl: string;

  constructor(_config: AppConfig, _storage: StorageService) {
    this.baseUrl = getServerConfig().dmapBaseUrl;
  }

  /**
   * Build a DMAP REST JSON URL for a multi-filter query.
   * Format: {base}/{schema}.{table}/{col1}/{op1}/{val1}/and/{col2}/{op2}/{val2}/{first}:{last}/json
   * Rows are 1-based and inclusive: `1:50` is 50 rows. DMAP reads a `first` of 0 as row 1, so
   * `0:49` would return only 49.
   *
   * With `join`, an inner join follows the filters:
   * `/join/{schema}.{table}/{leftColumn}/equals/{rightColumn}/and/{filter}…`. Filters before the
   * join bind to the first table only (DMAP rejects a column the first table lacks); filters
   * after the join comparison bind to the joined table. The range then counts joined rows.
   *
   * With `sort`, `/sort/{column}:{asc|desc},…` follows the filters and join, before the range.
   *
   * An `equals` or `in` value goes through exactFilter, so one carrying a character DMAP cannot
   * match throws a ValidationError naming it; `contains` values arrive already rewritten by
   * containsFilter.
   */
  private buildTableUrl(
    schema: string,
    table: string,
    filters: DmapFilter[],
    pagination: { first: number; last: number },
    options: {
      join?: {
        table: string;
        on: { left: string; right: string };
        filters: DmapFilter[];
      };
      sort?: DmapSortKey[];
    } = {},
  ): string {
    const { join, sort } = options;
    const toPath = (list: DmapFilter[]) =>
      list
        .map(exactFilter)
        .map((f) => `${encodeURIComponent(f.column)}/${f.operator}/${encodeURIComponent(f.value)}`)
        .join('/and/');
    const joinPath = join
      ? `/join/${join.table}/${join.on.left}/equals/${join.on.right}${join.filters.length > 0 ? `/and/${toPath(join.filters)}` : ''}`
      : '';
    const sortPath = sort ? `/sort/${sort.map((k) => `${k.column}:${k.direction}`).join(',')}` : '';
    const pagePath = `${pagination.first}:${pagination.last}`;
    return `${this.baseUrl}/${schema}.${table}/${toPath(filters)}${joinPath}${sortPath}/${pagePath}/json`;
  }

  /**
   * Fetch a DMAP table result as JSON array. Every attempt and backoff ends within `budget`
   * (shared by every request of one service call); expiry rejects with the budget's Timeout.
   *
   * A request line DMAP would count past DMAP_REQUEST_LINE_LIMIT is never sent: batched `in`
   * lists are chunked to fit, so only caller-supplied filter text can push one over, and it fails
   * as a ValidationError. DMAP answers HTTP 400 only from its front end, for a request it cannot
   * parse, never for a filter value — those are HTTP 500. A 400 that still arrives is a request
   * this server built wrong, not the caller's input, and maps to InternalError rather than the
   * default InvalidParams.
   */
  private fetchTable<T>(url: string, ctx: Context, budget: CallBudget): Promise<T[]> {
    const countedBytes = requestLineBytes(url) - DMAP_UNCOUNTED_BYTES;
    if (countedBytes > DMAP_REQUEST_LINE_LIMIT) {
      return Promise.reject(
        validationError(
          `The search filters are too long for EPA's DMAP service: the request would be ${countedBytes} bytes, over its ${DMAP_REQUEST_LINE_LIMIT}-byte limit. Shorten the text filters.`,
          { requestLineBytes: countedBytes },
        ),
      );
    }
    return withRetry(
      async ({ signal }) => {
        const response = await fetch(url, { signal });
        if (!response.ok) {
          throw await httpErrorFromResponse(response, {
            service: 'DMAP',
            codeOverride: (status) => (status === 400 ? JsonRpcErrorCode.InternalError : undefined),
          });
        }
        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable(
            'DMAP API returned HTML instead of JSON — likely rate-limited or unavailable.',
          );
        }
        const parsed = JSON.parse(text) as unknown;
        if (Array.isArray(parsed)) return parsed as T[];
        const [firstKey] = Object.keys(parsed as object);
        if (firstKey === undefined) return [] as T[];
        return ((parsed as Record<string, unknown[]>)[firstKey] ?? []) as T[];
      },
      {
        operation: 'DmapService.fetchTable',
        baseDelayMs: 1000,
        signal: ctx.signal,
        deadlineMs: budget.remainingMs(),
      },
    ).catch(budget.rethrow);
  }

  /**
   * Fetch up to `wanted` rows. Without a wildcarded filter (containsFilter) that is one request
   * ranged `1:wanted`. With one, DMAP's rows can include near-variants that match only through the
   * wildcard, so pages of at least EXACT_TEXT_PAGE_ROWS are read and narrowed to rows containing
   * the text as given, until `wanted` are found, DMAP runs out, or EXACT_TEXT_MAX_PAGES are read.
   * A walk the page limit ends short of `wanted` carries a notice that more matches may exist.
   */
  private async fetchMatchingRows<T extends Record<string, unknown>>(
    urlForRange: (range: { first: number; last: number }) => string,
    filters: DmapFilter[],
    wanted: number,
    ctx: Context,
    budget: CallBudget,
  ): Promise<T[]> {
    const wildcarded = filters.filter(
      (f): f is DmapFilter & { literal: string } => f.literal !== undefined,
    );
    if (wildcarded.length === 0) {
      return this.fetchTable<T>(urlForRange({ first: 1, last: wanted }), ctx, budget);
    }
    const pageRows = Math.max(wanted, EXACT_TEXT_PAGE_ROWS);
    const matches: T[] = [];
    let exhausted = false;
    for (let page = 0; page < EXACT_TEXT_MAX_PAGES && matches.length < wanted; page++) {
      const first = page * pageRows + 1;
      const rows = await this.fetchTable<T>(
        urlForRange({ first, last: first + pageRows - 1 }),
        ctx,
        budget,
      );
      matches.push(
        ...rows.filter((row) =>
          wildcarded.every((f) =>
            String(row[f.column] ?? '')
              .toLowerCase()
              .includes(f.literal.toLowerCase()),
          ),
        ),
      );
      if (rows.length < pageRows) {
        exhausted = true;
        break;
      }
    }
    if (!exhausted && matches.length < wanted) {
      const texts = wildcarded.map((f) => `"${f.literal}"`).join(' and ');
      const kept = `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}`;
      ctx.enrich.notice(
        `${texts} ${wildcarded.length === 1 ? 'was' : 'were'} searched with a one-character wildcard in place of punctuation, and the first ${(EXACT_TEXT_MAX_PAGES * pageRows).toLocaleString('en-US')} rows matching the wildcard held ${kept} spelled as given, so more may exist past them. Narrow the search with other filters or more of the text.`,
      );
    }
    return matches.slice(0, wanted);
  }

  /** Get up to 500 TRI filings for a facility, newest first unless a year is supplied. */
  async getTriReleases(
    params: {
      facilityId: string;
      year?: number;
      chemicalName?: string;
    },
    ctx: Context,
  ): Promise<TriRelease[]> {
    const filters: DmapFilter[] = [
      { column: 'tri_facility_id', operator: 'equals', value: params.facilityId },
    ];
    if (params.year !== undefined) {
      filters.push({ column: 'reporting_year', operator: 'equals', value: String(params.year) });
    }
    if (params.chemicalName) {
      // actual field is cas_chem_name, not chemical_name_text
      filters.push(containsFilter('cas_chem_name', params.chemicalName));
    }

    const budget = dmapBudget(
      'TRI release lookup',
      'Narrow it with year or chemical_name, or call again later.',
    );
    ctx.log.debug('DMAP TRI releases query', { facilityId: params.facilityId, year: params.year });

    const rows = await this.fetchMatchingRows<RawTriReportingForm>(
      (range) =>
        this.buildTableUrl('tri', 'tri_reporting_form', filters, range, {
          ...(params.year === undefined && { sort: NEWEST_FIRST }),
        }),
      filters,
      500,
      ctx,
      budget,
    );
    if (rows.length >= 500) {
      // Keep punctuation-scan notices intact; cap guidance has its own enrichment field.
      ctx.enrich({
        truncated: true,
        shown: rows.length,
        cap: 500,
        guidance: `The lookup returned its 500-filing cap; more may exist. Narrow with ${params.year === undefined ? 'year or chemical_name' : 'chemical_name'}.`,
      });
    }
    return this.withReleaseBreakdown(rows, rows.map(normalizeTriRelease), ctx, budget);
  }

  /**
   * Add each release's per-medium routine breakdown (tri.tri_release_qty, joined on doc_ctrl_num).
   * `releases[i]` is the normalized form of `rows[i]`.
   */
  private async withReleaseBreakdown<T extends TriRelease>(
    rows: RawTriReportingForm[],
    releases: T[],
    ctx: Context,
    budget: CallBudget,
  ): Promise<T[]> {
    const docCtrlNums = [
      ...new Set(
        rows
          .map((r) => r.doc_ctrl_num)
          .filter((d): d is string => typeof d === 'string' && d.length > 0),
      ),
    ];
    if (docCtrlNums.length === 0) return releases;
    const breakdownByDoc = await this.fetchReleaseBreakdown(docCtrlNums, ctx, budget);
    return releases.map((release, i) => {
      const doc = rows[i]?.doc_ctrl_num;
      return withBreakdown(release, typeof doc === 'string' ? breakdownByDoc.get(doc) : undefined);
    });
  }

  /**
   * Fetch the per-medium routine releases (tri.tri_release_qty) for a set of TRI submissions and
   * roll them up into air/water/land/underground-injection sums keyed by doc_ctrl_num.
   * getTriReleases does this on every call; searchTriReleases only when includeReleaseBreakdown
   * is set — an uncached tri_release_qty request takes ~18 s upstream.
   *
   * The submissions travel as one `doc_ctrl_num in` list per request, split so each request line
   * stays within IN_LIST_REQUEST_LINE_BUDGET (about 230 thirteen-digit numbers per request). The
   * chunks run BREAKDOWN_CONCURRENCY at a time against the call's deadline, and their rows merge
   * into one rollup; the lists are disjoint, so no row is counted twice.
   *
   * Sparsity is preserved: a row flagged release_na="1" (medium not applicable) or carrying only
   * a release_range_code (no hard total_release) contributes nothing — a null quantity is never
   * coerced to 0.
   */
  private async fetchReleaseBreakdown(
    docCtrlNums: string[],
    ctx: Context,
    budget: CallBudget,
  ): Promise<Map<string, MediumBreakdown>> {
    const urlFor = (docs: string[]) =>
      this.buildTableUrl(
        'tri',
        'tri_release_qty',
        [{ column: 'doc_ctrl_num', operator: 'in', value: docs.join(',') }],
        { first: 1, last: docs.length * RELEASE_QTY_ROWS_PER_SUBMISSION },
      );
    const urls: string[] = [];
    let chunk: string[] = [];
    for (const doc of docCtrlNums) {
      if (
        chunk.length > 0 &&
        requestLineBytes(urlFor([...chunk, doc])) > IN_LIST_REQUEST_LINE_BUDGET
      ) {
        urls.push(urlFor(chunk));
        chunk = [];
      }
      chunk.push(doc);
    }
    urls.push(urlFor(chunk));
    ctx.log.debug('DMAP TRI release-qty breakdown query', {
      submissions: docCtrlNums.length,
      requests: urls.length,
    });

    const rows: RawTriReleaseQty[] = [];
    let next = 0;
    let failed = false;
    const worker = async () => {
      while (!failed && next < urls.length) {
        const url = urls[next++] as string;
        try {
          rows.push(...(await this.fetchTable<RawTriReleaseQty>(url, ctx, budget)));
        } catch (error) {
          // The call has already failed; start no further chunks.
          failed = true;
          throw error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(BREAKDOWN_CONCURRENCY, urls.length) }, worker));

    const byDoc = new Map<string, MediumBreakdown>();
    for (const row of rows) {
      const doc = row.doc_ctrl_num;
      if (typeof doc !== 'string' || doc.length === 0) continue;
      // release_na "1" means the medium doesn't apply to this submission — not a zero release.
      if (row.release_na === '1') continue;
      const field = RELEASE_FIELD_BY_MEDIUM[row.environmental_medium ?? ''];
      if (!field) continue;
      // Only hard quantities roll up. A range-coded / null total_release stays out of the
      // sum rather than being fabricated as 0.
      const amount = parseNum(row.total_release ?? undefined);
      if (amount === undefined) continue;
      const entry = byDoc.get(doc) ?? {};
      entry[field] = roundQuantity((entry[field] ?? 0) + amount);
      byDoc.set(doc, entry);
    }
    return byDoc;
  }

  /**
   * Search TRI releases by state, optionally filtered by county, year, or chemical.
   * tri.tri_reporting_form carries no state, so one request joins it to tri.tri_facility: the
   * state and county filters bind to the facility table, the year and chemical filters to the
   * forms, and the row range caps the joined rows at `limit`. Without `year` the joined rows are
   * sorted newest reporting year first, so `limit` keeps the most recent filings; with `year` the
   * request is unsorted (table order already pages deterministically). However sparse the
   * filters, the search is one request; with includeReleaseBreakdown, fetchReleaseBreakdown adds
   * the per-medium routine releases to every kept record (one request at the 200-record cap).
   */
  async searchTriReleases(
    params: {
      state: string;
      county?: string;
      year?: number;
      chemicalName?: string;
      limit?: number;
      includeReleaseBreakdown?: boolean;
    },
    ctx: Context,
  ): Promise<(TriRelease & { facilityName?: string; countyName?: string })[]> {
    const limit = params.limit ?? 50;

    const facilityFilters: DmapFilter[] = [
      { column: 'state_abbr', operator: 'equals', value: params.state },
    ];
    if (params.county) {
      // DMAP matches county_name case-insensitively; `contains` catches states that store both a
      // bare and a suffixed form of one county (CALCASIEU / CALCASIEU PARISH), at the cost of
      // also matching a longer name that contains this one (LAKE / LAKE OF THE WOODS).
      facilityFilters.push(containsFilter('county_name', params.county));
    }
    const formFilters: DmapFilter[] = [];
    if (params.year !== undefined) {
      formFilters.push({
        column: 'reporting_year',
        operator: 'equals',
        value: String(params.year),
      });
    }
    if (params.chemicalName) {
      // actual field is cas_chem_name, not chemical_name_text
      formFilters.push(containsFilter('cas_chem_name', params.chemicalName));
    }

    const budget = dmapBudget(
      'TRI release search',
      'Narrow it with year, county, or chemical_name, leave include_release_breakdown off, or call again later.',
    );
    ctx.log.debug('DMAP TRI facility-form join query', {
      state: params.state,
      county: params.county,
      year: params.year,
    });

    // Joined rows carry both tables' columns, so the exact pass reads county and chemical alike.
    const rows = await this.fetchMatchingRows<RawTriReportingForm & RawTriFacility>(
      (range) =>
        this.buildTableUrl('tri', 'tri_facility', facilityFilters, range, {
          join: {
            table: 'tri.tri_reporting_form',
            on: { left: 'tri_facility_id', right: 'tri_facility_id' },
            filters: formFilters,
          },
          ...(params.year === undefined && { sort: NEWEST_FIRST }),
        }),
      [...facilityFilters, ...formFilters],
      limit,
      ctx,
      budget,
    );
    const kept = rows.slice(0, limit);
    const releases = kept.map((row) => ({
      ...normalizeTriRelease(row),
      facilityName: row.facility_name ?? '',
      ...(row.county_name && { countyName: row.county_name }),
    }));

    return params.includeReleaseBreakdown
      ? this.withReleaseBreakdown(kept, releases, ctx, budget)
      : releases;
  }

  /** Search Superfund sites by state or coordinates + radius. */
  async searchSuperfund(
    params: {
      state?: string;
      city?: string;
      zipCode?: string;
      latitude?: number;
      longitude?: number;
      radiusMiles?: number;
      nplStatus?: string;
      limit?: number;
    },
    ctx: Context,
  ): Promise<SuperfundSite[]> {
    const limit = params.limit ?? 50;
    const filters: DmapFilter[] = [];

    if (params.state) {
      filters.push({ column: 'fk_ref_state_code', operator: 'equals', value: params.state });
    }
    if (params.city) {
      filters.push(containsFilter('city_name', params.city));
    }
    if (params.zipCode) {
      filters.push({ column: 'zip_code', operator: 'equals', value: params.zipCode });
    }
    if (params.nplStatus && params.nplStatus !== 'all') {
      const nplMap: Record<string, string> = { listed: 'NPL', 'not-listed': 'N', proposed: 'P' };
      const nplCode = nplMap[params.nplStatus];
      if (nplCode) {
        filters.push({ column: 'npl_status_code', operator: 'equals', value: nplCode });
      }
    }

    const { latitude, longitude, radiusMiles } = params;
    const proximity =
      latitude !== undefined && longitude !== undefined && radiusMiles !== undefined;
    // A coordinate search supplies its own latitude-prefix filter below.
    if (filters.length === 0 && !proximity) {
      ctx.log.debug('DMAP Superfund query: no filters, returning empty');
      return [];
    }

    ctx.log.debug('DMAP Superfund query', { state: params.state, lat: params.latitude });
    const budget = dmapBudget(
      'Superfund site search',
      'Narrow it with zip_code, city, or npl_status, or call again later.',
    );
    let rows: RawSemsSite[];
    if (proximity) {
      const candidates = new Map<string, RawSemsSite>();
      const prefixes = proximityPrefixes(latitude, longitude, radiusMiles);
      for (const latPrefix of prefixes.latitudes) {
        for (const lonPrefix of prefixes.longitudes) {
          const seen = new Set<string>();
          for (let first = 1; ; first += 500) {
            const page = await this.fetchTable<RawSemsSite>(
              this.buildTableUrl(
                'sems',
                'envirofacts_site',
                [
                  ...filters,
                  {
                    column: 'primary_latitude_decimal_val',
                    operator: 'beginsWith',
                    value: latPrefix,
                  },
                  ...(lonPrefix === undefined
                    ? []
                    : [
                        {
                          column: 'primary_longitude_decimal_val',
                          operator: 'beginsWith' as const,
                          value: lonPrefix,
                        },
                      ]),
                ],
                { first, last: first + 499 },
                { sort: [{ column: 'sems.envirofacts_site.site_id', direction: 'asc' }] },
              ),
              ctx,
              budget,
            );
            if (
              page.length > 0 &&
              page.every((row) => seen.has(row.site_id || JSON.stringify(row)))
            ) {
              throw serviceUnavailable(
                'EPA DMAP repeated a Superfund candidate page. The proximity search could not be completed. Narrow the radius or add city, zip_code, or npl_status filters and retry.',
              );
            }
            for (const row of page) seen.add(row.site_id || JSON.stringify(row));
            for (const row of page) {
              if (
                filters.every(
                  (f) =>
                    f.literal === undefined ||
                    String(row[f.column] ?? '')
                      .toLowerCase()
                      .includes(f.literal.toLowerCase()),
                )
              ) {
                candidates.set(row.site_id || JSON.stringify(row), row);
              }
            }
            if (page.length < 500) break;
          }
        }
      }
      rows = [...candidates.values()];
    } else {
      rows = await this.fetchMatchingRows<RawSemsSite>(
        (range) => this.buildTableUrl('sems', 'envirofacts_site', filters, range),
        filters,
        limit,
        ctx,
        budget,
      );
    }
    let sites = rows.map(normalizeSemsSite);

    if (proximity) {
      sites = sites
        .flatMap((site) => {
          if (site.latitude === undefined || site.longitude === undefined) return [];
          const distance = haversineDistanceMiles(
            latitude,
            longitude,
            site.latitude,
            site.longitude,
          );
          return distance <= radiusMiles ? [{ site, distance }] : [];
        })
        .sort((a, b) => a.distance - b.distance || a.site.siteId.localeCompare(b.site.siteId))
        .map(({ site }) => site);
      if (sites.length > limit) {
        ctx.enrich.notice(
          `Showing the nearest ${limit} of ${sites.length} matching Superfund sites within the radius. ${limit < 200 ? 'Increase limit (maximum 200) or narrow the radius or other filters to retrieve more.' : 'Narrow the radius or add city, zip_code, or npl_status filters to retrieve a smaller set.'}`,
        );
      }
    }

    return sites.slice(0, limit);
  }

  /** Fetch a single Superfund site by exact SEMS site ID. */
  async searchSuperfundById(siteId: string, ctx: Context): Promise<SuperfundSite[]> {
    const url = this.buildTableUrl(
      'sems',
      'envirofacts_site',
      [{ column: 'site_id', operator: 'equals', value: siteId }],
      { first: 1, last: 1 },
    );
    ctx.log.debug('DMAP Superfund by ID', { siteId });
    const rows = await this.fetchTable<RawSemsSite>(
      url,
      ctx,
      dmapBudget('Superfund site lookup', 'Call again later.'),
    );
    return rows.map(normalizeSemsSite);
  }

  /** Search drinking water systems by state or ZIP code. */
  async searchWaterSystems(
    params: {
      state?: string;
      zipCode?: string;
      hasViolation?: boolean;
      pwsType?: string;
      limit?: number;
    },
    ctx: Context,
  ): Promise<WaterSystem[]> {
    const limit = params.limit ?? 50;
    const filters: DmapFilter[] = [];

    if (params.state) {
      filters.push({ column: 'primacy_agency_code', operator: 'equals', value: params.state });
    }
    if (params.zipCode) {
      filters.push({ column: 'zip_code', operator: 'equals', value: params.zipCode });
    }
    if (params.pwsType) {
      const typeMap: Record<string, string> = {
        community: 'CWS',
        'non-transient': 'NTNCWS',
        transient: 'TNCWS',
      };
      const typeCode = typeMap[params.pwsType] ?? params.pwsType;
      filters.push({ column: 'pws_type_code', operator: 'equals', value: typeCode });
    }

    if (filters.length === 0) return [];

    const budget = dmapBudget(
      'water system search',
      'Narrow it with zip_code or pws_type, or call again later.',
    );
    // sdwis.violation has no zip column: a ZIP's systems are checked by PWSID, a state is scanned.
    if (params.hasViolation && params.zipCode) {
      return this.searchViolatingWaterSystemsInZip(params.zipCode, filters, limit, ctx, budget);
    }
    if (params.hasViolation && params.state) {
      return this.searchViolatingWaterSystems(params.state, filters, limit, ctx, budget);
    }

    const url = this.buildTableUrl('sdwis', 'water_system', filters, { first: 1, last: limit });
    ctx.log.debug('DMAP water systems query', { state: params.state });

    const rows = await this.fetchTable<RawSdwisWaterSystem>(url, ctx, budget);
    return rows.slice(0, limit).map((r) => normalizeSdwisWaterSystem(r));
  }

  /**
   * Water systems in `state` with an open violation. water_system has no violation flag, so this
   * reads the first VIOLATION_SCAN_ROWS open rows of sdwis.violation, then looks up the systems
   * those rows name, PWSID_CHUNK_SIZE IDs per `pwsid in` request, until `limit` is filled. That is
   * at most 1 + VIOLATION_SCAN_ROWS / PWSID_CHUNK_SIZE requests. A state with more open violation
   * rows than the scan reads can have violators it never sees; the result then carries a notice.
   */
  private async searchViolatingWaterSystems(
    state: string,
    filters: DmapFilter[],
    limit: number,
    ctx: Context,
    budget: CallBudget,
  ): Promise<WaterSystem[]> {
    const violUrl = this.buildTableUrl(
      'sdwis',
      'violation',
      [{ column: 'primacy_agency_code', operator: 'equals', value: state }, OPEN_VIOLATION_FILTER],
      { first: 1, last: VIOLATION_SCAN_ROWS },
    );
    ctx.log.debug('DMAP SDWIS violation query', { state });
    const violRows = await this.fetchTable<RawSdwisViolation>(violUrl, ctx, budget);
    const violatingPwsids = pwsidSet(violRows);

    if (violRows.length >= VIOLATION_SCAN_ROWS) {
      ctx.enrich.notice(
        `The violation check stopped at the first ${VIOLATION_SCAN_ROWS.toLocaleString('en-US')} of ${state}'s open SDWIS violation records, which name ${violatingPwsids.size} distinct systems. Records past that point were not read, so these results may not include every system with an open violation in the state.`,
      );
    }

    const ids = [...violatingPwsids];
    const systems: WaterSystem[] = [];
    for (let i = 0; i < ids.length && systems.length < limit; i += PWSID_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + PWSID_CHUNK_SIZE);
      const url = this.buildTableUrl(
        'sdwis',
        'water_system',
        [...filters, { column: 'pwsid', operator: 'in', value: chunk.join(',') }],
        { first: 1, last: limit - systems.length },
      );
      ctx.log.debug('DMAP water systems query', { state, chunkStart: i, chunkSize: chunk.length });
      const rows = await this.fetchTable<RawSdwisWaterSystem>(url, ctx, budget);
      for (const row of rows.slice(0, limit - systems.length)) {
        systems.push(normalizeSdwisWaterSystem(row, violatingPwsids));
      }
    }
    return systems;
  }

  /**
   * Water systems in `zipCode` with an open violation. sdwis.violation has no zip column, so this
   * reads the ZIP's systems (up to ZIP_SYSTEM_SCAN_ROWS), then asks sdwis.violation for their open
   * rows PWSID_CHUNK_SIZE IDs at a time, in ZIP order, until `limit` violators are found. A ZIP
   * past the system read, or a chunk whose violation rows fill VIOLATION_SCAN_ROWS, can hide
   * violators; the result then carries a notice.
   */
  private async searchViolatingWaterSystemsInZip(
    zipCode: string,
    filters: DmapFilter[],
    limit: number,
    ctx: Context,
    budget: CallBudget,
  ): Promise<WaterSystem[]> {
    const url = this.buildTableUrl('sdwis', 'water_system', filters, {
      first: 1,
      last: ZIP_SYSTEM_SCAN_ROWS,
    });
    ctx.log.debug('DMAP water systems query', { zipCode });
    const zipRows = await this.fetchTable<RawSdwisWaterSystem>(url, ctx, budget);

    const notices: string[] = [];
    if (zipRows.length >= ZIP_SYSTEM_SCAN_ROWS) {
      notices.push(
        `The violation check read only the first ${ZIP_SYSTEM_SCAN_ROWS.toLocaleString('en-US')} water systems in ZIP ${zipCode}; systems past that point were not checked.`,
      );
    }

    const candidates = zipRows.filter(
      (r): r is RawSdwisWaterSystem & { pwsid: string } => typeof r.pwsid === 'string',
    );
    const systems: WaterSystem[] = [];
    let truncatedChunk = false;
    for (let i = 0; i < candidates.length && systems.length < limit; i += PWSID_CHUNK_SIZE) {
      const chunk = candidates.slice(i, i + PWSID_CHUNK_SIZE);
      const violUrl = this.buildTableUrl(
        'sdwis',
        'violation',
        [
          { column: 'pwsid', operator: 'in', value: chunk.map((r) => r.pwsid).join(',') },
          OPEN_VIOLATION_FILTER,
        ],
        { first: 1, last: VIOLATION_SCAN_ROWS },
      );
      ctx.log.debug('DMAP SDWIS violation query', {
        zipCode,
        chunkStart: i,
        chunkSize: chunk.length,
      });
      const violRows = await this.fetchTable<RawSdwisViolation>(violUrl, ctx, budget);
      if (violRows.length >= VIOLATION_SCAN_ROWS) truncatedChunk = true;
      const violatingPwsids = pwsidSet(violRows);
      for (const row of chunk) {
        if (systems.length >= limit) break;
        if (violatingPwsids.has(row.pwsid)) {
          systems.push(normalizeSdwisWaterSystem(row, violatingPwsids));
        }
      }
    }

    if (truncatedChunk) {
      notices.push(
        `The open violation records for a group of up to ${PWSID_CHUNK_SIZE} systems in ZIP ${zipCode} filled the ${VIOLATION_SCAN_ROWS.toLocaleString('en-US')}-row read; records past that point were not read, so these results may not include every system with an open violation in the ZIP.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
    return systems;
  }
}

// --- Init/accessor pattern ---

let _service: DmapService | undefined;

export function initDmapService(config: AppConfig, storage: StorageService): void {
  _service = new DmapService(config, storage);
}

export function getDmapService(): DmapService {
  if (!_service) {
    throw new Error('DmapService not initialized — call initDmapService() in setup()');
  }
  return _service;
}
