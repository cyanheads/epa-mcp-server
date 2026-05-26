/**
 * @fileoverview Tests for superfundSiteResource.
 * @module tests/mcp-server/resources/definitions/superfund-site.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { superfundSiteResource } from '@/mcp-server/resources/definitions/superfund-site.resource.js';

const mockSearchSuperfundById = vi.fn();

vi.mock('@/services/dmap/dmap-service.js', () => ({
  getDmapService: () => ({
    searchSuperfundById: mockSearchSuperfundById,
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
  nplStatus: 'NPL',
  cleanupStatus: 'Site Assessment',
  latitude: 46.652,
  longitude: -119.49,
};

describe('superfundSiteResource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns site when found by direct site ID query', async () => {
    mockSearchSuperfundById.mockResolvedValue([hanfordSite]);
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = superfundSiteResource.params.parse({ site_id: 'WA1890090003' });
    const result = await superfundSiteResource.handler(params, ctx);
    expect(result).toMatchObject({ siteId: 'WA1890090003', name: 'HANFORD 100-AREA (USDOE)' });
    expect(mockSearchSuperfundById).toHaveBeenCalledTimes(1);
    expect(mockSearchSuperfundById).toHaveBeenCalledWith('WA1890090003', expect.anything());
  });

  it('throws NotFound when site not found', async () => {
    mockSearchSuperfundById.mockResolvedValue([]);
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = superfundSiteResource.params.parse({ site_id: 'WA9999NOTREAL' });
    await expect(superfundSiteResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('throws NotFound for numeric site IDs (no state prefix)', async () => {
    mockSearchSuperfundById.mockResolvedValue([]);
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = superfundSiteResource.params.parse({ site_id: '0200048' });
    await expect(superfundSiteResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
    expect(mockSearchSuperfundById).toHaveBeenCalledWith('0200048', expect.anything());
  });

  it('propagates service errors upward', async () => {
    mockSearchSuperfundById.mockRejectedValue(new Error('Service unavailable'));
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = superfundSiteResource.params.parse({ site_id: 'WA1234' });
    await expect(superfundSiteResource.handler(params, ctx)).rejects.toThrow('Service unavailable');
  });

  it('passes site_id directly to searchSuperfundById', async () => {
    mockSearchSuperfundById.mockResolvedValue([hanfordSite]);
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = superfundSiteResource.params.parse({ site_id: 'WA1890090003' });
    await superfundSiteResource.handler(params, ctx);
    expect(mockSearchSuperfundById).toHaveBeenCalledWith('WA1890090003', expect.anything());
  });

  it('returns first result when multiple sites returned', async () => {
    const otherSite = { ...hanfordSite, siteId: 'WA9999', name: 'OTHER SITE' };
    mockSearchSuperfundById.mockResolvedValue([hanfordSite, otherSite]);
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = superfundSiteResource.params.parse({ site_id: 'WA1890090003' });
    const result = await superfundSiteResource.handler(params, ctx);
    expect(result).toMatchObject({ siteId: 'WA1890090003' });
  });
});
