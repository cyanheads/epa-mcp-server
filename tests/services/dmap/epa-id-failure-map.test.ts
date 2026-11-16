/**
 * @fileoverview Failure map for epa_superfund_get_site's lookup by EPA ID: each upstream failure of
 * the `sems.envirofacts_site` `epa_id` request and the call outcome it produces. A failed site
 * lookup never reads contaminants.
 * @module tests/services/dmap/epa-id-failure-map.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { superfundGetSiteTool } from '@/mcp-server/tools/definitions/superfund-get-site.tool.js';
import { initDmapService } from '@/services/dmap/dmap-service.js';
import { hang } from '../../helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const html = (status: number) =>
  new Response('<!DOCTYPE html><html><body>Access Denied</body></html>', {
    status,
    headers: { 'content-type': 'text/html' },
  });

it.each([
  [
    'a 404',
    () => new Response('Not Found', { status: 404 }),
    JsonRpcErrorCode.NotFound,
    1,
    'HTTP 404',
  ],
  [
    'a 400',
    () => new Response('Bad Request', { status: 400 }),
    JsonRpcErrorCode.InternalError,
    1,
    'HTTP 400',
  ],
  [
    'a 403',
    () => new Response('Forbidden', { status: 403 }),
    JsonRpcErrorCode.Forbidden,
    1,
    'HTTP 403',
  ],
  [
    'a 429',
    () => new Response('Too Many Requests', { status: 429 }),
    JsonRpcErrorCode.RateLimited,
    4,
    'HTTP 429',
  ],
  [
    'a 500',
    () => new Response('We could not process your query', { status: 500 }),
    JsonRpcErrorCode.ServiceUnavailable,
    4,
    'HTTP 500',
  ],
  [
    'a 503',
    () => new Response('Service Unavailable', { status: 503 }),
    JsonRpcErrorCode.ServiceUnavailable,
    4,
    'HTTP 503',
  ],
  [
    'an HTML 200',
    () => html(200),
    JsonRpcErrorCode.ServiceUnavailable,
    4,
    'returned HTML instead of JSON',
  ],
  ['an HTML 500', () => html(500), JsonRpcErrorCode.ServiceUnavailable, 4, 'HTTP 500'],
] as const)(
  'fails the EPA ID lookup on %s from sems.envirofacts_site without reading contaminants',
  async (_, answer, code, attempts, message) => {
    vi.useFakeTimers();
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      urls.push(decodeURIComponent(String(input)));
      return answer();
    });
    initDmapService({} as AppConfig, {} as StorageService);
    const pending = runToolContract(superfundGetSiteTool, { site_id: 'WA0002329803' });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code, message: expect.stringContaining(message) },
    });
    // Only a lookup that returned no row is site_not_found.
    expect(
      (result.structuredContent as { error: { data?: { reason?: string } } }).error.data?.reason,
    ).not.toBe('site_not_found');
    expect(urls).toHaveLength(attempts);
    expect(
      urls.every((url) => url.includes('/sems.envirofacts_site/epa_id/equals/WA0002329803/')),
    ).toBe(true);
  },
);

it('fails the EPA ID lookup as a Timeout when sems.envirofacts_site never answers', async () => {
  vi.useFakeTimers();
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    urls.push(String(input));
    return hang(init?.signal);
  });
  initDmapService({} as AppConfig, {} as StorageService);
  const pending = runToolContract(superfundGetSiteTool, { site_id: 'wa0002329803' });
  await vi.advanceTimersByTimeAsync(50_000);
  const result = await pending;
  expect(result.structuredContent).toMatchObject({
    error: { code: JsonRpcErrorCode.Timeout, data: { reason: 'retry_deadline_exceeded' } },
  });
  expect(urls).toHaveLength(1);
  expect(urls[0]).toContain('/epa_id/equals/WA0002329803/');
  expect(vi.getTimerCount()).toBe(0);
});
