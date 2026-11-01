/**
 * @fileoverview Tests for superfundSearchSitesTool.
 * @module tests/mcp-server/tools/definitions/superfund-search-sites.tool.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { superfundSearchSitesTool } from '@/mcp-server/tools/definitions/superfund-search-sites.tool.js';
import { DmapService } from '@/services/dmap/dmap-service.js';
import {
  describeLocationRendering,
  expectInvalidState,
  expectValidationRejection,
  textOf,
} from '../../../helpers.js';

const mockSearchSuperfund = vi.fn();

/** When set, getDmapService() returns this real service instead of the stub. */
const liveService: { current: DmapService | undefined } = { current: undefined };

vi.mock('@/services/dmap/dmap-service.js', async (importActual) => ({
  ...(await importActual<typeof import('@/services/dmap/dmap-service.js')>()),
  getDmapService: () =>
    liveService.current ?? {
      searchSuperfund: mockSearchSuperfund,
      getTriReleases: vi.fn(),
      searchTriReleases: vi.fn(),
      searchWaterSystems: vi.fn(),
    },
}));

const hanfordSite = {
  siteId: 'WA1890090003',
  name: 'HANFORD 100-AREA (USDOE)',
  street: 'RICHLAND',
  city: 'RICHLAND',
  state: 'WA',
  zip: '99352',
  county: 'BENTON',
  fipsCode: '53005',
  nplStatus: 'F',
  nplStatusName: 'Currently on the Final NPL',
  latitude: 46.652,
  longitude: -119.49,
};

