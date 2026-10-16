/**
 * @fileoverview ECHO API response types and normalized domain types for facility compliance data.
 * @module services/echo/types
 */

/**
 * Raw ECHO facility row from echo_rest_services.get_facility_info / get_qid. Which columns a
 * row carries depends on the request's `qcolumns`; ECHO reports a missing value as null.
 */
export interface RawEchoFacility {
  /** "Y" when the facility has an ICIS-Air record. */
  AIRFlag?: string | null;
  FacCity?: string | null;
  FacComplianceStatus?: string | null;
  FacCounty?: string | null;
  /** County FIPS ECHO derives from the coordinates; its default row carries this, not FacFIPSCode. */
  FacDerivedStctyFIPS?: string | null;
  FacFIPSCode?: string | null;
  /** Inspections over the last five years, across programs. */
  FacInspectionCount?: string | null;
  FacLat?: string | null;
  FacLong?: string | null;
  FacName?: string | null;
  /** Quarters with noncompliance in the last three years, across programs. */
  FacQtrsWithNC?: string | null;
  FacState?: string | null;
  FacStreet?: string | null;
  /** Penalties from formal actions over the last five years, dollar-formatted ("$5,000"). */
  FacTotalPenalties?: string | null;
  FacZip?: string | null;
  /** "Y" when the facility has an ICIS-NPDES record. */
  NPDESFlag?: string | null;
  /** "Y" when the facility has an RCRAInfo record. */
  RCRAFlag?: string | null;
  RegistryID?: string | null;
  /** "Y" when the facility has an SDWIS record. */
  SDWISFlag?: string | null;
  /** Space-separated TRI facility IDs ("77506CLNSC1423H 7750WVNKCR1431P"); null when the facility has none. */
  TRIIDs?: string | null;
  /** TRI releases and transfers in pounds for ECHO's latest TRI year. */
  TRIReleasesTransfers?: string | null;
  [key: string]: string | null | undefined;
}

/** One parameter ECHO reports having applied, from a search response's `QueryParameters`. */
export interface RawEchoQueryParameter {
  QP: string;
  QV?: string | null;
}

/** Raw ECHO get_facility_info / get_qid top-level response envelope. */
export interface RawEchoFacilityResponse {
  Results?: {
    Facilities?: RawEchoFacility[];
    QueryID?: string;
    /** Parameters ECHO applied; one it does not recognize is left out. */
    QueryParameters?: RawEchoQueryParameter[];
    QueryRows?: string;
    PageNo?: string;
    TotalPagesAvailable?: string;
    TotalCount?: string;
  };
}

/** One statute's row of get_dfr `EnforcementComplianceSummaries.Summaries[]`. Counts are strings. */
export interface RawEchoDfrComplianceSummary {
  CurrentStatus?: string | null;
  FormalActions?: string | null;
  InformalActions?: string | null;
  Inspections?: string | null;
  LastInspection?: string | null;
  QtrsInNC?: string | null;
  QtrsInSNC?: string | null;
  Statute?: string;
  /** Dollar-formatted, e.g. "$1,750". */
  TotalPenalties?: string | null;
}

/** One statute's reporting windows from get_dfr `EnforcementComplianceSummaries.ProgramDates[]`. */
export interface RawEchoDfrProgramDates {
  EndDate?: string;
  Program?: string;
  StartDate3Yr?: string;
  StartDate5Yr?: string;
}

/** One compliance monitoring record from get_dfr `ComplianceHistory.Inspection[]`. */
export interface RawEchoDfrInspection {
  /** "Inspection/Evaluation", "Compliance Investigation", "Information Request", …; empty for RCRA and SDWA. */
  ActivityType?: string | null;
  /** MM/DD/YYYY. */
  Date?: string | null;
  EPASystem?: string;
  Finding?: string | null;
  InspectionType?: string | null;
  LeadAgency?: string | null;
  SourceID?: string;
  Statute?: string;
}

/** One formal enforcement action from get_dfr `FormalActions.Action[]`. */
export interface RawEchoDfrFormalAction {
  /** MM/DD/YYYY. */
  ActionDate?: string | null;
  ActionType?: string | null;
  LeadAgency?: string | null;
  /** Dollar-formatted, e.g. "$1,000"; null when none was assessed. */
  PenaltyAmount?: string | null;
  SourceID?: string;
  Statute?: string;
}

