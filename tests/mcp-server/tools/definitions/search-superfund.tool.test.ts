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
    const ctx = createMockContext({ errors: searchSuperfundTool.errors });
    const input = searchSuperfundTool.input.parse({ state: ' WA ' });
    const result = await searchSuperfundTool.handler(input, ctx);
    // npl_status defaults to "all", which sends no NPL filter.
    expect(mockSearchSuperfund).toHaveBeenCalledWith({ state: 'WA', limit: 50 }, ctx);
    expect(result).toEqual({ sites: [hanfordSite], totalCount: 1 });
  });

  it('returns sites for city filter', async () => {
    mockSearchSuperfund.mockResolvedValue([hanfordSite]);
    const ctx = createMockContext({ errors: searchSuperfundTool.errors });
    const input = searchSuperfundTool.input.parse({
      city: 'RICHLAND',
      state: 'WA',
      npl_status: 'listed',
    });
    const result = await searchSuperfundTool.handler(input, ctx);
    expect(mockSearchSuperfund).toHaveBeenCalledWith(
      { state: 'WA', city: 'RICHLAND', nplStatus: 'listed', limit: 50 },
      ctx,
    );
    expect(result.sites).toEqual([hanfordSite]);
  });

  it('returns sites for lat/lng + radius proximity search', async () => {
    mockSearchSuperfund.mockResolvedValue([hanfordSite]);
    const ctx = createMockContext({ errors: searchSuperfundTool.errors });
    const input = searchSuperfundTool.input.parse({
      latitude: 46.652,
      longitude: -119.49,
      radius_miles: 50,
    });
    const result = await searchSuperfundTool.handler(input, ctx);
    expect(mockSearchSuperfund).toHaveBeenCalledWith(
      { latitude: 46.652, longitude: -119.49, radiusMiles: 50, limit: 50 },
      ctx,
    );
    expect(result.sites).toEqual([hanfordSite]);
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
    const ctx = createMockContext({ errors: searchSuperfundTool.errors });
    const input = searchSuperfundTool.input.parse({ state: 'HI', npl_status: 'listed' });
    const result = await searchSuperfundTool.handler(input, ctx);
    expect(result.sites).toHaveLength(0);
    expect(result.totalCount).toBe(0);
    expect(result.message).toBe(
      'No Superfund sites found near HI with npl_status="listed". Try expanding the area, removing NPL status filter, or using a different location.',
    );
  });

  it('formats output with site ID, NPL status, and coordinates', () => {
    const output = { sites: [hanfordSite], totalCount: 1 };
    const blocks = searchSuperfundTool.format!(output);
    expect(blocks).toHaveLength(1);
    const lines = (blocks[0] as { type: string; text: string }).text.split('\n');
    for (const line of [
      '## Superfund Sites',
      '**Found:** 1',
      '### HANFORD 100-AREA (USDOE)',
      '**Site ID:** WA1890090003',
      '**Location:** RICHLAND, RICHLAND, WA, 99352',
      '**County:** BENTON (FIPS: 53005)',
      '**Coordinates:** 46.652, -119.49',
      '**NPL Status:** NPL',
      '**Cleanup Status:** Site Assessment',
    ]) {
      expect(lines).toContain(line);
    }
  });

  it('formats empty result with message', () => {
    const output = {
      sites: [],
      totalCount: 0,
      message: 'No Superfund sites found near WA.',
    };
    const blocks = searchSuperfundTool.format!(output);
    const lines = (blocks[0] as { type: string; text: string }).text.split('\n');
    expect(lines).toContain('**Found:** 0');
    expect(lines).toContain('> No Superfund sites found near WA.');
  });

  it('formats sparse site (minimal required fields)', () => {
    const sparse = {
      sites: [{ siteId: 'TX1234', name: 'SPARSE SITE' }],
      totalCount: 1,
    };
    const blocks = searchSuperfundTool.format!(sparse);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text.slice(text.indexOf('### '))).toBe('### SPARSE SITE\n**Site ID:** TX1234');
  });

  describe('coordinate and FIPS rendering', () => {
    type Extra = { latitude?: number; longitude?: number; county?: string; fipsCode?: string };
    const render = (extra: Extra) =>
      (
        searchSuperfundTool.format!({
          sites: [{ siteId: 'COORD001', name: 'COORD SITE', ...extra }],
          totalCount: 1,
        })[0] as { text: string }
      ).text;

    it.each([
      [
        'both',
        { latitude: 47.60634, longitude: -122.33207 },
        '**Coordinates:** 47.60634, -122.33207',
      ],
      ['both zero', { latitude: 0, longitude: 0 }, '**Coordinates:** 0, 0'],
      ['latitude only', { latitude: 47.60634 }, '**Latitude:** 47.60634'],
      ['longitude only', { longitude: -122.33207 }, '**Longitude:** -122.33207'],
      ['zero latitude only', { latitude: 0 }, '**Latitude:** 0'],
      ['zero longitude only', { longitude: 0 }, '**Longitude:** 0'],
    ] as const)('renders %s', (_label, coords, line) => {
      const text = render(coords);
      const coordLines = text.split('\n').filter((l) => /Coordinates|Latitude|Longitude/.test(l));
      expect(coordLines).toEqual([line]);
    });

    it('renders no coordinate line when neither is present', () => {
      expect(render({})).not.toMatch(/Coordinates|Latitude|Longitude/);
    });

    it('renders county with its FIPS code on one line', () => {
      expect(render({ county: 'KING', fipsCode: '53033' })).toContain(
        '**County:** KING (FIPS: 53033)',
      );
    });

    it('renders a FIPS code that arrives without a county name', () => {
      const text = render({ fipsCode: '53033' });
      expect(text).toContain('**County FIPS:** 53033');
      expect(text).not.toContain('**County:**');
    });
  });
});
