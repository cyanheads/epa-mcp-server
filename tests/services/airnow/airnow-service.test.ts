/**
 * @fileoverview AirNow service wire output, caching, and credential isolation, exercised
 * through `epa_get_air_quality` against the 2026 web services with fetch stubbed at the
 * HTTP boundary.
 * @module tests/services/airnow/airnow-service.test
 */
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  createFetchMock,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAirQualityTool } from '@/mcp-server/tools/definitions/get-air-quality.tool.js';
import { AirNowService, initAirNowService } from '@/services/airnow/airnow-service.js';
import {
  FORECAST_60601_CATEGORY_ONLY,
  FORECAST_98101,
  FORECAST_NO_REPORTING_AREA,
  FORECAST_NONE_ISSUED_99501,
  INVALID_ZIP_400,
  OBSERVATION_98101,
  OBSERVATION_NO_COVERAGE,
} from './airnow-fixtures.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    airNowApiKey: 'synthetic-secret',
    airNowBaseUrl: 'https://airnow.example/aq',
  }),
}));

const http = createFetchMock();
const isAirNow = (req: Request) => new URL(req.url).origin === 'https://airnow.example';
/** Answer every AirNow request with `body`; any other host is rejected as unmocked. */
const serve = (body: string, status = 200) =>
  http.route({ match: isAirNow, respond: () => new Response(body, { status }) });
const sentUrl = (index = 0) => new URL(http.calls[index]!.request.url);
const textOf = (result: { content: { type: string; text?: string }[] }) =>
  result.content.flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : [])).join('\n');
const parse = (raw: Record<string, unknown>) => getAirQualityTool.input.parse(raw);
const toolCtx = (tenantId?: string) =>
  createMockContext({ errors: getAirQualityTool.errors, ...(tenantId && { tenantId }) });

const SEATTLE_DISCUSSION =
  'For Oct 7-12 (Wed-Mon): Expect GOOD to MODERATE air quality through early next week.';

