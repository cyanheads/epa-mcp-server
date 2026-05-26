/**
 * @fileoverview Tests for superfundSiteResource.
 * @module tests/mcp-server/resources/definitions/superfund-site.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { superfundSiteResource } from '@/mcp-server/resources/definitions/superfund-site.resource.js';

const mockSearchSuperfund = vi.fn();

vi.mock('@/services/dmap/dmap-service.js', () => ({
  getDmapService: () => ({
    searchSuperfund: mockSearchSuperfund,
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
  nplStatus: 'NPL',
  cleanupStatus: 'Site Assessment',
  latitude: 46.652,
  longitude: -119.49,
};

describe('superfundSiteResource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns site when found in first state-guessed search', async () => {
    // First call (state-guessed) returns the site
    mockSearchSuperfund.mockResolvedValue([hanfordSite]);
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = superfundSiteResource.params.parse({ site_id: 'WA1890090003' });
    const result = await superfundSiteResource.handler(params, ctx);
    expect(result).toMatchObject({ siteId: 'WA1890090003', name: 'HANFORD 100-AREA (USDOE)' });
    expect(mockSearchSuperfund).toHaveBeenCalledTimes(1);
  });

  it('falls back to broader search when state guess misses the site', async () => {
    // First call returns a different site, second (broader) search finds it
    mockSearchSuperfund
      .mockResolvedValueOnce([{ siteId: 'WA0000001', name: 'DIFFERENT SITE' }])
      .mockResolvedValueOnce([hanfordSite]);
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = superfundSiteResource.params.parse({ site_id: 'WA1890090003' });
    const result = await superfundSiteResource.handler(params, ctx);
    expect(result).toMatchObject({ siteId: 'WA1890090003' });
    expect(mockSearchSuperfund).toHaveBeenCalledTimes(2);
  });

  it('throws NotFound when site not found in either search', async () => {
    mockSearchSuperfund.mockResolvedValue([]);
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = superfundSiteResource.params.parse({ site_id: 'WA9999NOTREAL' });
    await expect(superfundSiteResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('throws NotFound when both searches return sites but none match the ID', async () => {
    const wrongSite = { ...hanfordSite, siteId: 'WA0000WRONG' };
    mockSearchSuperfund.mockResolvedValue([wrongSite]);
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = superfundSiteResource.params.parse({ site_id: 'WA9999NOTREAL' });
    await expect(superfundSiteResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('uses state prefix heuristic from site_id for first search', async () => {
    mockSearchSuperfund.mockResolvedValue([hanfordSite]);
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = superfundSiteResource.params.parse({ site_id: 'WA1890090003' });
    await superfundSiteResource.handler(params, ctx);
    // First call should include state: 'WA' (first 2 chars of site_id uppercased)
    expect(mockSearchSuperfund).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'WA' }),
      expect.anything(),
    );
  });

  it('propagates service errors upward', async () => {
    mockSearchSuperfund.mockRejectedValue(new Error('Service unavailable'));
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = superfundSiteResource.params.parse({ site_id: 'WA1234' });
    await expect(superfundSiteResource.handler(params, ctx)).rejects.toThrow('Service unavailable');
  });
});
