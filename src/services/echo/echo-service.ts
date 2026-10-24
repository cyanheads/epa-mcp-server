/**
 * @fileoverview ECHO API service for EPA facility compliance and enforcement data.
 * Wraps echodata.epa.gov/echo REST endpoints for facility search, facility detail,
 * and enforcement case search.
 * @module services/echo/echo-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { callBudget } from '@/services/call-budget.js';
import type {
  EpaCase,
  EpaFacility,
  EpaFacilityProfile,
  EpaProgramCompliance,
  RawEchoCaseInfoResponse,
  RawEchoCaseResponse,
  RawEchoDfrCaseAction,
  RawEchoDfrFormalAction,
  RawEchoDfrFullResponse,
  RawEchoDfrTriYear,
  RawEchoFacility,
  RawEchoFacilityResponse,
  RawEchoQueryParameter,
} from './types.js';

/**
 * Budget for one getFacility call — every get_dfr attempt plus the status lookup — kept under
 * the 60 s default request timeout of MCP SDK clients.
 */
const FACILITY_DEADLINE_MS = 50_000;

/** Ceiling for the best-effort p_frs status lookup within that budget. */
const STATUS_LOOKUP_DEADLINE_MS = 10_000;

/**
 * Budget for one searchFacilities or searchViolations call — the discovery request, its get_qid
 * page, and every retry and backoff of either — kept under the 60 s default request timeout of
 * MCP SDK clients. A legitimate `p_ct=Los Angeles` facility search takes 54.6–56.7 s, so the
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
 * Newest compliance monitoring records kept in a profile. A Texas refinery logs several hundred
 * state investigations in five years (581 at registry 110041990913, about 130 KB unbounded).
 */
const INSPECTION_CAP = 100;

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
 * Classifies ECHO's in-band failure: HTTP 200 with `Results.Error.ErrorMessage`. Only an
 * unrecognized message stays a retryable ServiceUnavailable. The queryset-limit message
 * ("Rows Returned would be <n>…") comes from get_facilities, which this service never calls;
 * get_facility_info and get_case_info have no row ceiling.
 */
function echoBodyError(message: string): McpError {
  const detail = `ECHO API error: ${message}`;
  if (/^ID .+ is invalid\.$/s.test(message)) return notFound(detail);
  if (/^QueryID .+ not found in ECHO\.$/s.test(message)) {
    return serviceUnavailable(detail, { retryable: false });
  }
  return serviceUnavailable(detail);
}

