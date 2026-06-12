#!/usr/bin/env node
/**
 * @fileoverview epa-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { allResourceDefinitions } from './mcp-server/resources/definitions/index.js';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { initAirNowService } from './services/airnow/airnow-service.js';
import { initDmapService } from './services/dmap/dmap-service.js';
import { initEchoService } from './services/echo/echo-service.js';

await createApp({
  name: 'epa-mcp-server',
  title: 'epa-mcp-server',
  tools: [...allToolDefinitions],
  resources: [...allResourceDefinitions],
  prompts: [],
  instructions:
    'EPA environmental data server covering facility compliance (ECHO), toxic releases (TRI), Superfund sites, drinking water systems (SDWIS), and real-time air quality (AirNow).\n' +
    '- All tools are read-only. All APIs are US federal government public domain data.\n' +
    '- ECHO tools require at least one geographic filter (zip_code, state, or city) — unscoped searches time out.\n' +
    '- TRI data lags ~18 months — most recent available year is typically 2 years prior to current.\n' +
    '- AirNow data is preliminary and not valid for regulatory, trend, or enforcement purposes.\n' +
    '- Typical workflows: epa_search_facilities → epa_get_facility → epa_search_violations (compliance audit); epa_search_superfund (proximity); epa_search_water_systems + has_violation=true (drinking water safety).',
  setup(core) {
    initEchoService(core.config, core.storage);
    initDmapService(core.config, core.storage);
    initAirNowService(core.config, core.storage);
  },
});
