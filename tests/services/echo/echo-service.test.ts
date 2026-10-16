/**
 * @fileoverview Tests for EchoService — verifies the ECHO REST requests the service builds and
 * how it normalizes the responses, with `fetch` stubbed at the HTTP boundary. Guards the
 * proximity-search param key (p_radius, not p_radius_mi), the get_dfr facility lookup (#10),
 * the two-step case search (#11), the facility profile built from one get_dfr body plus the
 * best-effort p_frs status row (#31, #36, #37), ECHO's in-band error classification (#35), and
 * the one deadline each search shares across its requests, retries, and backoffs (#42).
 * The tool tests stub getEchoService() wholesale, so the built requests and raw-field mapping
 * are only observable here.
 * @module tests/services/echo/echo-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  createMockContext,
  getEnrichment,
  type MockContextLogger,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EchoService } from '@/services/echo/echo-service.js';
import {
  CASE_INFO_WA_2024_CIVIL,
  CASE_PAGE_WA_2024_CIVIL,
  DFR_BOEING_110017848105,
  DFR_EIS_ONLY_110000897646,
  DFR_RCRA_ONLY_110005318012,
  DFR_RMP_ONLY_110000536661,
  DFR_THREE_TRI_IDS_110015969941,
  DFR_USNR_110070322017,
  FACILITY_INFO_BOEING_110017848105,
  FACILITY_INFO_RCRA_ONLY_110005318012,
  FACILITY_INFO_USNR_110070322017,
  FACILITY_SEARCH_AIR_98108,
  FACILITY_SEARCH_AIR_98108_PAGE,
  FACILITY_SEARCH_SDWA_98108_INLINE,
  INVALID_ID_110000350509,
  QUERY_ID_NOT_FOUND,
} from './echo-fixtures.js';

/** Minimal get_facility_info payload — the service reads Results.Facilities + Results.TotalCount. */
const facilityResponse = {
  Results: {
    Facilities: [{ RegistryID: '110000350509', FacName: 'BOEING COMMERCIAL AIRPLANES' }],
    TotalCount: '1',
  },
};

/** The ECHO endpoint a request URL targets (its last path segment). */
const endpointOf = (url: URL) => url.pathname.split('/').pop();

/**
 * ECHO echoes the parameters it honors in `Results.QueryParameters` on its search endpoints.
 * A stubbed search answer that sets no QueryParameters echoes every parameter sent, as ECHO
 * does for a request whose filters it all honors.
 */
function withEcho(url: URL, body: unknown): unknown {
  const results = (body as { Results?: Record<string, unknown> } | undefined)?.Results;
  if (!/get_(facility|case)_info$/.test(url.pathname) || !results || results.QueryParameters) {
    return body;
  }
  const echoed = [...url.searchParams].map(([QP, QV]) => ({ QP, QV }));
  return { ...(body as object), Results: { ...results, QueryParameters: echoed } };
}

/** Stub the global fetch, capturing every requested URL and answering with `respond(url)`. */
function stubFetch(respond: (url: URL) => unknown): URL[] {
  const urls: URL[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = new URL(String(input));
    urls.push(url);
    return Promise.resolve(
      new Response(JSON.stringify(withEcho(url, respond(url))), { status: 200 }),
    );
  });
  return urls;
}

/** The `qcolumns` the facility search requests: the ECHO columns its rows map. */
const SEARCH_QCOLUMNS = '1,2,3,4,5,6,7,19,20,28,38,43,62,70,83,93,100,101,102,103';

/** The package identity the framework reads from package.json into AppConfig.pkg. */
const PACKAGE = { name: '@cyanheads/epa-mcp-server', version: '9.8.7' };

const newService = () => new EchoService({ pkg: PACKAGE } as AppConfig, {} as StorageService);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EchoService request identity', () => {
  it('sends a User-Agent naming the package and its version from config', async () => {
    const userAgents: Array<string | null> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      userAgents.push(new Headers(init?.headers).get('User-Agent'));
      return Promise.resolve(
        new Response(JSON.stringify(withEcho(new URL(String(input)), facilityResponse)), {
          status: 200,
        }),
      );
    });

    await newService().searchFacilities({ zipCode: '98108' }, createMockContext());

    expect(userAgents).toEqual(['@cyanheads/epa-mcp-server/9.8.7']);
  });
});

