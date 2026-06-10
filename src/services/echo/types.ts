/**
 * @fileoverview ECHO API response types and normalized domain types for facility compliance data.
 * @module services/echo/types
 */

/** Raw ECHO get_facility_info response facility record. Fields may be absent or empty string. */
export interface RawEchoFacility {
  AIRFlag?: string;
  AIRPenalties?: string;
  CWAFlag?: string;
  CWAPenalties?: string;
  FacCity?: string;
  FacComplianceStatus?: string;
  FacCounty?: string;
  FacFIPSCode?: string;
  FacLat?: string;
  FacLon?: string;
  FacName?: string;
  FacState?: string;
  FacStreet?: string;
  FacZip?: string;
  InspectionCount?: string;
  RCRFlag?: string;
  RCRPenalties?: string;
  RegistryID?: string;
  SDWAFlag?: string;
  TRIFlag?: string;
  TRIReleasesTransfers?: string;
  [key: string]: string | undefined;
}

/** Raw ECHO get_facility_info top-level response envelope. */
export interface RawEchoFacilityResponse {
  Results?: {
    Facilities?: RawEchoFacility[];
    QueryID?: string;
    PageNo?: string;
    TotalPagesAvailable?: string;
    TotalCount?: string;
  };
}

/** Raw ECHO DFR compliance summary response envelope. */
export interface RawEchoDfrComplianceSummary {
  Results?: {
    ComplianceSummary?: {
      MediaStatusCode?: string;
      MediaStatusDesc?: string;
      QtrsInViol?: string | number;
      QtrsInNC?: string | number;
    };
  };
}

/** Raw inspection/enforcement record from ECHO DFR. */
export interface RawEchoInspection {
  ActivityDate?: string;
  ActivityType?: string;
  ActivityTypeDescription?: string;
}

/** Raw formal action/penalty record from ECHO DFR. */
export interface RawEchoFormalAction {
  CaseID?: string;
  FormalActionType?: string;
  PenaltyAssessed?: string | number;
  SettlementDate?: string;
}

/** Raw ECHO DFR inspection and enforcement response. */
export interface RawEchoDfrInspectionEnforcement {
  Results?: {
    Inspections?: RawEchoInspection[];
    FormalActions?: RawEchoFormalAction[];
  };
}

/** Raw ECHO DFR air compliance record. */
export interface RawEchoDfrAir {
  Results?: {
    AirComplianceSummary?: {
      ProgramID?: string;
      Status?: string;
      StatusDate?: string;
    };
  };
}

/** Raw ECHO DFR water compliance record. */
export interface RawEchoDfrWater {
  Results?: {
    WaterCompliance?: {
      ProgramID?: string;
      Status?: string;
      PermitID?: string;
    };
  };
}

/** A single permit/program record from dfr_rest_services.get_dfr Results.Permits[]. */
export interface RawEchoDfrPermit {
  EPARegion?: string;
  EPASystem?: string;
  FacilityCity?: string;
  FacilityCountyName?: string;
  FacilityFipsCode?: string;
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
    /** Compliance summary (same as dfr_rest_services.get_compliance_summary.Results.ComplianceSummary). */
    ComplianceSummary?: {
      Source?: Array<{
        Statute?: string;
        SourceID?: string;
        CurrentSNC?: string;
        QtrsInNC?: string;
      }>;
    };
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

/** Full facility compliance profile aggregated from multiple DFR endpoints. */
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
    caseId?: string;
    settlementDate?: string;
    penaltyAssessedInDollars?: number;
    actionType?: string;
  }>;
  inspections: Array<{
    activityType?: string;
    activityDate?: string;
    description?: string;
  }>;
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
  triReleasesTransfersInLbs?: number;
  waterCompliance?: {
    programId?: string;
    status?: string;
    permitId?: string;
  };
  zip?: string;
}
