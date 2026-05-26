/**
 * @fileoverview DMAP (Envirofacts) API response types and normalized domain types.
 * @module services/dmap/types
 */

/** Raw row from tri.tri_facility table. Coordinates encoded as DDMMSS integers. */
export interface RawTriFacility {
  city?: string;
  county?: string;
  fac_latitude?: string | number;
  fac_longitude?: string | number;
  facility_name?: string;
  state_abbr?: string;
  street?: string;
  tri_facility_id?: string;
  zip_code?: string;
  [key: string]: string | number | undefined;
}

/** Raw row from tri.tri_reporting_form table. */
export interface RawTriReportingForm {
  air_releases?: string | number;
  chemical_name_text?: string;
  land_releases?: string | number;
  off_site_release_total?: string | number;
  on_site_release_total?: string | number;
  reporting_year?: string | number;
  total_releases?: string | number;
  tri_facility_id?: string;
  underground_injection?: string | number;
  water_releases?: string | number;
  [key: string]: string | number | undefined;
}

/** Raw row from sems.envirofacts_site table. */
export interface RawSemsSite {
  city_name?: string;
  cleanup_status?: string;
  county_fips_code?: string;
  county_name?: string;
  fk_ref_state_code?: string;
  npl_status_code?: string;
  primary_latitude_decimal_val?: string | number;
  primary_longitude_decimal_val?: string | number;
  site_id?: string;
  site_name?: string;
  street_address_1?: string;
  zip_code?: string;
  [key: string]: string | number | undefined;
}

/** Raw row from sdwis.water_system table. */
export interface RawSdwisWaterSystem {
  active_flag?: string;
  city_served?: string;
  population_served_count?: string | number;
  primacy_agency_code?: string;
  primary_source_code?: string;
  pws_name?: string;
  pws_type_code?: string;
  pwsid?: string;
  violation_flag?: string;
  zip_code?: string;
  [key: string]: string | number | undefined;
}

/** Normalized TRI chemical release record. */
export interface TriRelease {
  airReleasesInLbs?: number;
  chemicalName: string;
  facilityId: string;
  landReleasesInLbs?: number;
  offSiteReleaseTotalInLbs?: number;
  onSiteReleaseTotalInLbs?: number;
  reportingYear: number;
  totalReleasesInLbs?: number;
  undergroundInjectionInLbs?: number;
  waterReleasesInLbs?: number;
}

/** Normalized Superfund site record. */
export interface SuperfundSite {
  city?: string;
  cleanupStatus?: string;
  county?: string;
  fipsCode?: string;
  latitude?: number;
  longitude?: number;
  name: string;
  nplStatus?: string;
  siteId: string;
  state?: string;
  street?: string;
  zip?: string;
}

/** Normalized drinking water system record. */
export interface WaterSystem {
  city?: string;
  hasViolation?: boolean;
  isActive?: boolean;
  name: string;
  populationServed?: number;
  primarySourceCode?: string;
  pwsid: string;
  state?: string;
  type?: string;
  zip?: string;
}