describe('EchoService.searchFacilities', () => {
  let service: EchoService;

  beforeEach(() => {
    // The constructor ignores config/storage and reads only getServerConfig().echoBaseUrl,
    // which defaults to the public ECHO host when the env var is unset.
    service = newService();
  });

  it('builds the proximity query with p_radius (not p_radius_mi)', async () => {
    const urls = stubFetch(() => facilityResponse);

    await service.searchFacilities(
      { latitude: 47.917, longitude: -122.248, radiusMiles: 10 },
      createMockContext(),
    );

    expect(urls).toHaveLength(1);
    const params = urls[0]!.searchParams;
    expect(endpointOf(urls[0]!)).toBe('echo_rest_services.get_facility_info');
    expect(params.get('p_radius')).toBe('10');
    expect(params.has('p_radius_mi')).toBe(false);
    expect(params.get('p_lat')).toBe('47.917');
    expect(params.get('p_long')).toBe('-122.248');
  });

  it('logs endpoint labels for discovery and pages without request URLs', async () => {
    const urls = stubFetch((url) => {
      const discovery = /get_(facility|case)_info$/.test(url.pathname);
      return {
        Results: discovery
          ? { QueryID: '841', QueryRows: '1' }
          : { ...facilityResponse.Results, Cases: [{ CaseNumber: 'CASE-1' }] },
      };
    });
    const ctx = createMockContext();
    await service.searchFacilities({ state: 'WA' }, ctx);
    await service.searchViolations({ state: 'WA' }, ctx);

    const calls = (ctx.log as MockContextLogger).calls;
    const logs = JSON.stringify(calls);
    expect(urls).toHaveLength(4);
    for (const url of urls) {
      expect(logs).not.toContain(url.toString());
      expect(logs).not.toContain(url.search.slice(1));
    }
    const logData = calls.map((call) => call.data as { endpoint?: string; queryId?: string });
    expect(logData.map((data) => data.endpoint)).toEqual([
      'echo_rest_services.get_facility_info',
      'echo_rest_services.get_qid',
      'case_rest_services.get_case_info',
      'case_rest_services.get_qid',
    ]);
    const pageLogs = logData.filter((data) => data.endpoint?.endsWith('.get_qid'));
    expect(pageLogs.map((data) => data.queryId)).toEqual(['841', '841']);
  });

  it('forwards latitude/longitude of 0 alongside p_radius', async () => {
    const urls = stubFetch(() => facilityResponse);

    await service.searchFacilities(
      { latitude: 0, longitude: 0, radiusMiles: 25 },
      createMockContext(),
    );

    const params = urls[0]!.searchParams;
    expect(params.get('p_lat')).toBe('0');
    expect(params.get('p_long')).toBe('0');
    expect(params.get('p_radius')).toBe('25');
    expect(params.has('p_radius_mi')).toBe(false);
  });

  it('regression #38: builds geographic queries with p_st and p_ct, no radius param', async () => {
    const urls = stubFetch(() => facilityResponse);

    await service.searchFacilities(
      { zipCode: '98204', state: 'WA', city: 'EVERETT' },
      createMockContext(),
    );

    const params = urls[0]!.searchParams;
    expect(params.get('p_zip')).toBe('98204');
    expect(params.get('p_st')).toBe('WA');
    expect(params.get('p_ct')).toBe('EVERETT');
    expect(params.has('p_state')).toBe(false);
    expect(params.has('p_city')).toBe(false);
    expect(params.has('p_radius')).toBe(false);
    expect(params.has('p_lat')).toBe(false);
    expect(params.has('p_long')).toBe(false);
  });

  it('regression #38: has_violation sends p_cs=3 and active_only p_act=Y', async () => {
    const urls = stubFetch(() => facilityResponse);

    await service.searchFacilities(
      { zipCode: '98108', hasViolation: true, activeOnly: true },
      createMockContext(),
    );

    const params = urls[0]!.searchParams;
    expect(params.get('p_cs')).toBe('3');
    expect(params.get('p_act')).toBe('Y');
    expect(params.has('p_sv_flag')).toBe(false);
  });

  it.each([
    ['CAA', 'A'],
    ['CWA', 'W'],
    ['RCRA', 'R'],
    ['TRI', 'T'],
    ['SDWA', 'S'],
  ] as const)(
    'regression #38: program %s sends ECHO media code p_med=%s',
    async (program, code) => {
      const urls = stubFetch(() => facilityResponse);

      await service.searchFacilities({ zipCode: '98108', program }, createMockContext());

      expect(urls[0]!.searchParams.get('p_med')).toBe(code);
      expect(urls[0]!.searchParams.has('p_naa')).toBe(false);
    },
  );

  it('sends no p_cs, p_med, or p_act without those filters', async () => {
    const urls = stubFetch(() => facilityResponse);

    await service.searchFacilities({ zipCode: '98108' }, createMockContext());

    const keys = [...urls[0]!.searchParams.keys()].sort();
    expect(keys).toEqual(['output', 'p_zip', 'qcolumns', 'responseset']);
  });

  it('regression #38: maps rows from the columns it requests on both requests', async () => {
    const urls = stubFetch((url) =>
      endpointOf(url) === 'echo_rest_services.get_facility_info'
        ? FACILITY_SEARCH_AIR_98108
        : FACILITY_SEARCH_AIR_98108_PAGE,
    );

    const result = await service.searchFacilities(
      { zipCode: '98108', program: 'CAA', limit: 3 },
      createMockContext(),
    );

    expect(urls.map(endpointOf)).toEqual([
      'echo_rest_services.get_facility_info',
      'echo_rest_services.get_qid',
    ]);
    expect(urls.map((url) => url.searchParams.get('qcolumns'))).toEqual([
      SEARCH_QCOLUMNS,
      SEARCH_QCOLUMNS,
    ]);
    expect(result.totalCount).toBe(26);
    expect(result.facilities).toEqual([
      {
        registryId: '110000489481',
        name: 'ACE GALVANIZING INC 96TH',
        street: '429 S 96TH',
        city: 'SEATTLE',
        state: 'WA',
        zip: '98108',
        county: 'KING',
        fipsCode: '53033',
        latitude: 47.516933,
        longitude: -122.328652,
        complianceStatus: 'Violation Identified',
        programs: { air: true, water: true, rcra: true, tri: true, sdwa: false },
        triReleasesTransfersInLbs: 178807,
        inspectionCount: 5,
        totalPenaltiesInDollars: 0,
      },
      {
        registryId: '110001916927',
        name: 'AERO LAC INC',
        street: '420 S 96TH ST',
        city: 'SEATTLE',
        state: 'WA',
        zip: '98108',
        county: 'KING',
        fipsCode: '53033',
        latitude: 47.51832,
        longitude: -122.327944,
        complianceStatus: 'No Violation Identified',
        programs: { air: true, water: false, rcra: true, tri: false, sdwa: false },
        inspectionCount: 1,
        totalPenaltiesInDollars: 0,
      },
      {
        registryId: '110000489579',
        name: 'ART BRASS PLATING INC SEATTLE',
        street: '5516 3RD AVE S',
        city: 'SEATTLE',
        state: 'WA',
        zip: '98108',
        county: 'KING',
        fipsCode: '53033',
        latitude: 47.552916,
        longitude: -122.330352,
        complianceStatus: 'No Violation Identified',
        programs: { air: true, water: false, rcra: true, tri: true, sdwa: false },
        inspectionCount: 7,
        totalPenaltiesInDollars: 5000,
      },
    ]);
  });

  it('regression #38: reads a one-row match ECHO returns inline without paging', async () => {
    const urls = stubFetch(() => FACILITY_SEARCH_SDWA_98108_INLINE);

    const result = await service.searchFacilities(
      { zipCode: '98108', program: 'SDWA', limit: 3 },
      createMockContext(),
    );

    expect(urls).toHaveLength(1);
    expect(result.totalCount).toBe(1);
    expect(result.facilities).toEqual([
      expect.objectContaining({
        registryId: '110052458023',
        programs: { air: false, water: false, rcra: false, tri: false, sdwa: true },
        latitude: 47.56249,
        longitude: -122.32412,
      }),
    ]);
  });

  it('returns an empty page without paging when nothing matches', async () => {
    const urls = stubFetch(() => ({
      Results: { Message: 'Success', QueryID: '779', QueryRows: '0' },
    }));

    const result = await service.searchFacilities(
      { zipCode: '98108', hasViolation: true, program: 'SDWA' },
      createMockContext(),
    );

    expect(urls).toHaveLength(1);
    expect(result).toEqual({ facilities: [], totalCount: 0 });
  });

  it('regression #38: fails without paging when ECHO drops a sent filter', async () => {
    // ECHO answers an unrecognized parameter by leaving it out of QueryParameters.
    const urls = stubFetch(() => ({
      Results: {
        Message: 'Success',
        QueryID: '87',
        QueryRows: '101808',
        QueryParameters: [
          { QP: 'output', QV: 'JSON' },
          { QP: 'p_st', QV: 'WA' },
          { QP: 'responseset', QV: '50' },
        ],
      },
    }));

    const error = await service
      .searchFacilities({ state: 'WA', city: 'SEATTLE' }, createMockContext())
      .catch((e: unknown) => e);

    expect(urls).toHaveLength(1);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: expect.stringContaining('p_ct'),
      data: { droppedParameters: ['p_ct'], retryable: false },
    });
  });

  it('pages through a bounded response set and preserves the full match count', async () => {
    const urls = stubFetch((url) =>
      endpointOf(url) === 'echo_rest_services.get_facility_info'
        ? { Results: { QueryID: '841', QueryRows: '330' } }
        : {
            Results: {
              Facilities: [
                { RegistryID: '110005351555', FacName: 'First facility' },
                { RegistryID: '110005351556', FacName: 'Second facility' },
              ],
              QueryRows: '330',
              PageNo: '1',
            },
          },
    );

    const result = await service.searchFacilities(
      { zipCode: '98101', limit: 1 },
      createMockContext(),
    );

    expect(result.facilities).toEqual([
      expect.objectContaining({ registryId: '110005351555', name: 'First facility' }),
    ]);
    expect(result.totalCount).toBe(330);
    expect(urls).toHaveLength(2);
    expect(urls[0]!.searchParams.get('responseset')).toBe('1');
    expect(urls[0]!.searchParams.has('p_limit')).toBe(false);
    expect(endpointOf(urls[1]!)).toBe('echo_rest_services.get_qid');
    expect(urls[1]!.searchParams.get('qid')).toBe('841');
    expect(urls[1]!.searchParams.get('pageno')).toBe('1');
  });
});

