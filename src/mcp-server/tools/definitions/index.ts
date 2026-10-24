/**
 * @fileoverview Barrel export for all EPA MCP server tool definitions.
 * @module mcp-server/tools/definitions/index
 */

export { airnowGetConditionsTool } from './airnow-get-conditions.tool.js';
export { echoGetFacilityTool } from './echo-get-facility.tool.js';
export { echoSearchFacilitiesTool } from './echo-search-facilities.tool.js';
export { echoSearchViolationsTool } from './echo-search-violations.tool.js';
export { ejscreenGetScoresTool } from './ejscreen-get-scores.tool.js';
export { superfundSearchSitesTool } from './superfund-search-sites.tool.js';
export { triGetFacilityReleasesTool } from './tri-get-facility-releases.tool.js';
export { triSearchReleasesTool } from './tri-search-releases.tool.js';
export { waterSearchSystemsTool } from './water-search-systems.tool.js';

import { airnowGetConditionsTool } from './airnow-get-conditions.tool.js';
import { echoGetFacilityTool } from './echo-get-facility.tool.js';
import { echoSearchFacilitiesTool } from './echo-search-facilities.tool.js';
import { echoSearchViolationsTool } from './echo-search-violations.tool.js';
import { ejscreenGetScoresTool } from './ejscreen-get-scores.tool.js';
import { superfundSearchSitesTool } from './superfund-search-sites.tool.js';
import { triGetFacilityReleasesTool } from './tri-get-facility-releases.tool.js';
import { triSearchReleasesTool } from './tri-search-releases.tool.js';
import { waterSearchSystemsTool } from './water-search-systems.tool.js';

/**
 * Tools backed only by keyless public APIs (ECHO, DMAP, EJAM). Always registered —
 * these require no API key.
 */
export const coreToolDefinitions = [
  echoSearchFacilitiesTool,
  echoGetFacilityTool,
  echoSearchViolationsTool,
  triGetFacilityReleasesTool,
  triSearchReleasesTool,
  superfundSearchSitesTool,
  waterSearchSystemsTool,
  ejscreenGetScoresTool,
] as const;

/**
 * Full tool surface, adding epa_airnow_get_conditions (requires AIRNOW_API_KEY).
 * index.ts registers this set when the key is configured, falling back to
 * coreToolDefinitions when it is absent.
 */
export const allToolDefinitions = [...coreToolDefinitions, airnowGetConditionsTool] as const;