describe('superfundSearchSitesTool', () => {
  it.each([
    { latitude: -90.01 },
    { latitude: 90.01 },
    { longitude: -180.01 },
    { longitude: 180.01 },
  ])('rejects impossible supplied coordinates %j', (coordinates) => {
    expect(superfundSearchSitesTool.input.safeParse({ state: 'WA', ...coordinates }).success).toBe(
      false,
    );
  });
  it.each([
    [0, 0],
    [-90, -180],
    [90, 180],
  ])('accepts valid coordinate endpoints %s,%s', async (latitude, longitude) => {
    mockSearchSuperfund.mockResolvedValue({ items: [], totalCount: 0 });
    const input = superfundSearchSitesTool.input.parse({ latitude, longitude, radius_miles: 1 });
    await superfundSearchSitesTool.handler(
      input,
      createMockContext({ errors: superfundSearchSitesTool.errors }),
    );
    expect(mockSearchSuperfund).toHaveBeenCalledWith(
      expect.objectContaining({ latitude, longitude, radiusMiles: 1 }),
      expect.anything(),
    );
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns sites for valid state filter', async () => {
    mockSearchSuperfund.mockResolvedValue({ items: [hanfordSite] });
    const ctx = createMockContext({ errors: superfundSearchSitesTool.errors });
    const input = superfundSearchSitesTool.input.parse({ state: ' WA ' });
    const result = await superfundSearchSitesTool.handler(input, ctx);
    // npl_status defaults to "all", which sends no NPL filter.
    expect(mockSearchSuperfund).toHaveBeenCalledWith({ state: 'WA', offset: 0, limit: 50 }, ctx);
    expect(result).toEqual({ sites: [hanfordSite] });
  });

  it('searches a ZIP+4 by its 5-digit ZIP and an uppercased state code', async () => {
    mockSearchSuperfund.mockResolvedValue({ items: [hanfordSite] });
    const call = await runToolContract(superfundSearchSitesTool, {
      state: 'nj',
      zip_code: '07631-2720',
    });
    expect(call.isError).toBeFalsy();
    expect(mockSearchSuperfund.mock.calls[0]![0]).toEqual({
      state: 'NJ',
      zipCode: '07631',
      offset: 0,
      limit: 50,
    });
  });

  it('reads blank state and zip_code as omitted', async () => {
    mockSearchSuperfund.mockResolvedValue({ items: [hanfordSite] });
    const call = await runToolContract(superfundSearchSitesTool, {
      state: '',
      zip_code: '',
      city: 'Richland',
    });
    expect(call.isError).toBeFalsy();
    expect(mockSearchSuperfund.mock.calls[0]![0]).toEqual({
      city: 'Richland',
      offset: 0,
      limit: 50,
    });
  });

  it.each([
    [{ state: 'Washington' }, '2-letter USPS code'],
    [{ state: 'W' }, '2-letter USPS code'],
    [{ zip_code: '9810' }, '5-digit ZIP code'],
    [{ zip_code: 'abcde' }, '5-digit ZIP code'],
  ])('rejects %j at the schema, naming the expected form', async (args, form) => {
    const call = await runToolContract(superfundSearchSitesTool, args);
    expect(call.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(textOf(call.content)).toContain(form);
    expect(mockSearchSuperfund).not.toHaveBeenCalled();
  });

  it('rejects an unknown state code as invalid_state with its recovery, before any request', async () => {
    expectInvalidState(await runToolContract(superfundSearchSitesTool, { state: 'ZZ' }));
    expect(mockSearchSuperfund).not.toHaveBeenCalled();
  });

  it('returns sites for city filter', async () => {
    mockSearchSuperfund.mockResolvedValue({ items: [hanfordSite] });
    const ctx = createMockContext({ errors: superfundSearchSitesTool.errors });
    const input = superfundSearchSitesTool.input.parse({
      city: 'RICHLAND',
      state: 'WA',
      npl_status: 'listed',
    });
    const result = await superfundSearchSitesTool.handler(input, ctx);
    expect(mockSearchSuperfund).toHaveBeenCalledWith(
      { state: 'WA', city: 'RICHLAND', nplStatus: 'listed', offset: 0, limit: 50 },
      ctx,
    );
    expect(result.sites).toEqual([hanfordSite]);
  });

  it('returns sites for lat/lng + radius proximity search', async () => {
    mockSearchSuperfund.mockResolvedValue({ items: [hanfordSite], totalCount: 1 });
    const ctx = createMockContext({ errors: superfundSearchSitesTool.errors });
    const input = superfundSearchSitesTool.input.parse({
      latitude: 46.652,
      longitude: -119.49,
      radius_miles: 50,
    });
    const result = await superfundSearchSitesTool.handler(input, ctx);
    expect(mockSearchSuperfund).toHaveBeenCalledWith(
      { latitude: 46.652, longitude: -119.49, radiusMiles: 50, offset: 0, limit: 50 },
      ctx,
    );
    expect(result).toEqual({ sites: [hanfordSite], totalCount: 1 });
  });

  it('throws no_location_filter when no location provided', async () => {
    const ctx = createMockContext({ errors: superfundSearchSitesTool.errors });
    const input = superfundSearchSitesTool.input.parse({ npl_status: 'listed' });
    await expect(superfundSearchSitesTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_location_filter' },
    });
  });

  it('throws no_location_filter when location fields are blank strings', async () => {
    const ctx = createMockContext({ errors: superfundSearchSitesTool.errors });
    const input = superfundSearchSitesTool.input.parse({ state: '  ', city: '  ', zip_code: '  ' });
    await expect(superfundSearchSitesTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_location_filter' },
    });
  });

  it('throws radius_required when lat/lng provided without radius_miles', async () => {
    const ctx = createMockContext({ errors: superfundSearchSitesTool.errors });
    const input = superfundSearchSitesTool.input.parse({
      latitude: 46.652,
      longitude: -119.49,
    });
    await expect(superfundSearchSitesTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'radius_required' },
    });
  });

  it('returns recovery advice without restating the filters when no sites are found', async () => {
    mockSearchSuperfund.mockResolvedValue({ items: [] });
    const ctx = createMockContext({ errors: superfundSearchSitesTool.errors });
    const input = superfundSearchSitesTool.input.parse({ state: 'HI', npl_status: 'listed' });
    const result = await superfundSearchSitesTool.handler(input, ctx);
    expect(result).toEqual({
      sites: [],
      message:
        'No Superfund sites found. Try expanding the area, removing NPL status filter, or using a different location.',
    });
  });

  describe('query echo', () => {
    const echoOf = async (args: Record<string, unknown>, items: unknown[] = [hanfordSite]) => {
      mockSearchSuperfund.mockResolvedValue({ items });
      const ctx = createMockContext({ errors: superfundSearchSitesTool.errors });
      await superfundSearchSitesTool.handler(superfundSearchSitesTool.input.parse(args), ctx);
      return getEnrichment(ctx).effectiveQuery;
    };

    it('echoes the normalized administrative filters and the NPL codes sent', async () => {
      expect(
        await echoOf({
          state: ' nj ',
          city: ' Newark ',
          zip_code: '07105-1234',
          npl_status: 'listed',
          exclude_archived: true,
        }),
      ).toBe(
        'state=NJ; city contains Newark; zip_code begins with 07105; npl_status=F,A; exclude_archived=true',
      );
    });

    it('echoes the proximity point and radius with its nearest-first order', async () => {
      expect(
        await echoOf({ latitude: 40.7357, longitude: -74.1724, radius_miles: 5, state: 'NJ' }),
      ).toBe('state=NJ; latitude=40.7357; longitude=-74.1724; radius_miles=5, nearest first');
    });

    it('leaves out blank inputs, npl_status all, and exclude_archived off', async () => {
      expect(await echoOf({ state: 'WA', city: '  ', zip_code: '', npl_status: 'all' })).toBe(
        'state=WA',
      );
    });

    it('echoes on an empty result too', async () => {
      expect(await echoOf({ state: 'HI', npl_status: 'deleted' }, [])).toBe(
        'state=HI; npl_status=D',
      );
    });
  });

  describe('paging', () => {
    it('clamps an over-cap limit to 200 with a notice and passes offset through', async () => {
      mockSearchSuperfund.mockResolvedValue({ items: [hanfordSite] });
      const ctx = createMockContext({ errors: superfundSearchSitesTool.errors });
      const input = superfundSearchSitesTool.input.parse({ state: 'WA', limit: 500, offset: 400 });
      await superfundSearchSitesTool.handler(input, ctx);
      expect(mockSearchSuperfund).toHaveBeenCalledWith(
        { state: 'WA', offset: 400, limit: 200 },
        ctx,
      );
      expect(getEnrichment(ctx).limitNotice).toBe(
        "limit 500 is above this tool's cap of 200, so at most 200 records were returned.",
      );
    });

    it('rejects a limit above the 5,000 ceiling and a negative offset at the schema', () => {
      expect(superfundSearchSitesTool.input.safeParse({ state: 'WA', limit: 5001 }).success).toBe(
        false,
      );
      expect(superfundSearchSitesTool.input.safeParse({ state: 'WA', offset: -1 }).success).toBe(
        false,
      );
    });

    it('names nextOffset in the guidance when more sites follow, never a larger limit', async () => {
      mockSearchSuperfund.mockResolvedValue({ items: [hanfordSite], nextOffset: 250 });
      const call = await runToolContract(superfundSearchSitesTool, {
        state: 'WA',
        limit: 200,
        offset: 50,
      });
      const guidance = 'More records follow; call again with offset 250 to continue.';
      expect(call.structuredContent).toMatchObject({ nextOffset: 250, guidance });
      expect(call.structuredContent).not.toHaveProperty('limitNotice');
      const text = textOf(call.content);
      expect(text).toContain('**Next offset:** 250');
      expect(text).toContain(guidance);
      expect(text).not.toMatch(/raise|increase/i);
    });

    it('writes no nextOffset or guidance on the last page', async () => {
      mockSearchSuperfund.mockResolvedValue({ items: [hanfordSite] });
      const call = await runToolContract(superfundSearchSitesTool, { state: 'WA' });
      expect(call.structuredContent).not.toHaveProperty('nextOffset');
      expect(call.structuredContent).not.toHaveProperty('guidance');
    });

    it('returns the proximity match count as totalCount, and no totalCount without one', async () => {
      mockSearchSuperfund.mockResolvedValue({ items: [hanfordSite], totalCount: 203 });
      const proximity = await runToolContract(superfundSearchSitesTool, {
        latitude: 46.652,
        longitude: -119.49,
        radius_miles: 5,
      });
      expect(proximity.structuredContent).toMatchObject({ totalCount: 203 });
      mockSearchSuperfund.mockResolvedValue({ items: [hanfordSite] });
      const admin = await runToolContract(superfundSearchSitesTool, { state: 'WA' });
      expect(admin.structuredContent).not.toHaveProperty('totalCount');
    });

    it.each([
      [
        undefined,
        'No Superfund sites found at offset 300: the search has no sites past it. Lower offset, or start again at offset 0.',
      ],
      [400, 'No Superfund sites found at offset 300.'],
    ])(
      'says an empty page at an offset is past the end only when nothing follows (nextOffset %s)',
      async (nextOffset, message) => {
        mockSearchSuperfund.mockResolvedValue({
          items: [],
          ...(nextOffset !== undefined && { nextOffset }),
        });
        const call = await runToolContract(superfundSearchSitesTool, {
          state: 'ID',
          offset: 300,
        });
        expect(call.structuredContent).toMatchObject({ sites: [], message });
        expect(textOf(call.content)).toContain(message);
      },
    );
  });

  it("bounds city at 4,094 characters, DMAP's whole request-line limit", () => {
    const parse = (city: string) => superfundSearchSitesTool.input.safeParse({ city }).success;
    // The longest sems.envirofacts_site city_name (live 2026-10-16), 57 characters.
    expect(parse('WAPPINGERS FALLS, TOWN OF WAPPINGER, TOWN OF POUGHKEEPSIE')).toBe(true);
    expect(parse('x'.repeat(4094))).toBe(true);
    expect(parse('x'.repeat(4095))).toBe(false);
    expect(superfundSearchSitesTool.input.shape.city.description).toContain('matched as written');
  });

  describe('DMAP input rejections through the real service', () => {
    beforeEach(() => {
      liveService.current = new DmapService({} as AppConfig, {} as StorageService);
    });
    afterEach(() => {
      liveService.current = undefined;
      vi.restoreAllMocks();
    });

    it.each([
      [
        'a city with no letter or digit',
        { state: 'WA', city: "'''" },
        'unmatchable_filter',
        'Include a letter or digit in city, or search by state or zip_code instead.',
        'has no letter or digit',
      ],
      [
        'a city past the request line',
        { city: 'a'.repeat(4030), limit: 1 },
        'filter_too_long',
        'Shorten city to a distinctive part of its name and retry.',
        'too long',
      ],
      [
        'a proximity city past the request line',
        { city: 'a'.repeat(4030), latitude: 47.6, longitude: -122.3, radius_miles: 1 },
        'filter_too_long',
        'Shorten city to a distinctive part of its name and retry.',
        'too long',
      ],
    ])(
      'rejects %s with its declared reason and recovery on both surfaces, before any request',
      async (_, args, reason, hint, message) => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        const call = await runToolContract(superfundSearchSitesTool, args);

        expectValidationRejection(call, { reason, hint, message });
        expect(fetchSpy).not.toHaveBeenCalled();
      },
    );
  });

  it('formats output with site ID, NPL status, and coordinates', () => {
    const output = { sites: [hanfordSite], totalCount: 203 };
    const blocks = superfundSearchSitesTool.format!(output);
    expect(blocks).toHaveLength(1);
    const lines = (blocks[0] as { type: string; text: string }).text.split('\n');
    for (const line of [
      '## Superfund Sites',
      '**Total Found:** 203 | **Returned:** 1',
      '### HANFORD 100-AREA (USDOE)',
      '**Site ID:** WA1890090003',
      '**Location:** RICHLAND, RICHLAND, WA, 99352',
      '**County:** BENTON (FIPS: 53005)',
      '**Coordinates:** 46.652, -119.49',
      '**NPL Status:** F',
      '**NPL Status Name:** Currently on the Final NPL',
    ]) {
      expect(lines).toContain(line);
    }
  });

  it('formats empty result with message, and the returned count alone without a match count', () => {
    const output = { sites: [], message: 'No Superfund sites found.' };
    const blocks = superfundSearchSitesTool.format!(output);
    const lines = (blocks[0] as { type: string; text: string }).text.split('\n');
    expect(lines).toContain('**Returned:** 0');
    expect(lines.join('\n')).not.toContain('Total Found');
    expect(lines).toContain('> No Superfund sites found.');
  });

  it('formats sparse site (minimal required fields)', () => {
    const sparse = {
      sites: [{ siteId: 'TX1234', name: 'SPARSE SITE' }],
      totalCount: 1,
    };
    const blocks = superfundSearchSitesTool.format!(sparse);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text.slice(text.indexOf('### '))).toBe('### SPARSE SITE\n**Site ID:** TX1234');
  });

  describeLocationRendering(
    (fields) =>
      (
        superfundSearchSitesTool.format!({
          sites: [{ siteId: 'COORD001', name: 'COORD SITE', ...fields }],
          totalCount: 1,
        })[0] as { text: string }
      ).text,
  );
});
