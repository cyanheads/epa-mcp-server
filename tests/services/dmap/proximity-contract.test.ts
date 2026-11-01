/**
 * @fileoverview Superfund proximity planning, input and coverage contracts at the fetch boundary.
 * @module tests/services/dmap/proximity-contract.test
 */
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { superfundSearchSitesTool as tool } from '@/mcp-server/tools/definitions/superfund-search-sites.tool.js';
import { DmapService, initDmapService } from '@/services/dmap/dmap-service.js';

const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
const coverage =
  'Proximity searches match only sites with usable coordinates. Administrative searches can also find sites without coordinates.';
describe('Superfund proximity contracts', () => {
  it('puts schema coordinate rejection on both surfaces without starting I/O', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const result = await runToolContract(tool, { state: 'WA', longitude: 181 });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(textOf(result)).toContain('longitude');
    expect(fetch).not.toHaveBeenCalled();
    expect(timer).not.toHaveBeenCalled();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it.each([
    { latitude: 0 },
    { longitude: 0 },
    { radius_miles: 1 },
    { latitude: 0, radius_miles: 1 },
    { longitude: 0, radius_miles: 1 },
  ])('rejects incomplete proximity before administrative fallback: %j', async (partial) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json([]));
    const timer = vi.spyOn(globalThis, 'setTimeout');
    initDmapService({} as AppConfig, {} as StorageService);
    for (const admin of [{}, { state: 'WA' }]) {
      const result = await runToolContract(tool, { ...partial, ...admin });
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'incomplete_proximity',
            recovery: { hint: expect.stringContaining('latitude') },
          },
        },
      });
      expect(textOf(result)).toContain('incomplete_proximity');
      expect(textOf(result)).toContain('radius_miles');
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(timer).not.toHaveBeenCalled();
  });
  it.each([
    { rows: [] },
    {
      rows: [
        {
          site_id: 'NEAR',
          name: 'Near',
          primary_latitude_decimal_val: '39.5',
          primary_longitude_decimal_val: '-98.35',
        },
      ],
    },
  ])('discloses coordinate coverage on both surfaces: %j', async ({ rows }) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(rows));
    initDmapService({} as AppConfig, {} as StorageService);
    const result = await runToolContract(tool, {
      latitude: 39.5,
      longitude: -98.35,
      radius_miles: 1,
      limit: 1,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ notice: expect.stringContaining(coverage) });
    expect(textOf(result)).toContain(coverage);
  });
  it('uses bounded latitude partitions for broad searches and awaits all work', async () => {
    let active = 0;
    let peak = 0;
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      urls.push(String(input));
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return Response.json([]);
    });
    const service = new DmapService({} as AppConfig, {} as StorageService);
    expect(
      await service.searchSuperfund(
        { latitude: 39.5, longitude: -98.35, radiusMiles: 500 },
        createMockContext(),
      ),
    ).toEqual([]);
    expect(urls).toHaveLength(15);
    expect(urls.every((url) => !url.includes('/primary_longitude_decimal_val/'))).toBe(true);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    expect(active).toBe(0);
  });
  it.each([400, 429, 503, 'malformed'] as const)(
    'settles sibling requests after fatal upstream %s',
    async (status) => {
      vi.useFakeTimers();
      let attempts = 0,
        active = 0,
        aborted = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        attempts++;
        if (attempts === 1)
          return status === 'malformed' ? new Response('{') : new Response('failure', { status });
        active++;
        try {
          await new Promise<void>((_resolve, reject) =>
            init!.signal!.addEventListener(
              'abort',
              () => {
                aborted++;
                reject(init!.signal!.reason);
              },
              { once: true },
            ),
          );
        } finally {
          active--;
        }
        return Response.json([]);
      });
      initDmapService({} as AppConfig, {} as StorageService);
      const pending = runToolContract(tool, {
        latitude: 39.5,
        longitude: -98.35,
        radius_miles: 500,
      });
      await vi.advanceTimersByTimeAsync(55_000);
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(result.structuredContent).not.toHaveProperty('sites');
      expect(textOf(result)).toContain('Error');
      expect(active).toBe(0);
      expect(aborted).toBeGreaterThan(0);
      expect(attempts).toBeLessThanOrEqual(11);
    },
  );
  it('exhausts broad pages before ranking, including an empty page past the end', async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      urls.push(url);
      if (!url.includes('/beginsWith/39/')) return Response.json([]);
      if (url.includes('/1:2000/'))
        return Response.json(
          Array.from({ length: 2000 }, (_, i) => ({
            site_id: `F${i}`,
            name: 'Far',
            primary_latitude_decimal_val: '39',
            primary_longitude_decimal_val: '0',
          })),
        );
      if (url.includes('/2001:4000/'))
        return Response.json(
          Array.from({ length: 2000 }, (_, i) => ({
            site_id: `N${i}`,
            name: 'Near',
            primary_latitude_decimal_val: '39.5',
            primary_longitude_decimal_val: '-98.35',
          })),
        );
      return Response.json([]);
    });
    initDmapService({} as AppConfig, {} as StorageService);
    const result = await runToolContract(tool, {
      latitude: 39.5,
      longitude: -98.35,
      radius_miles: 150,
      limit: 1,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      sites: [{ siteId: 'N0' }],
      notice: expect.stringContaining('nearest 1 of 2000'),
    });
    expect(textOf(result)).toContain('nearest 1 of 2000');
    expect(textOf(result)).toContain(coverage);
    expect(
      urls.filter((url) => url.includes('/beginsWith/39/')).map((url) => url.split('/').at(-2)),
    ).toEqual(['1:2000', '2001:4000', '4001:6000']);
  });
  it('cancels every started broad partition without scheduling another one', async () => {
    const controller = new AbortController();
    let active = 0;
    let starts = 0;
    let aborted = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      starts++;
      active++;
      const pending = new Promise<Response>((_resolve, reject) =>
        init!.signal!.addEventListener(
          'abort',
          () => {
            aborted++;
            active--;
            reject(init!.signal!.reason);
          },
          { once: true },
        ),
      );
      if (starts === 8) controller.abort();
      return pending;
    });
    initDmapService({} as AppConfig, {} as StorageService);
    const result = await runToolContract(
      tool,
      { latitude: 39.5, longitude: -98.35, radius_miles: 500 },
      { context: { signal: controller.signal } },
    );
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(result.structuredContent).not.toHaveProperty('sites');
    expect(textOf(result)).toMatch(/abort/i);
    expect(starts).toBe(8);
    expect(aborted).toBe(8);
    expect(active).toBe(0);
  });
});
