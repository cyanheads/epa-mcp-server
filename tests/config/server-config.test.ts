/**
 * @fileoverview Server environment normalization and optional AirNow configuration.
 * @module tests/config/server-config.test
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllEnvs());

describe('server environment configuration', () => {
  it.each(['', '   ', `\${AIRNOW_API_KEY}`])('treats %j as an absent key', async (value) => {
    vi.resetModules();
    vi.stubEnv('AIRNOW_API_KEY', value);
    vi.stubEnv('EJSCREEN_API_BASE_URL', value);
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(getServerConfig().airNowApiKey).toBeUndefined();
    expect(getServerConfig().ejscreenBaseUrl).toBe('https://api.ejanalysis.com');
  });

  it('preserves an explicitly configured key and URL', async () => {
    vi.resetModules();
    vi.stubEnv('AIRNOW_API_KEY', 'synthetic-key');
    vi.stubEnv('EJSCREEN_API_BASE_URL', 'https://example.com/ejam');
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(getServerConfig().airNowApiKey).toBe('synthetic-key');
    expect(getServerConfig().ejscreenBaseUrl).toBe('https://example.com/ejam');
  });
});
