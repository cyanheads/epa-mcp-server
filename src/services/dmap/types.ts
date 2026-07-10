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
  /** Submission control number — join key to tri.tri_release_qty for the per-medium breakdown */
  doc_ctrl_num?: string;
  /**
   * One-time / non-routine release quantity (spills, accidents) — a distinct TRI category,
   * not a rollup of the per-medium routine releases carried in tri.tri_release_qty.
   */
  one_time_release_qty?: string | number;
  reporting_year?: string | number;
  tri_facility_id?: string;
  [key: string]: string | number | undefined;
}

/**
 * Raw row from tri.tri_release_qty table — one row per (doc_ctrl_num, environmental_medium).
 * Carries the routine per-medium release quantities that tri_reporting_form lacks.
 */
export interface RawTriReleaseQty {
  /** Join key back to tri_reporting_form.doc_ctrl_num */
  doc_ctrl_num?: string;
  /** Release-type code (e.g. "AIR FUG", "AIR STACK", "WATER", "RCRA C", "UNINJ I") */
  environmental_medium?: string;
  /** "1" means this medium does not apply to the submission (total_release legitimately absent) */
  release_na?: string;
  /** Coarse range band reported instead of total_release for small releases; null otherwise */
  release_range_code?: string | null;
  /** Exact release quantity in lbs when reported as a hard number; null when range-coded or N/A */
  total_release?: string | number | null;
  [key: string]: string | number | null | undefined;
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
 * `totalReleasesInLbs` is TRI's one-time / non-routine release quantity (from
 * tri_reporting_form.one_time_release_qty) — a distinct category, NOT the sum of the
 * per-medium routine releases. The `releasesTo*InLbs` fields are the routine on-site
 * releases rolled up from tri.tri_release_qty, populated only by getTriReleases.
 */
export interface TriRelease {
  chemicalName: string;
  facilityId: string;
  /** On-site routine air releases (AIR FUG + AIR STACK) in lbs, summed per submission */
  releasesToAirInLbs?: number;
  /** On-site routine land releases (landfills, land treatment, surface impoundment, other disposal) in lbs */
  releasesToLandInLbs?: number;
  /** On-site routine releases via underground injection wells in lbs, summed per submission */
  releasesToUndergroundInjectionInLbs?: number;
  /** On-site routine releases to surface water in lbs, summed across outfalls per submission */
  releasesToWaterInLbs?: number;
  reportingYear: number;
  /** One-time / non-routine release quantity (from one_time_release_qty) — a distinct TRI category */
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
