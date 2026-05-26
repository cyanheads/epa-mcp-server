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
  RawSdwisWaterSystem,
  RawSemsSite,
  RawTriFacility,
  RawTriReportingForm,
  SuperfundSite,
  TriRelease,
  WaterSystem,
} from './types.js';

/** Parse a numeric field, returning undefined if absent/NaN. */
function parseNum(val: string | number | undefined): number | undefined {
  if (val === undefined || val === null || val === '') return;
  const n = Number(val);
  return Number.isNaN(n) ? undefined : n;
}

/** Normalize a raw TRI reporting form row. */
function normalizeTriRelease(raw: RawTriReportingForm): TriRelease {
  const result: TriRelease = {
    facilityId: raw.tri_facility_id ?? '',
    chemicalName: raw.chemical_name_text ?? '',
    reportingYear: Number(raw.reporting_year ?? 0),
  };
  const total = parseNum(raw.total_releases);
  const air = parseNum(raw.air_releases);
  const water = parseNum(raw.water_releases);
  const land = parseNum(raw.land_releases);
  const ug = parseNum(raw.underground_injection);
  const onSite = parseNum(raw.on_site_release_total);
  const offSite = parseNum(raw.off_site_release_total);
  if (total !== undefined) result.totalReleasesInLbs = total;
  if (air !== undefined) result.airReleasesInLbs = air;
  if (water !== undefined) result.waterReleasesInLbs = water;
  if (land !== undefined) result.landReleasesInLbs = land;
  if (ug !== undefined) result.undergroundInjectionInLbs = ug;
  if (onSite !== undefined) result.onSiteReleaseTotalInLbs = onSite;
  if (offSite !== undefined) result.offSiteReleaseTotalInLbs = offSite;
  return result;
}

/** Normalize a raw SEMS envirofacts_site record. */
function normalizeSemsSite(raw: RawSemsSite): SuperfundSite {
  const lat = parseNum(raw.primary_latitude_decimal_val);
  const lng = parseNum(raw.primary_longitude_decimal_val);
  return {
    siteId: raw.site_id ?? '',
    name: raw.site_name ?? '',
    ...(raw.street_address_1 && { street: raw.street_address_1 as string }),
    ...(raw.city_name && { city: raw.city_name as string }),
    ...(raw.fk_ref_state_code && { state: raw.fk_ref_state_code as string }),
    ...(raw.zip_code && { zip: raw.zip_code as string }),
    ...(raw.county_name && { county: raw.county_name as string }),
    ...(raw.county_fips_code && { fipsCode: raw.county_fips_code as string }),
    ...(raw.npl_status_code && { nplStatus: raw.npl_status_code as string }),
    ...(raw.cleanup_status && { cleanupStatus: raw.cleanup_status as string }),
    ...(lat !== undefined && { latitude: lat }),
    ...(lng !== undefined && { longitude: lng }),
  };
}

