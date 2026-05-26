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

/** Raw ECHO enforcement case from case_rest_services. */
export interface RawEchoCase {
  CaseID?: string;
  CaseName?: string;
  CaseType?: string;
  FacName?: string;
  FiledDate?: string;
  PenaltyAssessed?: string | number;
  ProgramsViolated?: string;
  RegistryID?: string;
  SettlementDate?: string;
  State?: string;
  [key: string]: string | number | undefined;
}

/** Raw ECHO case search response envelope. */
export interface RawEchoCaseResponse {
  Results?: {
    Cases?: RawEchoCase[];
    QueryID?: string;
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
