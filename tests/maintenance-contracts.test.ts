/**
 * @fileoverview Characterizes EPA domain recovery on both MCP result surfaces.
 * @module tests/maintenance-contracts.test
 */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { getAirQualityTool } from '@/mcp-server/tools/definitions/get-air-quality.tool.js';
import { getEjscreenTool } from '@/mcp-server/tools/definitions/get-ejscreen.tool.js';
import { searchFacilitiesTool } from '@/mcp-server/tools/definitions/search-facilities.tool.js';
import { searchSuperfundTool } from '@/mcp-server/tools/definitions/search-superfund.tool.js';
import { searchViolationsTool } from '@/mcp-server/tools/definitions/search-violations.tool.js';
import { searchWaterSystemsTool } from '@/mcp-server/tools/definitions/search-water-systems.tool.js';

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
