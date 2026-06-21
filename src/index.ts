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

// AirNow is the only key-gated service. When AIRNOW_API_KEY is absent the server
// starts without epa_get_air_quality, leaving the 7 keyless tools available.
const airNowEnabled = getServerConfig().airNowApiKey !== undefined;

/** Server instructions, omitting AirNow guidance when the air quality tool is disabled. */
function buildInstructions(): string {
  const lines = [
    `EPA environmental data server covering facility compliance (ECHO), toxic releases (TRI), Superfund sites, drinking water systems (SDWIS)${airNowEnabled ? ', and real-time air quality (AirNow)' : ''}.`,
    '- All tools are read-only. All APIs are US federal government public domain data.',
    '- ECHO tools require at least one geographic filter (zip_code, state, or city) — unscoped searches time out. epa_search_facilities also accepts latitude + longitude + radius_miles for proximity search.',
    '- TRI data lags ~18 months — most recent available year is typically 2 years prior to current.',
  ];
  if (airNowEnabled) {
    lines.push(
      '- AirNow data is preliminary and not valid for regulatory, trend, or enforcement purposes.',
    );
  }
  lines.push(
    '- Typical workflows: epa_search_facilities → epa_get_facility → epa_search_violations (compliance audit); epa_search_superfund (proximity); epa_search_water_systems + has_violation=true (drinking water safety).',
  );
  return lines.join('\n');
}

await createApp({
  name: 'epa-mcp-server',
  title: 'epa-mcp-server',
  tools: [...(airNowEnabled ? allToolDefinitions : coreToolDefinitions)],
  resources: [...allResourceDefinitions],
  prompts: [],
  instructions: buildInstructions(),
  setup(core) {
    initEchoService(core.config, core.storage);
    initDmapService(core.config, core.storage);
    if (airNowEnabled) initAirNowService(core.config, core.storage);
  },
});
