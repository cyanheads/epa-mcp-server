/**
 * @fileoverview Barrel export for all EPA MCP server tool definitions.
 * @module mcp-server/tools/definitions/index
 */

export { getAirQualityTool } from './get-air-quality.tool.js';
export { getEjscreenTool } from './get-ejscreen.tool.js';
export { getFacilityTool } from './get-facility.tool.js';
export { getTriReleasesTool } from './get-tri-releases.tool.js';
export { searchFacilitiesTool } from './search-facilities.tool.js';
export { searchSuperfundTool } from './search-superfund.tool.js';
export { searchTriReleasesTool } from './search-tri-releases.tool.js';
export { searchViolationsTool } from './search-violations.tool.js';
export { searchWaterSystemsTool } from './search-water-systems.tool.js';

import { getAirQualityTool } from './get-air-quality.tool.js';
import { getEjscreenTool } from './get-ejscreen.tool.js';
import { getFacilityTool } from './get-facility.tool.js';
import { getTriReleasesTool } from './get-tri-releases.tool.js';
import { searchFacilitiesTool } from './search-facilities.tool.js';
import { searchSuperfundTool } from './search-superfund.tool.js';
import { searchTriReleasesTool } from './search-tri-releases.tool.js';
import { searchViolationsTool } from './search-violations.tool.js';
import { searchWaterSystemsTool } from './search-water-systems.tool.js';

/**
 * Tools backed only by keyless public APIs (ECHO, DMAP, EJAM). Always registered —
 * these require no API key.
 */
export const coreToolDefinitions = [
  searchFacilitiesTool,
  getFacilityTool,
  searchViolationsTool,
  getTriReleasesTool,
  searchTriReleasesTool,
  searchSuperfundTool,
  searchWaterSystemsTool,
  getEjscreenTool,
] as const;

/**
 * Full tool surface, adding epa_get_air_quality (requires AIRNOW_API_KEY).
 * index.ts registers this set when the key is configured, falling back to
 * coreToolDefinitions when it is absent.
 */
export const allToolDefinitions = [...coreToolDefinitions, getAirQualityTool] as const;
