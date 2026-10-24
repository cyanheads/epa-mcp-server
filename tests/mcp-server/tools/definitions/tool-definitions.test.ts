/**
 * @fileoverview Tests for the tool-definition barrel — the core (keyless) vs full
 * tool sets that drive conditional AirNow registration in index.ts.
 * @module tests/mcp-server/tools/definitions/tool-definitions.test
 */

import { describe, expect, it } from 'vitest';
import {
  airnowGetConditionsTool,
  allToolDefinitions,
  coreToolDefinitions,
} from '@/mcp-server/tools/definitions/index.js';

const KEYLESS_TOOL_NAMES = [
  'epa_echo_get_facility',
  'epa_echo_search_facilities',
  'epa_echo_search_violations',
  'epa_ejscreen_get_scores',
  'epa_superfund_search_sites',
  'epa_tri_get_facility_releases',
  'epa_tri_search_releases',
  'epa_water_search_systems',
];

describe('tool definition sets', () => {
  it('core set has the 8 keyless tools and excludes the AirNow-gated air quality tool', () => {
    expect(coreToolDefinitions.map((t) => t.name).sort()).toEqual(KEYLESS_TOOL_NAMES);
    expect(coreToolDefinitions).not.toContain(airnowGetConditionsTool);
  });

  it('full set is the core set plus epa_airnow_get_conditions', () => {
    expect(allToolDefinitions.map((t) => t.name).sort()).toEqual(
      [...KEYLESS_TOOL_NAMES, 'epa_airnow_get_conditions'].sort(),
    );
    expect(allToolDefinitions).toContain(airnowGetConditionsTool);
    for (const t of coreToolDefinitions) {
      expect(allToolDefinitions).toContain(t);
    }
  });
});
