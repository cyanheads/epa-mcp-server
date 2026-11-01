/**
 * @fileoverview ECHO API service for EPA facility compliance and enforcement data.
 * Wraps echodata.epa.gov/echo REST endpoints for facility search, facility detail,
 * enforcement case search and report, and the current drinking-water violator lookup.
 * @module services/echo/echo-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serializationError,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { type CallBudget, callBudget } from '@/services/call-budget.js';
import { type ListSlice, type Page, slicePage } from '@/services/page.js';
import type {
  EpaCase,
  EpaCaseFacility,
  EpaCaseReport,
  EpaDrinkingWaterViolation,
  EpaEnforcementConclusion,
  EpaFacility,
  EpaFacilityProfile,
  EpaNaicsCode,
  EpaProgramCompliance,
  RawEchoCase,
  RawEchoCaseFacility,
  RawEchoCaseInformation,
  RawEchoCaseReportResponse,
  RawEchoCaseResponse,
  RawEchoDfrCaseAction,
  RawEchoDfrFormalAction,
  RawEchoDfrFullResponse,
  RawEchoDfrInspection,
  RawEchoDfrNaicsCode,
  RawEchoDfrSdwViolation,
  RawEchoDfrTriYear,
  RawEchoFacility,
  RawEchoFacilityResponse,
  RawEchoQueryParameter,
  RawEchoSearchResults,
  RawSdwSystemsPage,
  RawSdwSystemsResponse,
} from './types.js';

/**
 * Budget for one getFacility call — every get_dfr attempt plus the status lookup — kept under
 * the 60 s default request timeout of MCP SDK clients.
 */
const FACILITY_DEADLINE_MS = 50_000;

/** Ceiling for the best-effort p_frs status lookup within that budget. */
const STATUS_LOOKUP_DEADLINE_MS = 10_000;

/**
 * Budget for one getCase call's get_case_report attempts. The largest report measured, 117
 * settlements across 115 facilities (TX000A300485682003235), is 1.38 MB and took 8.0–9.9 s.
 */
const CASE_REPORT_DEADLINE_MS = 50_000;

/**
 * Budget for one searchFacilities or searchViolations call — the discovery request, its get_qid
 * page, and every retry and backoff of either — kept under the 60 s default request timeout of
 * MCP SDK clients. A legitimate `p_ct=Los Angeles` facility search takes 53.8–56.7 s, so the
 * budget keeps it and leaves 2 s for transport.
 */
const SEARCH_DEADLINE_MS = 58_000;

/**
 * The facility-search columns normalizeFacility maps, as echo_rest_services.metadata column IDs:
 * FacName, FacStreet, FacCity, FacState, FacZip, RegistryID, FacCounty, FacLat, FacLong, TRIIDs,
 * FacComplianceStatus, FacInspectionCount, FacTotalPenalties, TRIReleasesTransfers, FacFIPSCode,
 * FacDerivedStctyFIPS, AIRFlag, NPDESFlag, SDWISFlag, RCRAFlag. ECHO's default row omits the
 * coordinates, the per-program flags, and the inspection and penalty counts.
 */
const FACILITY_SEARCH_COLUMNS = '1,2,3,4,5,6,7,19,20,28,38,43,62,70,83,93,100,101,102,103';

/** Programs a facility search filters on. */
export type FacilityProgram = 'CAA' | 'CWA' | 'RCRA' | 'TRI' | 'SDWA';

/** ECHO `p_med` media code per program; `p_med` takes a single code. */
const PROGRAM_MEDIA_CODES = {
  CAA: 'A',
  CWA: 'W',
  RCRA: 'R',
  TRI: 'T',
  SDWA: 'S',
} as const satisfies Record<FacilityProgram, string>;

/** `p_cs` value selecting facilities with one or more programs in significant noncompliance. */
const SIGNIFICANT_NONCOMPLIANCE = '3';

/** Enforcement case types a case search filters on. */
export type CaseType = 'civil' | 'criminal' | 'all';

/** ECHO `p_civil_criminal_indicator` per case type; `all` sends none. */
const CASE_TYPE_CODES = { civil: 'CI', criminal: 'CR', all: undefined } as const satisfies Record<
  CaseType,
  string | undefined
>;

/**
 * Case milestones whose date is the filing date ECHO reports as DateFiled. ECHO records them for
 * civil cases only, so a date-bounded case search returns no criminal case.
 */
const FILING_MILESTONES = 'CMF,CPOA';

/** Open start for a filing-date range given only an end; ECHO requires both ends. */
const EARLIEST_FILING_DATE = '1900-01-01';

/**
 * sdw_rest_services `p_cs` value selecting systems with a current violation: every current
 * violation category (health-based, monitoring, other, public notice, serious violator) but N.
 */
const CURRENT_VIOLATION_CATEGORIES = 'H,M,O,P,S';

/** Rows per sdw get_qid page: get_systems `responseset` sets it (1,000 at most); get_qid ignores its own. */
const SDW_PAGE_ROWS = 1000;

/** PWSIDs per get_systems `p_pid` request; 200 nine-character IDs keep the GET URL near 2 KB. */
const SDW_PWSID_BATCH = 200;

/** get_qid columns of the current-violation lookup: 2 PWSID, 57 CURR_VIO_FLAG. */
const SDW_VIOLATOR_COLUMNS = '2,57';

/** Public water system types a current-violation lookup filters on. */
export type WaterSystemType = 'community' | 'non-transient' | 'transient';

/** ECHO `p_systyp` per system type. The SDW swagger's "NTCWS" matches no system; NTNCWS does. */
const SYSTEM_TYPE_CODES = {
  community: 'CWS',
  'non-transient': 'NTNCWS',
  transient: 'TNCWS',
} as const satisfies Record<WaterSystemType, string>;

/**
 * The systems a current-violation lookup covers: those located in a state (ECHO `p_st` is the
 * system's location, not its primacy agency, so a state's systems under EPA primacy are included),
 * or a list of PWSIDs.
 */
export type SdwViolatorScope =
  | { state: string; systemType?: WaterSystemType }
  | { pwsids: readonly string[] };