describe('EchoService.getFacility', () => {
  it('regression #10: looks the Registry ID up through get_dfr, never get_facility_info p_id', async () => {
    const urls = stubFetch((url) =>
      endpointOf(url) === 'dfr_rest_services.get_dfr'
        ? {
            Results: {
              RegistryID: '110005351555',
              Permits: [
                { EPASystem: 'FRS', FacilityName: 'NUMERIC ID FACILITY', FacilityState: 'WA' },
                { EPASystem: 'ICIS-Air', Statute: 'CAA' },
              ],
            },
          }
        : {},
    );

    const profile = await newService().getFacility('110005351555', createMockContext());

    expect(endpointOf(urls[0]!)).toBe('dfr_rest_services.get_dfr');
    expect(urls[0]!.searchParams.get('p_id')).toBe('110005351555');
    // get_facility_info takes program IDs in p_id; the status lookup (#36) uses p_frs.
    const facilityInfo = urls.filter(
      (url) => endpointOf(url) === 'echo_rest_services.get_facility_info',
    );
    expect(facilityInfo.map((url) => url.searchParams.has('p_id'))).toEqual([false]);
    expect(profile).toMatchObject({
      registryId: '110005351555',
      name: 'NUMERIC ID FACILITY',
      state: 'WA',
      programs: { air: true, water: false, rcra: false, tri: false, sdwa: false },
    });
  });

  it('reads name, address, and coordinates from the FRS permit record, else SpatialMetadata', async () => {
    // The FRS record and SpatialMetadata carry the same coordinates, so each case removes one.
    const { SpatialMetadata: _spatial, ...withoutSpatial } = DFR_BOEING_110017848105.Results;
    stubFetch((url) =>
      endpointOf(url) === 'dfr_rest_services.get_dfr' ? { Results: withoutSpatial } : {},
    );

    const profile = await newService().getFacility('110017848105', createMockContext());

    expect(profile).toMatchObject({
      registryId: '110017848105',
      name: 'BOEING NORTH BOEING FIELD',
      street: '7500 E MARGINAL WAY S',
      city: 'SEATTLE',
      state: 'WA',
      zip: '98108',
      latitude: 47.531169,
      longitude: -122.310812,
    });

    vi.restoreAllMocks();
    const frsWithoutCoordinates = {
      Results: {
        ...DFR_BOEING_110017848105.Results,
        Permits: DFR_BOEING_110017848105.Results.Permits.map((permit) =>
          permit.EPASystem === 'FRS' ? { ...permit, Latitude: null, Longitude: null } : permit,
        ),
      },
    };
    stubFetch((url) =>
      endpointOf(url) === 'dfr_rest_services.get_dfr' ? frsWithoutCoordinates : {},
    );

    const fallback = await newService().getFacility('110017848105', createMockContext());

    expect(fallback).toMatchObject({ latitude: 47.531169, longitude: -122.310812 });
  });

  it('resolves a TRI facility ID passed as p_id to its Registry ID', async () => {
    const urls = stubFetch((url) =>
      endpointOf(url) === 'dfr_rest_services.get_dfr' ? DFR_USNR_110070322017 : {},
    );

    const profile = await newService().getFacility('9867WSNRWD1981S', createMockContext());

    expect(urls[0]!.searchParams.get('p_id')).toBe('9867WSNRWD1981S');
    expect(profile).toMatchObject({ registryId: '110070322017', name: 'USNR WOODLAND DIVISION' });
  });
});

describe('EchoService.fetchJson retry classification', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Runs `call` to completion under fake timers, returning its rejection. */
  async function settle(call: Promise<unknown>): Promise<unknown> {
    const outcome = call.then(
      () => {
        throw new Error('expected a rejection');
      },
      (error: unknown) => error,
    );
    await vi.runAllTimersAsync();
    return outcome;
  }

  it('retries an unrecognized ErrorMessage body four times as ServiceUnavailable', async () => {
    const urls = stubFetch(() => ({ Results: { Error: { ErrorMessage: 'Unavailable' } } }));

    const error = await settle(
      newService().searchFacilities({ zipCode: '98108' }, createMockContext()),
    );

    expect(urls).toHaveLength(4);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'ECHO API error: Unavailable (failed after 4 attempts)',
    });
  });

  it('retries an HTTP 503 four times', async () => {
    const urls: URL[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      urls.push(new URL(String(input)));
      return Promise.resolve(new Response('Service Unavailable', { status: 503 }));
    });

    const error = await settle(newService().getFacility('110017848105', createMockContext()));

    expect(urls.map(endpointOf)).toEqual(Array(4).fill('dfr_rest_services.get_dfr'));
    expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
  });

  it('regression #35: an invalid-ID body fails after one request as facility_not_found', async () => {
    const urls = stubFetch(() => INVALID_ID_110000350509);

    const error = await settle(newService().getFacility('110000350509', createMockContext()));

    expect(urls).toHaveLength(1);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: 'No facility found for Registry ID "110000350509".',
      data: { reason: 'facility_not_found', registryId: '110000350509' },
    });
  });

  it('classifies an invalid-ID message spanning a line break, after one request', async () => {
    // Live, 2026-10-16, ECHO drops a newline from the p_id it echoes; the match must not rely on it.
    const urls = stubFetch(() => ({
      Results: { Error: { ErrorMessage: 'ID 110000\n350509 is invalid.' } },
    }));

    const error = await settle(newService().getFacility('110000\n350509', createMockContext()));

    expect(urls).toHaveLength(1);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'facility_not_found' },
    });
  });

  it('regression #35: a get_dfr body without a RegistryID fails after one request as facility_not_found', async () => {
    const urls = stubFetch(() => ({ Results: { Message: 'Success' } }));

    const error = await settle(newService().getFacility('ABCXYZ', createMockContext()));

    expect(urls).toHaveLength(1);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'facility_not_found', registryId: 'ABCXYZ' },
    });
  });

  it('regression #35: a QueryID-not-found body is not retried', async () => {
    const urls = stubFetch((url) =>
      endpointOf(url) === 'case_rest_services.get_case_info'
        ? { Results: { QueryID: '999999999', QueryRows: '3' } }
        : QUERY_ID_NOT_FOUND,
    );

    const error = await settle(newService().searchViolations({ state: 'WA' }, createMockContext()));

    expect(urls.map(endpointOf)).toEqual([
      'case_rest_services.get_case_info',
      'case_rest_services.get_qid',
    ]);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'ECHO API error: QueryID 999999999 not found in ECHO.',
      data: { retryable: false },
    });
  });
});

/** Answers get_dfr with `dfr` and the p_frs facility lookup with `info`; anything else gets `{}`. */
function stubFacility(dfr: unknown, info: unknown = { Results: { Facilities: [] } }): URL[] {
  return stubFetch((url) => {
    const endpoint = endpointOf(url);
    if (endpoint === 'dfr_rest_services.get_dfr') return dfr;
    if (endpoint === 'echo_rest_services.get_facility_info') return info;
    return {};
  });
}

