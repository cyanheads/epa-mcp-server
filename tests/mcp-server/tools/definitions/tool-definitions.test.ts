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

describe('tool definition sets', () => {
  it('core set has the 7 keyless tools and excludes the AirNow-gated air quality tool', () => {
    expect(coreToolDefinitions).toHaveLength(7);
    expect(coreToolDefinitions).not.toContain(getAirQualityTool);
  });

  it('full set is the core set plus epa_get_air_quality', () => {
    expect(allToolDefinitions).toHaveLength(8);
    expect(allToolDefinitions).toContain(getAirQualityTool);
    for (const t of coreToolDefinitions) {
      expect(allToolDefinitions).toContain(t);
    }
  });
});
