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

/**
 * Fixture reflecting the real get_qid response shape (regression #11).
 * FacName, RegistryID, and State are NOT returned by get_qid — those fields are absent.
 * caseId comes from CaseNumber; caseType from CaseCategoryDesc; programsViolated from PrimaryLaw.
 */
const waCase = {
  caseId: 'CAA-10-2023-0042',
  caseName: 'ACME INDUSTRIAL AIR VIOLATION',
  // facilityName and registryId intentionally absent — not in get_qid response
  programsViolated: 'CAA',
  caseType: 'Administrative',
  penaltyAssessedInDollars: 75000,
  settlementDate: '2023-09-15',
  filedDate: '2023-01-10',
  // state intentionally absent — not in get_qid response
};

describe('searchViolationsTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns cases for valid state filter', async () => {
    mockSearchViolations.mockResolvedValue({ cases: [waCase], totalCount: 7 });
    const ctx = createMockContext({ errors: searchViolationsTool.errors });
    const input = searchViolationsTool.input.parse({ state: ' WA ' });
    const result = await searchViolationsTool.handler(input, ctx);
    expect(mockSearchViolations).toHaveBeenCalledWith(
      { state: 'WA', caseType: 'all', limit: 50 },
      ctx,
    );
    expect(result).toEqual({ cases: [waCase], totalCount: 7 });
  });

  it('returns cases for valid zip_code filter', async () => {
    mockSearchViolations.mockResolvedValue({ cases: [waCase], totalCount: 1 });
    const ctx = createMockContext({ errors: searchViolationsTool.errors });
    const input = searchViolationsTool.input.parse({ zip_code: '98101' });
    const result = await searchViolationsTool.handler(input, ctx);
    expect(mockSearchViolations).toHaveBeenCalledWith(
      { zipCode: '98101', caseType: 'all', limit: 50 },
      ctx,
    );
    expect(result.cases).toEqual([waCase]);
  });

  it('passes program and case_type filters to service', async () => {
    mockSearchViolations.mockResolvedValue({ cases: [waCase], totalCount: 1 });
    const ctx = createMockContext({ errors: searchViolationsTool.errors });
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
    const ctx = createMockContext({ errors: searchViolationsTool.errors });
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
    const ctx = createMockContext({ errors: searchViolationsTool.errors });
    const input = searchViolationsTool.input.parse({ state: 'WA', program: 'TSCA' });
    const result = await searchViolationsTool.handler(input, ctx);
    expect(result.cases).toHaveLength(0);
    expect(result.totalCount).toBe(0);
    expect(result.message).toBe(
      'No enforcement cases matched: state="WA", program="TSCA". Try removing program or date filters, or expanding the geographic area.',
    );
  });

  it('formats output with case ID, program, penalty, and dates (real get_qid fields)', () => {
    const output = { cases: [waCase], totalCount: 1 };
    const blocks = searchViolationsTool.format!(output);
    expect(blocks).toHaveLength(1);
    const lines = (blocks[0] as { type: string; text: string }).text.split('\n');
    // facilityName, registryId, and state are absent from get_qid — no lines for them
    for (const line of [
      '## EPA Enforcement Cases',
      '**Total Found:** 1 | **Returned:** 1',
      '### ACME INDUSTRIAL AIR VIOLATION',
      '**Case ID:** CAA-10-2023-0042',
      '**Programs:** CAA',
      '**Type:** Administrative',
      '**Penalty:** $75,000',
      '**Filed:** 2023-01-10',
      '**Settlement:** 2023-09-15',
    ]) {
      expect(lines).toContain(line);
    }
  });

  it('formats empty result with message', () => {
    const output = {
      cases: [],
      totalCount: 0,
      message: 'No enforcement cases matched: state="WA".',
    };
    const blocks = searchViolationsTool.format!(output);
    const lines = (blocks[0] as { type: string; text: string }).text.split('\n');
    expect(lines).toContain('**Total Found:** 0 | **Returned:** 0');
    expect(lines).toContain('> No enforcement cases matched: state="WA".');
  });

  it('formats sparse case (minimal fields — uses caseId for heading)', () => {
    const sparse = {
      cases: [{ caseId: 'CWA-04-2022-9999' }],
      totalCount: 1,
    };
    const blocks = searchViolationsTool.format!(sparse);
    const lines = (blocks[0] as { type: string; text: string }).text.split('\n');
    expect(lines).toContain('### CWA-04-2022-9999');
    expect(lines).toContain('**Case ID:** CWA-04-2022-9999');
  });

  it('formats case without caseId or caseName using fallback heading', () => {
    const sparse = {
      cases: [{ facilityName: 'MYSTERY CO', state: 'TX' }],
      totalCount: 1,
    };
    const blocks = searchViolationsTool.format!(sparse);
    const lines = (blocks[0] as { type: string; text: string }).text.split('\n');
    expect(lines).toContain('### Unnamed Case');
    expect(lines).toContain('**Facility:** MYSTERY CO');
    expect(lines).toContain('**State:** TX');
  });
});
