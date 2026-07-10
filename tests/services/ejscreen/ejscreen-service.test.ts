/**
 * @fileoverview Tests for EjscreenService — the normalizeEjscreen mapper against a trimmed
 * real EJAM response (Baltimore, MD ground truth captured 2026-07-10), the out-of-coverage
 * (`valid:false`) case, and the service fetch path (POST body shape + HTTP 400 mapping).
 * `fetch` is stubbed so the request body and error handling are observable without live calls.
 * @module tests/services/ejscreen/ejscreen-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EjscreenService, normalizeEjscreen } from '@/services/ejscreen/ejscreen-service.js';
import type { RawEjamRow } from '@/services/ejscreen/types.js';

/**
 * Trimmed copy of the live EJAM `POST /data` response for Baltimore, MD (lat 39.2904,
 * lon -76.6122, 1-mile buffer). Only the mapped columns are kept; every value is the real
 * ground truth from the recorded fixture.
 */
const baltimoreRow: RawEjamRow = {
  ST: 'MD',
  statename: 'Maryland',
  pop: 38776.2,
  valid: true,
  invalid_msg: '',
  bgcount_near_site: 51,
  'radius.miles': 1,
  'EJAM Report':
    '<a href="https://api.ejanalysis.com/report?lat=39.2904&lon=-76.6122&buffer=1&sitetype=latlon&validate_regids=FALSE&version=3.2022.1&fileextension=pdf" target="_blank">EJAM Site Report</a>',
  pm: 6.925,
  'pctile.pm': 17,
  'state.pctile.pm': 51,
  'avg.pm': 8.4473,
  'state.avg.pm': 6.8078,
  o3: 62.98,
  'pctile.o3': 62,
  'state.pctile.o3': 97,
  dpm: 0.3169,
  no2: 15.3833,
  pctpre1960: 0.4584,
  'traffic.score': 4311066.2843,
  'proximity.npl': 0.344,
  'proximity.rmp': 2.4133,
  'proximity.tsdf': 18.8156,
  'proximity.npdes': 76205.3959,
  ust: 6.3583,
  drinking: 0,
  rsei: 859.9839,
  pctmin: 0.6307,
  'pctile.pctmin': 74,
  'state.pctile.pctmin': 62,
  pctlowinc: 0.4066,
  pctlingiso: 0.0203,
  pctlths: 0.1245,
  pctunder5: 0.0374,
  pctover64: 0.1202,
  'Demog.Index': 1.949,
  'pctile.Demog.Index': 76,
  'state.pctile.Demog.Index': 78,
  'Demog.Index.Supp': 1.9334,
  'pctile.Demog.Index.Supp': 71,
  'state.pctile.Demog.Index.Supp': 81,
  'EJ.DISPARITY.pm.eo': 32.9204,
  'pctile.EJ.DISPARITY.pm.eo': 39,
  'state.pctile.EJ.DISPARITY.pm.eo': 76,
};

const baltimoreParams = { latitude: 39.2904, longitude: -76.6122, bufferMiles: 1 };

function makeService(): EjscreenService {
  // Constructor ignores config/storage and reads only getServerConfig().ejscreenBaseUrl (defaulted).
  return new EjscreenService({} as AppConfig, {} as StorageService);
}