/** ECHO's MM/DD/YYYY form of a YYYY-MM-DD date. */
const toEchoDate = (iso: string): string =>
  `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;

/**
 * ECHO runs a search without any parameter it does not recognize and leaves that parameter out
 * of `Results.QueryParameters`. Fails when a sent `p_*` filter is missing there by name. Values
 * are not compared: ECHO also lists defaults it was not sent and echoes values it ignores.
 */
function assertFiltersApplied(
  endpoint: string,
  url: string,
  applied: RawEchoQueryParameter[] | undefined,
): void {
  const names = new Set((applied ?? []).map((parameter) => parameter.QP));
  const dropped = [...new URL(url).searchParams.keys()].filter(
    (key) => key.startsWith('p_') && !names.has(key),
  );
  if (dropped.length === 0) return;
  const filters = dropped.length === 1 ? 'that filter' : 'those filters';
  throw new McpError(
    JsonRpcErrorCode.InternalError,
    `ECHO ${endpoint} did not apply ${dropped.join(', ')}, so its results would ignore ${filters}. Retrying will not help; search without ${filters}.`,
    { droppedParameters: dropped, retryable: false },
  );
}

/**
 * One SEARCH_DEADLINE_MS budget for an ECHO search. Each request the search makes takes
 * `remainingMs()` as its deadline, so the discovery request and its get_qid page share the budget.
 */
const searchBudget = (search: string, narrow: string) =>
  callBudget('ECHO', search, SEARCH_DEADLINE_MS, narrow);

/** Disclosure for a profile built without the p_frs row. */
const STATUS_LOOKUP_NOTICE =
  "ECHO's facility search request failed, so this profile has no complianceStatus or compliance.quartersInViolation. Every other field comes from ECHO's detailed facility report; calling again may fill them.";

/**
 * Default page and cap of a profile's compliance monitoring records, a local slice of the one
 * get_dfr response. A Texas refinery logs several hundred state investigations in five years (581
 * at registry 110041990913, about 130 KB unbounded).
 */
export const INSPECTION_SLICE = { defaultLimit: 100, cap: 100 } as const;

/**
 * Default page and cap of a profile's drinking-water violations, a local slice of the one get_dfr
 * response. A small system can carry hundreds: WA5389080 (27 people) lists 899. Measured on its
 * profile, 50 entries make a 17.6 KB structuredContent and 9.2 KB of content[]; the 200 cap
 * keeps a page near 100 KB on both surfaces together (500 measured 264 KB).
 */
export const DRINKING_WATER_VIOLATION_SLICE = { defaultLimit: 50, cap: 200 } as const;

/** The slices of the lists a facility profile pages locally. */
export interface FacilitySlices {
  drinkingWaterViolations: ListSlice;
  inspections: ListSlice;
}

const DEFAULT_FACILITY_SLICES: FacilitySlices = {
  drinkingWaterViolations: { limit: DRINKING_WATER_VIOLATION_SLICE.defaultLimit, offset: 0 },
  inspections: { limit: INSPECTION_SLICE.defaultLimit, offset: 0 },
};

/**
 * One ECHO search for {@link EchoService.fetchSearchPage}: its discovery endpoint, what it sends,
 * and where its rows sit in a discovery or get_qid body.
 */
interface EchoSearch<Body extends { Results?: RawEchoSearchResults }, Row> {
  /** Discovery endpoint, e.g. `echo_rest_services.get_facility_info`; get_qid is its service's. */
  endpoint: `${string}.${string}`;
  /** Names the search in log lines and errors, e.g. "facility search". */
  label: string;
  /** Filters sent on discovery; undefined and empty values are dropped. */
  params: Record<string, string | number | boolean | undefined>;
  /** Sent on discovery and every get_qid page; omitted when unset. */
  qcolumns?: string;
  /** The rows of a discovery or get_qid body; discovery answers some small matches inline. */
  rows: (body: Body) => Row[] | undefined;
}

/** `T` with every key that may hold undefined made optional and defined-only. */
type Compacted<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/** Drops keys whose value is undefined, so optional output fields are absent rather than undefined. */
function compact<T extends object>(record: T): Compacted<T> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  ) as Compacted<T>;
}

/** ECHO reports missing values as null or ""; both read as absent. */
const echoText = (value: string | null | undefined): string | undefined => value || undefined;

/** Parses an ECHO count or dollar string ("12", "$1,750", "75,223"). */
function parseEchoNumber(value: string | null | undefined): number | undefined {
  if (!value) return;
  const parsed = Number(value.replace(/[$,]/g, ''));
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Sort key (YYYYMMDD) for an ECHO MM/DD/YYYY date. */
const dateKey = (date: string | null | undefined): string =>
  date ? `${date.slice(6)}${date.slice(0, 2)}${date.slice(3, 5)}` : '';

/**
 * Classifies ECHO's in-band failure: HTTP 200 with `Results.Error.ErrorMessage`, or a top-level
 * `Error.ErrorMessage` from get_case_report. Only an unrecognized message stays a retryable
 * ServiceUnavailable. The queryset-limit message ("Rows Returned would be <n>…") comes from
 * get_facilities, which this service never calls; get_facility_info and get_case_info have no row
 * ceiling.
 */
function echoBodyError(message: string): McpError {
  const detail = `ECHO API error: ${message}`;
  if (/^ID .+ is invalid\.$/s.test(message)) return notFound(detail);
  // get_case_report, for an unknown, blank, or criminal (CR_) case number.
  if (/^Case Number or Activity Id .* is invalid\.$/s.test(message)) return notFound(detail);
  if (/^QueryID .+ not found in ECHO\.$/s.test(message)) {
    return serviceUnavailable(detail, { retryable: false });
  }
  return serviceUnavailable(detail);
}

/**
 * Parses a fully read ECHO body. Malformed JSON is a SerializationError, an McpError withRetry
 * does not retry: the same body would come back. Retries stay for transport and HTTP failures.
 */
function parseEchoJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw serializationError('ECHO returned a response that is not JSON.', undefined, { cause });
  }
}

/** The NotFound `epa_echo_get_facility` and `epa://facility/{registry_id}` declare as `facility_not_found`. */
function facilityNotFound(registryId: string, cause?: unknown): McpError {
  return notFound(
    `No facility found for ID "${registryId}".`,
    { reason: 'facility_not_found', registryId },
    cause === undefined ? undefined : { cause },
  );
}

/** The NotFound `epa_echo_get_case` declares as `case_not_found`. */
function caseNotFound(caseId: string, cause?: unknown): McpError {
  return notFound(
    `ECHO has no civil case report for case ID "${caseId}".`,
    { reason: 'case_not_found', caseId },
    cause === undefined ? undefined : { cause },
  );
}

/** The values of a comma-separated ECHO list ("110009259729, 110009281767"), trimmed. */
const echoList = (value: string | null | undefined): string[] =>
  (value ?? '').split(',').flatMap((item) => item.trim() || []);

/** ECHO's "Y"/"N" flag; anything else is unknown. */
const echoFlag = (value: string | null | undefined): boolean | undefined =>
  value === 'Y' ? true : value === 'N' ? false : undefined;

/** One case search row. Every column the default row carries maps; a null one is absent. */
function normalizeCase(row: RawEchoCase): EpaCase {
  return compact({
    caseId: echoText(row.CaseNumber),
    caseName: echoText(row.CaseName),
    caseType: echoText(row.CaseCategoryDesc),
    caseStatus: echoText(row.CaseStatusDesc),
    enforcementOutcome: echoText(row.EnfOutcome),
    leadAgency: echoText(row.Lead),
    programsViolated: echoText(row.PrimaryLaw),
    primarySection: echoText(row.PrimarySection),
    penaltyAssessedInDollars: parseEchoNumber(row.FedPenalty),
    stateLocalPenaltyInDollars: parseEchoNumber(row.StateLocPenaltyAmt),
    costRecoveryInDollars: parseEchoNumber(row.CostRecovery),
    complianceActionCostInDollars: parseEchoNumber(row.TotalCompActionAmt),
    supplementalProjectCostInDollars: parseEchoNumber(row.SEPCost),
    filedDate: echoText(row.DateFiled),
    settlementDate: echoText(row.SettlementDate),
    closedDate: echoText(row.DateClosed),
  });
}