beforeEach(() => {
  initAirNowService({} as AppConfig, {} as StorageService);
  http.install();
});
afterEach(() => {
  http.restore();
  http.reset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('AirNow service', () => {
  it('preserves nested readings on both surfaces and reuses tenant storage', async () => {
    serve(OBSERVATION_98101);
    const result = await runToolContract(getAirQualityTool, { zip_code: '98101' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      observations: [{ readings: [{ aqi: 62 }, { aqi: 0 }, { aqi: 12 }] }],
    });
    expect(textOf(result)).toContain('PM2.5');
    expect(textOf(result)).toContain('AQI 12');
    expect(sentUrl().searchParams.get('API_KEY')).toBe('synthetic-secret');

    http.reset();
    serve('[]');
    const service = new AirNowService({} as AppConfig, {} as StorageService);
    const ctx = createMockContext({ tenantId: 'cache-test' });
    const zip = { kind: 'zip', zipCode: '98101' } as const;
    expect(await service.getCurrent(zip, ctx)).toEqual({ areas: [] });
    expect(await service.getCurrent(zip, ctx)).toEqual({ areas: [] });
    expect(http.calls).toHaveLength(1);
  });

  it.each([
    { zip: '98101', status: 403, body: 'Forbidden', code: JsonRpcErrorCode.Forbidden, calls: 1 },
    {
      zip: '98101',
      status: 200,
      body: '<html>Unavailable</html>',
      code: JsonRpcErrorCode.ServiceUnavailable,
      calls: 4,
    },
    {
      zip: '00000',
      status: 400,
      body: INVALID_ZIP_400,
      code: JsonRpcErrorCode.ValidationError,
      calls: 1,
    },
    {
      zip: '98101',
      status: 200,
      body: '{"unexpected":true}',
      code: JsonRpcErrorCode.SerializationError,
      calls: 1,
    },
  ])(
    'does not expose the credential-bearing URL on $status errors ($code)',
    async ({ zip, status, body, code, calls }) => {
      vi.useFakeTimers();
      serve(body, status);
      const pending = runToolContract(getAirQualityTool, { zip_code: zip });
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code } });
      expect(textOf(result)).toContain('AirNow');
      expect(http.calls).toHaveLength(calls);
      // The key was on the wire, so its absence below means the error surfaces dropped it.
      expect(sentUrl().searchParams.get('API_KEY')).toBe('synthetic-secret');
      expect(JSON.stringify(result.structuredContent)).not.toContain('synthetic-secret');
      expect(JSON.stringify(result.content)).not.toContain('synthetic-secret');
      expect(JSON.stringify(result)).not.toContain('API_KEY');
    },
  );

  it('regression #9: every cache-key kind is a valid storage key and serves repeats from cache', async () => {
    serve('[]');
    const ctx = toolCtx('cache-keys');
    const calls = [
      { zip_code: '98101' },
      { latitude: 47.6, longitude: -122.33 },
      { zip_code: '98101', mode: 'forecast' },
      { latitude: 47.6, longitude: -122.33, mode: 'forecast', forecast_date: '2026-10-09' },
    ];
    for (const raw of calls) {
      await getAirQualityTool.handler(parse(raw), ctx);
      await getAirQualityTool.handler(parse(raw), ctx);
    }
    expect(http.calls).toHaveLength(4);
    const keys = (await ctx.state.list('airnow/')).items.map((item) => item.key).sort();
    expect(keys).toEqual([
      'airnow/forecast/latlng/latitude-47.6_longitude--122.33',
      'airnow/forecast/zip/zipCode-98101',
      'airnow/observation/latlng/latitude-47.6_longitude--122.33',
      'airnow/observation/zip/zipCode-98101',
    ]);
    for (const key of keys) expect(key).toMatch(/^[a-zA-Z0-9_.\-/]+$/);
  });

  it('caches each location under its own key: distinct bodies, each repeat served from cache', async () => {
    /** One body per location, so a cache entry shared by two locations shows as a wrong area. */
    const area = (name: string) =>
      JSON.stringify([{ ...JSON.parse(OBSERVATION_98101)[0], reportingAreaName: name }]);
    const bodies: Record<string, string> = {
      'zipCode=98101': area('ZIP 98101 area'),
      'zipCode=98102': area('ZIP 98102 area'),
      'latitude=45&longitude=-100': area('West of the meridian'),
      'latitude=45&longitude=100': area('East of the meridian'),
    };
    http.route({
      match: isAirNow,
      respond: (req) => {
        const sent = new URL(req.url).searchParams;
        sent.delete('API_KEY');
        sent.delete('format');
        const body = bodies[sent.toString()];
        if (body === undefined) throw new Error(`No body for ${sent}`);
        return new Response(body);
      },
    });
    const service = new AirNowService({} as AppConfig, {} as StorageService);
    const ctx = createMockContext({ tenantId: 'per-location-cache' });
    const locations = [
      { kind: 'zip', zipCode: '98101' },
      { kind: 'zip', zipCode: '98102' },
      { kind: 'latlng', latitude: 45, longitude: -100 },
      { kind: 'latlng', latitude: 45, longitude: 100 },
    ] as const;
    const expected = [
      'ZIP 98101 area',
      'ZIP 98102 area',
      'West of the meridian',
      'East of the meridian',
    ];

    for (const round of [1, 2]) {
      const areas = [];
      for (const location of locations) {
        const {
          areas: [first],
        } = await service.getCurrent(location, ctx);
        areas.push(first?.reportingArea);
      }
      expect(areas, `round ${round}`).toEqual(expected);
    }
    expect(http.calls).toHaveLength(4);
  });

  it('never narrows the cached forecast: filtered, then unfiltered, from one fetch', async () => {
    serve(FORECAST_98101);
    const ctx = toolCtx('filter-then-all');
    const filtered = await getAirQualityTool.handler(
      parse({ zip_code: '98101', mode: 'forecast', forecast_date: '2026-10-11' }),
      ctx,
    );
    const all = await getAirQualityTool.handler(
      parse({ zip_code: '98101', mode: 'forecast' }),
      ctx,
    );
    expect(filtered.observations[0]?.readings.map((r) => r.dateValid)).toEqual(['2026-10-11']);
    expect(all.observations[0]?.readings.map((r) => r.dateValid)).toEqual([
      '2026-10-08',
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
      '2026-10-12',
    ]);
    expect(http.calls).toHaveLength(1);
  });
});