/** Normalize a raw SDWIS water system record. */
function normalizeSdwisWaterSystem(raw: RawSdwisWaterSystem): WaterSystem {
  const pop = parseNum(raw.population_served_count);
  return {
    pwsid: raw.pwsid ?? '',
    name: raw.pws_name ?? '',
    ...(raw.primacy_agency_code && { state: raw.primacy_agency_code as string }),
    ...(raw.city_served && { city: raw.city_served as string }),
    ...(raw.zip_code && { zip: raw.zip_code as string }),
    ...(raw.pws_type_code && { type: raw.pws_type_code as string }),
    ...(raw.primary_source_code && { primarySourceCode: raw.primary_source_code as string }),
    ...(pop !== undefined && { populationServed: pop }),
    ...(raw.violation_flag !== undefined && { hasViolation: raw.violation_flag === 'Y' }),
    ...(raw.active_flag !== undefined && { isActive: raw.active_flag === 'Y' }),
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
   */
  private buildTableUrl(
    schema: string,
    table: string,
    filters: Array<{ column: string; operator: string; value: string }>,
    pagination: { first: number; last: number },
  ): string {
    const filterPath = filters
      .map((f) => `${encodeURIComponent(f.column)}/${f.operator}/${encodeURIComponent(f.value)}`)
      .join('/and/');
    const pagePath = `${pagination.first}:${pagination.last}`;
    return `${this.baseUrl}/${schema}.${table}/${filterPath}/${pagePath}`;
  }

  /** Fetch a DMAP table result as JSON array. */
  // biome-ignore lint/suspicious/useAwait: delegates to withRetry() which returns a Promise — async typing is correct
  private async fetchTable<T>(url: string, ctx: Context): Promise<T[]> {
    return withRetry(
      async () => {
        const jsonUrl = url.endsWith('/json') ? url : `${url}/json`;
        const response = await fetch(jsonUrl, { signal: ctx.signal });
        if (!response.ok) {
          throw await httpErrorFromResponse(response, { service: 'DMAP', data: { url: jsonUrl } });
        }
        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable(
            'DMAP API returned HTML instead of JSON — likely rate-limited or unavailable.',
            { url: jsonUrl },
          );
        }
        const parsed = JSON.parse(text) as unknown;
        if (Array.isArray(parsed)) return parsed as T[];
        const keys = Object.keys(parsed as object);
        return ((parsed as Record<string, unknown[]>)[keys[0]!] ?? []) as T[];
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
    const filters: Array<{ column: string; operator: string; value: string }> = [
      { column: 'tri_facility_id', operator: 'equals', value: params.facilityId },
    ];
    if (params.year !== undefined) {
      filters.push({ column: 'reporting_year', operator: 'equals', value: String(params.year) });
    }
    if (params.chemicalName) {
      filters.push({
        column: 'chemical_name_text',
        operator: 'contains',
        value: params.chemicalName,
      });
    }

    const url = this.buildTableUrl('tri', 'tri_reporting_form', filters, { first: 0, last: 499 });
    ctx.log.debug('DMAP TRI releases query', { facilityId: params.facilityId, year: params.year });

    const rows = await this.fetchTable<RawTriReportingForm>(url, ctx);
    return rows.map(normalizeTriRelease);
  }

  /** Search TRI releases by state, optionally filtered by county, year, or chemical. */
  async searchTriReleases(
    params: {
      state: string;
      county?: string;
      year?: number;
      chemicalName?: string;
      limit?: number;
    },
    ctx: Context,
  ): Promise<(TriRelease & { facilityName?: string })[]> {
    const limit = params.limit ?? 50;

    const facilityFilters: Array<{ column: string; operator: string; value: string }> = [
      { column: 'state_abbr', operator: 'equals', value: params.state },
    ];
    if (params.county) {
      facilityFilters.push({ column: 'county', operator: 'contains', value: params.county });
    }

    const facilityUrl = this.buildTableUrl('tri', 'tri_facility', facilityFilters, {
      first: 0,
      last: limit - 1,
    });
    ctx.log.debug('DMAP TRI facility query', { state: params.state });

    const facilities = await this.fetchTable<RawTriFacility>(facilityUrl, ctx);
    if (facilities.length === 0) return [];

    const facilityIds = facilities
      .map((f) => f.tri_facility_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    const releaseFilters: Array<{ column: string; operator: string; value: string }> = [
      { column: 'tri_facility_id', operator: 'in', value: facilityIds.join(',') },
    ];
    if (params.year !== undefined) {
      releaseFilters.push({
        column: 'reporting_year',
        operator: 'equals',
        value: String(params.year),
      });
    }
    if (params.chemicalName) {
      releaseFilters.push({
        column: 'chemical_name_text',
        operator: 'contains',
        value: params.chemicalName,
      });
    }

    const releaseUrl = this.buildTableUrl('tri', 'tri_reporting_form', releaseFilters, {
      first: 0,
      last: 499,
    });
    const releaseRows = await this.fetchTable<RawTriReportingForm>(releaseUrl, ctx);

    const facilityMap = new Map(facilities.map((f) => [f.tri_facility_id, f]));

    return releaseRows.map((row) => {
      const release = normalizeTriRelease(row);
      const fac = facilityMap.get(row.tri_facility_id as string);
      return fac ? { ...release, facilityName: fac.facility_name ?? '' } : release;
    });
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
    const filters: Array<{ column: string; operator: string; value: string }> = [];

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
      first: 0,
      last: pageSize - 1,
    });
    ctx.log.debug('DMAP Superfund query', { state: params.state, lat: params.latitude });

    const rows = await this.fetchTable<RawSemsSite>(url, ctx);
    let sites = rows.map(normalizeSemsSite);

    if (params.latitude !== undefined && params.longitude !== undefined && params.radiusMiles) {
      sites = sites.filter((site) => {
        if (site.latitude === undefined || site.longitude === undefined) return false;
        const dist = haversineDistanceMiles(
          params.latitude!,
          params.longitude!,
          site.latitude,
          site.longitude,
        );
        return dist <= (params.radiusMiles ?? 0);
      });
    }

    return sites.slice(0, limit);
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
    const filters: Array<{ column: string; operator: string; value: string }> = [];

    if (params.state) {
      filters.push({ column: 'primacy_agency_code', operator: 'equals', value: params.state });
    }
    if (params.zipCode) {
      filters.push({ column: 'zip_code', operator: 'equals', value: params.zipCode });
    }
    if (params.hasViolation) {
      filters.push({ column: 'violation_flag', operator: 'equals', value: 'Y' });
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

    const url = this.buildTableUrl('sdwis', 'water_system', filters, { first: 0, last: limit - 1 });
    ctx.log.debug('DMAP water systems query', { state: params.state });

    const rows = await this.fetchTable<RawSdwisWaterSystem>(url, ctx);
    return rows.map(normalizeSdwisWaterSystem);
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