/**
 * A case report's Facilities rows, one entry per Registry ID in first-appearance order. A
 * facility's rows differ in their program link and in which carries the NAICS codes; the first
 * row's name and address win, and a row without an FRSNumber stands alone.
 */
function mergeCaseFacilities(rows: readonly RawEchoCaseFacility[]): EpaCaseFacility[] {
  const merged = new Map<string, EpaCaseFacility>();
  rows.forEach((row, index) => {
    const key = echoText(row.FRSNumber) ?? `row ${index}`;
    const facility =
      merged.get(key) ??
      compact({
        registryId: echoText(row.FRSNumber),
        name: echoText(row.FacilityName),
        street: echoText(row.FacilityAddress),
        city: echoText(row.FacilityCity),
        state: echoText(row.FacilityState),
        zip: echoText(row.FacilityZip),
        naicsCodes: [] as string[],
        sicCodes: [] as string[],
        programIds: [] as EpaCaseFacility['programIds'],
        noLongerExists: echoFlag(row.FacilityNoLongerExists),
      });
    merged.set(key, facility);
    for (const code of echoList(row.NAICSCodes)) {
      if (!facility.naicsCodes.includes(code)) facility.naicsCodes.push(code);
    }
    for (const code of echoList(row.SICCodes)) {
      if (!facility.sicCodes.includes(code)) facility.sicCodes.push(code);
    }
    const id = echoText(row.ProgramId);
    if (id) facility.programIds.push(compact({ system: echoText(row.ProgramAcronym), id }));
  });
  return [...merged.values()];
}

/** A case report from one get_case_report body whose CaseInformation names `caseNumber`. */
function normalizeCaseReport(
  caseNumber: string,
  info: RawEchoCaseInformation,
  results: NonNullable<RawEchoCaseReportResponse['Results']>,
): EpaCaseReport {
  const conclusions = (results.EnforcementConclusions ?? []).map(
    (entry): EpaEnforcementConclusion =>
      compact({
        conclusionId: echoText(entry.EnforcementConclusionId),
        conclusionNumber: echoText(entry.EnforcementConclusionNmbr),
        type: echoText(entry.EnforcementConclusionType),
        name: echoText(entry.EnforcementConclusionName),
        registryIds: echoList(entry.FacilitiesInSettlement),
        enteredDate: echoText(entry.SettlementEnteredDate),
        lodgedDate: echoText(entry.SettlementLodgedDate),
        penaltyAssessedInDollars: parseEchoNumber(entry.FederalPenalty),
        stateLocalPenaltyInDollars: parseEchoNumber(entry.StatePenalty),
        supplementalProjectCostInDollars: parseEchoNumber(entry.SEPCost),
        complianceActionCostInDollars: parseEchoNumber(entry.ComplianceActionCost),
        costRecoveryInDollars: parseEchoNumber(entry.CostRecovery),
        closedDate: echoText(entry.EnforcementActionClosedDate),
        terminationDate: echoText(entry.ActualTerminationDate),
        complyingActions: (entry.ComplyingActions ?? []).map((action) =>
          compact({
            type: echoText(action.ComplyingActionType),
            description: echoText(action.ComplyingActionDescription),
            category: echoText(action.ComplyingActionCategory),
          }),
        ),
        pollutantReductions: (entry.PollutantReductions ?? []).map((reduction) =>
          compact({
            pollutant: echoText(reduction.Pollutant),
            annualAmount: parseEchoNumber(reduction.AnnualAmount),
            units: echoText(reduction.Units),
            media: echoText(reduction.Media),
            source:
              reduction.SEPorComp === 'C'
                ? ('complying action' as const)
                : reduction.SEPorComp === 'S'
                  ? ('supplemental project' as const)
                  : undefined,
          }),
        ),
        supplementalProjects: (entry.SupplementalEnvironmentalProjects ?? []).map((project) =>
          compact({
            category: echoText(project.Category),
            description: echoText(project.Description),
            text: echoText(project.SEPText),
            costInDollars: parseEchoNumber(project.SEPAmount),
          }),
        ),
      }),
  );
  return compact({
    caseId: caseNumber,
    caseName: echoText(info.CaseName),
    caseCategoryCode: echoText(info.CaseType),
    enforcementType: echoText(info.EnforcementType),
    caseStatus: echoText(info.CaseStatus),
    caseStatusDate: echoText(info.CaseStatusDate),
    leadAgency: echoText(info.Lead),
    reliefSought: echoText(info.ReliefSought),
    enforcementOutcome: echoText(info.EnforcementOutcome),
    courtDocketNumber: echoText(info.RegionalDocketNumber),
    dojDocketNumber: echoText(info.DOJDocketNumber),
    violations: echoText(info.Violations),
    summary: echoText(info.CaseSummary),
    penaltyAssessedInDollars: parseEchoNumber(info.TotalFederalPenalty),
    stateLocalPenaltyInDollars: parseEchoNumber(info.TotalStatePenalty),
    penaltyCollectedInDollars: parseEchoNumber(info.PenaltyCollected),
    supplementalProjectCostInDollars: parseEchoNumber(info.TotalSEPCost),
    complianceActionCostInDollars: parseEchoNumber(info.TotalComplianceActionCost),
    costRecoveryInDollars: parseEchoNumber(info.TotalCostRecovery),
    lawsAndSections: (results.LawsAndSections ?? []).map((entry) =>
      compact({
        law: echoText(entry.Law),
        sections: echoText(entry.Sections),
        programs: echoText(entry.Programs),
      }),
    ),
    facilities: mergeCaseFacilities(results.Facilities ?? []),
    defendants: (results.Defendants ?? []).map((defendant) =>
      compact({
        name: echoText(defendant.DefendantName),
        namedInComplaint: echoFlag(defendant.NamedInComplaint),
        namedInSettlement: echoFlag(defendant.NamedInSettlement),
      }),
    ),
    pollutants: (results.Pollutants ?? []).map((pollutant) =>
      compact({
        name: echoText(pollutant.PollutantName),
        casNumber: echoText(pollutant.ChemicalAbstractNumber),
      }),
    ),
    milestones: (results.CaseMilestones ?? []).map((milestone) =>
      compact({ event: echoText(milestone.Event), date: echoText(milestone.ActualDate) }),
    ),
    enforcementConclusions: conclusions,
  });
}

/** Settlement dates recorded on an enforcement case. */
const settlementDates = (entry: RawEchoDfrCaseAction): string[] =>
  (entry.Settlements?.Settlement ?? []).flatMap((s) =>
    s.SettlementDate ? [s.SettlementDate] : [],
  );

/** A case's issue date; ECHO writes an unknown one as "01/01/0001". */
const issueDate = (entry: RawEchoDfrCaseAction): string | undefined =>
  entry.IssueDate && entry.IssueDate !== '01/01/0001' ? entry.IssueDate : undefined;