describe('AirNow characterization', () => {
  it('serves a cached response for one hour, then refetches', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-08T12:00:00Z') });
    serve('[]');
    const ctx = toolCtx('ttl');
    const input = parse({ zip_code: '98101' });
    await getAirQualityTool.handler(input, ctx);
    vi.setSystemTime(new Date('2026-10-08T12:59:59Z'));
    await getAirQualityTool.handler(input, ctx);
    expect(http.calls).toHaveLength(1);
    vi.setSystemTime(new Date('2026-10-08T13:00:01Z'));
    await getAirQualityTool.handler(input, ctx);
    expect(http.calls).toHaveLength(2);
  });

  it('falls back to latitude/longitude when a form client sends a blank zip_code', async () => {
    serve('[]');
    const input = parse({ zip_code: '', latitude: 47.6, longitude: -122.33 });
    await getAirQualityTool.handler(input, toolCtx());
    const sent = sentUrl().searchParams;
    expect(sent.get('latitude')).toBe('47.6');
    expect(sent.get('longitude')).toBe('-122.33');
    expect(sent.has('zipCode')).toBe(false);
    expect(sent.get('format')).toBe('application/json');
  });
});

describe('AirNow 2026 observations (observation/current/ziplatlong/)', () => {
  const seattleArea = {
    reportingArea: 'Seattle-Bellevue-Kent Valley',
    dateObserved: '2026-10-08',
    hourObserved: '03:00',
    localTimeZone: 'PDT',
    readings: [
      {
        parameterName: 'PM2.5',
        aqi: 62,
        categoryName: 'Moderate',
        categoryNumber: 2,
        siteName: 'Seattle-10th & Weller',
        siteID: '530330030',
        reportingAgency: 'Washington Department of Ecology',
      },
      {
        parameterName: 'OZONE',
        aqi: 0,
        categoryName: 'Good',
        categoryNumber: 1,
        siteName: 'Seattle-Beacon Hill',
        siteID: '530330080',
        reportingAgency: 'Washington Department of Ecology',
      },
      {
        parameterName: 'PM10',
        aqi: 12,
        categoryName: 'Good',
        categoryNumber: 1,
        siteName: 'Seattle-Beacon Hill',
        siteID: '530330080',
        reportingAgency: 'Washington Department of Ecology',
      },
    ],
  };

  it('maps a ZIP lookup onto the replacement endpoint and the multi-site reading shape', async () => {
    serve(OBSERVATION_98101);
    const result = await runToolContract(getAirQualityTool, { zip_code: '98101' });
    expect(result.isError).not.toBe(true);

    const url = sentUrl();
    expect(url.pathname).toBe('/aq/observation/current/ziplatlong/');
    expect(url.searchParams.get('zipCode')).toBe('98101');
    expect(url.searchParams.has('distance')).toBe(false);

    const structured = result.structuredContent as {
      observations: unknown[];
      attribution: string;
      mode: string;
    };
    expect(structured.mode).toBe('current');
    expect(structured.observations).toEqual([seattleArea]);
    expect(structured.attribution).toContain('Washington Department of Ecology');
    expect(structured.attribution).toContain('U.S. EPA AirNow');
    expect(structured.attribution).toContain('preliminary');

    const text = textOf(result);
    for (const fragment of [
      'Seattle-Bellevue-Kent Valley',
      '2026-10-08 at 03:00 PDT',
      'AQI 62 (Moderate) [category 2]',
      'Seattle-10th & Weller',
      '530330030',
      'Seattle-Beacon Hill',
      'Washington Department of Ecology',
      'U.S. EPA AirNow',
      'preliminary',
    ]) {
      expect(text).toContain(fragment);
    }
    expect(text).not.toContain('Coordinates');
  });

  it('sends latitude and longitude, never distance', async () => {
    serve(OBSERVATION_98101);
    const result = await runToolContract(getAirQualityTool, { latitude: 47.6, longitude: -122.33 });
    expect(result.isError).not.toBe(true);
    const url = sentUrl();
    expect(url.pathname).toBe('/aq/observation/current/ziplatlong/');
    expect([...url.searchParams.keys()].sort()).toEqual([
      'API_KEY',
      'format',
      'latitude',
      'longitude',
    ]);
  });

  it('keeps sparse and unrecognized records honest', async () => {
    serve(
      JSON.stringify([
        {
          dateObserved: '2026-10-08',
          hourObserved: '05:00',
          localTimeZone: 'CDT',
          reportingAreaName: 'Chicago',
          parameterName: 'PM2.5',
          nowcastAQI: 310,
          aqiCategoryName: 'Hazardous',
        },
        {
          dateObserved: '2026-10-08',
          hourObserved: '05:00',
          localTimeZone: 'CDT',
          reportingAreaName: 'Chicago',
          parameterName: 'OZONE',
          nowcastAQI: -1,
          aqiCategoryName: 'Beyond the AQI',
          siteName: 'CICERO',
        },
        {
          dateObserved: '2026-10-08',
          hourObserved: '04:00',
          localTimeZone: 'CDT',
          reportingAreaName: 'Chicago',
          parameterName: 'PM10',
          nowcastAQI: 19,
          aqiCategoryName: 'Unhealthy for Sensitive Groups',
        },
        { reportingAreaName: 'Chicago', nowcastAQI: 5 },
      ]),
    );
    const result = await runToolContract(getAirQualityTool, { zip_code: '60601' });
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { observations: unknown }).observations).toEqual([
      {
        reportingArea: 'Chicago',
        dateObserved: '2026-10-08',
        hourObserved: '05:00',
        localTimeZone: 'CDT',
        readings: [
          { parameterName: 'PM2.5', aqi: 310, categoryName: 'Hazardous', categoryNumber: 6 },
          { parameterName: 'OZONE', categoryName: 'Beyond the AQI', siteName: 'CICERO' },
        ],
      },
      {
        reportingArea: 'Chicago',
        dateObserved: '2026-10-08',
        hourObserved: '04:00',
        localTimeZone: 'CDT',
        readings: [
          {
            parameterName: 'PM10',
            aqi: 19,
            categoryName: 'Unhealthy for Sensitive Groups',
            categoryNumber: 3,
          },
        ],
      },
    ]);
    expect(textOf(result)).not.toContain('AQI -1');
    // No agency on any reading: the credit still names the AirNow program.
    expect((result.structuredContent as { attribution: string }).attribution).toContain(
      'U.S. EPA AirNow',
    );
  });

  it('relays an HTTP 200 WebServiceError as an empty result on both surfaces', async () => {
    serve(OBSERVATION_NO_COVERAGE);
    const result = await runToolContract(getAirQualityTool, { latitude: 30, longitude: -150 });
    expect(result.isError).not.toBe(true);
    const upstream =
      'There are no observations available for the requested latitude/longitude: No observations were found for all monitors within 50 miles.';
    const structured = result.structuredContent as { observations: unknown[]; message: string };
    expect(structured.observations).toEqual([]);
    expect(structured.message).toContain(upstream);
    expect(textOf(result)).toContain(upstream);
  });

  it.each([
    { name: 'non-JSON text', body: 'Service temporarily degraded' },
    { name: 'a JSON object without WebServiceError', body: '{"data":[]}' },
    { name: 'a WebServiceError without a message', body: '{"WebServiceError":[{}]}' },
  ])('throws on $name instead of reporting an empty result', async ({ body }) => {
    serve(body);
    const result = await runToolContract(getAirQualityTool, { zip_code: '98101' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.SerializationError },
    });
    expect(http.calls).toHaveLength(1);
  });

  it('rejects an invalid ZIP with the declared reason and names the ZIP', async () => {
    serve(INVALID_ZIP_400, 400);
    const result = await runToolContract(getAirQualityTool, { zip_code: '00000' });
    expect(result.isError).toBe(true);
    const hint = getAirQualityTool.errors?.find((e) => e.reason === 'invalid_zip_code')?.recovery;
    expect(hint).toBeDefined();
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_zip_code', recovery: { hint } },
      },
    });
    const text = textOf(result);
    expect(text).toContain('"00000"');
    expect(text).toContain('Invalid zipCode provided');
    expect(text).toContain('invalid_zip_code');
    expect(text).toContain(hint);
  });
});

