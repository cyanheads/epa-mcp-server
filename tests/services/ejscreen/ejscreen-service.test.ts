/**
 * @fileoverview Tests for EjscreenService — the normalizeEjscreen mapper against trimmed real
 * EJAM responses (Baltimore, MD captured 2026-07-10; the no-data shapes in ejam-fixtures.ts),
 * the bounds check that answers out-of-bounds points without a request, and the fetch path
 * (POST body shape, HTTP 400 mapping, malformed bodies, retries). `fetch` is stubbed so the
 * request body and error handling are observable without live calls.
 * @module tests/services/ejscreen/ejscreen-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ejscreenGetScoresTool } from '@/mcp-server/tools/definitions/ejscreen-get-scores.tool.js';
import {
  EjscreenService,
  initEjscreenService,
  normalizeEjscreen,
} from '@/services/ejscreen/ejscreen-service.js';
import type { EjscreenResult, RawEjamRow } from '@/services/ejscreen/types.js';
import { answerAfter, hang, textOf, track } from '../../helpers.js';
import {
  EJAM_NO_BLOCKS,
  EJAM_OUT_OF_BOUNDS_400,
  nevadaZeroResidentRow,
  sanJuanRow,
} from './ejam-fixtures.js';

/** The coverage notes the service writes, as literals. */
const NOTE = {
  noBlockBelowMax:
    'EJScreen found no Census block within the buffer. Either none lies this close to the point, and a larger distance (up to 15 miles) may reach one, or the point is somewhere EJScreen does not cover, such as open water or a place outside the 50 states, DC, and Puerto Rico.',
  noBlockAtMax:
    'EJScreen found no Census block within the buffer, which is already at the 15-mile maximum. Either none lies within 15 miles of the point, or the point is somewhere EJScreen does not cover, such as open water or a place outside the 50 states, DC, and Puerto Rico.',
  zeroResidentsBelowMax:
    'EJScreen found Census blocks within the buffer but no residents, so it has no population-weighted indicators to report. A larger distance (up to 15 miles) may reach populated blocks.',
  zeroResidentsAtMax:
    'EJScreen found Census blocks within the buffer but no residents, so it has no population-weighted indicators to report.',
  outOfBounds:
    'The point is outside the bounds EJScreen accepts, which enclose the 50 states, DC, Puerto Rico, and the U.S. Island Areas, so no EJScreen lookup was made. If the point should be in the US, check its latitude and longitude.',
};

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
  'avg.Demog.Index': 1.3407,
  'state.avg.Demog.Index': 1.3551,
  'Demog.Index.Supp': 1.9334,
  'pctile.Demog.Index.Supp': 71,
  'state.pctile.Demog.Index.Supp': 81,
  'avg.Demog.Index.Supp': 1.6423,
  'state.avg.Demog.Index.Supp': 1.3273,
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

    // All 13 environmental indicators, in report order, each read from its own column.
    expect(result.environmental.map((e) => [e.code, e.label, e.value, e.unit])).toEqual([
      ['pm', 'PM2.5', 6.925, 'µg/m³'],
      ['o3', 'Ozone', 62.98, 'ppb'],
      ['dpm', 'Diesel particulate matter', 0.3169, 'µg/m³'],
      ['no2', 'Nitrogen dioxide (NO2)', 15.3833, 'ppb'],
      ['pctpre1960', 'Lead paint (pre-1960 housing)', 0.4584, 'fraction of housing built pre-1960'],
      [
        'traffic.score',
        'Traffic proximity & volume',
        4311066.2843,
        'daily traffic count / distance',
      ],
      ['proximity.npl', 'Superfund (NPL) proximity', 0.344, 'site count / km'],
      ['proximity.rmp', 'RMP facility proximity', 2.4133, 'facility count / km'],
      ['proximity.tsdf', 'Hazardous-waste (TSDF) proximity', 18.8156, 'facility count / km'],
      ['proximity.npdes', 'Wastewater discharge (NPDES) proximity', 76205.3959, 'score'],
      ['ust', 'Underground storage tanks', 6.3583, 'count / area'],
      ['drinking', 'Drinking-water non-compliance', 0, 'score'],
      ['rsei', 'Toxic releases to air (RSEI)', 859.9839, 'score'],
    ]);
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

    // All 6 demographic indicators, in report order, fractions converted to percentages.
    expect(result.demographic.map((d) => [d.code, d.label, d.percent])).toEqual([
      ['pctmin', 'People of color', 63.07],
      ['pctlowinc', 'Low income', 40.66],
      ['pctlingiso', 'Limited English (linguistically isolated)', 2.03],
      ['pctlths', 'Less than high school education', 12.45],
      ['pctunder5', 'Under age 5', 3.74],
      ['pctover64', 'Over age 64', 12.02],
    ]);
    const pctmin = result.demographic.find((d) => d.code === 'pctmin');
    expect(pctmin).toEqual({
      code: 'pctmin',
      label: 'People of color',
      percent: 63.07,
      usPercentile: 74,
      statePercentile: 62,
    });

    // Each index carries its national average; the state averages belong to the
    // state-normalized index, so they stay out (toEqual rejects any extra key).
    expect(result.demographicIndex).toEqual({
      value: 1.949,
      usAverage: 1.3407,
      usPercentile: 76,
      statePercentile: 78,
    });
    expect(result.supplementalDemographicIndex).toEqual({
      value: 1.9334,
      usAverage: 1.6423,
      usPercentile: 71,
      statePercentile: 81,
    });

    expect(result.reportUrl).toBe(
      'https://api.ejanalysis.com/report?lat=39.2904&lon=-76.6122&buffer=1&sitetype=latlon&validate_regids=FALSE&version=3.2022.1&fileextension=pdf',
    );
    expect(result.dataSource).toContain("EJAM's ACS 2018–2022 release (EJScreen 2.3 method)");
    expect(result.dataSource).not.toContain('v2.2');
  });

  it('omits usAverage when the average column is absent', () => {
    const {
      'avg.Demog.Index': _avg,
      'avg.Demog.Index.Supp': _avgSupp,
      ...withoutAverages
    } = baltimoreRow;
    const result = normalizeEjscreen(withoutAverages, baltimoreParams);
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
  });
});

