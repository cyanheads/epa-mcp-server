/**
 * @fileoverview AirNow service wire output, caching, and credential isolation.
 * @module tests/services/airnow/airnow-service.test
 */
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAirQualityTool } from '@/mcp-server/tools/definitions/get-air-quality.tool.js';
import { AirNowService, initAirNowService } from '@/services/airnow/airnow-service.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    airNowApiKey: 'synthetic-secret',
    airNowBaseUrl: 'https://airnow.example/aq',
  }),
}));

beforeEach(() => initAirNowService({} as AppConfig, {} as StorageService));
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('AirNow service', () => {
  it('preserves nested readings on both surfaces and reuses tenant storage', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            ReportingArea: 'Seattle',
            DateObserved: '2026-09-19',
            ParameterName: 'PM2.5',
            AQI: 42,
            Category: { Number: 1, Name: 'Good' },
          },
          { ReportingArea: 'Seattle', DateObserved: '2026-09-19', ParameterName: 'Ozone', AQI: 30 },
        ]),
      ),
    );
    const result = await runToolContract(getAirQualityTool, { zip_code: '98101' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      observations: [{ readings: [{ aqi: 42 }, { aqi: 30 }] }],
    });
    expect(JSON.stringify(result.content)).toContain('PM2.5');
    expect(JSON.stringify(result.content)).toContain('AQI 30');
    expect(String(fetch.mock.calls[0]?.[0])).toContain('API_KEY=synthetic-secret');
    fetch.mockClear().mockImplementation(async () => new Response('[]'));
    const service = new AirNowService({} as AppConfig, {} as StorageService);
    const ctx = createMockContext({ tenantId: 'cache-test' });
    expect(await service.getCurrentByZip({ zipCode: '98101' }, ctx)).toEqual([]);
    expect(await service.getCurrentByZip({ zipCode: '98101' }, ctx)).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 403, body: 'Forbidden', code: JsonRpcErrorCode.Forbidden },
    { status: 200, body: '<html>Unavailable</html>', code: JsonRpcErrorCode.ServiceUnavailable },
  ])(
    'does not expose the credential-bearing URL on $status errors',
    async ({ status, body, code }) => {
      vi.useFakeTimers();
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(body, { status }));
      const pending = runToolContract(getAirQualityTool, { zip_code: '98101' });
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code } });
      expect(JSON.stringify(result.content)).toContain('AirNow');
      expect(globalThis.fetch).toHaveBeenCalledTimes(status === 403 ? 1 : 4);
      expect(JSON.stringify(result.structuredContent)).not.toContain('synthetic-secret');
      expect(JSON.stringify(result.content)).not.toContain('synthetic-secret');
      expect(JSON.stringify(result)).not.toContain('API_KEY');
    },
  );
});
