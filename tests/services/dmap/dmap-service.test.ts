/**
 * @fileoverview Tests for DmapService TRI and drinking-water retrieval, including per-medium
 * breakdowns and bounded regional-search pagination. `fetch` is stubbed — routed by table path, or
 * answered by an in-memory DMAP evaluator that applies filters, joins, and row ranges — so the
 * built URLs are observable.
 * @module tests/services/dmap/dmap-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTriReleasesTool } from '@/mcp-server/tools/definitions/get-tri-releases.tool.js';
import { searchSuperfundTool } from '@/mcp-server/tools/definitions/search-superfund.tool.js';
import { searchTriReleasesTool } from '@/mcp-server/tools/definitions/search-tri-releases.tool.js';
import { DmapService, initDmapService } from '@/services/dmap/dmap-service.js';

/**
 * Route fetch by URL substring, returning each route's rows as a JSON array. A request no route
 * matches rejects with a non-retryable error, so an unexpected URL fails the test instead of
 * silently reading as an empty table.
 */
function stubDmapFetch(routes: Array<{ match: string; rows: unknown[] }>): string[] {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    urls.push(url);
    const route = routes.find((r) => url.includes(r.match));
    if (!route) {
      return Promise.reject(validationError(`Unmocked DMAP fetch: ${url}`, { retryable: false }));
    }
    return Promise.resolve(new Response(JSON.stringify(route.rows), { status: 200 }));
  });
  return urls;
}

/**
 * Serve a table the way DMAP pages it: the trailing `first:last` range is 1-based and inclusive,
 * and a `first` of 0 reads as row 1 (live, 2026-10-08: `tri.tri_facility` WA `0:4` → 4 rows,
 * `1:5` → 5 rows; `sems.envirofacts_site` WA `0:2` → 2 rows, `1:3` → 3 rows).
 */
function dmapPage(url: string, table: unknown[]): unknown[] {
  const range = /\/(\d+):(\d+)\/json$/.exec(url);
  if (!range) throw new Error(`No first:last range in ${url}`);
  const first = Math.max(Number(range[1]), 1);
  return table.slice(first - 1, Number(range[2]));
}

/** Stub fetch with one paged table per URL substring; unmatched URLs reject. */
function stubPagedDmapFetch(routes: Array<{ match: string; table: unknown[] }>): string[] {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    urls.push(url);
    const route = routes.find((r) => url.includes(r.match));
    if (!route) {
      return Promise.reject(validationError(`Unmocked DMAP fetch: ${url}`, { retryable: false }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(dmapPage(url, route.table)), { status: 200 }),
    );
  });
  return urls;
}

function makeService(): DmapService {
  // Constructor ignores config/storage and reads only getServerConfig().dmapBaseUrl (defaulted).
  return new DmapService({} as AppConfig, {} as StorageService);
}

type DmapRow = Record<string, unknown>;
type DmapFilter = { column: string; operator: string; value: string };

/**
 * A filter value DMAP's path parser cannot read (live, 2026-10-16): a character outside letters,
 * digits, space, `,` `-` `_` `?` `@` is HTTP 500 "The query could not be parsed" (apostrophes,
 * brackets, parentheses, periods, slashes, non-ASCII letters); `%` is an nginx HTTP 403.
 */
class DmapParseError extends Error {
  constructor(
    readonly status: 403 | 500,
    readonly character: string,
  ) {
    super(`The query could not be parsed. No terminal matches '${character}'`);
  }
}

function checkDmapValue(value: string): void {
  for (const character of value) {
    if (character === '%') throw new DmapParseError(403, character);
    if (!/[A-Za-z0-9 ,\-_?@]/.test(character)) throw new DmapParseError(500, character);
  }
}

/**
 * Apply one DMAP filter the way the live service does (2026-10-16). Text comparisons are
 * case-insensitive. A comma ends an `equals` or `contains` value — DMAP ignores the rest, so
 * `contains/1,3-Butadiene` matches any name containing "1" — and in `contains`, `_` and `?` match
 * any one character (`Michler_s` matches "Michler's ketone").
 */
function dmapRowMatches(row: DmapRow, filter: DmapFilter): boolean {
  const cell = String(row[filter.column] ?? '').toLowerCase();
  const value = filter.value.toLowerCase();
  const head = value.split(',')[0]!;
  if (filter.operator === 'equals') return cell === head;
  if (filter.operator === 'beginsWith') return cell.startsWith(head);
  if (filter.operator === 'contains') {
    const pattern = Array.from(head, (c) =>
      c === '_' || c === '?' ? '.' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    ).join('');
    return new RegExp(pattern, 'su').test(cell);
  }
  if (filter.operator === 'in') return value.split(',').includes(cell);
  throw new Error(`Fake DMAP has no operator ${filter.operator}`);
}

/** Read `col/op/val[/and/col/op/val…]` from `segments` at `start`, stopping at a non-`and` word. */
function readDmapFilters(segments: string[], start: number): [DmapFilter[], number] {
  const filters: DmapFilter[] = [];
  let i = start;
  while (
    i + 2 < segments.length &&
    !/^\d+:\d+$/.test(segments[i]!) &&
    segments[i] !== 'join' &&
    segments[i] !== 'sort'
  ) {
    checkDmapValue(segments[i + 2]!);
    filters.push({ column: segments[i]!, operator: segments[i + 1]!, value: segments[i + 2]! });
    i += 3;
    if (segments[i] !== 'and') break;
    i += 1;
  }
  return [filters, i];
}

/** Order two DMAP cells: numerically when both are numbers, otherwise as text. */
function compareDmapCells(a: unknown, b: unknown): number {
  const numeric = (v: unknown) =>
    typeof v === 'number' || (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v));
  if (numeric(a) && numeric(b)) return Number(a) - Number(b);
  const [x, y] = [String(a ?? ''), String(b ?? '')];
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Evaluate a DMAP URL against in-memory tables, the way the live service does (2026-10-08,
 * sort 2026-10-16):
 * `{table}/{filters}[/join/{table}/{left}/equals/{right}[/and/{filter}…]][/sort/{key},…]/{first}:{last}/json`.
 * Filters before the join bind to the first table and a filter on a column it lacks is an error;
 * `and` filters after the join comparison bind to the joined table; joined rows come out in
 * first-table order, each carrying both tables' columns. A sort key is
 * `{schema}.{table}.{column}:{asc|desc}`; an unqualified column resolves against the first table
 * (live: `reporting_year:desc` on the facility join is HTTP 500 "The order field
 * tri.tri_facility.reporting_year does not exist."). The range is 1-based and inclusive.
 * DMAP decodes the path before splitting it and drops empty segments, so an encoded slash at
 * either end of a value reads as no slash at all (live, 2026-10-16: `equals/98108THBNG7500E%2F`,
 * `equals/%2F98108THBNG7500E`, and `contains/Seattle%2F` answer as the bare value does).
 */
function evaluateDmapUrl(url: string, tables: Record<string, DmapRow[]>): DmapRow[] {
  const path = url.replace(/^https:\/\/data\.epa\.gov\/dmapservice\//, '').replace(/\/json$/, '');
  const segments = decodeURIComponent(path)
    .split('/')
    .filter((segment) => segment !== '');
  const tableRows = (name: string): DmapRow[] => {
    const rows = tables[name];
    if (!rows) throw new Error(`Fake DMAP has no table ${name}`);
    return rows;
  };
  const checkColumns = (name: string, filters: DmapFilter[]) => {
    for (const { column } of filters) {
      const rows = tableRows(name);
      if (rows.length > 0 && !rows.some((row) => column in row)) {
        throw new Error(`The column, ${name}.${column} does not exist`);
      }
    }
  };

  const baseName = segments[0]!;
  const [baseFilters, afterBase] = readDmapFilters(segments, 1);
  checkColumns(baseName, baseFilters);
  let rows = tableRows(baseName).filter((row) => baseFilters.every((f) => dmapRowMatches(row, f)));
  let i = afterBase;
  let joinName: string | undefined;

  if (segments[i] === 'join') {
    joinName = segments[i + 1]!;
    const [leftColumn, , rightColumn] = segments.slice(i + 2, i + 5);
    i += 5;
    let joinFilters: DmapFilter[] = [];
    if (segments[i] === 'and') [joinFilters, i] = readDmapFilters(segments, i + 1);
    checkColumns(joinName, joinFilters);
    const joinRows = tableRows(joinName).filter((row) =>
      joinFilters.every((f) => dmapRowMatches(row, f)),
    );
    rows = rows.flatMap((base) =>
      joinRows
        .filter((joined) => joined[rightColumn!] === base[leftColumn!])
        .map((joined) => ({ ...joined, ...base })),
    );
  }

  if (segments[i] === 'sort') {
    const keys = segments[i + 1]!.split(',').map((key) => {
      const [field = '', direction] = key.split(':');
      const dot = field.lastIndexOf('.');
      const table = dot === -1 ? baseName : field.slice(0, dot);
      const column = field.slice(dot + 1);
      const tableRowsForKey = table === baseName || table === joinName ? tableRows(table) : [];
      if (
        (table !== baseName && table !== joinName) ||
        (tableRowsForKey.length > 0 && !tableRowsForKey.some((row) => column in row))
      ) {
        throw new Error(`The order field ${table}.${column} does not exist.`);
      }
      if (direction !== 'asc' && direction !== 'desc') {
        throw new Error(`Unknown sort direction ${direction}`);
      }
      return { column, sign: direction === 'desc' ? -1 : 1 };
    });
    rows = rows.toSorted((a, b) => {
      for (const { column, sign } of keys) {
        const order = compareDmapCells(a[column], b[column]);
        if (order !== 0) return sign * order;
      }
      return 0;
    });
    i += 2;
  }

  const range = /^(\d+):(\d+)$/.exec(segments[i] ?? '');
  if (!range) throw new Error(`No first:last range in ${url}`);
  return rows.slice(Math.max(Number(range[1]), 1) - 1, Number(range[2]));
}

/** The HTTP/1.1 request line a GET of `url` sends: method, path and query, protocol. */
function requestLine(url: string): string {
  const { pathname, search } = new URL(url);
  return `GET ${pathname}${search} HTTP/1.1`;
}

/**
 * DMAP's front end refuses a request line past 4,094 bytes with this HTTP 400 page. It counts 11
 * bytes fewer than the client sends (live, 2026-10-16: a 4,105-byte client line is answered, a
 * 4,106-byte one is "Request Line is too large (4095 &gt; 4094)").
 */
const DMAP_UNCOUNTED_BYTES = 11;

function requestLineTooLarge(length: number): Response {
  return new Response(
    `<html>\n  <head>\n    <title>Bad Request</title>\n  </head>\n  <body>\n    <h1><p>Bad Request</p></h1>\n    Request Line is too large (${length} &gt; 4094)\n  </body>\n</html>\n`,
    { status: 400, statusText: 'Bad Request' },
  );
}

/**
 * Stub fetch with a fake DMAP over `tables`, recording every URL. A request line past 4,094 bytes
 * gets DMAP's HTTP 400. `beforeResponse` runs before each response and can hold or fail it (the
 * abort tests park a request there), or answer it with a Response of its own.
 */
function stubFakeDmap(
  tables: Record<string, DmapRow[]>,
  beforeResponse?: (url: string, signal: AbortSignal | undefined) => Promise<unknown>,
): string[] {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    urls.push(url);
    const counted = Buffer.byteLength(requestLine(url)) - DMAP_UNCOUNTED_BYTES;
    if (counted > 4094) return requestLineTooLarge(counted);
    const held = await beforeResponse?.(url, init?.signal ?? undefined);
    if (held instanceof Response) return held;
    let rows: DmapRow[];
    try {
      rows = evaluateDmapUrl(url, tables);
    } catch (error) {
      if (error instanceof DmapParseError) {
        return error.status === 403
          ? new Response('<html><head><title>403 Forbidden</title></head></html>', {
              status: 403,
              statusText: 'Forbidden',
            })
          : new Response(JSON.stringify({ error: error.message }), {
              status: 500,
              statusText: 'INTERNAL SERVER ERROR',
            });
      }
      throw validationError(`Fake DMAP rejected ${url}: ${(error as Error).message}`, {
        retryable: false,
      });
    }
    return new Response(JSON.stringify(rows), { status: 200 });
  });
  return urls;
}

/** Park a request until its signal aborts, aborting `controller` once the request is in flight. */
function abortWhileInFlight(controller: AbortController) {
  return (_url: string, signal: AbortSignal | undefined) =>
    new Promise<void>((_, reject) => {
      if (!signal) throw new Error('Request carried no abort signal');
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      controller.abort();
    });
}

