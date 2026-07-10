/**
 * @fileoverview Server-specific environment variable configuration for epa-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  // Optional: an empty or whitespace-only value (e.g. an unfilled `${AIRNOW_API_KEY}`
  // placeholder from a bundle/compose config) is treated as absent so the server still
  // starts. When absent, index.ts skips registering epa_get_air_quality and AirNow init.
  airNowApiKey: z
    .preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.string().min(1).optional(),
    )
    .describe(
      'AirNow API key (free registration at docs.airnowapi.org). Optional — when unset, epa_get_air_quality is not registered and the other tools run without it.',
    ),
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
  // Optional override. Bundle/compose configs may inject an unfilled
  // `${EJSCREEN_API_BASE_URL}` placeholder as an empty string — treat empty or
  // whitespace-only as absent so the default applies instead of failing `.url()`.
  ejscreenBaseUrl: z
    .preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.string().url().default('https://api.ejanalysis.com'),
    )
    .describe('EJScreen (EJAM) API base URL — the community-maintained EJScreen rehost'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    airNowApiKey: 'AIRNOW_API_KEY',
    echoBaseUrl: 'EPA_ECHO_BASE_URL',
    dmapBaseUrl: 'EPA_DMAP_BASE_URL',
    airNowBaseUrl: 'EPA_AIRNOW_BASE_URL',
    ejscreenBaseUrl: 'EJSCREEN_API_BASE_URL',
  });
  return _config;
}
