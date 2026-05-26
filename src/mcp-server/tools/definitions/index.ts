/**
 * @fileoverview Barrel export for all EPA MCP server tool definitions.
 * @module mcp-server/tools/definitions/index
 */

export { getAirQualityTool } from './get-air-quality.tool.js';
export { getFacilityTool } from './get-facility.tool.js';
export { getTriReleasesTool } from './get-tri-releases.tool.js';
export { searchFacilitiesTool } from './search-facilities.tool.js';
export { searchSuperfundTool } from './search-superfund.tool.js';
export { searchTriReleasesTool } from './search-tri-releases.tool.js';
export { searchViolationsTool } from './search-violations.tool.js';
export { searchWaterSystemsTool } from './search-water-systems.tool.js';

import { getAirQualityTool } from './get-air-quality.tool.js';
import { getFacilityTool } from './get-facility.tool.js';
import { getTriReleasesTool } from './get-tri-releases.tool.js';
import { searchFacilitiesTool } from './search-facilities.tool.js';
import { searchSuperfundTool } from './search-superfund.tool.js';
import { searchTriReleasesTool } from './search-tri-releases.tool.js';
import { searchViolationsTool } from './search-violations.tool.js';
import { searchWaterSystemsTool } from './search-water-systems.tool.js';

export const allToolDefinitions = [
  searchFacilitiesTool,
  getFacilityTool,
  searchViolationsTool,
  getAirQualityTool,
  getTriReleasesTool,
  searchTriReleasesTool,
  searchSuperfundTool,
  searchWaterSystemsTool,
] as const;
