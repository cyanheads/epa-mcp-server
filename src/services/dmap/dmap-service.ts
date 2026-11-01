/**
 * @fileoverview Envirofacts DMAP REST service for TRI, Superfund, and drinking water data.
 * Wraps data.epa.gov/dmapservice REST endpoints.
 * @module services/dmap/dmap-service
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  JsonRpcErrorCode,
  notFound,
  serializationError,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { type CallBudget, callBudget } from '@/services/call-budget.js';
import { bareCountyName } from '@/services/county-name.js';
import type { SdwViolatorScope, WaterSystemType } from '@/services/echo/echo-service.js';
import { type Page, slicePage } from '@/services/page.js';
import type {
  RawSdwisWaterSystem,
  RawSemsSite,
  RawTriFacility,
  RawTriReleaseQty,
  RawTriReportingForm,
  SuperfundSite,
  SuperfundSiteDetail,
  TriRelease,
  TriSearchRelease,
  WaterSystem,
} from './types.js';

/**
 * One DMAP URL filter: `{column}/{operator}/{value}`. `literal` is set on a `contains` filter
 * whose value had characters replaced by DMAP's wildcard (containsFilter); rows must contain it.
 * `keep`, set with `literal`, replaces that containment check with its own test of the cell.
 */
type DmapFilter = {
  column: string;
  operator: string;
  value: string;
  literal?: string;
  keep?: (cell: string) => boolean;
};

/** A filter fetchMatchingRows checks each returned row against. */
type CheckedFilter = DmapFilter & { literal: string };

/** Whether `row` passes every checked filter: its `keep` test, or containing its literal text. */
function passesChecks(row: Record<string, unknown>, checked: CheckedFilter[]): boolean {
  return checked.every((f) => {
    const cell = String(row[f.column] ?? '');
    return f.keep ? f.keep(cell) : cell.toLowerCase().includes(f.literal.toLowerCase());
  });
}

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
      { reason: 'unmatchable_filter', value },
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
          { reason: 'unmatchable_filter', value, character },
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

/** The rows fetchMatchingRows kept, each with its zero-based upstream position. */
interface MatchedRows<T> {
  positions: number[];
  rows: T[];
  /** Upstream position where the read stopped; absent when DMAP ran out of rows first. */
  scanEnd?: number;
}

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
 * Every TRI form read sends it, a single-year one included, so paging rests on the unique
 * doc_ctrl_num rather than DMAP's unsorted order. Keys must be table-qualified: DMAP resolves a
 * bare column against the first table of a join (`reporting_year` there is HTTP 500). Without the
 * doc_ctrl_num tiebreak, AK rows `1:50` and `51:100` shared 36 records.
 */
const NEWEST_FIRST: DmapSortKey[] = [
  { column: 'tri.tri_reporting_form.reporting_year', direction: 'desc' },
  { column: 'tri.tri_reporting_form.doc_ctrl_num', direction: 'asc' },
];

/**
 * SEMS site ID order, so a Superfund row range pages deterministically on SEMS's unique site key
 * rather than DMAP's unsorted order. Live (2026-11-01), NJ's 2,217 rows carry 2,217 distinct
 * site IDs, and the sort costs nothing measurable on a 201-row page (3.09 s sorted, 3.11 s not).
 */
const BY_SITE_ID: DmapSortKey[] = [{ column: 'sems.envirofacts_site.site_id', direction: 'asc' }];

/** SEMS seq repeats across chemicals; the full exposed association tuple orders pages. */
const CONTAMINANT_ORDER: DmapSortKey[] = [
  'preferred_contaminant_name',
  'media_name',
  'operable_unit_num',
  'action_name',
  'type_code',
  'seq',
].map((column) => ({ column: `sems.envirofacts_contaminants.${column}`, direction: 'asc' }));
const CONTAMINANT_PAGE_ROWS = 100;
const contaminantRowsSchema = z.array(
  z.object({
    preferred_contaminant_name: z.string().nullish(),
    media_name: z.string().nullish(),
    operable_unit_num: z.string().nullish(),
    action_name: z.string().nullish(),
    type_code: z.string().nullish(),
  }),
);

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
  // one_time_release_qty is the only release qty in tri_reporting_form; the per-medium breakdown
  // lives in tri.tri_release_qty and is merged in by the callers through fetchReleaseBreakdown
  // (always for getTriReleases, opt-in for searchTriReleases).
  const oneTime = parseNum(raw.one_time_release_qty);
  if (oneTime !== undefined)
    result.oneTimeReleaseInLbs = inGrams ? gramsToPounds(oneTime) : oneTime;
  return result;
}

/** Per-medium on-site release sums for one TRI submission, in the unit the form was reported in. */
type MediumBreakdown = Pick<
  TriRelease,
  | 'releasesToAirInLbs'
  | 'releasesToWaterInLbs'
  | 'releasesToLandInLbs'
  | 'releasesToUndergroundInjectionInLbs'