describe('DmapService Superfund proximity candidates', () => {
  afterEach(() => vi.restoreAllMocks());

  it('characterizes ZIP-only searches without coordinates', async () => {
    const urls = stubFakeDmap({
      'sems.envirofacts_site': [{ site_id: 'S1', name: 'SPARSE', zip_code: '98104' }],
    });
    const sites = await makeService().searchSuperfund(
      { zipCode: '98104', limit: 1 },
      createMockContext(),
    );
    expect(sites).toEqual([{ siteId: 'S1', name: 'SPARSE', zip: '98104' }]);
    expect(urls).toEqual([
      'https://data.epa.gov/dmapservice/sems.envirofacts_site/zip_code/equals/98104/1:1/json',
    ]);
  });

  it('requests latitude candidates for coordinate-only searches', async () => {
    const urls = stubFakeDmap({
      'sems.envirofacts_site': [
        {
          site_id: '1002655',
          name: 'LOCKHEED WEST SEATTLE',
          primary_latitude_decimal_val: '47.583889',
          primary_longitude_decimal_val: '-122.3625',
        },
        {
          site_id: 'FAR',
          name: 'FAR',
          primary_latitude_decimal_val: '47.5',
          primary_longitude_decimal_val: '-111.2',
        },
      ],
    });
    const sites = await makeService().searchSuperfund(
      { latitude: 47.6, longitude: -122.3, radiusMiles: 25 },
      createMockContext(),
    );
    expect(sites.map((s) => s.siteId)).toEqual(['1002655']);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/primary_latitude_decimal_val/beginsWith/47/1:500/json');
  });

  it.each([
    ['negative', -14.2, -170.7, -14.21, -170.7],
    ['equator', 0, 0, -0.01, 0],
    ['zero', 0, 0, 0, 0],
    ['9/10 boundary', 9.99, 0, 10.01, 0],
    ['negative 9/10 boundary', -9.99, 0, -10.01, 0],
    ['longitude wrap', 47.6, 179.99, 47.6, -179.99],
    ['north pole', 90, 0, 89.99, 180],
    ['south pole', -90, 0, -89.99, 180],
  ] as const)(
    'covers %s without a numeric longitude predicate',
    async (_name, latitude, longitude, lat, lng) => {
      const urls = stubFakeDmap({
        'sems.envirofacts_site': [
          {
            site_id: 'NEAR',
            name: 'NEAR',
            primary_latitude_decimal_val: String(lat),
            primary_longitude_decimal_val: String(lng),
          },
          { site_id: 'MISSING', name: 'MISSING', primary_latitude_decimal_val: String(lat) },
        ],
      });
      const sites = await makeService().searchSuperfund(
        { latitude, longitude, radiusMiles: 5 },
        createMockContext(),
      );
      expect(sites.map((s) => s.siteId)).toEqual(['NEAR']);
      expect(urls.every((url) => !url.includes('/primary_longitude_decimal_val/'))).toBe(true);
      if (latitude === 0) {
        expect(urls.some((url) => url.includes('/beginsWith/0/'))).toBe(true);
        expect(urls.some((url) => url.includes('/beginsWith/-0/'))).toBe(true);
      }
    },
  );

  it('retains combined filters and punctuation matching, deduplicating overlapping prefixes', async () => {
    const row = {
      site_id: 'S1',
      name: 'ONE',
      city_name: 'ST. LOUIS',
      fk_ref_state_code: 'MO',
      zip_code: '63101',
      npl_status_code: 'NPL',
      primary_latitude_decimal_val: '40',
      primary_longitude_decimal_val: '0',
    };
    const urls = stubFakeDmap({
      'sems.envirofacts_site': [row, row, { ...row, site_id: 'VARIANT', city_name: 'STX LOUIS' }],
    });
    const sites = await makeService().searchSuperfund(
      {
        latitude: 39.99,
        longitude: 0,
        radiusMiles: 5,
        city: 'St. Louis',
        state: 'MO',
        zipCode: '63101',
        nplStatus: 'listed',
      },
      createMockContext(),
    );
    expect(sites.map((s) => s.siteId)).toEqual(['S1']);
    expect(urls).toHaveLength(2);
    for (const url of urls)
      expect(decodeURIComponent(url)).toContain(
        '/fk_ref_state_code/equals/MO/and/city_name/contains/St_ Louis/and/zip_code/equals/63101/and/npl_status_code/equals/NPL/and/primary_latitude_decimal_val/beginsWith/',
      );
  });

  it.each([false, true])(
    'discloses the combined raw candidate cap on both surfaces, nearby=%s',
    async (nearby) => {
      const rows = Array.from({ length: 600 }, (_, i) => ({
        site_id: `S${i}`,
        name: `SITE ${i}`,
        primary_latitude_decimal_val: i < 200 ? '9.99' : '10.01',
        primary_longitude_decimal_val: nearby ? '0' : '100',
      }));
      const urls = stubFakeDmap({ 'sems.envirofacts_site': rows });
      initDmapService({} as AppConfig, {} as StorageService);
      const call = await runToolContract(searchSuperfundTool, {
        latitude: 9.99,
        longitude: 0,
        radius_miles: 5,
        limit: 2,
      });
      expect(call.isError).toBeFalsy();
      const structured = call.structuredContent as {
        sites: unknown[];
        notice: string;
        message?: string;
      };
      expect(structured.sites).toHaveLength(nearby ? 2 : 0);
      expect(structured.notice).toContain('500-candidate cap');
      expect(structured.notice).toContain('More nearby sites may exist');
      const text = call.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
      expect(text).toContain(structured.notice);
      if (!nearby) expect(text).toContain('No Superfund sites found in the retrieved candidates');
      expect(urls.map((url) => /\/(\d+:\d+)\/json$/.exec(url)![1])).toEqual(['1:500', '1:300']);
    },
  );

  it('carries uncapped proximity results without a notice on both surfaces', async () => {
    stubFakeDmap({
      'sems.envirofacts_site': [
        {
          site_id: 'ZERO',
          name: 'ZERO SITE',
          primary_latitude_decimal_val: '0',
          primary_longitude_decimal_val: '0',
        },
      ],
    });
    initDmapService({} as AppConfig, {} as StorageService);
    const call = await runToolContract(searchSuperfundTool, {
      latitude: 0,
      longitude: 0,
      radius_miles: 1,
    });
    expect(call.isError).toBeFalsy();
    expect(call.structuredContent).toMatchObject({
      sites: [{ siteId: 'ZERO', latitude: 0, longitude: 0 }],
      totalCount: 1,
    });
    expect(call.structuredContent).not.toHaveProperty('notice');
    expect(call.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n')).toContain(
      '**Coordinates:** 0, 0',
    );
  });

  it('excludes integer-prefix overfetch at another digit width', async () => {
    stubFakeDmap({
      'sems.envirofacts_site': [
        {
          site_id: 'NEAR',
          name: 'NEAR',
          primary_latitude_decimal_val: '4.51',
          primary_longitude_decimal_val: '0',
        },
        {
          site_id: 'OVERFETCH',
          name: 'OVERFETCH',
          primary_latitude_decimal_val: '45.1',
          primary_longitude_decimal_val: '0',
        },
      ],
    });
    const sites = await makeService().searchSuperfund(
      { latitude: 4.5, longitude: 0, radiusMiles: 5 },
      createMockContext(),
    );
    expect(sites.map((site) => site.siteId)).toEqual(['NEAR']);
  });

  it('stops candidate queries when the second request is cancelled', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const urls = stubFakeDmap({ 'sems.envirofacts_site': [] }, (url, signal) => {
      if (++attempts === 2) return abortWhileInFlight(controller)(url, signal);
      return Promise.resolve();
    });
    await expect(
      makeService().searchSuperfund(
        { latitude: 0, longitude: 0, radiusMiles: 500 },
        createMockContext({ signal: controller.signal }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(urls).toHaveLength(2);
  });
});

describe('DmapService facility TRI cap and order', () => {
  afterEach(() => vi.restoreAllMocks());

  const forms = () => [
    {
      tri_facility_id: 'FAC',
      cas_chem_name: '1,3-Butadiene',
      reporting_year: '1987',
      doc_ctrl_num: 'A',
    },
    ...Array.from({ length: 500 }, (_, i) => ({
      tri_facility_id: 'FAC',
      cas_chem_name: '1,3-Butadiene',
      reporting_year: '2024',
      doc_ctrl_num: `D${String(500 - i).padStart(3, '0')}`,
    })),
  ];

  it('characterizes explicit-year request order and per-medium merge', async () => {
    const urls = stubFakeDmap({
      'tri.tri_reporting_form': forms(),
      'tri.tri_release_qty': [
        {
          doc_ctrl_num: 'D500',
          environmental_medium: 'AIR STACK',
          total_release: '12',
          release_na: '0',
        },
      ],
    });
    const releases = await makeService().getTriReleases(
      { facilityId: 'FAC', year: 2024 },
      createMockContext(),
    );
    expect(releases[0]).toMatchObject({ reportingYear: 2024, releasesToAirInLbs: 12 });
    expect(urls[0]).toBe(
      'https://data.epa.gov/dmapservice/tri.tri_reporting_form/tri_facility_id/equals/FAC/and/reporting_year/equals/2024/1:500/json',
    );
  });

  it('sorts capped all-years filings newest-first with a submission tiebreak', async () => {
    const urls = stubFakeDmap({ 'tri.tri_reporting_form': forms(), 'tri.tri_release_qty': [] });
    const releases = await makeService().getTriReleases(
      { facilityId: 'FAC', chemicalName: '1,3-Butadiene' },
      createMockContext(),
    );
    expect(releases).toHaveLength(500);
    expect(releases.every((r) => r.reportingYear === 2024)).toBe(true);
    expect(urls[0]).toContain(
      '/sort/tri.tri_reporting_form.reporting_year:desc,tri.tri_reporting_form.doc_ctrl_num:asc/1:500/json',
    );
    const docs = urls.filter((url) => url.includes('/tri.tri_release_qty/')).flatMap(docInFilter);
    expect(docs[0]).toBe('D001');
    expect(docs.at(-1)).toBe('D500');
    const oldYear = await makeService().getTriReleases(
      { facilityId: 'FAC', year: 1987 },
      createMockContext(),
    );
    expect(oldYear).toHaveLength(1);
    expect(oldYear[0]?.reportingYear).toBe(1987);
  });

  it.each([undefined, 2024])(
    'discloses 500 records with usable guidance on both surfaces, year=%s',
    async (year) => {
      stubFakeDmap({ 'tri.tri_reporting_form': forms(), 'tri.tri_release_qty': [] });
      initDmapService({} as AppConfig, {} as StorageService);
      const original = DmapService.prototype.getTriReleases;
      vi.spyOn(DmapService.prototype, 'getTriReleases').mockImplementation(function (
        this: DmapService,
        params,
        ctx,
      ) {
        ctx.enrich.notice('Existing punctuation-scan notice.');
        return original.call(this, params, ctx);
      });
      const call = await runToolContract(getTriReleasesTool, {
        facility_id: 'FAC',
        ...(year !== undefined && { year }),
      });
      expect(call.isError).toBeFalsy();
      expect(call.structuredContent).toMatchObject({
        truncated: true,
        shown: 500,
        cap: 500,
        notice: 'Existing punctuation-scan notice.',
      });
      const structured = call.structuredContent as { guidance: string };
      expect(structured.guidance).toContain('more may exist');
      expect(structured.guidance).toContain('chemical_name');
      expect(structured.guidance.includes('year')).toBe(year === undefined);
      const text = call.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
      expect(text).toContain(structured.guidance);
      expect(text).toContain('Existing punctuation-scan notice.');
      expect(text).toContain('**truncated:** true');
      expect(text).toContain('**shown:** 500');
      expect(text).toContain('**cap:** 500');
    },
  );

  it('omits cap fields below 500 and retains a successful empty result', async () => {
    stubFakeDmap({ 'tri.tri_reporting_form': [], 'tri.tri_release_qty': [] });
    initDmapService({} as AppConfig, {} as StorageService);
    const call = await runToolContract(getTriReleasesTool, { facility_id: 'FAC' });
    expect(call.isError).toBeFalsy();
    expect(call.structuredContent).toMatchObject({ releases: [], facilityId: 'FAC' });
    for (const key of ['truncated', 'shown', 'cap', 'guidance'])
      expect(call.structuredContent).not.toHaveProperty(key);
    expect(call.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n')).toContain(
      'No TRI releases found',
    );
  });

  it.each([0, 2])(
    'sorts later exact-text pages and stops at exhaustion with %s matches',
    async (count) => {
      const nearVariants = Array.from({ length: 500 }, (_, i) => ({
        tri_facility_id: 'FAC',
        cas_chem_name: '1X3-Butadiene',
        reporting_year: '2024',
        doc_ctrl_num: `V${i}`,
      }));
      const exact = Array.from({ length: count }, (_, i) => ({
        tri_facility_id: 'FAC',
        cas_chem_name: '1,3-Butadiene',
        reporting_year: '2023',
        doc_ctrl_num: `E${i}`,
      }));
      const urls = stubFakeDmap({
        'tri.tri_reporting_form': [...nearVariants, ...exact],
        'tri.tri_release_qty': [],
      });
      const ctx = createMockContext();
      const releases = await makeService().getTriReleases(
        { facilityId: 'FAC', chemicalName: '1,3-Butadiene' },
        ctx,
      );
      expect(releases).toHaveLength(count);
      expect(
        releases.every((r) => r.reportingYear === 2023 && r.chemicalName === '1,3-Butadiene'),
      ).toBe(true);
      const pages = urls.filter((url) => url.includes('/tri.tri_reporting_form/'));
      expect(pages).toHaveLength(2);
      expect(pages[0]).toContain(`${NEWEST_FIRST_SORT}/1:500/json`);
      expect(pages[1]).toContain(`${NEWEST_FIRST_SORT}/501:1000/json`);
      expect(getEnrichment(ctx)).toEqual({});
    },
  );
});

describe('DmapService.getTriReleases per-medium breakdown', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rolls up tri_release_qty into 4 media and joins on doc_ctrl_num', async () => {
    const urls = stubDmapFetch([
      {
        match: '/tri.tri_reporting_form/',
        rows: [
          {
            doc_ctrl_num: 'D1',
            tri_facility_id: 'FAC1',
            cas_chem_name: 'BENZENE',
            reporting_year: '2020',
            one_time_release_qty: 0,
          },
        ],
      },
      {
        match: '/tri.tri_release_qty/',
        rows: [
          {
            doc_ctrl_num: 'D1',
            environmental_medium: 'AIR FUG',
            total_release: 120,
            release_na: '0',
          },
          {
            doc_ctrl_num: 'D1',
            environmental_medium: 'AIR STACK',
            total_release: 100,
            release_na: '0',
          },
          {
            doc_ctrl_num: 'D1',
            environmental_medium: 'WATER',
            total_release: 50,
            release_na: '0',
            water_sequence_num: '1',
          },
          {
            doc_ctrl_num: 'D1',
            environmental_medium: 'RCRA C',
            total_release: 30,
            release_na: '0',
          },
          {
            doc_ctrl_num: 'D1',
            environmental_medium: 'OTH DISP',
            total_release: 5,
            release_na: '0',
          },
          {
            doc_ctrl_num: 'D1',
            environmental_medium: 'UNINJ I',
            total_release: 200,
            release_na: '0',
          },
        ],
      },
    ]);

    const releases = await makeService().getTriReleases(
      { facilityId: 'FAC1' },
      createMockContext(),
    );

    expect(releases).toHaveLength(1);
    const r = releases[0]!;
    expect(r.releasesToAirInLbs).toBe(220); // 120 + 100
    expect(r.releasesToWaterInLbs).toBe(50);
    expect(r.releasesToLandInLbs).toBe(35); // RCRA C 30 + OTH DISP 5
    expect(r.releasesToUndergroundInjectionInLbs).toBe(200);
    // one_time_release_qty stays its own distinct category, untouched by the breakdown.
    expect(r.totalReleasesInLbs).toBe(0);
    // The forms request, then one breakdown request on doc_ctrl_num ranged 30 rows per submission.
    expect(urls).toEqual([
      `https://data.epa.gov/dmapservice/tri.tri_reporting_form/tri_facility_id/equals/FAC1${NEWEST_FIRST_SORT}/1:500/json`,
      'https://data.epa.gov/dmapservice/tri.tri_release_qty/doc_ctrl_num/in/D1/1:30/json',
    ]);
  });

  it('keys each submission independently by doc_ctrl_num (no cross-contamination)', async () => {
    stubDmapFetch([
      {
        match: '/tri.tri_reporting_form/',
        rows: [
          {
            doc_ctrl_num: 'D1',
            tri_facility_id: 'FAC1',
            cas_chem_name: 'BENZENE',
            reporting_year: '2020',
          },
          {
            doc_ctrl_num: 'D2',
            tri_facility_id: 'FAC1',
            cas_chem_name: 'TOLUENE',
            reporting_year: '2020',
          },
        ],
      },
      {
        match: '/tri.tri_release_qty/',
        rows: [
          {
            doc_ctrl_num: 'D1',
            environmental_medium: 'AIR FUG',
            total_release: 10,
            release_na: '0',
          },
          { doc_ctrl_num: 'D2', environmental_medium: 'WATER', total_release: 40, release_na: '0' },
        ],
      },
    ]);

    const releases = await makeService().getTriReleases(
      { facilityId: 'FAC1' },
      createMockContext(),
    );

    const benzene = releases.find((x) => x.chemicalName === 'BENZENE')!;
    const toluene = releases.find((x) => x.chemicalName === 'TOLUENE')!;
    expect(benzene.releasesToAirInLbs).toBe(10);
    expect(benzene.releasesToWaterInLbs).toBeUndefined();
    expect(toluene.releasesToWaterInLbs).toBe(40);
    expect(toluene.releasesToAirInLbs).toBeUndefined();
  });

  it('preserves sparsity — release_na and range-coded rows never fabricate a 0', async () => {
    stubDmapFetch([
      {
        match: '/tri.tri_reporting_form/',
        rows: [
          {
            doc_ctrl_num: 'D3',
            tri_facility_id: 'FAC2',
            cas_chem_name: 'LEAD',
            reporting_year: '2019',
          },
        ],
      },
      {
        match: '/tri.tri_release_qty/',
        rows: [
          {
            doc_ctrl_num: 'D3',
            environmental_medium: 'AIR FUG',
            total_release: 75,
            release_na: '0',
          },
          // Not applicable to this submission — the 0 it carries must not surface as a release.
          {
            doc_ctrl_num: 'D3',
            environmental_medium: 'UNINJ I',
            total_release: 0,
            release_na: '1',
          },
          // A code outside the on-site release taxonomy (a non-release sub-metric) adds nothing.
          {
            doc_ctrl_num: 'D3',
            environmental_medium: 'SI 5.5.3A',
            total_release: 8,
            release_na: '0',
          },
          // Reported as a coarse range band, not a hard number — must not become 0.
          {
            doc_ctrl_num: 'D3',
            environmental_medium: 'WATER',
            total_release: null,
            release_range_code: '1',
            release_na: '0',
          },
        ],
      },
    ]);

    const releases = await makeService().getTriReleases(
      { facilityId: 'FAC2' },
      createMockContext(),
    );

    // Only the hard AIR FUG quantity lands; no other field, zero or otherwise, is added.
    expect(releases).toEqual([
      { facilityId: 'FAC2', chemicalName: 'LEAD', reportingYear: 2019, releasesToAirInLbs: 75 },
    ]);
  });

  it('rounds each per-medium sum so binary-float noise never reaches the output', async () => {
    const qty = (environmental_medium: string, total_release: number) => ({
      doc_ctrl_num: 'D4',
      environmental_medium,
      total_release,
      release_na: '0',
    });
    stubDmapFetch([
      {
        match: '/tri.tri_reporting_form/',
        rows: [{ doc_ctrl_num: 'D4', tri_facility_id: 'FAC3', cas_chem_name: 'MERCURY' }],
      },
      {
        match: '/tri.tri_release_qty/',
        rows: [
          qty('AIR FUG', 0.000894),
          qty('AIR STACK', 0.000014),
          qty('LAND TREA', 0.1),
          qty('OTH LANDF', 0.2),
          qty('WATER', 12345.678),
          qty('UNINJ I', 1e-7),
        ],
      },
    ]);

    const [r] = await makeService().getTriReleases({ facilityId: 'FAC3' }, createMockContext());

    // Unrounded: 0.0009080000000000001 and 0.30000000000000004.
    expect(r!.releasesToAirInLbs).toBe(0.000908);
    expect(r!.releasesToLandInLbs).toBe(0.3);
    expect(r!.releasesToWaterInLbs).toBe(12345.678);
    expect(r!.releasesToUndergroundInjectionInLbs).toBe(1e-7);
  });
});