describe('EchoService.getFacility profile from one get_dfr body', () => {
  it('regression #37: requests only get_dfr and the p_frs lookup for the resolved Registry ID', async () => {
    const urls = stubFacility(DFR_USNR_110070322017, FACILITY_INFO_USNR_110070322017);

    await newService().getFacility('9867WSNRWD1981S', createMockContext());

    expect(urls.map(endpointOf)).toEqual([
      'dfr_rest_services.get_dfr',
      'echo_rest_services.get_facility_info',
    ]);
    expect(urls[1]!.searchParams.get('p_frs')).toBe('110070322017');
    expect([...urls[1]!.searchParams.keys()].sort()).toEqual(['output', 'p_frs']);
  });

  it('regression #37: maps per-program summaries, inspections, and formal actions from get_dfr', async () => {
    stubFacility(DFR_BOEING_110017848105, FACILITY_INFO_BOEING_110017848105);

    const profile = await newService().getFacility('110017848105', createMockContext());

    expect(profile.programCompliance).toEqual([
      {
        statute: 'CAA',
        currentStatus: 'No Violation Identified',
        quartersInNoncompliance: 0,
        quartersInSignificantNoncompliance: 0,
        inspections: 5,
        lastInspectionDate: '07/08/2026',
        informalActions: 7,
        formalActions: 2,
        totalPenaltiesInDollars: 1750,
        threeYearPeriodStart: '10/01/2023',
        fiveYearPeriodStart: '10/10/2021',
        periodEnd: '09/30/2026',
      },
      {
        statute: 'CWA',
        currentStatus: 'Significant/Category I Noncompliance',
        quartersInNoncompliance: 12,
        quartersInSignificantNoncompliance: 5,
        inspections: 4,
        lastInspectionDate: '09/03/2025',
        formalActions: 2,
        totalPenaltiesInDollars: 0,
        threeYearPeriodStart: '07/01/2023',
        fiveYearPeriodStart: '10/10/2021',
        periodEnd: '06/30/2026',
      },
      {
        statute: 'RCRA',
        currentStatus: 'No Violation Identified',
        quartersInNoncompliance: 2,
        quartersInSignificantNoncompliance: 0,
        inspections: 2,
        lastInspectionDate: '03/27/2025',
        informalActions: 3,
        threeYearPeriodStart: '10/01/2023',
        fiveYearPeriodStart: '10/10/2021',
        periodEnd: '09/30/2026',
      },
    ]);

    // Newest first across statutes; the RCRA rows carry ECHO's finding text.
    expect(profile.inspections.map((i) => `${i.activityDate} ${i.statute}`)).toEqual([
      '07/15/2026 CAA',
      '07/08/2026 CAA',
      '09/03/2025 CWA',
      '03/27/2025 RCRA',
      '03/27/2024 RCRA',
      '08/29/2023 CWA',
    ]);
    expect(profile.inspections[3]).toEqual({
      activityType: 'Compliance Evaluation Inspection',
      activityDate: '03/27/2025',
      description: 'Violations Or Compliance Issues Were Found',
      statute: 'RCRA',
      sourceId: 'WAD009256819',
      leadAgency: 'State',
    });

    expect(profile.formalActions).toEqual([
      {
        caseId: 'WA-794715',
        settlementDate: '06/08/2026',
        penaltyAssessedInDollars: 0,
        actionType: 'State CWA Non Penalty AO',
        actionDate: '06/08/2026',
        statute: 'CWA',
        sourceId: 'WAR315626',
        leadAgency: 'State',
      },
      {
        caseId: 'WA-793990',
        settlementDate: '04/23/2025',
        penaltyAssessedInDollars: 0,
        actionType: 'State CWA Non Penalty AO',
        actionDate: '04/23/2025',
        statute: 'CWA',
        sourceId: 'WAR314396',
        leadAgency: 'State',
      },
      {
        caseId: 'WAPSCAF000000000000000416',
        settlementDate: '06/16/2022',
        penaltyAssessedInDollars: 1000,
        actionType: 'Administrative Order',
        actionDate: '06/16/2022',
        statute: 'CAA',
        sourceId: 'WAPSC0005303321147',
        leadAgency: 'Local',
      },
      {
        caseId: 'WAPSCAF000000000000000400',
        settlementDate: '02/14/2022',
        penaltyAssessedInDollars: 750,
        actionType: 'Administrative Order',
        actionDate: '02/14/2022',
        statute: 'CAA',
        sourceId: 'WAPSC0005303321147',
        leadAgency: 'Local',
      },
    ]);

    // Three ICIS-Air sources and eleven NPDES permits: one status per program, no single ID.
    expect(profile.airCompliance).toEqual({
      status: 'No Violation Identified',
      statusDate: '09/30/2026',
    });
    expect(profile.waterCompliance).toEqual({ status: 'Significant/Category I Noncompliance' });
    expect(profile.compliance).toEqual({ quartersInViolation: 12 });
  });

  it('regression #37: names the program ID and permit when the facility has exactly one', async () => {
    stubFacility(DFR_THREE_TRI_IDS_110015969941);

    const profile = await newService().getFacility('110015969941', createMockContext());

    expect(profile.airCompliance).toEqual({
      programId: 'WAPSC0005303300006',
      status: 'No Violation Identified',
      statusDate: '09/30/2026',
    });
    expect(profile.waterCompliance).toEqual({
      status: 'Violation Identified',
      permitId: 'WA0031305',
    });
  });

  it('regression #37: joins RCRA formal actions to their settlements without a case ID', async () => {
    stubFacility(DFR_RCRA_ONLY_110005318012, FACILITY_INFO_RCRA_ONLY_110005318012);

    const profile = await newService().getFacility('110005318012', createMockContext());

    expect(profile.formalActions).toEqual([
      {
        settlementDate: '02/12/2026',
        actionType: 'FINAL PENALTY',
        actionDate: '02/12/2026',
        statute: 'RCRA',
        sourceId: 'WAD027470111',
        leadAgency: 'State',
      },
      {
        settlementDate: '08/18/2025',
        actionType: 'INITIAL 3008(A) COMPLIANCE',
        actionDate: '08/18/2025',
        statute: 'RCRA',
        sourceId: 'WAD027470111',
        leadAgency: 'State',
      },
    ]);
    expect(profile.inspections).toHaveLength(4);
    expect(profile.inspections[0]).toMatchObject({
      activityType: 'Non-Financial Record Review',
      activityDate: '10/22/2025',
    });
  });

  it('joins a case whose issue date is the 01/01/0001 placeholder, and same-day cases by penalty', async () => {
    // Values from get_dfr?p_id=110000502901; cases listed in the reverse of their actions' order.
    const action = (ActionDate: string, PenaltyAmount: string) => ({
      Statute: 'CAA',
      SourceID: 'TX0000004820100027',
      ActionType: 'Administrative Order',
      LeadAgency: 'State',
      ActionDate,
      PenaltyAmount,
    });
    const settled = (
      CaseID: string,
      IssueDate: string,
      SettlementDate: string,
      penalty: string,
    ) => ({
      StatuteCode: 'CAA',
      SourceID: 'AIR/TX0000004820100027',
      CaseID,
      IssueDate,
      Settlements: {
        Settlement: [{ SettlementDate, FederalPenalty: '$0', StateLocalPenalty: penalty }],
      },
    });
    stubFacility({
      Results: {
        RegistryID: '110000502901',
        Permits: [{ EPASystem: 'FRS', FacilityName: 'EXXONMOBIL BAYTOWN REFINERY' }],
        FormalActions: {
          Action: [
            action('06/23/2026', '$25,000'),
            action('06/17/2022', '$26,250'),
            action('06/17/2022', '$50,000'),
          ],
        },
        CaseFormalActions: {
          Action: [
            settled('TX000A100602172021216', '06/17/2022', '06/17/2022', '$50,000'),
            settled('TX000A777606642020059', '06/17/2022', '06/17/2022', '$26,250'),
            settled('TX000A231311392025258', '01/01/0001', '06/23/2026', '$25,000'),
          ],
        },
      },
    });

    const profile = await newService().getFacility('110000502901', createMockContext());

    expect(
      profile.formalActions.map((a) => [a.actionDate, a.penaltyAssessedInDollars, a.caseId]),
    ).toEqual([
      ['06/23/2026', 25000, 'TX000A231311392025258'],
      ['06/17/2022', 26250, 'TX000A777606642020059'],
      ['06/17/2022', 50000, 'TX000A100602172021216'],
    ]);
  });

  it('keeps the newest 100 compliance monitoring records and counts them all', async () => {
    const Inspection = Array.from({ length: 150 }, (_, i) => ({
      Statute: 'CAA',
      SourceID: 'TX0000004824500018',
      ActivityType: i === 0 ? 'Information Request' : 'Compliance Investigation',
      InspectionType: i === 0 ? 'Formal' : 'Investigation',
      LeadAgency: 'State',
      Date: `01/${String((i % 28) + 1).padStart(2, '0')}/${2022 + Math.floor(i / 28)}`,
    }));
    stubFacility({
      Results: {
        RegistryID: '110041990913',
        Permits: [{ EPASystem: 'FRS', FacilityName: 'EXXONMOBIL BEAUMONT REFINERY' }],
        ComplianceHistory: { Inspection },
      },
    });

    const profile = await newService().getFacility('110041990913', createMockContext());

    expect(profile.inspectionsTotal).toBe(150);
    expect(profile.inspections).toHaveLength(100);
    expect(profile.inspections[0]!.activityDate).toBe('01/10/2027');
    expect(profile.inspections.at(-1)!.activityDate).toBe('01/23/2023');
    expect(profile.inspections).not.toContainEqual(
      expect.objectContaining({ category: 'Information Request' }),
    );
    expect(profile.inspections[0]).toMatchObject({
      category: 'Compliance Investigation',
      activityType: 'Investigation',
    });
  });

  it('regression #36: keys program flags on Permits[].EPASystem', async () => {
    stubFacility(DFR_BOEING_110017848105);
    const boeing = await newService().getFacility('110017848105', createMockContext());
    expect(boeing.programs).toEqual({ air: true, water: true, rcra: true, tri: true, sdwa: false });

    vi.restoreAllMocks();
    stubFacility(DFR_EIS_ONLY_110000897646);
    const eisOnly = await newService().getFacility('110000897646', createMockContext());
    expect(eisOnly.programs.air).toBe(false);
    expect(eisOnly.airCompliance).toBeUndefined();

    vi.restoreAllMocks();
    stubFacility(DFR_RMP_ONLY_110000536661);
    const rmpOnly = await newService().getFacility('110000536661', createMockContext());
    expect(rmpOnly.programs.air).toBe(false);

    vi.restoreAllMocks();
    stubFacility({
      Results: {
        RegistryID: '110000000001',
        Permits: [
          { EPASystem: 'FRS', FacilityName: 'WATER SYSTEM' },
          { EPASystem: 'SDWIS', Statute: 'SDWA', SourceID: 'WA5300000' },
        ],
      },
    });
    const sdwis = await newService().getFacility('110000000001', createMockContext());
    expect(sdwis.programs).toEqual({
      air: false,
      water: false,
      rcra: false,
      tri: false,
      sdwa: true,
    });
  });

  it('regression #36: sets the TRI total and year from the latest TRIHistory year', async () => {
    stubFacility(DFR_USNR_110070322017, FACILITY_INFO_USNR_110070322017);

    const profile = await newService().getFacility('110070322017', createMockContext());

    expect(profile).toMatchObject({
      programs: { tri: true },
      triReleasesTransfersInLbs: 75223,
      triReleasesTransfersYear: 2024,
    });
    // The p_frs row exists but ECHO assigns a TRI-only facility no compliance status.
    expect(profile).not.toHaveProperty('complianceStatus');
    expect(profile).not.toHaveProperty('compliance');
  });

  it('regression #36: sums TRIHistory rows that share the latest year', async () => {
    const [source] = DFR_USNR_110070322017.Results.TRIHistory.Sources;
    const secondOperator = {
      ReleaseYear: source!.ReleaseYear.map((row) => ({
        ...row,
        SourceID: '9867WSPRTR1981S',
        TotalReleasesTransfers: '1,000',
      })),
    };
    stubFacility({
      Results: {
        ...DFR_USNR_110070322017.Results,
        TRIHistory: { Sources: [source, secondOperator] },
      },
    });

    const profile = await newService().getFacility('110070322017', createMockContext());

    expect(profile.triReleasesTransfersInLbs).toBe(76223);
    expect(profile.triReleasesTransfersYear).toBe(2024);
  });

  it('regression #36: sets complianceStatus from the p_frs row; RCRA-only carries no TRI data', async () => {
    stubFacility(DFR_RCRA_ONLY_110005318012, FACILITY_INFO_RCRA_ONLY_110005318012);

    const profile = await newService().getFacility('110005318012', createMockContext());

    expect(profile.complianceStatus).toBe('Significant Violation');
    expect(profile.compliance).toEqual({ quartersInViolation: 7 });
    expect(profile.programs.tri).toBe(false);
    expect(profile).not.toHaveProperty('triReleasesTransfersInLbs');
    expect(profile).not.toHaveProperty('triReleasesTransfersYear');
  });

  it('regression #40: sets county and fipsCode from the first Permits[] entry that carries them', async () => {
    // The FRS entry carries null for both; ICIS, TRI, and RCRAInfo entries carry them.
    stubFacility(DFR_BOEING_110017848105, FACILITY_INFO_BOEING_110017848105);
    const boeing = await newService().getFacility('110017848105', createMockContext());
    expect(boeing).toMatchObject({ county: 'King County', fipsCode: '53033' });

    vi.restoreAllMocks();
    // The p_frs row has no county for this TRI-only facility; its TRI entry does.
    stubFacility(DFR_USNR_110070322017, FACILITY_INFO_USNR_110070322017);
    const usnr = await newService().getFacility('110070322017', createMockContext());
    expect(usnr).toMatchObject({ county: 'Cowlitz County', fipsCode: '53015' });

    vi.restoreAllMocks();
    // Same values whether or not the best-effort p_frs lookup succeeds.
    stubFacility(DFR_RCRA_ONLY_110005318012);
    const withoutStatusRow = await newService().getFacility('110005318012', createMockContext());
    expect(withoutStatusRow).toMatchObject({ county: 'King County', fipsCode: '53033' });
  });

  it('regression #40: falls back to the p_frs row when no Permits[] entry carries them', async () => {
    stubFacility(DFR_EIS_ONLY_110000897646, {
      Results: {
        Facilities: [
          {
            RegistryID: '110000897646',
            FacCounty: 'KING',
            FacFIPSCode: null,
            FacDerivedStctyFIPS: '53033',
          },
        ],
      },
    });
    const profile = await newService().getFacility('110000897646', createMockContext());
    expect(profile).toMatchObject({ county: 'KING', fipsCode: '53033' });

    vi.restoreAllMocks();
    stubFacility(DFR_EIS_ONLY_110000897646);
    const none = await newService().getFacility('110000897646', createMockContext());
    expect(none).not.toHaveProperty('county');
    expect(none).not.toHaveProperty('fipsCode');
  });

  it('regression #31: lists TRI facility IDs most recently reported first', async () => {
    stubFacility(DFR_THREE_TRI_IDS_110015969941);
    const multi = await newService().getFacility('110015969941', createMockContext());
    expect(multi.triFacilityIds).toEqual(['98106SLMNB2424S', '98106HCKTT2424S', '98106STTLS2414S']);
    expect(multi.programs.tri).toBe(true);

    vi.restoreAllMocks();
    stubFacility(DFR_USNR_110070322017);
    const single = await newService().getFacility('110070322017', createMockContext());
    expect(single.triFacilityIds).toEqual(['9867WSNRWD1981S']);

    vi.restoreAllMocks();
    stubFacility(DFR_RCRA_ONLY_110005318012);
    const none = await newService().getFacility('110005318012', createMockContext());
    expect(none.triFacilityIds).toEqual([]);
    expect(none.programs.tri).toBe(false);
  });
});

