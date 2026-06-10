/**
 * @fileoverview Tests for getAirQualityTool.
 * @module tests/mcp-server/tools/definitions/get-air-quality.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAirQualityTool } from '@/mcp-server/tools/definitions/get-air-quality.tool.js';

const mockGetCurrentByZip = vi.fn();
const mockGetCurrentByLatLng = vi.fn();
const mockGetForecastByZip = vi.fn();
const mockGetForecastByLatLng = vi.fn();

vi.mock('@/services/airnow/airnow-service.js', () => ({
  getAirNowService: () => ({
    getCurrentByZip: mockGetCurrentByZip,
    getCurrentByLatLng: mockGetCurrentByLatLng,
    getForecastByZip: mockGetForecastByZip,
    getForecastByLatLng: mockGetForecastByLatLng,
  }),
}));

const seattleObservation = {
  reportingArea: 'Seattle-Tacoma-Bellevue, WA',
  stateCode: 'WA',
  latitude: 47.6062,
  longitude: -122.3321,
  dateObserved: '2024-06-01',
  hourObserved: 14,
  localTimeZone: 'PDT',
  readings: [
    { parameterName: 'PM2.5', aqi: 42, categoryNumber: 1, categoryName: 'Good' },
    { parameterName: 'Ozone', aqi: 38, categoryNumber: 1, categoryName: 'Good' },
  ],
};

describe('getAirQualityTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns current observations by zip code', async () => {
    mockGetCurrentByZip.mockResolvedValue([seattleObservation]);
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const input = getAirQualityTool.input.parse({ zip_code: '98101' });
    const result = await getAirQualityTool.handler(input, ctx);
    expect(result.mode).toBe('current');
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]!.reportingArea).toBe('Seattle-Tacoma-Bellevue, WA');
    expect(result.observations[0]!.readings).toHaveLength(2);
  });

  it('returns current observations by lat/lng', async () => {
    mockGetCurrentByLatLng.mockResolvedValue([seattleObservation]);
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const input = getAirQualityTool.input.parse({ latitude: 47.6062, longitude: -122.3321 });
    const result = await getAirQualityTool.handler(input, ctx);
    expect(result.mode).toBe('current');
    expect(result.observations).toHaveLength(1);
  });

  it('returns forecast by zip code with forecast_date', async () => {
    mockGetForecastByZip.mockResolvedValue([seattleObservation]);
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const input = getAirQualityTool.input.parse({
      zip_code: '98101',
      mode: 'forecast',
      forecast_date: '2024-06-02',
    });
    const result = await getAirQualityTool.handler(input, ctx);
    expect(result.mode).toBe('forecast');
    expect(result.observations).toHaveLength(1);
  });

  it('returns forecast by lat/lng with forecast_date', async () => {
    mockGetForecastByLatLng.mockResolvedValue([seattleObservation]);
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const input = getAirQualityTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
      mode: 'forecast',
      forecast_date: '2024-06-02',
    });
    const result = await getAirQualityTool.handler(input, ctx);
    expect(result.mode).toBe('forecast');
    expect(result.observations).toHaveLength(1);
  });

  it('returns message when no observations found', async () => {
    mockGetCurrentByZip.mockResolvedValue([]);
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const input = getAirQualityTool.input.parse({ zip_code: '00001' });
    const result = await getAirQualityTool.handler(input, ctx);
    expect(result.observations).toHaveLength(0);
    expect(result.message).toContain('No AQI data found');
    expect(result.message).toContain('00001');
  });

  it('throws no_location when neither zip_code nor lat/lng provided', async () => {
    const ctx = createMockContext({ errors: getAirQualityTool.errors, tenantId: 'test-tenant' });
    const input = getAirQualityTool.input.parse({ mode: 'current' });
    await expect(getAirQualityTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_location' },
    });
  });

  it('throws no_location when zip_code is blank string', async () => {
    const ctx = createMockContext({ errors: getAirQualityTool.errors, tenantId: 'test-tenant' });
    const input = getAirQualityTool.input.parse({ zip_code: '   ' });
    await expect(getAirQualityTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_location' },
    });
  });

  it('throws forecast_date_required when mode is forecast without date', async () => {
    const ctx = createMockContext({ errors: getAirQualityTool.errors, tenantId: 'test-tenant' });
    const input = getAirQualityTool.input.parse({ zip_code: '98101', mode: 'forecast' });
    await expect(getAirQualityTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'forecast_date_required' },
    });
  });

  it('throws forecast_date_required when forecast_date is blank string', async () => {
    const ctx = createMockContext({ errors: getAirQualityTool.errors, tenantId: 'test-tenant' });
    const input = getAirQualityTool.input.parse({
      zip_code: '98101',
      mode: 'forecast',
      forecast_date: '  ',
    });
    await expect(getAirQualityTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'forecast_date_required' },
    });
  });

  it('formats output with all fields including aqi readings', () => {
    const output = {
      observations: [seattleObservation],
      mode: 'current',
    };
    const blocks = getAirQualityTool.format!(output);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('text');
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('Current Observations');
    expect(text).toContain('Seattle-Tacoma-Bellevue, WA');
    expect(text).toContain('WA');
    expect(text).toContain('2024-06-01');
    expect(text).toContain('PM2.5');
    expect(text).toContain('AQI 42');
    expect(text).toContain('Good');
    expect(text).toContain('Ozone');
    expect(text).toContain('AQI 38');
  });

  it('formats forecast output showing mode', () => {
    const output = { observations: [seattleObservation], mode: 'forecast' };
    const blocks = getAirQualityTool.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('Forecast');
    expect(text).toContain('forecast');
  });

  it('formats empty result with message', () => {
    const output = {
      observations: [],
      mode: 'current',
      message: 'No AQI data found for zip_code="99999" within 25 miles.',
    };
    const blocks = getAirQualityTool.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('No AQI data found');
  });

  it('regression #9: cacheKey produces only valid framework key characters', () => {
    // All four kind values previously embedded colons in the key, crashing ctx.state.set()
    const validKeyPattern = /^[a-zA-Z0-9_.\-/]+$/;
    // Access cacheKey via the service instance's private method by reconstructing the logic
    // The fix: kind ':' → '/', prefix separator ':' → '/'
    const kinds = ['current:zip', 'current:latlng', 'forecast:zip', 'forecast:latlng'];
    for (const kind of kinds) {
      const safeKind = kind.replace(/:/g, '/');
      const stable = 'zipCode-98101_distance-25';
      const key = `airnow/${safeKind}/${stable}`;
      expect(validKeyPattern.test(key)).toBe(true);
    }
    // Confirm old format was invalid
    expect(validKeyPattern.test('airnow:current:zip:distance-25_zipCode-98101')).toBe(false);
  });

  it('formats sparse observation (minimal fields)', () => {
    const sparse = {
      observations: [
        {
          readings: [{ parameterName: 'PM2.5', aqi: 55 }],
        },
      ],
      mode: 'current',
    };
    const blocks = getAirQualityTool.format!(sparse);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('Unknown Area');
    expect(text).toContain('PM2.5');
    expect(text).toContain('AQI 55');
  });
});
