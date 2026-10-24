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
// starts without epa_airnow_get_conditions, leaving the 8 keyless tools available.
const airNowEnabled = getServerConfig().airNowApiKey !== undefined;

/** Server instructions, omitting AirNow guidance when the air quality tool is disabled. */
function buildInstructions(): string {
  return `Use these read-only tools for EPA facility compliance, toxic releases, Superfund sites, drinking water, and environmental-justice screening${airNowEnabled ? ', plus preliminary AirNow air quality that is unsuitable for regulatory, trend, or enforcement purposes' : ''}. Scope ECHO searches geographically with zip_code or state (facility searches also accept city, latitude, longitude, and radius_miles), then use epa_echo_search_facilities → epa_echo_get_facility → epa_echo_search_violations for compliance, epa_superfund_search_sites for cleanup sites, and epa_water_search_systems with has_violation=true for drinking-water violations. TRI reporting lags about 18 months, while epa_ejscreen_get_scores provides US-only EJScreen v2.2 (2022) point-and-buffer indicators from the community-maintained EJAM API (Public Environmental Data Partners), which rehosts the data after EPA discontinued public access in 2025.`;
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
