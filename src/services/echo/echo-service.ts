/**
 * @fileoverview ECHO API service for EPA facility compliance and enforcement data.
 * Wraps echodata.epa.gov/echo REST endpoints for facility search, facility detail,
 * and enforcement case search.
 * @module services/echo/echo-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  EpaCase,
  EpaFacility,
  EpaFacilityProfile,
  RawEchoCaseInfoResponse,
  RawEchoCaseResponse,
  RawEchoDfrAir,
  RawEchoDfrComplianceSummary,
  RawEchoDfrFullResponse,
  RawEchoDfrInspectionEnforcement,
  RawEchoDfrWater,
  RawEchoFacilityResponse,
} from './types.js';

/** Normalizes a raw ECHO facility to the domain type. */
function normalizeFacility(raw: Record<string, string | undefined>): EpaFacility {
  const penaltyAir = parseFloat(raw.AIRPenalties ?? '0') || 0;
  const penaltyCwa = parseFloat(raw.CWAPenalties ?? '0') || 0;
  const penaltyRcr = parseFloat(raw.RCRPenalties ?? '0') || 0;
  const totalPenalties = penaltyAir + penaltyCwa + penaltyRcr;

  return {
    registryId: raw.RegistryID ?? '',
    name: raw.FacName ?? '',
    ...(raw.FacStreet && { street: raw.FacStreet }),
    ...(raw.FacCity && { city: raw.FacCity }),
    ...(raw.FacState && { state: raw.FacState }),
    ...(raw.FacZip && { zip: raw.FacZip }),
    ...(raw.FacCounty && { county: raw.FacCounty }),
    ...(raw.FacFIPSCode && { fipsCode: raw.FacFIPSCode }),
    ...(raw.FacLat &&
      !Number.isNaN(parseFloat(raw.FacLat)) && { latitude: parseFloat(raw.FacLat) }),
    ...(raw.FacLon &&
      !Number.isNaN(parseFloat(raw.FacLon)) && { longitude: parseFloat(raw.FacLon) }),
    ...(raw.FacComplianceStatus && { complianceStatus: raw.FacComplianceStatus }),
    programs: {
      air: raw.AIRFlag === 'Y',
      water: raw.CWAFlag === 'Y',
      rcra: raw.RCRFlag === 'Y',
      tri: raw.TRIFlag === 'Y',
      sdwa: raw.SDWAFlag === 'Y',
    },
    ...(raw.TRIReleasesTransfers &&
      !Number.isNaN(parseFloat(raw.TRIReleasesTransfers)) && {
        triReleasesTransfersInLbs: parseFloat(raw.TRIReleasesTransfers),
      }),
    ...(raw.InspectionCount &&
      !Number.isNaN(parseInt(raw.InspectionCount, 10)) && {
        inspectionCount: parseInt(raw.InspectionCount, 10),
      }),
    ...(totalPenalties > 0 && { totalPenaltiesInDollars: totalPenalties }),
  };
}

export class EchoService {
  private readonly baseUrl: string;