describe('EchoService.getFacility best-effort compliance status lookup', () => {
  /** The disclosure a profile built without the p_frs row carries. */
  const STATUS_LOOKUP_NOTICE =
    "ECHO's facility search request failed, so this profile has no complianceStatus or compliance.quartersInViolation. Every other field comes from ECHO's detailed facility report; calling again may fill them.";

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('regression #36: a failing p_frs lookup is retried once, then the profile returns without it', async () => {
    const urls: URL[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = new URL(String(input));
      urls.push(url);
      return Promise.resolve(
        endpointOf(url) === 'dfr_rest_services.get_dfr'
          ? new Response(JSON.stringify(DFR_BOEING_110017848105), { status: 200 })
          : new Response('We could not process your query', { status: 500 }),
      );
    });
    const ctx = createMockContext();

    const pending = newService().getFacility('110017848105', ctx);
    await vi.runAllTimersAsync();
    const profile = await pending;

    expect(urls.map(endpointOf)).toEqual([
      'dfr_rest_services.get_dfr',
      'echo_rest_services.get_facility_info',
      'echo_rest_services.get_facility_info',
    ]);
    expect(profile).toMatchObject({
      registryId: '110017848105',
      name: 'BOEING NORTH BOEING FIELD',
      programs: { air: true, water: true, rcra: true, tri: true, sdwa: false },
      triFacilityIds: ['98108THBNG7500E'],
    });
    expect(profile.programCompliance).toHaveLength(3);
    expect(profile).not.toHaveProperty('complianceStatus');
    expect(profile).not.toHaveProperty('compliance');
    expect(getEnrichment(ctx)).toEqual({ notice: STATUS_LOOKUP_NOTICE });
  });

  it('abandons a hung p_frs lookup at its deadline and returns the profile', async () => {
    const urls: URL[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = new URL(String(input));
      urls.push(url);
      if (endpointOf(url) === 'dfr_rest_services.get_dfr') {
        return Promise.resolve(new Response(JSON.stringify(DFR_BOEING_110017848105)));
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    });
    const ctx = createMockContext();

    const call = track(newService().getFacility('110017848105', ctx));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(call.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(call.error).toBeUndefined();
    const profile = call.value as { registryId: string };
    expect(urls.map(endpointOf)).toEqual([
      'dfr_rest_services.get_dfr',
      'echo_rest_services.get_facility_info',
    ]);
    expect(profile.registryId).toBe('110017848105');
    expect(profile).not.toHaveProperty('complianceStatus');
    expect(getEnrichment(ctx)).toEqual({ notice: STATUS_LOOKUP_NOTICE });
  });

  it('gives the p_frs lookup a zero budget, never a negative timer, when get_dfr ends past 50 s', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (endpointOf(new URL(String(input))) === 'dfr_rest_services.get_dfr') {
        return answerAfter(49_990, init?.signal, () => {
          // Reading a very large report carries the call 40 ms past its 50 s budget.
          vi.setSystemTime(Date.now() + 40);
          return new Response(JSON.stringify(DFR_BOEING_110017848105));
        });
      }
      return hang(init?.signal);
    });
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const ctx = createMockContext();

    const call = track(newService().getFacility('110017848105', ctx));
    await vi.advanceTimersByTimeAsync(49_990);
    await vi.advanceTimersByTimeAsync(100);
    const negativeDelays = timers.mock.calls.flatMap(([, ms]) =>
      typeof ms === 'number' && ms < 0 ? [ms] : [],
    );
    timers.mockRestore();

    expect(negativeDelays).toEqual([]);
    expect(call.error).toBeUndefined();
    expect((call.value as { registryId: string }).registryId).toBe('110017848105');
    expect(getEnrichment(ctx)).toEqual({ notice: STATUS_LOOKUP_NOTICE });
  });

  it('propagates caller cancellation during the p_frs lookup instead of degrading', async () => {
    const controller = new AbortController();
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (endpointOf(new URL(String(input))) === 'dfr_rest_services.get_dfr') {
        return Promise.resolve(new Response(JSON.stringify(DFR_BOEING_110017848105)));
      }
      controller.abort(new DOMException('Client cancelled', 'AbortError'));
      return Promise.reject(init?.signal?.reason);
    });
    const ctx = createMockContext({ signal: controller.signal });

    const outcome = newService()
      .getFacility('110017848105', ctx)
      .then(
        () => 'resolved',
        (error: unknown) => error,
      );
    await vi.runAllTimersAsync();

    expect(await outcome).toMatchObject({ name: 'AbortError' });
    expect(getEnrichment(ctx)).not.toHaveProperty('notice');
  });
});

