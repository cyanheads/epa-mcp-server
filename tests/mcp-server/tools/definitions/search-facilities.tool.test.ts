/**
 * @fileoverview Tests for searchFacilitiesTool.
 * @module tests/mcp-server/tools/definitions/search-facilities.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchFacilitiesTool } from '@/mcp-server/tools/definitions/search-facilities.tool.js';

const mockSearchFacilities = vi.fn();

vi.mock('@/services/echo/echo-service.js', () => ({
  getEchoService: () => ({
    searchFacilities: mockSearchFacilities,
    getFacility: vi.fn(),
    searchViolations: vi.fn(),
  }),
}));

const boeingFacility = {
  registryId: '110000350509',
  name: 'BOEING COMMERCIAL AIRPLANES',
  street: '3003 W CASINO RD',
  city: 'EVERETT',
  state: 'WA',
  zip: '98204',
  county: 'SNOHOMISH',
  fipsCode: '53061',
  latitude: 47.917,
  longitude: -122.248,
  complianceStatus: 'No Recent Activity',
  programs: { air: true, water: true, rcra: false, tri: true, sdwa: false },
  triReleasesTransfersInLbs: 48210,
  inspectionCount: 5,
  totalPenaltiesInDollars: 15000,
};

describe('searchFacilitiesTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns facilities for valid state filter', async () => {
    mockSearchFacilities.mockResolvedValue({ facilities: [boeingFacility], totalCount: 412 });
    const ctx = createMockContext({ errors: searchFacilitiesTool.errors });
    const input = searchFacilitiesTool.input.parse({ state: ' WA ' });
    const result = await searchFacilitiesTool.handler(input, ctx);
    expect(mockSearchFacilities).toHaveBeenCalledWith({ state: 'WA', limit: 50 }, ctx);
    expect(result).toEqual({ facilities: [boeingFacility], totalCount: 412 });
  });

  it('returns facilities for valid zip_code filter', async () => {
    mockSearchFacilities.mockResolvedValue({ facilities: [boeingFacility], totalCount: 1 });
    const ctx = createMockContext({ errors: searchFacilitiesTool.errors });
    const input = searchFacilitiesTool.input.parse({ zip_code: '98204' });
    const result = await searchFacilitiesTool.handler(input, ctx);
    expect(mockSearchFacilities).toHaveBeenCalledWith({ zipCode: '98204', limit: 50 }, ctx);
    expect(result.facilities).toEqual([boeingFacility]);
  });

  it('returns facilities for city+state filter', async () => {
    mockSearchFacilities.mockResolvedValue({ facilities: [boeingFacility], totalCount: 1 });
    const ctx = createMockContext({ errors: searchFacilitiesTool.errors });
    const input = searchFacilitiesTool.input.parse({ city: 'EVERETT', state: 'WA' });
    const result = await searchFacilitiesTool.handler(input, ctx);
    expect(mockSearchFacilities).toHaveBeenCalledWith(
      { state: 'WA', city: 'EVERETT', limit: 50 },
      ctx,
    );
    expect(result.facilities).toEqual([boeingFacility]);
  });

  it('passes program filter to service', async () => {
    mockSearchFacilities.mockResolvedValue({ facilities: [boeingFacility], totalCount: 1 });
    const ctx = createMockContext({ errors: searchFacilitiesTool.errors });
    const input = searchFacilitiesTool.input.parse({ state: 'WA', programs: ['TRI', 'CAA'] });
    await searchFacilitiesTool.handler(input, ctx);
    expect(mockSearchFacilities).toHaveBeenCalledWith(
      expect.objectContaining({ programs: ['TRI', 'CAA'] }),
      expect.anything(),
    );
  });

  it('throws no_geographic_filter when no location provided', async () => {
    const ctx = createMockContext({ errors: searchFacilitiesTool.errors });
    const input = searchFacilitiesTool.input.parse({ active_only: true });
    await expect(searchFacilitiesTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_geographic_filter' },
    });
  });

  it('throws no_geographic_filter when all location fields are blank strings', async () => {
    const ctx = createMockContext({ errors: searchFacilitiesTool.errors });
    const input = searchFacilitiesTool.input.parse({ state: '  ', city: '  ', zip_code: '  ' });
    await expect(searchFacilitiesTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_geographic_filter' },
    });
  });

  it('returns facilities for a latitude+longitude+radius_miles proximity filter', async () => {
    mockSearchFacilities.mockResolvedValue({ facilities: [boeingFacility], totalCount: 1 });
    const ctx = createMockContext({ errors: searchFacilitiesTool.errors });
    const input = searchFacilitiesTool.input.parse({
      latitude: 47.917,
      longitude: -122.248,
      radius_miles: 10,
    });
    const result = await searchFacilitiesTool.handler(input, ctx);
    expect(result.facilities).toHaveLength(1);
    expect(mockSearchFacilities).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: 47.917, longitude: -122.248, radiusMiles: 10 }),
      expect.anything(),
    );
  });

  it('accepts latitude/longitude of 0 (equator / prime meridian) as a complete triple', async () => {
    mockSearchFacilities.mockResolvedValue({ facilities: [], totalCount: 0 });
    const ctx = createMockContext({ errors: searchFacilitiesTool.errors });
    const input = searchFacilitiesTool.input.parse({ latitude: 0, longitude: 0, radius_miles: 25 });
    await searchFacilitiesTool.handler(input, ctx);
    // 0 is a valid coordinate — the triple is complete and forwarded, not dropped by a truthy guard.
    expect(mockSearchFacilities).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: 0, longitude: 0, radiusMiles: 25 }),
      expect.anything(),
    );
  });

  it('throws incomplete_proximity when only latitude is provided', async () => {
    const ctx = createMockContext({ errors: searchFacilitiesTool.errors });
    const input = searchFacilitiesTool.input.parse({ latitude: 47.6 });
    await expect(searchFacilitiesTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'incomplete_proximity' },
    });
  });

  it('throws incomplete_proximity when latitude+longitude are given without radius_miles', async () => {
    const ctx = createMockContext({ errors: searchFacilitiesTool.errors });
    const input = searchFacilitiesTool.input.parse({ latitude: 47.6, longitude: -122.3 });
    await expect(searchFacilitiesTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'incomplete_proximity' },
    });
  });

  it('surfaces the proximity filter in the no-match message', async () => {
    mockSearchFacilities.mockResolvedValue({ facilities: [], totalCount: 0 });
    const ctx = createMockContext({ errors: searchFacilitiesTool.errors });
    const input = searchFacilitiesTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      radius_miles: 5,
    });
    const result = await searchFacilitiesTool.handler(input, ctx);
    expect(result.message).toContain('within 5 mi of (47.6, -122.3)');
  });

  it('returns message when no facilities found', async () => {
    mockSearchFacilities.mockResolvedValue({ facilities: [], totalCount: 0 });
    const ctx = createMockContext({ errors: searchFacilitiesTool.errors });
    const input = searchFacilitiesTool.input.parse({ state: 'WA', has_violation: true });
    const result = await searchFacilitiesTool.handler(input, ctx);
    expect(result.facilities).toHaveLength(0);
    expect(result.totalCount).toBe(0);
    expect(result.message).toBe(
      'No facilities matched: state="WA", has_violation=true. Try broadening the geographic area or removing program/violation filters.',
    );
  });

  it('formats results with registry IDs, programs, and penalty data', () => {
    const output = { facilities: [boeingFacility], totalCount: 412 };
    const blocks = searchFacilitiesTool.format!(output);
    expect(blocks).toHaveLength(1);
    const lines = (blocks[0] as { type: string; text: string }).text.split('\n');
    for (const line of [
      '## EPA Facility Search Results',
      '**Total Found:** 412 | **Returned:** 1',
      '### BOEING COMMERCIAL AIRPLANES',
      '**Registry ID:** 110000350509',
      '**Location:** 3003 W CASINO RD, EVERETT, WA, 98204',
      '**County:** SNOHOMISH (FIPS: 53061)',
      '**Coordinates:** 47.917, -122.248',
      '**Compliance Status:** No Recent Activity',
      '**Programs:** AIR, WATER, TRI',
      '**TRI Releases+Transfers:** 48,210 lbs',
      '**Inspections:** 5',
      '**Total Penalties:** $15,000',
    ]) {
      expect(lines).toContain(line);
    }
  });

  it('renders a sub-0.001 TRI releases+transfers total at full precision', () => {
    const text = (
      searchFacilitiesTool.format!({
        facilities: [{ ...boeingFacility, triReleasesTransfersInLbs: 0.00062 }],
        totalCount: 1,
      })[0] as { text: string }
    ).text;
    expect(text).toContain('**TRI Releases+Transfers:** 0.00062 lbs');
  });

  it('formats empty result with message', () => {
    const output = {
      facilities: [],
      totalCount: 0,
      message: 'No facilities matched: state="WA".',
    };
    const blocks = searchFacilitiesTool.format!(output);
    const lines = (blocks[0] as { type: string; text: string }).text.split('\n');
    expect(lines).toContain('**Total Found:** 0 | **Returned:** 0');
    expect(lines).toContain('> No facilities matched: state="WA".');
  });

  describe('registry-ID handoff wording', () => {
    const facilityShape = searchFacilitiesTool.output.shape.facilities.element.shape;

    it('description lists only epa_get_facility as a registry-ID consumer', () => {
      expect(searchFacilitiesTool.description).toContain(
        'Registry IDs returned here feed epa_get_facility',
      );
      expect(searchFacilitiesTool.description).not.toContain('epa_get_tri_releases');
    });

    it('registryId .describe() names only epa_get_facility', () => {
      const text = facilityShape.registryId.description ?? '';
      expect(text).toContain('epa_get_facility');
      expect(text).not.toContain('epa_get_tri_releases');
    });

    it('triReleasesTransfersInLbs sources the TRI facility ID from epa_search_tri_releases', () => {
      const text = facilityShape.triReleasesTransfersInLbs.description ?? '';
      expect(text).toContain('epa_get_tri_releases');
      expect(text).toContain('epa_search_tri_releases');
    });
  });

  it('formats sparse facility (minimal fields)', () => {
    const sparse = {
      facilities: [
        {
          registryId: 'SPARSE001',
          name: 'SPARSE FACILITY',
          programs: { air: false, water: false, rcra: false, tri: false, sdwa: false },
        },
      ],
      totalCount: 1,
    };
    const blocks = searchFacilitiesTool.format!(sparse);
    const text = (blocks[0] as { type: string; text: string }).text;
    // Absent fields render no lines at all — no Programs line when every flag is false.
    expect(text.slice(text.indexOf('### '))).toBe(
      '### SPARSE FACILITY\n**Registry ID:** SPARSE001',
    );
  });

  describe('coordinate and FIPS rendering', () => {
    type Extra = { latitude?: number; longitude?: number; county?: string; fipsCode?: string };
    const render = (extra: Extra) =>
      (
        searchFacilitiesTool.format!({
          facilities: [
            {
              registryId: 'COORD001',
              name: 'COORD FACILITY',
              programs: { air: false, water: false, rcra: false, tri: false, sdwa: false },
              ...extra,
            },
          ],
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