describe('regression #64: no-data answers say what EJAM found', () => {
  const yellowstone = { latitude: 44.5, longitude: -110.5 };
  const noBlocks = JSON.parse(EJAM_NO_BLOCKS) as RawEjamRow;
  const noteOf = ({ coverage }: EjscreenResult) => (coverage.valid ? undefined : coverage.note);

  /** A result EJScreen has no indicators for: nothing fabricated, both indexes omitted. */
  function expectNoIndicators(result: EjscreenResult) {
    expect(result.environmental).toEqual([]);
    expect(result.demographic).toEqual([]);
    expect(result.demographicIndex).toBeUndefined();
    expect(result.supplementalDemographicIndex).toBeUndefined();
    expect(result.reportUrl).toBeUndefined();
  }

  it('a {} answer below the distance maximum names both readings and suggests a larger distance', () => {
    const result = normalizeEjscreen(noBlocks, { ...yellowstone, bufferMiles: 1 });
    expect(result.coverage).toEqual({ valid: false, note: NOTE.noBlockBelowMax });
    expect(result.location).toEqual({ ...yellowstone, bufferMiles: 1 });
    expectNoIndicators(result);
  });

  it('a {} answer at the 15-mile maximum names both readings without suggesting a larger distance', () => {
    const toronto = { latitude: 43.6532, longitude: -79.3832, bufferMiles: 15 };
    const result = normalizeEjscreen(noBlocks, toronto);
    expect(result.coverage).toEqual({ valid: false, note: NOTE.noBlockAtMax });
    expect(noteOf(result)).not.toContain('larger distance');
    expectNoIndicators(result);
  });

  it('the {} note for Guam does not say the point is outside the US', () => {
    const result = normalizeEjscreen(noBlocks, {
      latitude: 13.4443,
      longitude: 144.7937,
      bufferMiles: 1,
    });
    expect(result.coverage).toEqual({ valid: false, note: NOTE.noBlockBelowMax });
    expect(noteOf(result)).not.toMatch(/outside (the )?(US|U\.S\.|United States)/i);
  });

  it('a zero-resident buffer keeps its state, population, and block groups and is not called uncovered', () => {
    const nevada = { latitude: 38, longitude: -116, bufferMiles: 15 };
    const result = normalizeEjscreen(nevadaZeroResidentRow, nevada);
    expect(result.location).toEqual({
      ...nevada,
      state: 'NV',
      stateName: 'Nevada',
      population: 0,
      blockGroupCount: 3,
    });
    expect(result.coverage).toEqual({ valid: false, note: NOTE.zeroResidentsAtMax });
    expect(noteOf(result)).not.toMatch(/coverage|cover/i);
    // The row carries the national averages, but with no index value there is no index object.
    expectNoIndicators(result);

    const smaller = normalizeEjscreen(nevadaZeroResidentRow, { ...nevada, bufferMiles: 5 });
    expect(smaller.coverage).toEqual({ valid: false, note: NOTE.zeroResidentsBelowMax });
  });

  it('a row EJAM marks invalid for another reason relays its message as the reason', () => {
    // Synthetic: no live single-site lookup has returned this shape.
    const row: RawEjamRow = { ...nevadaZeroResidentRow, pop: 12.5, invalid_msg: 'invalid latlon' };
    const result = normalizeEjscreen(row, { latitude: 38, longitude: -116, bufferMiles: 15 });
    expect(result.coverage).toEqual({
      valid: false,
      note: 'EJScreen reported no indicators for this buffer (EJAM: "invalid latlon").',
    });
    expectNoIndicators(result);
  });
});

