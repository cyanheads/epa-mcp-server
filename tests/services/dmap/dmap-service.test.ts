/**
 * @fileoverview Tests for DmapService.getTriReleases per-medium breakdown — the batched
 * tri.tri_release_qty fetch, the medium-code rollup, sparsity preservation, and the guarantee
 * that searchTriReleases (which shares normalizeTriRelease) does NOT issue the extra query.
 * `fetch` is stubbed and routed by table path so the built URLs are observable.
 * @module tests/services/dmap/dmap-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DmapService } from '@/services/dmap/dmap-service.js';

/** Route fetch by table-path substring, returning each route's rows as a JSON array. */
function stubDmapFetch(routes: Array<{ match: string; rows: unknown[] }>): string[] {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    urls.push(url);
    const route = routes.find((r) => url.includes(r.match));
    return Promise.resolve(new Response(JSON.stringify(route ? route.rows : []), { status: 200 }));
  });
  return urls;
}

function makeService(): DmapService {
  // Constructor ignores config/storage and reads only getServerConfig().dmapBaseUrl (defaulted).
  return new DmapService({} as AppConfig, {} as StorageService);
}

describe('DmapService.getTriReleases per-medium breakdown', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rolls up tri_release_qty into 4 media and joins on doc_ctrl_num', async () => {
    const urls = stubDmapFetch([
      {
        match: '/tri.tri_reporting_form/',
        rows: [
          {
            doc_ctrl_num: 'D1',
            tri_facility_id: 'FAC1',
            cas_chem_name: 'BENZENE',
            reporting_year: '2020',
            one_time_release_qty: 0,
          },
        ],
      },
      {
        match: '/tri.tri_release_qty/',
        rows: [
          {
            doc_ctrl_num: 'D1',
            environmental_medium: 'AIR FUG',
            total_release: 120,
            release_na: '0',
          },
          {
            doc_ctrl_num: 'D1',
            environmental_medium: 'AIR STACK',
            total_release: 100,
            release_na: '0',
          },
          {
            doc_ctrl_num: 'D1',
            environmental_medium: 'WATER',
            total_release: 50,
            release_na: '0',
            water_sequence_num: '1',
          },
          {
            doc_ctrl_num: 'D1',
            environmental_medium: 'RCRA C',
            total_release: 30,
            release_na: '0',
          },
          {
            doc_ctrl_num: 'D1',
            environmental_medium: 'OTH DISP',
            total_release: 5,
            release_na: '0',
          },
          {
            doc_ctrl_num: 'D1',
            environmental_medium: 'UNINJ I',
            total_release: 200,
            release_na: '0',
          },
        ],
      },
    ]);

    const releases = await makeService().getTriReleases(
      { facilityId: 'FAC1' },
      createMockContext(),
    );

    expect(releases).toHaveLength(1);
    const r = releases[0]!;
    expect(r.releasesToAirInLbs).toBe(220); // 120 + 100
    expect(r.releasesToWaterInLbs).toBe(50);
    expect(r.releasesToLandInLbs).toBe(35); // RCRA C 30 + OTH DISP 5
    expect(r.releasesToUndergroundInjectionInLbs).toBe(200);
    // one_time_release_qty stays its own distinct category, untouched by the breakdown.
    expect(r.totalReleasesInLbs).toBe(0);
    // The breakdown fetch targeted tri_release_qty via the `in` operator on doc_ctrl_num.
    expect(
      urls.some((u) => u.includes('/tri.tri_release_qty/') && u.includes('doc_ctrl_num/in/D1')),
    ).toBe(true);
  });

  it('keys each submission independently by doc_ctrl_num (no cross-contamination)', async () => {
    stubDmapFetch([
      {
        match: '/tri.tri_reporting_form/',
        rows: [
          {
            doc_ctrl_num: 'D1',
            tri_facility_id: 'FAC1',
            cas_chem_name: 'BENZENE',
            reporting_year: '2020',
          },
          {
            doc_ctrl_num: 'D2',
            tri_facility_id: 'FAC1',
            cas_chem_name: 'TOLUENE',
            reporting_year: '2020',
          },
        ],
      },
      {
        match: '/tri.tri_release_qty/',
        rows: [
          {
            doc_ctrl_num: 'D1',
            environmental_medium: 'AIR FUG',
            total_release: 10,
            release_na: '0',
          },
          { doc_ctrl_num: 'D2', environmental_medium: 'WATER', total_release: 40, release_na: '0' },
        ],
      },
    ]);

    const releases = await makeService().getTriReleases(
      { facilityId: 'FAC1' },
      createMockContext(),
    );

    const benzene = releases.find((x) => x.chemicalName === 'BENZENE')!;
    const toluene = releases.find((x) => x.chemicalName === 'TOLUENE')!;
    expect(benzene.releasesToAirInLbs).toBe(10);
    expect(benzene.releasesToWaterInLbs).toBeUndefined();
    expect(toluene.releasesToWaterInLbs).toBe(40);
    expect(toluene.releasesToAirInLbs).toBeUndefined();
  });

  it('preserves sparsity — release_na and range-coded rows never fabricate a 0', async () => {
    stubDmapFetch([
      {
        match: '/tri.tri_reporting_form/',
        rows: [
          {
            doc_ctrl_num: 'D3',
            tri_facility_id: 'FAC2',
            cas_chem_name: 'LEAD',
            reporting_year: '2019',
          },
        ],
      },
      {
        match: '/tri.tri_release_qty/',
        rows: [
          {
            doc_ctrl_num: 'D3',
            environmental_medium: 'AIR FUG',
            total_release: 75,
            release_na: '0',
          },
          // Not applicable to this submission — must not become 0.
          {
            doc_ctrl_num: 'D3',
            environmental_medium: 'UNINJ I',
            total_release: null,
            release_na: '1',
          },
          // Reported as a coarse range band, not a hard number — must not become 0.
          {
            doc_ctrl_num: 'D3',
            environmental_medium: 'WATER',
            total_release: null,
            release_range_code: '1',
            release_na: '0',
          },
        ],
      },
    ]);

    const releases = await makeService().getTriReleases(
      { facilityId: 'FAC2' },
      createMockContext(),
    );

    const r = releases[0]!;
    expect(r.releasesToAirInLbs).toBe(75);
    expect(r.releasesToWaterInLbs).toBeUndefined();
    expect(r.releasesToLandInLbs).toBeUndefined();
    expect(r.releasesToUndergroundInjectionInLbs).toBeUndefined();
  });

  it('searchTriReleases does not fetch the per-medium table and surfaces no breakdown', async () => {
    const urls = stubDmapFetch([
      { match: '/tri.tri_facility/', rows: [{ tri_facility_id: 'FAC3', facility_name: 'ACME' }] },
      {
        match: '/tri.tri_reporting_form/',
        rows: [
          {
            doc_ctrl_num: 'D4',
            tri_facility_id: 'FAC3',
            cas_chem_name: 'XYLENE',
            reporting_year: '2020',
            one_time_release_qty: 10,
          },
        ],
      },
    ]);

    const results = await makeService().searchTriReleases({ state: 'WA' }, createMockContext());

    expect(results).toHaveLength(1);
    expect(results[0]!.releasesToAirInLbs).toBeUndefined();
    expect(urls.some((u) => u.includes('/tri.tri_release_qty/'))).toBe(false);
  });
});
