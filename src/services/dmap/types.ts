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
  /** Chemical name — actual field name in tri.tri_reporting_form */
  cas_chem_name?: string;
  /** One-time release quantity (the only release qty field in this table) */
  one_time_release_qty?: string | number;
  reporting_year?: string | number;
  tri_facility_id?: string;
  [key: string]: string | number | undefined;
}

/** Raw row from sems.envirofacts_site table. */
export interface RawSemsSite {
  city_name?: string;
  cleanup_status?: string;
  county_name?: string;
  /** Actual FIPS field name — county_fips_code does not exist */
  fips_code?: string;
  fk_ref_state_code?: string;
  /** Actual site name field — site_name is null in SEMS */
  name?: string;
  npl_status_code?: string;
  primary_latitude_decimal_val?: string | number;
  primary_longitude_decimal_val?: string | number;
  site_id?: string;
  /** Actual street address field — street_address_1 does not exist */
  street_addr_txt?: string;
  zip_code?: string;
  [key: string]: string | number | undefined;
}

/** Raw row from sdwis.water_system table. */
export interface RawSdwisWaterSystem {
  /** Actual city field — city_served does not exist */
  city_name?: string;
  population_served_count?: string | number;
  primacy_agency_code?: string;
  primary_source_code?: string;
  /** Actual activity field — active_flag does not exist; 'A' = active */
  pws_activity_code?: string;
  pws_name?: string;
  pws_type_code?: string;
  pwsid?: string;
  zip_code?: string;
  [key: string]: string | number | undefined;
}

/** Raw row from sdwis.violation table (used for has_violation filtering). */
export interface RawSdwisViolation {
  primacy_agency_code?: string;
  pwsid?: string;
  [key: string]: string | number | undefined;
}

/**
 * Normalized TRI chemical release record.
 * Note: tri_reporting_form only provides one_time_release_qty (mapped to totalReleasesInLbs).
 * Air/water/land breakdown fields are not available in DMAP's tri_reporting_form table.
 */
export interface TriRelease {
  chemicalName: string;
  facilityId: string;
  reportingYear: number;
  /** Mapped from one_time_release_qty — the only release quantity in tri_reporting_form */
  totalReleasesInLbs?: number;
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
