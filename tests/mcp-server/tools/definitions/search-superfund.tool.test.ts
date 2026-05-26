/**
 * @fileoverview Tests for searchSuperfundTool.
 * @module tests/mcp-server/tools/definitions/search-superfund.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchSuperfundTool } from '@/mcp-server/tools/definitions/search-superfund.tool.js';

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
  street: 'RICHLAND',
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

describe('searchSuperfundTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns sites for valid state filter', async () => {
    mockSearchSuperfund.mockResolvedValue([hanfordSite]);
    const ctx = createMockContext();
    const input = searchSuperfundTool.input.parse({ state: 'WA' });
    const result = await searchSuperfundTool.handler(input, ctx);
    expect(result.sites).toHaveLength(1);
    expect(result.totalCount).toBe(1);
    expect(result.sites[0]!.siteId).toBe('WA1890090003');
    expect(result.sites[0]!.nplStatus).toBe('NPL');
  });

  it('returns sites for city filter', async () => {
    mockSearchSuperfund.mockResolvedValue([hanfordSite]);
    const ctx = createMockContext();
    const input = searchSuperfundTool.input.parse({ city: 'RICHLAND', state: 'WA' });
    const result = await searchSuperfundTool.handler(input, ctx);
    expect(result.sites).toHaveLength(1);
  });

  it('returns sites for lat/lng + radius proximity search', async () => {
    mockSearchSuperfund.mockResolvedValue([hanfordSite]);
    const ctx = createMockContext();
    const input = searchSuperfundTool.input.parse({
      latitude: 46.652,
      longitude: -119.49,
      radius_miles: 50,
    });
    const result = await searchSuperfundTool.handler(input, ctx);
    expect(result.sites).toHaveLength(1);
  });

  it('throws no_location_filter when no location provided', async () => {
    const ctx = createMockContext({ errors: searchSuperfundTool.errors });
    const input = searchSuperfundTool.input.parse({ npl_status: 'listed' });
    await expect(searchSuperfundTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_location_filter' },
    });
  });

  it('throws no_location_filter when location fields are blank strings', async () => {
    const ctx = createMockContext({ errors: searchSuperfundTool.errors });
    const input = searchSuperfundTool.input.parse({ state: '  ', city: '  ', zip_code: '  ' });
    await expect(searchSuperfundTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_location_filter' },
    });
  });

  it('throws radius_required when lat/lng provided without radius_miles', async () => {
    const ctx = createMockContext({ errors: searchSuperfundTool.errors });
    const input = searchSuperfundTool.input.parse({
      latitude: 46.652,
      longitude: -119.49,
    });
    await expect(searchSuperfundTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'radius_required' },
    });
  });

  it('returns message when no sites found', async () => {
    mockSearchSuperfund.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = searchSuperfundTool.input.parse({ state: 'HI', npl_status: 'listed' });
    const result = await searchSuperfundTool.handler(input, ctx);
    expect(result.sites).toHaveLength(0);
    expect(result.totalCount).toBe(0);
    expect(result.message).toContain('No Superfund sites found');
    expect(result.message).toContain('listed');
  });

  it('formats output with site ID, NPL status, and coordinates', () => {
    const output = { sites: [hanfordSite], totalCount: 1 };
    const blocks = searchSuperfundTool.format!(output);
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('Superfund Sites');
    expect(text).toContain('WA1890090003');
    expect(text).toContain('HANFORD 100-AREA');
    expect(text).toContain('RICHLAND');
    expect(text).toContain('BENTON');
    expect(text).toContain('FIPS: 53005');
    expect(text).toContain('46.652');
    expect(text).toContain('NPL');
    expect(text).toContain('Site Assessment');
  });

  it('formats empty result with message', () => {
    const output = {
      sites: [],
      totalCount: 0,
      message: 'No Superfund sites found near WA.',
    };
    const blocks = searchSuperfundTool.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('No Superfund sites found');
  });

  it('formats sparse site (minimal required fields)', () => {
    const sparse = {
      sites: [{ siteId: 'TX1234', name: 'SPARSE SITE' }],
      totalCount: 1,
    };
    const blocks = searchSuperfundTool.format!(sparse);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('TX1234');
    expect(text).toContain('SPARSE SITE');
  });
});
