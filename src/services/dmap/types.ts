/**
 * @fileoverview DMAP (Envirofacts) API response types and normalized domain types.
 * @module services/dmap/types
 */

/** Raw row from tri.tri_facility table. Coordinates encoded as DDMMSS integers. */
export interface RawTriFacility {
  city_name?: string;
  /** County name as the state reported it — usually bare and uppercase ("KING"), sometimes suffixed ("CALCASIEU PARISH") */
  county_name?: string;
  /** 12-digit EPA Facility Registry Service ID — the registry_id epa_echo_get_facility takes */
  epa_registry_id?: string | null;
  fac_latitude?: string | number;
  fac_longitude?: string | number;
  facility_name?: string;
  /** Parent company as TRI standardizes it; "NA" when the facility reported none */
  standardized_parent_company?: string | null;
  state_abbr?: string;
  street_address?: string;
  tri_facility_id?: string;
  zip_code?: string;
  [key: string]: string | number | null | undefined;
}

/** Raw row from tri.tri_reporting_form table. */
export interface RawTriReportingForm {
  /** Chemical name — actual field name in tri.tri_reporting_form */
  cas_chem_name?: string;
  /** Submission control number — join key to tri.tri_release_qty for the per-medium breakdown */
  doc_ctrl_num?: string;
  /**
   * Form R Section 8.8 one-time release quantity: releases from remedial actions, catastrophic
   * events, or one-time events not associated with production. Section 8.8 reports it separately,
   * but it is already counted in the Section 5 per-medium releases (tri.tri_release_qty) and the
   * off-site transfers.
   */
  one_time_release_qty?: string | number;
  reporting_year?: string | number;
  /**
   * TRI chemical or category ID. N150 (dioxin and dioxin-like compounds) is reported in grams;
   * every other chemical in pounds. The reporting-form and release-quantity tables carry no unit
   * column, so this is the marker on their rows (tri.tri_chem_info.unit_of_measure records Grams
   * for N150).
   */
  tri_chem_id?: string;
  tri_facility_id?: string;
  [key: string]: string | number | undefined;
}

/**
 * Raw row from tri.tri_release_qty table — one row per (doc_ctrl_num, environmental_medium).
 * Carries the per-medium on-site release quantities that tri_reporting_form lacks.
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
  archived_ind?: string | null;
  city_name?: string;
  county_name?: string;
  epa_id?: string | null;
  federal_facility_ind?: string | null;
  /** Actual FIPS field name — county_fips_code does not exist */
  fips_code?: string;
  fk_ref_state_code?: string;
  /** Actual site name field — site_name is null in SEMS */
  name?: string;
  non_npl_status_name?: string | null;
  npl_status_code?: string;
  npl_status_name?: string | null;
  primary_latitude_decimal_val?: string | number;
  primary_longitude_decimal_val?: string | number;
  site_id?: string;
  /** Actual street address field — street_address_1 does not exist */
  street_addr_txt?: string;
  zip_code?: string;
  [key: string]: string | number | null | undefined;
}

/**
 * Raw row from sdwis.water_system table. A county search's rows also carry the joined
 * sdwis.geographic_area columns; DMAP prefixes the ones both tables have
 * (`sdwis.geographic_area.pwsid`), so the water_system columns keep their names.
 */
export interface RawSdwisWaterSystem {
  /** Actual city field — city_served does not exist */
  city_name?: string;
  /** sdwis.geographic_area: the counties served, comma-joined ("Dallas,Johnson") */
  county_served?: string;
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

/**
 * Normalized TRI chemical release record.
 * `oneTimeReleaseInLbs` is the Form R Section 8.8 one-time quantity
 * (tri_reporting_form.one_time_release_qty), already counted in the per-medium releases and the
 * off-site transfers. The `releasesTo*InLbs` fields are the on-site releases rolled up from
 * tri.tri_release_qty by doc_ctrl_num, each omitted when the submission reported no hard quantity
 * for that medium, and `totalOnSiteReleasesInLbs` sums the ones present; searchTriReleases fills
 * them only when its caller opts into the breakdown. Every quantity is in pounds: a chemical TRI
 * has facilities report in grams is converted, and `reportedUnit` says so.
 */
export interface TriRelease {
  chemicalName: string;
  facilityId: string;
  /** Form R Section 8.8 one-time release quantity (one_time_release_qty) in lbs */
  oneTimeReleaseInLbs?: number;
  /** On-site air releases (AIR FUG + AIR STACK) in lbs, summed per submission */
  releasesToAirInLbs?: number;
  /** On-site land releases (landfills, land treatment, surface impoundment, other disposal) in lbs */
  releasesToLandInLbs?: number;
  /** On-site releases via underground injection wells in lbs, summed per submission */
  releasesToUndergroundInjectionInLbs?: number;
  /** On-site releases to surface water in lbs, summed across outfalls per submission */
  releasesToWaterInLbs?: number;
  /** 'grams' when TRI had the facility report this chemical in grams (dioxin and dioxin-like compounds); the *InLbs quantities are converted. Absent for pound-reported chemicals. */
  reportedUnit?: 'grams';
  reportingYear: number;
  /** Sum of the per-medium fields present, in lbs; absent when none is */
  totalOnSiteReleasesInLbs?: number;
}

/** A TRI release from a regional search, with the facility columns its tri.tri_facility join carries. */
export interface TriSearchRelease extends TriRelease {
  countyName?: string;
  facilityName: string;
  /** Parent company as TRI standardizes it; absent when TRI holds its "NA" placeholder */
  parentCompany?: string;
  /** 12-digit EPA Facility Registry Service ID */
  registryId?: string;
}

/** Normalized Superfund site record. */
export interface SuperfundSite {
  archivedInd?: string;
  city?: string;
  county?: string;
  epaId?: string;
  federalFacilityInd?: string;
  fipsCode?: string;
  latitude?: number;
  longitude?: number;
  name: string;
  nonNplStatusName?: string;
  nplStatus?: string;
  nplStatusName?: string;
  siteId: string;
  state?: string;
  street?: string;
  zip?: string;
}

/** One SEMS contaminant association; repeated chemicals retain their action/media context. */
export interface SuperfundContaminant {
  action?: string;
  medium?: string;
  name?: string;
  operableUnit?: string;
  typeCode?: string;
}

/** Exact site lookup and every associated contaminant row. */
export interface SuperfundSiteDetail {
  contaminants: SuperfundContaminant[];
  site: SuperfundSite;
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
