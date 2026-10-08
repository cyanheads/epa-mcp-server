/**
 * @fileoverview Tests for getAirQualityTool: input contract, location routing,
 * forecast_date filtering, and format(). Upstream normalization is covered against
 * captured AirNow bodies in tests/services/airnow/airnow-service.test.ts.
 * @module tests/mcp-server/tools/definitions/get-air-quality.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAirQualityTool } from '@/mcp-server/tools/definitions/get-air-quality.tool.js';

const mockGetCurrent = vi.fn();
const mockGetForecast = vi.fn();

vi.mock('@/services/airnow/airnow-service.js', () => ({
  getAirNowService: () => ({ getCurrent: mockGetCurrent, getForecast: mockGetForecast }),
}));

const seattleObservation = {
  reportingArea: 'Seattle-Bellevue-Kent Valley',
  dateObserved: '2026-10-08',
  hourObserved: '03:00',
  localTimeZone: 'PDT',
  readings: [
    {
      parameterName: 'PM2.5',
      aqi: 62,
      categoryNumber: 2,
      categoryName: 'Moderate',
      siteName: 'Seattle-10th & Weller',
      siteID: '530330030',
      reportingAgency: 'Washington Department of Ecology',
    },
    {
      parameterName: 'OZONE',
      aqi: 0,
      categoryNumber: 1,
      categoryName: 'Good',
      siteName: 'Seattle-Beacon Hill',
      siteID: '530330080',
      reportingAgency: 'Washington Department of Ecology',
    },
  ],
};

const forecastReading = (dateValid: string, extra: Record<string, unknown> = {}) => ({
  parameterName: 'PM2.5',
  aqi: 39,
  categoryNumber: 1,
  categoryName: 'Good',
  dateIssue: '2026-10-07',
  dateValid,
  forecastAgency: 'Puget Sound Clean Air Agency',
  actionDay: false,
  ...extra,
});

const forecastAreas = [
  {
    reportingArea: 'Seattle-Bellevue-Kent Valley',
    reportingAreaCode: 'wa004',
    stateCode: 'WA',
    discussion: 'Expect GOOD to MODERATE air quality.',
    readings: [forecastReading('2026-10-08'), forecastReading('2026-10-09')],
  },
  {
    reportingArea: 'Tacoma',
    reportingAreaCode: 'wa005',
    stateCode: 'WA',
    readings: [forecastReading('2026-10-09', { forecastAgency: 'Tacoma Agency' })],
  },
];

const ctx = () => createMockContext({ errors: getAirQualityTool.errors, tenantId: 'test-tenant' });
const textOf = (blocks: { type: string; text?: string }[]) =>
  blocks.map((block) => block.text ?? '').join('\n');

describe('getAirQualityTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes a ZIP to current observations', async () => {
    mockGetCurrent.mockResolvedValue({ areas: [seattleObservation] });
    const context = ctx();
    const result = await getAirQualityTool.handler(
      getAirQualityTool.input.parse({ zip_code: '98101' }),
      context,
    );
    expect(mockGetCurrent).toHaveBeenCalledWith({ kind: 'zip', zipCode: '98101' }, context);
    expect(mockGetForecast).not.toHaveBeenCalled();
    expect(result.mode).toBe('current');
    expect(result.observations).toEqual([seattleObservation]);
    expect(result.message).toBeUndefined();
    // One credit per agency (deduplicated), then the program and the preliminary-data notice.
    expect(result.attribution).toBe(
      'Data courtesy of Washington Department of Ecology and the U.S. EPA AirNow program (www.airnow.gov). AirNow data are preliminary and unverified; do not use them for regulatory, trend, or enforcement decisions.',
    );
  });

  it('routes latitude/longitude to current observations', async () => {
    mockGetCurrent.mockResolvedValue({ areas: [seattleObservation] });
    await getAirQualityTool.handler(
      getAirQualityTool.input.parse({ latitude: 47.6, longitude: -122.33 }),
      ctx(),
    );
    expect(mockGetCurrent).toHaveBeenCalledWith(
      { kind: 'latlng', latitude: 47.6, longitude: -122.33 },
      expect.anything(),
    );
  });

  it('trims a padded zip_code before it reaches the service', async () => {
    mockGetCurrent.mockResolvedValue({ areas: [seattleObservation] });
    await getAirQualityTool.handler(getAirQualityTool.input.parse({ zip_code: ' 98101 ' }), ctx());
    expect(mockGetCurrent).toHaveBeenCalledWith(
      { kind: 'zip', zipCode: '98101' },
      expect.anything(),
    );
  });

  it('falls through to latitude/longitude when zip_code is whitespace only', async () => {
    mockGetCurrent.mockResolvedValue({ areas: [seattleObservation] });
    await getAirQualityTool.handler(
      getAirQualityTool.input.parse({ zip_code: '   ', latitude: 47.6, longitude: -122.33 }),
      ctx(),
    );
    expect(mockGetCurrent).toHaveBeenCalledWith(
      { kind: 'latlng', latitude: 47.6, longitude: -122.33 },
      expect.anything(),
    );
  });

  it('returns the whole forecast outlook when forecast_date is omitted or blank', async () => {
    mockGetForecast.mockResolvedValue({ areas: forecastAreas });
    for (const raw of [{}, { forecast_date: '  ' }]) {
      const result = await getAirQualityTool.handler(
        getAirQualityTool.input.parse({ zip_code: '98101', mode: 'forecast', ...raw }),
        ctx(),
      );
      expect(result.mode).toBe('forecast');
      expect(result.observations).toEqual(forecastAreas);
    }
    expect(mockGetForecast).toHaveBeenCalledWith(
      { kind: 'zip', zipCode: '98101' },
      expect.anything(),
    );
  });

  it('filters readings across every area and drops areas with no match', async () => {
    mockGetForecast.mockResolvedValue({ areas: forecastAreas });
    const result = await getAirQualityTool.handler(
      getAirQualityTool.input.parse({
        latitude: 47.4,
        longitude: -122.4,
        mode: 'forecast',
        forecast_date: '2026-10-09',
      }),
      ctx(),
    );
    expect(result.observations).toEqual([
      { ...forecastAreas[0], readings: [forecastReading('2026-10-09')] },
      forecastAreas[1],
    ]);
    expect(result.attribution).toContain('Puget Sound Clean Air Agency');
    expect(result.attribution).toContain('Tacoma Agency');

    const onlyFirst = await getAirQualityTool.handler(
      getAirQualityTool.input.parse({
        zip_code: '98101',
        mode: 'forecast',
        forecast_date: '2026-10-08',
      }),
      ctx(),
    );
    expect(onlyFirst.observations.map((area) => area.reportingArea)).toEqual([
      'Seattle-Bellevue-Kent Valley',
    ]);
    // Attribution credits only the agencies behind what is returned.
    expect(onlyFirst.attribution).not.toContain('Tacoma Agency');
  });

  it('lists the issued dates when forecast_date matches nothing', async () => {
    mockGetForecast.mockResolvedValue({ areas: forecastAreas });
    const result = await getAirQualityTool.handler(
      getAirQualityTool.input.parse({
        zip_code: '98101',
        mode: 'forecast',
        forecast_date: '2027-01-01',
      }),
      ctx(),
    );
    expect(result.observations).toEqual([]);
    // 2026-10-09 is issued by both areas and listed once.
    expect(result.message).toBe(
      'No forecast valid on 2027-01-01 for zip_code="98101". Issued forecast dates: 2026-10-08, 2026-10-09. Omit forecast_date to get every issued day.',
    );
  });

  it('prefers the upstream no-data message over the date list', async () => {
    mockGetForecast.mockResolvedValue({
      areas: [],
      noDataMessage: 'Error - There is no reporting area at your searched location',
    });
    const result = await getAirQualityTool.handler(
      getAirQualityTool.input.parse({
        latitude: 30,
        longitude: -150,
        mode: 'forecast',
        forecast_date: '2026-10-09',
      }),
      ctx(),
    );
    expect(result.observations).toEqual([]);
    expect(result.message).toBe(
      'AirNow returned no data for latitude=30, longitude=-150: "Error - There is no reporting area at your searched location"',
    );
  });

  it('explains an empty upstream array', async () => {
    mockGetCurrent.mockResolvedValue({ areas: [] });
    const result = await getAirQualityTool.handler(
      getAirQualityTool.input.parse({ zip_code: '00001' }),
      ctx(),
    );
    expect(result.observations).toHaveLength(0);
    expect(result.message).toBe(
      'No AQI data found for zip_code="00001". AirNow observations come from monitors within 50 miles and forecasts from the location\'s reporting area; check that the location is in the US, or try a nearby ZIP code.',
    );
    expect(result.message).not.toContain('distance_miles');
    expect(result.attribution).toMatch(/^Data courtesy of the U\.S\. EPA AirNow program/);
  });

  it('throws no_location when neither zip_code nor lat/lng provided', async () => {
    await expect(
      getAirQualityTool.handler(getAirQualityTool.input.parse({ mode: 'current' }), ctx()),
    ).rejects.toMatchObject({ data: { reason: 'no_location' } });
  });

  it('throws no_location when zip_code is blank string', async () => {
    await expect(
      getAirQualityTool.handler(getAirQualityTool.input.parse({ zip_code: '   ' }), ctx()),
    ).rejects.toMatchObject({ data: { reason: 'no_location' } });
  });

  it('rejects a stale distance_miles argument by name', async () => {
    // A pre-removal caller's arguments; the cast bypasses the compile-time check only.
    const stale = { zip_code: '98101', distance_miles: 25 } as { zip_code: string };
    const result = await runToolContract(getAirQualityTool, stale);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
    });
    expect(textOf(result.content as { type: string; text?: string }[])).toContain('distance_miles');
    expect(mockGetCurrent).not.toHaveBeenCalled();
  });

  it('rejects forecast_date in current mode instead of ignoring it', async () => {
    await expect(
      getAirQualityTool.handler(
        getAirQualityTool.input.parse({ zip_code: '98101', forecast_date: '2026-10-09' }),
        ctx(),
      ),
    ).rejects.toMatchObject({ data: { reason: 'forecast_date_needs_forecast_mode' } });
    expect(mockGetCurrent).not.toHaveBeenCalled();
  });

  it('accepts a blank forecast_date in current mode', async () => {
    mockGetCurrent.mockResolvedValue({ areas: [seattleObservation] });
    const result = await getAirQualityTool.handler(
      getAirQualityTool.input.parse({ zip_code: '98101', forecast_date: '  ' }),
      ctx(),
    );
    expect(result.observations).toEqual([seattleObservation]);
  });

  it('declares invalid_zip_code and no longer declares forecast_date_required', () => {
    const reasons = getAirQualityTool.errors?.map((entry) => entry.reason);
    expect(reasons).toEqual([
      'no_location',
      'forecast_date_needs_forecast_mode',
      'invalid_zip_code',
    ]);
    expect(getAirQualityTool.errors?.[1]).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
    });
  });

  it('formats observations with site, agency, time, and attribution', () => {
    const output = {
      observations: [seattleObservation],
      mode: 'current',
      attribution:
        'Data courtesy of Washington Department of Ecology and the U.S. EPA AirNow program.',
    };
    const lines = textOf(
      getAirQualityTool.format!(output) as { type: string; text?: string }[],
    ).split('\n');
    for (const line of [
      '## Air Quality Index — Current Observations (mode: current)',
      '### Seattle-Bellevue-Kent Valley',
      '**Observed:** 2026-10-08 at 03:00 PDT',
      '- **PM2.5:** AQI 62 (Moderate) [category 2] — Seattle-10th & Weller, site 530330030 · Washington Department of Ecology',
      '- **OZONE:** AQI 0 (Good) [category 1] — Seattle-Beacon Hill, site 530330080 · Washington Department of Ecology',
      '**Source:** Data courtesy of Washington Department of Ecology and the U.S. EPA AirNow program.',
    ]) {
      expect(lines).toContain(line);
    }
  });

  it('formats a forecast with per-day readings and the discussion once', () => {
    const output = {
      observations: [
        {
          ...forecastAreas[0],
          readings: [
            forecastReading('2026-10-08'),
            forecastReading('2026-10-09', { aqi: undefined, actionDay: true }),
          ],
        },
      ],
      mode: 'forecast',
      attribution: 'Forecasts issued by Puget Sound Clean Air Agency.',
    };
    const text = textOf(getAirQualityTool.format!(output) as { type: string; text?: string }[]);
    const lines = text.split('\n');
    for (const line of [
      '## Air Quality Index — Forecast (mode: forecast)',
      '**State:** WA | **Reporting area code:** wa004',
      '- **2026-10-08 PM2.5:** AQI 39 (Good) [category 1] · issued 2026-10-07 by Puget Sound Clean Air Agency · action day: no',
      '- **2026-10-09 PM2.5:** Good [category 1] (category only, no AQI number) · issued 2026-10-07 by Puget Sound Clean Air Agency · action day: yes',
      '**Discussion:**',
      '**Source:** Forecasts issued by Puget Sound Clean Air Agency.',
    ]) {
      expect(lines).toContain(line);
    }
    expect(text.split('Expect GOOD to MODERATE air quality.')).toHaveLength(2);
    expect(text).not.toContain('AQI undefined');
  });

  it('formats an empty result with its message', () => {
    const lines = textOf(
      getAirQualityTool.format!({
        observations: [],
        mode: 'current',
        message: 'No AQI data found for zip_code="99999".',
        attribution: 'Data courtesy of the U.S. EPA AirNow program.',
      }) as { type: string; text?: string }[],
    ).split('\n');
    expect(lines).toContain('> No AQI data found for zip_code="99999".');
    expect(lines).toContain('**Source:** Data courtesy of the U.S. EPA AirNow program.');
  });

  it('formats a sparse observation (minimal fields)', () => {
    const lines = textOf(
      getAirQualityTool.format!({
        observations: [{ readings: [{ parameterName: 'PM2.5', aqi: 55 }] }],
        mode: 'current',
        attribution: 'Data courtesy of the U.S. EPA AirNow program.',
      }) as { type: string; text?: string }[],
    ).split('\n');
    expect(lines).toContain('### Unknown Area');
    // No category, site, or agency: the reading line ends at the AQI value.
    expect(lines).toContain('- **PM2.5:** AQI 55');
  });
});
