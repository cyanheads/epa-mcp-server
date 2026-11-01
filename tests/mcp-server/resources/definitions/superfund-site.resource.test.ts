/**
 * @fileoverview Tests for superfundSiteResource.
 * @module tests/mcp-server/resources/definitions/superfund-site.resource.test
 */

import { JsonRpcErrorCode, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { superfundSiteResource } from '@/mcp-server/resources/definitions/superfund-site.resource.js';
import { rpcResponse, startHttpServer } from '../../../helpers.js';

const mockGetSuperfundSite = vi.fn();

vi.mock('@/services/dmap/dmap-service.js', () => ({
  getDmapService: () => ({
    getSuperfundSite: mockGetSuperfundSite,
    searchSuperfund: vi.fn(),
    getTriReleases: vi.fn(),
    searchTriReleases: vi.fn(),
    searchWaterSystems: vi.fn(),
  }),
}));

const hanfordSite = {
  siteId: 'WA1890090003',
  name: 'HANFORD 100-AREA (USDOE)',
  city: 'RICHLAND',
  state: 'WA',
  zip: '99352',
  county: 'BENTON',
  fipsCode: '53005',
  nplStatus: 'F',
  nplStatusName: 'Currently on the Final NPL',
  latitude: 46.652,
  longitude: -119.49,
};

describe('superfundSiteResource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns site when found by direct site ID query', async () => {
    mockGetSuperfundSite.mockResolvedValue({ site: hanfordSite, contaminants: [] });
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: superfundSiteResource.errors,
    });
    const params = superfundSiteResource.params!.parse({ site_id: 'WA1890090003' });
    const result = await superfundSiteResource.handler(params, ctx);
    expect(result).toEqual({ ...hanfordSite, contaminants: [] });
    expect(mockGetSuperfundSite).toHaveBeenCalledTimes(1);
    expect(mockGetSuperfundSite).toHaveBeenCalledWith('WA1890090003', ctx);
  });

  it('throws NotFound when site not found', async () => {
    mockGetSuperfundSite.mockRejectedValue(
      notFound('No Superfund site found with site ID "WA9999NOTREAL".', {
        siteId: 'WA9999NOTREAL',
      }),
    );
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: superfundSiteResource.errors,
    });
    const params = superfundSiteResource.params!.parse({ site_id: 'WA9999NOTREAL' });
    await expect(superfundSiteResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: expect.stringContaining('site ID "WA9999NOTREAL"'),
      data: { siteId: 'WA9999NOTREAL' },
    });
  });

  it('throws NotFound for numeric site IDs (no state prefix)', async () => {
    mockGetSuperfundSite.mockRejectedValue(notFound('No site found'));
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: superfundSiteResource.errors,
    });
    const params = superfundSiteResource.params!.parse({ site_id: '0200048' });
    await expect(superfundSiteResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
    expect(mockGetSuperfundSite).toHaveBeenCalledWith('0200048', expect.anything());
  });

  it('propagates service errors upward', async () => {
    mockGetSuperfundSite.mockRejectedValue(new Error('Service unavailable'));
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: superfundSiteResource.errors,
    });
    const params = superfundSiteResource.params!.parse({ site_id: 'WA1234' });
    await expect(superfundSiteResource.handler(params, ctx)).rejects.toThrow('Service unavailable');
  });

  it('retains contaminant associations beside top-level site fields', async () => {
    mockGetSuperfundSite.mockResolvedValue({
      site: hanfordSite,
      contaminants: [{ name: 'ARSENIC' }],
    });
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: superfundSiteResource.errors,
    });
    const params = superfundSiteResource.params!.parse({ site_id: 'WA1890090003' });
    const result = await superfundSiteResource.handler(params, ctx);
    expect(result).toMatchObject({ siteId: 'WA1890090003', contaminants: [{ name: 'ARSENIC' }] });
  });
});

describe('epa://superfund/{site_id} over JSON-RPC', () => {
  it('rejects a site_id DMAP cannot carry with its declared reason and recovery, before any upstream request', async () => {
    // An unreachable DMAP base URL: a request that escaped the pre-request checks fails loudly.
    const { origin, stop } = await startHttpServer({
      EPA_DMAP_BASE_URL: 'http://127.0.0.1:9/dmapservice',
      LOGS_DIR: '/tmp/epa-superfund-resource-test-logs',
    });
    try {
      const read = async (uri: string) => {
        const response = await fetch(`${origin}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2025-11-25',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'resources/read',
            params: { uri },
          }),
        });
        return rpcResponse(await response.text());
      };
      const hint = 'Pass one SEMS site ID exactly as epa_superfund_search_sites returns it.';

      expect(await read('epa://superfund/A.B')).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message:
            '"A.B" contains ".", a character EPA\'s DMAP service cannot match in an exact-value filter. Remove it and retry.',
          data: { reason: 'unmatchable_filter', character: '.', recovery: { hint } },
        },
      });
      expect(await read(`epa://superfund/${'A'.repeat(5000)}`)).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringContaining("too long for EPA's DMAP service"),
          data: { reason: 'filter_too_long', recovery: { hint } },
        },
      });
    } finally {
      await stop();
    }
  }, 15_000);
});
