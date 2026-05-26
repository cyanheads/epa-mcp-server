/**
 * @fileoverview Tests for searchTriReleasesTool.
 * @module tests/mcp-server/tools/definitions/search-tri-releases.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchTriReleasesTool } from '@/mcp-server/tools/definitions/search-tri-releases.tool.js';

const mockSearchTriReleases = vi.fn();

vi.mock('@/services/dmap/dmap-service.js', () => ({
  getDmapService: () => ({
    searchTriReleases: mockSearchTriReleases,
    getTriReleases: vi.fn(),
    searchSuperfund: vi.fn(),
    searchWaterSystems: vi.fn(),
  }),
}));

const waRelease = {
  facilityId: 'WA0001234',
  facilityName: 'TEST FACILITY',
  chemicalName: 'BENZENE',
  reportingYear: 2022,
  totalReleasesInLbs: 580,
};

describe('searchTriReleasesTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns releases for valid state', async () => {
    mockSearchTriReleases.mockResolvedValue([waRelease]);
    const ctx = createMockContext();
    const input = searchTriReleasesTool.input.parse({ state: 'WA' });
    const result = await searchTriReleasesTool.handler(input, ctx);
    expect(result.state).toBe('WA');
    expect(result.releases).toHaveLength(1);
    expect(result.releases[0]!.chemicalName).toBe('BENZENE');
  });

  it('uppercases state before calling service', async () => {
    mockSearchTriReleases.mockResolvedValue([waRelease]);
    const ctx = createMockContext();
    const input = searchTriReleasesTool.input.parse({ state: 'WA' });
    await searchTriReleasesTool.handler(input, ctx);
    expect(mockSearchTriReleases).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'WA' }),
      expect.anything(),
    );
  });

  it('passes county and year filters to service', async () => {
    mockSearchTriReleases.mockResolvedValue([waRelease]);
    const ctx = createMockContext();
    const input = searchTriReleasesTool.input.parse({
      state: 'WA',
      county: 'KING',
      year: 2022,
    });
    await searchTriReleasesTool.handler(input, ctx);
    expect(mockSearchTriReleases).toHaveBeenCalledWith(
      expect.objectContaining({ county: 'KING', year: 2022 }),
      expect.anything(),
    );
  });

  it('passes chemical_name filter trimmed', async () => {
    mockSearchTriReleases.mockResolvedValue([waRelease]);
    const ctx = createMockContext();
    const input = searchTriReleasesTool.input.parse({ state: 'WA', chemical_name: '  BENZENE  ' });
    await searchTriReleasesTool.handler(input, ctx);
    expect(mockSearchTriReleases).toHaveBeenCalledWith(
      expect.objectContaining({ chemicalName: 'BENZENE' }),
      expect.anything(),
    );
  });

  it('returns message when no releases found', async () => {
    mockSearchTriReleases.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = searchTriReleasesTool.input.parse({ state: 'WY', year: 2010 });
    const result = await searchTriReleasesTool.handler(input, ctx);
    expect(result.releases).toHaveLength(0);
    expect(result.message).toContain('No TRI releases found');
    expect(result.message).toContain('WY');
    expect(result.message).toContain('2010');
  });

  it('formats output with chemical name, facility ID, and release amounts', () => {
    const output = { releases: [waRelease], state: 'WA' };
    const blocks = searchTriReleasesTool.format!(output);
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('TRI Releases');
    expect(text).toContain('WA');
    expect(text).toContain('BENZENE');
    expect(text).toContain('WA0001234');
    expect(text).toContain('2022');
    expect(text).toContain('580');
    expect(text).toContain('Release Quantity');
    expect(text).toContain('TEST FACILITY');
  });

  it('formats empty result with message', () => {
    const output = { releases: [], state: 'WY', message: 'No TRI releases found in WY.' };
    const blocks = searchTriReleasesTool.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('WY');
    expect(text).toContain('No TRI releases found');
  });

  it('formats sparse release (only required fields)', () => {
    const sparse = {
      releases: [{ facilityId: 'TX9999', chemicalName: 'TOLUENE', reportingYear: 2021 }],
      state: 'TX',
    };
    const blocks = searchTriReleasesTool.format!(sparse);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('TOLUENE');
    expect(text).toContain('TX9999');
    expect(text).toContain('2021');
  });
});