/** The NotFound `epa_echo_get_facility` and `epa://facility/{registry_id}` declare as `facility_not_found`. */
function facilityNotFound(registryId: string, cause?: unknown): McpError {
  return notFound(
    `No facility found for Registry ID "${registryId}".`,
    { reason: 'facility_not_found', registryId },
    cause === undefined ? undefined : { cause },
  );
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
 * Normalizes an ECHO facility row, read by the column names FACILITY_SEARCH_COLUMNS requests, to
 * the domain type. Program flags match the `p_med` filters: a TRI facility is one with a TRI ID
 * (ECHO's TRIFlag marks current reporters only). getFacility passes the same columns, some unset.
 */
function normalizeFacility(
  raw: {
    [K in keyof RawEchoFacility]?: RawEchoFacility[K] | undefined;
  },
): EpaFacility {
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
      tri: echoText(raw.TRIIDs) !== undefined,
      sdwa: raw.SDWISFlag === 'Y',
    },
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
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const errorMsg = (parsed as { Results?: { Error?: { ErrorMessage?: string } } }).Results
          ?.Error?.ErrorMessage;
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
   * Search EPA-regulated facilities using ECHO get_facility_info, then get_qid for the first
   * page when ECHO does not return the rows inline. At least one geographic parameter must be
   * supplied.
   */
  async searchFacilities(
    params: {
      zipCode?: string;
      state?: string;
      city?: string;
      latitude?: number;
      longitude?: number;
      radiusMiles?: number;
      activeOnly?: boolean;
      program?: FacilityProgram;
      hasViolation?: boolean;
      limit?: number;
    },
    ctx: Context,
  ): Promise<{ facilities: EpaFacility[]; totalCount: number }> {
    const budget = searchBudget(
      'facility search',
      'Narrow it with zip_code instead of city or state, a smaller radius_miles, or a programs filter, or call again later.',
    );
    const limit = params.limit ?? 50;
    // buildUrl drops undefined values; latitude/longitude of 0 are valid and sent.
    const url = this.buildUrl('echo_rest_services.get_facility_info', {
      output: 'JSON',
      responseset: limit,
      qcolumns: FACILITY_SEARCH_COLUMNS,
      p_zip: params.zipCode,
      p_st: params.state,
      p_ct: params.city,
      p_lat: params.latitude,
      p_long: params.longitude,
      p_radius: params.radiusMiles,
      p_act: params.activeOnly ? 'Y' : undefined,
      p_cs: params.hasViolation ? SIGNIFICANT_NONCOMPLIANCE : undefined,
      p_med: params.program && PROGRAM_MEDIA_CODES[params.program],
    });
    ctx.log.debug('ECHO facility search', { endpoint: 'echo_rest_services.get_facility_info' });

    const data = await this.fetchJson<RawEchoFacilityResponse>(url, ctx, {
      deadlineMs: budget.remainingMs(),
    }).catch(budget.rethrow);
    assertFiltersApplied(
      'echo_rest_services.get_facility_info',
      url,
      data.Results?.QueryParameters,
    );
    const directFacilities = data.Results?.Facilities ?? [];
    const parsedTotalCount = Number.parseInt(
      data.Results?.QueryRows ?? data.Results?.TotalCount ?? '',
      10,
    );
    const totalCount = Number.isNaN(parsedTotalCount) ? directFacilities.length : parsedTotalCount;

    let raw = directFacilities;
    if (raw.length === 0 && totalCount > 0) {
      const queryId = data.Results?.QueryID;
      if (!queryId) {
        throw serviceUnavailable('ECHO facility search returned matches without a query ID.', {
          totalCount,
        });
      }

      const qidUrl = this.buildUrl('echo_rest_services.get_qid', {
        output: 'JSON',
        qid: queryId,
        pageno: 1,
        qcolumns: FACILITY_SEARCH_COLUMNS,
      });
      ctx.log.debug('ECHO facility search page', {
        endpoint: 'echo_rest_services.get_qid',
        queryId,
      });
      const page = await this.fetchJson<RawEchoFacilityResponse>(qidUrl, ctx, {
        deadlineMs: budget.remainingMs(),
      }).catch(budget.rethrow);
      raw = page.Results?.Facilities ?? [];
    }

    return { facilities: raw.slice(0, limit).map(normalizeFacility), totalCount };
  }

  /**
   * Retrieve a full compliance profile for a single facility from one
   * dfr_rest_services.get_dfr response, plus a best-effort facility search row for the
   * facility-level compliance status that no DFR section carries.
   *
   * get_dfr takes a Registry ID or a program ID (a TRI or RCRA ID resolves to its Registry ID);
   * echo_rest_services.get_facility_info takes the resolved Registry ID only as `p_frs`.
   * A failed status lookup is disclosed as an enrichment notice.
   */
  async getFacility(registryId: string, ctx: Context): Promise<EpaFacilityProfile> {
    const { profile, notice } = await this.getFacilityReport(registryId, ctx);
    if (notice) ctx.enrich.notice(notice);
    return profile;
  }

  /** The getFacility profile, with the notice to show when the status lookup failed. */
  async getFacilityReport(
    registryId: string,
    ctx: Context,
  ): Promise<{ profile: EpaFacilityProfile; notice?: string }> {
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
      TRIIDs: triFacilityIds.join(','),
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

    const monitoring = results.ComplianceHistory?.Inspection ?? [];
    const inspections = [...monitoring]
      .sort((a, b) => dateKey(b.Date).localeCompare(dateKey(a.Date)))
      .slice(0, INSPECTION_CAP)
      .map((inspection) =>
        compact({
          category: echoText(inspection.ActivityType),
          activityType: echoText(inspection.InspectionType),
          activityDate: echoText(inspection.Date),
          description: echoText(inspection.Finding),
          statute: echoText(inspection.Statute),
          sourceId: echoText(inspection.SourceID),
          leadAgency: echoText(inspection.LeadAgency),
        }),
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

    const air = base.programs.air ? programSummary('CAA') : undefined;
    const water = base.programs.water ? programSummary('CWA') : undefined;
    const quartersInViolation = parseEchoNumber(statusRow?.FacQtrsWithNC);

    const profile: EpaFacilityProfile = {
      ...base,
      triFacilityIds,
      ...(tri && { triReleasesTransfersInLbs: tri.lbs, triReleasesTransfersYear: tri.year }),
      ...(quartersInViolation !== undefined && { compliance: { quartersInViolation } }),
      programCompliance,
      inspections,
      inspectionsTotal: monitoring.length,
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
   * Search EPA enforcement cases using a two-step ECHO case_rest_services flow.
   *
   * Step 1: case_rest_services.get_case_info — returns QueryID and row count (no Cases array).
   * Step 2: case_rest_services.get_qid?qid=<QueryID> — returns the actual Cases[] records.
   *
   * The single-step approach (reading Cases from get_case_info) always returns empty because
   * get_case_info is a discovery/cluster endpoint that does not include paginated case records.
   *
   * Filing dates are validated YYYY-MM-DD strings. A date bound sends both MM/DD/YYYY ends ECHO
   * requires — an open end reads 01/01/1900 or today (UTC), and each end is clamped to that span —
   * with the civil filing milestones. A range that clamps empty returns no cases without a
   * request: ECHO answers an inverted range with an in-band error, not an empty result.
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
    },
    ctx: Context,
  ): Promise<{ cases: EpaCase[]; totalCount: number }> {
    const budget = searchBudget(
      'case search',
      'Narrow it with zip_code, program, or a filing-date range, or call again later.',
    );
    const limit = params.limit ?? 50;
    const { dateFiledStart, dateFiledEnd } = params;
    const dated = dateFiledStart !== undefined || dateFiledEnd !== undefined;
    const today = new Date().toISOString().slice(0, 10);
    const fromDate =
      dateFiledStart !== undefined && dateFiledStart > EARLIEST_FILING_DATE
        ? dateFiledStart
        : EARLIEST_FILING_DATE;
    const toDate = dateFiledEnd !== undefined && dateFiledEnd < today ? dateFiledEnd : today;
    if (dated && fromDate > toDate) return { cases: [], totalCount: 0 };

    // Step 1: Get QueryID from get_case_info (returns cluster data only, no Cases[])
    const infoUrl = this.buildUrl('case_rest_services.get_case_info', {
      output: 'JSON',
      responseset: limit,
      p_state: params.state,
      p_fac_zip: params.zipCode,
      p_law: params.program,
      p_civil_criminal_indicator: params.caseType && CASE_TYPE_CODES[params.caseType],
      ...(dated && {
        p_from_date: toEchoDate(fromDate),
        p_to_date: toEchoDate(toDate),
        p_milestone: FILING_MILESTONES,
      }),
    });
    ctx.log.debug('ECHO case search step 1', { endpoint: 'case_rest_services.get_case_info' });

    const infoData = await this.fetchJson<RawEchoCaseInfoResponse>(infoUrl, ctx, {
      deadlineMs: budget.remainingMs(),
    }).catch(budget.rethrow);
    assertFiltersApplied(
      'case_rest_services.get_case_info',
      infoUrl,
      infoData.Results?.QueryParameters,
    );
    const queryId = infoData.Results?.QueryID;
    const totalCount = parseInt(infoData.Results?.QueryRows ?? '0', 10) || 0;

    if (!queryId || totalCount === 0) {
      return { cases: [], totalCount: 0 };
    }

    // Step 2: Fetch actual case records via get_qid
    const qidUrl = this.buildUrl('case_rest_services.get_qid', {
      output: 'JSON',
      qid: queryId,
      pageno: 1,
    });
    ctx.log.debug('ECHO case search step 2', { endpoint: 'case_rest_services.get_qid', queryId });

    const data = await this.fetchJson<RawEchoCaseResponse>(qidUrl, ctx, {
      deadlineMs: budget.remainingMs(),
    }).catch(budget.rethrow);
    const raw = (data.Results?.Cases ?? []).slice(0, limit);

    const cases: EpaCase[] = raw.map((c) => {
      const fedPenalty = c.FedPenalty ? parseFloat(String(c.FedPenalty).replace(/[$,]/g, '')) : NaN;
      return {
        // CaseNumber is the primary identifier in get_qid (e.g. "03-2014-7010")
        ...(c.CaseNumber && { caseId: c.CaseNumber }),
        ...(c.CaseName && { caseName: c.CaseName }),
        // CaseCategoryDesc maps to caseType (e.g. "Judicial", "Administrative")
        ...(c.CaseCategoryDesc && { caseType: String(c.CaseCategoryDesc) }),
        // PrimaryLaw maps to programsViolated (e.g. "CERCLA", "CAA")
        ...(c.PrimaryLaw && { programsViolated: String(c.PrimaryLaw) }),
        // FedPenalty is a dollar-formatted string — parse to float
        ...(!Number.isNaN(fedPenalty) && { penaltyAssessedInDollars: fedPenalty }),
        ...(c.SettlementDate && { settlementDate: String(c.SettlementDate) }),
        // DateFiled is the filing date field in get_qid (not FiledDate)
        ...(c.DateFiled && { filedDate: String(c.DateFiled) }),
        // Note: FacName, RegistryID, and State are not present in get_qid responses;
        // those fields remain optional in the output schema per the tool definition.
      };
    });

    return { cases, totalCount };
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