>;

/**
 * Merge a submission's per-medium sums into its release, converting a gram-reported form to
 * pounds, and total the media present (Form R Sections 5.1–5.5.4). A range-coded medium is in
 * neither the fields nor the total; TRI's published on-site total counts it at its midpoint.
 */
function withBreakdown<T extends TriRelease>(
  release: T,
  breakdown: MediumBreakdown | undefined,
): T {
  if (!breakdown) return release;
  let pounds = breakdown;
  if (release.reportedUnit === 'grams') {
    pounds = {};
    for (const [field, grams] of Object.entries(breakdown) as Array<
      [keyof MediumBreakdown, number]
    >) {
      pounds[field] = gramsToPounds(grams);
    }
  }
  const total = Object.values(pounds).reduce((sum, lbs) => sum + lbs, 0);
  return { ...release, ...pounds, totalOnSiteReleasesInLbs: roundQuantity(total) };
}

/**
 * Map each tri.tri_release_qty environmental_medium code to the TriRelease field its quantity
 * rolls up into, following EPA's on-site release taxonomy: air (fugitive + stack), water, land
 * (landfills / treatment / impoundment / other disposal), and underground injection. These are
 * every code the table holds (live, 2026-11-01); an unknown code contributes nothing. Form R
 * replaced its one surface impoundment line (SURF IMP, 5.5.3) with two siblings in RY2003 —
 * SI 5.5.3A (RCRA Subtitle C) and SI 5.5.3B (other) — and no submission carries a quantity on
 * both forms of the line.
 */
const RELEASE_FIELD_BY_MEDIUM: Record<string, keyof MediumBreakdown> = {
  'AIR FUG': 'releasesToAirInLbs',
  'AIR STACK': 'releasesToAirInLbs',
  WATER: 'releasesToWaterInLbs',
  'RCRA C': 'releasesToLandInLbs',
  'OTH LANDF': 'releasesToLandInLbs',
  'LAND TREA': 'releasesToLandInLbs',
  'SURF IMP': 'releasesToLandInLbs',
  'SI 5.5.3A': 'releasesToLandInLbs',
  'SI 5.5.3B': 'releasesToLandInLbs',
  'OTH DISP': 'releasesToLandInLbs',
  LANDF8795: 'releasesToLandInLbs',
  'UNINJ I': 'releasesToUndergroundInjectionInLbs',
  'UNINJ IIV': 'releasesToUndergroundInjectionInLbs',
  UNINJ8795: 'releasesToUndergroundInjectionInLbs',
};

/**
 * PWSIDs per `pwsid in` request (a ~2,500-character URL), and per ECHO current-violation lookup
 * of a ZIP's or county's systems, so one lookup is one get_systems request.
 */
const PWSID_CHUNK_SIZE = 200;

/**
 * sdwis.water_system rows one ZIP or county violation check reads, in one request. Measured ZIPs
 * hold 10 (98104) and 194 (59901) systems and King County 519, so one read covers most; a check
 * is one DMAP read plus at most VIOLATION_CHECK_ROWS / PWSID_CHUNK_SIZE ECHO lookups, and a larger
 * match continues from the next row on the following call.
 */
const VIOLATION_CHECK_ROWS = 1000;

/**
 * PWSID order, so a water-system row range pages deterministically on SDWIS's unique system key.
 * Table-qualified, because a county search joins sdwis.geographic_area, which also has `pwsid`.
 */
const BY_PWSID: DmapSortKey[] = [{ column: 'sdwis.water_system.pwsid', direction: 'asc' }];

/** SDWIS pws_type_code per system type, the codes ECHO's p_systyp takes as well. */
const WATER_TYPE_CODES = {
  community: 'CWS',
  'non-transient': 'NTNCWS',
  transient: 'TNCWS',
} as const satisfies Record<WaterSystemType, string>;

/**
 * Looks up the systems in `scope` that ECHO reports with a current SDWA violation
 * (EchoService.findCurrentSdwViolators bound to the request context). Every request it makes takes
 * its deadline from `budget`, and a failed request rejects: it never reads as "no violations".
 */
export type CurrentViolatorLookup = (
  scope: SdwViolatorScope,
  budget: CallBudget,
) => Promise<{ pwsids: ReadonlySet<string> }>;

/**
 * The `county_served` filter for `county`, a bare uppercase name (bareCountyName). SDWIS stores
 * one comma-joined value per system ("Dallas,Johnson"), bare in most states and suffixed in
 * others ("Calcasieu Parish"), and DMAP's `equals` cannot carry a period ("St. Tammany"), so the
 * filter matches by `contains` (wildcarded through containsFilter) and keeps a row only when one
 * of its entries, suffix dropped, is the county itself: HARRIS keeps no Harrison row, BALTIMORE no
 * "Baltimore city" row. DMAP's `contains` is case-insensitive.
 */
