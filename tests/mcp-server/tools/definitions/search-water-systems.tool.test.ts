/**
 * @fileoverview Tests for searchWaterSystemsTool.
 * @module tests/mcp-server/tools/definitions/search-water-systems.tool.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
    const ctx = createMockContext({ errors: searchWaterSystemsTool.errors });
    const input = searchWaterSystemsTool.input.parse({ state: ' WA ' });
    const result = await searchWaterSystemsTool.handler(input, ctx);
    expect(result).toEqual({ systems: [seattleWaterSystem], totalCount: 1 });
    expect(mockSearchWaterSystems).toHaveBeenCalledWith({ state: 'WA', limit: 50 }, ctx);
  });

  it('returns water systems for valid zip_code', async () => {
    mockSearchWaterSystems.mockResolvedValue([seattleWaterSystem]);
    const ctx = createMockContext({ errors: searchWaterSystemsTool.errors });
    const input = searchWaterSystemsTool.input.parse({ zip_code: ' 98104 ' });
    const result = await searchWaterSystemsTool.handler(input, ctx);
    expect(result).toEqual({ systems: [seattleWaterSystem], totalCount: 1 });
    expect(mockSearchWaterSystems).toHaveBeenCalledWith({ zipCode: '98104', limit: 50 }, ctx);
  });

  it('passes has_violation and pws_type filters to service', async () => {
    mockSearchWaterSystems.mockResolvedValue([seattleWaterSystem]);
    const ctx = createMockContext({ errors: searchWaterSystemsTool.errors });
    const input = searchWaterSystemsTool.input.parse({
      state: 'WA',
      has_violation: true,
      pws_type: 'community',
    });
    await searchWaterSystemsTool.handler(input, ctx);
    expect(mockSearchWaterSystems).toHaveBeenCalledWith(
      { state: 'WA', hasViolation: true, pwsType: 'community', limit: 50 },
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
    const ctx = createMockContext({ errors: searchWaterSystemsTool.errors });
    const input = searchWaterSystemsTool.input.parse({ state: 'WY', has_violation: true });
    const result = await searchWaterSystemsTool.handler(input, ctx);
    expect(result).toEqual({
      systems: [],
      totalCount: 0,
      message:
        'No water systems found matching: state="WY", has_violation=true. Try removing the violation or type filter, or checking the state abbreviation.',
    });
  });

  it('formats output with PWSID, population, source, and violation flag', () => {
    const output = { systems: [seattleWaterSystem], totalCount: 1 };
    const blocks = searchWaterSystemsTool.format!(output);
    expect(blocks).toEqual([
      {
        type: 'text',
        text: [
          '## Drinking Water Systems',
          '**Found:** 1',
          '',
          '### SEATTLE PUBLIC UTILITIES',
          '**PWSID:** WA00200Y',
          '**Location:** SEATTLE, WA, 98104',
          '**Type:** CWS',
          '**Population Served:** 730,000',
          '**Primary Source:** SW',
          '**Open Violation:** No',
          '**Active:** Yes',
        ].join('\n'),
      },
    ]);
  });

  it('shows violation warning flag in heading when hasViolation is true', () => {
    const systemWithViolation = { ...seattleWaterSystem, hasViolation: true };
    const output = { systems: [systemWithViolation], totalCount: 1 };
    const blocks = searchWaterSystemsTool.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('\n### SEATTLE PUBLIC UTILITIES ⚠️ VIOLATION\n');
    expect(text).toContain('**Open Violation:** Yes');
  });

  describe('violation wording matches the open-only filter', () => {
    const shape = searchWaterSystemsTool.input.shape;
    const systemShape = searchWaterSystemsTool.output.shape.systems.element.shape;

    it('describes has_violation as open violations, never "active"', () => {
      const text = shape.has_violation.description ?? '';
      expect(text).toMatch(/open/i);
      expect(text).toMatch(/returned to compliance/i);
      expect(text).not.toMatch(/active/i);
    });

    it('describes hasViolation as an open violation, never "active"', () => {
      const text = systemShape.hasViolation.description ?? '';
      expect(text).toMatch(/open/i);
      expect(text).not.toMatch(/active/i);
    });

    it('tool description promises open violation status and ZIP support', () => {
      expect(searchWaterSystemsTool.description).toMatch(/open violation/i);
      expect(searchWaterSystemsTool.description).not.toMatch(/active violation/i);
      expect(searchWaterSystemsTool.description).toContain('by state or ZIP code');
    });
  });

  it('formats empty result with message', () => {
    const output = {
      systems: [],
      totalCount: 0,
      message: 'No water systems found matching: state="WY".',
    };
    const blocks = searchWaterSystemsTool.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toBe(
      [
        '## Drinking Water Systems',
        '**Found:** 0',
        '',
        '> No water systems found matching: state="WY".',
      ].join('\n'),
    );
  });

  describe('partial violation-scan notice', () => {
    const scanNotice =
      'The violation check read the first 1,000 of this state’s SDWIS violation records, naming 559 distinct systems.';

    it('carries the service notice on both structuredContent and content', async () => {
      mockSearchWaterSystems.mockImplementation((_params, ctx) => {
        ctx.enrich.notice(scanNotice);
        return Promise.resolve([{ ...seattleWaterSystem, hasViolation: true }]);
      });
      const call = await runToolContract(searchWaterSystemsTool, {
        state: 'WA',
        has_violation: true,
      });
      expect(call.isError).toBeFalsy();
      const structured = call.structuredContent as { systems: unknown[]; notice?: string };
      expect(structured.systems).toHaveLength(1);
      expect(structured.notice).toBe(scanNotice);
      const text = call.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      expect(text).toContain(scanNotice);
      expect(text).toContain('WA00200Y');
    });

    it('carries the notice beside the no-results message', async () => {
      mockSearchWaterSystems.mockImplementation((_params, ctx) => {
        ctx.enrich.notice(scanNotice);
        return Promise.resolve([]);
      });
      const call = await runToolContract(searchWaterSystemsTool, {
        state: 'WA',
        has_violation: true,
        pws_type: 'transient',
      });
      const structured = call.structuredContent as { message?: string; notice?: string };
      expect(structured.message).toContain('No water systems found');
      expect(structured.notice).toBe(scanNotice);
    });

    it('passes a ZIP-only has_violation search to the service and carries its notice', async () => {
      const zipNotice =
        'The violation check read only the first 1,000 water systems in ZIP 98104; systems past that point were not checked.';
      mockSearchWaterSystems.mockImplementation((_params, ctx) => {
        ctx.enrich.notice(zipNotice);
        return Promise.resolve([{ ...seattleWaterSystem, hasViolation: true }]);
      });
      const call = await runToolContract(searchWaterSystemsTool, {
        zip_code: '98104',
        has_violation: true,
      });
      expect(mockSearchWaterSystems).toHaveBeenCalledWith(
        { zipCode: '98104', hasViolation: true, limit: 50 },
        expect.anything(),
      );
      const structured = call.structuredContent as {
        systems: Array<{ hasViolation?: boolean }>;
        notice?: string;
      };
      expect(structured.systems[0]?.hasViolation).toBe(true);
      expect(structured.notice).toBe(zipNotice);
      const text = call.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      expect(text).toContain(zipNotice);
      expect(text).toContain('VIOLATION');
    });

    it('adds no notice when the service reports none', async () => {
      mockSearchWaterSystems.mockResolvedValue([seattleWaterSystem]);
      const call = await runToolContract(searchWaterSystemsTool, { state: 'WA' });
      expect(call.structuredContent).not.toHaveProperty('notice');
    });
  });

  it('formats sparse water system (minimal required fields)', () => {
    const sparse = {
      systems: [{ pwsid: 'OR0000001', name: 'SPARSE UTILITY' }],
      totalCount: 1,
    };
    const blocks = searchWaterSystemsTool.format!(sparse);
    const text = (blocks[0] as { type: string; text: string }).text;
    // Absent optional fields render no line at all, and no violation flag or status.
    expect(text).toBe(
      [
        '## Drinking Water Systems',
        '**Found:** 1',
        '',
        '### SPARSE UTILITY',
        '**PWSID:** OR0000001',
      ].join('\n'),
    );
  });
});