/**
 * Facility 96020CLLNS500MA, reporting year 2022, captured live from DMAP (2026-10-08). The N150
 * form (dioxin and dioxin-like compounds) reports in grams; the N420 form (lead compounds) in
 * pounds. Neither tri_reporting_form nor tri_release_qty carries a unit column — tri_chem_id is
 * the only marker.
 */
const DIOXIN_FACILITY_FORMS = [
  {
    doc_ctrl_num: '1322220762153',
    tri_facility_id: '96020CLLNS500MA',
    tri_chem_id: 'N420',
    cas_chem_name: 'Lead compounds',
    reporting_year: 2022,
    one_time_release_qty: null,
  },
  {
    doc_ctrl_num: '1322220762367',
    tri_facility_id: '96020CLLNS500MA',
    tri_chem_id: 'N150',
    cas_chem_name: 'Dioxin and dioxin-like compounds',
    reporting_year: 2022,
    one_time_release_qty: 2,
  },
];
const DIOXIN_FACILITY_RELEASE_QTY = [
  ['1322220762367', 'LAND TREA', 0.0005809],
  ['1322220762367', 'AIR STACK', 0.073914],
  ['1322220762153', 'LAND TREA', 26.3],
  ['1322220762153', 'AIR STACK', 2.21],
].map(([doc, medium, total]) => ({
  doc_ctrl_num: doc,
  environmental_medium: medium,
  total_release: total,
  release_na: '0',
  release_range_code: null,
}));

describe('DmapService TRI dioxin quantities (reported in grams)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getTriReleases converts an N150 form from grams to pounds and marks the unit', async () => {
    stubDmapFetch([
      { match: '/tri.tri_reporting_form/', rows: DIOXIN_FACILITY_FORMS },
      { match: '/tri.tri_release_qty/', rows: DIOXIN_FACILITY_RELEASE_QTY },
    ]);

    const [lead, dioxin] = await makeService().getTriReleases(
      { facilityId: '96020CLLNS500MA', year: 2022 },
      createMockContext(),
    );

    // 1 lb = 453.59237 g, rounded to 12 significant digits.
    expect(dioxin).toEqual({
      facilityId: '96020CLLNS500MA',
      chemicalName: 'Dioxin and dioxin-like compounds',
      reportingYear: 2022,
      reportedUnit: 'grams',
      totalReleasesInLbs: 0.0044092452437,
      releasesToAirInLbs: 0.000162952476471,
      releasesToLandInLbs: 1.28066528103e-6,
    });
    // Pound-reported chemicals pass through unconverted and unmarked.
    expect(lead).toEqual({
      facilityId: '96020CLLNS500MA',
      chemicalName: 'Lead compounds',
      reportingYear: 2022,
      releasesToAirInLbs: 2.21,
      releasesToLandInLbs: 26.3,
    });
  });

  it('marks an N150 form with no quantities without fabricating any', async () => {
    stubDmapFetch([
      {
        match: '/tri.tri_reporting_form/',
        rows: [{ ...DIOXIN_FACILITY_FORMS[1], one_time_release_qty: null }],
      },
      { match: '/tri.tri_release_qty/', rows: [] },
    ]);

    const [dioxin] = await makeService().getTriReleases(
      { facilityId: '96020CLLNS500MA' },
      createMockContext(),
    );

    expect(dioxin).toEqual({
      facilityId: '96020CLLNS500MA',
      chemicalName: 'Dioxin and dioxin-like compounds',
      reportingYear: 2022,
      reportedUnit: 'grams',
    });
  });

  it('searchTriReleases converts N150 records with and without the breakdown', async () => {
    const tables = {
      'tri.tri_facility': [triFacility('96020CLLNS500MA', 'COLLINS PINE CO', 'CA', 'PLUMAS')],
      'tri.tri_reporting_form': DIOXIN_FACILITY_FORMS,
      'tri.tri_release_qty': DIOXIN_FACILITY_RELEASE_QTY,
    };

    stubFakeDmap(tables);
    const withBreakdown = await makeService().searchTriReleases(
      { state: 'CA', county: 'PLUMAS', year: 2022, limit: 5, includeReleaseBreakdown: true },
      createMockContext(),
    );
    vi.restoreAllMocks();
    stubFakeDmap(tables);
    const withoutBreakdown = await makeService().searchTriReleases(
      { state: 'CA', county: 'PLUMAS', year: 2022, limit: 5 },
      createMockContext(),
    );

    expect(withBreakdown[1]).toMatchObject({
      reportedUnit: 'grams',
      totalReleasesInLbs: 0.0044092452437,
      releasesToAirInLbs: 0.000162952476471,
      releasesToLandInLbs: 1.28066528103e-6,
    });
    expect(withBreakdown[0]).toMatchObject({ releasesToAirInLbs: 2.21, releasesToLandInLbs: 26.3 });
    expect(withBreakdown[0]).not.toHaveProperty('reportedUnit');
    expect(withoutBreakdown[1]).toEqual({
      facilityId: '96020CLLNS500MA',
      facilityName: 'COLLINS PINE CO',
      countyName: 'PLUMAS',
      chemicalName: 'Dioxin and dioxin-like compounds',
      reportingYear: 2022,
      reportedUnit: 'grams',
      totalReleasesInLbs: 0.0044092452437,
    });
  });
});

/**
 * tri.tri_release_qty rows captured live from DMAP (OR, reporting year 2022, 2026-10-08), trimmed
 * to the columns the rollup reads. 1322220659559 mixes a hard AIR STACK quantity with a range-coded
 * AIR FUG row and release_na rows (including the unmapped "SI 5.5.3*" codes); 1322220789794 is
 * release_na on every medium; 1322221249042 reports hard zeros; 1322220687305 has no rows at all.
 */
const OR_2022_RELEASE_QTY = [
  ['1322220659559', 'AIR STACK', 17.123, '0', null],
  ['1322220659559', 'AIR FUG', null, '0', '1'],
  ['1322220659559', 'OTH DISP', null, '1', null],
  ['1322220659559', 'SI 5.5.3B', null, '1', null],
  ['1322220659559', 'UNINJ I', null, '1', null],
  ['1322220659559', 'WATER', null, '1', null],
  ['1322220789794', 'AIR STACK', null, '1', null],
  ['1322220789794', 'AIR FUG', null, '1', null],
  ['1322220789794', 'SI 5.5.3A', null, '1', null],
  ['1322220789794', 'WATER', null, '1', null],
  ['1322221249042', 'AIR FUG', 0, '0', null],
  ['1322221249042', 'AIR STACK', 0, '0', null],
  ['1322221249042', 'RCRA C', null, '1', null],
].map(([doc, medium, total, na, range]) => ({
  doc_ctrl_num: doc,
  environmental_medium: medium,
  total_release: total,
  release_na: na,
  release_range_code: range,
}));

describe('DmapService.searchTriReleases per-medium breakdown', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('merges the per-medium rollup into each kept record, preserving sparsity', async () => {
    const urls = stubFakeDmap({
      'tri.tri_facility': [
        triFacility('97321RCNPC3009S', 'FACILITY A', 'OR', 'LINN'),
        triFacility('97487MRCDS2500W', 'FACILITY B', 'OR', 'DOUGLAS'),
      ],
      'tri.tri_reporting_form': [
        {
          doc_ctrl_num: '1322220659559',
          tri_facility_id: '97321RCNPC3009S',
          cas_chem_name: 'Lead compounds',
          reporting_year: '2022',
          one_time_release_qty: 4,
        },
        {
          doc_ctrl_num: '1322220789794',
          tri_facility_id: '97321RCNPC3009S',
          cas_chem_name: 'Zinc compounds',
          reporting_year: '2022',
        },
        {
          doc_ctrl_num: '1322221249042',
          tri_facility_id: '97487MRCDS2500W',
          cas_chem_name: 'Methanol',
          reporting_year: '2022',
        },
        {
          doc_ctrl_num: '1322220687305',
          tri_facility_id: '97487MRCDS2500W',
          cas_chem_name: 'Ammonia',
          reporting_year: '2022',
        },
      ],
      'tri.tri_release_qty': OR_2022_RELEASE_QTY,
    });

    const releases = await makeService().searchTriReleases(
      { state: 'OR', year: 2022, limit: 10, includeReleaseBreakdown: true },
      createMockContext(),
    );

    expect(releases).toEqual([
      {
        facilityId: '97321RCNPC3009S',
        facilityName: 'FACILITY A',
        countyName: 'LINN',
        chemicalName: 'Lead compounds',
        reportingYear: 2022,
        // one_time_release_qty keeps its own value — never summed with the routine media.
        totalReleasesInLbs: 4,
        // AIR STACK 17.123; the range-coded AIR FUG row adds nothing.
        releasesToAirInLbs: 17.123,
      },
      // Every medium release_na — none of the four fields, no fabricated 0.
      {
        facilityId: '97321RCNPC3009S',
        facilityName: 'FACILITY A',
        countyName: 'LINN',
        chemicalName: 'Zinc compounds',
        reportingYear: 2022,
      },
      // Reported hard zeros stay zeros.
      {
        facilityId: '97487MRCDS2500W',
        facilityName: 'FACILITY B',
        countyName: 'DOUGLAS',
        chemicalName: 'Methanol',
        reportingYear: 2022,
        releasesToAirInLbs: 0,
      },
      // No tri_release_qty rows at all — none of the four fields.
      {
        facilityId: '97487MRCDS2500W',
        facilityName: 'FACILITY B',
        countyName: 'DOUGLAS',
        chemicalName: 'Ammonia',
        reportingYear: 2022,
      },
    ]);

    const breakdownUrls = urls.filter((u) => u.includes('/tri.tri_release_qty/'));
    expect(breakdownUrls).toHaveLength(1);
    expect(breakdownUrls[0]).toContain(
      '/doc_ctrl_num/in/1322220659559%2C1322220789794%2C1322221249042%2C1322220687305/',
    );
    // The search request, then the one breakdown request after it.
    expect(urls).toHaveLength(2);
    expect(urls[1]).toBe(breakdownUrls[0]);
  });

  /** 51 WA facilities; the first and the last filed a form, every other one filed nothing. */
  const firstAndLast = {
    'tri.tri_facility': [
      ...Array.from({ length: 50 }, (_, index) =>
        triFacility(`FAC${String(index).padStart(3, '0')}`, `Facility ${index}`, 'WA', 'KING'),
      ),
      triFacility('LATE1', 'Late Match', 'WA', 'KING'),
    ],
    'tri.tri_reporting_form': [
      { ...triForm('EARLY', 'FAC000', 'Benzene', 2022), one_time_release_qty: 7 },
      triForm('LATE', 'LATE1', 'Toluene', 2022),
    ],
    'tri.tri_release_qty': [
      { doc_ctrl_num: 'EARLY', environmental_medium: 'WATER', total_release: 12, release_na: '0' },
      { doc_ctrl_num: 'LATE', environmental_medium: 'UNINJ I', total_release: 9, release_na: '0' },
      {
        doc_ctrl_num: 'LATE',
        environmental_medium: 'LANDF8795',
        total_release: 3,
        release_na: '0',
      },
    ],
  };

  it('makes exactly one breakdown request for matches anywhere in the state', async () => {
    const urls = stubFakeDmap(firstAndLast);

    const releases = await makeService().searchTriReleases(
      { state: 'WA', limit: 5, includeReleaseBreakdown: true },
      createMockContext(),
    );

    expect(releases).toEqual([
      expect.objectContaining({ facilityId: 'FAC000', releasesToWaterInLbs: 12 }),
      expect.objectContaining({
        facilityId: 'LATE1',
        releasesToUndergroundInjectionInLbs: 9,
        releasesToLandInLbs: 3,
      }),
    ]);
    expect(urls).toHaveLength(2);
    const breakdownUrls = urls.filter((u) => u.includes('/tri.tri_release_qty/'));
    expect(breakdownUrls).toHaveLength(1);
    expect(breakdownUrls[0]).toContain('/doc_ctrl_num/in/EARLY%2CLATE/');
  });

  it('requests the breakdown only for the records the limit keeps', async () => {
    const urls = stubFakeDmap({
      'tri.tri_facility': [triFacility('FAC1', 'ACME', 'WA', 'KING')],
      'tri.tri_reporting_form': [
        triForm('KEEP1', 'FAC1', 'Benzene', 2022),
        triForm('KEEP2', 'FAC1', 'Toluene', 2022),
        // Older than the two kept forms, so the newest-first sort puts it past the limit.
        triForm('DROP3', 'FAC1', 'Xylene', 2021),
      ],
      'tri.tri_release_qty': [],
    });

    const releases = await makeService().searchTriReleases(
      { state: 'WA', limit: 2, includeReleaseBreakdown: true },
      createMockContext(),
    );

    expect(releases.map((r) => r.chemicalName)).toEqual(['Benzene', 'Toluene']);
    const breakdownUrl = urls.find((u) => u.includes('/tri.tri_release_qty/'));
    expect(breakdownUrl).toContain('/doc_ctrl_num/in/KEEP1%2CKEEP2/');
    expect(breakdownUrl).not.toContain('DROP3');
  });

  it('skips the breakdown request when the search keeps no records', async () => {
    const urls = stubFakeDmap({
      'tri.tri_facility': [triFacility('FAC1', 'ACME', 'WA', 'KING')],
      'tri.tri_reporting_form': [triForm('D2022', 'FAC1', 'Benzene', 2022)],
    });

    const releases = await makeService().searchTriReleases(
      { state: 'WA', year: 1990, includeReleaseBreakdown: true },
      createMockContext(),
    );

    expect(releases).toEqual([]);
    expect(urls).toHaveLength(1);
  });

  it.each([
    ['omitted', {}],
    ['false', { includeReleaseBreakdown: false }],
  ])('makes no breakdown request and carries no media when the flag is %s', async (_, flag) => {
    const urls = stubFakeDmap(firstAndLast);

    const releases = await makeService().searchTriReleases(
      { state: 'WA', limit: 5, ...flag },
      createMockContext(),
    );

    // Both matches kept, the one-time quantity kept, no medium field on any record.
    expect(releases).toEqual([
      {
        facilityId: 'FAC000',
        facilityName: 'Facility 0',
        countyName: 'KING',
        chemicalName: 'Benzene',
        reportingYear: 2022,
        totalReleasesInLbs: 7,
      },
      {
        facilityId: 'LATE1',
        facilityName: 'Late Match',
        countyName: 'KING',
        chemicalName: 'Toluene',
        reportingYear: 2022,
      },
    ]);
    expect(urls).toHaveLength(1);
  });
});

