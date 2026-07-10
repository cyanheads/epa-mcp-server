/**
 * @fileoverview Tests for getTriReleasesTool.
 * @module tests/mcp-server/tools/definitions/get-tri-releases.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTriReleasesTool } from '@/mcp-server/tools/definitions/get-tri-releases.tool.js';

const mockGetTriReleases = vi.fn();

vi.mock('@/services/dmap/dmap-service.js', () => ({
  getDmapService: () => ({
    getTriReleases: mockGetTriReleases,
    searchTriReleases: vi.fn(),
    searchSuperfund: vi.fn(),
    searchWaterSystems: vi.fn(),
  }),
}));

const benzeneRelease = {
  facilityId: 'WA0001234',
  chemicalName: 'BENZENE',
  reportingYear: 2022,
  totalReleasesInLbs: 1240,
};

const fullBreakdownRelease = {
  facilityId: 'WA0005678',
  chemicalName: 'TOLUENE',
  reportingYear: 2021,
  totalReleasesInLbs: 0,
  releasesToAirInLbs: 15000,
  releasesToWaterInLbs: 200,
  releasesToLandInLbs: 3400,
  releasesToUndergroundInjectionInLbs: 90000,
};

describe('getTriReleasesTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns TRI releases for valid facility ID', async () => {
    mockGetTriReleases.mockResolvedValue([benzeneRelease]);
    const ctx = createMockContext();
    const input = getTriReleasesTool.input.parse({ facility_id: 'WA0001234' });
    const result = await getTriReleasesTool.handler(input, ctx);
    expect(result.facilityId).toBe('WA0001234');
    expect(result.releases).toHaveLength(1);
    expect(result.releases[0]!.chemicalName).toBe('BENZENE');
    expect(result.releases[0]!.reportingYear).toBe(2022);
    expect(result.releases[0]!.totalReleasesInLbs).toBe(1240);
  });

  it('passes year and chemical_name filters to service', async () => {
    mockGetTriReleases.mockResolvedValue([benzeneRelease]);
    const ctx = createMockContext();
    const input = getTriReleasesTool.input.parse({
      facility_id: 'WA0001234',
      year: 2022,
      chemical_name: 'BENZENE',
    });
    await getTriReleasesTool.handler(input, ctx);
    expect(mockGetTriReleases).toHaveBeenCalledWith(
      expect.objectContaining({ year: 2022, chemicalName: 'BENZENE' }),
      expect.anything(),
    );
  });

  it('returns message when no releases found', async () => {
    mockGetTriReleases.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = getTriReleasesTool.input.parse({ facility_id: 'NOFACILITY' });
    const result = await getTriReleasesTool.handler(input, ctx);
    expect(result.releases).toHaveLength(0);
    expect(result.message).toContain('No TRI releases found');
    expect(result.message).toContain('NOFACILITY');
  });

  it('includes year in no-results message when year filter provided', async () => {
    mockGetTriReleases.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = getTriReleasesTool.input.parse({ facility_id: 'WA0001234', year: 2019 });
    const result = await getTriReleasesTool.handler(input, ctx);
    expect(result.message).toContain('2019');
  });

  it('includes chemical name in no-results message when filter provided', async () => {
    mockGetTriReleases.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = getTriReleasesTool.input.parse({
      facility_id: 'WA0001234',
      chemical_name: 'LEAD',
    });
    const result = await getTriReleasesTool.handler(input, ctx);
    expect(result.message).toContain('LEAD');
  });

  it('trims whitespace from facility_id and chemical_name', async () => {
    mockGetTriReleases.mockResolvedValue([benzeneRelease]);
    const ctx = createMockContext();
    const input = getTriReleasesTool.input.parse({
      facility_id: '  WA0001234  ',
      chemical_name: '  benzene  ',
    });
    await getTriReleasesTool.handler(input, ctx);
    expect(mockGetTriReleases).toHaveBeenCalledWith(
      expect.objectContaining({ facilityId: 'WA0001234', chemicalName: 'benzene' }),
      expect.anything(),
    );
  });

  it('formats output with chemical name, year, and release amounts', () => {
    const output = { releases: [benzeneRelease], facilityId: 'WA0001234' };
    const blocks = getTriReleasesTool.format!(output);
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('WA0001234');
    expect(text).toContain('BENZENE');
    expect(text).toContain('2022');
    expect(text).toContain('1,240');
    expect(text).toContain('One-Time / Non-Routine Release');
  });

  it('formats empty result with message', () => {
    const output = {
      releases: [],
      facilityId: 'WA0001234',
      message: 'No TRI releases found.',
    };
    const blocks = getTriReleasesTool.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('WA0001234');
    expect(text).toContain('No TRI releases found.');
  });

  it('formats sparse release (only required fields)', () => {
    const sparse = {
      releases: [{ facilityId: 'WA9999', chemicalName: 'MERCURY', reportingYear: 2020 }],
      facilityId: 'WA9999',
    };
    const blocks = getTriReleasesTool.format!(sparse);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('MERCURY');
    expect(text).toContain('WA9999');
    expect(text).toContain('2020');
  });

  it('passes per-medium breakdown fields through from the service', async () => {
    mockGetTriReleases.mockResolvedValue([fullBreakdownRelease]);
    const ctx = createMockContext();
    const input = getTriReleasesTool.input.parse({ facility_id: 'WA0005678' });
    const result = await getTriReleasesTool.handler(input, ctx);
    expect(result.releases[0]).toMatchObject({
      releasesToAirInLbs: 15000,
      releasesToWaterInLbs: 200,
      releasesToLandInLbs: 3400,
      releasesToUndergroundInjectionInLbs: 90000,
    });
  });

  it('accepts the per-medium fields in the output schema', () => {
    const parsed = getTriReleasesTool.output.parse({
      releases: [fullBreakdownRelease],
      facilityId: 'WA0005678',
    });
    expect(parsed.releases[0]).toMatchObject({
      releasesToAirInLbs: 15000,
      releasesToUndergroundInjectionInLbs: 90000,
    });
  });

  it('formats all four media plus the distinct one-time release line', () => {
    const output = { releases: [fullBreakdownRelease], facilityId: 'WA0005678' };
    const text = (getTriReleasesTool.format!(output)[0] as { type: string; text: string }).text;
    expect(text).toContain('Air Releases');
    expect(text).toContain('15,000');
    expect(text).toContain('Water Releases');
    expect(text).toContain('Land Releases');
    expect(text).toContain('3,400');
    expect(text).toContain('Underground Injection');
    expect(text).toContain('90,000');
    // one_time_release_qty is a separate TRI category, rendered distinctly from the routine media.
    expect(text).toContain('One-Time / Non-Routine Release');
  });

  it('omits absent media in format without fabricating zero', () => {
    const airOnly = {
      releases: [
        {
          facilityId: 'WA0009999',
          chemicalName: 'XYLENE',
          reportingYear: 2020,
          releasesToAirInLbs: 500,
        },
      ],
      facilityId: 'WA0009999',
    };
    const text = (getTriReleasesTool.format!(airOnly)[0] as { type: string; text: string }).text;
    expect(text).toContain('Air Releases');
    expect(text).toContain('500');
    expect(text).not.toContain('Water Releases');
    expect(text).not.toContain('Land Releases');
    expect(text).not.toContain('Underground Injection');
    expect(text).not.toContain('One-Time / Non-Routine Release');
  });
});