describe('normalizeEjscreen', () => {
  it('maps the Baltimore ground-truth row to location, indicators, and indices', () => {
    const result = normalizeEjscreen(baltimoreRow, baltimoreParams);

    expect(result.coverage).toEqual({ valid: true });
    expect(result.location).toEqual({
      latitude: 39.2904,
      longitude: -76.6122,
      bufferMiles: 1,
      state: 'MD',
      stateName: 'Maryland',
      population: 38776.2,
      blockGroupCount: 51,
    });

    // All 13 environmental indicators are present.
    expect(result.environmental).toHaveLength(13);
    const pm = result.environmental.find((e) => e.code === 'pm');
    expect(pm).toEqual({
      code: 'pm',
      label: 'PM2.5',
      value: 6.925,
      unit: 'µg/m³',
      usPercentile: 17,
      statePercentile: 51,
      ejIndex: 32.9204,
      ejIndexUsPercentile: 39,
      ejIndexStatePercentile: 76,
    });

    // A zero value is a real reading, not absence — it must survive.
    const drinking = result.environmental.find((e) => e.code === 'drinking');
    expect(drinking?.value).toBe(0);

    // Absent percentiles / EJ Index columns are omitted, not fabricated.
    const o3 = result.environmental.find((e) => e.code === 'o3');
    expect(o3?.value).toBe(62.98);
    expect(o3?.usPercentile).toBe(62);
    expect(o3?.ejIndex).toBeUndefined();

    // All 6 demographic indicators, fractions converted to percentages.
    expect(result.demographic).toHaveLength(6);
    const pctmin = result.demographic.find((d) => d.code === 'pctmin');
    expect(pctmin).toEqual({
      code: 'pctmin',
      label: 'People of color',
      percent: 63.07,
      usPercentile: 74,
      statePercentile: 62,
    });
    expect(result.demographic.find((d) => d.code === 'pctlingiso')?.percent).toBe(2.03);

    expect(result.demographicIndex).toEqual({
      value: 1.949,
      usPercentile: 76,
      statePercentile: 78,
    });
    expect(result.supplementalDemographicIndex).toEqual({
      value: 1.9334,
      usPercentile: 71,
      statePercentile: 81,
    });

    expect(result.reportUrl).toBe(
      'https://api.ejanalysis.com/report?lat=39.2904&lon=-76.6122&buffer=1&sitetype=latlon&validate_regids=FALSE&version=3.2022.1&fileextension=pdf',
    );
    expect(result.dataSource).toContain('EJScreen v2.2');
  });

  it('surfaces coverage note and omits indicators when the point is out of coverage', () => {
    const oceanRow: RawEjamRow = {
      valid: false,
      invalid_msg: 'The site is not located within the United States.',
      // Out-of-coverage rows carry null indicator columns — must never become zeros.
      ST: null,
      pm: null,
      pctmin: null,
      'Demog.Index': null,
    };

    const result = normalizeEjscreen(oceanRow, { latitude: 0, longitude: 0, bufferMiles: 1 });

    expect(result.coverage).toEqual({
      valid: false,
      note: 'The site is not located within the United States.',
    });
    expect(result.environmental).toEqual([]);
    expect(result.demographic).toEqual([]);
    expect(result.demographicIndex).toBeUndefined();
    expect(result.supplementalDemographicIndex).toBeUndefined();
    expect(result.reportUrl).toBeUndefined();
    expect(result.location).toEqual({ latitude: 0, longitude: 0, bufferMiles: 1 });
    expect(result.dataSource).toContain('EJScreen v2.2');
  });

  it('treats an empty/dataless upstream object as out of coverage with a synthesized note', () => {
    // The live EJAM API returns a bare `{}` (no valid:false, no columns) for points it
    // can process but has no data for (non-US land, open ocean) — must not read as valid.
    const result = normalizeEjscreen(
      {},
      { latitude: 43.6532, longitude: -79.3832, bufferMiles: 1 },
    );

    expect(result.coverage.valid).toBe(false);
    expect(result.coverage.note).toMatch(/outside US coverage/i);
    expect(result.environmental).toEqual([]);
    expect(result.demographic).toEqual([]);
    expect(result.demographicIndex).toBeUndefined();
    expect(result.location).toEqual({ latitude: 43.6532, longitude: -79.3832, bufferMiles: 1 });
  });
});

describe('EjscreenService.getIndicators', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs sites + buffer as a JSON body and returns the normalized result', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      captured = { url: String(url), init: (init ?? {}) as RequestInit };
      return Promise.resolve(new Response(JSON.stringify([baltimoreRow]), { status: 200 }));
    });

    const result = await makeService().getIndicators(baltimoreParams, createMockContext());

    expect(captured?.url).toBe('https://api.ejanalysis.com/data');
    expect(captured?.init.method).toBe('POST');
    expect(JSON.parse(String(captured?.init.body))).toEqual({
      sites: [{ lat: 39.2904, lon: -76.6122 }],
      buffer: 1,
    });
    expect(result.location.state).toBe('MD');
    expect(result.environmental).toHaveLength(13);
    expect(result.coverage.valid).toBe(true);
  });

  it('maps an HTTP 400 to a deterministic upstream_rejected validation failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: ['Invalid coordinates provided'] }), { status: 400 }),
    );

    await expect(
      makeService().getIndicators(
        { latitude: 999, longitude: 999, bufferMiles: 1 },
        createMockContext(),
      ),
    ).rejects.toMatchObject({ data: { reason: 'upstream_rejected' } });
  });
});
