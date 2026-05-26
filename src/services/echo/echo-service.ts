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
  RawEchoCaseResponse,
  RawEchoDfrAir,
  RawEchoDfrComplianceSummary,
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
          headers: { 'User-Agent': '@cyanheads/epa-mcp-server/0.1.0' },
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
   * Steps 2-5 run in parallel after the initial facility info fetch.
   */
  async getFacility(registryId: string, ctx: Context): Promise<EpaFacilityProfile> {
    // Step 1: Get base facility info + program flags
    const facilityUrl = this.buildUrl('echo_rest_services.get_facility_info', {
      output: 'JSON',
      p_id: registryId,
      p_limit: 1,
    });
    ctx.log.debug('ECHO get_facility_info', { registryId });
    const facilityData = await this.fetchJson<RawEchoFacilityResponse>(facilityUrl, ctx);
    const rawFacilities = facilityData.Results?.Facilities ?? [];
    const raw = rawFacilities[0] as Record<string, string | undefined> | undefined;

    if (!raw?.RegistryID) {
      throw serviceUnavailable(
        `ECHO returned no facility for Registry ID "${registryId}". Check the ID and try again.`,
        { registryId },
      );
    }

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
   * Search EPA enforcement cases using ECHO case_rest_services.
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

    const url = this.buildUrl('case_rest_services.get_case_info', qparams);
    ctx.log.debug('ECHO case search', { url });

    const data = await this.fetchJson<RawEchoCaseResponse>(url, ctx);
    const raw = data.Results?.Cases ?? [];
    const totalCount = parseInt(data.Results?.TotalCount ?? '0', 10) || raw.length;

    const cases: EpaCase[] = raw.map((c) => ({
      ...(c.CaseID && { caseId: c.CaseID }),
      ...(c.CaseName && { caseName: c.CaseName }),
      ...(c.FacName && { facilityName: c.FacName }),
      ...(c.RegistryID && { registryId: c.RegistryID }),
      ...(c.ProgramsViolated && { programsViolated: String(c.ProgramsViolated) }),
      ...(c.CaseType && { caseType: String(c.CaseType) }),
      ...(c.PenaltyAssessed !== undefined &&
        !Number.isNaN(Number(c.PenaltyAssessed)) && {
          penaltyAssessedInDollars: Number(c.PenaltyAssessed),
        }),
      ...(c.SettlementDate && { settlementDate: String(c.SettlementDate) }),
      ...(c.FiledDate && { filedDate: String(c.FiledDate) }),
      ...(c.State && { state: String(c.State) }),
    }));

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