describe('DmapService.searchTriReleases request shape', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const joinPath = '/join/tri.tri_reporting_form/tri_facility_id/equals/tri_facility_id';

  it('joins the forms to the state facilities in one request ranged 1:limit', async () => {
    const urls = stubFakeDmap({
      'tri.tri_facility': [
        triFacility('FAC1', 'ACME', 'WA', 'KING'),
        triFacility('FAC2', 'BETA', 'WA', 'KING'),
      ],
      'tri.tri_reporting_form': [
        triForm('D1', 'FAC1', 'Benzene', 2023),
        triForm('D2', 'FAC2', 'Toluene', 2023),
      ],
    });

    const releases = await makeService().searchTriReleases(
      { state: 'WA', limit: 1 },
      createMockContext(),
    );

    expect(releases.map((r) => r.facilityId)).toEqual(['FAC1']);
    expect(urls).toEqual([
      `https://data.epa.gov/dmapservice/tri.tri_facility/state_abbr/equals/WA${joinPath}${NEWEST_FIRST_SORT}/1:1/json`,
    ]);
  });

  it('defaults to 50 joined rows', async () => {
    const urls = stubFakeDmap({ 'tri.tri_facility': [], 'tri.tri_reporting_form': [] });

    await makeService().searchTriReleases({ state: 'WA' }, createMockContext());

    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/\/1:50\/json$/);
  });

  it('filters facilities on county_name before the join and forms on year and chemical after it', async () => {
    const urls = stubFakeDmap({
      'tri.tri_facility': [
        triFacility('98001PRMSB1234X', 'PRIMUS AUBURN', 'WA', 'KING'),
        triFacility('98402PIERC', 'PIERCE PLANT', 'WA', 'PIERCE'),
      ],
      'tri.tri_reporting_form': [
        triForm('K1', '98001PRMSB1234X', 'Chromium', 2023),
        triForm('P1', '98402PIERC', 'Chromium', 2023),
      ],
    });

    const releases = await makeService().searchTriReleases(
      { state: 'WA', county: 'KING', year: 2023, chemicalName: 'chromium compounds', limit: 5 },
      createMockContext(),
    );

    expect(releases).toEqual([]);
    expect(urls).toEqual([
      `https://data.epa.gov/dmapservice/tri.tri_facility/state_abbr/equals/WA/and/county_name/contains/KING${joinPath}/and/reporting_year/equals/2023/and/cas_chem_name/contains/chromium%20compounds/1:5/json`,
    ]);
  });

  it('encodes a multi-word county and returns nothing when no facility matches', async () => {
    const urls = stubFakeDmap({
      'tri.tri_facility': [triFacility('99701FRBNK', 'FAIRBANKS PLANT', 'AK', 'NORTH SLOPE')],
      'tri.tri_reporting_form': [triForm('F1', '99701FRBNK', 'Lead', 2022)],
    });

    const releases = await makeService().searchTriReleases(
      { state: 'AK', county: 'FAIRBANKS NORTH STAR' },
      createMockContext(),
    );

    expect(releases).toEqual([]);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`/county_name/contains/FAIRBANKS%20NORTH%20STAR${joinPath}/`);
  });
});

/** A tri.tri_facility row. */
function triFacility(id: string, name: string, state: string, county: string): DmapRow {
  return { tri_facility_id: id, facility_name: name, state_abbr: state, county_name: county };
}

/** A tri.tri_reporting_form row. */
function triForm(doc: string, facilityId: string, chemical: string, year: number): DmapRow {
  return {
    doc_ctrl_num: doc,
    tri_facility_id: facilityId,
    cas_chem_name: chemical,
    reporting_year: String(year),
    tri_chem_id: 'X',
  };
}

/**
 * A state with `count` facilities in which only the last one filed a 2022 form — every earlier
 * facility filed in 2019 — the shape of a sparse year filter in a large state.
 */
function sparseState(count: number): Record<string, DmapRow[]> {
  const facilities = Array.from({ length: count }, (_, n) =>
    triFacility(`TX${String(n).padStart(5, '0')}`, `PLANT ${n}`, 'TX', 'HARRIS'),
  );
  const forms = facilities.map((facility, n) =>
    triForm(
      `DOC${n}`,
      facility.tri_facility_id as string,
      'Benzene',
      n === count - 1 ? 2022 : 2019,
    ),
  );
  return {
    'tri.tri_facility': facilities,
    'tri.tri_reporting_form': forms,
    'tri.tri_release_qty': [
      {
        doc_ctrl_num: `DOC${count - 1}`,
        environmental_medium: 'AIR STACK',
        total_release: 5,
        release_na: '0',
      },
    ],
  };
}

describe('DmapService.searchTriReleases against DMAP semantics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const tables = {
    'tri.tri_facility': [
      triFacility('98001KINGA', 'KING ALPHA', 'WA', 'KING'),
      triFacility('98402PIERC', 'PIERCE PLANT', 'WA', 'PIERCE'),
      triFacility('98002KINGB', 'KING BETA', 'WA', 'KING'),
      triFacility('97201PORTL', 'PORTLAND PLANT', 'OR', 'MULTNOMAH'),
    ],
    'tri.tri_reporting_form': [
      triForm('A1', '98001KINGA', 'Lead', 2022),
      triForm('A2', '98001KINGA', 'Lead compounds', 2021),
      triForm('A3', '98001KINGA', 'Toluene', 2022),
      triForm('P1', '98402PIERC', 'Lead', 2022),
      triForm('B1', '98002KINGB', 'Lead compounds', 2022),
      triForm('O1', '97201PORTL', 'Lead', 2022),
    ],
  };

  it('returns each matching form with its facility name, honoring county, year, and chemical', async () => {
    stubFakeDmap(tables);

    const releases = await makeService().searchTriReleases(
      { state: 'WA', county: 'KING', year: 2022, chemicalName: 'lead', limit: 10 },
      createMockContext(),
    );

    expect(releases).toEqual([
      {
        facilityId: '98001KINGA',
        facilityName: 'KING ALPHA',
        countyName: 'KING',
        chemicalName: 'Lead',
        reportingYear: 2022,
      },
      {
        facilityId: '98002KINGB',
        facilityName: 'KING BETA',
        countyName: 'KING',
        chemicalName: 'Lead compounds',
        reportingYear: 2022,
      },
    ]);
  });

  it('caps the records at limit, newest reporting year first', async () => {
    stubFakeDmap(tables);

    const releases = await makeService().searchTriReleases(
      { state: 'WA', limit: 3 },
      createMockContext(),
    );

    // The 2021 form precedes two of these in table order; the sort moves it past the limit.
    expect(releases.map((r) => `${r.facilityId}/${r.chemicalName}/${r.reportingYear}`)).toEqual([
      '98001KINGA/Lead/2022',
      '98001KINGA/Toluene/2022',
      '98002KINGB/Lead compounds/2022',
    ]);
  });

  it('returns nothing when no facility in the state filed a matching form', async () => {
    stubFakeDmap(tables);

    const releases = await makeService().searchTriReleases(
      { state: 'WA', year: 1990, limit: 10 },
      createMockContext(),
    );

    expect(releases).toEqual([]);
  });

  it('finds matches spread across more than one 50-facility stretch of the state', async () => {
    const facilities = Array.from({ length: 120 }, (_, n) =>
      triFacility(`WA${String(n).padStart(3, '0')}`, `PLANT ${n}`, 'WA', 'KING'),
    );
    stubFakeDmap({
      'tri.tri_facility': facilities,
      'tri.tri_reporting_form': [
        triForm('FIRST', 'WA000', 'Benzene', 2022),
        triForm('LAST', 'WA119', 'Benzene', 2022),
      ],
    });

    const releases = await makeService().searchTriReleases(
      { state: 'WA', year: 2022, limit: 5 },
      createMockContext(),
    );

    expect(releases.map((r) => r.facilityName)).toEqual(['PLANT 0', 'PLANT 119']);
  });

  it('rejects with the cancellation when the caller aborts mid-request', async () => {
    const controller = new AbortController();
    stubFakeDmap(sparseState(200), abortWhileInFlight(controller));

    const search = makeService().searchTriReleases(
      { state: 'TX', year: 2022, limit: 200 },
      createMockContext({ signal: controller.signal }),
    );

    await expect(search).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('finds a sparse match in a large state with one request, however many facilities precede it', async () => {
    const urls = stubFakeDmap(sparseState(2000));

    const releases = await makeService().searchTriReleases(
      { state: 'TX', year: 2022, limit: 200 },
      createMockContext(),
    );

    expect(releases).toEqual([
      {
        facilityId: 'TX01999',
        facilityName: 'PLANT 1999',
        countyName: 'HARRIS',
        chemicalName: 'Benzene',
        reportingYear: 2022,
      },
    ]);
    expect(urls).toHaveLength(1);
  });

  it('labels each record with its own county when a short county name also matches a longer one', async () => {
    // county_name `contains` LAKE also matches LAKE OF THE WOODS (live: MN, "Lake County", 2022).
    initDmapService({} as AppConfig, {} as StorageService);
    stubFakeDmap({
      'tri.tri_facility': [
        triFacility('55616LPTWO', 'TWO HARBORS SIDING', 'MN', 'LAKE'),
        triFacility('56623BDTMI', 'BAUDETTE MILL', 'MN', 'LAKE OF THE WOODS'),
        triFacility('55604GRMRA', 'GRAND MARAIS PLANT', 'MN', 'COOK'),
      ],
      'tri.tri_reporting_form': [
        triForm('L1', '55616LPTWO', 'Formaldehyde', 2022),
        triForm('W1', '56623BDTMI', 'Methanol', 2022),
        triForm('C1', '55604GRMRA', 'Lead', 2022),
      ],
    });

    const call = await runToolContract(searchTriReleasesTool, {
      state: 'MN',
      county: 'Lake County',
      year: 2022,
    });

    expect(call.isError).toBeFalsy();
    const structured = call.structuredContent as { releases: Array<Record<string, unknown>> };
    expect(structured.releases).toEqual([
      {
        facilityId: '55616LPTWO',
        facilityName: 'TWO HARBORS SIDING',
        countyName: 'LAKE',
        chemicalName: 'Formaldehyde',
        reportingYear: 2022,
      },
      {
        facilityId: '56623BDTMI',
        facilityName: 'BAUDETTE MILL',
        countyName: 'LAKE OF THE WOODS',
        chemicalName: 'Methanol',
        reportingYear: 2022,
      },
    ]);
    const text = call.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    const sections = text.split('\n### ').slice(1);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toContain('TWO HARBORS SIDING (55616LPTWO)');
    expect(sections[0]).toMatch(/^\*\*County:\*\* LAKE$/m);
    expect(sections[0]).not.toContain('LAKE OF THE WOODS');
    expect(sections[1]).toContain('BAUDETTE MILL (56623BDTMI)');
    expect(sections[1]).toMatch(/^\*\*County:\*\* LAKE OF THE WOODS$/m);
  });

  it('adds the breakdown to a sparse search with exactly one more request', async () => {
    const urls = stubFakeDmap(sparseState(2000));

    const releases = await makeService().searchTriReleases(
      { state: 'TX', year: 2022, limit: 200, includeReleaseBreakdown: true },
      createMockContext(),
    );

    expect(releases).toEqual([expect.objectContaining({ releasesToAirInLbs: 5 })]);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('/tri.tri_release_qty/doc_ctrl_num/in/DOC1999/');
  });
});

describe('DmapService.searchWaterSystems pagination', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses DMAP one-based ranges and bounds returned systems when limit is one', async () => {
    const urls = stubDmapFetch([
      {
        match: '/sdwis.water_system/',
        rows: [
          { pwsid: 'WA0000001', pws_name: 'First Water System' },
          { pwsid: 'WA0000002', pws_name: 'Second Water System' },
        ],
      },
    ]);

    const systems = await makeService().searchWaterSystems(
      { state: 'WA', limit: 1 },
      createMockContext(),
    );

    expect(systems).toEqual([{ pwsid: 'WA0000001', name: 'First Water System' }]);
    expect(urls).toEqual([
      'https://data.epa.gov/dmapservice/sdwis.water_system/primacy_agency_code/equals/WA/1:1/json',
    ]);
  });
});

/** WA-style PWSID for violator number `n` (1-based). */
const pwsidOf = (n: number) => `WA${String(n).padStart(7, '0')}`;

/** IDs a `sdwis.water_system` URL restricts on through its `pwsid/in/<ids>` filter. */
function pwsidInFilter(url: string): string[] | undefined {
  const match = /\/pwsid\/in\/([^/]+)\//.exec(url);
  return match ? decodeURIComponent(match[1]!).split(',') : undefined;
}

/** Status codes a `sdwis.violation` URL restricts on through `compliance_status_code/in/<codes>`. */
function statusInFilter(url: string): string[] | undefined {
  const match = /\/compliance_status_code\/in\/([^/]+)\//.exec(url);
  return match ? decodeURIComponent(match[1]!).split(',') : undefined;
}

/**
 * Serve sdwis.violation and sdwis.water_system the way DMAP filters them: only the rows the URL's
 * `pwsid in` list names (when it has one) and, for violations, the `compliance_status_code in`
 * list (a fixture row without a code is an open "O" violation), then the `first:last` range.
 */
function stubSdwisFetch(
  violations: Array<{ pwsid: string; [column: string]: unknown }>,
  systems: Array<{ pwsid: string; [column: string]: unknown }>,
): string[] {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    urls.push(url);
    let table: unknown[];
    if (url.includes('/sdwis.violation/')) {
      const ids = pwsidInFilter(url);
      const codes = statusInFilter(url);
      table = violations.filter(
        (v) =>
          (!ids || ids.includes(v.pwsid)) &&
          (!codes || codes.includes(String(v.compliance_status_code ?? 'O'))),
      );
    } else if (url.includes('/sdwis.water_system/')) {
      const ids = pwsidInFilter(url);
      table = ids ? systems.filter((s) => ids.includes(s.pwsid)) : systems;
    } else {
      return Promise.reject(validationError(`Unmocked DMAP fetch: ${url}`, { retryable: false }));
    }
    return Promise.resolve(new Response(JSON.stringify(dmapPage(url, table)), { status: 200 }));
  });
  return urls;
}

