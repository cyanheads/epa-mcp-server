/**
 * @fileoverview Tests for echoSearchViolationsTool.
 * @module tests/mcp-server/tools/definitions/echo-search-violations.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { echoSearchViolationsTool } from '@/mcp-server/tools/definitions/echo-search-violations.tool.js';

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

/** The notice a date-bounded case_type "all" search carries. */
const CRIMINAL_EXCLUSION_NOTICE =
  'Criminal cases are excluded: ECHO records filing dates for civil cases only, so a filing-date range returns civil cases. Search case_type "criminal" without dates for criminal cases.';

describe('echoSearchViolationsTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns cases for valid state filter', async () => {
    mockSearchViolations.mockResolvedValue({ cases: [waCase], totalCount: 7 });
    const ctx = createMockContext({ errors: echoSearchViolationsTool.errors });
    const input = echoSearchViolationsTool.input.parse({ state: ' WA ' });
    const result = await echoSearchViolationsTool.handler(input, ctx);
    expect(mockSearchViolations).toHaveBeenCalledWith(
      { state: 'WA', caseType: 'all', limit: 50 },
      ctx,
    );
    expect(result).toEqual({ cases: [waCase], totalCount: 7 });
  });

  it('returns cases for valid zip_code filter', async () => {
    mockSearchViolations.mockResolvedValue({ cases: [waCase], totalCount: 1 });
    const ctx = createMockContext({ errors: echoSearchViolationsTool.errors });
    const input = echoSearchViolationsTool.input.parse({ zip_code: '98101' });
    const result = await echoSearchViolationsTool.handler(input, ctx);
    expect(mockSearchViolations).toHaveBeenCalledWith(
      { zipCode: '98101', caseType: 'all', limit: 50 },
      ctx,
    );
    expect(result.cases).toEqual([waCase]);
  });

  it('passes program and case_type filters to service', async () => {
    mockSearchViolations.mockResolvedValue({ cases: [waCase], totalCount: 1 });
    const ctx = createMockContext({ errors: echoSearchViolationsTool.errors });
    const input = echoSearchViolationsTool.input.parse({
      state: 'WA',
      program: 'CAA',
      case_type: 'civil',
    });
    await echoSearchViolationsTool.handler(input, ctx);
    expect(mockSearchViolations).toHaveBeenCalledWith(
      expect.objectContaining({ program: 'CAA', caseType: 'civil' }),
      expect.anything(),
    );
  });

  it('passes date range filters to service', async () => {
    mockSearchViolations.mockResolvedValue({ cases: [waCase], totalCount: 1 });
    const ctx = createMockContext({ errors: echoSearchViolationsTool.errors });
    const input = echoSearchViolationsTool.input.parse({
      state: 'WA',
      date_filed_start: '2023-01-01',
      date_filed_end: '2023-12-31',
    });
    await echoSearchViolationsTool.handler(input, ctx);
    expect(mockSearchViolations).toHaveBeenCalledWith(
      expect.objectContaining({
        dateFiledStart: '2023-01-01',
        dateFiledEnd: '2023-12-31',
      }),
      expect.anything(),
    );
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', ' \t '],
  ])('treats %s date strings as no bound', async (_label, blank) => {
    mockSearchViolations.mockResolvedValue({ cases: [waCase], totalCount: 1 });
    const ctx = createMockContext({ errors: echoSearchViolationsTool.errors });
    const input = echoSearchViolationsTool.input.parse({
      state: 'WA',
      date_filed_start: blank,
      date_filed_end: blank,
    });
    await echoSearchViolationsTool.handler(input, ctx);
    expect(mockSearchViolations).toHaveBeenCalledWith(
      { state: 'WA', caseType: 'all', limit: 50 },
      ctx,
    );
    expect(getEnrichment(ctx)).not.toHaveProperty('notice');
  });

  it('trims padding around a filing date', async () => {
    mockSearchViolations.mockResolvedValue({ cases: [waCase], totalCount: 1 });
    const ctx = createMockContext({ errors: echoSearchViolationsTool.errors });
    const input = echoSearchViolationsTool.input.parse({
      state: 'WA',
      date_filed_start: ' 2024-01-01 ',
    });
    await echoSearchViolationsTool.handler(input, ctx);
    expect(mockSearchViolations).toHaveBeenCalledWith(
      { state: 'WA', caseType: 'all', dateFiledStart: '2024-01-01', limit: 50 },
      ctx,
    );
  });

  it.each(['01/01/2024', '2024-1-1', '2024'])(
    'regression #28: rejects the non-ISO date %s at the schema',
    (date) => {
      expect(
        echoSearchViolationsTool.input.safeParse({ state: 'WA', date_filed_start: date }).success,
      ).toBe(false);
      expect(
        echoSearchViolationsTool.input.safeParse({ state: 'WA', date_filed_end: date }).success,
      ).toBe(false);
    },
  );

  it.each([
    ['date_filed_start', '2024-02-30'],
    ['date_filed_end', '2023-13-01'],
    ['date_filed_end', '2023-02-29'],
  ])('regression #28: rejects %s %s as invalid_date before any request', async (field, date) => {
    const ctx = createMockContext({ errors: echoSearchViolationsTool.errors });
    const input = echoSearchViolationsTool.input.parse({ state: 'WA', [field]: date });
    await expect(echoSearchViolationsTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: `${field} "${date}" is not a calendar date.`,
      data: { reason: 'invalid_date', field },
    });
    expect(mockSearchViolations).not.toHaveBeenCalled();
  });

  it.each([
    [
      'invalid_date',
      { date_filed_start: '2024-02-30' },
      'Pass a real calendar date in YYYY-MM-DD form, such as 2024-02-29.',
    ],
    [
      'date_range_inverted',
      { date_filed_start: '2024-12-31', date_filed_end: '2024-01-01' },
      'Swap the two dates so date_filed_start is on or before date_filed_end.',
    ],
    [
      'criminal_date_filter',
      { case_type: 'criminal' as const, date_filed_end: '2024-12-31' },
      'Drop date_filed_start and date_filed_end to search criminal cases, or set case_type to civil.',
    ],
  ])('carries the %s recovery hint on both surfaces', async (reason, filters, hint) => {
    const result = await runToolContract(echoSearchViolationsTool, { state: 'WA', ...filters });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ValidationError, data: { reason, recovery: { hint } } },
    });
    expect(JSON.stringify(result.content)).toContain(hint);
    expect(mockSearchViolations).not.toHaveBeenCalled();
  });

  it('accepts a leap day', async () => {
    mockSearchViolations.mockResolvedValue({ cases: [waCase], totalCount: 1 });
    const ctx = createMockContext({ errors: echoSearchViolationsTool.errors });
    const input = echoSearchViolationsTool.input.parse({
      state: 'WA',
      date_filed_start: '2024-02-29',
    });
    await echoSearchViolationsTool.handler(input, ctx);
    expect(mockSearchViolations).toHaveBeenCalledWith(
      expect.objectContaining({ dateFiledStart: '2024-02-29' }),
      ctx,
    );
  });

  it('regression #28: rejects a start date after the end date before any request', async () => {
    const ctx = createMockContext({ errors: echoSearchViolationsTool.errors });
    const input = echoSearchViolationsTool.input.parse({
      state: 'WA',
      date_filed_start: '2024-12-31',
      date_filed_end: '2024-01-01',
    });
    await expect(echoSearchViolationsTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'date_range_inverted' },
    });
    expect(mockSearchViolations).not.toHaveBeenCalled();
  });

  it('accepts a one-day range', async () => {
    mockSearchViolations.mockResolvedValue({ cases: [waCase], totalCount: 1 });
    const ctx = createMockContext({ errors: echoSearchViolationsTool.errors });
    const input = echoSearchViolationsTool.input.parse({
      state: 'WA',
      date_filed_start: '2024-05-01',
      date_filed_end: '2024-05-01',
    });
    await echoSearchViolationsTool.handler(input, ctx);
    expect(mockSearchViolations).toHaveBeenCalledWith(
      expect.objectContaining({ dateFiledStart: '2024-05-01', dateFiledEnd: '2024-05-01' }),
      ctx,
    );
  });

  it.each([{ date_filed_start: '2024-01-01' }, { date_filed_end: '2024-12-31' }])(
    'regression #28: rejects case_type criminal with a date bound (%o)',
    async (dates) => {
      const ctx = createMockContext({ errors: echoSearchViolationsTool.errors });
      const input = echoSearchViolationsTool.input.parse({
        state: 'WA',
        case_type: 'criminal',
        ...dates,
      });
      await expect(echoSearchViolationsTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'criminal_date_filter' },
      });
      expect(mockSearchViolations).not.toHaveBeenCalled();
    },
  );

  it('regression #28: discloses that a date-bounded "all" search excludes criminal cases', async () => {
    mockSearchViolations.mockResolvedValue({ cases: [waCase], totalCount: 87 });
    const ctx = createMockContext({ errors: echoSearchViolationsTool.errors });
    const input = echoSearchViolationsTool.input.parse({
      state: 'WA',
      date_filed_start: '2024-01-01',
      date_filed_end: '2024-12-31',
    });
    const result = await echoSearchViolationsTool.handler(input, ctx);
    expect(result.totalCount).toBe(87);
    expect(getEnrichment(ctx)).toEqual({ notice: CRIMINAL_EXCLUSION_NOTICE });
  });

  it('renders the criminal-exclusion notice on both surfaces', async () => {
    mockSearchViolations.mockResolvedValue({ cases: [waCase], totalCount: 87 });
    const result = await runToolContract(echoSearchViolationsTool, {
      state: 'WA',
      date_filed_start: '2024-01-01',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      cases: [waCase],
      totalCount: 87,
      notice: CRIMINAL_EXCLUSION_NOTICE,
    });
    const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    expect(text).toContain(CRIMINAL_EXCLUSION_NOTICE);
    expect(text).toContain('**Case ID:** CAA-10-2023-0042');
  });

  it.each([
    ['civil with dates', { case_type: 'civil', date_filed_start: '2024-01-01' }],
    ['all without dates', { case_type: 'all' }],
    ['criminal without dates', { case_type: 'criminal' }],
  ])('adds no criminal-exclusion notice for %s', async (_label, filters) => {
    mockSearchViolations.mockResolvedValue({ cases: [waCase], totalCount: 1 });
    const ctx = createMockContext({ errors: echoSearchViolationsTool.errors });
    const input = echoSearchViolationsTool.input.parse({ state: 'WA', ...filters });
    await echoSearchViolationsTool.handler(input, ctx);
    expect(getEnrichment(ctx)).not.toHaveProperty('notice');
  });

  it('echoes the date filters in the no-match message', async () => {
    mockSearchViolations.mockResolvedValue({ cases: [], totalCount: 0 });
    const ctx = createMockContext({ errors: echoSearchViolationsTool.errors });
    const input = echoSearchViolationsTool.input.parse({
      zip_code: '98108',
      case_type: 'civil',
      date_filed_start: '2026-10-01',
    });
    const result = await echoSearchViolationsTool.handler(input, ctx);
    expect(result.message).toBe(
      'No enforcement cases matched: zip_code="98108", case_type="civil", date_filed_start="2026-10-01". Try removing program or date filters, or expanding the geographic area.',
    );
  });

  it('throws no_geographic_filter when neither state nor zip_code provided', async () => {
    const ctx = createMockContext({ errors: echoSearchViolationsTool.errors });
    const input = echoSearchViolationsTool.input.parse({ program: 'CAA' });
    await expect(echoSearchViolationsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_geographic_filter' },
    });
  });

  it('throws no_geographic_filter when state and zip_code are blank strings', async () => {
    const ctx = createMockContext({ errors: echoSearchViolationsTool.errors });
    const input = echoSearchViolationsTool.input.parse({ state: '  ', zip_code: '  ' });
    await expect(echoSearchViolationsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_geographic_filter' },
    });
  });

  it('returns message when no cases found', async () => {
    mockSearchViolations.mockResolvedValue({ cases: [], totalCount: 0 });
    const ctx = createMockContext({ errors: echoSearchViolationsTool.errors });
    const input = echoSearchViolationsTool.input.parse({ state: 'WA', program: 'TSCA' });
    const result = await echoSearchViolationsTool.handler(input, ctx);
    expect(result.cases).toHaveLength(0);
    expect(result.totalCount).toBe(0);
    expect(result.message).toBe(
      'No enforcement cases matched: state="WA", program="TSCA". Try removing program or date filters, or expanding the geographic area.',
    );
  });

  it('formats output with case ID, program, penalty, and dates (real get_qid fields)', () => {
    const output = { cases: [waCase], totalCount: 1 };
    const blocks = echoSearchViolationsTool.format!(output);
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
    const blocks = echoSearchViolationsTool.format!(output);
    const lines = (blocks[0] as { type: string; text: string }).text.split('\n');
    expect(lines).toContain('**Total Found:** 0 | **Returned:** 0');
    expect(lines).toContain('> No enforcement cases matched: state="WA".');
  });

  it('formats sparse case (minimal fields — uses caseId for heading)', () => {
    const sparse = {
      cases: [{ caseId: 'CWA-04-2022-9999' }],
      totalCount: 1,
    };
    const blocks = echoSearchViolationsTool.format!(sparse);
    const lines = (blocks[0] as { type: string; text: string }).text.split('\n');
    expect(lines).toContain('### CWA-04-2022-9999');
    expect(lines).toContain('**Case ID:** CWA-04-2022-9999');
  });

  it('formats case without caseId or caseName using fallback heading', () => {
    const sparse = {
      cases: [{ facilityName: 'MYSTERY CO', state: 'TX' }],
      totalCount: 1,
    };
    const blocks = echoSearchViolationsTool.format!(sparse);
    const lines = (blocks[0] as { type: string; text: string }).text.split('\n');
    expect(lines).toContain('### Unnamed Case');
    expect(lines).toContain('**Facility:** MYSTERY CO');
    expect(lines).toContain('**State:** TX');
  });
});
