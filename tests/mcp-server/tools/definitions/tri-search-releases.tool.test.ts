/**
 * @fileoverview Tests for triSearchReleasesTool.
 * @module tests/mcp-server/tools/definitions/tri-search-releases.tool.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { triSearchReleasesTool } from '@/mcp-server/tools/definitions/tri-search-releases.tool.js';
import { DmapService } from '@/services/dmap/dmap-service.js';
import { expectInvalidState, expectValidationRejection, textOf } from '../../../helpers.js';

const mockSearchTriReleases = vi.fn();

/** When set, getDmapService() returns this real service instead of the stub. */
const liveService: { current: DmapService | undefined } = { current: undefined };

vi.mock('@/services/dmap/dmap-service.js', async (importActual) => ({
  ...(await importActual<typeof import('@/services/dmap/dmap-service.js')>()),
  getDmapService: () =>
    liveService.current ?? {
      searchTriReleases: mockSearchTriReleases,
      getTriReleases: vi.fn(),
      searchSuperfund: vi.fn(),
      searchWaterSystems: vi.fn(),
    },
}));

const waRelease = {
  facilityId: 'WA0001234',
  facilityName: 'TEST FACILITY',
  chemicalName: 'BENZENE',
  reportingYear: 2022,
  oneTimeReleaseInLbs: 580,
};

