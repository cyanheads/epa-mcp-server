/**
 * @fileoverview Characterizes EPA domain recovery on both MCP result surfaces.
 * @module tests/maintenance-contracts.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAirQualityTool } from '@/mcp-server/tools/definitions/get-air-quality.tool.js';
import { getEjscreenTool } from '@/mcp-server/tools/definitions/get-ejscreen.tool.js';
import { getTriReleasesTool } from '@/mcp-server/tools/definitions/get-tri-releases.tool.js';
import { searchFacilitiesTool } from '@/mcp-server/tools/definitions/search-facilities.tool.js';
import { searchSuperfundTool } from '@/mcp-server/tools/definitions/search-superfund.tool.js';
import { searchTriReleasesTool } from '@/mcp-server/tools/definitions/search-tri-releases.tool.js';
import { searchViolationsTool } from '@/mcp-server/tools/definitions/search-violations.tool.js';
import { searchWaterSystemsTool } from '@/mcp-server/tools/definitions/search-water-systems.tool.js';
import { initDmapService } from '@/services/dmap/dmap-service.js';

describe('TRI successful empty-result recovery', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const tools = [
    { tool: getTriReleasesTool, input: { facility_id: 'NOFACILITY' } },
    { tool: searchTriReleasesTool, input: { state: 'WA' } },
  ];

  function emptyDmap() {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]'));
    initDmapService({} as AppConfig, {} as StorageService);
  }

  for (const { tool, input } of tools) {
    it.each([undefined, 2010, 2024, 2030, 1987])(
      `${tool.name} suggests a changed accepted call, year=%s`,
      async (year) => {
        emptyDmap();
        for (const optional of [false, true]) {
          vi.mocked(fetch).mockImplementation(async () => new Response('[]'));
          const filters = optional
            ? {
                chemical_name: 'NONEXISTENT',
                ...(tool === searchTriReleasesTool && { county: 'NOWHERE' }),
              }
            : {};
          const call = await runToolContract(tool, {
            ...input,
            ...filters,
            ...(year !== undefined && { year }),
          });
          expect(call.isError).toBeFalsy();
          const structured = call.structuredContent as { releases: unknown[]; message: string };
          expect(structured.releases).toEqual([]);
          expect(structured.message).toContain('No TRI releases found');
          const guidance = structured.message.slice(structured.message.indexOf('TRI data lags'));
          const nextYear = year === undefined ? undefined : Math.min(year - 1, 2024);
          if (nextYear !== undefined && nextYear >= 1987)
            expect(guidance).toContain(`try year ${nextYear}`);
          else expect(guidance).not.toMatch(/try year \d+/i);
          if (year !== undefined) expect(guidance).not.toContain(`try year ${year}`);
          expect(guidance.includes('Remove chemical_name')).toBe(optional);
          if (tool === searchTriReleasesTool)
            expect(guidance.includes('Remove county')).toBe(optional);
          else expect(guidance).toContain('triFacilityIds');
          const text = call.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
          expect(text).toContain(structured.message);
        }
      },
    );

    it(`${tool.name} declares no unreachable no_releases_found reason`, () => {
      expect(tool.errors).toBeUndefined();
    });

    it.each([1986, 2031])(
      `${tool.name} keeps invalid year %s outside the handler`,
      async (year) => {
        const request = vi.spyOn(globalThis, 'fetch');
        const call = await runToolContract(tool, { ...input, year });
        expect(call.isError).toBe(true);
        expect(call.structuredContent).toMatchObject({ error: { code: -32602 } });
        expect(request).not.toHaveBeenCalled();
        expect(
          call.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n'),
        ).toContain('year');
      },
    );
  }
});

describe('EPA domain recovery contracts', () => {
  const cases = [
    { tool: searchFacilitiesTool, input: {}, reason: 'no_geographic_filter' },
    { tool: searchFacilitiesTool, input: { latitude: 0 }, reason: 'incomplete_proximity' },
    { tool: searchSuperfundTool, input: {}, reason: 'no_location_filter' },
    { tool: searchSuperfundTool, input: { latitude: 0, longitude: 0 }, reason: 'radius_required' },
    { tool: searchViolationsTool, input: {}, reason: 'no_geographic_filter' },
    { tool: searchWaterSystemsTool, input: {}, reason: 'no_geographic_filter' },
    { tool: getAirQualityTool, input: {}, reason: 'no_location' },
    {
      tool: getAirQualityTool,
      input: { zip_code: '98101', forecast_date: '2026-10-08' },
      reason: 'forecast_date_needs_forecast_mode',
    },
    {
      tool: getEjscreenTool,
      input: { latitude: 0, longitude: 0, distance: 16 },
      reason: 'buffer_too_large',
    },
  ];

  it.each(cases)(
    '$tool.name preserves $reason and its declared recovery',
    async ({ tool, input, reason }) => {
      const result = await runToolContract(tool, input);
      const hint = tool.errors?.find((entry) => entry.reason === reason)?.recovery;
      expect(hint).toBeDefined();
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: -32007, data: { reason, recovery: { hint } } },
      });
      const text = result.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n');
      expect(text).toContain(reason);
      expect(text).toContain(hint);
    },
  );
});
