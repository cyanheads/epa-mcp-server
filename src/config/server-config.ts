/**
 * @fileoverview Server-specific environment variable configuration for epa-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  airNowApiKey: z
    .string()
    .min(1)
    .describe('AirNow API key (free registration at docs.airnowapi.org)'),
  echoBaseUrl: z
    .string()
    .url()
    .default('https://echodata.epa.gov/echo')
    .describe('ECHO API base URL'),
  dmapBaseUrl: z
    .string()
    .url()
    .default('https://data.epa.gov/dmapservice')
    .describe('DMAP API base URL'),
  airNowBaseUrl: z
    .string()
    .url()
    .default('https://www.airnowapi.org/aq')
    .describe('AirNow API base URL'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    airNowApiKey: 'AIRNOW_API_KEY',
    echoBaseUrl: 'EPA_ECHO_BASE_URL',
    dmapBaseUrl: 'EPA_DMAP_BASE_URL',
    airNowBaseUrl: 'EPA_AIRNOW_BASE_URL',
  });
  return _config;
}