/** One enforcement case from get_dfr `CaseFormalActions.Action[]`. */
export interface RawEchoDfrCaseAction {
  /** Null for RCRAInfo actions. */
  CaseID?: string | null;
  /** MM/DD/YYYY; "01/01/0001" when ECHO has none. */
  IssueDate?: string | null;
  Settlements?: {
    Settlement?: Array<{
      /** Dollar-formatted, e.g. "$1,000". */
      FederalPenalty?: string | null;
      SettlementDate?: string | null;
      /** Dollar-formatted, e.g. "$25,000". */
      StateLocalPenalty?: string | null;
    }>;
  };
  /** Prefixed with the program, e.g. "AIR/WAPSC0005303321147". */
  SourceID?: string;
  StatuteCode?: string;
}

/** One annual TRI total from get_dfr `TRIHistory.Sources[].ReleaseYear[]`. */
export interface RawEchoDfrTriYear {
  SourceID?: string;
  /** Comma-formatted pounds, e.g. "75,223". */
  TotalReleasesTransfers?: string | null;
  Year?: string;
}

/** A single permit/program record from dfr_rest_services.get_dfr Results.Permits[]. */
export interface RawEchoDfrPermit {
  EPARegion?: string;
  EPASystem?: string;
  FacilityCity?: string;
  /** "King County"; null on the FRS entry, set on program entries. */
  FacilityCountyName?: string | null;
  FacilityFipsCode?: string | null;
  FacilityName?: string;
  FacilityState?: string;
  FacilityStatus?: string | null;
  FacilityStreet?: string;
  FacilityZip?: string;
  Latitude?: string;
  Longitude?: string;
  SourceID?: string;
  Statute?: string;
  [key: string]: string | null | undefined;
}

/** Top-level response from dfr_rest_services.get_dfr. */
export interface RawEchoDfrFullResponse {
  Results?: {
    /** FRS Registry ID for the facility. */
    RegistryID?: string;
    /** Program permit/source records — FRS record (EPASystem="FRS") contains facility name and address. */
    Permits?: RawEchoDfrPermit[];
    SpatialMetadata?: {
      RegistryID?: string;
      Latitude83?: string;
      Longitude83?: string;
    };
    /** Per-statute status, inspections, and enforcement over ECHO's 3- and 5-year windows. */
    EnforcementComplianceSummaries?: {
      ProgramDates?: RawEchoDfrProgramDates[];
      Summaries?: RawEchoDfrComplianceSummary[];
    };
    ComplianceHistory?: { Inspection?: RawEchoDfrInspection[] };
    FormalActions?: { Action?: RawEchoDfrFormalAction[] };
    CaseFormalActions?: { Action?: RawEchoDfrCaseAction[] };
    TRIHistory?: { Sources?: Array<{ ReleaseYear?: RawEchoDfrTriYear[] }> };
    Message?: string;
  };
}

/**
 * Raw ECHO enforcement case from case_rest_services.get_qid.
 * Field names differ from the old get_case_info assumption — these are the real get_qid fields.
 */
export interface RawEchoCase {
  ActivityID?: string;
  CaseCategoryCode?: string;
  /** Category description, e.g. "Judicial", "Administrative". Maps to caseType. */
  CaseCategoryDesc?: string;
  CaseName?: string;
  /** Primary human-readable identifier, e.g. "03-2014-7010". Maps to caseId in the domain type. */
  CaseNumber?: string;
  CaseStatusCode?: string;
  CaseStatusDesc?: string;
  CivilCriminalIndicator?: string;
  CostRecovery?: string;
  /** Filing date field in get_qid response. Maps to filedDate. */
  DateFiled?: string;
  /** Dollar-formatted penalty string, e.g. "$75,000.00" or "$0.00". Maps to penaltyAssessedInDollars. */
  FedPenalty?: string;
  /** Primary regulatory law, e.g. "CERCLA", "CAA". Maps to programsViolated. */
  PrimaryLaw?: string;
  SettlementDate?: string;
  StateLocPenaltyAmt?: string;
  TotalCompActionAmt?: string;
  [key: string]: string | number | undefined;
}

