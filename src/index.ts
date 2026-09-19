#!/usr/bin/env node
/**
 * @fileoverview epa-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { allResourceDefinitions } from './mcp-server/resources/definitions/index.js';
import { allToolDefinitions, coreToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { initAirNowService } from './services/airnow/airnow-service.js';
import { initDmapService } from './services/dmap/dmap-service.js';
import { initEchoService } from './services/echo/echo-service.js';
import { initEjscreenService } from './services/ejscreen/ejscreen-service.js';

// AirNow is the only key-gated service. When AIRNOW_API_KEY is absent the server
// starts without epa_get_air_quality, leaving the 8 keyless tools available.
const airNowEnabled = getServerConfig().airNowApiKey !== undefined;

/** Server instructions, omitting AirNow guidance when the air quality tool is disabled. */
function buildInstructions(): string {
  return `Use these read-only tools for EPA facility compliance, toxic releases, Superfund sites, drinking water, and environmental-justice screening${airNowEnabled ? ', plus preliminary AirNow air quality that is unsuitable for regulatory, trend, or enforcement purposes' : ''}. Scope ECHO searches geographically with zip_code, state, or city (facility searches also accept latitude, longitude, and radius_miles), then use epa_search_facilities → epa_get_facility → epa_search_violations for compliance, epa_search_superfund for cleanup sites, and epa_search_water_systems with has_violation=true for drinking-water violations. TRI reporting lags about 18 months, while epa_get_ejscreen provides US-only EJScreen v2.2 (2022) point-and-buffer indicators from the community-maintained EJAM API (Public Environmental Data Partners), which rehosts the data after EPA discontinued public access in 2025.`;
}

await createApp({
  name: 'epa-mcp-server',
  title: 'epa-mcp-server',
  sessionMode: 'stateless',
  tools: [...(airNowEnabled ? allToolDefinitions : coreToolDefinitions)],
  resources: [...allResourceDefinitions],
  prompts: [],
  instructions: buildInstructions(),
  setup(core) {
    initEchoService(core.config, core.storage);
    initDmapService(core.config, core.storage);
    initEjscreenService(core.config, core.storage);
    if (airNowEnabled) initAirNowService(core.config, core.storage);
  },
});