describe('regression #64: EJAM bounds are checked before any request', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** EJAM's answer to a lookup, as the stub serves it: the recorded 400 out of bounds, `{}` in. */
  const stubEjam = () =>
    vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response(EJAM_NO_BLOCKS, { status: 200 })));

  it.each([
    { name: 'Paris', latitude: 48.85, longitude: 2.35 },
    { name: '0, 0', latitude: 0, longitude: 0 },
    { name: 'the mid-Atlantic', latitude: 30, longitude: -40 },
  ])('$name returns valid:false with the bounds note and makes no request', async (point) => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(EJAM_OUT_OF_BOUNDS_400, { status: 400 }));

    const params = { latitude: point.latitude, longitude: point.longitude, bufferMiles: 1 };
    const result = await makeService().getIndicators(params, createMockContext());

    expect(result.coverage).toEqual({ valid: false, note: NOTE.outOfBounds });
    expect(result.location).toEqual(params);
    expect(result.environmental).toEqual([]);
    expect(result.demographicIndex).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    // EJAM's core box: latitude 17.5–71.5, longitude outside (−64, 172).
    { latitude: 17.5, longitude: -66.5, sent: true },
    { latitude: 17.4, longitude: -66.5, sent: false },
    { latitude: 71.5, longitude: -156.8, sent: true },
    { latitude: 71.6, longitude: -156.8, sent: false },
    { latitude: 30, longitude: -64, sent: true },
    { latitude: 30, longitude: -63.9, sent: false },
    { latitude: 52, longitude: 172, sent: true },
    { latitude: 52, longitude: 171.9, sent: false },
    { latitude: 52, longitude: -180, sent: true },
    // Island Areas outside the core box: Guam, Saipan, Pago Pago. The USVI sit inside it.
    { latitude: 13.4443, longitude: 144.7937, sent: true },
    { latitude: 15.1833, longitude: 145.75, sent: true },
    { latitude: -14.2756, longitude: -170.702, sent: true },
    { latitude: 18.3419, longitude: -64.9307, sent: true },
    { latitude: -14.2756, longitude: -167.9, sent: false },
    { latitude: 12.9, longitude: 144.7937, sent: false },
  ])('($latitude, $longitude) reaches EJAM: $sent', async ({ latitude, longitude, sent }) => {
    const fetchSpy = stubEjam();
    const result = await makeService().getIndicators(
      { latitude, longitude, bufferMiles: 1 },
      createMockContext(),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(sent ? 1 : 0);
    expect(result.coverage).toEqual({
      valid: false,
      note: sent ? NOTE.noBlockBelowMax : NOTE.outOfBounds,
    });
  });
});