describe('DmapService.searchWaterSystems violation filter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Two violation rows per violator, so distinct PWSIDs are half the scanned rows. */
  const violationRows = (violators: number) =>
    Array.from({ length: violators * 2 }, (_, i) => ({ pwsid: pwsidOf(Math.floor(i / 2) + 1) }));
  const systemsFor = (violators: number) =>
    Array.from({ length: violators }, (_, i) => ({
      pwsid: pwsidOf(i + 1),
      pws_name: `System ${i + 1}`,
    }));

  it('returns violators past the first 100 the violation scan found', async () => {
    const urls = stubSdwisFetch(violationRows(150), systemsFor(150));
    const ctx = createMockContext();

    const systems = await makeService().searchWaterSystems(
      { state: 'WA', hasViolation: true, limit: 200 },
      ctx,
    );

    expect(systems).toHaveLength(150);
    expect(systems.at(-1)).toEqual(
      expect.objectContaining({ pwsid: pwsidOf(150), hasViolation: true }),
    );
    expect(systems.every((s) => s.hasViolation === true)).toBe(true);
    // 300 violation rows is below the 1,000-row scan, so nothing is disclosed.
    expect(getEnrichment(ctx)).not.toHaveProperty('notice');
    expect(urls.filter((u) => u.includes('/sdwis.water_system/'))).toHaveLength(1);
  });

  it('stops requesting systems once the limit is filled', async () => {
    const urls = stubSdwisFetch(violationRows(450), systemsFor(450));

    const systems = await makeService().searchWaterSystems(
      { state: 'WA', hasViolation: true, limit: 50 },
      createMockContext(),
    );

    expect(systems.map((s) => s.pwsid)).toEqual(
      Array.from({ length: 50 }, (_, i) => pwsidOf(i + 1)),
    );
    const systemUrls = urls.filter((u) => u.includes('/sdwis.water_system/'));
    expect(systemUrls).toHaveLength(1);
    expect(systemUrls[0]).toContain('/1:50/json');
  });

  it('walks every chunk of at most 200 IDs when the filters thin the matches', async () => {
    const violations = Array.from({ length: 1000 }, (_, i) => ({ pwsid: pwsidOf(i + 1) }));
    // Only three violators are community systems; they sit in the first, third, and last chunk.
    const communityViolators = [5, 450, 1000].map((n) => ({
      pwsid: pwsidOf(n),
      pws_name: `Community ${n}`,
      pws_type_code: 'CWS',
    }));
    const urls = stubSdwisFetch(violations, communityViolators);

    const systems = await makeService().searchWaterSystems(
      { state: 'WA', hasViolation: true, pwsType: 'community', limit: 10 },
      createMockContext(),
    );

    expect(systems.map((s) => s.pwsid)).toEqual([pwsidOf(5), pwsidOf(450), pwsidOf(1000)]);
    const systemUrls = urls.filter((u) => u.includes('/sdwis.water_system/'));
    expect(systemUrls).toHaveLength(5);
    const chunks = systemUrls.map((u) => pwsidInFilter(u) ?? []);
    expect(chunks.every((ids) => ids.length <= 200)).toBe(true);
    expect(new Set(chunks.flat()).size).toBe(1000);
    expect(systemUrls.every((u) => u.includes('/pws_type_code/equals/CWS/'))).toBe(true);
    // Each chunk asks only for the rows the limit still has room for.
    expect(systemUrls.map((u) => /\/(\d+:\d+)\/json$/.exec(u)?.[1])).toEqual([
      '1:10',
      '1:9',
      '1:9',
      '1:8',
      '1:8',
    ]);
  });

  it('discloses that a scan reaching its 1,000-row cap may miss violators', async () => {
    // 1,000 rows naming 500 distinct systems — the state has more violation records than were read.
    const urls = stubSdwisFetch(violationRows(500), systemsFor(500));
    const ctx = createMockContext();

    const systems = await makeService().searchWaterSystems(
      { state: 'WA', hasViolation: true, limit: 5 },
      ctx,
    );

    expect(systems).toHaveLength(5);
    expect(urls.find((u) => u.includes('/sdwis.violation/'))).toContain('/1:1000/json');
    const { notice } = getEnrichment(ctx) as { notice?: string };
    expect(notice).toBe(
      "The violation check stopped at the first 1,000 of WA's open SDWIS violation records, which name 500 distinct systems. Records past that point were not read, so these results may not include every system with an open violation in the state.",
    );
  });

  it('returns nothing after walking every chunk when no violator matches the filters', async () => {
    const urls = stubSdwisFetch(violationRows(250), []);

    const systems = await makeService().searchWaterSystems(
      { state: 'WA', hasViolation: true, pwsType: 'transient', limit: 200 },
      createMockContext(),
    );

    expect(systems).toEqual([]);
    expect(urls.filter((u) => u.includes('/sdwis.water_system/'))).toHaveLength(2);
  });

  it('makes no system request when the scan finds no violators', async () => {
    const urls = stubSdwisFetch([], systemsFor(3));

    const systems = await makeService().searchWaterSystems(
      { state: 'WA', hasViolation: true, limit: 5 },
      createMockContext(),
    );

    expect(systems).toEqual([]);
    expect(urls).toHaveLength(1);
  });
});

describe('DmapService.searchWaterSystems violation filter on a ZIP', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** `count` systems in one ZIP, numbered from 1. */
  const zipSystems = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      pwsid: pwsidOf(i + 1),
      pws_name: `System ${i + 1}`,
      zip_code: '98104',
    }));
  const violationUrls = (urls: string[]) => urls.filter((u) => u.includes('/sdwis.violation/'));
  const systemUrls = (urls: string[]) => urls.filter((u) => u.includes('/sdwis.water_system/'));

  it('without has_violation makes one ZIP request and flags nothing', async () => {
    const urls = stubSdwisFetch([{ pwsid: pwsidOf(2) }], zipSystems(3));

    const systems = await makeService().searchWaterSystems(
      { zipCode: '98104', limit: 50 },
      createMockContext(),
    );

    expect(systems.map((s) => s.pwsid)).toEqual([pwsidOf(1), pwsidOf(2), pwsidOf(3)]);
    expect(systems.every((s) => s.hasViolation === undefined)).toBe(true);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/sdwis.water_system/zip_code/equals/98104/1:50/json');
  });

  it('returns only the ZIP systems with a violation, checked by PWSID', async () => {
    // WA0000099 is a violator outside the ZIP; it must not appear.
    const urls = stubSdwisFetch(
      [{ pwsid: pwsidOf(2) }, { pwsid: pwsidOf(2) }, { pwsid: pwsidOf(4) }, { pwsid: pwsidOf(99) }],
      zipSystems(5),
    );
    const ctx = createMockContext();

    const systems = await makeService().searchWaterSystems(
      { zipCode: '98104', hasViolation: true, limit: 50 },
      ctx,
    );

    expect(systems).toEqual([
      expect.objectContaining({ pwsid: pwsidOf(2), hasViolation: true }),
      expect.objectContaining({ pwsid: pwsidOf(4), hasViolation: true }),
    ]);
    expect(systemUrls(urls)).toEqual([
      expect.stringContaining('/sdwis.water_system/zip_code/equals/98104/1:1000/json'),
    ]);
    expect(violationUrls(urls)).toHaveLength(1);
    expect(pwsidInFilter(violationUrls(urls)[0]!)).toEqual(
      Array.from({ length: 5 }, (_, i) => pwsidOf(i + 1)),
    );
    expect(getEnrichment(ctx)).not.toHaveProperty('notice');
  });

  it('checks a state + ZIP search by PWSID instead of scanning the state', async () => {
    const urls = stubSdwisFetch([{ pwsid: pwsidOf(3) }], zipSystems(3));

    const systems = await makeService().searchWaterSystems(
      { state: 'WA', zipCode: '98104', hasViolation: true, limit: 50 },
      createMockContext(),
    );

    expect(systems.map((s) => s.pwsid)).toEqual([pwsidOf(3)]);
    expect(systemUrls(urls)[0]).toContain(
      '/primacy_agency_code/equals/WA/and/zip_code/equals/98104/',
    );
    expect(violationUrls(urls)).toHaveLength(1);
    expect(violationUrls(urls)[0]).not.toContain('primacy_agency_code');
    expect(pwsidInFilter(violationUrls(urls)[0]!)).toHaveLength(3);
  });

  it('walks PWSID chunks of at most 200 and finds a violator in the last one', async () => {
    const urls = stubSdwisFetch([{ pwsid: pwsidOf(450) }], zipSystems(450));

    const systems = await makeService().searchWaterSystems(
      { zipCode: '98104', hasViolation: true, limit: 10 },
      createMockContext(),
    );

    expect(systems.map((s) => s.pwsid)).toEqual([pwsidOf(450)]);
    const chunks = violationUrls(urls).map((u) => pwsidInFilter(u) ?? []);
    expect(chunks.map((ids) => ids.length)).toEqual([200, 200, 50]);
    expect(new Set(chunks.flat()).size).toBe(450);
  });

  it('stops checking chunks once the limit is filled, keeping ZIP order', async () => {
    const urls = stubSdwisFetch(
      [5, 150, 250, 300].map((n) => ({ pwsid: pwsidOf(n) })),
      zipSystems(450),
    );

    const systems = await makeService().searchWaterSystems(
      { zipCode: '98104', hasViolation: true, limit: 2 },
      createMockContext(),
    );

    expect(systems.map((s) => s.pwsid)).toEqual([pwsidOf(5), pwsidOf(150)]);
    expect(violationUrls(urls)).toHaveLength(1);
  });

  it('discloses a ZIP whose systems reach the 1,000-row read', async () => {
    const urls = stubSdwisFetch([], zipSystems(1200));
    const ctx = createMockContext();

    const systems = await makeService().searchWaterSystems(
      { zipCode: '98104', hasViolation: true, limit: 10 },
      ctx,
    );

    expect(systems).toEqual([]);
    expect(violationUrls(urls)).toHaveLength(5);
    expect(urls).toHaveLength(6);
    const { notice } = getEnrichment(ctx) as { notice?: string };
    expect(notice).toBe(
      'The violation check read only the first 1,000 water systems in ZIP 98104; systems past that point were not checked.',
    );
  });

  it('discloses a PWSID chunk whose violation rows reach the 1,000-row read', async () => {
    const violations = Array.from({ length: 1000 }, () => ({ pwsid: pwsidOf(1) }));
    const ctx = createMockContext();
    stubSdwisFetch(violations, zipSystems(3));

    const systems = await makeService().searchWaterSystems(
      { zipCode: '98104', hasViolation: true, limit: 10 },
      ctx,
    );

    expect(systems.map((s) => s.pwsid)).toEqual([pwsidOf(1)]);
    const { notice } = getEnrichment(ctx) as { notice?: string };
    expect(notice).toBe(
      'The open violation records for a group of up to 200 systems in ZIP 98104 filled the 1,000-row read; records past that point were not read, so these results may not include every system with an open violation in the ZIP.',
    );
  });

  it('makes no violation request when the ZIP has no systems', async () => {
    const urls = stubSdwisFetch([{ pwsid: pwsidOf(1) }], []);

    const systems = await makeService().searchWaterSystems(
      { zipCode: '00000', hasViolation: true, limit: 10 },
      createMockContext(),
    );

    expect(systems).toEqual([]);
    expect(urls).toHaveLength(1);
  });

  it('returns nothing when no ZIP system has a violation', async () => {
    const urls = stubSdwisFetch([{ pwsid: pwsidOf(99) }], zipSystems(3));

    const systems = await makeService().searchWaterSystems(
      { zipCode: '98104', hasViolation: true, limit: 10 },
      createMockContext(),
    );

    expect(systems).toEqual([]);
    expect(violationUrls(urls)).toHaveLength(1);
  });
});

describe('DmapService.searchWaterSystems open-violation filter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Live WA codes (sdwis.violation, 2026-10-08): R = returned to compliance (rtc_date set),
   * I = resolved when the system was deactivated (rtc_date = pws_deactivation_date),
   * K and O = no rtc_date — still open.
   */
  const mixedViolations = [
    { pwsid: pwsidOf(1), compliance_status_code: 'R', rtc_date: '2004-12-31 00:00:00' },
    { pwsid: pwsidOf(2), compliance_status_code: 'I', rtc_date: '2016-04-20 00:00:00' },
    { pwsid: pwsidOf(3), compliance_status_code: 'K', rtc_date: null },
    { pwsid: pwsidOf(4), compliance_status_code: 'O', rtc_date: null },
    { pwsid: pwsidOf(5), compliance_status_code: 'R', rtc_date: '2024-03-22 00:00:00' },
    { pwsid: pwsidOf(5), compliance_status_code: 'K', rtc_date: null },
  ];
  const systems = Array.from({ length: 5 }, (_, i) => ({
    pwsid: pwsidOf(i + 1),
    pws_name: `System ${i + 1}`,
  }));

  it('a state scan reads only open (K, O) violations', async () => {
    const urls = stubSdwisFetch(mixedViolations, systems);

    const result = await makeService().searchWaterSystems(
      { state: 'WA', hasViolation: true, limit: 50 },
      createMockContext(),
    );

    expect(result.map((s) => s.pwsid)).toEqual([pwsidOf(3), pwsidOf(4), pwsidOf(5)]);
    const violUrl = urls.find((u) => u.includes('/sdwis.violation/'))!;
    expect(violUrl).toContain(
      '/sdwis.violation/primacy_agency_code/equals/WA/and/compliance_status_code/in/K%2CO/1:1000/json',
    );
  });

  it('a ZIP check reads only open (K, O) violations', async () => {
    const urls = stubSdwisFetch(mixedViolations, systems);

    const result = await makeService().searchWaterSystems(
      { zipCode: '98104', hasViolation: true, limit: 50 },
      createMockContext(),
    );

    expect(result.map((s) => s.pwsid)).toEqual([pwsidOf(3), pwsidOf(4), pwsidOf(5)]);
    expect(statusInFilter(urls.find((u) => u.includes('/sdwis.violation/'))!)).toEqual(['K', 'O']);
  });

  it('returns nothing when every violation on record is resolved', async () => {
    const urls = stubSdwisFetch(
      mixedViolations.filter(
        (v) => v.compliance_status_code === 'R' || v.compliance_status_code === 'I',
      ),
      systems,
    );

    const result = await makeService().searchWaterSystems(
      { state: 'WA', hasViolation: true, limit: 50 },
      createMockContext(),
    );

    expect(result).toEqual([]);
    expect(urls.filter((u) => u.includes('/sdwis.water_system/'))).toHaveLength(0);
  });
});