  // config and storage retained for future caching/state use
  constructor(_config: AppConfig, _storage: StorageService) {
    this.baseUrl = getServerConfig().echoBaseUrl;
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

  /** Fetch JSON from ECHO with retry. */
  // biome-ignore lint/suspicious/useAwait: delegates to withRetry() which returns a Promise — async typing is correct
  private async fetchJson<T>(url: string, ctx: Context): Promise<T> {
    return withRetry(
      async () => {
        const response = await fetch(url, {
          signal: ctx.signal,
          headers: { 'User-Agent': '@cyanheads/epa-mcp-server/0.1.1' },
        });
        if (!response.ok) {
          throw await httpErrorFromResponse(response, { service: 'ECHO', data: { url } });
        }
        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable(
            'ECHO API returned HTML instead of JSON — likely rate-limited or unavailable.',
            { url },
          );
        }
        const parsed = JSON.parse(text) as Record<string, unknown>;
        // ECHO returns bot-blocking errors in Results.Error.ErrorMessage rather than HTTP error codes
        const errorMsg = (parsed as { Results?: { Error?: { ErrorMessage?: string } } }).Results
          ?.Error?.ErrorMessage;
        if (errorMsg) {
          throw serviceUnavailable(`ECHO API error: ${errorMsg}`, { url });
        }
        return parsed as T;
      },
      {
        operation: 'EchoService.fetchJson',
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );
  }

  /**
   * Search EPA-regulated facilities using ECHO get_facility_info.
   * At least one geographic parameter must be supplied.
   */
  async searchFacilities(
    params: {
      zipCode?: string;
      state?: string;
      city?: string;
      activeOnly?: boolean;
      programs?: string[];
      hasViolation?: boolean;
      limit?: number;
    },
    ctx: Context,
  ): Promise<{ facilities: EpaFacility[]; totalCount: number }> {
    const qparams: Record<string, string | number | boolean | undefined> = {
      output: 'JSON',
      p_limit: params.limit ?? 50,
    };

    if (params.zipCode) qparams.p_zip = params.zipCode;
    if (params.state) qparams.p_state = params.state;
    if (params.city) qparams.p_city = params.city;
    if (params.activeOnly) qparams.p_act = 'Y';
    if (params.hasViolation) qparams.p_sv_flag = 'Y';

    // Program filters — comma-separated list restricts to facilities in those programs
    if (params.programs?.length) {
      const programMap: Record<string, string> = {
        CAA: 'AIR',
        CWA: 'CWA',
        RCRA: 'RCRA',
        TRI: 'TRI',
        SDWA: 'SDWA',
      };
      const mapped = params.programs.map((p) => programMap[p]).filter(Boolean);
      if (mapped.length) qparams.p_naa = mapped.join(',');
    }

    const url = this.buildUrl('echo_rest_services.get_facility_info', qparams);
    ctx.log.debug('ECHO facility search', { url });

    const data = await this.fetchJson<RawEchoFacilityResponse>(url, ctx);
    const raw = data.Results?.Facilities ?? [];
    const totalCount = parseInt(data.Results?.TotalCount ?? '0', 10) || raw.length;

    return {
      facilities: raw.map((f) => normalizeFacility(f as Record<string, string | undefined>)),
      totalCount,
    };
  }

  /**
   * Retrieve a full compliance profile for a single facility, aggregating multiple DFR endpoints.
   *
   * Step 1 uses dfr_rest_services.get_dfr (accepts Registry IDs directly) to obtain base facility
   * data. The previous approach used echo_rest_services.get_facility_info?p_id=registryId, which
   * only accepts program-specific IDs (e.g. RCRA handler IDs), never numeric Registry IDs — so it
   * always returned 0 results. Steps 2-5 run in parallel after the initial DFR fetch.
   */
  async getFacility(registryId: string, ctx: Context): Promise<EpaFacilityProfile> {
    // Step 1: get_dfr accepts Registry IDs via p_id and returns facility name/address in
    // Results.Permits[] (EPASystem="FRS" record) and confirms identity via Results.RegistryID.
    const dfrUrl = this.buildUrl('dfr_rest_services.get_dfr', {
      output: 'JSON',
      p_id: registryId,
    });
    ctx.log.debug('ECHO get_dfr', { registryId });
    const dfrData = await this.fetchJson<RawEchoDfrFullResponse>(dfrUrl, ctx);
    const confirmedId = dfrData.Results?.RegistryID;

    if (!confirmedId) {
      throw serviceUnavailable(
        `ECHO returned no facility for Registry ID "${registryId}". Check the ID and try again.`,
        { registryId },
      );
    }

    // Extract base facility info from the FRS permit record in Permits[]
    const permits = dfrData.Results?.Permits ?? [];
    const frsPerm = permits.find((p) => p.EPASystem === 'FRS');
    // Derive program flags from the statutes present in the Permits list
    const statutes = new Set(permits.map((p) => p.Statute?.toUpperCase()).filter(Boolean));
    const raw: Record<string, string | undefined> = {
      RegistryID: confirmedId,
      FacName: frsPerm?.FacilityName ?? undefined,
      FacStreet: frsPerm?.FacilityStreet ?? undefined,
      FacCity: frsPerm?.FacilityCity ?? undefined,
      FacState: frsPerm?.FacilityState ?? undefined,
      FacZip: frsPerm?.FacilityZip ?? undefined,
      FacCounty: frsPerm?.FacilityCountyName ?? undefined,
      FacFIPSCode: frsPerm?.FacilityFipsCode ?? undefined,
      FacLat: frsPerm?.Latitude ?? dfrData.Results?.SpatialMetadata?.Latitude83 ?? undefined,
      FacLon: frsPerm?.Longitude ?? dfrData.Results?.SpatialMetadata?.Longitude83 ?? undefined,
      // Program flags derived from Permits[].Statute (CAA→AIR, CWA, RCRA, TRI, SDWA)
      AIRFlag: statutes.has('CAA') ? 'Y' : 'N',
      CWAFlag: statutes.has('CWA') || statutes.has('NPDES') ? 'Y' : 'N',
      RCRFlag: statutes.has('RCRA') ? 'Y' : 'N',
      TRIFlag: statutes.has('TRI') ? 'Y' : 'N',
      SDWAFlag: statutes.has('SDWA') ? 'Y' : 'N',
    };

    const base = normalizeFacility(raw);

    // Steps 2-5: Parallel DFR calls
    const [complianceResult, inspEnfResult, airResult, waterResult] = await Promise.allSettled([
      this.fetchJson<RawEchoDfrComplianceSummary>(
        this.buildUrl('dfr_rest_services.get_compliance_summary', {
          output: 'JSON',
          p_id: registryId,
        }),
        ctx,
      ),
      this.fetchJson<RawEchoDfrInspectionEnforcement>(
        this.buildUrl('dfr_rest_services.get_inspection_enforcement', {
          output: 'JSON',
          p_id: registryId,
        }),
        ctx,
      ),
      base.programs.air
        ? this.fetchJson<RawEchoDfrAir>(
            this.buildUrl('dfr_rest_services.get_air', { output: 'JSON', p_id: registryId }),
            ctx,
          )
        : Promise.resolve(null),
      base.programs.water
        ? this.fetchJson<RawEchoDfrWater>(
            this.buildUrl('dfr_rest_services.get_water', { output: 'JSON', p_id: registryId }),
            ctx,
          )
        : Promise.resolve(null),
    ]);

    // Extract compliance summary
    let compliance: EpaFacilityProfile['compliance'];
    if (complianceResult.status === 'fulfilled') {
      const cs = complianceResult.value?.Results?.ComplianceSummary;
      if (cs) {
        compliance = {
          ...(cs.MediaStatusCode && { mediaStatusCode: cs.MediaStatusCode }),
          ...(cs.MediaStatusDesc && { mediaStatusDescription: cs.MediaStatusDesc }),
          ...(cs.QtrsInViol !== undefined && { quartersInViolation: Number(cs.QtrsInViol) }),
        };
      }
    }

    // Extract inspections and formal actions
    const inspections: EpaFacilityProfile['inspections'] = [];
    const formalActions: EpaFacilityProfile['formalActions'] = [];
    if (inspEnfResult.status === 'fulfilled') {
      const ie = inspEnfResult.value?.Results;
      for (const insp of ie?.Inspections ?? []) {
        inspections.push({
          ...(insp.ActivityType && { activityType: insp.ActivityType }),
          ...(insp.ActivityDate && { activityDate: insp.ActivityDate }),
          ...(insp.ActivityTypeDescription && { description: insp.ActivityTypeDescription }),
        });
      }
      for (const fa of ie?.FormalActions ?? []) {
        formalActions.push({
          ...(fa.CaseID && { caseId: fa.CaseID }),
          ...(fa.SettlementDate && { settlementDate: fa.SettlementDate }),
          ...(fa.PenaltyAssessed !== undefined && {
            penaltyAssessedInDollars: Number(fa.PenaltyAssessed),
          }),
          ...(fa.FormalActionType && { actionType: fa.FormalActionType }),
        });
      }
    }

    // Extract air compliance
    let airCompliance: EpaFacilityProfile['airCompliance'];
    if (airResult.status === 'fulfilled' && airResult.value) {
      const ac = airResult.value?.Results?.AirComplianceSummary;
      if (ac) {
        airCompliance = {
          ...(ac.ProgramID && { programId: ac.ProgramID }),
          ...(ac.Status && { status: ac.Status }),
          ...(ac.StatusDate && { statusDate: ac.StatusDate }),
        };
      }
    }

    // Extract water compliance
    let waterCompliance: EpaFacilityProfile['waterCompliance'];
    if (waterResult.status === 'fulfilled' && waterResult.value) {
      const wc = waterResult.value?.Results?.WaterCompliance;
      if (wc) {
        waterCompliance = {
          ...(wc.ProgramID && { programId: wc.ProgramID }),
          ...(wc.Status && { status: wc.Status }),
          ...(wc.PermitID && { permitId: wc.PermitID }),
        };
      }
    }

    return {
      ...base,
      ...(compliance && { compliance }),
      inspections,
      formalActions,
      ...(airCompliance && { airCompliance }),
      ...(waterCompliance && { waterCompliance }),
    };
  }

  /**
   * Search EPA enforcement cases using a two-step ECHO case_rest_services flow.
   *
   * Step 1: case_rest_services.get_case_info — returns QueryID and row count (no Cases array).
   * Step 2: case_rest_services.get_qid?qid=<QueryID> — returns the actual Cases[] records.
   *
   * The single-step approach (reading Cases from get_case_info) always returns empty because
   * get_case_info is a discovery/cluster endpoint that does not include paginated case records.
   */
  async searchViolations(
    params: {
      state?: string;
      zipCode?: string;
      program?: string;
      caseType?: string;
      dateFiledStart?: string;
      dateFiledEnd?: string;
      limit?: number;
    },
    ctx: Context,
  ): Promise<{ cases: EpaCase[]; totalCount: number }> {
    const qparams: Record<string, string | number | undefined> = {
      output: 'JSON',
      p_limit: params.limit ?? 50,
    };

    if (params.state) qparams.p_state = params.state;
    if (params.zipCode) qparams.p_zip = params.zipCode;
    if (params.program) qparams.p_act = params.program;
    if (params.dateFiledStart) qparams.p_date_filed_from = params.dateFiledStart;
    if (params.dateFiledEnd) qparams.p_date_filed_to = params.dateFiledEnd;

    // Case type filter
    if (params.caseType && params.caseType !== 'all') {
      qparams.p_case_category = params.caseType === 'criminal' ? 'C' : 'V';
    }

    // Step 1: Get QueryID from get_case_info (returns cluster data only, no Cases[])
    const infoUrl = this.buildUrl('case_rest_services.get_case_info', qparams);
    ctx.log.debug('ECHO case search step 1', { url: infoUrl });

    const infoData = await this.fetchJson<RawEchoCaseInfoResponse>(infoUrl, ctx);
    const queryId = infoData.Results?.QueryID;
    const totalCount = parseInt(infoData.Results?.QueryRows ?? '0', 10) || 0;

    if (!queryId || totalCount === 0) {
      return { cases: [], totalCount: 0 };
    }

    // Step 2: Fetch actual case records via get_qid
    const qidUrl = this.buildUrl('case_rest_services.get_qid', {
      output: 'JSON',
      qid: queryId,
      p_limit: params.limit ?? 50,
    });
    ctx.log.debug('ECHO case search step 2', { url: qidUrl, queryId });

    const data = await this.fetchJson<RawEchoCaseResponse>(qidUrl, ctx);
    const raw = data.Results?.Cases ?? [];

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
