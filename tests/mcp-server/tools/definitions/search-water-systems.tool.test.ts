/**
 * @fileoverview Tests for searchWaterSystemsTool.
 * @module tests/mcp-server/tools/definitions/search-water-systems.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchWaterSystemsTool } from '@/mcp-server/tools/definitions/search-water-systems.tool.js';

const mockSearchWaterSystems = vi.fn();

vi.mock('@/services/dmap/dmap-service.js', () => ({
  getDmapService: () => ({
    searchWaterSystems: mockSearchWaterSystems,
    getTriReleases: vi.fn(),
    searchTriReleases: vi.fn(),
    searchSuperfund: vi.fn(),
  }),
}));

const seattleWaterSystem = {
  pwsid: 'WA00200Y',
  name: 'SEATTLE PUBLIC UTILITIES',
  state: 'WA',
  city: 'SEATTLE',
  zip: '98104',
  type: 'CWS',
  populationServed: 730000,
  primarySourceCode: 'SW',
  hasViolation: false,
  isActive: true,
};

describe('searchWaterSystemsTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns water systems for valid state', async () => {
    mockSearchWaterSystems.mockResolvedValue([seattleWaterSystem]);
    const ctx = createMockContext();
    const input = searchWaterSystemsTool.input.parse({ state: 'WA' });
    const result = await searchWaterSystemsTool.handler(input, ctx);
    expect(result.totalCount).toBe(1);
    expect(result.systems).toHaveLength(1);
    expect(result.systems[0]!.pwsid).toBe('WA00200Y');
    expect(result.systems[0]!.populationServed).toBe(730000);
  });

  it('returns water systems for valid zip_code', async () => {
    mockSearchWaterSystems.mockResolvedValue([seattleWaterSystem]);
    const ctx = createMockContext();
    const input = searchWaterSystemsTool.input.parse({ zip_code: '98104' });
    const result = await searchWaterSystemsTool.handler(input, ctx);
    expect(result.systems).toHaveLength(1);
  });

  it('passes has_violation and pws_type filters to service', async () => {
    mockSearchWaterSystems.mockResolvedValue([seattleWaterSystem]);
    const ctx = createMockContext();
    const input = searchWaterSystemsTool.input.parse({
      state: 'WA',
      has_violation: true,
      pws_type: 'community',
    });
    await searchWaterSystemsTool.handler(input, ctx);
    expect(mockSearchWaterSystems).toHaveBeenCalledWith(
      expect.objectContaining({ hasViolation: true, pwsType: 'community' }),
      expect.anything(),
    );
  });

  it('throws no_geographic_filter when neither state nor zip_code provided', async () => {
    const ctx = createMockContext({ errors: searchWaterSystemsTool.errors });
    const input = searchWaterSystemsTool.input.parse({ has_violation: true });
    await expect(searchWaterSystemsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_geographic_filter' },
    });
  });

  it('throws no_geographic_filter when state and zip_code are blank strings', async () => {
    const ctx = createMockContext({ errors: searchWaterSystemsTool.errors });
    const input = searchWaterSystemsTool.input.parse({ state: '  ', zip_code: '  ' });
    await expect(searchWaterSystemsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_geographic_filter' },
    });
  });

  it('returns message when no systems found', async () => {
    mockSearchWaterSystems.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = searchWaterSystemsTool.input.parse({ state: 'WY', has_violation: true });
    const result = await searchWaterSystemsTool.handler(input, ctx);
    expect(result.systems).toHaveLength(0);
    expect(result.totalCount).toBe(0);
    expect(result.message).toContain('No water systems found');
    expect(result.message).toContain('WY');
  });

  it('formats output with PWSID, population, source, and violation flag', () => {
    const output = { systems: [seattleWaterSystem], totalCount: 1 };
    const blocks = searchWaterSystemsTool.format!(output);
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('Drinking Water Systems');
    expect(text).toContain('WA00200Y');
    expect(text).toContain('SEATTLE PUBLIC UTILITIES');
    expect(text).toContain('SEATTLE');
    expect(text).toContain('WA');
    expect(text).toContain('CWS');
    expect(text).toContain('730,000');
    expect(text).toContain('SW');
    expect(text).toContain('Active Violation:');
    expect(text).toContain('No');
    expect(text).toContain('Active:');
    expect(text).toContain('Yes');
  });

  it('shows violation warning flag in heading when hasViolation is true', () => {
    const systemWithViolation = { ...seattleWaterSystem, hasViolation: true };
    const output = { systems: [systemWithViolation], totalCount: 1 };
    const blocks = searchWaterSystemsTool.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('VIOLATION');
    expect(text).toContain('Active Violation');
  });

  it('formats empty result with message', () => {
    const output = {
      systems: [],
      totalCount: 0,
      message: 'No water systems found matching: state="WY".',
    };
    const blocks = searchWaterSystemsTool.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('No water systems found');
  });

  it('formats sparse water system (minimal required fields)', () => {
    const sparse = {
      systems: [{ pwsid: 'OR0000001', name: 'SPARSE UTILITY' }],
      totalCount: 1,
    };
    const blocks = searchWaterSystemsTool.format!(sparse);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('OR0000001');
    expect(text).toContain('SPARSE UTILITY');
  });
});