describe('DmapService one-based row ranges', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getTriReleases requests and returns 500 reporting-form rows', async () => {
    const forms = Array.from({ length: 600 }, (_, i) => ({
      tri_facility_id: 'FAC1',
      cas_chem_name: `Chemical ${i + 1}`,
      reporting_year: '2022',
    }));
    const urls = stubPagedDmapFetch([{ match: '/tri.tri_reporting_form/', table: forms }]);

    const releases = await makeService().getTriReleases(
      { facilityId: 'FAC1' },
      createMockContext(),
    );

    expect(releases).toHaveLength(500);
    expect(releases.at(-1)?.chemicalName).toBe('Chemical 500');
    expect(urls[0]).toContain('/1:500/json');
  });

  it('fetchReleaseBreakdown reads 30 rows per submission, the last one included', async () => {
    const qty = ['D1', 'D2'].flatMap((doc) =>
      Array.from({ length: 30 }, () => ({
        doc_ctrl_num: doc,
        environmental_medium: 'AIR FUG',
        total_release: 1,
        release_na: '0',
      })),
    );
    const urls = stubPagedDmapFetch([
      {
        match: '/tri.tri_reporting_form/',
        table: [
          { doc_ctrl_num: 'D1', tri_facility_id: 'FAC1', cas_chem_name: 'Benzene' },
          { doc_ctrl_num: 'D2', tri_facility_id: 'FAC1', cas_chem_name: 'Toluene' },
        ],
      },
      { match: '/tri.tri_release_qty/', table: qty },
    ]);

    const releases = await makeService().getTriReleases(
      { facilityId: 'FAC1' },
      createMockContext(),
    );

    expect(releases.map((r) => r.releasesToAirInLbs)).toEqual([30, 30]);
    expect(urls.find((u) => u.includes('/tri.tri_release_qty/'))).toContain('/1:60/json');
  });

  it('searchSuperfund returns the full limit for a state search', async () => {
    const sites = Array.from({ length: 10 }, (_, i) => ({
      site_id: `S${i + 1}`,
      name: `Site ${i + 1}`,
    }));
    const urls = stubPagedDmapFetch([{ match: '/sems.envirofacts_site/', table: sites }]);

    const result = await makeService().searchSuperfund(
      { state: 'WA', limit: 3 },
      createMockContext(),
    );

    expect(result.map((s) => s.siteId)).toEqual(['S1', 'S2', 'S3']);
    expect(urls[0]).toContain('/fk_ref_state_code/equals/WA/1:3/json');
  });

  it('searchSuperfund proximity scans the whole candidate page, its last row included', async () => {
    const farAway = { primary_latitude_decimal_val: 10, primary_longitude_decimal_val: 10 };
    const sites = Array.from({ length: 20 }, (_, i) => ({
      site_id: `S${i + 1}`,
      name: `Site ${i + 1}`,
      ...(i === 19
        ? { primary_latitude_decimal_val: 47.6, primary_longitude_decimal_val: -122.3 }
        : farAway),
    }));
    const urls = stubPagedDmapFetch([{ match: '/sems.envirofacts_site/', table: sites }]);

    const result = await makeService().searchSuperfund(
      { state: 'WA', latitude: 47.6, longitude: -122.3, radiusMiles: 5, limit: 2 },
      createMockContext(),
    );

    expect(result.map((s) => s.siteId)).toEqual(['S20']);
    expect(urls[0]).toContain('/1:500/json');
  });

  it('searchSuperfundById requests exactly one row', async () => {
    const urls = stubPagedDmapFetch([
      { match: '/site_id/equals/1000598/', table: [{ site_id: '1000598', name: 'One Site' }] },
    ]);

    const result = await makeService().searchSuperfundById('1000598', createMockContext());

    expect(urls[0]).toContain('/1:1/json');
    expect(result).toEqual([expect.objectContaining({ siteId: '1000598', name: 'One Site' })]);
  });

  it('searchWaterSystems reads all 1,000 violation rows when flagging violators', async () => {
    const violations = Array.from({ length: 1000 }, (_, i) => ({ pwsid: pwsidOf(i + 1) }));
    const urls = stubSdwisFetch(violations, [
      { pwsid: 'WA0001000', pws_name: 'Thousandth Violator' },
    ]);

    const systems = await makeService().searchWaterSystems(
      { state: 'WA', hasViolation: true, limit: 5 },
      createMockContext(),
    );

    expect(systems).toEqual([expect.objectContaining({ pwsid: 'WA0001000', hasViolation: true })]);
    expect(urls.find((u) => u.includes('/sdwis.violation/'))).toContain('/1:1000/json');
  });
});

/**
 * Alaska facilities and reporting forms captured live from DMAP (2026-10-16), trimmed. In table
 * order the state's first joined rows are ALASKA PULP CORP's 1990s forms; the newest year on file
 * is 2024.
 */
const AK_TABLES = {
  'tri.tri_facility': [
    triFacility('99835LSKPLMILE6', 'ALASKA PULP CORP', 'AK', 'SITKA'),
    triFacility('99752RDDGP90MIL', 'RED DOG OPERATIONS', 'AK', 'NORTHWEST ARCTIC BOROUGH'),
    triFacility(
      '99901SCSTG1300S',
      'U.S. COAST GUARD BASE KETCHIKAN',
      'AK',
      'KETCHIKAN GATEWAY BOROUGH',
    ),
  ],
  'tri.tri_reporting_form': [
    triForm('1394085314363', '99835LSKPLMILE6', 'Polychlorinated biphenyls', 1994),
    triForm('1392060208939', '99835LSKPLMILE6', 'Acetone', 1992),
    triForm('1392060208941', '99835LSKPLMILE6', 'Ammonia', 1992),
    triForm('1324222523654', '99752RDDGP90MIL', 'Lead compounds', 2024),
    triForm('1324222523639', '99752RDDGP90MIL', 'Cyanide compounds', 2024),
    triForm('1324222523641', '99752RDDGP90MIL', 'Ammonia', 2024),
    triForm('1324222469734', '99901SCSTG1300S', 'Lead', 2024),
  ],
  'tri.tri_release_qty': [
    {
      doc_ctrl_num: '1324222469734',
      environmental_medium: 'AIR STACK',
      total_release: 0.5,
      release_na: '0',
    },
    {
      doc_ctrl_num: '1392060208939',
      environmental_medium: 'AIR FUG',
      total_release: 750,
      release_na: '0',
    },
  ],
};

const NEWEST_FIRST_SORT =
  '/sort/tri.tri_reporting_form.reporting_year:desc,tri.tri_reporting_form.doc_ctrl_num:asc';

describe('DmapService.searchTriReleases result order', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const joinPath = '/join/tri.tri_reporting_form/tri_facility_id/equals/tri_facility_id';
  const yearDoc = (r: { reportingYear: number; facilityId: string; chemicalName: string }) =>
    `${r.reportingYear} ${r.facilityId} ${r.chemicalName}`;

  it('without year returns the newest reporting years first, ties by submission number', async () => {
    const urls = stubFakeDmap(AK_TABLES);

    const releases = await makeService().searchTriReleases(
      { state: 'AK', limit: 6 },
      createMockContext(),
    );

    expect(releases.map(yearDoc)).toEqual([
      '2024 99901SCSTG1300S Lead',
      '2024 99752RDDGP90MIL Cyanide compounds',
      '2024 99752RDDGP90MIL Ammonia',
      '2024 99752RDDGP90MIL Lead compounds',
      '1994 99835LSKPLMILE6 Polychlorinated biphenyls',
      '1992 99835LSKPLMILE6 Acetone',
    ]);
    expect(urls).toEqual([
      `https://data.epa.gov/dmapservice/tri.tri_facility/state_abbr/equals/AK${joinPath}${NEWEST_FIRST_SORT}/1:6/json`,
    ]);
  });

  it('a smaller limit returns a prefix of a larger one', async () => {
    stubFakeDmap(AK_TABLES);
    const first3 = await makeService().searchTriReleases(
      { state: 'AK', limit: 3 },
      createMockContext(),
    );
    const all = await makeService().searchTriReleases(
      { state: 'AK', limit: 7 },
      createMockContext(),
    );

    expect(first3.map(yearDoc)).toEqual(all.slice(0, 3).map(yearDoc));
    const years = all.map((r) => r.reportingYear);
    expect(years).toEqual(years.toSorted((a, b) => b - a));
  });

  it('sorts after the county and chemical filters and before the row range', async () => {
    const urls = stubFakeDmap(AK_TABLES);

    // Both borough facilities filed a 2024 lead form; table order puts RED DOG's first, the
    // submission-number tiebreak puts the Coast Guard's first, and limit 1 keeps only one.
    const releases = await makeService().searchTriReleases(
      { state: 'AK', county: 'BOROUGH', chemicalName: 'lead', limit: 1 },
      createMockContext(),
    );

    expect(releases.map(yearDoc)).toEqual(['2024 99901SCSTG1300S Lead']);
    expect(urls).toEqual([
      `https://data.epa.gov/dmapservice/tri.tri_facility/state_abbr/equals/AK/and/county_name/contains/BOROUGH${joinPath}/and/cas_chem_name/contains/lead${NEWEST_FIRST_SORT}/1:1/json`,
    ]);
  });

  it('with year sends the unsorted request and keeps table order', async () => {
    const urls = stubFakeDmap(AK_TABLES);

    const releases = await makeService().searchTriReleases(
      { state: 'AK', year: 2024, limit: 5 },
      createMockContext(),
    );

    expect(releases.map(yearDoc)).toEqual([
      '2024 99752RDDGP90MIL Lead compounds',
      '2024 99752RDDGP90MIL Cyanide compounds',
      '2024 99752RDDGP90MIL Ammonia',
      '2024 99901SCSTG1300S Lead',
    ]);
    expect(urls).toEqual([
      `https://data.epa.gov/dmapservice/tri.tri_facility/state_abbr/equals/AK${joinPath}/and/reporting_year/equals/2024/1:5/json`,
    ]);
  });

  it('adds the breakdown to the sorted records it keeps', async () => {
    const urls = stubFakeDmap(AK_TABLES);

    const releases = await makeService().searchTriReleases(
      { state: 'AK', limit: 1, includeReleaseBreakdown: true },
      createMockContext(),
    );

    expect(releases).toEqual([
      {
        facilityId: '99901SCSTG1300S',
        facilityName: 'U.S. COAST GUARD BASE KETCHIKAN',
        countyName: 'KETCHIKAN GATEWAY BOROUGH',
        chemicalName: 'Lead',
        reportingYear: 2024,
        releasesToAirInLbs: 0.5,
      },
    ]);
    expect(urls[1]).toBe(
      'https://data.epa.gov/dmapservice/tri.tri_release_qty/doc_ctrl_num/in/1324222469734/1:30/json',
    );
  });

  it('carries the newest-first records on both tool surfaces', async () => {
    initDmapService({} as AppConfig, {} as StorageService);
    stubFakeDmap(AK_TABLES);

    const call = await runToolContract(searchTriReleasesTool, { state: 'AK', limit: 2 });

    expect(call.isError).toBeFalsy();
    const structured = call.structuredContent as { releases: Array<Record<string, unknown>> };
    expect(structured.releases.map((r) => r.reportingYear)).toEqual([2024, 2024]);
    const text = call.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    const headings = text.split('\n').filter((line) => line.startsWith('### '));
    expect(headings).toEqual([
      '### Lead — U.S. COAST GUARD BASE KETCHIKAN (99901SCSTG1300S) (2024)',
      '### Cyanide compounds — RED DOG OPERATIONS (99752RDDGP90MIL) (2024)',
    ]);
  });
});

const BOEING = '98108THBNG7500E';

/**
 * The Boeing Field facility (98108THBNG7500E) as DMAP held it on 2026-10-16: 375 reporting forms,
 * 1997–2024, each with a 13-digit doc_ctrl_num. The first and last forms and their release rows
 * are live captures; the forms between are synthetic, each with one AIR STACK row carrying its
 * index, so every chunk's rows are traceable in the merged result.
 */
function boeingTables(count = 375): Record<string, DmapRow[]> {
  const middle = Array.from({ length: count - 2 }, (_, n) => ({
    ...triForm(`13980${String(n + 1).padStart(8, '0')}`, BOEING, `Chemical ${n + 1}`, 2005),
  }));
  const forms = [
    triForm('1397110322979', BOEING, 'Toluene', 1997),
    ...middle,
    triForm('1324222981425', BOEING, 'Naphthalene', 2024),
  ];
  const liveQty = [
    ['1397110322979', 'AIR FUG', null, '0', '3'],
    ['1397110322979', 'AIR STACK', 0, '0', null],
    ['1397110322979', 'UNINJ I', null, '1', null],
    ['1397110322979', 'WATER', null, '0', null],
    ['1324222981425', 'UNINJ I', null, '1', null],
    ['1324222981425', 'AIR FUG', 18.67, '0', null],
    ['1324222981425', 'AIR STACK', 0.14, '0', null],
    ['1324222981425', 'SI 5.5.3A', null, '1', null],
    ['1324222981425', 'WATER', 0, '0', null],
  ].map(([doc, medium, total, na, range]) => ({
    doc_ctrl_num: doc,
    environmental_medium: medium,
    total_release: total,
    release_na: na,
    release_range_code: range,
  }));
  return {
    'tri.tri_reporting_form': forms,
    'tri.tri_release_qty': [
      ...liveQty,
      ...middle.map((form, n) => ({
        doc_ctrl_num: form.doc_ctrl_num,
        environmental_medium: 'AIR STACK',
        total_release: n + 1,
        release_na: '0',
      })),
    ],
  };
}

/** The doc_ctrl_nums a `tri.tri_release_qty` URL asks for through its `doc_ctrl_num/in` filter. */
function docInFilter(url: string): string[] {
  const match = /\/doc_ctrl_num\/in\/([^/]+)\//.exec(url);
  return match ? decodeURIComponent(match[1]!).split(',') : [];
}

const breakdownUrlsOf = (urls: string[]) => urls.filter((u) => u.includes('/tri.tri_release_qty/'));

