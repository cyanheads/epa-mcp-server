/**
 * @fileoverview Tests for EchoService — verifies the ECHO REST requests the service builds and
 * how it normalizes the responses, with `fetch` stubbed at the HTTP boundary. Guards the
 * proximity-search param key (p_radius, not p_radius_mi), the get_dfr facility lookup (#10),
 * and the two-step case search (#11). The tool tests stub getEchoService() wholesale, so the
 * built requests and raw-field mapping are only observable here.
 * @module tests/services/echo/echo-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, type MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EchoService } from '@/services/echo/echo-service.js';

/** Minimal get_facility_info payload — the service reads Results.Facilities + Results.TotalCount. */
const facilityResponse = {
  Results: {
    Facilities: [{ RegistryID: '110000350509', FacName: 'BOEING COMMERCIAL AIRPLANES' }],
    TotalCount: '1',
  },
};

/** The ECHO endpoint a request URL targets (its last path segment). */
const endpointOf = (url: URL) => url.pathname.split('/').pop();

/** Stub the global fetch, capturing every requested URL and answering with `respond(url)`. */
function stubFetch(respond: (url: URL) => unknown): URL[] {
  const urls: URL[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = new URL(String(input));
    urls.push(url);
    return Promise.resolve(new Response(JSON.stringify(respond(url)), { status: 200 }));
  });
  return urls;
}

const newService = () => new EchoService({} as AppConfig, {} as StorageService);

afterEach(() => {
  vi.restoreAllMocks();
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

  it('builds geographic queries (zip/state/city) with no radius param', async () => {
    const urls = stubFetch(() => facilityResponse);

    await service.searchFacilities(
      { zipCode: '98204', state: 'WA', city: 'EVERETT' },
      createMockContext(),
    );

    const params = urls[0]!.searchParams;
    expect(params.get('p_zip')).toBe('98204');
    expect(params.get('p_state')).toBe('WA');
    expect(params.get('p_city')).toBe('EVERETT');
    expect(params.has('p_radius')).toBe(false);
    expect(params.has('p_lat')).toBe(false);
    expect(params.has('p_long')).toBe(false);
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
  it('regression #10: looks the Registry ID up through get_dfr, never get_facility_info', async () => {
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
    expect(urls.map(endpointOf)).not.toContain('echo_rest_services.get_facility_info');
    expect(profile).toMatchObject({
      registryId: '110005351555',
      name: 'NUMERIC ID FACILITY',
      state: 'WA',
      programs: { air: true, water: false, rcra: false, tri: false, sdwa: false },
    });
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
