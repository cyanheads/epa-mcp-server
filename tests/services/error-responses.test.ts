/**
 * @fileoverview Upstream error classification and client-visible URL isolation.
 * @module tests/services/error-responses.test
 */
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEjscreenTool } from '@/mcp-server/tools/definitions/get-ejscreen.tool.js';
import { searchFacilitiesTool } from '@/mcp-server/tools/definitions/search-facilities.tool.js';
import { searchWaterSystemsTool } from '@/mcp-server/tools/definitions/search-water-systems.tool.js';
import { initDmapService } from '@/services/dmap/dmap-service.js';
import { initEchoService } from '@/services/echo/echo-service.js';
import { initEjscreenService } from '@/services/ejscreen/ejscreen-service.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    echoBaseUrl: 'https://example.com/private-echo',
    dmapBaseUrl: 'https://example.com/private-dmap',
    ejscreenBaseUrl: 'https://example.com/private-ejam',
  }),
}));
beforeEach(() => {
  vi.useFakeTimers();
  initEchoService({} as AppConfig, {} as StorageService);
  initDmapService({} as AppConfig, {} as StorageService);
  initEjscreenService({} as AppConfig, {} as StorageService);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('service errors', () => {
  it.each([
    {
      name: 'ECHO HTTP',
      call: () => runToolContract(searchFacilitiesTool, { state: 'WA' }),
      base: 'https://example.com/private-echo/',
      status: 403,
      body: 'Forbidden',
      code: JsonRpcErrorCode.Forbidden,
      message: 'ECHO returned HTTP 403.',
    },
    {
      name: 'ECHO HTML',
      call: () => runToolContract(searchFacilitiesTool, { state: 'WA' }),
      base: 'https://example.com/private-echo/',
      status: 200,
      body: '<html>Unavailable</html>',
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'ECHO API returned HTML instead of JSON',
    },
    {
      name: 'ECHO error payload',
      call: () => runToolContract(searchFacilitiesTool, { state: 'WA' }),
      base: 'https://example.com/private-echo/',
      status: 200,
      body: '{"Results":{"Error":{"ErrorMessage":"Unavailable"}}}',
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'ECHO API error: Unavailable',
    },
    {
      name: 'DMAP HTTP',
      call: () => runToolContract(searchWaterSystemsTool, { state: 'WA' }),
      base: 'https://example.com/private-dmap/',
      status: 403,
      body: 'Forbidden',
      code: JsonRpcErrorCode.Forbidden,
      message: 'DMAP returned HTTP 403.',
    },
    {
      name: 'DMAP HTML',
      call: () => runToolContract(searchWaterSystemsTool, { state: 'WA' }),
      base: 'https://example.com/private-dmap/',
      status: 200,
      body: '<html>Unavailable</html>',
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'DMAP API returned HTML instead of JSON',
    },
    {
      name: 'EJAM HTTP',
      call: () => runToolContract(getEjscreenTool, { latitude: 40, longitude: -75 }),
      base: 'https://example.com/private-ejam/',
      status: 403,
      body: 'Forbidden',
      code: JsonRpcErrorCode.Forbidden,
      message: 'EJAM returned HTTP 403.',
    },
    {
      name: 'EJAM HTML',
      call: () => runToolContract(getEjscreenTool, { latitude: 40, longitude: -75 }),
      base: 'https://example.com/private-ejam/',
      status: 200,
      body: '<html>Unavailable</html>',
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'EJAM API returned HTML instead of JSON',
    },
    {
      name: 'EJAM empty',
      call: () => runToolContract(getEjscreenTool, { latitude: 40, longitude: -75 }),
      base: 'https://example.com/private-ejam/',
      status: 200,
      body: '[]',
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'EJAM API returned an empty response.',
    },
  ])(
    'classifies $name without forwarding the request URL',
    async ({ call, base, status, body, code, message }) => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => new Response(body, { status }));
      const pending = call();
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code } });
      expect(JSON.stringify(result.content)).toContain(`Error: ${message}`);

      // The configured base URL was really on the wire, so its absence from the result means
      // the error surfaces dropped it rather than never having seen it.
      const requested = fetchSpy.mock.calls.map(([input]) => String(input));
      expect(requested.length).toBeGreaterThan(0);
      for (const url of requested) {
        expect(url.startsWith(base)).toBe(true);
        expect(JSON.stringify(result)).not.toContain(new URL(url).host + new URL(url).pathname);
      }
      expect(JSON.stringify(result)).not.toContain('https://example.com/private-');
    },
  );

  it('retains EJAM domain rejection and its recovery on both surfaces', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":["Invalid coordinates"]}', { status: 400 }),
    );
    const result = await runToolContract(getEjscreenTool, { latitude: 40, longitude: -75 });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'upstream_rejected',
          recovery: { hint: expect.stringContaining('latitude and longitude') },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('Invalid coordinates');
    expect(JSON.stringify(result.content)).toContain('latitude and longitude');
    expect(JSON.stringify(result.content)).toContain('upstream_rejected');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