describe('EchoService.searchViolations', () => {
  it('uses ECHO response-set pagination and preserves the full match count', async () => {
    const urls = stubFetch((url) =>
      endpointOf(url) === 'case_rest_services.get_case_info'
        ? { Results: { QueryID: '328', QueryRows: '6166' } }
        : {
            Results: {
              Cases: [
                { CaseNumber: 'CASE-1', CaseName: 'First case' },
                { CaseNumber: 'CASE-2', CaseName: 'Second case' },
              ],
              PageNo: '1',
            },
          },
    );

    const result = await newService().searchViolations(
      { state: 'WA', limit: 1 },
      createMockContext(),
    );

    expect(result.cases).toEqual([{ caseId: 'CASE-1', caseName: 'First case' }]);
    expect(result.totalCount).toBe(6166);
    expect(urls[0]!.searchParams.get('responseset')).toBe('1');
    expect(urls[0]!.searchParams.has('p_limit')).toBe(false);
    expect(urls[1]!.searchParams.get('pageno')).toBe('1');
    expect(urls[1]!.searchParams.has('p_limit')).toBe(false);
  });

  it('regression #11: reads cases from get_qid using the QueryID from get_case_info', async () => {
    const urls = stubFetch((url) =>
      endpointOf(url) === 'case_rest_services.get_case_info'
        ? // get_case_info is a discovery endpoint: any Cases it carries are not the result set.
          { Results: { QueryID: '328', QueryRows: '1', Cases: [{ CaseNumber: 'DISCOVERY-ONLY' }] } }
        : { Results: { Cases: [{ CaseNumber: 'FROM-GET-QID' }] } },
    );

    const result = await newService().searchViolations({ state: 'WA' }, createMockContext());

    expect(urls.map(endpointOf)).toEqual([
      'case_rest_services.get_case_info',
      'case_rest_services.get_qid',
    ]);
    expect(urls[0]!.searchParams.get('p_state')).toBe('WA');
    expect(urls[1]!.searchParams.get('qid')).toBe('328');
    expect(result).toEqual({ cases: [{ caseId: 'FROM-GET-QID' }], totalCount: 1 });
  });

  it('regression #28: sends p_fac_zip and p_law, never p_zip or p_act', async () => {
    const urls = stubFetch(() => ({ Results: { QueryID: '466', QueryRows: '0' } }));

    await newService().searchViolations(
      { state: 'WA', zipCode: '98108', program: 'CERCLA' },
      createMockContext(),
    );

    const params = urls[0]!.searchParams;
    expect(params.get('p_state')).toBe('WA');
    expect(params.get('p_fac_zip')).toBe('98108');
    expect(params.get('p_law')).toBe('CERCLA');
    expect(params.has('p_zip')).toBe(false);
    expect(params.has('p_act')).toBe(false);
  });

  it.each([
    ['civil', 'CI'],
    ['criminal', 'CR'],
    ['all', null],
  ] as const)(
    'regression #28: case_type %s sends p_civil_criminal_indicator=%s',
    async (caseType, code) => {
      const urls = stubFetch(() => ({ Results: { QueryID: '447', QueryRows: '0' } }));

      await newService().searchViolations({ state: 'WA', caseType }, createMockContext());

      expect(urls[0]!.searchParams.get('p_civil_criminal_indicator')).toBe(code);
      expect(urls[0]!.searchParams.has('p_case_category')).toBe(false);
    },
  );

  describe('regression #28: filing-date bounds', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-16T12:00:00Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it.each([
      [
        'both bounds',
        { dateFiledStart: '2024-01-01', dateFiledEnd: '2024-12-31' },
        ['01/01/2024', '12/31/2024'],
      ],
      ['a start bound only', { dateFiledStart: '2024-01-01' }, ['01/01/2024', '10/16/2026']],
      ['an end bound only', { dateFiledEnd: '2023-12-31' }, ['01/01/1900', '12/31/2023']],
      [
        'a range reaching past 1900 and today',
        { dateFiledStart: '1850-01-01', dateFiledEnd: '2030-12-31' },
        ['01/01/1900', '10/16/2026'],
      ],
    ])('%s sends both MM/DD/YYYY ends and p_milestone', async (_label, dates, [from, to]) => {
      const urls = stubFetch(() => ({ Results: { QueryID: '410', QueryRows: '0' } }));

      await newService().searchViolations({ state: 'WA', ...dates }, createMockContext());

      const params = urls[0]!.searchParams;
      expect(params.get('p_from_date')).toBe(from);
      expect(params.get('p_to_date')).toBe(to);
      expect(params.get('p_milestone')).toBe('CMF,CPOA');
      expect(params.has('p_date_filed_from')).toBe(false);
      expect(params.has('p_date_filed_to')).toBe(false);
    });

    it('sends no date or milestone parameter without a date bound', async () => {
      const urls = stubFetch(() => ({ Results: { QueryID: '380', QueryRows: '0' } }));

      await newService().searchViolations({ state: 'WA' }, createMockContext());

      const params = urls[0]!.searchParams;
      expect(params.has('p_from_date')).toBe(false);
      expect(params.has('p_to_date')).toBe(false);
      expect(params.has('p_milestone')).toBe(false);
    });

    /**
     * Live, 2026-10-16: ECHO answers an inverted range (p_from_date 01/01/2030, p_to_date
     * 10/16/2026; or 01/01/1900 to 12/31/1899) with HTTP 200 and
     * `{"Results":{"Error":{"ErrorMessage":"From_date must be earlier than or equal to to_date."}}}`,
     * which the in-band error path would retry four times as an outage.
     */
    it.each([
      ['a start after today', { dateFiledStart: '2030-01-01' }],
      ['an end before 1900', { dateFiledEnd: '1899-12-31' }],
      ['a range wholly before 1900', { dateFiledStart: '1850-01-01', dateFiledEnd: '1880-12-31' }],
    ])('answers %s with no cases and no request', async (_label, dates) => {
      const urls = stubFetch(() => ({
        Results: {
          Error: { ErrorMessage: 'From_date must be earlier than or equal to to_date.' },
        },
      }));

      const result = await newService().searchViolations(
        { state: 'WA', ...dates },
        createMockContext(),
      );

      expect(result).toEqual({ cases: [], totalCount: 0 });
      expect(urls).toHaveLength(0);
    });
  });

  it('regression #28: maps a date-bounded civil search from real ECHO bodies', async () => {
    const urls = stubFetch((url) =>
      endpointOf(url) === 'case_rest_services.get_case_info'
        ? CASE_INFO_WA_2024_CIVIL
        : CASE_PAGE_WA_2024_CIVIL,
    );

    const result = await newService().searchViolations(
      {
        state: 'WA',
        caseType: 'civil',
        dateFiledStart: '2024-01-01',
        dateFiledEnd: '2024-12-31',
        limit: 2,
      },
      createMockContext(),
    );

    expect(urls.map(endpointOf)).toEqual([
      'case_rest_services.get_case_info',
      'case_rest_services.get_qid',
    ]);
    expect(result.totalCount).toBe(87);
    expect(result.cases).toEqual([
      {
        caseId: '05-2024-0043',
        caseName: 'Blue Falls USA LLC (NOW)',
        caseType: 'Administrative - Formal',
        programsViolated: 'FIFRA',
        penaltyAssessedInDollars: 0,
        settlementDate: '05/01/2024',
        filedDate: '05/01/2024',
      },
      {
        caseId: '09-2024-0631',
        caseName: 'Amazon services HFC Denial Letter',
        caseType: 'Administrative - Formal',
        programsViolated: 'AIM',
        penaltyAssessedInDollars: 0,
        settlementDate: '09/05/2024',
        filedDate: '09/05/2024',
      },
    ]);
  });

  it('regression #28: fails without paging when ECHO drops a sent filter', async () => {
    // ECHO echoes defaults it was not sent (p_name_type) and drops parameters it does not know.
    const urls = stubFetch(() => ({
      Results: {
        Message: 'Success',
        QueryID: '466',
        QueryRows: '312945',
        QueryParameters: [
          { QP: 'output', QV: 'JSON' },
          { QP: 'p_name_type', QV: 'ANY' },
          { QP: 'mapset', QV: '2000' },
        ],
      },
    }));

    const error = await newService()
      .searchViolations({ zipCode: '98108' }, createMockContext())
      .catch((e: unknown) => e);

    expect(urls).toHaveLength(1);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: expect.stringContaining('p_fac_zip'),
      data: { droppedParameters: ['p_fac_zip'], retryable: false },
    });
  });

  it('accepts an echo that lists defaults it was not sent and values it reformatted', async () => {
    // Names only: ECHO reports p_radius=0.5 as ".5" and adds p_name_type/mapset on its own.
    const urls = stubFetch(() => ({
      Results: {
        QueryID: '410',
        QueryRows: '0',
        QueryParameters: [
          { QP: 'p_state', QV: 'WA' },
          { QP: 'p_name_type', QV: 'ANY' },
          { QP: 'p_civil_criminal_indicator', QV: 'XX' },
        ],
      },
    }));

    const result = await newService().searchViolations(
      { state: 'WA', caseType: 'civil' },
      createMockContext(),
    );

    expect(urls).toHaveLength(1);
    expect(result).toEqual({ cases: [], totalCount: 0 });
  });

  it('regression #11: maps the real get_qid fields onto the case shape', async () => {
    stubFetch((url) =>
      endpointOf(url) === 'case_rest_services.get_case_info'
        ? { Results: { QueryID: '328', QueryRows: '1' } }
        : {
            Results: {
              Cases: [
                {
                  CaseNumber: '03-2014-7010',
                  CaseName: 'SOME CASE',
                  CaseCategoryDesc: 'Judicial',
                  PrimaryLaw: 'CERCLA',
                  FedPenalty: '$27,044,146.00',
                  DateFiled: '2014-03-01',
                  SettlementDate: '2015-06-30',
                },
              ],
            },
          },
    );

    const result = await newService().searchViolations({ state: 'WA' }, createMockContext());

    expect(result.cases).toEqual([
      {
        caseId: '03-2014-7010',
        caseName: 'SOME CASE',
        caseType: 'Judicial',
        programsViolated: 'CERCLA',
        penaltyAssessedInDollars: 27044146,
        filedDate: '2014-03-01',
        settlementDate: '2015-06-30',
      },
    ]);
  });
});

