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
    mockSearchFacilities.mockResolvedValue({ facilities: [boeingFacility], totalCount: 1 });
    const ctx = createMockContext();
    const input = searchFacilitiesTool.input.parse({ state: 'WA' });
    const result = await searchFacilitiesTool.handler(input, ctx);
    expect(result.facilities).toHaveLength(1);
    expect(result.totalCount).toBe(1);
    expect(result.facilities[0]!.registryId).toBe('110000350509');
  });

  it('returns facilities for valid zip_code filter', async () => {
    mockSearchFacilities.mockResolvedValue({ facilities: [boeingFacility], totalCount: 1 });
    const ctx = createMockContext();
    const input = searchFacilitiesTool.input.parse({ zip_code: '98204' });
    const result = await searchFacilitiesTool.handler(input, ctx);
    expect(result.facilities).toHaveLength(1);
  });

  it('returns facilities for city+state filter', async () => {
    mockSearchFacilities.mockResolvedValue({ facilities: [boeingFacility], totalCount: 1 });
    const ctx = createMockContext();
    const input = searchFacilitiesTool.input.parse({ city: 'EVERETT', state: 'WA' });
    const result = await searchFacilitiesTool.handler(input, ctx);
    expect(result.facilities).toHaveLength(1);
  });

  it('passes program filter to service', async () => {
    mockSearchFacilities.mockResolvedValue({ facilities: [boeingFacility], totalCount: 1 });
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
    const input = searchFacilitiesTool.input.parse({ state: 'WA', has_violation: true });
    const result = await searchFacilitiesTool.handler(input, ctx);
    expect(result.facilities).toHaveLength(0);
    expect(result.totalCount).toBe(0);
    expect(result.message).toContain('No facilities matched');
    expect(result.message).toContain('WA');
  });

  it('formats results with registry IDs, programs, and penalty data', () => {
    const output = { facilities: [boeingFacility], totalCount: 1 };
    const blocks = searchFacilitiesTool.format!(output);
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('EPA Facility Search Results');
    expect(text).toContain('110000350509');
    expect(text).toContain('BOEING COMMERCIAL AIRPLANES');
    expect(text).toContain('EVERETT');
    expect(text).toContain('SNOHOMISH');
    expect(text).toContain('FIPS: 53061');
    expect(text).toContain('47.917');
    expect(text).toContain('No Recent Activity');
    expect(text).toContain('AIR');
    expect(text).toContain('WATER');
    expect(text).toContain('TRI');
    expect(text).toContain('48,210');
    expect(text).toContain('5');
    expect(text).toContain('$15,000');
  });

  it('formats empty result with message', () => {
    const output = {
      facilities: [],
      totalCount: 0,
      message: 'No facilities matched: state="WA".',
    };
    const blocks = searchFacilitiesTool.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('No facilities matched');
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
    expect(text).toContain('SPARSE001');
    expect(text).toContain('SPARSE FACILITY');
  });
});
