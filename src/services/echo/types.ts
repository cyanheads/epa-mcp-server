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

/** What an ECHO search reads from any discovery (`get_*_info`) or get_qid body. */
export interface RawEchoSearchResults {
  QueryID?: string;
  /** Parameters ECHO applied; discovery bodies only. */
  QueryParameters?: RawEchoQueryParameter[];
  /** Rows matched across every get_qid page. */
  QueryRows?: string;
  TotalCount?: string;
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

/**
 * Raw sdw_rest_services.get_systems response: counts and the QueryID get_qid pages. Unlike the
 * facility and case searches, it echoes no QueryParameters and ignores a parameter it does not know.
 */
export interface RawSdwSystemsResponse {
  Results?: {
    /** Systems with a current violation among the matches. */
    CVRows?: string;
    Message?: string;
    QueryID?: string;
    /** Systems matched, across every get_qid page. */
    QueryRows?: string;
  };
}

/** One sdw_rest_services.get_qid row read with qcolumns 2 and 57; ECHO adds PWSName to every row. */
export interface RawSdwSystemRow {
  /** "1" when the system has a current violation, "0" when not. */
  CurrVioFlag?: string | null;
  PWSId?: string | null;
  PWSName?: string | null;
}

/** Raw sdw_rest_services.get_qid page; past the last page WaterSystems is empty. */
export interface RawSdwSystemsPage {
  Results?: {
    PageNo?: string;
    QueryID?: string;
    QueryRows?: string;
    WaterSystems?: RawSdwSystemRow[];
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

/** One enforcement action ECHO links to a drinking-water violation. */
export interface RawEchoDfrSdwEnforcementAction {
  /** "State", "EPA", … */
  Agency?: string | null;
  EnforcementActionTypeDesc?: string | null;
  /** MM/DD/YYYY. */
  EnforcementDate?: string | null;
  EnforcementId?: string | null;
  /** "Formal", "Informal", or "Resolving". */
  EnforcementType?: string | null;
}

/**
 * One SDWIS violation from get_dfr `ViolationsEnforcementActions.Sources[].Violations[]`. Dates
 * are MM/DD/YYYY; measures and MCLs carry their units ("148.37 UG/L", "0.080 mg/L").
 */
export interface RawEchoDfrSdwViolation {
  CompliancePeriodBeginDate?: string | null;
  /** Null while the compliance period is open. */
  CompliancePeriodEndDate?: string | null;
  ContaminantName?: string | null;
  /** Empty when ECHO links no action to the violation. */
  EnforcementActions?: RawEchoDfrSdwEnforcementAction[];
  FederalMCL?: string | null;
  FederalRule?: string | null;
  ResolvedDate?: string | null;
  /** The PWSID. */
  SourceID?: string | null;
  StateMCL?: string | null;
  /** "Resolved", "Archived", "Addressed", or "Unaddressed". */
  Status?: string | null;
  /** "MCL", "MR", "MON", "TT", … */
  ViolationCategoryCode?: string | null;
  ViolationCategoryDesc?: string | null;
  ViolationID?: string | null;
  ViolationMeasure?: string | null;
}

/** One NAICS code a program source records, from get_dfr `NAICS.Sources[].NAICSCodes[]`. */
export interface RawEchoDfrNaicsCode {
  EPASystem?: string;
  /** 2–6 digits; the same code can repeat across sources. */
  NAICSCode?: string | null;
  NAICSDesc?: string | null;
  SourceID?: string;
}

/** A single permit/program record from dfr_rest_services.get_dfr Results.Permits[]. */
export interface RawEchoDfrPermit {
  EPARegion?: string;
  EPASystem?: string;
  /** Permit expiration date, MM/DD/YYYY; null for most non-permit IDs. */
  ExpDate?: string | null;
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
  /** Classification within the system, e.g. "Major Emissions", "LQG"; "" on the FRS entry. */
  Universe?: string | null;
  [key: string]: string | null | undefined;
}

/** Quarter bounds (MM/DD/YYYY) of a get_dfr compliance section: Qtr1Start, Qtr1End, … */
export type RawEchoDfrQuarterBounds = {
  [bound: `Qtr${number}Start` | `Qtr${number}End`]: string | null | undefined;
};

/**
 * One effluent exceedance series from get_dfr `CWAEffluentComplianceEXP.Sources[].Parameters[]`.
 * Qtr1–Qtr13 cells hold the quarter's value ("1061%" or "LIMIT VIOLATION") and an "S" or "R"
 * status; Mnth1–Mnth39 repeat them by month and are not read.
 */
export interface RawEchoDfrEffluentParameter {
  DischargePoint?: string | null;
  /** "Mthly", "NMth", or "Neither". */
  MeasurementType?: string | null;
  MonitoringLocation?: string | null;
  ParameterCode?: string | null;
  ParameterName?: string | null;
  /** The NPDES permit. */
  SourceID?: string | null;
  [cell: `Qtr${number}Status` | `Qtr${number}Value`]: string | null | undefined;
}

/**
 * One RCRA violation from get_dfr `RCRACompliance.Sources[].Violations[]`. Qtr1–Qtr12 cells hold
 * the determined date, "--->" while open, and the return-to-compliance date, or one
 * "determined-returned" range when both fall in one quarter.
 */
export interface RawEchoDfrRcraViolation {
  /** A state code or "EPA". */
  Agency?: string | null;
  RCRAViolReportURL?: string | null;
  /** The RCRA handler ID. */
  SourceID?: string | null;
  Violation?: string | null;
  ViolationType?: string | null;
  [cell: `Qtr${number}Status`]: string | null | undefined;
}

/**
 * One Clean Air Act High Priority Violation from get_dfr
 * `AirCompliance.Sources[].HPVProgramsPollutants[]`. Qtr1–Qtr12 cells hold the begin date (in Qtr1
 * when it precedes the window), "--->" while unresolved, and the resolved date.
 */
export interface RawEchoDfrHpv {
  Agency?: string | null;
  /** Comma-separated pollutant codes. */
  AirPollutants?: string | null;
  /** Comma-separated air program codes, e.g. "CAATVP". */
  AirPrograms?: string | null;
  /** The ICIS-Air ID. */
  SourceID?: string | null;
  ViolationActivityID?: string | null;
  [cell: `Qtr${number}Status`]: string | null | undefined;
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
    /** NAICS codes per program source; one source can list several. */
    NAICS?: { Sources?: Array<{ NAICSCodes?: RawEchoDfrNaicsCode[] }> };
    FormalActions?: { Action?: RawEchoDfrFormalAction[] };
    CaseFormalActions?: { Action?: RawEchoDfrCaseAction[] };
    TRIHistory?: { Sources?: Array<{ ReleaseYear?: RawEchoDfrTriYear[] }> };
    /** Drinking-water violations over ECHO's five-year window; `{}` for a facility with no SDWIS record. */
    ViolationsEnforcementActions?: { Sources?: Array<{ Violations?: RawEchoDfrSdwViolation[] }> };
    /** CWA effluent exceedances over 13 quarters; `{}` for a facility with none. */
    CWAEffluentComplianceEXP?: {
      Header?: RawEchoDfrQuarterBounds;
      Sources?: Array<{ Parameters?: RawEchoDfrEffluentParameter[] }>;
    };
    /** RCRA violations over 12 quarters, the quarter bounds at the section's top level; `{}` for none. */
    RCRACompliance?: { Sources?: Array<{ Violations?: RawEchoDfrRcraViolation[] }> };
    /** CAA compliance over 12 quarters; `{}` for a facility with no ICIS-Air record. */
    AirCompliance?: { Sources?: Array<{ HPVProgramsPollutants?: RawEchoDfrHpv[] }> };
    Message?: string;
  };
}

/**
 * Raw ECHO enforcement case row from case_rest_services.get_case_info (a small match comes back
 * inline) or get_qid. The default row, without `qcolumns`, carries every column read here; ECHO
 * reports a missing value as null, and a criminal row carries null status and money columns.
 */
export interface RawEchoCase {
  ActivityID?: string | null;
  CaseCategoryCode?: string | null;
  /** "Judicial", "Administrative - Formal", or "Criminal" on every criminal row. Maps to caseType. */
  CaseCategoryDesc?: string | null;
  CaseName?: string | null;
  /** Primary identifier, e.g. "03-2014-7010"; criminal cases read "CR_<n>". Maps to caseId. */
  CaseNumber?: string | null;
  CaseStatusCode?: string | null;
  CaseStatusDesc?: string | null;
  /** "CI" or "CR"; CaseCategoryDesc already reads "Criminal" on every CR row. */
  CivilCriminalIndicator?: string | null;
  CostRecovery?: string | null;
  DateClosed?: string | null;
  /** Filing date (MM/DD/YYYY). Maps to filedDate. */
  DateFiled?: string | null;
  EnfOutcome?: string | null;
  /** Dollar-formatted penalty string, e.g. "$75,000.00" or "$0.00". Maps to penaltyAssessedInDollars. */
  FedPenalty?: string | null;
  /** "EPA" or "State". */
  Lead?: string | null;
  /** Primary regulatory law, e.g. "CERCLA", "CAA". Maps to programsViolated. */
  PrimaryLaw?: string | null;
  /** Section of the primary law, e.g. "107A"; a criminal row cites the U.S.C. ("33 U.S.C. 1908(a)"). */
  PrimarySection?: string | null;
  SEPCost?: string | null;
  SettlementDate?: string | null;
  StateLocPenaltyAmt?: string | null;
  TotalCompActionAmt?: string | null;
  [key: string]: string | null | undefined;
}

/**
 * Raw ECHO case search body: get_case_info discovery (QueryID, QueryRows, QueryParameters, and the
 * rows of a small match) or a get_qid page (Cases).
 */
export interface RawEchoCaseResponse {
  Results?: {
    Cases?: RawEchoCase[];
    Message?: string;
    PageNo?: string;
    QueryID?: string;
    /**
     * Parameters ECHO applied, plus defaults it was not sent (p_name_type, mapset); one it does
     * not recognize is left out. Discovery bodies only.
     */
    QueryParameters?: RawEchoQueryParameter[];
    QueryRows?: string;
    TotalCount?: string;
  };
}

/** `CaseInformation` of a case_rest_services.get_case_report body. Dollar totals are "$27,044,146". */
export interface RawEchoCaseInformation {
  ActivityId?: string | null;
  CaseName?: string | null;
  CaseNumber?: string | null;
  CaseStatus?: string | null;
  CaseStatusDate?: string | null;
  CaseSummary?: string | null;
  /** Case category code: "JDC" judicial, "AFR" administrative formal. */
  CaseType?: string | null;
  DOJDocketNumber?: string | null;
  EnforcementOutcome?: string | null;
  EnforcementType?: string | null;
  Lead?: string | null;
  PenaltyCollected?: string | null;
  /** The court's docket number; get_qid calls it CourtDocketNumber. */
  RegionalDocketNumber?: string | null;
  ReliefSought?: string | null;
  TotalComplianceActionCost?: string | null;
  TotalCostRecovery?: string | null;
  TotalFederalPenalty?: string | null;
  TotalSEPCost?: string | null;
  TotalStatePenalty?: string | null;
  Violations?: string | null;
}

/** One `Facilities` row of a case report: one facility × one program link, so FRSNumber repeats. */
export interface RawEchoCaseFacility {
  FacilityAddress?: string | null;
  FacilityCity?: string | null;
  FacilityName?: string | null;
  /** "Y" when FRS marks the facility closed. */
  FacilityNoLongerExists?: string | null;
  FacilityState?: string | null;
  FacilityZip?: string | null;
  /** The facility's Registry ID. */
  FRSNumber?: string | null;
  /** Comma-separated ("211111, 211112"); usually set on one of a facility's rows only. */
  NAICSCodes?: string | null;
  /** The program system of this row's link, e.g. "ICIS", "SEMS", "NPDES", "AIR". */
  ProgramAcronym?: string | null;
  ProgramId?: string | null;
  SICCodes?: string | null;
}

/** One complying action of an enforcement conclusion. */
export interface RawEchoComplyingAction {
  ComplyingActionCategory?: string | null;
  ComplyingActionDescription?: string | null;
  ComplyingActionType?: string | null;
}

/** One pollutant reduction of an enforcement conclusion. */
export interface RawEchoPollutantReduction {
  /** Annual amount, comma-grouped ("21,168"). */
  AnnualAmount?: string | null;
  Media?: string | null;
  Pollutant?: string | null;
  /** "C" for a complying action's reduction, "S" for a SEP's. */
  SEPorComp?: string | null;
  Units?: string | null;
}

/** One Supplemental Environmental Project of an enforcement conclusion. */
export interface RawEchoSupplementalProject {
  Category?: string | null;
  Description?: string | null;
  SEPAmount?: string | null;
  SEPText?: string | null;
}

/**
 * One `EnforcementConclusions` entry. Its EnfConFacilities repeats the case's Facilities and its
 * ComplianceSchedules can run to dozens of rows (67 in WA-100446); neither is read.
 */
export interface RawEchoEnforcementConclusion {
  ActualTerminationDate?: string | null;
  ComplianceActionCost?: string | null;
  ComplyingActions?: RawEchoComplyingAction[] | null;
  CostRecovery?: string | null;
  EnforcementActionClosedDate?: string | null;
  EnforcementConclusionId?: string | null;
  EnforcementConclusionName?: string | null;
  EnforcementConclusionNmbr?: string | null;
  EnforcementConclusionType?: string | null;
  /** Comma-separated Registry IDs ("110009259729, 110009281767"). */
  FacilitiesInSettlement?: string | null;
  FederalPenalty?: string | null;
  PollutantReductions?: RawEchoPollutantReduction[] | null;
  SEPCost?: string | null;
  SettlementEnteredDate?: string | null;
  SettlementLodgedDate?: string | null;
  StatePenalty?: string | null;
  SupplementalEnvironmentalProjects?: RawEchoSupplementalProject[] | null;
}

/**
 * Raw case_rest_services.get_case_report body, cut to the sections EchoService reads. An unknown
 * or criminal case number answers HTTP 200 with a top-level `Error` and no `Results`.
 */
export interface RawEchoCaseReportResponse {
  Results?: {
    CaseInformation?: RawEchoCaseInformation | null;
    CaseMilestones?: Array<{ ActualDate?: string | null; Event?: string | null }> | null;
    Defendants?: Array<{
      DefendantName?: string | null;
      NamedInComplaint?: string | null;
      NamedInSettlement?: string | null;
    }> | null;
    EnforcementConclusions?: RawEchoEnforcementConclusion[] | null;
    Facilities?: RawEchoCaseFacility[] | null;
    LawsAndSections?: Array<{
      Law?: string | null;
      Programs?: string | null;
      Sections?: string | null;
    }> | null;
    Pollutants?: Array<{
      ChemicalAbstractNumber?: string | null;
      PollutantName?: string | null;
    }> | null;
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
  /** TRI facility IDs in ECHO's order; empty when the facility has none. */
  triFacilityIds: string[];
  triReleasesTransfersInLbs?: number;
  zip?: string;
}

/** One NAICS code a facility profile carries, deduplicated across the program sources recording it. */
export interface EpaNaicsCode {
  code: string;
  description?: string;
}

/** Normalized enforcement case row; columns ECHO leaves null are absent. */
export interface EpaCase {
  caseId?: string;
  caseName?: string;
  caseStatus?: string;
  caseType?: string;
  closedDate?: string;
  complianceActionCostInDollars?: number;
  costRecoveryInDollars?: number;
  enforcementOutcome?: string;
  filedDate?: string;
  leadAgency?: string;
  penaltyAssessedInDollars?: number;
  primarySection?: string;
  programsViolated?: string;
  settlementDate?: string;
  stateLocalPenaltyInDollars?: number;
  supplementalProjectCostInDollars?: number;
}

/** One facility a case names, merged across its program-link rows. */
export interface EpaCaseFacility {
  city?: string;
  /** NAICS codes across the facility's rows, each once, in ECHO's order. */
  naicsCodes: string[];
  name?: string;
  /** True when FRS marks the facility as no longer existing. */
  noLongerExists?: boolean;
  /** Program-system IDs the case links to this facility, in ECHO's order. */
  programIds: Array<{ id: string; system?: string }>;
  registryId?: string;
  sicCodes: string[];
  state?: string;
  street?: string;
  zip?: string;
}

/** One order, consent decree, or other settlement that concluded part of a civil case. */
export interface EpaEnforcementConclusion {
  closedDate?: string;
  complianceActionCostInDollars?: number;
  complyingActions: Array<{ category?: string; description?: string; type?: string }>;
  conclusionId?: string;
  conclusionNumber?: string;
  costRecoveryInDollars?: number;
  enteredDate?: string;
  lodgedDate?: string;
  name?: string;
  penaltyAssessedInDollars?: number;
  pollutantReductions: Array<{
    annualAmount?: number;
    media?: string;
    pollutant?: string;
    source?: 'complying action' | 'supplemental project';
    units?: string;
  }>;
  /** Registry IDs of the facilities this settlement covers. */
  registryIds: string[];
  stateLocalPenaltyInDollars?: number;
  supplementalProjectCostInDollars?: number;
  supplementalProjects: Array<{
    category?: string;
    costInDollars?: number;
    description?: string;
    text?: string;
  }>;
  terminationDate?: string;
  type?: string;
}

/** A civil enforcement case report from case_rest_services.get_case_report. */
export interface EpaCaseReport {
  caseCategoryCode?: string;
  caseId: string;
  caseName?: string;
  caseStatus?: string;
  caseStatusDate?: string;
  complianceActionCostInDollars?: number;
  costRecoveryInDollars?: number;
  courtDocketNumber?: string;
  defendants: Array<{ name?: string; namedInComplaint?: boolean; namedInSettlement?: boolean }>;
  dojDocketNumber?: string;
  enforcementConclusions: EpaEnforcementConclusion[];
  enforcementOutcome?: string;
  enforcementType?: string;
  facilities: EpaCaseFacility[];
  lawsAndSections: Array<{ law?: string; programs?: string; sections?: string }>;
  leadAgency?: string;
  milestones: Array<{ date?: string; event?: string }>;
  penaltyAssessedInDollars?: number;
  penaltyCollectedInDollars?: number;
  pollutants: Array<{ casNumber?: string; name?: string }>;
  reliefSought?: string;
  stateLocalPenaltyInDollars?: number;
  summary?: string;
  supplementalProjectCostInDollars?: number;
  violations?: string;
}

/** One drinking-water violation in a facility profile; fields ECHO leaves empty are absent. */
export interface EpaDrinkingWaterViolation {
  compliancePeriodBeginDate?: string;
  compliancePeriodEndDate?: string;
  contaminantName?: string;
  /** Absent when ECHO links no action to the violation. */
  enforcementActions?: Array<{
    agency?: string;
    date?: string;
    description?: string;
    type?: string;
  }>;
  federalMcl?: string;
  federalRule?: string;
  resolvedDate?: string;
  sourceId?: string;
  stateMcl?: string;
  status?: string;
  violationCategory?: string;
  violationCategoryCode?: string;
  violationId?: string;
  violationMeasure?: string;
}

/** One quarter of an effluent exceedance series. */
export interface EpaEffluentQuarter {
  /** MM/DD/YYYY; absent when the section carries no quarter bounds. */
  end?: string;
  start?: string;
  /** ECHO's "S" or "R", relayed without an asserted meaning. */
  status?: string;
  /** Percent over the limit as ECHO writes it ("1061%"), or "LIMIT VIOLATION". */
  value: string;
}

/** One CWA effluent exceedance series: a permit, outfall, monitoring location, parameter, and measurement type. */
export interface EpaEffluentExceedance {
  measurementType?: string;
  monitoringLocation?: string;
  outfall?: string;
  parameterCode?: string;
  parameterName?: string;
  permitId?: string;
  /** Quarters with an exceedance, oldest first. */
  quarters: EpaEffluentQuarter[];
}

/** One RCRA violation in a facility profile; fields ECHO leaves empty are absent. */
export interface EpaRcraViolation {
  agency?: string;
  /** Can precede ECHO's 12-quarter window. */
  determinedDate?: string;
  handlerId?: string;
  reportUrl?: string;
  /** Absent while the violation is open. */
  returnedToComplianceDate?: string;
  violation?: string;
  violationType?: string;
}

/** One program ID FRS links to a facility, other than its Registry ID. */
export interface EpaProgramId {
  expirationDate?: string;
  id: string;
  status?: string;
  statute?: string;
  system: string;
  universe?: string;
}

/** One Clean Air Act High Priority Violation in a facility profile. */
export interface EpaHighPriorityViolation {
  agency?: string;
  airProgramId?: string;
  /** Can precede ECHO's 12-quarter window. */
  beginDate?: string;
  pollutants?: string;
  programs?: string;
  /** Absent while unresolved. */
  resolvedDate?: string;
  violationId?: string;
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
    quartersInViolation?: number;
  };
  complianceStatus?: string;
  county?: string;
  /** One page of the report's drinking-water violations, newest compliance period first. */
  drinkingWaterViolations: EpaDrinkingWaterViolation[];
  /** Offset of the next page, present exactly when more violations follow. */
  drinkingWaterViolationsNextOffset?: number;
  /** Drinking-water violations in the report, across all pages. */
  drinkingWaterViolationsTotal: number;
  /** One page of the report's effluent exceedance series, in permit, outfall, parameter order. */
  effluentExceedances: EpaEffluentExceedance[];
  /** Offset of the next page, present exactly when more series follow. */
  effluentExceedancesNextOffset?: number;
  /** Effluent exceedance series in the report, across all pages. */
  effluentExceedancesTotal: number;
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
  /** The report's Clean Air Act High Priority Violations, in ECHO's order. */
  highPriorityViolations: EpaHighPriorityViolation[];
  /** One page of the report's compliance monitoring records, newest first. */
  inspections: Array<{
    activityDate?: string;
    activityType?: string;
    category?: string;
    description?: string;
    leadAgency?: string;
    sourceId?: string;
    statute?: string;
  }>;
  /** Offset of the next page, present exactly when more inspections follow. */
  inspectionsNextOffset?: number;
  /** Records in the 5-year history, across all pages. */
  inspectionsTotal: number;
  latitude?: number;
  longitude?: number;
  /** NAICS codes the facility's program sources record, ascending by code. */
  naics: EpaNaicsCode[];
  name: string;
  programCompliance: EpaProgramCompliance[];
  /** Every program ID in Permits[] but the FRS entry, in ECHO's order. */
  programIds: EpaProgramId[];
  programs: {
    air: boolean;
    water: boolean;
    rcra: boolean;
    tri: boolean;
    sdwa: boolean;
  };
  /** One page of the report's RCRA violations, newest determination first. */
  rcraViolations: EpaRcraViolation[];
  /** Offset of the next page, present exactly when more violations follow. */
  rcraViolationsNextOffset?: number;
  /** RCRA violations in the report, across all pages. */
  rcraViolationsTotal: number;
  registryId: string;
  state?: string;
  street?: string;
  /** TRI facility IDs, most recently reported first. */
  triFacilityIds: string[];
  triReleasesTransfersInLbs?: number;
  triReleasesTransfersYear?: number;
  waterCompliance?: {
    status?: string;
    permitId?: string;
  };
  zip?: string;
}