describe('epa_ejscreen_get_scores no-data and rejection surfaces', () => {
  beforeEach(() => {
    initEjscreenService({} as AppConfig, {} as StorageService);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('an out-of-bounds point is a coverage result on both surfaces, not an error', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await runToolContract(ejscreenGetScoresTool, {
      latitude: 48.85,
      longitude: 2.35,
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      coverage: { valid: false, note: NOTE.outOfBounds },
      notice: NOTE.outOfBounds,
      environmental: [],
      demographic: [],
    });
    expect(textOf(result.content)).toContain('**Coverage valid:** no');
    expect(textOf(result.content)).toContain('so no EJScreen lookup was made');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a zero-resident buffer reports its state and population, and its notice claims no missing coverage', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([nevadaZeroResidentRow]), { status: 200 }),
    );
    const result = await runToolContract(ejscreenGetScoresTool, {
      latitude: 38,
      longitude: -116,
      distance: 15,
    });

    expect(result.structuredContent).toMatchObject({
      location: { state: 'NV', population: 0, blockGroupCount: 3 },
      coverage: { valid: false, note: NOTE.zeroResidentsAtMax },
      notice: NOTE.zeroResidentsAtMax,
    });
    expect(result.structuredContent).not.toHaveProperty('demographicIndex');
    const text = textOf(result.content);
    expect(text).toContain('**Population in buffer:** 0');
    expect(text).toContain('but no residents');
    expect(text).not.toMatch(/no coverage|outside/i);
  });

  it('an HTTP 400 inside the bounds stays upstream_rejected with EJAM text only in error.data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(EJAM_OUT_OF_BOUNDS_400, { status: 400 }),
    );
    const result = await runToolContract(ejscreenGetScoresTool, {
      latitude: 39.2904,
      longitude: -76.6122,
    });

    const hint = ejscreenGetScoresTool.errors?.find(
      (e) => e.reason === 'upstream_rejected',
    )?.recovery;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        message: 'EJAM rejected a lookup for a point inside the bounds it accepts (HTTP 400).',
        data: {
          reason: 'upstream_rejected',
          status: 400,
          upstreamMessage:
            'latlon_as.numeric(x) expects x to be a vector like 1:10 or df$mycol, not a data.frame, list, length zero, or anything else.',
          recovery: { hint },
        },
      },
    });
    const text = textOf(result.content);
    expect(text).toContain('EJAM rejected a lookup');
    expect(text).toContain(hint);
    expect(text).not.toContain('latlon_as.numeric');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
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
    // Headers normalizes name casing, so the lookup holds however the service spelled it.
    expect(new Headers(captured?.init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(captured?.init.body))).toEqual({
      sites: [{ lat: 39.2904, lon: -76.6122 }],
      buffer: 1,
    });
    expect(result.location.state).toBe('MD');
    expect(result.environmental).toHaveLength(13);
    expect(result.coverage.valid).toBe(true);
  });

  it('maps an HTTP 400 for an in-bounds point to a deterministic upstream_rejected failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: ['Invalid coordinates provided'] }), { status: 400 }),
    );

    await expect(
      makeService().getIndicators(baltimoreParams, createMockContext()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: 'EJAM rejected a lookup for a point inside the bounds it accepts (HTTP 400).',
      data: {
        reason: 'upstream_rejected',
        status: 400,
        upstreamMessage: 'Invalid coordinates provided',
      },
    });
    // Deterministic rejection: no retry.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('a non-JSON 400 body carries no upstreamMessage', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Bad Request', { status: 400 }));
    const error = await makeService()
      .getIndicators(baltimoreParams, createMockContext())
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ data: { reason: 'upstream_rejected', status: 400 } });
    expect((error as { data: object }).data).not.toHaveProperty('upstreamMessage');
  });
});