describe('AirNow 2026 forecasts (forecast/current/)', () => {
  const seattleReading = (dateValid: string, aqi: number, categoryNumber: number) => ({
    parameterName: 'PM2.5',
    aqi,
    categoryNumber,
    categoryName: categoryNumber === 1 ? 'Good' : 'Moderate',
    dateIssue: '2026-10-07',
    dateValid,
    forecastAgency: 'Puget Sound Clean Air Agency',
    actionDay: false,
  });

  it('returns every issued day with the discussion once per area', async () => {
    serve(FORECAST_98101);
    const result = await runToolContract(getAirQualityTool, {
      zip_code: '98101',
      mode: 'forecast',
    });
    expect(result.isError).not.toBe(true);

    const url = sentUrl();
    expect(url.pathname).toBe('/aq/forecast/current/');
    expect([...url.searchParams.keys()].sort()).toEqual(['API_KEY', 'format', 'zipCode']);

    const structured = result.structuredContent as {
      observations: unknown[];
      attribution: string;
    };
    expect(structured.observations).toEqual([
      {
        reportingArea: 'Seattle-Bellevue-Kent Valley',
        reportingAreaCode: 'wa004',
        stateCode: 'WA',
        discussion: SEATTLE_DISCUSSION,
        readings: [
          seattleReading('2026-10-08', 39, 1),
          seattleReading('2026-10-09', 39, 1),
          seattleReading('2026-10-10', 39, 1),
          seattleReading('2026-10-11', 53, 2),
          seattleReading('2026-10-12', 56, 2),
        ],
      },
    ]);
    expect(structured.attribution).toContain('Puget Sound Clean Air Agency');
    expect(structured.attribution).toContain('U.S. EPA AirNow');
    expect(structured.attribution).toContain('preliminary');

    const text = textOf(result);
    expect(text.split(SEATTLE_DISCUSSION)).toHaveLength(2);
    for (const fragment of [
      'wa004',
      '2026-10-12',
      'issued 2026-10-07',
      'Puget Sound Clean Air Agency',
      'action day: no',
      'U.S. EPA AirNow',
      'preliminary',
    ]) {
      expect(text).toContain(fragment);
    }
  });

  it('filters to the requested forecast_date without sending it upstream', async () => {
    serve(FORECAST_98101);
    const result = await runToolContract(getAirQualityTool, {
      zip_code: '98101',
      mode: 'forecast',
      forecast_date: '2026-10-11',
    });
    expect(result.isError).not.toBe(true);
    expect(sentUrl().searchParams.has('date')).toBe(false);
    expect(result.structuredContent).toMatchObject({
      observations: [
        { discussion: SEATTLE_DISCUSSION, readings: [seattleReading('2026-10-11', 53, 2)] },
      ],
    });
    expect(
      (result.structuredContent as { observations: { readings: unknown[] }[] }).observations[0]!
        .readings,
    ).toHaveLength(1);
  });

  it('returns an empty result listing the issued dates when forecast_date matches none', async () => {
    serve(FORECAST_98101);
    const result = await runToolContract(getAirQualityTool, {
      zip_code: '98101',
      mode: 'forecast',
      forecast_date: '2026-10-20',
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as { observations: unknown[]; message: string };
    expect(structured.observations).toEqual([]);
    const dates = '2026-10-08, 2026-10-09, 2026-10-10, 2026-10-11, 2026-10-12';
    expect(structured.message).toContain('2026-10-20');
    expect(structured.message).toContain(dates);
    expect(textOf(result)).toContain(dates);
  });

  it('serves different forecast_date values from one cached fetch', async () => {
    serve(FORECAST_98101);
    const ctx = toolCtx('forecast-cache');
    const first = await getAirQualityTool.handler(
      parse({ zip_code: '98101', mode: 'forecast', forecast_date: '2026-10-08' }),
      ctx,
    );
    const second = await getAirQualityTool.handler(
      parse({ zip_code: '98101', mode: 'forecast', forecast_date: '2026-10-12' }),
      ctx,
    );
    expect(http.calls).toHaveLength(1);
    expect(first.observations[0]?.readings.map((r) => r.dateValid)).toEqual(['2026-10-08']);
    expect(second.observations[0]?.readings.map((r) => r.dateValid)).toEqual(['2026-10-12']);
  });

  it('renders a category-only forecast without an AQI value', async () => {
    serve(FORECAST_60601_CATEGORY_ONLY);
    const result = await runToolContract(getAirQualityTool, {
      zip_code: '60601',
      mode: 'forecast',
    });
    expect(result.isError).not.toBe(true);
    const [area] = (
      result.structuredContent as {
        observations: { discussion?: string; readings: Record<string, unknown>[] }[];
      }
    ).observations;
    expect(area?.readings).toHaveLength(4);
    for (const reading of area?.readings ?? []) {
      expect(reading).not.toHaveProperty('aqi');
      expect(reading).toMatchObject({ categoryNumber: 1, categoryName: 'Good' });
    }
    expect(area).not.toHaveProperty('discussion');
    const text = textOf(result);
    expect(text).not.toContain('AQI -1');
    expect(text).toContain('Good [category 1]');
    expect(text).not.toContain('Discussion');
  });

  it('groups a multi-area outlook by area with each discussion once', async () => {
    serve(
      JSON.stringify([
        {
          dateIssue: '2026-10-07',
          dateValid: '2026-10-08',
          reportingArea: 'Area A',
          reportingAreaCode: 'xx001',
          stateCode: 'XX',
          parameterName: 'OZONE',
          aqi: 40,
          forecastAgency: 'Agency A',
          categoryNumber: 1,
          categoryName: 'Good',
          actionDay: false,
          discussion: 'Discussion A',
        },
        {
          dateIssue: '2026-10-07',
          dateValid: '2026-10-08',
          reportingArea: 'Area B',
          reportingAreaCode: 'xx002',
          stateCode: 'XX',
          parameterName: 'PM2.5',
          aqi: 110,
          forecastAgency: 'Agency B',
          categoryNumber: 3,
          categoryName: 'Unhealthy for Sensitive Groups',
          actionDay: true,
          discussion: 'Discussion B',
        },
        {
          dateValid: '2026-10-09',
          reportingArea: 'Area A',
          reportingAreaCode: 'xx001',
          parameterName: 'OZONE',
          categoryName: 'Moderate',
        },
      ]),
    );
    const result = await runToolContract(getAirQualityTool, {
      zip_code: '12345',
      mode: 'forecast',
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      observations: { reportingArea: string; discussion?: string; readings: unknown[] }[];
      attribution: string;
    };
    expect(
      structured.observations.map((a) => [a.reportingArea, a.discussion, a.readings.length]),
    ).toEqual([
      ['Area A', 'Discussion A', 2],
      ['Area B', 'Discussion B', 1],
    ]);
    expect(structured.observations[0]?.readings[1]).toEqual({
      parameterName: 'OZONE',
      categoryName: 'Moderate',
      dateValid: '2026-10-09',
    });
    expect(structured.attribution).toContain('Agency A');
    expect(structured.attribution).toContain('Agency B');
    const text = textOf(result);
    expect(text.split('Discussion A')).toHaveLength(2);
    expect(text).toContain('action day: yes');
  });

  it.each([
    {
      name: 'no reporting area at the point',
      body: FORECAST_NO_REPORTING_AREA,
      input: { latitude: 30, longitude: -150, mode: 'forecast' as const },
      upstream: 'Error - There is no reporting area at your searched location',
    },
    {
      name: 'no forecast issued for the area, even with a forecast_date',
      body: FORECAST_NONE_ISSUED_99501,
      input: { zip_code: '99501', mode: 'forecast' as const, forecast_date: '2026-10-09' },
      upstream:
        'Error - There are no current forecasts available for the requested reporting area: Anchorage, AK.',
    },
  ])('relays the upstream WebServiceError: $name', async ({ body, input, upstream }) => {
    serve(body);
    const result = await runToolContract(getAirQualityTool, input);
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as { observations: unknown[]; message: string };
    expect(structured.observations).toEqual([]);
    expect(structured.message).toContain(upstream);
    expect(textOf(result)).toContain(upstream);
  });
});