/** A fetch that never answers; it rejects with the abort reason once its signal fires, as fetch does. */
function hang(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason));
  });
}

/** A fetch that answers `response()` after `ms`, unless its signal fires first. */
function answerAfter(
  ms: number,
  signal: AbortSignal | null | undefined,
  response: () => Response,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(response()), ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

/** An ECHO JSON answer, echoing the parameters a search endpoint was sent. */
const echoJson = (url: URL, body: unknown, status = 200) =>
  new Response(JSON.stringify(withEcho(url, body)), { status });

/** Records whether `call` has settled and how, without awaiting it. */
function track(call: Promise<unknown>) {
  const state: { settled: boolean; value?: unknown; error?: unknown } = { settled: false };
  call.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error: unknown) => Object.assign(state, { settled: true, error }),
  );
  return state;
}

describe('regression #42: one deadline per ECHO search call', () => {
  const airSearch = { zipCode: '98108', program: 'CAA', limit: 3 } as const;
  const civilSearch = {
    state: 'WA',
    caseType: 'civil',
    dateFiledStart: '2024-01-01',
    dateFiledEnd: '2024-12-31',
    limit: 2,
  } as const;

  /** Routes each request to `discovery` or `page` by endpoint, recording every URL. */
  function stubSearch(
    discovery: (url: URL, signal?: AbortSignal | null) => Promise<Response>,
    page: (url: URL, signal?: AbortSignal | null) => Promise<Response>,
  ): URL[] {
    const urls: URL[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = new URL(String(input));
      urls.push(url);
      return /get_(facility|case)_info$/.test(url.pathname)
        ? discovery(url, init?.signal)
        : page(url, init?.signal);
    });
    return urls;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a facility search whose get_qid page hangs ends as a Timeout 58 s after the call began', async () => {
    const urls = stubSearch(
      (url, signal) => answerAfter(30_000, signal, () => echoJson(url, FACILITY_SEARCH_AIR_98108)),
      (_url, signal) => hang(signal),
    );

    const call = track(newService().searchFacilities(airSearch, createMockContext()));
    await vi.advanceTimersByTimeAsync(57_999);
    expect(call.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(call.error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: expect.stringMatching(
        /^ECHO did not finish the facility search within 58 seconds\. Narrow it/,
      ),
      data: { reason: 'retry_deadline_exceeded', deadlineMs: 58_000 },
    });
    expect(urls.map(endpointOf)).toEqual([
      'echo_rest_services.get_facility_info',
      'echo_rest_services.get_qid',
    ]);
  });

  it('a hung facility discovery request ends as a Timeout at 58 s after one request', async () => {
    const urls = stubSearch(
      (_url, signal) => hang(signal),
      (_url, signal) => hang(signal),
    );

    const call = track(newService().searchFacilities(airSearch, createMockContext()));
    await vi.advanceTimersByTimeAsync(57_999);
    expect(call.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(call.error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'retry_deadline_exceeded', deadlineMs: 58_000 },
    });
    expect(urls.map(endpointOf)).toEqual(['echo_rest_services.get_facility_info']);
  });

  it('bounds the retry ladder: slow 503s stop at 58 s instead of running four attempts', async () => {
    const urls = stubSearch(
      (_url, signal) =>
        answerAfter(20_000, signal, () => new Response('Service Unavailable', { status: 503 })),
      (_url, signal) => hang(signal),
    );

    const call = track(newService().searchFacilities(airSearch, createMockContext()));
    await vi.advanceTimersByTimeAsync(58_000);

    expect(call.error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'retry_deadline_exceeded' },
    });
    // 20 s + ~1 s backoff + 20 s + ~2 s backoff puts the third attempt in flight at the deadline.
    expect(urls.map(endpointOf)).toEqual(Array(3).fill('echo_rest_services.get_facility_info'));
  });

  it('returns a search whose two requests finish inside the shared budget', async () => {
    stubSearch(
      (url, signal) => answerAfter(45_000, signal, () => echoJson(url, FACILITY_SEARCH_AIR_98108)),
      (url, signal) =>
        answerAfter(9_000, signal, () => echoJson(url, FACILITY_SEARCH_AIR_98108_PAGE)),
    );

    const call = track(newService().searchFacilities(airSearch, createMockContext()));
    await vi.advanceTimersByTimeAsync(54_000);

    expect(call.error).toBeUndefined();
    expect(call.value).toMatchObject({ totalCount: 26 });
    expect((call.value as { facilities: unknown[] }).facilities).toHaveLength(3);
  });

  it('answers a search as slow as the measured p_ct=Los Angeles one (45.6 s + 11.1 s)', async () => {
    stubSearch(
      (url, signal) => answerAfter(45_600, signal, () => echoJson(url, FACILITY_SEARCH_AIR_98108)),
      (url, signal) =>
        answerAfter(11_100, signal, () => echoJson(url, FACILITY_SEARCH_AIR_98108_PAGE)),
    );

    const call = track(newService().searchFacilities(airSearch, createMockContext()));
    await vi.advanceTimersByTimeAsync(56_700);

    expect(call.error).toBeUndefined();
    expect(call.value).toMatchObject({ totalCount: 26 });
    expect((call.value as { facilities: unknown[] }).facilities).toHaveLength(3);
  });

  it('a case search whose get_qid page hangs ends as a Timeout 58 s after the call began', async () => {
    const urls = stubSearch(
      (url, signal) => answerAfter(40_000, signal, () => echoJson(url, CASE_INFO_WA_2024_CIVIL)),
      (_url, signal) => hang(signal),
    );

    const call = track(newService().searchViolations(civilSearch, createMockContext()));
    await vi.advanceTimersByTimeAsync(57_999);
    expect(call.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(call.error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: expect.stringMatching(
        /^ECHO did not finish the case search within 58 seconds\. Narrow it/,
      ),
      data: { reason: 'retry_deadline_exceeded', deadlineMs: 58_000 },
    });
    expect(urls.map(endpointOf)).toEqual([
      'case_rest_services.get_case_info',
      'case_rest_services.get_qid',
    ]);
  });

  it('getFacility keeps its own 50 s budget: a hung get_dfr ends as a Timeout at 50 s', async () => {
    const urls: URL[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      urls.push(new URL(String(input)));
      return hang(init?.signal);
    });

    const call = track(newService().getFacility('110017848105', createMockContext()));
    await vi.advanceTimersByTimeAsync(49_999);
    expect(call.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(call.error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'retry_deadline_exceeded', deadlineMs: 50_000 },
    });
    expect(urls.map(endpointOf)).toEqual(['dfr_rest_services.get_dfr']);
  });

  it.each([
    {
      search: 'facility search',
      run: (ctx: ReturnType<typeof createMockContext>) =>
        newService().searchFacilities(airSearch, ctx),
      discoveryBody: FACILITY_SEARCH_AIR_98108,
    },
    {
      search: 'case search',
      run: (ctx: ReturnType<typeof createMockContext>) =>
        newService().searchViolations(civilSearch, ctx),
      discoveryBody: CASE_INFO_WA_2024_CIVIL,
    },
  ])(
    'caller cancellation during a hung $search get_qid surfaces as the abort, not a Timeout',
    async ({ run, discoveryBody }) => {
      stubSearch(
        (url) => Promise.resolve(echoJson(url, discoveryBody)),
        (_url, signal) => hang(signal),
      );
      const controller = new AbortController();

      const call = track(run(createMockContext({ signal: controller.signal })));
      await vi.advanceTimersByTimeAsync(10_000);
      controller.abort(new DOMException('Client cancelled', 'AbortError'));
      await vi.advanceTimersByTimeAsync(0);

      expect(call.error).toMatchObject({ name: 'AbortError', message: 'Client cancelled' });
      expect(call.error).not.toBeInstanceOf(McpError);
    },
  );
});