function countyServedFilter(county: string): CheckedFilter {
  return {
    ...containsFilter('county_served', county),
    literal: county,
    keep: (cell) => cell.split(',').some((entry) => bareCountyName(entry) === county),
  };
}

/**
 * The SEMS npl_status_code values each npl_status choice sends: `listed` covers sites on the final
 * NPL (F) and sites that are part of an NPL site (A). `all` sends no filter.
 */
export const NPL_STATUS_CODES: ReadonlyMap<string, string> = new Map([
  ['listed', 'F,A'],
  ['not-listed', 'N'],
  ['proposed', 'P'],
  ['deleted', 'D'],
  ['removed', 'R'],
  ['withdrawn', 'W'],
]);

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
    ...(raw.npl_status_name != null && { nplStatusName: raw.npl_status_name }),
    ...(raw.non_npl_status_name != null && { nonNplStatusName: raw.non_npl_status_name }),
    ...(raw.archived_ind != null && { archivedInd: raw.archived_ind }),
    ...(raw.epa_id != null && { epaId: raw.epa_id }),
    ...(raw.federal_facility_ind != null && { federalFacilityInd: raw.federal_facility_ind }),
    ...(lat !== undefined && { latitude: lat }),
    ...(lng !== undefined && { longitude: lng }),
  };
}

/**
 * Normalize a raw SDWIS water system record. `currentViolation` marks a has_violation result,
 * which holds only systems ECHO reports with a current violation.
 */