/** Federal plus state and local penalty across a case's settlements, in dollars. */
const settledPenalty = (entry: RawEchoDfrCaseAction): number =>
  (entry.Settlements?.Settlement ?? []).reduce(
    (sum, s) =>
      sum + (parseEchoNumber(s.FederalPenalty) ?? 0) + (parseEchoNumber(s.StateLocalPenalty) ?? 0),
    0,
  );

/**
 * Removes and returns the `CaseFormalActions` entry that records `action`: same statute, same
 * source (the case prefixes it, e.g. "AIR/"), and issued — or, lacking an issue date, settled —
 * on the action date. Among several such cases, the one whose settled penalty equals the
 * action's penalty wins.
 */
function takeCase(
  cases: RawEchoDfrCaseAction[],
  action: RawEchoDfrFormalAction,
): RawEchoDfrCaseAction | undefined {
  const matches = cases.flatMap((entry, index) => {
    const issued = issueDate(entry);
    const sameAction =
      entry.StatuteCode === action.Statute &&
      entry.SourceID?.split('/').pop() === action.SourceID &&
      (issued
        ? issued === action.ActionDate
        : settlementDates(entry).includes(action.ActionDate ?? ''));
    return sameAction ? [{ entry, index }] : [];
  });
  const penalty = parseEchoNumber(action.PenaltyAmount) ?? 0;
  const match = matches.find(({ entry }) => settledPenalty(entry) === penalty) ?? matches[0];
  return match && cases.splice(match.index, 1)[0];
}

/** The latest TRIHistory year and its releases + transfers, summed across rows for that year. */
function latestTriTotal(rows: RawEchoDfrTriYear[]): { year: number; lbs: number } | undefined {
  const year = Math.max(...rows.map((row) => Number(row.Year)).filter(Number.isFinite));
  const totals = rows
    .filter((row) => Number(row.Year) === year)
    .map((row) => parseEchoNumber(row.TotalReleasesTransfers))
    .filter((lbs): lbs is number => lbs !== undefined);
  return totals.length > 0 ? { year, lbs: totals.reduce((sum, lbs) => sum + lbs, 0) } : undefined;
}

/** The reporting year in a TRI permit's FacilityStatus ("Last Reported for 2024"); 0 when absent. */
const lastReportedYear = (status: string | null | undefined): number =>
  Number(/\b(\d{4})\b/.exec(status ?? '')?.[1] ?? 0);

/**
 * Newest compliance period first, then descending ViolationID, which is unique within a report,
 * so every page of a re-sliced list holds the same entries.
 */
function newestComplianceFirst(a: RawEchoDfrSdwViolation, b: RawEchoDfrSdwViolation): number {
  const byPeriod = dateKey(b.CompliancePeriodBeginDate).localeCompare(
    dateKey(a.CompliancePeriodBeginDate),
  );
  if (byPeriod !== 0) return byPeriod;
  const [idA, idB] = [a.ViolationID ?? '', b.ViolationID ?? ''];
  // Length first orders numeric IDs numerically; code-unit order breaks every remaining tie.
  return idB.length - idA.length || (idB < idA ? -1 : idB > idA ? 1 : 0);
}

/** Fields that order two compliance monitoring records sharing a date; records equal in all are interchangeable. */
const INSPECTION_TIEBREAK = [
  'Statute',
  'SourceID',
  'ActivityType',
  'InspectionType',
  'LeadAgency',
  'Finding',
] as const satisfies ReadonlyArray<keyof RawEchoDfrInspection>;

/**
 * Newest record first, then ascending by each INSPECTION_TIEBREAK field. Records carry no ID, so
 * the tiebreak orders same-day records by content, independent of ECHO's order, and every page of
 * a re-sliced list holds the same records.
 */
