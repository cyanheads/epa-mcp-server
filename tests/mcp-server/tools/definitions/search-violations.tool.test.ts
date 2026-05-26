/**
 * @fileoverview Tests for searchViolationsTool.
 * @module tests/mcp-server/tools/definitions/search-violations.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchViolationsTool } from '@/mcp-server/tools/definitions/search-violations.tool.js';

const mockSearchViolations = vi.fn();

vi.mock('@/services/echo/echo-service.js', () => ({
  getEchoService: () => ({
    searchViolations: mockSearchViolations,
    getFacility: vi.fn(),
    searchFacilities: vi.fn(),
  }),
}));

const waCase = {
  caseId: 'CAA-10-2023-0042',
  caseName: 'ACME INDUSTRIAL AIR VIOLATION',
  facilityName: 'ACME INDUSTRIAL',
  registryId: '110000111111',
  programsViolated: 'CAA',
  caseType: 'civil',
  penaltyAssessedInDollars: 75000,
  settlementDate: '2023-09-15',
  filedDate: '2023-01-10',
  state: 'WA',
};

describe('searchViolationsTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns cases for valid state filter', async () => {
    mockSearchViolations.mockResolvedValue({ cases: [waCase], totalCount: 1 });
    const ctx = createMockContext();
    const input = searchViolationsTool.input.parse({ state: 'WA' });
    const result = await searchViolationsTool.handler(input, ctx);
    expect(result.totalCount).toBe(1);
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0]!.caseId).toBe('CAA-10-2023-0042');
  });

  it('returns cases for valid zip_code filter', async () => {
    mockSearchViolations.mockResolvedValue({ cases: [waCase], totalCount: 1 });
    const ctx = createMockContext();
    const input = searchViolationsTool.input.parse({ zip_code: '98101' });
    const result = await searchViolationsTool.handler(input, ctx);
    expect(result.cases).toHaveLength(1);
  });

  it('passes program and case_type filters to service', async () => {
    mockSearchViolations.mockResolvedValue({ cases: [waCase], totalCount: 1 });
    const ctx = createMockContext();
    const input = searchViolationsTool.input.parse({
      state: 'WA',
      program: 'CAA',
      case_type: 'civil',
    });
    await searchViolationsTool.handler(input, ctx);
    expect(mockSearchViolations).toHaveBeenCalledWith(
      expect.objectContaining({ program: 'CAA', caseType: 'civil' }),
      expect.anything(),
    );
  });

  it('passes date range filters to service', async () => {
    mockSearchViolations.mockResolvedValue({ cases: [waCase], totalCount: 1 });
    const ctx = createMockContext();
    const input = searchViolationsTool.input.parse({
      state: 'WA',
      date_filed_start: '2023-01-01',
      date_filed_end: '2023-12-31',
    });
    await searchViolationsTool.handler(input, ctx);
    expect(mockSearchViolations).toHaveBeenCalledWith(
      expect.objectContaining({
        dateFiledStart: '2023-01-01',
        dateFiledEnd: '2023-12-31',
      }),
      expect.anything(),
    );
  });

  it('throws no_geographic_filter when neither state nor zip_code provided', async () => {
    const ctx = createMockContext({ errors: searchViolationsTool.errors });
    const input = searchViolationsTool.input.parse({ program: 'CAA' });
    await expect(searchViolationsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_geographic_filter' },
    });
  });

  it('throws no_geographic_filter when state and zip_code are blank strings', async () => {
    const ctx = createMockContext({ errors: searchViolationsTool.errors });
    const input = searchViolationsTool.input.parse({ state: '  ', zip_code: '  ' });
    await expect(searchViolationsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_geographic_filter' },
    });
  });

  it('returns message when no cases found', async () => {
    mockSearchViolations.mockResolvedValue({ cases: [], totalCount: 0 });
    const ctx = createMockContext();
    const input = searchViolationsTool.input.parse({ state: 'WA', program: 'TSCA' });
    const result = await searchViolationsTool.handler(input, ctx);
    expect(result.cases).toHaveLength(0);
    expect(result.totalCount).toBe(0);
    expect(result.message).toContain('No enforcement cases matched');
    expect(result.message).toContain('WA');
  });

  it('formats output with case ID, facility, penalty, and dates', () => {
    const output = { cases: [waCase], totalCount: 1 };
    const blocks = searchViolationsTool.format!(output);
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('EPA Enforcement Cases');
    expect(text).toContain('CAA-10-2023-0042');
    expect(text).toContain('ACME INDUSTRIAL AIR VIOLATION');
    expect(text).toContain('ACME INDUSTRIAL');
    expect(text).toContain('110000111111');
    expect(text).toContain('WA');
    expect(text).toContain('CAA');
    expect(text).toContain('civil');
    expect(text).toContain('$75,000');
    expect(text).toContain('2023-01-10');
    expect(text).toContain('2023-09-15');
  });

  it('formats empty result with message', () => {
    const output = {
      cases: [],
      totalCount: 0,
      message: 'No enforcement cases matched: state="WA".',
    };
    const blocks = searchViolationsTool.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('No enforcement cases matched');
  });

  it('formats sparse case (minimal fields — uses caseId for heading)', () => {
    const sparse = {
      cases: [{ caseId: 'CWA-04-2022-9999' }],
      totalCount: 1,
    };
    const blocks = searchViolationsTool.format!(sparse);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('CWA-04-2022-9999');
  });

  it('formats case without caseId or caseName using fallback heading', () => {
    const sparse = {
      cases: [{ facilityName: 'MYSTERY CO', state: 'TX' }],
      totalCount: 1,
    };
    const blocks = searchViolationsTool.format!(sparse);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('Unnamed Case');
    expect(text).toContain('MYSTERY CO');
    expect(text).toContain('TX');
  });
});
