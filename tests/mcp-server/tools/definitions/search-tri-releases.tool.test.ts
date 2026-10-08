/**
 * @fileoverview Tests for searchTriReleasesTool.
 * @module tests/mcp-server/tools/definitions/search-tri-releases.tool.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchTriReleasesTool } from '@/mcp-server/tools/definitions/search-tri-releases.tool.js';
import { DmapService } from '@/services/dmap/dmap-service.js';

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
  totalReleasesInLbs: 580,
};

describe('searchTriReleasesTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns releases for valid state', async () => {
    mockSearchTriReleases.mockResolvedValue([waRelease]);
    const ctx = createMockContext({ errors: searchTriReleasesTool.errors });
    const input = searchTriReleasesTool.input.parse({ state: 'WA' });
    const result = await searchTriReleasesTool.handler(input, ctx);
    expect(result).toEqual({ releases: [waRelease], state: 'WA' });
  });

  it('uppercases state before calling service', async () => {
    mockSearchTriReleases.mockResolvedValue([waRelease]);
    const ctx = createMockContext({ errors: searchTriReleasesTool.errors });
    const input = searchTriReleasesTool.input.parse({ state: 'wa' });
    await searchTriReleasesTool.handler(input, ctx);
    expect(mockSearchTriReleases).toHaveBeenCalledWith(
      { state: 'WA', limit: 50, includeReleaseBreakdown: false },
      expect.anything(),
    );
  });

  it('passes county and year filters to service', async () => {
    mockSearchTriReleases.mockResolvedValue([waRelease]);
    const ctx = createMockContext({ errors: searchTriReleasesTool.errors });
    const input = searchTriReleasesTool.input.parse({
      state: 'WA',
      county: 'KING',
      year: 2022,
    });
    await searchTriReleasesTool.handler(input, ctx);
    expect(mockSearchTriReleases).toHaveBeenCalledWith(
      { state: 'WA', county: 'KING', year: 2022, limit: 50, includeReleaseBreakdown: false },
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
    mockSearchTriReleases.mockResolvedValue([waRelease]);
    const ctx = createMockContext({ errors: searchTriReleasesTool.errors });
    const input = searchTriReleasesTool.input.parse({ state: 'WA', county });
    await searchTriReleasesTool.handler(input, ctx);
    expect(mockSearchTriReleases).toHaveBeenCalledWith(
      expect.objectContaining({ county: expected }),
      expect.anything(),
    );
  });

  it('omits the county filter when county is blank', async () => {
    mockSearchTriReleases.mockResolvedValue([waRelease]);
    const ctx = createMockContext({ errors: searchTriReleasesTool.errors });
    const input = searchTriReleasesTool.input.parse({ state: 'WA', county: '   ' });
    await searchTriReleasesTool.handler(input, ctx);
    expect(mockSearchTriReleases.mock.calls[0]![0]).not.toHaveProperty('county');
  });

  it('names the normalized county in the no-results message', async () => {
    mockSearchTriReleases.mockResolvedValue([]);
    const ctx = createMockContext({ errors: searchTriReleasesTool.errors });
    const input = searchTriReleasesTool.input.parse({
      state: 'WA',
      county: 'Nowhere County',
      year: 2023,
    });
    const result = await searchTriReleasesTool.handler(input, ctx);
    expect(result.releases).toEqual([]);
    expect(result.message).toContain('No TRI releases found in WA in NOWHERE county for year 2023');
    expect(result.message).not.toMatch(/county county/i);
  });

  it('passes chemical_name filter trimmed', async () => {
    mockSearchTriReleases.mockResolvedValue([waRelease]);
    const ctx = createMockContext({ errors: searchTriReleasesTool.errors });
    const input = searchTriReleasesTool.input.parse({ state: 'WA', chemical_name: '  BENZENE  ' });
    await searchTriReleasesTool.handler(input, ctx);
    expect(mockSearchTriReleases).toHaveBeenCalledWith(
      expect.objectContaining({ chemicalName: 'BENZENE' }),
      expect.anything(),
    );
  });

  it('returns message when no releases found', async () => {
    mockSearchTriReleases.mockResolvedValue([]);
    const ctx = createMockContext({ errors: searchTriReleasesTool.errors });
    const input = searchTriReleasesTool.input.parse({ state: 'WY', year: 2010 });
    const result = await searchTriReleasesTool.handler(input, ctx);
    expect(result.releases).toEqual([]);
    expect(result.message).toMatch(/^No TRI releases found in WY for year 2010\. TRI data lags/);
  });

  it('formats output with chemical name, facility ID, and release amounts', () => {
    const output = { releases: [waRelease], state: 'WA' };
    const blocks = searchTriReleasesTool.format!(output);
    expect(blocks).toEqual([
      {
        type: 'text',
        text: [
          '## TRI Releases — WA',
          '**Records:** 1',
          '',
          '### BENZENE — TEST FACILITY (WA0001234) (2022)',
          '**One-Time / Non-Routine Release:** 580 lbs',
        ].join('\n'),
      },
    ]);
  });

  it('formats empty result with message', () => {
    const output = { releases: [], state: 'WY', message: 'No TRI releases found in WY.' };
    const blocks = searchTriReleasesTool.format!(output);
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
    const blocks = searchTriReleasesTool.format!(sparse);
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
      totalReleasesInLbs: 0,
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
      const item = searchTriReleasesTool.output.shape.releases.element.shape;
      expect(item.totalReleasesInLbs.description).toContain('one-time / non-routine');
      expect(item.totalReleasesInLbs.description).toContain('NOT the sum');
      expect(item.releasesToAirInLbs.description).toContain('air');
      expect(item.releasesToUndergroundInjectionInLbs.description).toContain('injection');
      expect(searchTriReleasesTool.description).toContain(
        'air, water, land, and underground-injection',
      );
      expect(searchTriReleasesTool.description).not.toMatch(/and release quantity/);
    });

    it('makes the breakdown opt-in and states its cost', () => {
      const flag = searchTriReleasesTool.input.shape.include_release_breakdown;
      expect(flag.parse(undefined)).toBe(false);
      expect(flag.description).toContain('20 seconds');
      expect(searchTriReleasesTool.description).toContain('include_release_breakdown');
      const item = searchTriReleasesTool.output.shape.releases.element.shape;
      expect(item.releasesToAirInLbs.description).toContain('include_release_breakdown');
    });

    it.each([
      [{}, false],
      [{ include_release_breakdown: false }, false],
      [{ include_release_breakdown: true }, true],
    ])('passes %j to the service as includeReleaseBreakdown=%s', async (flag, expected) => {
      mockSearchTriReleases.mockResolvedValue([waRelease]);
      const ctx = createMockContext({ errors: searchTriReleasesTool.errors });
      const input = searchTriReleasesTool.input.parse({ state: 'WA', ...flag });
      await searchTriReleasesTool.handler(input, ctx);
      expect(mockSearchTriReleases.mock.calls[0]![0]).toMatchObject({
        includeReleaseBreakdown: expected,
      });
    });

    it('carries the media on both structuredContent and content', async () => {
      mockSearchTriReleases.mockResolvedValue([fullBreakdown, airOnly]);
      const call = await runToolContract(searchTriReleasesTool, {
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
      const text = call.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      expect(text).toContain('**Air Releases:** 15,000 lbs');
      expect(text).toContain('**Water Releases:** 200 lbs');
      expect(text).toContain('**Land Releases:** 3,400 lbs');
      expect(text).toContain('**Underground Injection:** 90,000 lbs');
      expect(text).toContain('**One-Time / Non-Routine Release:** 0 lbs');
      expect(text).toContain('**Air Releases:** 4 lbs');
    });

    it('formats a record with no breakdown without any medium line', () => {
      const text = (
        searchTriReleasesTool.format!({
          releases: [{ facilityId: 'OR0001', chemicalName: 'Zinc', reportingYear: 2022 }],
          state: 'OR',
        })[0] as { text: string }
      ).text;
      expect(text).not.toMatch(/Air Releases|Water Releases|Land Releases|Underground Injection/);
      expect(text).not.toContain('One-Time / Non-Routine Release');
    });

    it('renders sub-0.001 quantities and medium sums at full precision', () => {
      const text = (
        searchTriReleasesTool.format!({
          releases: [
            {
              facilityId: '96020CLLNS500MA',
              chemicalName: 'Dioxin and dioxin-like compounds',
              reportingYear: 2022,
              totalReleasesInLbs: 0.00062,
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
      expect(text).toContain('**One-Time / Non-Routine Release:** 0.00062 lbs');
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
        totalReleasesInLbs: 0.0044092452437,
      };
      mockSearchTriReleases.mockResolvedValue([dioxin, waRelease]);
      const call = await runToolContract(searchTriReleasesTool, { state: 'CA', year: 2022 });
      expect(call.isError).toBeFalsy();
      const structured = call.structuredContent as { releases: Array<Record<string, unknown>> };
      expect(structured.releases).toEqual([dioxin, waRelease]);
      const text = call.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      expect(text).toContain(
        '**Reported Unit:** grams — any quantities shown are converted to pounds (1 lb = 453.59237 g)',
      );
      expect(text).toContain('**One-Time / Non-Routine Release:** 0.0044092452437 lbs');
      expect(text.match(/Reported Unit/g)).toHaveLength(1);
      const item = searchTriReleasesTool.output.shape.releases.element.shape;
      expect(item.reportedUnit.description).toMatch(/dioxin/i);
      expect(searchTriReleasesTool.description).toMatch(/grams/);
    });

    it('formats a gram-reported record with no quantities without promising any', () => {
      const text = (
        searchTriReleasesTool.format!({
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
        searchTriReleasesTool.format!({ releases: [airOnly], state: 'WA' })[0] as { text: string }
      ).text;
      expect(text).toContain('**Air Releases:** 4 lbs');
      expect(text).not.toMatch(/Water Releases|Land Releases|Underground Injection/);
    });
  });

  describe('result envelope below the limit', () => {
    it('returns records without truncation fields when fewer than limit come back', async () => {
      mockSearchTriReleases.mockResolvedValue([waRelease]);
      const call = await runToolContract(searchTriReleasesTool, { state: 'WA', limit: 5 });
      expect(call.isError).toBeFalsy();
      expect(mockSearchTriReleases.mock.calls[0]![0]).toMatchObject({
        includeReleaseBreakdown: false,
      });
      const structured = call.structuredContent as Record<string, unknown>;
      expect(structured.releases).toEqual([waRelease]);
      expect(structured).not.toHaveProperty('truncated');
      expect(structured).not.toHaveProperty('shown');
      const text = call.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      expect(text).toContain('**Records:** 1');
      expect(text).not.toMatch(/truncated/i);
    });

    it('returns the no-results message, not an error, for a county with no facilities', async () => {
      mockSearchTriReleases.mockResolvedValue([]);
      const call = await runToolContract(searchTriReleasesTool, {
        state: 'WA',
        county: 'Nowhere County',
        year: 2022,
      });
      expect(call.isError).toBeFalsy();
      const structured = call.structuredContent as { releases: unknown[]; message?: string };
      expect(structured.releases).toEqual([]);
      expect(structured.message).toContain('No TRI releases found in WA in NOWHERE county');
      const text = call.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      expect(text).toContain('No TRI releases found in WA in NOWHERE county');
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

      const call = await runToolContract(searchTriReleasesTool, {
        state: 'tx',
        year: 2022,
        limit: 2,
      });

      expect(call.isError).toBeFalsy();
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain('/and/reporting_year/equals/2022/1:2/json');
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
          totalReleasesInLbs: 0,
        },
        {
          facilityId: '77001PLANT',
          facilityName: 'HOUSTON PLANT 1',
          chemicalName: 'Benzene',
          reportingYear: 2022,
          totalReleasesInLbs: 1,
        },
      ]);
      expect(structured).toMatchObject({ truncated: true, shown: 2, cap: 2 });
      const text = call.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      expect(text).toContain('**Records:** 2');
      expect(text).toContain('Benzene — HOUSTON PLANT 1 (77001PLANT) (2022)');
    });

    it('returns every record below the limit without truncation fields', async () => {
      stubJoin(joinedRows);

      const call = await runToolContract(searchTriReleasesTool, { state: 'TX', year: 2022 });

      expect(call.isError).toBeFalsy();
      const structured = call.structuredContent as Record<string, unknown>;
      expect(structured.releases).toHaveLength(3);
      expect(structured).not.toHaveProperty('truncated');
      const text = call.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      expect(text).toContain('**Records:** 3');
    });

    it('returns the no-results message on both surfaces when the join matches nothing', async () => {
      const urls = stubJoin([]);

      const call = await runToolContract(searchTriReleasesTool, {
        state: 'TX',
        year: 1990,
        chemical_name: 'Benzene',
      });

      expect(call.isError).toBeFalsy();
      expect(urls).toHaveLength(1);
      const structured = call.structuredContent as { releases: unknown[]; message?: string };
      expect(structured.releases).toEqual([]);
      expect(structured.message).toContain('No TRI releases found in TX for year 1990');
      const text = call.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      expect(text).toContain('No TRI releases found in TX for year 1990');
    });

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
        searchTriReleasesTool,
        { state: 'TX', year: 2022, limit: 200 },
        { context: { signal: controller.signal } },
      );

      expect(call.isError).toBe(true);
      expect(call.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.RequestCancelled },
      });
      expect(call.structuredContent).not.toHaveProperty('releases');
      const text = call.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      expect(text).toContain('Error:');
      expect(text).not.toContain('No TRI releases found');
    });
  });
});