/** Raw ECHO case_rest_services.get_case_info response (step 1 — discovery only). */
export interface RawEchoCaseInfoResponse {
  Results?: {
    /** Opaque query ID to pass to get_qid for the actual case records. */
    QueryID?: string;
    /**
     * Parameters ECHO applied, plus defaults it was not sent (p_name_type, mapset); one it does
     * not recognize is left out.
     */
    QueryParameters?: RawEchoQueryParameter[];
    /** Total rows matched across all pages. */
    QueryRows?: string;
    Message?: string;
  };
}

/** Raw ECHO case_rest_services.get_qid response (step 2 — actual case records). */
export interface RawEchoCaseResponse {
  Results?: {
    Cases?: RawEchoCase[];
    QueryID?: string;
    QueryRows?: string;
    PageNo?: string;
    TotalCount?: string;
  };
}

/** Normalized EPA facility record for tool responses. */
export interface EpaFacility {
  city?: string;
  complianceStatus?: string;
  county?: string;
  fipsCode?: string;
  inspectionCount?: number;
  latitude?: number;
  longitude?: number;
  name: string;
  programs: {
    air: boolean;
    water: boolean;
    rcra: boolean;
    tri: boolean;
    sdwa: boolean;
  };
  registryId: string;
  state?: string;
  street?: string;
  totalPenaltiesInDollars?: number;
  triReleasesTransfersInLbs?: number;
  zip?: string;
}

/** Normalized enforcement case. */
export interface EpaCase {
  caseId?: string;
  caseName?: string;
  caseType?: string;
  facilityName?: string;
  filedDate?: string;
  penaltyAssessedInDollars?: number;
  programsViolated?: string;
  registryId?: string;
  settlementDate?: string;
  state?: string;
}

/** One statute's ECHO enforcement and compliance summary. */
export interface EpaProgramCompliance {
  currentStatus?: string;
  fiveYearPeriodStart?: string;
  formalActions?: number;
  informalActions?: number;
  inspections?: number;
  lastInspectionDate?: string;
  periodEnd?: string;
  quartersInNoncompliance?: number;
  quartersInSignificantNoncompliance?: number;
  statute: string;
  threeYearPeriodStart?: string;
  totalPenaltiesInDollars?: number;
}

/**
 * Full facility compliance profile, built from one dfr_rest_services.get_dfr response plus a
 * best-effort echo_rest_services.get_facility_info?p_frs row for the facility-level status.
 */
export interface EpaFacilityProfile {
  airCompliance?: {
    programId?: string;
    status?: string;
    statusDate?: string;
  };
  city?: string;
  compliance?: {
    mediaStatusCode?: string;
    mediaStatusDescription?: string;
    quartersInViolation?: number;
  };
  complianceStatus?: string;
  county?: string;
  fipsCode?: string;
  formalActions: Array<{
    actionDate?: string;
    actionType?: string;
    caseId?: string;
    leadAgency?: string;
    penaltyAssessedInDollars?: number;
    settlementDate?: string;
    sourceId?: string;
    statute?: string;
  }>;
  inspections: Array<{
    activityDate?: string;
    activityType?: string;
    category?: string;
    description?: string;
    leadAgency?: string;
    sourceId?: string;
    statute?: string;
  }>;
  /** Records in the 5-year history; `inspections` holds the newest of them. */
  inspectionsTotal: number;
  latitude?: number;
  longitude?: number;
  name: string;
  programCompliance: EpaProgramCompliance[];
  programs: {
    air: boolean;
    water: boolean;
    rcra: boolean;
    tri: boolean;
    sdwa: boolean;
  };
  registryId: string;
  state?: string;
  street?: string;
  /** TRI facility IDs, most recently reported first. */
  triFacilityIds: string[];
  triReleasesTransfersInLbs?: number;
  triReleasesTransfersYear?: number;
  waterCompliance?: {
    programId?: string;
    status?: string;
    permitId?: string;
  };
  zip?: string;
}