function normalizeSdwisWaterSystem(
  raw: RawSdwisWaterSystem,
  currentViolation = false,
): WaterSystem {
  const pop = parseNum(raw.population_served_count);
  return {
    pwsid: raw.pwsid ?? '',
    name: raw.pws_name ?? '',
    ...(raw.primacy_agency_code && { state: raw.primacy_agency_code as string }),
    // actual field is city_name, not city_served
    ...(raw.city_name && { city: raw.city_name as string }),
    ...(raw.zip_code && { zip: raw.zip_code as string }),
    ...(raw.pws_type_code && { type: raw.pws_type_code as string }),
    ...(raw.primary_source_code && { primarySourceCode: raw.primary_source_code as string }),
    ...(pop !== undefined && { populationServed: pop }),
    ...(currentViolation && { hasViolation: true }),
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
   * match throws a ValidationError naming it (reason `unmatchable_filter`); `contains` values
   * arrive already rewritten by containsFilter.
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
   * as a ValidationError with reason `filter_too_long`. DMAP answers HTTP 400 only from its front
   * end, for a request it cannot parse, never for a filter value — those are HTTP 500. A 400 that
   * still arrives is a request this server built wrong, not the caller's input, and maps to
   * InternalError rather than the default InvalidParams. A fully read 200 body that is not JSON
   * fails once as a SerializationError; transport and HTTP failures keep their retries.
   */
  private fetchTable<T>(url: string, ctx: Context, budget: CallBudget): Promise<T[]> {
    const countedBytes = requestLineBytes(url) - DMAP_UNCOUNTED_BYTES;
    if (countedBytes > DMAP_REQUEST_LINE_LIMIT) {
      return Promise.reject(
        validationError(
          `The search filters are too long for EPA's DMAP service: the request would be ${countedBytes} bytes, over its ${DMAP_REQUEST_LINE_LIMIT}-byte limit. Shorten the text filters.`,
          { reason: 'filter_too_long', requestLineBytes: countedBytes },
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
        // A fully read body that does not parse fails once: withRetry would retry a bare SyntaxError.
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (cause) {
          throw serializationError(
            'EPA DMAP returned a response that is not JSON. Call again later.',
            undefined,
            { cause },
          );
        }
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
   * Fetch up to `wanted` matching rows from zero-based upstream position `offset`. Without a
   * checked filter (`literal` set) that is one request ranged `offset+1:offset+wanted`. With one,
   * DMAP's rows can include near-variants that match only through the wildcard, or a `keep`
   * test drops, so pages of at least EXACT_TEXT_PAGE_ROWS are read and narrowed (passesChecks),
   * until `wanted` are found, DMAP runs out, or EXACT_TEXT_MAX_PAGES are read. A walk the page
   * limit ends short of `wanted` carries a notice that more matches may exist.
   */
  private async fetchMatchingRows<T extends Record<string, unknown>>(
    urlForRange: (range: { first: number; last: number }) => string,
    filters: DmapFilter[],
    offset: number,
    wanted: number,
    ctx: Context,
    budget: CallBudget,
  ): Promise<MatchedRows<T>> {
    const wildcarded = filters.filter((f): f is CheckedFilter => f.literal !== undefined);
    if (wildcarded.length === 0) {
      const rows = await this.fetchTable<T>(
        urlForRange({ first: offset + 1, last: offset + wanted }),
        ctx,
        budget,
      );
      return {
        rows,
        positions: rows.map((_, i) => offset + i),
        ...(rows.length === wanted && { scanEnd: offset + wanted }),
      };
    }
    const pageRows = Math.max(wanted, EXACT_TEXT_PAGE_ROWS);
    const matches: T[] = [];
    const positions: number[] = [];
    let scanned = 0;
    let exhausted = false;
    for (let page = 0; page < EXACT_TEXT_MAX_PAGES && matches.length < wanted; page++) {
      const start = offset + scanned;
      const rows = await this.fetchTable<T>(
        urlForRange({ first: start + 1, last: start + pageRows }),
        ctx,
        budget,
      );
      rows.forEach((row, i) => {
        if (passesChecks(row, wildcarded) && matches.length < wanted) {
          matches.push(row);
          positions.push(start + i);
        }
      });
      scanned += pageRows;
      if (rows.length < pageRows) {
        exhausted = true;
        break;
      }
    }
    if (!exhausted && matches.length < wanted) {
      const texts = wildcarded.map((f) => `"${f.literal}"`).join(' and ');
      const kept = `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}`;
      const verb = wildcarded.length === 1 ? 'was' : 'were';
      const kind = wildcarded.some((f) => f.keep) ? 'containing it' : 'matching the wildcard';
      const span = scanned.toLocaleString('en-US');
      const read =
        offset === 0
          ? `the first ${span} rows ${kind}`
          : `the ${span} rows ${kind} after offset ${offset.toLocaleString('en-US')}`;
      ctx.enrich.notice(
        wildcarded.some((f) => f.keep)
          ? `${texts} ${verb} matched as part of a longer value and kept only as a whole entry, and ${read} held ${kept}, so more may exist past them. Continue from nextOffset.`
          : `${texts} ${verb} searched with a one-character wildcard in place of punctuation, and ${read} held ${kept} spelled as given, so more may exist past them. Narrow the search with other filters or more of the text.`,
      );
    }
    return { rows: matches, positions, ...(!exhausted && { scanEnd: offset + scanned }) };
  }

  /**
   * One page of `limit` matching rows from upstream position `offset`. It reads one match more
   * than it returns, so `nextOffset` is exact: the position of that extra match, which can skip
   * rows a wildcard pass dropped. A wildcard walk its page limit ends with no extra match
   * continues from where the walk stopped.
   */
  private async fetchPage<T extends Record<string, unknown>>(
    urlForRange: (range: { first: number; last: number }) => string,
    filters: DmapFilter[],
    { offset, limit }: { offset: number; limit: number },
    ctx: Context,
    budget: CallBudget,
  ): Promise<Page<T>> {
    const { rows, positions, scanEnd } = await this.fetchMatchingRows<T>(
      urlForRange,
      filters,
      offset,
      limit + 1,
      ctx,
      budget,
    );
    if (rows.length > limit) {
      return { items: rows.slice(0, limit), nextOffset: positions[limit] as number };
    }
    return { items: rows, ...(scanEnd !== undefined && { nextOffset: scanEnd }) };
  }

  /**
   * One page of a facility's TRI filings, newest reporting year first, then by submission number;
   * `limit` defaults to 500 and `offset` to 0.
   */
  async getTriReleases(
    params: {
      facilityId: string;
      year?: number;
      chemicalName?: string;
      offset?: number;
      limit?: number;
    },
    ctx: Context,
  ): Promise<Page<TriRelease>> {
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

    const page = await this.fetchPage<RawTriReportingForm>(
      (range) =>
        this.buildTableUrl('tri', 'tri_reporting_form', filters, range, { sort: NEWEST_FIRST }),
      filters,
      { offset: params.offset ?? 0, limit: params.limit ?? 500 },
      ctx,
      budget,
    );
    const items = await this.withReleaseBreakdown(
      page.items,
      page.items.map(normalizeTriRelease),
      ctx,
      budget,
    );
    return { ...page, items };
  }

  /**
   * Add each release's per-medium on-site breakdown (tri.tri_release_qty, joined on doc_ctrl_num).
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
   * Fetch the per-medium on-site releases (tri.tri_release_qty) for a set of TRI submissions and
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
   * forms, and the row range selects one page of joined rows. The joined rows are sorted newest
   * reporting year first, then by submission number, so `offset` and `limit` page the most recent
   * filings first and every page is a slice of one order. However sparse the filters, a page is
   * one request (more only for a punctuated text filter's walk); with includeReleaseBreakdown,
   * fetchReleaseBreakdown adds the per-medium on-site releases to every kept record (one request at
   * the 200-record cap). The facility's Registry ID and parent company ride in the joined rows.
   */
  async searchTriReleases(
    params: {
      state: string;
      county?: string;
      year?: number;
      chemicalName?: string;
      offset?: number;
      limit?: number;
      includeReleaseBreakdown?: boolean;
    },
    ctx: Context,
  ): Promise<Page<TriSearchRelease>> {
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
    const page = await this.fetchPage<RawTriReportingForm & RawTriFacility>(
      (range) =>
        this.buildTableUrl('tri', 'tri_facility', facilityFilters, range, {
          join: {
            table: 'tri.tri_reporting_form',
            on: { left: 'tri_facility_id', right: 'tri_facility_id' },
            filters: formFilters,
          },
          sort: NEWEST_FIRST,
        }),
      [...facilityFilters, ...formFilters],
      { offset: params.offset ?? 0, limit: params.limit ?? 50 },
      ctx,
      budget,
    );
    const releases = page.items.map((row): TriSearchRelease => {
      const parent = row.standardized_parent_company;
      return {
        ...normalizeTriRelease(row),
        facilityName: row.facility_name ?? '',
        ...(row.county_name && { countyName: row.county_name }),
        ...(row.epa_registry_id && { registryId: row.epa_registry_id }),
        // TRI writes NA for a facility that reported no parent company.
        ...(parent && parent.trim() !== 'NA' && { parentCompany: parent }),
      };
    });

    const items = params.includeReleaseBreakdown
      ? await this.withReleaseBreakdown(page.items, releases, ctx, budget)
      : releases;
    return { ...page, items };
  }

  /**
   * One page of Superfund sites by state, city, or ZIP, or by coordinates + radius; `limit`
   * defaults to 50 and `offset` to 0. An administrative search reads its row range in site ID
   * order (fetchPage), so `nextOffset` is an upstream position and `totalCount` stays absent:
   * DMAP reports no match count. A proximity search scans every candidate on each call, ranks the
   * matches nearest first with a site ID tiebreak, and slices the page from that order, so its
   * `totalCount` is the full match and `nextOffset` a position in it.
   */
  async searchSuperfund(
    params: {
      state?: string;
      city?: string;
      zipCode?: string;
      latitude?: number;
      longitude?: number;
      radiusMiles?: number;
      nplStatus?: string;
      excludeArchived?: boolean;
      offset?: number;
      limit?: number;
    },
    ctx: Context,
  ): Promise<Page<SuperfundSite>> {
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 50;
    const filters: DmapFilter[] = [];

    if (params.state) {
      filters.push({ column: 'fk_ref_state_code', operator: 'equals', value: params.state });
    }
    if (params.city) {
      filters.push(containsFilter('city_name', params.city));
    }
    if (params.zipCode) {
      // SEMS stores a ZIP+4 for some sites ("07631-2720"), so a 5-digit ZIP matches by prefix.
      filters.push({ column: 'zip_code', operator: 'beginsWith', value: params.zipCode });
    }
    const nplCode = params.nplStatus && NPL_STATUS_CODES.get(params.nplStatus);
    if (nplCode) {
      filters.push({
        column: 'npl_status_code',
        operator: nplCode.includes(',') ? 'in' : 'equals',
        value: nplCode,
      });
    }
    if (params.excludeArchived) {
      filters.push({ column: 'archived_ind', operator: 'equals', value: 'N' });
    }

    const { latitude, longitude, radiusMiles } = params;
    const proximity =
      latitude !== undefined && longitude !== undefined && radiusMiles !== undefined;
    // A coordinate search supplies its own latitude-prefix filter below.
    if (filters.length === 0 && !proximity) {
      ctx.log.debug('DMAP Superfund query: no filters, returning empty');
      return { items: [] };
    }

    ctx.log.debug('DMAP Superfund query', { state: params.state, lat: params.latitude });
    const budget = dmapBudget(
      'Superfund site search',
      'Narrow it with radius_miles, zip_code, city, or npl_status, or call again later.',
    );
    if (!proximity) {
      const page = await this.fetchPage<RawSemsSite>(
        (range) =>
          this.buildTableUrl('sems', 'envirofacts_site', filters, range, { sort: BY_SITE_ID }),
        filters,
        { offset, limit },
        ctx,
        budget,
      );
      return { ...page, items: page.items.map(normalizeSemsSite) };
    }

    const candidates = new Map<string, RawSemsSite>();
    const prefixes = proximityPrefixes(latitude, longitude, radiusMiles);
    /** Broad circles avoid multiplying latitude bands by many mostly empty longitude bins. */
    const broad = prefixes.longitudes.length > 4;
    const partitions = prefixes.latitudes.flatMap((latPrefix) =>
      (broad ? [undefined] : prefixes.longitudes).map((lonPrefix) => ({ latPrefix, lonPrefix })),
    );
    const pageRows = broad ? 2000 : 500;
    const siblings = new AbortController();
    const signal = AbortSignal.any([ctx.signal, siblings.signal]);
    const scanContext = { ...ctx, signal };
    const pendingPartitions = partitions.values();
    const scan = async () => {
      while (!signal.aborted) {
        const partition = pendingPartitions.next();
        if (partition.done) return;
        const { latPrefix, lonPrefix } = partition.value;
        const seen = new Set<string>();
        for (let first = 1; ; first += pageRows) {
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
              { first, last: first + pageRows - 1 },
              { sort: BY_SITE_ID },
            ),
            scanContext,
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
              const site = normalizeSemsSite(row);
              if (
                site.latitude !== undefined &&
                site.longitude !== undefined &&
                haversineDistanceMiles(latitude, longitude, site.latitude, site.longitude) <=
                  radiusMiles
              ) {
                candidates.set(row.site_id || JSON.stringify(row), row);
              }
            }
          }
          if (page.length < pageRows) break;
        }
      }
    };
    const workers = Array.from({ length: broad ? Math.min(8, partitions.length) : 1 }, async () => {
      try {
        await scan();
      } catch (error) {
        if (!siblings.signal.aborted) siblings.abort(error);
        throw error;
      }
    });
    await Promise.allSettled(workers);
    ctx.signal.throwIfAborted();
    if (siblings.signal.aborted) throw siblings.signal.reason;

    // Every call rescans the whole match, so each page is a slice of one nearest-first order.
    const ranked = [...candidates.values()]
      .map(normalizeSemsSite)
      .flatMap((site) => {
        if (site.latitude === undefined || site.longitude === undefined) return [];
        const distance = haversineDistanceMiles(latitude, longitude, site.latitude, site.longitude);
        return distance <= radiusMiles ? [{ site, distance }] : [];
      })
      .sort((a, b) => a.distance - b.distance || a.site.siteId.localeCompare(b.site.siteId))
      .map(({ site }) => site);
    const page = slicePage(ranked, { limit, offset });
    const { items } = page;
    const coverage =
      'Proximity searches match only sites with usable coordinates. Administrative searches can also find sites without coordinates.';
    const position =
      items.length === 1 ? `site ${offset + 1}` : `sites ${offset + 1}–${offset + items.length}`;
    ctx.enrich.notice(
      items.length > 0 && items.length < ranked.length
        ? `${coverage} Showing ${position} of ${ranked.length.toLocaleString('en-US')} matching Superfund sites within the radius, nearest first.`
        : coverage,
    );
    return page;
  }

  /** Fetch a single Superfund site by exact SEMS site ID. */
  private async fetchSuperfundById(
    siteId: string,
    ctx: Context,
    budget: CallBudget,
  ): Promise<SuperfundSite[]> {
    const url = this.buildTableUrl(
      'sems',
      'envirofacts_site',
      [{ column: 'site_id', operator: 'equals', value: siteId }],
      { first: 1, last: 1 },
    );
    ctx.log.debug('DMAP Superfund by ID', { siteId });
    const rows = await this.fetchTable<RawSemsSite>(url, ctx, budget);
    return rows.map(normalizeSemsSite);
  }

  /** Fetch an exact site and exhaust its contaminant associations under one total deadline. */
  async getSuperfundSite(siteId: string, ctx: Context): Promise<SuperfundSiteDetail> {
    const budget = dmapBudget('Superfund site and contaminant lookup', 'Call again later.');
    const [site] = await this.fetchSuperfundById(siteId, ctx, budget);
    if (!site) {
      throw notFound(
        `No Superfund site found with site ID "${siteId}". Use epa_superfund_search_sites to discover valid site IDs.`,
        { reason: 'site_not_found', siteId },
      );
    }
    const contaminants: SuperfundSiteDetail['contaminants'] = [];
    for (let first = 1; ; first += CONTAMINANT_PAGE_ROWS) {
      const raw = await this.fetchTable<unknown>(
        this.buildTableUrl(
          'sems',
          'envirofacts_contaminants',
          [{ column: 'fk_site_id', operator: 'equals', value: siteId }],
          { first, last: first + CONTAMINANT_PAGE_ROWS - 1 },
          { sort: CONTAMINANT_ORDER },
        ),
        ctx,
        budget,
      );
      const parsed = contaminantRowsSchema.safeParse(raw);
      if (!parsed.success)
        throw serializationError(
          'EPA SEMS returned an invalid contaminant association. Call again later.',
          undefined,
          { cause: parsed.error },
        );
      const rows = parsed.data;
      for (const row of rows) {
        contaminants.push({
          ...(row.preferred_contaminant_name != null && { name: row.preferred_contaminant_name }),
          ...(row.media_name != null && { medium: row.media_name }),
          ...(row.operable_unit_num != null && { operableUnit: row.operable_unit_num }),
          ...(row.action_name != null && { action: row.action_name }),
          ...(row.type_code != null && { typeCode: row.type_code }),
        });
      }
      if (rows.length < CONTAMINANT_PAGE_ROWS) break;
    }
    return { site, contaminants };
  }

  /**
   * One page of drinking water systems by state, ZIP, or county served, in PWSID order; `limit`
   * defaults to 50 and `offset` to 0. `state` is the primacy agency (primacy_agency_code).
   * `zipCode` matches the address of record by prefix, so a stored ZIP+4 matches its five-digit
   * ZIP. `county`, a bare uppercase name (bareCountyName), joins sdwis.geographic_area and keeps
   * the systems that serve it (countyServedFilter). `activeOnly` keeps pws_activity_code A.
   *
   * With `currentViolators`, the page holds only systems it reports with a current violation: a
   * state search asks it for the state's violators first (pageCurrentViolatorsInState), a ZIP or
   * county search reads its systems first and asks about them by PWSID
   * (pageCurrentViolatorsAmong). Its requests and DMAP's share one deadline. Without it, no ECHO
   * request is made.
   *
   * `nextOffset` is an upstream position — a row in the PWSID-ordered match, or for a state
   * violation search a place in the violator list — so it can skip rows a check dropped.
   * `totalCount` is set only when the call saw the whole match: offset 0 and nothing past it.
   */
  async searchWaterSystems(
    params: {
      state?: string;
      zipCode?: string;
      county?: string;
      pwsType?: WaterSystemType;
      activeOnly?: boolean;
      currentViolators?: CurrentViolatorLookup;
      offset?: number;
      limit?: number;
    },
    ctx: Context,
  ): Promise<Page<WaterSystem>> {
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 50;
    const filters: DmapFilter[] = [];

    if (params.state) {
      filters.push({ column: 'primacy_agency_code', operator: 'equals', value: params.state });
    }
    if (params.zipCode) {
      // SDWIS stores ZIP+4 and nine-digit forms beside five-digit ZIPs (98104-3122, 985093400).
      filters.push({ column: 'zip_code', operator: 'beginsWith', value: params.zipCode });
    }
    if (params.pwsType) {
      filters.push({
        column: 'pws_type_code',
        operator: 'equals',
        value: WATER_TYPE_CODES[params.pwsType],
      });
    }
    if (params.activeOnly) {
      filters.push({ column: 'pws_activity_code', operator: 'equals', value: 'A' });
    }
    const county = params.county === undefined ? undefined : countyServedFilter(params.county);
    if (filters.length === 0 && !county) return { items: [] };

    const lookup = params.currentViolators;
    const budget = callBudget(
      lookup ? 'DMAP and ECHO' : 'DMAP',
      'water system search',
      CALL_DEADLINE_MS,
      'Narrow it with zip_code, county, pws_type, or active_only, or call again later.',
    );
    const checked = county ? [county] : [];
    const urlForRange = (range: { first: number; last: number }) =>
      this.buildTableUrl('sdwis', 'water_system', filters, range, {
        ...(county && {
          join: {
            table: 'sdwis.geographic_area',
            on: { left: 'pwsid', right: 'pwsid' },
            filters: checked,
          },
        }),
        sort: BY_PWSID,
      });
    ctx.log.debug('DMAP water systems query', {
      state: params.state,
      zipCode: params.zipCode,
      county: params.county,
      offset,
    });

    if (lookup && params.state && !params.zipCode && !county) {
      return this.pageCurrentViolatorsInState(
        { state: params.state, pwsType: params.pwsType, filters, lookup },
        { offset, limit },
        ctx,
        budget,
      );
    }
    if (lookup) {
      return this.pageCurrentViolatorsAmong(
        urlForRange,
        checked,
        lookup,
        { offset, limit },
        ctx,
        budget,
      );
    }
    const page = await this.fetchPage<RawSdwisWaterSystem>(
      urlForRange,
      checked,
      { offset, limit },
      ctx,
      budget,
    );
    const items = page.items.map((row) => normalizeSdwisWaterSystem(row));
    return {
      items,
      ...(page.nextOffset !== undefined
        ? { nextOffset: page.nextOffset }
        : offset === 0 && { totalCount: items.length }),
    };
  }

  /**
   * One page of `state`'s systems with a current violation. The violator list comes first, in
   * PWSID order: ECHO's `p_st` (the system's location; an EPA region code or NN selects that
   * primacy agency's systems) narrowed by `p_systyp`. Each PWSID_CHUNK_SIZE slice of it from
   * `offset` is then read whole with `pwsid in` and the search's own filters, which keep `state`
   * a primacy-agency filter (WA's list also names systems in WA under EPA Region 10 primacy, and
   * those drop out here) and apply active_only. The walk stops once `limit + 1` systems are kept;
   * `nextOffset` is the list position of the first one left over. `totalCount` is exact when the
   * walk read the whole list from position 0: WA's 166 violators are one slice.
   */
  private async pageCurrentViolatorsInState(
    search: {
      state: string;
      pwsType: WaterSystemType | undefined;
      filters: DmapFilter[];
      lookup: CurrentViolatorLookup;
    },
    { offset, limit }: { offset: number; limit: number },
    ctx: Context,
    budget: CallBudget,
  ): Promise<Page<WaterSystem>> {
    const { state, pwsType, filters, lookup } = search;
    const { pwsids } = await lookup({ state, ...(pwsType && { systemType: pwsType }) }, budget);
    const violators = [...pwsids];
    const kept: KeptSystem[] = [];
    let start = offset;
    for (; start < violators.length && kept.length <= limit; start += PWSID_CHUNK_SIZE) {
      const chunk = violators.slice(start, start + PWSID_CHUNK_SIZE);
      const url = this.buildTableUrl(
        'sdwis',
        'water_system',
        [...filters, { column: 'pwsid', operator: 'in', value: chunk.join(',') }],
        { first: 1, last: chunk.length },
      );
      ctx.log.debug('DMAP water systems lookup', { state, start, chunkSize: chunk.length });
      const rows = await this.fetchTable<RawSdwisWaterSystem>(url, ctx, budget);
      const byPwsid = new Map(rows.map((row) => [row.pwsid, row]));
      for (const [i, pwsid] of chunk.entries()) {
        const row = byPwsid.get(pwsid);
        if (row) kept.push({ row, position: start + i });
      }
    }
    return violatorPage(kept, limit, offset === 0 && start >= violators.length);
  }

  /**
   * One page of a ZIP's or county's systems with a current violation. It reads
   * VIOLATION_CHECK_ROWS rows of the PWSID-ordered match from `offset` in one request, keeps the
   * rows passing `checked` (the county test), and looks them up PWSID_CHUNK_SIZE at a time until
   * `limit + 1` violators are found; `nextOffset` is the row position of the first one left over.
   * A full read that leaves the page short has rows past it unchecked, so `nextOffset` is the
   * next row and a notice says so. `totalCount` is exact when every row from position 0 was
   * checked.
   */
  private async pageCurrentViolatorsAmong(
    urlForRange: (range: { first: number; last: number }) => string,
    checked: CheckedFilter[],
    lookup: CurrentViolatorLookup,
    { offset, limit }: { offset: number; limit: number },
    ctx: Context,
    budget: CallBudget,
  ): Promise<Page<WaterSystem>> {
    const rows = await this.fetchTable<RawSdwisWaterSystem>(
      urlForRange({ first: offset + 1, last: offset + VIOLATION_CHECK_ROWS }),
      ctx,
      budget,
    );
    const candidates = rows.flatMap((row, i) =>
      row.pwsid !== undefined && passesChecks(row, checked)
        ? [{ row, pwsid: row.pwsid, position: offset + i }]
        : [],
    );
    const kept: KeptSystem[] = [];
    let start = 0;
    for (; start < candidates.length && kept.length <= limit; start += PWSID_CHUNK_SIZE) {
      const batch = candidates.slice(start, start + PWSID_CHUNK_SIZE);
      const { pwsids } = await lookup({ pwsids: batch.map((c) => c.pwsid) }, budget);
      kept.push(...batch.filter((c) => pwsids.has(c.pwsid)));
    }
    const fullRead = rows.length === VIOLATION_CHECK_ROWS;
    const page = violatorPage(kept, limit, offset === 0 && !fullRead && start >= candidates.length);
    if (page.nextOffset !== undefined || !fullRead) return page;
    const next = offset + VIOLATION_CHECK_ROWS;
    ctx.enrich.notice(
      `The violation check read ${VIOLATION_CHECK_ROWS.toLocaleString('en-US')} systems from offset ${offset.toLocaleString('en-US')} and found ${kept.length} with a current violation; systems from offset ${next.toLocaleString('en-US')} on were not checked in this call.`,
    );
    return { ...page, nextOffset: next };
  }
}

/** A water system a violation check kept, with its upstream position. */
interface KeptSystem {
  position: number;
  row: RawSdwisWaterSystem;
}

/**
 * The page a violation check returns: the first `limit` kept systems, `nextOffset` at the first
 * one past them, and `totalCount` when `sawWholeMatch`.
 */
function violatorPage(
  kept: KeptSystem[],
  limit: number,
  sawWholeMatch: boolean,
): Page<WaterSystem> {
  const next = kept[limit];
  return {
    items: kept.slice(0, limit).map(({ row }) => normalizeSdwisWaterSystem(row, true)),
    ...(next && { nextOffset: next.position }),
    ...(sawWholeMatch && { totalCount: kept.length }),
  };
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
