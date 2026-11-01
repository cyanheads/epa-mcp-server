/**
 * @fileoverview Tests for waterSearchSystemsTool: input normalization and validation, the
 * service wiring (county, active_only, paging, the ECHO current-violation lookup), the
 * effectiveQuery echo, empty-result guidance, and both output surfaces.
 * @module tests/mcp-server/tools/definitions/water-search-systems.tool.test
 */

import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waterSearchSystemsTool } from '@/mcp-server/tools/definitions/water-search-systems.tool.js';
import type { CallBudget } from '@/services/call-budget.js';
import type { CurrentViolatorLookup } from '@/services/dmap/dmap-service.js';
import { expectInvalidState, textOf } from '../../../helpers.js';

const mockSearchWaterSystems = vi.fn();
const mockFindCurrentSdwViolators = vi.fn();

vi.mock('@/services/dmap/dmap-service.js', () => ({
  getDmapService: () => ({
    searchWaterSystems: mockSearchWaterSystems,
    getTriReleases: vi.fn(),
    searchTriReleases: vi.fn(),
    searchSuperfund: vi.fn(),
  }),
}));

vi.mock('@/services/echo/echo-service.js', () => ({
  getEchoService: () => ({ findCurrentSdwViolators: mockFindCurrentSdwViolators }),
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

/** The params the handler passed to searchWaterSystems on its first call. */
const serviceParams = () => mockSearchWaterSystems.mock.calls[0]![0] as Record<string, unknown>;

describe('waterSearchSystemsTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns water systems for valid state', async () => {
    mockSearchWaterSystems.mockResolvedValue({ items: [seattleWaterSystem], totalCount: 1 });
    const ctx = createMockContext({ errors: waterSearchSystemsTool.errors });
    const input = waterSearchSystemsTool.input.parse({ state: ' WA ' });
    const result = await waterSearchSystemsTool.handler(input, ctx);
    expect(result).toEqual({ systems: [seattleWaterSystem], totalCount: 1 });
    expect(mockSearchWaterSystems).toHaveBeenCalledWith({ state: 'WA', offset: 0, limit: 50 }, ctx);
  });

  it('returns water systems for valid zip_code', async () => {
    mockSearchWaterSystems.mockResolvedValue({ items: [seattleWaterSystem] });
    const ctx = createMockContext({ errors: waterSearchSystemsTool.errors });
    const input = waterSearchSystemsTool.input.parse({ zip_code: ' 98104 ' });
    const result = await waterSearchSystemsTool.handler(input, ctx);
    expect(result).toEqual({ systems: [seattleWaterSystem] });
    expect(mockSearchWaterSystems).toHaveBeenCalledWith(
      { zipCode: '98104', offset: 0, limit: 50 },
      ctx,
    );
  });

  it('searches an EPA region code as the state SDWIS files tribal systems under', async () => {
    mockSearchWaterSystems.mockResolvedValue({
      items: [{ ...seattleWaterSystem, state: '09' }],
      totalCount: 1,
    });
    const call = await runToolContract(waterSearchSystemsTool, { state: '09' });
    expect(call.isError).toBeFalsy();
    expect(serviceParams()).toEqual({ state: '09', offset: 0, limit: 50 });
    expect(call.structuredContent).toMatchObject({ totalCount: 1 });
  });

  it.each(['98108-1234', '981081234'])('searches ZIP+4 %j by its 5-digit ZIP', async (zip_code) => {
    mockSearchWaterSystems.mockResolvedValue({ items: [seattleWaterSystem] });
    const call = await runToolContract(waterSearchSystemsTool, { zip_code });
    expect(call.isError).toBeFalsy();
    expect(serviceParams()).toEqual({ zipCode: '98108', offset: 0, limit: 50 });
    expect(call.structuredContent).toMatchObject({ effectiveQuery: 'zip_code begins with 98108' });
  });

  it.each([
    [{ state: 'Washington' }, '2-letter USPS code'],
    [{ state: 'W' }, '2-letter USPS code'],
    [{ zip_code: '2134' }, '5-digit ZIP code'],
    [{ zip_code: 'abcde' }, '5-digit ZIP code'],
  ])('rejects %j at the schema, naming the expected form', async (args, form) => {
    const call = await runToolContract(waterSearchSystemsTool, args);
    expect(call.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(textOf(call.content)).toContain(form);
    expect(mockSearchWaterSystems).not.toHaveBeenCalled();
  });

  it('rejects an unknown state code as invalid_state with its recovery, before any request', async () => {
    expectInvalidState(await runToolContract(waterSearchSystemsTool, { state: 'zz' }));
    expect(mockSearchWaterSystems).not.toHaveBeenCalled();
  });

  it('throws no_geographic_filter when neither state nor zip_code provided', async () => {
    const ctx = createMockContext({ errors: waterSearchSystemsTool.errors });
    const input = waterSearchSystemsTool.input.parse({ has_violation: true });
    await expect(waterSearchSystemsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_geographic_filter' },
    });
  });

  it.each(['', '  '])(
    'throws no_geographic_filter when state and zip_code are blank (%j)',
    async (blank) => {
      const ctx = createMockContext({ errors: waterSearchSystemsTool.errors });
      const input = waterSearchSystemsTool.input.parse({ state: blank, zip_code: blank });
      await expect(waterSearchSystemsTool.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'no_geographic_filter' },
      });
    },
  );

  describe('county served', () => {
    it.each([{ county: 'King' }, { county: 'King', zip_code: '98104' }])(
      'fails %j without state as county_requires_state, naming state, before any request',
      async (args) => {
        const call = await runToolContract(waterSearchSystemsTool, args);
        expect(call.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ValidationError,
            message: expect.stringContaining('state'),
            data: { reason: 'county_requires_state' },
          },
        });
        expect(textOf(call.content)).toContain('e.g. state "WA" with county "King"');
        expect(mockSearchWaterSystems).not.toHaveBeenCalled();
      },
    );

    it.each(['King', 'KING', 'king', ' King County ', 'king parish'])(
      'sends county %j as the bare uppercase name and echoes it as an exact match',
      async (county) => {
        mockSearchWaterSystems.mockResolvedValue({ items: [seattleWaterSystem] });
        const call = await runToolContract(waterSearchSystemsTool, { state: 'wa', county });
        expect(serviceParams()).toEqual({ state: 'WA', county: 'KING', offset: 0, limit: 50 });
        expect(call.structuredContent).toMatchObject({ effectiveQuery: 'state=WA; county=KING' });
      },
    );

    it('reads a blank county as omitted', async () => {
      mockSearchWaterSystems.mockResolvedValue({ items: [seattleWaterSystem] });
      const call = await runToolContract(waterSearchSystemsTool, { state: 'WA', county: '  ' });
      expect(serviceParams()).toEqual({ state: 'WA', offset: 0, limit: 50 });
      expect(call.structuredContent).toMatchObject({ effectiveQuery: 'state=WA' });
    });

    it.each([
      ['unmatchable_filter', 'Include a letter or digit in county'],
      ['filter_too_long', "Shorten county to the county's name alone"],
    ])('carries the service reason %s with its declared recovery', async (reason, hint) => {
      mockSearchWaterSystems.mockRejectedValue(
        validationError('DMAP cannot carry it.', { reason }),
      );
      const call = await runToolContract(waterSearchSystemsTool, { state: 'WA', county: '...' });
      expect(call.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: { reason, recovery: { hint: expect.stringContaining(hint) } },
        },
      });
      expect(textOf(call.content)).toContain(hint);
    });
  });

  describe('current violations', () => {
    it('passes a lookup bound to ECHO only with has_violation', async () => {
      mockSearchWaterSystems.mockResolvedValue({ items: [] });
      mockFindCurrentSdwViolators.mockResolvedValue({
        pwsids: new Set(['WA5301483']),
        totalCount: 1,
      });
      const ctx = createMockContext({ errors: waterSearchSystemsTool.errors });
      const input = waterSearchSystemsTool.input.parse({
        state: 'WA',
        has_violation: true,
        pws_type: 'community',
      });
      await waterSearchSystemsTool.handler(input, ctx);

      const params = serviceParams();
      expect(params).toEqual({
        state: 'WA',
        pwsType: 'community',
        currentViolators: expect.any(Function),
        offset: 0,
        limit: 50,
      });
      const budget = { remainingMs: () => 1000, rethrow: vi.fn() } as unknown as CallBudget;
      const lookup = params.currentViolators as CurrentViolatorLookup;
      await expect(lookup({ state: 'WA', systemType: 'community' }, budget)).resolves.toEqual({
        pwsids: new Set(['WA5301483']),
        totalCount: 1,
      });
      expect(mockFindCurrentSdwViolators).toHaveBeenCalledWith(
        { state: 'WA', systemType: 'community' },
        ctx,
        budget,
      );
    });

    it.each([{}, { has_violation: false }])(
      'passes no lookup for %j, so no ECHO request can be made',
      async (args) => {
        mockSearchWaterSystems.mockResolvedValue({ items: [seattleWaterSystem] });
        await runToolContract(waterSearchSystemsTool, { state: 'WA', ...args });
        expect(serviceParams()).not.toHaveProperty('currentViolators');
        expect(mockFindCurrentSdwViolators).not.toHaveBeenCalled();
      },
    );
  });

  describe('active_only', () => {
    it('sends activeOnly only when true, and echoes it only then', async () => {
      mockSearchWaterSystems.mockResolvedValue({ items: [seattleWaterSystem] });
      const on = await runToolContract(waterSearchSystemsTool, {
        zip_code: '98104',
        active_only: true,
      });
      expect(serviceParams()).toEqual({ zipCode: '98104', activeOnly: true, offset: 0, limit: 50 });
      expect(on.structuredContent).toMatchObject({
        effectiveQuery: 'zip_code begins with 98104; active_only=true',
      });

      mockSearchWaterSystems.mockClear();
      const off = await runToolContract(waterSearchSystemsTool, {
        zip_code: '98104',
        active_only: false,
      });
      expect(serviceParams()).toEqual({ zipCode: '98104', offset: 0, limit: 50 });
      expect(off.structuredContent).toMatchObject({ effectiveQuery: 'zip_code begins with 98104' });
    });
  });

  describe('paging', () => {
    it('passes offset, writes nextOffset and its guidance, and keeps totalCount absent', async () => {
      mockSearchWaterSystems.mockResolvedValue({ items: [seattleWaterSystem], nextOffset: 71 });
      const call = await runToolContract(waterSearchSystemsTool, {
        state: 'CA',
        offset: 70,
        limit: 1,
      });
      expect(serviceParams()).toEqual({ state: 'CA', offset: 70, limit: 1 });
      const structured = call.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({
        nextOffset: 71,
        guidance: 'More records follow; call again with offset 71 to continue.',
      });
      expect(structured).not.toHaveProperty('totalCount');
      const text = textOf(call.content);
      expect(text).toContain('**Returned:** 1');
      expect(text).toContain('**Next offset:** 71');
      expect(text).toContain('> More records follow; call again with offset 71 to continue.');
    });

    it('clamps a limit above the cap of 200 with a notice', async () => {
      mockSearchWaterSystems.mockResolvedValue({ items: [seattleWaterSystem] });
      const call = await runToolContract(waterSearchSystemsTool, { state: 'CA', limit: 500 });
      expect(serviceParams()).toMatchObject({ limit: 200 });
      expect(call.structuredContent).toMatchObject({
        limitNotice:
          "limit 500 is above this tool's cap of 200, so at most 200 records were returned.",
      });
    });

    it('rejects a limit above 5,000 at the schema', async () => {
      const call = await runToolContract(waterSearchSystemsTool, { state: 'CA', limit: 5001 });
      expect(call.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expect(mockSearchWaterSystems).not.toHaveBeenCalled();
    });

    it('explains an empty page past the end without a nextOffset', async () => {
      mockSearchWaterSystems.mockResolvedValue({ items: [] });
      const call = await runToolContract(waterSearchSystemsTool, { state: 'CA', offset: 20000 });
      const structured = call.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({
        systems: [],
        message:
          'No water systems found at offset 20000: the search has no systems past it. Lower offset, or start again at offset 0.',
      });
      expect(structured).not.toHaveProperty('nextOffset');
    });

    it('keeps an empty page that a check left short distinct from the end', async () => {
      mockSearchWaterSystems.mockResolvedValue({ items: [], nextOffset: 2000 });
      const call = await runToolContract(waterSearchSystemsTool, {
        zip_code: '98104',
        has_violation: true,
        offset: 1000,
      });
      expect(call.structuredContent).toMatchObject({
        message: 'No water systems found at offset 1000.',
        nextOffset: 2000,
      });
    });
  });

  describe('effectiveQuery and the empty-result message', () => {
    it('echoes every filter the search sent, in input order', async () => {
      mockSearchWaterSystems.mockResolvedValue({ items: [seattleWaterSystem] });
      const call = await runToolContract(waterSearchSystemsTool, {
        state: 'wa',
        zip_code: '98104-3122',
        county: 'King County',
        pws_type: 'non-transient',
        active_only: true,
        has_violation: true,
      });
      expect(call.structuredContent).toMatchObject({
        effectiveQuery:
          'state=WA; zip_code begins with 98104; county=KING; pws_type=non-transient; active_only=true; has_violation=true, current SDWA violation per ECHO',
      });
      expect(textOf(call.content)).toContain(
        '`state=WA; zip_code begins with 98104; county=KING; pws_type=non-transient; active_only=true; has_violation=true, current SDWA violation per ECHO`',
      );
    });

    it('echoes an empty result too, and its message restates no filter value', async () => {
      mockSearchWaterSystems.mockResolvedValue({ items: [], totalCount: 0 });
      const call = await runToolContract(waterSearchSystemsTool, {
        state: 'wy',
        has_violation: true,
      });
      const structured = call.structuredContent as { message: string; effectiveQuery: string };
      expect(structured).toMatchObject({
        systems: [],
        totalCount: 0,
        effectiveQuery: 'state=WY; has_violation=true, current SDWA violation per ECHO',
      });
      expect(structured.message).toBe(
        'No water systems found. Remove has_violation to include systems without a current violation. Check the state code: tribal systems file under their EPA region code (01–10), not the state they sit in.',
      );
      expect(structured.message).not.toMatch(/WY|"/);
    });

    it('suggests county for a ZIP search that found nothing', async () => {
      mockSearchWaterSystems.mockResolvedValue({ items: [] });
      const call = await runToolContract(waterSearchSystemsTool, {
        zip_code: '98104',
        active_only: true,
        pws_type: 'transient',
      });
      expect(call.structuredContent).toMatchObject({
        message:
          "No water systems found. zip_code matches a system's address of record, not the area it serves; try county with state. Remove active_only to include inactive systems. Remove pws_type to include every system type.",
      });
    });
  });

  it('formats output with PWSID, population, source, and violation flag', () => {
    const output = { systems: [seattleWaterSystem], totalCount: 1 };
    const blocks = waterSearchSystemsTool.format!(output);
    expect(blocks).toEqual([
      {
        type: 'text',
        text: [
          '## Drinking Water Systems',
          '**Total Found:** 1 | **Returned:** 1',
          '',
          '### SEATTLE PUBLIC UTILITIES',
          '**PWSID:** WA00200Y',
          '**Location:** SEATTLE, WA, 98104',
          '**Type:** CWS',
          '**Population Served:** 730,000',
          '**Primary Source:** SW',
          '**Current Violation:** No',
          '**Active:** Yes',
        ].join('\n'),
      },
    ]);
  });

  it('shows the current-violation flag in the heading when hasViolation is true', () => {
    const systemWithViolation = { ...seattleWaterSystem, hasViolation: true };
    const output = { systems: [systemWithViolation] };
    const blocks = waterSearchSystemsTool.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('**Returned:** 1\n');
    expect(text).toContain('\n### SEATTLE PUBLIC UTILITIES ⚠️ CURRENT VIOLATION\n');
    expect(text).toContain('**Current Violation:** Yes');
  });

  describe('violation wording matches the ECHO current-violation source', () => {
    const shape = waterSearchSystemsTool.input.shape;
    const systemShape = waterSearchSystemsTool.output.shape.systems.element.shape;

    it('describes has_violation as a current violation in ECHO, never "open" or "active"', () => {
      const text = shape.has_violation.description ?? '';
      expect(text).toMatch(/current SDWA violation/i);
      expect(text).toMatch(/ECHO/);
      expect(text).not.toMatch(/\bopen\b|active/i);
    });

    it('describes hasViolation as a current violation in ECHO, never "open" or "active"', () => {
      const text = systemShape.hasViolation.description ?? '';
      expect(text).toMatch(/current SDWA violation/i);
      expect(text).toMatch(/ECHO/);
      expect(text).not.toMatch(/\bopen\b|active/i);
    });

    it('tool description promises current violation status, county, and the PWSID chain', () => {
      const { description } = waterSearchSystemsTool;
      expect(description).toMatch(/current SDWA violation/i);
      expect(description).not.toMatch(/open violation|active violation/i);
      expect(description).toContain('by state, ZIP code, or county served');
      expect(description).toContain(
        "Pass a returned pwsid as registry_id to epa_echo_get_facility for the system's drinking-water violations: contaminant, measured level, MCL, status, and enforcement actions.",
      );
    });
  });

  it('formats empty result with message', () => {
    const output = { systems: [], totalCount: 0, message: 'No water systems found.' };
    const blocks = waterSearchSystemsTool.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toBe(
      [
        '## Drinking Water Systems',
        '**Total Found:** 0 | **Returned:** 0',
        '',
        '> No water systems found.',
      ].join('\n'),
    );
  });

  describe('service notices', () => {
    const checkNotice =
      'The violation check read 1,000 systems from offset 0 and found 0 with a current violation; systems from offset 1,000 on were not checked in this call.';

    it('carries the service notice on both structuredContent and content', async () => {
      mockSearchWaterSystems.mockImplementation((_params, ctx) => {
        ctx.enrich.notice(checkNotice);
        return Promise.resolve({ items: [{ ...seattleWaterSystem, hasViolation: true }] });
      });
      const call = await runToolContract(waterSearchSystemsTool, {
        zip_code: '98104',
        has_violation: true,
      });
      expect(call.isError).toBeFalsy();
      const structured = call.structuredContent as { systems: unknown[]; notice?: string };
      expect(structured.systems).toHaveLength(1);
      expect(structured.notice).toBe(checkNotice);
      const text = textOf(call.content);
      expect(text).toContain(checkNotice);
      expect(text).toContain('WA00200Y');
      expect(text).toContain('CURRENT VIOLATION');
    });

    it('carries the notice beside the no-results message', async () => {
      mockSearchWaterSystems.mockImplementation((_params, ctx) => {
        ctx.enrich.notice(checkNotice);
        return Promise.resolve({ items: [], nextOffset: 1000 });
      });
      const call = await runToolContract(waterSearchSystemsTool, {
        zip_code: '98104',
        has_violation: true,
      });
      const structured = call.structuredContent as { message?: string; notice?: string };
      expect(structured.message).toContain('No water systems found');
      expect(structured.notice).toBe(checkNotice);
    });

    it('adds no notice when the service reports none', async () => {
      mockSearchWaterSystems.mockResolvedValue({ items: [seattleWaterSystem] });
      const ctx = createMockContext({ errors: waterSearchSystemsTool.errors });
      await waterSearchSystemsTool.handler(
        waterSearchSystemsTool.input.parse({ state: 'WA' }),
        ctx,
      );
      expect(getEnrichment(ctx)).not.toHaveProperty('notice');
    });
  });

  it('formats sparse water system (minimal required fields)', () => {
    const sparse = { systems: [{ pwsid: 'OR0000001', name: 'SPARSE UTILITY' }] };
    const blocks = waterSearchSystemsTool.format!(sparse);
    const text = (blocks[0] as { type: string; text: string }).text;
    // Absent optional fields render no line at all, and no violation flag or status.
    expect(text).toBe(
      [
        '## Drinking Water Systems',
        '**Returned:** 1',
        '',
        '### SPARSE UTILITY',
        '**PWSID:** OR0000001',
      ].join('\n'),
    );
  });
});
