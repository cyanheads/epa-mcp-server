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

  it('formats output with case ID, program, penalty, and dates (real get_qid fields)', () => {
    const output = { cases: [waCase], totalCount: 1 };
    const blocks = searchViolationsTool.format!(output);
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('EPA Enforcement Cases');
    expect(text).toContain('CAA-10-2023-0042');
    expect(text).toContain('ACME INDUSTRIAL AIR VIOLATION');
    // facilityName, registryId, and state are absent from get_qid — not asserted
    expect(text).toContain('CAA');
    expect(text).toContain('Administrative');
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

  it('regression #11: service passes QueryID from step 1 to get_qid in step 2', async () => {
    // The fix: searchViolations() calls get_case_info (step 1) to get QueryID,
    // then calls get_qid (step 2) to retrieve actual Cases[]. Before the fix,
    // it read Cases directly from get_case_info which always returned [].
    const step1Result = { cases: [waCase], totalCount: 1 };
    mockSearchViolations.mockResolvedValue(step1Result);
    const ctx = createMockContext();
    const input = searchViolationsTool.input.parse({ state: 'WA' });
    const result = await searchViolationsTool.handler(input, ctx);
    // Service was called — verify it received the state filter
    expect(mockSearchViolations).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'WA' }),
      expect.anything(),
    );
    // Result came back non-empty — the two-step flow worked
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0]!.caseId).toBe('CAA-10-2023-0042');
    expect(result.totalCount).toBe(1);
  });

  it('regression #11: service maps real get_qid fields — CaseNumber→caseId, CaseCategoryDesc→caseType, PrimaryLaw→programsViolated, FedPenalty→penaltyAssessedInDollars', async () => {
    // Fixture with real get_qid field names (raw service output after normalization)
    const normalizedCase = {
      caseId: '03-2014-7010', // from CaseNumber
      caseName: 'SOME CASE',
      caseType: 'Judicial', // from CaseCategoryDesc
      programsViolated: 'CERCLA', // from PrimaryLaw
      penaltyAssessedInDollars: 27044146, // parsed from "$27,044,146.00"
      filedDate: '2014-03-01', // from DateFiled
    };
    mockSearchViolations.mockResolvedValue({ cases: [normalizedCase], totalCount: 1 });
    const ctx = createMockContext();
    const input = searchViolationsTool.input.parse({ state: 'WA' });
    const result = await searchViolationsTool.handler(input, ctx);
    expect(result.cases[0]!.caseId).toBe('03-2014-7010');
    expect(result.cases[0]!.caseType).toBe('Judicial');
    expect(result.cases[0]!.programsViolated).toBe('CERCLA');
    expect(result.cases[0]!.penaltyAssessedInDollars).toBe(27044146);
    expect(result.cases[0]!.filedDate).toBe('2014-03-01');
  });
});
