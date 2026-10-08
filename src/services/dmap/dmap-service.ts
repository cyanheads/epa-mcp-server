/**
 * @fileoverview Envirofacts DMAP REST service for TRI, Superfund, and drinking water data.
 * Wraps data.epa.gov/dmapservice REST endpoints.
 * @module services/dmap/dmap-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
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

/** One DMAP URL filter: `{column}/{operator}/{value}`. */
type DmapFilter = { column: string; operator: string; value: string };

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
  // breakdown lives in tri.tri_release_qty and is merged in by the callers after one batched
  // fetchReleaseBreakdown request (always for getTriReleases, opt-in for searchTriReleases).
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

export class DmapService {
  private readonly baseUrl: string;

  constructor(_config: AppConfig, _storage: StorageService) {
    this.baseUrl = getServerConfig().dmapBaseUrl;
  }

  /**
   * Build a DMAP REST URL for a multi-filter query.
   * Format: {base}/{schema}.{table}/{col1}/{op1}/{val1}/and/{col2}/{op2}/{val2}/{first}:{last}
   * Rows are 1-based and inclusive: `1:50` is 50 rows. DMAP reads a `first` of 0 as row 1, so
   * `0:49` would return only 49.
   *
   * With `join`, an inner join follows the filters:
   * `/join/{schema}.{table}/{leftColumn}/equals/{rightColumn}/and/{filter}…`. Filters before the
   * join bind to the first table only (DMAP rejects a column the first table lacks); filters
   * after the join comparison bind to the joined table. The range then counts joined rows.
   */
  private buildTableUrl(
    schema: string,
    table: string,
    filters: DmapFilter[],
    pagination: { first: number; last: number },
    join?: {
      table: string;
      on: { left: string; right: string };
      filters: DmapFilter[];
    },
  ): string {
    const toPath = (list: DmapFilter[]) =>
      list
        .map((f) => `${encodeURIComponent(f.column)}/${f.operator}/${encodeURIComponent(f.value)}`)
        .join('/and/');
    const joinPath = join
      ? `/join/${join.table}/${join.on.left}/equals/${join.on.right}${join.filters.length > 0 ? `/and/${toPath(join.filters)}` : ''}`
      : '';
    const pagePath = `${pagination.first}:${pagination.last}`;
    return `${this.baseUrl}/${schema}.${table}/${toPath(filters)}${joinPath}/${pagePath}`;
  }

  /** Fetch a DMAP table result as JSON array. */
  // biome-ignore lint/suspicious/useAwait: delegates to withRetry() which returns a Promise — async typing is correct
  private async fetchTable<T>(url: string, ctx: Context): Promise<T[]> {
    return withRetry(
      async () => {
        const jsonUrl = url.endsWith('/json') ? url : `${url}/json`;
        const response = await fetch(jsonUrl, { signal: ctx.signal });
        if (!response.ok) {
          throw await httpErrorFromResponse(response, { service: 'DMAP' });
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
      },
    );
  }

  /** Get TRI releases for a specific facility. */
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
      filters.push({
        column: 'cas_chem_name',
        operator: 'contains',
        value: params.chemicalName,
      });
    }

    const url = this.buildTableUrl('tri', 'tri_reporting_form', filters, { first: 1, last: 500 });
    ctx.log.debug('DMAP TRI releases query', { facilityId: params.facilityId, year: params.year });