describe('DmapService TRI release breakdown under the request-line limit', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('splits a 375-form facility into breakdown requests under 4,094 bytes and merges every row', async () => {
    const tables = boeingTables();
    const urls = stubFakeDmap(tables);

    const releases = await makeService().getTriReleases(
      { facilityId: BOEING },
      createMockContext(),
    );

    const breakdownUrls = breakdownUrlsOf(urls);
    expect(breakdownUrls.length).toBeGreaterThan(1);
    for (const url of breakdownUrls) {
      expect(requestLine(url).length).toBeLessThan(4094);
      expect(url).toMatch(new RegExp(`/1:${docInFilter(url).length * 30}/json$`));
    }
    const requested = breakdownUrls.flatMap(docInFilter);
    const allDocs = tables['tri.tri_reporting_form']!.map((f) => f.doc_ctrl_num as string);
    expect(requested.toSorted()).toEqual(allDocs.toSorted());

    expect(releases).toHaveLength(375);
    // Live 1997 form: hard AIR STACK zero; range-coded AIR FUG and null WATER add nothing.
    expect(releases.at(-1)).toEqual({
      facilityId: BOEING,
      chemicalName: 'Toluene',
      reportingYear: 1997,
      releasesToAirInLbs: 0,
    });
    // Live 2024 form sorts first; the older form remains in a later breakdown chunk.
    expect(releases[0]).toEqual({
      facilityId: BOEING,
      chemicalName: 'Naphthalene',
      reportingYear: 2024,
      releasesToAirInLbs: 18.81,
      releasesToWaterInLbs: 0,
    });
    expect(releases.slice(1, -1).map((r) => r.releasesToAirInLbs)).toEqual(
      Array.from({ length: 373 }, (_, n) => n + 1),
    );
  });

  it('epa_get_tri_releases returns a many-form facility with its breakdown on both surfaces', async () => {
    initDmapService({} as AppConfig, {} as StorageService);
    stubFakeDmap(boeingTables());

    const call = await runToolContract(getTriReleasesTool, { facility_id: BOEING });

    expect(call.isError).toBeFalsy();
    const structured = call.structuredContent as { releases: Array<Record<string, unknown>> };
    expect(structured.releases).toHaveLength(375);
    expect(structured.releases[0]).toEqual({
      facilityId: BOEING,
      chemicalName: 'Naphthalene',
      reportingYear: 2024,
      releasesToAirInLbs: 18.81,
      releasesToWaterInLbs: 0,
    });
    const text = call.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('**Records:** 375');
    const naphthalene = text.split('\n### ').find((s) => s.startsWith('Naphthalene (2024)'));
    expect(naphthalene).toContain('**Air Releases:** 18.81 lbs');
    expect(naphthalene).toContain('**Water Releases:** 0 lbs');
  });

  it('fetches the chunks concurrently, at most three at a time', async () => {
    // 40-character submission numbers (live ones are 13) force more chunks than the pool holds.
    const forms = Array.from({ length: 500 }, (_, n) =>
      triForm(`D${String(n).padStart(39, '0')}`, BOEING, `Chemical ${n}`, 2010),
    );
    const releaseQty = forms.map((form, n) => ({
      doc_ctrl_num: form.doc_ctrl_num,
      environmental_medium: 'AIR STACK',
      total_release: n + 1,
      release_na: '0',
    }));
    let inFlight = 0;
    let peak = 0;
    const urls = stubFakeDmap(
      { 'tri.tri_reporting_form': forms, 'tri.tri_release_qty': releaseQty },
      async (url) => {
        if (!url.includes('/tri.tri_release_qty/')) return;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
      },
    );

    const releases = await makeService().getTriReleases(
      { facilityId: BOEING },
      createMockContext(),
    );

    const breakdownUrls = breakdownUrlsOf(urls);
    expect(breakdownUrls.length).toBeGreaterThan(3);
    expect(breakdownUrls.flatMap(docInFilter)).toHaveLength(500);
    expect(peak).toBe(3);
    // Every chunk's rows merge onto their own submission, the last chunk's included.
    expect(releases.map((r) => r.releasesToAirInLbs)).toEqual(
      Array.from({ length: 500 }, (_, n) => n + 1),
    );
  });

  it('a 200-record search with the breakdown stays in one request under the limit', async () => {
    const facilities = [triFacility(BOEING, 'BOEING FIELD', 'WA', 'KING')];
    const forms = boeingTables(200)['tri.tri_reporting_form']!;
    const urls = stubFakeDmap({
      'tri.tri_facility': facilities,
      'tri.tri_reporting_form': forms,
      'tri.tri_release_qty': boeingTables(200)['tri.tri_release_qty']!,
    });

    const releases = await makeService().searchTriReleases(
      { state: 'WA', limit: 200, includeReleaseBreakdown: true },
      createMockContext(),
    );

    expect(releases).toHaveLength(200);
    expect(releases[0]).toMatchObject({ chemicalName: 'Naphthalene', releasesToAirInLbs: 18.81 });
    const breakdownUrls = breakdownUrlsOf(urls);
    expect(breakdownUrls).toHaveLength(1);
    expect(requestLine(breakdownUrls[0]!).length).toBeLessThan(4094);
    expect(docInFilter(breakdownUrls[0]!)).toHaveLength(200);
  });

  it('retries a chunk that fails transiently and still merges its rows', async () => {
    vi.useFakeTimers();
    let failed = false;
    const urls = stubFakeDmap(boeingTables(), async (url) => {
      if (!failed && url.includes('/tri.tri_release_qty/') && url.includes('1324222981425')) {
        failed = true;
        return new Response('upstream busy', { status: 503 });
      }
      return;
    });

    const pending = makeService().getTriReleases({ facilityId: BOEING }, createMockContext());
    await vi.runAllTimersAsync();
    const releases = await pending;

    const lastChunkRequests = breakdownUrlsOf(urls).filter((u) => u.includes('1324222981425'));
    expect(lastChunkRequests).toHaveLength(2);
    expect(releases[0]).toMatchObject({ releasesToAirInLbs: 18.81 });
  });

  it('settles a hung chunk as a Timeout under the 60-second client timeout', async () => {
    vi.useFakeTimers();
    stubFakeDmap(boeingTables(), (url, signal) =>
      url.includes('/tri.tri_release_qty/')
        ? new Promise((_, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          })
        : Promise.resolve(),
    );

    let settled: unknown;
    const pending = makeService()
      .getTriReleases({ facilityId: BOEING }, createMockContext())
      .then(
        () => {
          settled = 'resolved';
        },
        (error: unknown) => {
          settled = error;
        },
      );
    await vi.advanceTimersByTimeAsync(55_000);
    await pending;

    expect(settled).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message:
        'DMAP did not finish the TRI release lookup within 50 seconds. Narrow it with year or chemical_name, or call again later.',
      data: { reason: 'retry_deadline_exceeded', deadlineMs: 50_000 },
    });
  });

  it('carries the narrowing Timeout on both surfaces of epa_get_tri_releases', async () => {
    vi.useFakeTimers();
    initDmapService({} as AppConfig, {} as StorageService);
    stubFakeDmap({}, (_url, signal) => hang(signal));

    let call: Awaited<ReturnType<typeof runToolContract>> | undefined;
    const pending = runToolContract(getTriReleasesTool, { facility_id: BOEING }).then((result) => {
      call = result;
    });
    await vi.advanceTimersByTimeAsync(55_000);
    await pending;

    expect(call?.isError).toBe(true);
    expect(call?.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.Timeout, data: { reason: 'retry_deadline_exceeded' } },
    });
    const text = call?.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('Narrow it with year or chemical_name, or call again later.');
  });

  it('rejects with the cancellation when the caller aborts during the breakdown', async () => {
    const controller = new AbortController();
    const abort = abortWhileInFlight(controller);
    stubFakeDmap(boeingTables(), (url, signal) =>
      url.includes('/tri.tri_release_qty/') ? abort(url, signal) : Promise.resolve(),
    );

    const call = makeService().getTriReleases(
      { facilityId: BOEING },
      createMockContext({ signal: controller.signal }),
    );

    await expect(call).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports a DMAP HTTP 400 as this server failing, after exactly one request', async () => {
    initDmapService({} as AppConfig, {} as StorageService);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => requestLineTooLarge(5313));

    const call = await runToolContract(getTriReleasesTool, { facility_id: BOEING });

    expect(call.isError).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(call.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InternalError },
    });
    const text = call.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('DMAP returned HTTP 400');
  });
});

/**
 * Reporting forms whose chemical names (live TRI names, tri.tri_chem_info 2026-10-16) carry the
 * characters DMAP cannot take in a path: commas, an apostrophe, brackets, Greek letters.
 */
const PUNCTUATED_TABLES = {
  'tri.tri_facility': [
    triFacility('77001HSTNP100MA', 'HOUSTON PLANT', 'TX', 'HARRIS'),
    triFacility('20743PRNCG1500W', 'PRINCE GEORGES PLANT', 'MD', "PRINCE GEORGE'S"),
    triFacility('20744VRNTB2200W', 'VARIANT PLANT', 'MD', 'PRINCE GEORGE S'),
  ],
  'tri.tri_reporting_form': [
    triForm('1322220000001', '77001HSTNP100MA', '1,1,1-Trichloroethane', 2022),
    triForm('1322220000002', '77001HSTNP100MA', '1,2,4-Trimethylbenzene', 2022),
    triForm('1322220000003', '77001HSTNP100MA', '1,3-Butadiene', 2022),
    triForm('1322220000004', '77001HSTNP100MA', "Michler's ketone", 2022),
    triForm('1322220000005', '77001HSTNP100MA', 'Benzo[g,h,i]perylene', 2022),
    triForm('1322220000006', '77001HSTNP100MA', 'Thiols, C4-10, γ-ω-perfluoro', 2022),
    triForm('1322220000007', '20743PRNCG1500W', 'Lead', 2022),
    triForm('1322220000008', '20744VRNTB2200W', 'Lead', 2022),
  ],
  'tri.tri_release_qty': [],
};

/** The notice a wildcarded text filter carries when its page limit ends the walk short. */
const WILDCARD_CAP_NOTICE = (text: string, rowsRead: number, kept: number) =>
  `"${text}" was searched with a one-character wildcard in place of punctuation, and the first ${rowsRead.toLocaleString('en-US')} rows matching the wildcard held ${kept} ${kept === 1 ? 'match' : 'matches'} spelled as given, so more may exist past them. Narrow the search with other filters or more of the text.`;

/** A sems.envirofacts_site row. */
function semsSite(id: string, city: string, state = 'ID'): DmapRow {
  return { site_id: id, name: `SITE ${id}`, city_name: city, fk_ref_state_code: state };
}

const chemicalsOf = (releases: Array<{ chemicalName: string }>) =>
  releases.map((r) => r.chemicalName);