describe('regression #72: a malformed EJAM body fails once', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fails as SerializationError after one request, keeping the SyntaxError as cause', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response('{ broken', { status: 200 })),
    );

    const pending = makeService()
      .getIndicators({ latitude: 47.6, longitude: -122.3, bufferMiles: 1 }, createMockContext())
      .catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const error = await pending;

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
      message: 'EJAM API returned a response that is not JSON.',
    });
    expect((error as Error).cause).toBeInstanceOf(SyntaxError);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('covered rows', () => {
  it('maps the sparse San Juan row as covered and skips its null indicators', () => {
    const result = normalizeEjscreen(sanJuanRow, {
      latitude: 18.4655,
      longitude: -66.1057,
      bufferMiles: 1,
    });

    expect(result.coverage).toEqual({ valid: true });
    expect(result.location).toMatchObject({
      state: 'PR',
      stateName: 'Puerto Rico',
      population: 7311.3,
      blockGroupCount: 12,
    });
    expect(result.environmental.map((e) => e.code)).toEqual([
      'dpm',
      'no2',
      'pctpre1960',
      'traffic.score',
      'proximity.npl',
      'proximity.rmp',
      'proximity.tsdf',
      'proximity.npdes',
      'ust',
      'rsei',
    ]);
    expect(result.demographic).toHaveLength(6);
    expect(result.demographicIndex).toMatchObject({
      value: 2.7057,
      usPercentile: 91,
      statePercentile: 12,
    });
  });
});

describe('EJAM transient failures retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A 200 whose body stream errors after the first bytes. */
  const midStreamFailure = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('[{"ST":'));
          controller.error(new TypeError('terminated'));
        },
      }),
      { status: 200 },
    );

  it.each([
    { name: 'a rejected fetch', first: () => Promise.reject(new TypeError('fetch failed')) },
    { name: 'a body read that fails mid-stream', first: () => Promise.resolve(midStreamFailure()) },
    { name: 'HTTP 503', first: () => Promise.resolve(new Response('busy', { status: 503 })) },
    { name: 'HTTP 429', first: () => Promise.resolve(new Response('slow', { status: 429 })) },
    {
      name: 'HTML instead of JSON',
      first: () => Promise.resolve(new Response('<html>Unavailable</html>', { status: 200 })),
    },
  ])('retries after $name and returns the next answer', async ({ first }) => {
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(first)
      .mockResolvedValueOnce(new Response(JSON.stringify([baltimoreRow]), { status: 200 }));

    const pending = makeService().getIndicators(baltimoreParams, createMockContext());
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.coverage.valid).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('regression #42: one deadline per EJAM call', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A fetch that never answers; it rejects with the abort reason once its signal fires. */
  const stubHungFetch = () =>
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => hang(init?.signal));

  it('a hung EJAM request ends as a Timeout at 55 s after one request', async () => {
    stubHungFetch();

    const call = track(makeService().getIndicators(baltimoreParams, createMockContext()));
    await vi.advanceTimersByTimeAsync(54_999);
    expect(call.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(call.error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: 'EJAM request exceeded its 55000ms retry deadline after 1 attempt.',
      data: { reason: 'retry_deadline_exceeded', deadlineMs: 55_000 },
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds the retry ladder: slow 503s stop at 55 s instead of running four attempts', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) =>
      answerAfter(20_000, init?.signal, () => new Response('busy', { status: 503 })),
    );

    const call = track(makeService().getIndicators(baltimoreParams, createMockContext()));
    await vi.advanceTimersByTimeAsync(55_000);

    expect(call.error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'retry_deadline_exceeded' },
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it('caller cancellation during a hung EJAM request surfaces as the abort, not a Timeout', async () => {
    stubHungFetch();
    const controller = new AbortController();

    const call = track(
      makeService().getIndicators(
        baltimoreParams,
        createMockContext({ signal: controller.signal }),
      ),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    controller.abort(new DOMException('Client cancelled', 'AbortError'));
    await vi.advanceTimersByTimeAsync(0);

    expect(call.error).toMatchObject({ name: 'AbortError', message: 'Client cancelled' });
    expect(call.error).not.toMatchObject({ code: JsonRpcErrorCode.Timeout });
  });
});