    const rows = await this.fetchTable<RawTriReportingForm>(url, ctx);
    return this.withReleaseBreakdown(rows, rows.map(normalizeTriRelease), ctx);
  }

  /**
   * Add each release's per-medium routine breakdown (tri.tri_release_qty, joined on doc_ctrl_num)
   * with one batched request. `releases[i]` is the normalized form of `rows[i]`.
   */
  private async withReleaseBreakdown<T extends TriRelease>(
    rows: RawTriReportingForm[],
    releases: T[],
    ctx: Context,
  ): Promise<T[]> {
    const docCtrlNums = [
      ...new Set(
        rows
          .map((r) => r.doc_ctrl_num)
          .filter((d): d is string => typeof d === 'string' && d.length > 0),
      ),
    ];
    if (docCtrlNums.length === 0) return releases;
    const breakdownByDoc = await this.fetchReleaseBreakdown(docCtrlNums, ctx);
    return releases.map((release, i) => {
      const doc = rows[i]?.doc_ctrl_num;
      return withBreakdown(release, typeof doc === 'string' ? breakdownByDoc.get(doc) : undefined);
    });
  }

  /**
   * Batch-fetch the per-medium routine releases (tri.tri_release_qty) for a set of TRI
   * submissions and roll them up into air/water/land/underground-injection sums keyed by
   * doc_ctrl_num. getTriReleases makes this one request per call; searchTriReleases makes it
   * once per call, and only when includeReleaseBreakdown is set — an uncached tri_release_qty
   * query takes ~20 s upstream.
   *
   * Sparsity is preserved: a row flagged release_na="1" (medium not applicable) or carrying only
   * a release_range_code (no hard total_release) contributes nothing — a null quantity is never
   * coerced to 0.
   */
  private async fetchReleaseBreakdown(
    docCtrlNums: string[],
    ctx: Context,
  ): Promise<Map<string, MediumBreakdown>> {
    const url = this.buildTableUrl(
      'tri',
      'tri_release_qty',
      [{ column: 'doc_ctrl_num', operator: 'in', value: docCtrlNums.join(',') }],
      { first: 1, last: docCtrlNums.length * 30 },
    );
    ctx.log.debug('DMAP TRI release-qty breakdown query', { submissions: docCtrlNums.length });

    const rows = await this.fetchTable<RawTriReleaseQty>(url, ctx);

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
   * forms, and the row range caps the joined rows at `limit`. However sparse the filters, the
   * search is one request; with includeReleaseBreakdown, one fetchReleaseBreakdown request adds
   * the per-medium routine releases to every kept record.
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
      facilityFilters.push({ column: 'county_name', operator: 'contains', value: params.county });
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
      formFilters.push({
        column: 'cas_chem_name',
        operator: 'contains',
        value: params.chemicalName,
      });
    }

    const url = this.buildTableUrl(
      'tri',
      'tri_facility',
      facilityFilters,
      { first: 1, last: limit },
      {
        table: 'tri.tri_reporting_form',
        on: { left: 'tri_facility_id', right: 'tri_facility_id' },
        filters: formFilters,
      },
    );
    ctx.log.debug('DMAP TRI facility-form join query', {
      state: params.state,
      county: params.county,
      year: params.year,
    });

    const rows = await this.fetchTable<RawTriReportingForm & RawTriFacility>(url, ctx);
    const kept = rows.slice(0, limit);
    const releases = kept.map((row) => ({
      ...normalizeTriRelease(row),
      facilityName: row.facility_name ?? '',
      ...(row.county_name && { countyName: row.county_name }),
    }));

    return params.includeReleaseBreakdown
      ? this.withReleaseBreakdown(kept, releases, ctx)
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
      filters.push({ column: 'city_name', operator: 'contains', value: params.city });
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

    // Need at least one filter for DMAP; fall back to a no-op that returns empty
    if (filters.length === 0) {
      ctx.log.debug('DMAP Superfund query: no filters, returning empty');
      return [];
    }

    const pageSize =
      params.latitude !== undefined && params.longitude !== undefined
        ? Math.min(500, limit * 10)
        : limit;
    const url = this.buildTableUrl('sems', 'envirofacts_site', filters, {
      first: 1,
      last: pageSize,
    });
    ctx.log.debug('DMAP Superfund query', { state: params.state, lat: params.latitude });

    const rows = await this.fetchTable<RawSemsSite>(url, ctx);
    let sites = rows.map(normalizeSemsSite);

    if (params.latitude !== undefined && params.longitude !== undefined && params.radiusMiles) {
      const originLat = params.latitude;
      const originLng = params.longitude;
      sites = sites.filter((site) => {
        if (site.latitude === undefined || site.longitude === undefined) return false;
        const dist = haversineDistanceMiles(originLat, originLng, site.latitude, site.longitude);
        return dist <= (params.radiusMiles ?? 0);
      });
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
    const rows = await this.fetchTable<RawSemsSite>(url, ctx);
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

    // sdwis.violation has no zip column: a ZIP's systems are checked by PWSID, a state is scanned.
    if (params.hasViolation && params.zipCode) {
      return this.searchViolatingWaterSystemsInZip(params.zipCode, filters, limit, ctx);
    }
    if (params.hasViolation && params.state) {
      return this.searchViolatingWaterSystems(params.state, filters, limit, ctx);
    }

    const url = this.buildTableUrl('sdwis', 'water_system', filters, { first: 1, last: limit });
    ctx.log.debug('DMAP water systems query', { state: params.state });

    const rows = await this.fetchTable<RawSdwisWaterSystem>(url, ctx);
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
  ): Promise<WaterSystem[]> {
    const violUrl = this.buildTableUrl(
      'sdwis',
      'violation',
      [{ column: 'primacy_agency_code', operator: 'equals', value: state }, OPEN_VIOLATION_FILTER],
      { first: 1, last: VIOLATION_SCAN_ROWS },
    );
    ctx.log.debug('DMAP SDWIS violation query', { state });
    const violRows = await this.fetchTable<RawSdwisViolation>(violUrl, ctx);
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
      const rows = await this.fetchTable<RawSdwisWaterSystem>(url, ctx);
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
  ): Promise<WaterSystem[]> {
    const url = this.buildTableUrl('sdwis', 'water_system', filters, {
      first: 1,
      last: ZIP_SYSTEM_SCAN_ROWS,
    });
    ctx.log.debug('DMAP water systems query', { zipCode });
    const zipRows = await this.fetchTable<RawSdwisWaterSystem>(url, ctx);

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
      const violRows = await this.fetchTable<RawSdwisViolation>(violUrl, ctx);
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