describe('DmapService text filters DMAP cannot carry in a URL path', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('matches a chemical name with commas exactly, not just its text before the first comma', async () => {
    const urls = stubFakeDmap(PUNCTUATED_TABLES);

    const releases = await makeService().searchTriReleases(
      { state: 'TX', year: 2022, chemicalName: '1,3-Butadiene', limit: 5 },
      createMockContext(),
    );

    expect(chemicalsOf(releases)).toEqual(['1,3-Butadiene']);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/and/cas_chem_name/contains/1_3-Butadiene/');
  });

  it.each([
    ["Michler's ketone", "Michler's ketone", 'Michler_s%20ketone'],
    ['benzo[g,h,i]PERYLENE', 'Benzo[g,h,i]perylene', 'benzo_g_h_i_PERYLENE'],
    ['γ-ω-perfluoro', 'Thiols, C4-10, γ-ω-perfluoro', '_-_-perfluoro'],
  ])(
    'finds "%s" in one request through a one-character wildcard',
    async (input, chemical, sent) => {
      const urls = stubFakeDmap(PUNCTUATED_TABLES);

      const releases = await makeService().getTriReleases(
        { facilityId: '77001HSTNP100MA', chemicalName: input },
        createMockContext(),
      );

      expect(chemicalsOf(releases)).toEqual([chemical]);
      expect(urls[0]).toContain(`/cas_chem_name/contains/${sent}/`);
      expect(urls.filter((u) => u.includes('/tri.tri_reporting_form/'))).toHaveLength(1);
    },
  );

  it('keeps only the county spelled as given, dropping a wildcard near-match', async () => {
    const urls = stubFakeDmap(PUNCTUATED_TABLES);

    const releases = await makeService().searchTriReleases(
      { state: 'MD', county: "PRINCE GEORGE'S", year: 2022, limit: 5 },
      createMockContext(),
    );

    expect(releases.map((r) => r.countyName)).toEqual(["PRINCE GEORGE'S"]);
    expect(urls[0]).toContain('/county_name/contains/PRINCE%20GEORGE_S/');
  });

  it('epa_search_tri_releases carries an apostrophe search on both surfaces', async () => {
    initDmapService({} as AppConfig, {} as StorageService);
    stubFakeDmap(PUNCTUATED_TABLES);

    const call = await runToolContract(searchTriReleasesTool, {
      state: 'TX',
      chemical_name: "Michler's ketone",
    });

    expect(call.isError).toBeFalsy();
    const structured = call.structuredContent as { releases: Array<Record<string, unknown>> };
    expect(structured.releases.map((r) => r.chemicalName)).toEqual(["Michler's ketone"]);
    const text = call.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain("### Michler's ketone — HOUSTON PLANT (77001HSTNP100MA) (2022)");
  });

  it('reads the next page when the exact match drops near-variants from a full page', async () => {
    // Superfund city names carry spelling variants: SEMS lists both COEUR D'ALENE and COEUR D ALENE.
    const sites = [
      ...Array.from({ length: 99 }, (_, n) => semsSite(`V${n}`, 'COEUR D ALENE')),
      semsSite('E1', "COEUR D'ALENE"),
      semsSite('E2', "COEUR D'ALENE"),
      semsSite('E3', "COEUR D'ALENE"),
    ];
    const urls = stubFakeDmap({ 'sems.envirofacts_site': sites });

    const result = await makeService().searchSuperfund(
      { state: 'ID', city: "Coeur d'Alene", limit: 2 },
      createMockContext(),
    );

    expect(result.map((s) => s.siteId)).toEqual(['E1', 'E2']);
    expect(urls.map((u) => /\/(\d+:\d+)\/json$/.exec(u)?.[1])).toEqual(['1:100', '101:200']);
    expect(urls[0]).toContain('/city_name/contains/Coeur%20d_Alene/');
  });

  it('reads at most three pages of near-variants, and says more matches may exist', async () => {
    const sites = [
      ...Array.from({ length: 300 }, (_, n) => semsSite(`V${n}`, 'COEUR D ALENE')),
      semsSite('E1', "COEUR D'ALENE"),
    ];
    const urls = stubFakeDmap({ 'sems.envirofacts_site': sites });
    const ctx = createMockContext();

    const result = await makeService().searchSuperfund(
      { state: 'ID', city: "Coeur d'Alene", limit: 5 },
      ctx,
    );

    expect(result).toEqual([]);
    expect(urls).toHaveLength(3);
    expect(getEnrichment(ctx)).toEqual({ notice: WILDCARD_CAP_NOTICE("Coeur d'Alene", 300, 0) });
  });

  it('adds no notice when DMAP runs out of wildcard rows before the page limit', async () => {
    const sites = [
      ...Array.from({ length: 150 }, (_, n) => semsSite(`V${n}`, 'COEUR D ALENE')),
      semsSite('E1', "COEUR D'ALENE"),
    ];
    stubFakeDmap({ 'sems.envirofacts_site': sites });
    const ctx = createMockContext();

    const result = await makeService().searchSuperfund(
      { state: 'ID', city: "Coeur d'Alene", limit: 5 },
      ctx,
    );

    expect(result.map((s) => s.siteId)).toEqual(['E1']);
    expect(getEnrichment(ctx)).not.toHaveProperty('notice');
  });

  it('adds no notice when the exact matches fill the limit within the page limit', async () => {
    const sites = [
      ...Array.from({ length: 299 }, (_, n) => semsSite(`V${n}`, 'COEUR D ALENE')),
      semsSite('E1', "COEUR D'ALENE"),
      semsSite('E2', "COEUR D'ALENE"),
    ];
    const urls = stubFakeDmap({ 'sems.envirofacts_site': sites });
    const ctx = createMockContext();

    const result = await makeService().searchSuperfund(
      { state: 'ID', city: "Coeur d'Alene", limit: 1 },
      ctx,
    );

    expect(result.map((s) => s.siteId)).toEqual(['E1']);
    expect(urls).toHaveLength(3);
    expect(getEnrichment(ctx)).not.toHaveProperty('notice');
  });

  it('epa_search_tri_releases discloses a wildcard walk cut short, beside the records it found', async () => {
    initDmapService({} as AppConfig, {} as StorageService);
    // Live 2026-10-16: TX "C.I." reads three pages of C_I_ wildcard rows and keeps 3 records.
    const facilities = [triFacility('77001HSTNP100MA', 'HOUSTON PLANT', 'TX', 'HARRIS')];
    const forms = [
      triForm('1322220000001', '77001HSTNP100MA', 'C.I. Food Red 15', 2024),
      ...Array.from({ length: 300 }, (_, n) =>
        triForm(`13222201${String(n).padStart(5, '0')}`, '77001HSTNP100MA', 'CHIC SOLVENT', 2023),
      ),
      triForm('1322220099999', '77001HSTNP100MA', 'C.I. Solvent Yellow 34', 2022),
    ];
    stubFakeDmap({
      'tri.tri_facility': facilities,
      'tri.tri_reporting_form': forms,
      'tri.tri_release_qty': [],
    });

    const call = await runToolContract(searchTriReleasesTool, {
      state: 'TX',
      chemical_name: 'C.I.',
    });

    expect(call.isError).toBeFalsy();
    const notice = WILDCARD_CAP_NOTICE('C.I.', 300, 1);
    const structured = call.structuredContent as {
      releases: Array<{ chemicalName: string }>;
      notice?: string;
    };
    expect(structured.releases.map((r) => r.chemicalName)).toEqual(['C.I. Food Red 15']);
    expect(structured.notice).toBe(notice);
    const text = call.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain(notice);
    expect(text).toContain('### C.I. Food Red 15 — HOUSTON PLANT (77001HSTNP100MA) (2024)');
  });

  it('epa_get_tri_releases discloses a wildcard walk cut short on both surfaces', async () => {
    initDmapService({} as AppConfig, {} as StorageService);
    const forms = Array.from({ length: 1500 }, (_, n) =>
      triForm(`1322230${String(n).padStart(6, '0')}`, BOEING, 'CHIC SOLVENT', 2023),
    );
    const urls = stubFakeDmap({ 'tri.tri_reporting_form': forms, 'tri.tri_release_qty': [] });

    const call = await runToolContract(getTriReleasesTool, {
      facility_id: BOEING,
      chemical_name: 'C.I.',
    });

    expect(call.isError).toBeFalsy();
    expect(urls.map((u) => /\/(\d+:\d+)\/json$/.exec(u)?.[1])).toEqual([
      '1:500',
      '501:1000',
      '1001:1500',
    ]);
    const notice = WILDCARD_CAP_NOTICE('C.I.', 1500, 0);
    const structured = call.structuredContent as { releases: unknown[]; notice?: string };
    expect(structured.releases).toEqual([]);
    expect(structured.notice).toBe(notice);
    const text = call.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain(notice);
    expect(text).toContain('No TRI releases found');
  });

  it('epa_search_superfund discloses a wildcard walk cut short on both surfaces', async () => {
    initDmapService({} as AppConfig, {} as StorageService);
    const sites = [
      ...Array.from({ length: 300 }, (_, n) => semsSite(`V${n}`, 'COEUR D ALENE')),
      semsSite('E1', "COEUR D'ALENE"),
    ];
    stubFakeDmap({ 'sems.envirofacts_site': sites });

    const call = await runToolContract(searchSuperfundTool, {
      state: 'ID',
      city: "Coeur d'Alene",
      limit: 5,
    });

    expect(call.isError).toBeFalsy();
    const notice = WILDCARD_CAP_NOTICE("Coeur d'Alene", 300, 0);
    const structured = call.structuredContent as { sites: unknown[]; notice?: string };
    expect(structured.sites).toEqual([]);
    expect(structured.notice).toBe(notice);
    const text = call.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain(notice);
  });

  it('matches a literal underscore as written, not as a one-character wildcard', async () => {
    const tables = {
      ...PUNCTUATED_TABLES,
      'tri.tri_reporting_form': [
        triForm('1322220000011', '77001HSTNP100MA', 'C112 resin', 2022),
        triForm('1322220000012', '77001HSTNP100MA', 'C_12 resin', 2022),
      ],
    };
    const urls = stubFakeDmap(tables);

    const releases = await makeService().getTriReleases(
      { facilityId: '77001HSTNP100MA', chemicalName: 'C_12' },
      createMockContext(),
    );

    expect(chemicalsOf(releases)).toEqual(['C_12 resin']);
    expect(urls[0]).toContain('/cas_chem_name/contains/C_12/');
  });

  it('sends a plain text filter unchanged, in one request ranged to the limit', async () => {
    const urls = stubFakeDmap({
      'sems.envirofacts_site': [
        semsSite('K1', 'KALISPELL', 'MT'),
        semsSite('K2', 'KALISPELL', 'MT'),
      ],
    });

    const result = await makeService().searchSuperfund(
      { state: 'MT', city: 'Kalispell', limit: 1 },
      createMockContext(),
    );

    expect(result.map((s) => s.siteId)).toEqual(['K1']);
    expect(urls).toEqual([
      'https://data.epa.gov/dmapservice/sems.envirofacts_site/fk_ref_state_code/equals/MT/and/city_name/contains/Kalispell/1:1/json',
    ]);
  });

  it.each([
    [
      'a TRI facility ID',
      () => makeService().getTriReleases({ facilityId: '98108THBNG7500E/X' }, createMockContext()),
      '/',
    ],
    [
      'a water-system state',
      () => makeService().searchWaterSystems({ state: 'WA,OR' }, createMockContext()),
      ',',
    ],
    [
      'a Superfund ZIP',
      () => makeService().searchSuperfund({ zipCode: '98104%' }, createMockContext()),
      '%',
    ],
    [
      'a TRI search state',
      () => makeService().searchTriReleases({ state: "W'" }, createMockContext()),
      "'",
    ],
  ])(
    'rejects %s carrying a character DMAP cannot match, before any request',
    async (_, call, character) => {
      const urls = stubFakeDmap(PUNCTUATED_TABLES);

      await expect(call()).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringContaining(`"${character}"`),
        data: { character },
      });
      expect(urls).toEqual([]);
    },
  );

  it('tells a comma-joined exact value to pass one value per call', async () => {
    initDmapService({} as AppConfig, {} as StorageService);
    const urls = stubFakeDmap(PUNCTUATED_TABLES);

    const call = await runToolContract(searchSuperfundTool, { zip_code: '98104,98101' });

    expect(call.isError).toBe(true);
    expect(urls).toEqual([]);
    const message =
      '"98104,98101" contains ",", a character EPA\'s DMAP service cannot match in an exact-value filter. Pass one value per call.';
    expect(call.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ValidationError, message },
    });
    expect(JSON.stringify(call.content)).toContain('Pass one value per call.');
  });

  it.each([
    ['a trailing', '98108THBNG7500E/'],
    ['a leading', '/98108THBNG7500E'],
    ['repeated', '//98108THBNG7500E//'],
  ])('reads a TRI facility ID with %s slash as DMAP does, as the bare ID', async (_, id) => {
    const urls = stubFakeDmap(boeingTables(3));

    const releases = await makeService().getTriReleases({ facilityId: id }, createMockContext());

    expect(urls[0]).toBe(
      `https://data.epa.gov/dmapservice/tri.tri_reporting_form/tri_facility_id/equals/${BOEING}${NEWEST_FIRST_SORT}/1:500/json`,
    );
    expect(releases.map((r) => r.chemicalName)).toEqual(['Naphthalene', 'Chemical 1', 'Toluene']);
  });

  it.each([
    [
      'a water-system ZIP',
      () => makeService().searchWaterSystems({ zipCode: '98104/' }, createMockContext()),
      '/sdwis.water_system/zip_code/equals/98104/1:50/json',
    ],
    [
      'a Superfund ZIP',
      () => makeService().searchSuperfund({ zipCode: '/98104' }, createMockContext()),
      '/sems.envirofacts_site/zip_code/equals/98104/1:50/json',
    ],
    [
      'a Superfund city',
      () => makeService().searchSuperfund({ state: 'WA', city: 'Seattle/' }, createMockContext()),
      '/sems.envirofacts_site/fk_ref_state_code/equals/WA/and/city_name/contains/Seattle/1:50/json',
    ],
    [
      'a TRI chemical name',
      () =>
        makeService().getTriReleases(
          { facilityId: BOEING, chemicalName: 'Toluene/' },
          createMockContext(),
        ),
      `/tri_facility_id/equals/98108THBNG7500E/and/cas_chem_name/contains/Toluene${NEWEST_FIRST_SORT}/1:500/json`,
    ],
  ])('sends %s with a slash at an end as the bare value', async (_, call, path) => {
    const urls = stubFakeDmap({
      'sdwis.water_system': [
        { pwsid: 'WA5377050', pws_name: 'SEATTLE PUBLIC UTILITIES', zip_code: '98104' },
      ],
      'sems.envirofacts_site': [
        { ...semsSite('S1', 'SEATTLE', 'WA'), zip_code: '98104' },
        semsSite('S2', 'SPOKANE', 'WA'),
      ],
      ...boeingTables(3),
    });

    const rows = (await call()) as unknown[];

    expect(urls[0]).toContain(path);
    expect(rows).toHaveLength(1);
  });

  it('still rejects a slash inside a value, and a value of slashes only, before any request', async () => {
    const urls = stubFakeDmap(boeingTables(3));

    for (const facilityId of ['98108THBNG7500E/X', '/', '//']) {
      await expect(
        makeService().getTriReleases({ facilityId }, createMockContext()),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError, data: { character: '/' } });
    }
    expect(urls).toEqual([]);
  });

  it('sends a Superfund city as long as DMAP still answers, on both surfaces', async () => {
    initDmapService({} as AppConfig, {} as StorageService);
    const urls = stubFakeDmap({ 'sems.envirofacts_site': [semsSite('S1', 'SEATTLE', 'WA')] });

    // 4,029 letters at limit 1 make a 4,105-byte request line, which DMAP counts as 4,094.
    const call = await runToolContract(searchSuperfundTool, { city: 'a'.repeat(4029), limit: 1 });

    expect(call.isError).toBeFalsy();
    expect(urls).toHaveLength(1);
    expect(Buffer.byteLength(requestLine(urls[0]!))).toBe(4105);
    const structured = call.structuredContent as { sites: unknown[]; message?: string };
    expect(structured.sites).toEqual([]);
    expect(structured.message).toContain('No Superfund sites found');
    const text = call.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('No Superfund sites found');
  });

  it('sends an all-years chemical filter through the sorted request-line boundary', async () => {
    const urls = stubFakeDmap(boeingTables(3));

    const releases = await makeService().getTriReleases(
      { facilityId: 'X', chemicalName: 'a'.repeat(3905) },
      createMockContext(),
    );

    expect(releases).toEqual([]);
    expect(urls).toHaveLength(1);
    expect(Buffer.byteLength(requestLine(urls[0]!))).toBe(4105);
  });

  it.each([3906, 3993])(
    'rejects a %s-character all-years filter whose sorted URL exceeds the bound',
    async (length) => {
      const urls = stubFakeDmap(boeingTables(3));
      await expect(
        makeService().getTriReleases(
          { facilityId: 'X', chemicalName: 'a'.repeat(length) },
          createMockContext(),
        ),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      expect(urls).toEqual([]);
    },
  );

  it('rejects one byte more than DMAP counts as its limit, before any request', async () => {
    const urls = stubFakeDmap({ 'sems.envirofacts_site': [] });

    await expect(
      makeService().searchSuperfund({ city: 'a'.repeat(4030), limit: 1 }, createMockContext()),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
    expect(urls).toEqual([]);
  });

  it('rejects a text filter with no letter or digit, before any request', async () => {
    const urls = stubFakeDmap(PUNCTUATED_TABLES);

    await expect(
      makeService().searchTriReleases({ state: 'TX', chemicalName: "'" }, createMockContext()),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
    expect(urls).toEqual([]);
  });

  it('rejects filters too long for DMAP request line as an input error, before any request', async () => {
    const urls = stubFakeDmap(PUNCTUATED_TABLES);

    await expect(
      makeService().getTriReleases({ facilityId: 'A'.repeat(5000) }, createMockContext()),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
    expect(urls).toEqual([]);
  });
});

/** Hold a request until its signal aborts, then reject with the abort reason. */
function hang(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** Answer a request after `ms`, or reject with the abort reason if its signal aborts first. */
function respondAfter(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** Run `call` under fake timers for `ms` and return how it settled (undefined while pending). */
async function settleWithin(call: () => Promise<unknown>, ms: number): Promise<unknown> {
  let settled: unknown;
  const pending = call().then(
    () => {
      settled = 'resolved';
    },
    (error: unknown) => {
      settled = error;
    },
  );
  await vi.advanceTimersByTimeAsync(ms);
  if (settled !== undefined) await pending;
  return settled;
}

describe('DmapService water-system and Superfund call deadline', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const zipSystems = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      pwsid: pwsidOf(i + 1),
      pws_name: `System ${i + 1}`,
      zip_code: '59901',
      primacy_agency_code: 'MT',
    }));

  it('shares the 50-second deadline across latitude prefixes and a later retry', async () => {
    vi.useFakeTimers();
    let requests = 0;
    const urls = stubFakeDmap({ 'sems.envirofacts_site': [] }, async (_url, signal) => {
      requests++;
      if (requests === 1) return respondAfter(30_000, signal);
      if (requests === 2) {
        await respondAfter(10_000, signal);
        return new Response('temporary outage', { status: 503 });
      }
      return hang(signal);
    });
    const settled = await settleWithin(
      () =>
        makeService().searchSuperfund(
          { latitude: 0, longitude: 0, radiusMiles: 500 },
          createMockContext(),
        ),
      55_000,
    );
    expect(settled).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'retry_deadline_exceeded', deadlineMs: 50_000 },
    });
    expect(urls).toHaveLength(3);
    expect(urls[1]).toBe(urls[2]);
    expect(urls[0]).not.toBe(urls[1]);
  });

  it('settles a ZIP violation check against a hung DMAP as a Timeout under 60 seconds', async () => {
    vi.useFakeTimers();
    stubFakeDmap({ 'sdwis.water_system': zipSystems(5), 'sdwis.violation': [] }, (url, signal) =>
      url.includes('/sdwis.violation/') ? hang(signal) : Promise.resolve(),
    );

    const settled = await settleWithin(
      () =>
        makeService().searchWaterSystems(
          { zipCode: '59901', hasViolation: true, limit: 10 },
          createMockContext(),
        ),
      55_000,
    );

    expect(settled).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'retry_deadline_exceeded' },
    });
  });

  it('shares one deadline across the whole ZIP chain, not one per request', async () => {
    vi.useFakeTimers();
    // 1,000 systems: the ZIP read, then five 200-PWSID violation requests of 12 s each — 60 s in
    // all, so only a deadline shared across the chain settles the call by 55 s.
    stubFakeDmap(
      { 'sdwis.water_system': zipSystems(1000), 'sdwis.violation': [] },
      (url, signal) =>
        url.includes('/sdwis.violation/') ? respondAfter(12_000, signal) : Promise.resolve(),
    );

    const settled = await settleWithin(
      () =>
        makeService().searchWaterSystems(
          { zipCode: '59901', hasViolation: true, limit: 10 },
          createMockContext(),
        ),
      55_000,
    );

    expect(settled).toMatchObject({ code: JsonRpcErrorCode.Timeout });
  });

  const waterNarrowing =
    'DMAP did not finish the water system search within 50 seconds. Narrow it with zip_code or pws_type, or call again later.';

  it.each([
    [
      'a state violation scan',
      () =>
        makeService().searchWaterSystems({ state: 'MT', hasViolation: true }, createMockContext()),
      waterNarrowing,
    ],
    [
      'a plain water-system search',
      () => makeService().searchWaterSystems({ state: 'MT' }, createMockContext()),
      waterNarrowing,
    ],
    [
      'a Superfund search',
      () => makeService().searchSuperfund({ state: 'MT' }, createMockContext()),
      'DMAP did not finish the Superfund site search within 50 seconds. Narrow it with zip_code, city, or npl_status, or call again later.',
    ],
    [
      'a Superfund site lookup',
      () => makeService().searchSuperfundById('0800040', createMockContext()),
      'DMAP did not finish the Superfund site lookup within 50 seconds. Call again later.',
    ],
    [
      'a TRI search',
      () => makeService().searchTriReleases({ state: 'MT' }, createMockContext()),
      'DMAP did not finish the TRI release search within 50 seconds. Narrow it with year, county, or chemical_name, leave include_release_breakdown off, or call again later.',
    ],
  ])(
    'settles %s against a hung DMAP as a Timeout naming how to narrow it',
    async (_, call, message) => {
      vi.useFakeTimers();
      stubFakeDmap({}, (_url, signal) => hang(signal));

      const settled = await settleWithin(call, 55_000);

      expect(settled).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        message,
        data: { reason: 'retry_deadline_exceeded', deadlineMs: 50_000 },
      });
    },
  );

  it('rejects with the cancellation when the caller aborts mid-chain', async () => {
    const controller = new AbortController();
    const abort = abortWhileInFlight(controller);
    stubFakeDmap({ 'sdwis.water_system': zipSystems(5), 'sdwis.violation': [] }, (url, signal) =>
      url.includes('/sdwis.violation/') ? abort(url, signal) : Promise.resolve(),
    );

    await expect(
      makeService().searchWaterSystems(
        { zipCode: '59901', hasViolation: true, limit: 10 },
        createMockContext({ signal: controller.signal }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