describe('triSearchReleasesTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns releases for valid state', async () => {
    mockSearchTriReleases.mockResolvedValue({ items: [waRelease] });
    const ctx = createMockContext({ errors: triSearchReleasesTool.errors });
    const input = triSearchReleasesTool.input.parse({ state: 'WA' });
    const result = await triSearchReleasesTool.handler(input, ctx);
    expect(result).toEqual({ releases: [waRelease], state: 'WA' });
  });

  it('uppercases state before calling service', async () => {
    mockSearchTriReleases.mockResolvedValue({ items: [waRelease] });
    const ctx = createMockContext({ errors: triSearchReleasesTool.errors });
    const input = triSearchReleasesTool.input.parse({ state: 'wa' });
    await triSearchReleasesTool.handler(input, ctx);
    expect(mockSearchTriReleases).toHaveBeenCalledWith(
      { state: 'WA', offset: 0, limit: 50, includeReleaseBreakdown: false },
      expect.anything(),
    );
  });

  it('accepts a padded lowercase state and searches its code', async () => {
    mockSearchTriReleases.mockResolvedValue({ items: [waRelease] });
    const call = await runToolContract(triSearchReleasesTool, { state: ' wa ' });
    expect(call.isError).toBeFalsy();
    expect(mockSearchTriReleases.mock.calls[0]![0]).toMatchObject({ state: 'WA' });
    expect(call.structuredContent).toMatchObject({ state: 'WA' });
    const text = textOf(call.content);
    expect(text).toContain('## TRI Releases — WA');
  });

  it.each(['Washington', 'W'])(
    'rejects state %j at the schema, before any request',
    async (state) => {
      const call = await runToolContract(triSearchReleasesTool, { state });
      expect(call.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      const text = textOf(call.content);
      expect(text).toContain('2-letter USPS code');
      expect(mockSearchTriReleases).not.toHaveBeenCalled();
    },
  );

  it('rejects an unknown state code as invalid_state with its recovery, before any request', async () => {
    expectInvalidState(await runToolContract(triSearchReleasesTool, { state: 'zz' }));
    expect(mockSearchTriReleases).not.toHaveBeenCalled();
  });

  it('passes county and year filters to service', async () => {
    mockSearchTriReleases.mockResolvedValue({ items: [waRelease] });
    const ctx = createMockContext({ errors: triSearchReleasesTool.errors });
    const input = triSearchReleasesTool.input.parse({
      state: 'WA',
      county: 'KING',
      year: 2022,
    });
    await triSearchReleasesTool.handler(input, ctx);
    expect(mockSearchTriReleases).toHaveBeenCalledWith(
      {
        state: 'WA',
        county: 'KING',
        year: 2022,
        offset: 0,
        limit: 50,
        includeReleaseBreakdown: false,
      },
      expect.anything(),
    );
  });

  it.each([
    ['KING', 'KING'],
    ['king', 'KING'],
    ['King County', 'KING'],
    ['  king county  ', 'KING'],
    ['Calcasieu Parish', 'CALCASIEU'],
    ['Fairbanks North Star Borough', 'FAIRBANKS NORTH STAR'],
    ['Grays Harbor', 'GRAYS HARBOR'],
  ])('normalizes county %j to the bare uppercase name %j', async (county, expected) => {
    mockSearchTriReleases.mockResolvedValue({ items: [waRelease] });
    const ctx = createMockContext({ errors: triSearchReleasesTool.errors });
    const input = triSearchReleasesTool.input.parse({ state: 'WA', county });
    await triSearchReleasesTool.handler(input, ctx);
    expect(mockSearchTriReleases).toHaveBeenCalledWith(
      expect.objectContaining({ county: expected }),
      expect.anything(),
    );
  });

  it('omits the county filter when county is blank', async () => {
    mockSearchTriReleases.mockResolvedValue({ items: [waRelease] });
    const ctx = createMockContext({ errors: triSearchReleasesTool.errors });
    const input = triSearchReleasesTool.input.parse({ state: 'WA', county: '   ' });
    await triSearchReleasesTool.handler(input, ctx);
    expect(mockSearchTriReleases.mock.calls[0]![0]).not.toHaveProperty('county');
  });

  it('names the normalized county in the echo, not in the no-results message', async () => {
    mockSearchTriReleases.mockResolvedValue({ items: [] });
    const ctx = createMockContext({ errors: triSearchReleasesTool.errors });
    const input = triSearchReleasesTool.input.parse({
      state: 'WA',
      county: 'Nowhere County',
      year: 2023,
    });
    const result = await triSearchReleasesTool.handler(input, ctx);
    expect(result.releases).toEqual([]);
    expect(getEnrichment(ctx).effectiveQuery).toContain('county contains NOWHERE;');
    expect(result.message).toMatch(/^No TRI releases found\. /);
    expect(result.message).not.toMatch(/county county/i);
  });

  it('passes chemical_name filter trimmed', async () => {
    mockSearchTriReleases.mockResolvedValue({ items: [waRelease] });
    const ctx = createMockContext({ errors: triSearchReleasesTool.errors });
    const input = triSearchReleasesTool.input.parse({ state: 'WA', chemical_name: '  BENZENE  ' });
    await triSearchReleasesTool.handler(input, ctx);
    expect(mockSearchTriReleases).toHaveBeenCalledWith(
      expect.objectContaining({ chemicalName: 'BENZENE' }),
      expect.anything(),
    );
  });

  it('returns message when no releases found', async () => {
    mockSearchTriReleases.mockResolvedValue({ items: [] });
    const ctx = createMockContext({ errors: triSearchReleasesTool.errors });
    const input = triSearchReleasesTool.input.parse({ state: 'WY', year: 2010 });
    const result = await triSearchReleasesTool.handler(input, ctx);
    expect(result.releases).toEqual([]);
    expect(result.message).toMatch(/^No TRI releases found\. TRI data lags/);
    expect(result.message).toContain('try year 2009');
  });

  it('formats output with chemical name, facility ID, and release amounts', () => {
    const output = { releases: [waRelease], state: 'WA' };
    const blocks = triSearchReleasesTool.format!(output);
    expect(blocks).toEqual([
      {
        type: 'text',
        text: [
          '## TRI Releases — WA',
          '**Records:** 1',
          '',
          '### BENZENE — TEST FACILITY (WA0001234) (2022)',
          '**One-Time Release:** 580 lbs',
        ].join('\n'),
      },
    ]);
  });

  it('formats empty result with message', () => {
    const output = { releases: [], state: 'WY', message: 'No TRI releases found in WY.' };
    const blocks = triSearchReleasesTool.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toBe(
      ['## TRI Releases — WY', '**Records:** 0', '', '> No TRI releases found in WY.'].join('\n'),
    );
  });

  it('formats sparse release (only required fields)', () => {
    const sparse = {
      releases: [{ facilityId: 'TX9999', chemicalName: 'TOLUENE', reportingYear: 2021 }],
      state: 'TX',
    };
    const blocks = triSearchReleasesTool.format!(sparse);
    const text = (blocks[0] as { type: string; text: string }).text;
    // No facility name: the heading carries the bare ID, and no county or quantity line follows.
    expect(text).toBe(
      ['## TRI Releases — TX', '**Records:** 1', '', '### TOLUENE — TX9999 (2021)'].join('\n'),
    );
  });

  describe('per-medium breakdown', () => {
    const fullBreakdown = {
      facilityId: '98134YNGCR3231U',
      facilityName: 'FULL BREAKDOWN PLANT',
      chemicalName: 'Toluene',
      reportingYear: 2022,
      oneTimeReleaseInLbs: 0,
      releasesToAirInLbs: 15000,
      releasesToWaterInLbs: 200,
      releasesToLandInLbs: 3400,
      releasesToUndergroundInjectionInLbs: 90000,
    };
    const airOnly = {
      facilityId: '9867WSNRWD1981S',
      facilityName: 'SPARSE PLANT',
      chemicalName: 'Chromium',
      reportingYear: 2022,
      releasesToAirInLbs: 4,
    };

    it('describes the one-time quantity and the per-medium fields', () => {
      const item = triSearchReleasesTool.output.shape.releases.element.shape;
      expect(item.oneTimeReleaseInLbs.description).toContain('one-time release quantity');
      expect(item.oneTimeReleaseInLbs.description).toContain('never added to them');
      expect(item.releasesToAirInLbs.description).toContain('air');
      expect(item.releasesToUndergroundInjectionInLbs.description).toContain('injection');
      expect(triSearchReleasesTool.description).toContain(
        'air, water, land, and underground-injection',
      );
      expect(triSearchReleasesTool.description).not.toMatch(/and release quantity/);
    });

    it('states that omitting year returns the newest reporting years first', () => {
      expect(triSearchReleasesTool.input.shape.year.description).toContain(
        'newest reporting year first',
      );
      expect(triSearchReleasesTool.description).toContain('without year');
      expect(triSearchReleasesTool.description).toContain('newest first');
      expect(triSearchReleasesTool.description).not.toContain('for a given reporting year');
    });

    it('makes the breakdown opt-in and states its cost', () => {
      const flag = triSearchReleasesTool.input.shape.include_release_breakdown;
      expect(flag.parse(undefined)).toBe(false);
      expect(flag.description).toContain('20 seconds');
      expect(triSearchReleasesTool.description).toContain('include_release_breakdown');
      const item = triSearchReleasesTool.output.shape.releases.element.shape;
      expect(item.releasesToAirInLbs.description).toContain('include_release_breakdown');
    });

    it.each([
      [{}, false],
      [{ include_release_breakdown: false }, false],
      [{ include_release_breakdown: true }, true],
    ])('passes %j to the service as includeReleaseBreakdown=%s', async (flag, expected) => {
      mockSearchTriReleases.mockResolvedValue({ items: [waRelease] });
      const ctx = createMockContext({ errors: triSearchReleasesTool.errors });
      const input = triSearchReleasesTool.input.parse({ state: 'WA', ...flag });
      await triSearchReleasesTool.handler(input, ctx);
      expect(mockSearchTriReleases.mock.calls[0]![0]).toMatchObject({
        includeReleaseBreakdown: expected,
      });
    });

    it('carries the media on both structuredContent and content', async () => {
      mockSearchTriReleases.mockResolvedValue({ items: [fullBreakdown, airOnly], nextOffset: 2 });
      const call = await runToolContract(triSearchReleasesTool, {
        state: 'WA',
        year: 2022,
        limit: 2,
        include_release_breakdown: true,
      });
      expect(call.isError).toBeFalsy();
      const structured = call.structuredContent as {
        releases: Array<Record<string, unknown>>;
        truncated?: boolean;
        shown?: number;
        cap?: number;
      };
      expect(structured.releases).toEqual([fullBreakdown, airOnly]);
      expect(structured).toMatchObject({ truncated: true, shown: 2, cap: 2 });
      const text = textOf(call.content);
      expect(text).toContain('**Air Releases:** 15,000 lbs');
      expect(text).toContain('**Water Releases:** 200 lbs');
      expect(text).toContain('**Land Releases:** 3,400 lbs');
      expect(text).toContain('**Underground Injection:** 90,000 lbs');
      expect(text).toContain('**One-Time Release:** 0 lbs');
      expect(text).toContain('**Air Releases:** 4 lbs');
    });

    it('formats a record with no breakdown without any medium line', () => {
      const text = (
        triSearchReleasesTool.format!({
          releases: [{ facilityId: 'OR0001', chemicalName: 'Zinc', reportingYear: 2022 }],
          state: 'OR',
        })[0] as { text: string }
      ).text;
      expect(text).not.toMatch(/Air Releases|Water Releases|Land Releases|Underground Injection/);
      expect(text).not.toContain('One-Time Release');
    });

    it('renders sub-0.001 quantities and medium sums at full precision', () => {
      const text = (
        triSearchReleasesTool.format!({
          releases: [
            {
              facilityId: '96020CLLNS500MA',
              chemicalName: 'Dioxin and dioxin-like compounds',
              reportingYear: 2022,
              oneTimeReleaseInLbs: 0.00062,
              // AIR STACK 0.000894 + AIR FUG 0.000014, as the breakdown rollup sums them.
              releasesToAirInLbs: 0.000894 + 0.000014,
              releasesToWaterInLbs: 0.0000001,
              releasesToLandInLbs: 0.0005809,
              releasesToUndergroundInjectionInLbs: 1234567.891,
            },
          ],
          state: 'WA',
        })[0] as { text: string }
      ).text;
      expect(text).toContain('**One-Time Release:** 0.00062 lbs');
      expect(text).toContain('**Air Releases:** 0.000908 lbs');
      expect(text).toContain('**Water Releases:** 0.0000001 lbs');
      expect(text).toContain('**Land Releases:** 0.0005809 lbs');
      expect(text).toContain('**Underground Injection:** 1,234,567.891 lbs');
    });

    it('carries a gram-reported record as pounds with its reportedUnit on both surfaces', async () => {
      const dioxin = {
        facilityId: '96020CLLNS500MA',
        facilityName: 'COLLINS PINE CO',
        chemicalName: 'Dioxin and dioxin-like compounds',
        reportingYear: 2022,
        reportedUnit: 'grams' as const,
        oneTimeReleaseInLbs: 0.0044092452437,
      };
      mockSearchTriReleases.mockResolvedValue({ items: [dioxin, waRelease] });
      const call = await runToolContract(triSearchReleasesTool, { state: 'CA', year: 2022 });
      expect(call.isError).toBeFalsy();
      const structured = call.structuredContent as { releases: Array<Record<string, unknown>> };
      expect(structured.releases).toEqual([dioxin, waRelease]);
      const text = textOf(call.content);
      expect(text).toContain(
        '**Reported Unit:** grams — any quantities shown are converted to pounds (1 lb = 453.59237 g)',
      );
      expect(text).toContain('**One-Time Release:** 0.0044092452437 lbs');
      expect(text.match(/Reported Unit/g)).toHaveLength(1);
      const item = triSearchReleasesTool.output.shape.releases.element.shape;
      expect(item.reportedUnit.description).toMatch(/dioxin/i);
      expect(triSearchReleasesTool.description).toMatch(/grams/);
    });

    it('formats a gram-reported record with no quantities without promising any', () => {
      const text = (
        triSearchReleasesTool.format!({
          releases: [
            {
              facilityId: '98421STMPS',
              facilityName: 'WA DIOXIN REPORTER',
              countyName: 'PIERCE',
              chemicalName: 'Dioxin and dioxin-like compounds',
              reportingYear: 2022,
              reportedUnit: 'grams',
            },
          ],
          state: 'WA',
        })[0] as { text: string }
      ).text;
      expect(text).toContain(
        '**Reported Unit:** grams — any quantities shown are converted to pounds (1 lb = 453.59237 g)',
      );
      expect(text).toContain('**County:** PIERCE');
      expect(text).not.toMatch(/below|lbs/);
    });

    it('formats a sparse record with only the media it has', () => {
      const text = (
        triSearchReleasesTool.format!({ releases: [airOnly], state: 'WA' })[0] as { text: string }
      ).text;
      expect(text).toContain('**Air Releases:** 4 lbs');
      expect(text).not.toMatch(/Water Releases|Land Releases|Underground Injection/);
    });
  });

  describe('result envelope below the limit', () => {
    it('returns records without truncation fields when fewer than limit come back', async () => {
      mockSearchTriReleases.mockResolvedValue({ items: [waRelease] });
      const call = await runToolContract(triSearchReleasesTool, { state: 'WA', limit: 5 });
      expect(call.isError).toBeFalsy();
      expect(mockSearchTriReleases.mock.calls[0]![0]).toMatchObject({
        includeReleaseBreakdown: false,
      });
      const structured = call.structuredContent as Record<string, unknown>;
      expect(structured.releases).toEqual([waRelease]);
      expect(structured).not.toHaveProperty('truncated');
      expect(structured).not.toHaveProperty('shown');
      const text = textOf(call.content);
      expect(text).toContain('**Records:** 1');
      expect(text).not.toMatch(/truncated/i);
    });

    it('returns the no-results message, not an error, for a county with no facilities', async () => {
      mockSearchTriReleases.mockResolvedValue({ items: [] });
      const call = await runToolContract(triSearchReleasesTool, {
        state: 'WA',
        county: 'Nowhere County',
        year: 2022,
      });
      expect(call.isError).toBeFalsy();
      const structured = call.structuredContent as {
        releases: unknown[];
        message?: string;
        effectiveQuery?: string;
      };
      expect(structured.releases).toEqual([]);
      expect(structured.message).toContain('Remove county to search the whole state.');
      expect(structured.effectiveQuery).toBe('state=WA; county contains NOWHERE; year=2022');
      const text = textOf(call.content);
      expect(text).toContain('Remove county to search the whole state.');
      expect(text).toContain('Query: `state=WA; county contains NOWHERE; year=2022`');
    });
  });

  describe('text filter bounds', () => {
    /** The longest TRI chemical name (tri.tri_chem_info, live 2026-10-16), 542 characters. */
    const longestChemical =
      '2-Propenoic acid, butyl ester, telomer with 2-[[(heptadecafluorooctyl)sulfonyl]methylamino]ethyl 2-propenoate, 2-[methyl[(nonafluorobutyl)sulfonyl]amino]ethyl 2-propenoate, α-(2-methyl-1-oxo-2-propenyl)-ω-hydroxypoly(oxy-1,4-butanediyl), α-(2-methyl-1-oxo-2-propenyl)-ω-[(2-methyl-1-oxo-2-propenyl)oxy]poly(oxy-1,4-butanediyl), 2-[methyl[(pentadecafluoroheptyl)sulfonyl]amino]ethyl 2-propenoate, 2-[methyl[(tridecafluorohexyl)sulfonyl]amino]ethyl 2-propenoate, 2-[methyl[(undecafluoropentyl)sulfonyl]amino]ethyl 2-propenoate and 1-octanethiol';

    it("accepts text up to DMAP's 4,094-byte request line and rejects longer text", () => {
      const parse = (args: Record<string, unknown>) =>
        triSearchReleasesTool.input.safeParse({ state: 'TX', ...args }).success;
      expect(longestChemical).toHaveLength(542);
      expect(parse({ chemical_name: longestChemical })).toBe(true);
      expect(parse({ chemical_name: 'x'.repeat(4094) })).toBe(true);
      expect(parse({ chemical_name: 'x'.repeat(4095) })).toBe(false);
      expect(parse({ county: 'PRINCE OF WALES-OUTER KETCHIKAN' })).toBe(true);
      expect(parse({ county: 'x'.repeat(4094) })).toBe(true);
      expect(parse({ county: 'x'.repeat(4095) })).toBe(false);
    });

    it('says punctuation in the text filters is matched as written', () => {
      expect(triSearchReleasesTool.input.shape.chemical_name.description).toContain(
        'matched as written',
      );
      expect(triSearchReleasesTool.input.shape.county.description).toContain('matched as written');
    });
  });

  describe('paging', () => {
    it('passes offset to the service and continues with nextOffset on both surfaces', async () => {
      mockSearchTriReleases.mockResolvedValue({ items: [waRelease, waRelease], nextOffset: 7 });

      const call = await runToolContract(triSearchReleasesTool, {
        state: 'WA',
        offset: 5,
        limit: 2,
      });

      expect(call.isError).toBeFalsy();
      expect(mockSearchTriReleases.mock.calls[0]![0]).toMatchObject({ offset: 5, limit: 2 });
      const structured = call.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({
        nextOffset: 7,
        truncated: true,
        shown: 2,
        cap: 2,
        guidance: 'More records follow; call again with offset 7 to continue.',
      });
      const text = textOf(call.content);
      expect(text).toContain('**Next offset:** 7');
      expect(text).toContain('More records follow; call again with offset 7 to continue.');
      expect(text.toLowerCase()).not.toContain('raise the cap');
    });

    it('returns the last page without nextOffset or truncation fields', async () => {
      mockSearchTriReleases.mockResolvedValue({ items: [waRelease] });

      const call = await runToolContract(triSearchReleasesTool, { state: 'WA', offset: 50 });

      expect(call.isError).toBeFalsy();
      const structured = call.structuredContent as Record<string, unknown>;
      expect(structured.releases).toEqual([waRelease]);
      for (const key of ['nextOffset', 'truncated', 'shown', 'cap', 'guidance', 'limitNotice'])
        expect(structured).not.toHaveProperty(key);
      expect(textOf(call.content)).not.toContain('Next offset');
    });

    it('clamps a limit above 200 to 200 with a notice instead of rejecting it', async () => {
      mockSearchTriReleases.mockResolvedValue({ items: [waRelease] });

      const call = await runToolContract(triSearchReleasesTool, { state: 'WA', limit: 5000 });

      expect(call.isError).toBeFalsy();
      expect(mockSearchTriReleases.mock.calls[0]![0]).toMatchObject({ limit: 200 });
      const notice = (call.structuredContent as { limitNotice?: string }).limitNotice;
      expect(notice).toContain('limit 5000');
      expect(textOf(call.content)).toContain(`> ${notice}`);
      expect(triSearchReleasesTool.input.safeParse({ state: 'WA', limit: 5001 }).success).toBe(
        false,
      );
    });

    it('says an empty page past the end is past the end, without no-match advice', async () => {
      mockSearchTriReleases.mockResolvedValue({ items: [] });

      const call = await runToolContract(triSearchReleasesTool, {
        state: 'WA',
        year: 2022,
        offset: 400,
      });

      const structured = call.structuredContent as { releases: unknown[]; message: string };
      expect(structured.releases).toEqual([]);
      expect(structured.message).toBe(
        'No TRI releases found at offset 400: the search has no records past it. Lower offset, or start again at offset 0.',
      );
      expect(structured).not.toHaveProperty('nextOffset');
      expect(textOf(call.content)).toContain(structured.message);
    });
  });

  describe('effective query', () => {
    it('echoes the normalized state, the county match, and the year, and returns the normalized state', async () => {
      mockSearchTriReleases.mockResolvedValue({ items: [waRelease] });

      const call = await runToolContract(triSearchReleasesTool, {
        state: 'wa',
        county: 'King County',
        year: 2022,
      });

      const structured = call.structuredContent as { state: string; effectiveQuery: string };
      expect(structured.state).toBe('WA');
      expect(structured.effectiveQuery).toBe('state=WA; county contains KING; year=2022');
      const text = textOf(call.content);
      expect(text).toContain('Query: `state=WA; county contains KING; year=2022`');
    });

    it('echoes an omitted year as all years newest first and the chemical match', async () => {
      mockSearchTriReleases.mockResolvedValue({ items: [] });
      const ctx = createMockContext({ errors: triSearchReleasesTool.errors });

      await triSearchReleasesTool.handler(
        triSearchReleasesTool.input.parse({
          state: 'TX',
          county: '  ',
          chemical_name: " Michler's ketone ",
          include_release_breakdown: true,
        }),
        ctx,
      );

      expect(getEnrichment(ctx).effectiveQuery).toBe(
        "state=TX; year=all, newest first; chemical_name contains Michler's ketone",
      );
    });

    it('stops restating filters in the empty-result message', async () => {
      mockSearchTriReleases.mockResolvedValue({ items: [] });
      const ctx = createMockContext({ errors: triSearchReleasesTool.errors });

      const result = await triSearchReleasesTool.handler(
        triSearchReleasesTool.input.parse({
          state: 'WA',
          county: 'Nowhere County',
          year: 2023,
          chemical_name: 'BENZENE',
        }),
        ctx,
      );

      expect(getEnrichment(ctx).effectiveQuery).toBe(
        'state=WA; county contains NOWHERE; year=2023; chemical_name contains BENZENE',
      );
      expect(result.message).toMatch(/^No TRI releases found\. TRI data lags ~18 months\. /);
      expect(result.message).toContain('Remove county to search the whole state.');
      expect(result.message).not.toMatch(/NOWHERE|2023|BENZENE/);
    });
  });

  describe('facility identifiers and release totals', () => {
    const identified = {
      facilityId: '9867WSNRWD1981S',
      facilityName: 'WOODLAND USNR LLC',
      countyName: 'COWLITZ',
      registryId: '110070322017',
      parentCompany: 'WOOD *TECHNOLOGIES* [INTL](https://example.com)',
      chemicalName: 'Chromium',
      reportingYear: 2022,
      oneTimeReleaseInLbs: 3,
      releasesToAirInLbs: 4,
      releasesToLandInLbs: 10,
      totalOnSiteReleasesInLbs: 14,
    };

    it('carries the Registry ID, parent company, and both totals on both surfaces', async () => {
      mockSearchTriReleases.mockResolvedValue({ items: [identified] });

      const call = await runToolContract(triSearchReleasesTool, {
        state: 'WA',
        include_release_breakdown: true,
      });

      expect((call.structuredContent as { releases: unknown[] }).releases).toEqual([identified]);
      const text = textOf(call.content);
      expect(text).toContain('**Registry ID:** 110070322017');
      expect(text).toContain(
        '**Parent Company:** WOOD \\*TECHNOLOGIES\\* \\[INTL\\](https://example.com)',
      );
      expect(text).toContain('**Total On-Site Releases:** 14 lbs');
      expect(text).toContain('**One-Time Release:** 3 lbs');
      expect(text).not.toMatch(/routine/i);
    });

    it('describes the renamed one-time quantity, the on-site total, and no ranking', () => {
      const item = triSearchReleasesTool.output.shape.releases.element.shape;
      expect(item).not.toHaveProperty('totalReleasesInLbs');
      expect(item.oneTimeReleaseInLbs.description).toContain('8.8');
      expect(item.oneTimeReleaseInLbs.description).toContain('already counted');
      expect(item.totalOnSiteReleasesInLbs.description).toContain('midpoint');
      expect(item.registryId.description).toContain('epa_echo_get_facility');
      expect(item.parentCompany.description).toContain('NA');
      const texts = [
        triSearchReleasesTool.description,
        triSearchReleasesTool.input.shape.include_release_breakdown.description ?? '',
        ...Object.values(item).map((field) => field.description ?? ''),
      ];
      for (const text of texts) {
        expect(text).not.toMatch(/routine/i);
        expect(text).not.toMatch(/top (polluters|emitters)/i);
        expect(text).not.toContain('NOT the sum');
      }
    });
  });

  describe('through the real DMAP service', () => {
    /** Facility-joined reporting-form rows as DMAP returns them for TX, year 2022. */
    const joinedRows = Array.from({ length: 3 }, (_, n) => ({
      tri_facility_id: `7700${n}PLANT`,
      facility_name: `HOUSTON PLANT ${n}`,
      state_abbr: 'TX',
      doc_ctrl_num: `DOC${n}`,
      cas_chem_name: 'Benzene',
      reporting_year: '2022',
      one_time_release_qty: n,
    }));

    /**
     * Serve the facility→reporting-form join one page at a time; any other request rejects, so a
     * per-batch facility walk fails here instead of reading as an empty state.
     */
    function stubJoin(
      rows: unknown[],
      beforeResponse?: (signal: AbortSignal | undefined) => Promise<void>,
    ): string[] {
      const urls: string[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        urls.push(url);
        await beforeResponse?.(init?.signal ?? undefined);
        const range = /\/(\d+):(\d+)\/json$/.exec(url);
        if (!url.includes('/tri.tri_facility/state_abbr/equals/TX/join/tri.tri_reporting_form/')) {
          throw validationError(`Unmocked DMAP fetch: ${url}`, { retryable: false });
        }
        const page = rows.slice(Number(range![1]) - 1, Number(range![2]));
        return new Response(JSON.stringify(page), { status: 200 });
      });
      return urls;
    }

    beforeEach(() => {
      liveService.current = new DmapService({} as AppConfig, {} as StorageService);
    });

    afterEach(() => {
      liveService.current = undefined;
      vi.restoreAllMocks();
    });

    it('answers a state search with one request and carries the cap on both surfaces', async () => {
      const urls = stubJoin(joinedRows);

      const call = await runToolContract(triSearchReleasesTool, {
        state: 'tx',
        year: 2022,
        limit: 2,
      });

      expect(call.isError).toBeFalsy();
      expect(urls).toHaveLength(1);
      // One row past the limit proves more follow; the sort ends on the unique submission number.
      expect(urls[0]).toContain(
        '/and/reporting_year/equals/2022/sort/tri.tri_reporting_form.reporting_year:desc,tri.tri_reporting_form.doc_ctrl_num:asc/1:3/json',
      );
      const structured = call.structuredContent as {
        releases: Array<Record<string, unknown>>;
        truncated?: boolean;
        shown?: number;
        cap?: number;
      };
      expect(structured.releases).toEqual([
        {
          facilityId: '77000PLANT',
          facilityName: 'HOUSTON PLANT 0',
          chemicalName: 'Benzene',
          reportingYear: 2022,
          oneTimeReleaseInLbs: 0,
        },
        {
          facilityId: '77001PLANT',
          facilityName: 'HOUSTON PLANT 1',
          chemicalName: 'Benzene',
          reportingYear: 2022,
          oneTimeReleaseInLbs: 1,
        },
      ]);
      expect(structured).toMatchObject({ truncated: true, shown: 2, cap: 2, nextOffset: 2 });
      const text = textOf(call.content);
      expect(text).toContain('**Records:** 2');
      expect(text).toContain('Benzene — HOUSTON PLANT 1 (77001PLANT) (2022)');

      const last = await runToolContract(triSearchReleasesTool, {
        state: 'tx',
        year: 2022,
        limit: 2,
        offset: 2,
      });
      expect(urls[1]).toMatch(/\/3:5\/json$/);
      expect((last.structuredContent as { releases: unknown[] }).releases).toHaveLength(1);
      expect(last.structuredContent).not.toHaveProperty('nextOffset');
      expect(last.structuredContent).not.toHaveProperty('truncated');
    });

    it('returns every record below the limit without truncation fields', async () => {
      stubJoin(joinedRows);

      const call = await runToolContract(triSearchReleasesTool, { state: 'TX', year: 2022 });

      expect(call.isError).toBeFalsy();
      const structured = call.structuredContent as Record<string, unknown>;
      expect(structured.releases).toHaveLength(3);
      expect(structured).not.toHaveProperty('truncated');
      const text = textOf(call.content);
      expect(text).toContain('**Records:** 3');
    });

    it('returns the no-results message on both surfaces when the join matches nothing', async () => {
      const urls = stubJoin([]);

      const call = await runToolContract(triSearchReleasesTool, {
        state: 'TX',
        year: 1990,
        chemical_name: 'Benzene',
      });

      expect(call.isError).toBeFalsy();
      expect(urls).toHaveLength(1);
      const structured = call.structuredContent as {
        releases: unknown[];
        message?: string;
        effectiveQuery?: string;
      };
      expect(structured.releases).toEqual([]);
      expect(structured.message).toContain('No TRI releases found. TRI data lags');
      expect(structured.message).toContain('try year 1989');
      expect(structured.effectiveQuery).toBe('state=TX; year=1990; chemical_name contains Benzene');
      const text = textOf(call.content);
      expect(text).toContain('No TRI releases found. TRI data lags');
      expect(text).toContain('Query: `state=TX; year=1990; chemical_name contains Benzene`');
    });

    const unmatchableHint =
      'Include a letter or digit in whichever of county or chemical_name has none, or remove that filter.';
    const tooLongHint =
      'Shorten county or chemical_name to a distinctive part of the name and retry.';

    it.each([
      [
        'a chemical_name with no letter or digit',
        { chemical_name: "'''" },
        'unmatchable_filter',
        unmatchableHint,
        'has no letter or digit',
      ],
      [
        'a county with no letter or digit',
        { county: "'''" },
        'unmatchable_filter',
        unmatchableHint,
        'has no letter or digit',
      ],
      [
        'a chemical_name past the request line',
        { chemical_name: 'a'.repeat(4000) },
        'filter_too_long',
        tooLongHint,
        'too long',
      ],
      [
        'a county past the request line',
        { county: 'a'.repeat(4000) },
        'filter_too_long',
        tooLongHint,
        'too long',
      ],
    ])(
      'rejects %s with its declared reason and recovery on both surfaces, before any request',
      async (_, filter, reason, hint, message) => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        const call = await runToolContract(triSearchReleasesTool, { state: 'WA', ...filter });

        expectValidationRejection(call, { reason, hint, message });
        expect(fetchSpy).not.toHaveBeenCalled();
      },
    );

    it('surfaces a caller abort mid-request as cancellation, never as an empty result', async () => {
      const controller = new AbortController();
      stubJoin(
        joinedRows,
        (signal) =>
          new Promise((_, reject) => {
            if (!signal) throw new Error('Request carried no abort signal');
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            controller.abort();
          }),
      );

      const call = await runToolContract(
        triSearchReleasesTool,
        { state: 'TX', year: 2022, limit: 200 },
        { context: { signal: controller.signal } },
      );

      expect(call.isError).toBe(true);
      expect(call.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.RequestCancelled },
      });
      expect(call.structuredContent).not.toHaveProperty('releases');
      const text = textOf(call.content);
      expect(text).toContain('Error:');
      expect(text).not.toContain('No TRI releases found');
    });
  });
});