function newestInspectionFirst(a: RawEchoDfrInspection, b: RawEchoDfrInspection): number {
  const byDate = dateKey(b.Date).localeCompare(dateKey(a.Date));
  if (byDate !== 0) return byDate;
  for (const key of INSPECTION_TIEBREAK) {
    const [x, y] = [a[key] ?? '', b[key] ?? ''];
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * The report's NAICS codes, once each, ascending by code. Several program sources can record one
 * code; its first recorded description is kept.
 */
function naicsCodes(entries: RawEchoDfrNaicsCode[]): EpaNaicsCode[] {
  const byCode = new Map<string, EpaNaicsCode>();
  for (const entry of entries) {
    const code = echoText(entry.NAICSCode);
    if (!code) continue;
    const description = byCode.get(code)?.description ?? echoText(entry.NAICSDesc);
    byCode.set(code, compact({ code, description }));
  }
  return [...byCode.values()].sort((a, b) => (a.code < b.code ? -1 : 1));
}

/** A get_dfr drinking-water violation as the profile carries it. */
function normalizeSdwViolation(raw: RawEchoDfrSdwViolation): EpaDrinkingWaterViolation {
  const actions = (raw.EnforcementActions ?? []).map((action) =>
    compact({
      date: echoText(action.EnforcementDate),
      type: echoText(action.EnforcementType),
      description: echoText(action.EnforcementActionTypeDesc),
      agency: echoText(action.Agency),
    }),
  );
  return compact({
    sourceId: echoText(raw.SourceID),
    violationId: echoText(raw.ViolationID),
    compliancePeriodBeginDate: echoText(raw.CompliancePeriodBeginDate),
    compliancePeriodEndDate: echoText(raw.CompliancePeriodEndDate),
    federalRule: echoText(raw.FederalRule),
    contaminantName: echoText(raw.ContaminantName),
    violationCategoryCode: echoText(raw.ViolationCategoryCode),
    violationCategory: echoText(raw.ViolationCategoryDesc),
    violationMeasure: echoText(raw.ViolationMeasure),
    stateMcl: echoText(raw.StateMCL),
    federalMcl: echoText(raw.FederalMCL),
    status: echoText(raw.Status),
    resolvedDate: echoText(raw.ResolvedDate),
    enforcementActions: actions.length > 0 ? actions : undefined,
  });
}

/**
 * Normalizes an ECHO facility row, read by the column names FACILITY_SEARCH_COLUMNS requests, to
 * the domain type. Program flags match the `p_med` filters: a TRI facility is one with a TRI ID
 * (ECHO's TRIFlag marks current reporters only). getFacility passes the same columns, some unset.
 */
function normalizeFacility(
  raw: {
    [K in keyof RawEchoFacility]?: RawEchoFacility[K] | undefined;
  },
): EpaFacility {
  const triFacilityIds = (raw.TRIIDs ?? '').split(/\s+/).filter(Boolean);
  return {
    registryId: raw.RegistryID ?? '',
    name: raw.FacName ?? '',
    ...compact({
      street: echoText(raw.FacStreet),
      city: echoText(raw.FacCity),
      state: echoText(raw.FacState),
      zip: echoText(raw.FacZip),
      county: echoText(raw.FacCounty),
      fipsCode: echoText(raw.FacFIPSCode) ?? echoText(raw.FacDerivedStctyFIPS),
      latitude: parseEchoNumber(raw.FacLat),
      longitude: parseEchoNumber(raw.FacLong),
      complianceStatus: echoText(raw.FacComplianceStatus),
    }),
    programs: {
      air: raw.AIRFlag === 'Y',
      water: raw.NPDESFlag === 'Y',
      rcra: raw.RCRAFlag === 'Y',
      tri: triFacilityIds.length > 0,
      sdwa: raw.SDWISFlag === 'Y',
    },
    triFacilityIds,
    ...compact({
      triReleasesTransfersInLbs: parseEchoNumber(raw.TRIReleasesTransfers),
      inspectionCount: parseEchoNumber(raw.FacInspectionCount),
      totalPenaltiesInDollars: parseEchoNumber(raw.FacTotalPenalties),
    }),
  };
}

export class EchoService {
  private readonly baseUrl: string;
  private readonly userAgent: string;

  // storage retained for future caching/state use
  constructor(config: AppConfig, _storage: StorageService) {
    this.baseUrl = getServerConfig().echoBaseUrl;
    this.userAgent = `${config.pkg.name}/${config.pkg.version}`;
  }

  /** Build URL with query params. */
  private buildUrl(
    path: string,
    params: Record<string, string | number | boolean | undefined>,
  ): string {
    const url = new URL(`${this.baseUrl}/${path}`);
    for (const [key, val] of Object.entries(params)) {
      if (val !== undefined && val !== '') {
        url.searchParams.set(key, String(val));
      }
    }
    return url.toString();
  }

  /**
   * Fetch JSON from ECHO with retry. `retry.deadlineMs` bounds every attempt and backoff and is
   * required, so no ECHO request runs without a share of its tool call's budget; `maxRetries`
   * narrows the attempt count.
   */
  private fetchJson<T>(
    url: string,
    ctx: Context,
    retry: { maxRetries?: number; deadlineMs: number },
  ): Promise<T> {
    return withRetry(
      async ({ signal }) => {
        const response = await fetch(url, {
          signal,
          headers: { 'User-Agent': this.userAgent },
        });
        if (!response.ok) {
          throw await httpErrorFromResponse(response, { service: 'ECHO' });
        }
        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable(
            'ECHO API returned HTML instead of JSON — likely rate-limited or unavailable.',
          );
        }
        const parsed = parseEchoJson(text) as {
          Error?: { ErrorMessage?: string };
          Results?: { Error?: { ErrorMessage?: string } };
        };
        // get_case_report puts its in-band error at the top level, outside Results.
        const errorMsg = parsed.Results?.Error?.ErrorMessage ?? parsed.Error?.ErrorMessage;
        if (errorMsg) throw echoBodyError(errorMsg);
        return parsed as T;
      },
      {
        operation: 'EchoService.fetchJson',
        baseDelayMs: 1000,
        signal: ctx.signal,
        ...retry,
      },
    );
  }

  /**
   * Search EPA-regulated facilities with ECHO get_facility_info, paged by
   * {@link fetchSearchPage}. The caller supplies at least one geographic filter; `county` needs
   * `state`. Text filters go upstream as given: `facilityName` (p_fn) matches whole words of a
   * name ECHO records for the facility, `county` (p_co) a county-name prefix, `naics` (p_ncs) a
   * code prefix; `countyFips` (p_fips) is an exact 5-digit code.
   */
  async searchFacilities(
    params: {
      zipCode?: string;
      state?: string;
      city?: string;
      county?: string;
      countyFips?: string;
      facilityName?: string;
      naics?: string;
      latitude?: number;
      longitude?: number;
      radiusMiles?: number;
      activeOnly?: boolean;
      program?: FacilityProgram;
      hasViolation?: boolean;
      limit?: number;
      offset?: number;
    },
    ctx: Context,
  ): Promise<Page<EpaFacility> & { totalCount: number }> {
    const budget = searchBudget(
      'facility search',
      'Narrow it with zip_code or county_fips instead of city or state, a smaller radius_miles, or a programs filter, or call again later.',
    );
    const page = await this.fetchSearchPage<RawEchoFacilityResponse, RawEchoFacility>(
      {
        endpoint: 'echo_rest_services.get_facility_info',
        label: 'facility search',
        qcolumns: FACILITY_SEARCH_COLUMNS,
        // buildUrl drops undefined values; latitude/longitude of 0 are valid and sent.
        params: {
          p_zip: params.zipCode,
          p_st: params.state,
          p_ct: params.city,
          p_co: params.county,
          p_fips: params.countyFips,
          p_fn: params.facilityName,
          p_ncs: params.naics,
          p_lat: params.latitude,
          p_long: params.longitude,
          p_radius: params.radiusMiles,
          p_act: params.activeOnly ? 'Y' : undefined,
          p_cs: params.hasViolation ? SIGNIFICANT_NONCOMPLIANCE : undefined,
          p_med: params.program && PROGRAM_MEDIA_CODES[params.program],
        },
        rows: (body) => body.Results?.Facilities,
      },
      { limit: params.limit ?? 50, offset: params.offset ?? 0 },
      ctx,
      budget,
    );
    return { ...page, items: page.items.map(normalizeFacility) };
  }

  /**
   * One page of an ECHO search. Each call runs discovery afresh with `responseset` = `limit`, so
   * get_qid page `offset / limit + 1` holds `offset`; an unaligned offset also reads the page
   * after it. No QueryID is carried between calls: ECHO serves the same row order across
   * discovery runs and page sizes. Discovery's inline rows, when ECHO sends them, stand in for
   * get_qid page 1.
   *
   * `totalCount` is ECHO's QueryRows, the match before limit and offset. `nextOffset` is present
   * exactly when `offset + items.length` is below it. An offset at or past the end returns an
   * empty page without a get_qid request. Every request takes its deadline from `budget`.
   * @throws McpError `InternalError` when ECHO drops a sent filter (see assertFiltersApplied), and
   * `ServiceUnavailable` when it reports matches without a QueryID or serves an empty page short
   * of the match count.
   */
  private async fetchSearchPage<Body extends { Results?: RawEchoSearchResults }, Row>(
    search: EchoSearch<Body, Row>,
    { limit, offset }: ListSlice,
    ctx: Context,
    budget: CallBudget,
  ): Promise<Page<Row> & { totalCount: number }> {
    const url = this.buildUrl(search.endpoint, {
      output: 'JSON',
      responseset: limit,
      qcolumns: search.qcolumns,
      ...search.params,
    });
    ctx.log.debug(`ECHO ${search.label}`, { endpoint: search.endpoint });
    const data = await this.fetchJson<Body>(url, ctx, {
      deadlineMs: budget.remainingMs(),
    }).catch(budget.rethrow);
    assertFiltersApplied(search.endpoint, url, data.Results?.QueryParameters);

    const inline = search.rows(data) ?? [];
    const matched = Number.parseInt(data.Results?.QueryRows ?? data.Results?.TotalCount ?? '', 10);
    const totalCount = Number.isNaN(matched) ? inline.length : matched;
    if (offset >= totalCount) return { items: [], totalCount };

    const first = Math.floor(offset / limit) + 1;
    const pagenos =
      offset % limit === 0 || first * limit >= totalCount ? [first] : [first, first + 1];
    const queryId = data.Results?.QueryID;
    const qidEndpoint = `${search.endpoint.split('.')[0]}.get_qid`;
    const readPage = async (pageno: number): Promise<Row[]> => {
      if (pageno === 1 && inline.length > 0) return inline;
      if (!queryId) {
        throw serviceUnavailable(`ECHO ${search.label} returned matches without a query ID.`, {
          totalCount,
        });
      }
      ctx.log.debug(`ECHO ${search.label} page`, { endpoint: qidEndpoint, queryId, pageno });
      const page = await this.fetchJson<Body>(
        this.buildUrl(qidEndpoint, {
          output: 'JSON',
          qid: queryId,
          pageno,
          qcolumns: search.qcolumns,
        }),
        ctx,
        { deadlineMs: budget.remainingMs() },
      ).catch(budget.rethrow);
      return search.rows(page) ?? [];
    };
    // Both pages run at once; allSettled waits for each, so no request outlives the call.
    const settled = await Promise.allSettled(pagenos.map(readPage));
    const rows = settled.flatMap((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value.slice(0, limit);
    });

    const start = offset - (first - 1) * limit;
    const items = rows.slice(start, start + limit);
    if (items.length === 0) {
      throw serviceUnavailable(
        `ECHO's ${search.label} matched ${totalCount} rows but returned none from row ${offset + 1}. Calling again runs the search afresh.`,
        { totalCount, offset },
      );
    }
    const end = offset + items.length;
    return { items, totalCount, ...(end < totalCount && { nextOffset: end }) };
  }

  /**
   * Retrieve a full compliance profile for a single facility from one
   * dfr_rest_services.get_dfr response, plus a best-effort facility search row for the
   * facility-level compliance status that no DFR section carries.
   *
   * get_dfr takes a Registry ID or a program ID and answers with the Registry ID it resolves to: a
   * PWSID, a TRI facility ID, an NPDES permit, or a RCRA handler ID all work as `p_id`.
   * echo_rest_services.get_facility_info takes the resolved Registry ID only as `p_frs`.
   * A failed status lookup is disclosed as an enrichment notice. `slices` picks the page of each
   * locally paged list; a list it leaves out gets its first default-size page.
   */
  async getFacility(
    registryId: string,
    ctx: Context,
    slices: Partial<FacilitySlices> = {},
  ): Promise<EpaFacilityProfile> {
    const { profile, notice } = await this.getFacilityReport(registryId, ctx, slices);
    if (notice) ctx.enrich.notice(notice);
    return profile;
  }

  /** The getFacility profile, with the notice to show when the status lookup failed. */
  async getFacilityReport(
    registryId: string,
    ctx: Context,
    slices: Partial<FacilitySlices> = {},
  ): Promise<{ profile: EpaFacilityProfile; notice?: string }> {
    const lists = { ...DEFAULT_FACILITY_SLICES, ...slices };
    const startedAt = Date.now();
    const dfrUrl = this.buildUrl('dfr_rest_services.get_dfr', { output: 'JSON', p_id: registryId });
    ctx.log.debug('ECHO get_dfr', { registryId });
    const dfr = await this.fetchJson<RawEchoDfrFullResponse>(dfrUrl, ctx, {
      deadlineMs: FACILITY_DEADLINE_MS,
    }).catch((error: unknown) => {
      throw error instanceof McpError && error.code === JsonRpcErrorCode.NotFound
        ? facilityNotFound(registryId, error)
        : error;
    });
    const results = dfr.Results;
    const confirmedId = results?.RegistryID;
    if (!results || !confirmedId) throw facilityNotFound(registryId);

    const permits = results.Permits ?? [];
    const frs = permits.find((p) => p.EPASystem === 'FRS');
    const systemPermits = (system: string) => permits.filter((p) => p.EPASystem === system);
    const soleSourceId = (system: string) => {
      const ids = systemPermits(system).flatMap((p) => (p.SourceID ? [p.SourceID] : []));
      return ids.length === 1 ? ids[0] : undefined;
    };
    const flag = (system: string) => (systemPermits(system).length > 0 ? 'Y' : 'N');
    // The FRS entry carries null county and FIPS; program entries carry "King County" / "53033".
    const permitValue = (key: 'FacilityCountyName' | 'FacilityFipsCode') =>
      [frs, ...permits].map((p) => echoText(p?.[key])).find((value) => value !== undefined);

    const status = await this.fetchFacilityStatusRow(
      confirmedId,
      ctx,
      Math.max(0, FACILITY_DEADLINE_MS - (Date.now() - startedAt)),
    );
    const statusRow = status.row;

    const triFacilityIds = [
      ...new Set(
        systemPermits('TRI')
          .sort((a, b) => lastReportedYear(b.FacilityStatus) - lastReportedYear(a.FacilityStatus))
          .flatMap((p) => (p.SourceID ? [p.SourceID] : [])),
      ),
    ];

    // Program flags key on ECHO's media systems: an EIS, CEDRI, RMP, or GHGRP entry also carries
    // Statute CAA without an ICIS-Air record, and a TRI entry carries Statute EP313. County and
    // FIPS come from Permits[] first, so they do not depend on the best-effort status row.
    const base = normalizeFacility({
      RegistryID: confirmedId,
      FacName: frs?.FacilityName,
      FacStreet: frs?.FacilityStreet,
      FacCity: frs?.FacilityCity,
      FacState: frs?.FacilityState,
      FacZip: frs?.FacilityZip,
      FacCounty: permitValue('FacilityCountyName') ?? statusRow?.FacCounty,
      FacFIPSCode: permitValue('FacilityFipsCode') ?? statusRow?.FacFIPSCode,
      FacDerivedStctyFIPS: statusRow?.FacDerivedStctyFIPS,
      FacLat: frs?.Latitude ?? results.SpatialMetadata?.Latitude83,
      FacLong: frs?.Longitude ?? results.SpatialMetadata?.Longitude83,
      FacComplianceStatus: statusRow?.FacComplianceStatus,
      AIRFlag: flag('ICIS-Air'),
      NPDESFlag: flag('ICIS-NPDES'),
      RCRAFlag: flag('RCRAInfo'),
      TRIIDs: triFacilityIds.join(' '),
      SDWISFlag: flag('SDWIS'),
    });
    const tri = latestTriTotal(
      (results.TRIHistory?.Sources ?? []).flatMap((source) => source.ReleaseYear ?? []),
    );

    const programDates = new Map(
      (results.EnforcementComplianceSummaries?.ProgramDates ?? []).map((d) => [d.Program, d]),
    );
    const programCompliance = (results.EnforcementComplianceSummaries?.Summaries ?? []).flatMap(
      (summary): EpaProgramCompliance[] => {
        const recorded = compact({
          currentStatus: echoText(summary.CurrentStatus),
          quartersInNoncompliance: parseEchoNumber(summary.QtrsInNC),
          quartersInSignificantNoncompliance: parseEchoNumber(summary.QtrsInSNC),
          inspections: parseEchoNumber(summary.Inspections),
          lastInspectionDate: echoText(summary.LastInspection),
          informalActions: parseEchoNumber(summary.InformalActions),
          formalActions: parseEchoNumber(summary.FormalActions),
          totalPenaltiesInDollars: parseEchoNumber(summary.TotalPenalties),
        });
        // ECHO lists a statute row with no values for a program the facility has no record in.
        if (!summary.Statute || Object.keys(recorded).length === 0) return [];
        const dates = programDates.get(summary.Statute);
        return [
          compact({
            statute: summary.Statute,
            ...recorded,
            threeYearPeriodStart: echoText(dates?.StartDate3Yr),
            fiveYearPeriodStart: echoText(dates?.StartDate5Yr),
            periodEnd: echoText(dates?.EndDate),
          }),
        ];
      },
    );
    const programSummary = (statute: string) =>
      programCompliance.find((p) => p.statute === statute);

    const inspections = slicePage(
      [...(results.ComplianceHistory?.Inspection ?? [])].sort(newestInspectionFirst),
      lists.inspections,
    );

    const cases = [...(results.CaseFormalActions?.Action ?? [])];
    const formalActions = [...(results.FormalActions?.Action ?? [])]
      .sort((a, b) => dateKey(b.ActionDate).localeCompare(dateKey(a.ActionDate)))
      .map((action) => {
        const recordedCase = takeCase(cases, action);
        const settlements = recordedCase ? settlementDates(recordedCase) : [];
        return compact({
          caseId: echoText(recordedCase?.CaseID),
          settlementDate: settlements.sort((a, b) => dateKey(b).localeCompare(dateKey(a)))[0],
          penaltyAssessedInDollars: parseEchoNumber(action.PenaltyAmount),
          actionType: echoText(action.ActionType),
          actionDate: echoText(action.ActionDate),
          statute: echoText(action.Statute),
          sourceId: echoText(action.SourceID),
          leadAgency: echoText(action.LeadAgency),
        });
      });

    const drinkingWater = slicePage(
      (results.ViolationsEnforcementActions?.Sources ?? [])
        .flatMap((source) => source.Violations ?? [])
        .sort(newestComplianceFirst),
      lists.drinkingWaterViolations,
    );

    const air = base.programs.air ? programSummary('CAA') : undefined;
    const water = base.programs.water ? programSummary('CWA') : undefined;
    const quartersInViolation = parseEchoNumber(statusRow?.FacQtrsWithNC);

    const profile: EpaFacilityProfile = {
      ...base,
      naics: naicsCodes(
        (results.NAICS?.Sources ?? []).flatMap((source) => source.NAICSCodes ?? []),
      ),
      ...(tri && { triReleasesTransfersInLbs: tri.lbs, triReleasesTransfersYear: tri.year }),
      ...(quartersInViolation !== undefined && { compliance: { quartersInViolation } }),
      programCompliance,
      inspections: inspections.items.map((inspection) =>
        compact({
          category: echoText(inspection.ActivityType),
          activityType: echoText(inspection.InspectionType),
          activityDate: echoText(inspection.Date),
          description: echoText(inspection.Finding),
          statute: echoText(inspection.Statute),
          sourceId: echoText(inspection.SourceID),
          leadAgency: echoText(inspection.LeadAgency),
        }),
      ),
      inspectionsTotal: inspections.totalCount,
      ...(inspections.nextOffset !== undefined && {
        inspectionsNextOffset: inspections.nextOffset,
      }),
      drinkingWaterViolations: drinkingWater.items.map(normalizeSdwViolation),
      drinkingWaterViolationsTotal: drinkingWater.totalCount,
      ...(drinkingWater.nextOffset !== undefined && {
        drinkingWaterViolationsNextOffset: drinkingWater.nextOffset,
      }),
      formalActions,
      ...(air?.currentStatus && {
        airCompliance: compact({
          programId: soleSourceId('ICIS-Air'),
          status: air.currentStatus,
          statusDate: air.periodEnd,
        }),
      }),
      ...(water?.currentStatus && {
        waterCompliance: compact({
          status: water.currentStatus,
          permitId: soleSourceId('ICIS-NPDES'),
        }),
      }),
    };
    return status.failed ? { profile, notice: STATUS_LOOKUP_NOTICE } : { profile };
  }

  /**
   * Best-effort echo_rest_services.get_facility_info?p_frs row, the only source of ECHO's
   * facility-level compliance status. Two attempts within what is left of the call's budget;
   * any failure but caller cancellation returns `failed` instead of throwing.
   */
  private async fetchFacilityStatusRow(
    registryId: string,
    ctx: Context,
    budgetMs: number,
  ): Promise<{ row?: RawEchoFacility | undefined; failed?: true }> {
    const url = this.buildUrl('echo_rest_services.get_facility_info', {
      output: 'JSON',
      p_frs: registryId,
    });
    ctx.log.debug('ECHO facility status lookup', {
      endpoint: 'echo_rest_services.get_facility_info',
      registryId,
    });
    try {
      const data = await this.fetchJson<RawEchoFacilityResponse>(url, ctx, {
        maxRetries: 1,
        deadlineMs: Math.min(STATUS_LOOKUP_DEADLINE_MS, budgetMs),
      });
      return { row: data.Results?.Facilities?.find((f) => f.RegistryID === registryId) };
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      ctx.log.warning('ECHO facility status lookup failed; returning the profile without it', {
        registryId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { failed: true };
    }
  }

  /**
   * The public water systems in `scope` that ECHO reports with a current SDWA violation — ECHO's
   * Enforcement Response Policy status, not SDWIS's unresolved (K/O) rows — through
   * sdw_rest_services.get_systems with `p_cs=H,M,O,P,S`, then every get_qid page. A PWSID scope
   * sends `p_pid` batches of SDW_PWSID_BATCH IDs, one get_systems request (plus a get_qid page
   * when any match) per batch. `pwsids` iterates in PWSID order; `totalCount` is ECHO's exact
   * match count, summed across batches. Every request takes its deadline from `budget`, so a
   * caller chaining other upstreams settles them all under one deadline. A failed request fails
   * the lookup: it never reads as "no violations". An empty PWSID list makes no request.
   */
  async findCurrentSdwViolators(
    scope: SdwViolatorScope,
    ctx: Context,
    budget: CallBudget,
  ): Promise<{ pwsids: ReadonlySet<string>; totalCount: number }> {
    if (!('pwsids' in scope)) {
      const { pwsids, totalCount } = await this.fetchSdwViolators(
        {
          p_st: scope.state,
          p_systyp: scope.systemType && SYSTEM_TYPE_CODES[scope.systemType],
        },
        ctx,
        budget,
      );
      return { pwsids: new Set(pwsids.sort()), totalCount };
    }
    const ids = [...new Set(scope.pwsids)];
    const found: string[] = [];
    let totalCount = 0;
    for (let i = 0; i < ids.length; i += SDW_PWSID_BATCH) {
      const batch = await this.fetchSdwViolators(
        { p_pid: ids.slice(i, i + SDW_PWSID_BATCH).join(',') },
        ctx,
        budget,
      );
      found.push(...batch.pwsids);
      totalCount += batch.totalCount;
    }
    return { pwsids: new Set(found.sort()), totalCount };
  }

  /**
   * One get_systems current-violation request and its get_qid pages. get_systems echoes no
   * parameters, so each row's CurrVioFlag is checked instead: a "0" row means ECHO dropped p_cs.
   */
  private async fetchSdwViolators(
    filter: { p_st?: string; p_systyp?: string | undefined; p_pid?: string },
    ctx: Context,
    budget: CallBudget,
  ): Promise<{ pwsids: string[]; totalCount: number }> {
    const url = this.buildUrl('sdw_rest_services.get_systems', {
      output: 'JSON',
      responseset: SDW_PAGE_ROWS,
      p_cs: CURRENT_VIOLATION_CATEGORIES,
      ...filter,
    });
    ctx.log.debug('ECHO SDW current-violation lookup', {
      endpoint: 'sdw_rest_services.get_systems',
    });
    const data = await this.fetchJson<RawSdwSystemsResponse>(url, ctx, {
      deadlineMs: budget.remainingMs(),
    }).catch(budget.rethrow);
    const totalCount = Number.parseInt(data.Results?.QueryRows ?? '', 10);
    if (Number.isNaN(totalCount)) {
      throw serviceUnavailable('ECHO water system lookup returned no match count.');
    }
    if (totalCount === 0) return { pwsids: [], totalCount };
    const queryId = data.Results?.QueryID;
    if (!queryId) {
      throw serviceUnavailable('ECHO water system lookup returned matches without a query ID.', {
        totalCount,
      });
    }

    const pwsids: string[] = [];
    for (let pageno = 1; pwsids.length < totalCount; pageno++) {
      const qidUrl = this.buildUrl('sdw_rest_services.get_qid', {
        output: 'JSON',
        qid: queryId,
        pageno,
        qcolumns: SDW_VIOLATOR_COLUMNS,
      });
      ctx.log.debug('ECHO SDW current-violation page', {
        endpoint: 'sdw_rest_services.get_qid',
        queryId,
        pageno,
      });
      const page = await this.fetchJson<RawSdwSystemsPage>(qidUrl, ctx, {
        deadlineMs: budget.remainingMs(),
      }).catch(budget.rethrow);
      const rows = page.Results?.WaterSystems ?? [];
      if (rows.length === 0) {
        throw serviceUnavailable(
          `ECHO returned ${pwsids.length} of the ${totalCount} water systems its current-violation lookup matched.`,
          { totalCount, received: pwsids.length },
        );
      }
      for (const row of rows) {
        if (row.CurrVioFlag !== '1' || !row.PWSId) {
          throw new McpError(
            JsonRpcErrorCode.InternalError,
            `ECHO sdw_rest_services.get_systems returned ${row.PWSId ?? 'a system'} without a current violation for a p_cs=${CURRENT_VIOLATION_CATEGORIES} lookup, so it did not apply that filter. Retrying will not help.`,
            { retryable: false },
          );
        }
        pwsids.push(row.PWSId);
      }
    }
    return { pwsids, totalCount };
  }

  /**
   * Search EPA enforcement cases with ECHO get_case_info, paged by {@link fetchSearchPage}: a
   * large match is read from get_qid, and ECHO answers a small one inline in discovery. The
   * default row carries every column normalizeCase maps, so no `qcolumns` is sent.
   *
   * Filing dates are validated YYYY-MM-DD strings. A date bound sends both MM/DD/YYYY ends ECHO
   * requires — an open end reads 01/01/1900 or today (UTC), and each end is clamped to that span —
   * with the civil filing milestones; `filedDateRange` reports both ends as sent. A range that
   * clamps empty returns no cases without a request: ECHO answers an inverted range with an
   * in-band error, not an empty result.
   */
  async searchViolations(
    params: {
      state?: string;
      zipCode?: string;
      program?: string;
      caseType?: CaseType;
      dateFiledStart?: string;
      dateFiledEnd?: string;
      limit?: number;
      offset?: number;
    },
    ctx: Context,
  ): Promise<
    Page<EpaCase> & { totalCount: number; filedDateRange?: { start: string; end: string } }
  > {
    const budget = searchBudget(
      'case search',
      'Narrow it with zip_code, program, or a filing-date range, or call again later.',
    );
    const { dateFiledStart, dateFiledEnd } = params;
    const dated = dateFiledStart !== undefined || dateFiledEnd !== undefined;
    const today = new Date().toISOString().slice(0, 10);
    const fromDate =
      dateFiledStart !== undefined && dateFiledStart > EARLIEST_FILING_DATE
        ? dateFiledStart
        : EARLIEST_FILING_DATE;
    const toDate = dateFiledEnd !== undefined && dateFiledEnd < today ? dateFiledEnd : today;
    const range = dated ? { filedDateRange: { start: fromDate, end: toDate } } : {};
    if (dated && fromDate > toDate) return { items: [], totalCount: 0, ...range };

    const page = await this.fetchSearchPage<RawEchoCaseResponse, RawEchoCase>(
      {
        endpoint: 'case_rest_services.get_case_info',
        label: 'case search',
        params: {
          p_state: params.state,
          p_fac_zip: params.zipCode,
          p_law: params.program,
          p_civil_criminal_indicator: params.caseType && CASE_TYPE_CODES[params.caseType],
          ...(dated && {
            p_from_date: toEchoDate(fromDate),
            p_to_date: toEchoDate(toDate),
            p_milestone: FILING_MILESTONES,
          }),
        },
        rows: (body) => body.Results?.Cases,
      },
      { limit: params.limit ?? 50, offset: params.offset ?? 0 },
      ctx,
      budget,
    );
    return { ...page, items: page.items.map(normalizeCase), ...range };
  }

  /**
   * One civil enforcement case from case_rest_services.get_case_report: the case, its facilities
   * (merged by Registry ID), defendants, laws, milestones, pollutants, and enforcement
   * conclusions. The report rejects criminal case numbers like an unknown one.
   * @throws McpError `NotFound` with reason `case_not_found` when ECHO has no report for the ID.
   */
  async getCase(caseId: string, ctx: Context): Promise<EpaCaseReport> {
    const url = this.buildUrl('case_rest_services.get_case_report', {
      output: 'JSON',
      p_id: caseId,
    });
    ctx.log.debug('ECHO get_case_report', { caseId });
    const report = await this.fetchJson<RawEchoCaseReportResponse>(url, ctx, {
      deadlineMs: CASE_REPORT_DEADLINE_MS,
    }).catch((error: unknown) => {
      throw error instanceof McpError && error.code === JsonRpcErrorCode.NotFound
        ? caseNotFound(caseId, error)
        : error;
    });
    const results = report.Results;
    const info = results?.CaseInformation;
    const caseNumber = echoText(info?.CaseNumber);
    if (!results || !info || !caseNumber) throw caseNotFound(caseId);
    return normalizeCaseReport(caseNumber, info, results);
  }
}

// --- Init/accessor pattern ---

let _service: EchoService | undefined;

export function initEchoService(config: AppConfig, storage: StorageService): void {
  _service = new EchoService(config, storage);
}

export function getEchoService(): EchoService {
  if (!_service) {
    throw new Error('EchoService not initialized — call initEchoService() in setup()');
  }
  return _service;
}
