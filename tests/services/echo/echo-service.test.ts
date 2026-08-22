/**
 * @fileoverview Tests for EchoService — verifies the ECHO REST query strings the service
 * builds, with `fetch` stubbed. Guards the proximity-search param key (p_radius, not
 * p_radius_mi) and confirms the zip/state/city geographic paths are unaffected. Every other
 * test in this repo stubs getEchoService() wholesale, so the built URL is only observable here.
 * @module tests/services/echo/echo-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EchoService } from '@/services/echo/echo-service.js';

/** Minimal get_facility_info payload — the service reads Results.Facilities + Results.TotalCount. */
const facilityResponse = {
  Results: {
    Facilities: [{ RegistryID: '110000350509', FacName: 'BOEING COMMERCIAL AIRPLANES' }],
    TotalCount: '1',
  },
};

/** Stub the global fetch, capturing every requested URL and returning a canned ECHO JSON body. */
function stubFetch(payload: unknown): string[] {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    urls.push(String(input));
    return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
  });
  return urls;
}

describe('EchoService.searchFacilities', () => {
  let service: EchoService;

  beforeEach(() => {
    // The constructor ignores config/storage and reads only getServerConfig().echoBaseUrl,
    // which defaults to the public ECHO host when the env var is unset.
    service = new EchoService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds the proximity query with p_radius (not p_radius_mi)', async () => {
    const urls = stubFetch(facilityResponse);
    const ctx = createMockContext();

    await service.searchFacilities({ latitude: 47.917, longitude: -122.248, radiusMiles: 10 }, ctx);

    expect(urls).toHaveLength(1);
    const url = urls[0]!;
    expect(url).toContain('p_radius=10');
    expect(url).not.toContain('p_radius_mi');
    expect(url).toContain('p_lat=47.917');
    expect(url).toContain('p_long=-122.248');
  });

  it('forwards latitude/longitude of 0 alongside p_radius', async () => {
    const urls = stubFetch(facilityResponse);
    const ctx = createMockContext();

    await service.searchFacilities({ latitude: 0, longitude: 0, radiusMiles: 25 }, ctx);

    const url = urls[0]!;
    expect(url).toContain('p_lat=0');
    expect(url).toContain('p_long=0');
    expect(url).toContain('p_radius=25');
    expect(url).not.toContain('p_radius_mi');
  });

  it('builds geographic queries (zip/state/city) with no radius param', async () => {
    const urls = stubFetch(facilityResponse);
    const ctx = createMockContext();

    await service.searchFacilities({ zipCode: '98204', state: 'WA', city: 'EVERETT' }, ctx);

    const url = urls[0]!;
    expect(url).toContain('p_zip=98204');
    expect(url).toContain('p_state=WA');
    expect(url).toContain('p_city=EVERETT');
    expect(url).not.toContain('p_radius');
    expect(url).not.toContain('p_lat');
    expect(url).not.toContain('p_long');
  });

  it('pages through a bounded response set and preserves the full match count', async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      urls.push(url);
      const payload = url.includes('get_facility_info')
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
          };
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
    });

    const result = await service.searchFacilities(
      { zipCode: '98101', limit: 1 },
      createMockContext(),
    );

    expect(result.facilities).toEqual([
      expect.objectContaining({ registryId: '110005351555', name: 'First facility' }),
    ]);
    expect(result.totalCount).toBe(330);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('responseset=1');
    expect(urls[0]).not.toContain('p_limit');
    expect(urls[1]).toContain('echo_rest_services.get_qid');
    expect(urls[1]).toContain('qid=841');
    expect(urls[1]).toContain('pageno=1');
  });
});

describe('EchoService.searchViolations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses ECHO response-set pagination and preserves the full match count', async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      urls.push(url);
      const payload = url.includes('get_case_info')
        ? { Results: { QueryID: '328', QueryRows: '6166' } }
        : {
            Results: {
              Cases: [
                { CaseNumber: 'CASE-1', CaseName: 'First case' },
                { CaseNumber: 'CASE-2', CaseName: 'Second case' },
              ],
              PageNo: '1',
            },
          };
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
    });

    const result = await new EchoService({} as AppConfig, {} as StorageService).searchViolations(
      { state: 'WA', limit: 1 },
      createMockContext(),
    );

    expect(result.cases).toEqual([expect.objectContaining({ caseId: 'CASE-1' })]);
    expect(result.totalCount).toBe(6166);
    expect(urls[0]).toContain('responseset=1');
    expect(urls[0]).not.toContain('p_limit');
    expect(urls[1]).toContain('pageno=1');
    expect(urls[1]).not.toContain('p_limit');
  });
});
