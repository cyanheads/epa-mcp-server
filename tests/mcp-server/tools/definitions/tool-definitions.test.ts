/**
 * @fileoverview Tests for the tool-definition barrel — the core (keyless) vs full
 * tool sets that drive conditional AirNow registration in index.ts.
 * @module tests/mcp-server/tools/definitions/tool-definitions.test
 */

import { describe, expect, it } from 'vitest';
import {
  allToolDefinitions,
  coreToolDefinitions,
  getAirQualityTool,
} from '@/mcp-server/tools/definitions/index.js';

const KEYLESS_TOOL_NAMES = [
  'epa_get_ejscreen',
  'epa_get_facility',
  'epa_get_tri_releases',
  'epa_search_facilities',
  'epa_search_superfund',
  'epa_search_tri_releases',
  'epa_search_violations',
  'epa_search_water_systems',
];

describe('tool definition sets', () => {
  it('core set has the 8 keyless tools and excludes the AirNow-gated air quality tool', () => {
    expect(coreToolDefinitions.map((t) => t.name).sort()).toEqual(KEYLESS_TOOL_NAMES);
    expect(coreToolDefinitions).not.toContain(getAirQualityTool);
  });

  it('full set is the core set plus epa_get_air_quality', () => {
    expect(allToolDefinitions.map((t) => t.name).sort()).toEqual(
      [...KEYLESS_TOOL_NAMES, 'epa_get_air_quality'].sort(),
    );
    expect(allToolDefinitions).toContain(getAirQualityTool);
    for (const t of coreToolDefinitions) {
      expect(allToolDefinitions).toContain(t);
    }
  });
});
