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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { superfundSearchSitesTool } from '@/mcp-server/tools/definitions/superfund-search-sites.tool.js';
import { triGetFacilityReleasesTool } from '@/mcp-server/tools/definitions/tri-get-facility-releases.tool.js';
import { triSearchReleasesTool } from '@/mcp-server/tools/definitions/tri-search-releases.tool.js';
import { waterSearchSystemsTool } from '@/mcp-server/tools/definitions/water-search-systems.tool.js';
import {
  type CurrentViolatorLookup,
  DmapService,
  initDmapService,
} from '@/services/dmap/dmap-service.js';
import { initEchoService, type SdwViolatorScope } from '@/services/echo/echo-service.js';
import { answerAfter, hang, textOf } from '../../helpers.js';
import newarkCoordinates from './fixtures/newark-superfund-coordinates.json' with { type: 'json' };
import seattleCoordinates from './fixtures/seattle-superfund-coordinates.json' with {
  type: 'json',
};

/**
 * Route fetch by URL substring, answering each request with `body(route, url)` as JSON. A request
 * no route matches rejects with a non-retryable error, so an unexpected URL fails the test instead
 * of silently reading as an empty table.
 */
function stubRoutes<Route extends { match: string }>(
  routes: Route[],
  body: (route: Route, url: string) => unknown,
): string[] {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    urls.push(url);
    const route = routes.find((r) => url.includes(r.match));
    if (!route) {
      return Promise.reject(validationError(`Unmocked DMAP fetch: ${url}`, { retryable: false }));
    }
    return Promise.resolve(new Response(JSON.stringify(body(route, url)), { status: 200 }));
  });
  return urls;
}

/** Stub fetch with each route's `rows` as its whole response. */
const stubDmapFetch = (routes: Array<{ match: string; rows: unknown[] }>): string[] =>
  stubRoutes(routes, (route) => route.rows);

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
const stubPagedDmapFetch = (routes: Array<{ match: string; table: unknown[] }>): string[] =>
  stubRoutes(routes, (route, url) => dmapPage(url, route.table));

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

  /** Full latitude-band coordinate captures from EPA DMAP, 2026-10-24; names omitted. */
  it.each([
    ['Newark', newarkCoordinates, 40.7357, -74.1724, 203, '0202764', 3],
    ['Seattle', seattleCoordinates, 47.6, -122.3, 15, '1003072', 1],
  ] as const)(
    'preserves the complete %s reference matches with fewer candidates',
    async (_city, coordinates, latitude, longitude, total, nearest, requests) => {
      const rows = coordinates.map(
        ([site_id, primary_latitude_decimal_val, primary_longitude_decimal_val]) => ({
          site_id,
          name: site_id,
          primary_latitude_decimal_val,
          primary_longitude_decimal_val,
        }),
      );
      const urls = stubFakeDmap({ 'sems.envirofacts_site': rows });
      initDmapService({} as AppConfig, {} as StorageService);
      const call = await runToolContract(superfundSearchSitesTool, {
        latitude,
        longitude,
        radius_miles: 5,
        limit: 200,
      });
      expect(call.isError).toBeFalsy();
      const structured = call.structuredContent as {
        sites: { siteId: string }[];
        totalCount?: number;
        notice?: string;
      };
      expect(structured.sites).toHaveLength(Math.min(total, 200));
      expect(structured.totalCount).toBe(total);
      expect(structured.sites[0]?.siteId).toBe(nearest);
      expect(urls).toHaveLength(requests);
      const text = textOf(call.content);
      expect(text).toContain(nearest);
      if (total > 200) {
        expect(structured.notice).toContain('Showing sites 1–200 of 203');
        expect(text).toContain(structured.notice);
      } else
        expect(structured.notice).toContain(
          'Proximity searches match only sites with usable coordinates.',
        );
    },
  );

  it('continues past a full page with no exact-radius matches and an empty later partition', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => ({
      site_id: String(i).padStart(7, '0'),
      name: `SITE ${i}`,
      primary_latitude_decimal_val: i === 500 ? '9.99' : '90',
      primary_longitude_decimal_val: '0',
    }));
    const urls = stubFakeDmap({ 'sems.envirofacts_site': rows });
    const result = await makeService().searchSuperfund(
      { latitude: 9.99, longitude: 0, radiusMiles: 5 },
      createMockContext(),
    );
    expect(result.items.map((site) => site.siteId)).toEqual(['0000500']);
    expect(urls.some((url) => url.includes('/501:1000/json'))).toBe(true);
    expect(urls.some((url) => url.includes('/beginsWith/10/'))).toBe(true);
  });

  it('covers both literal zero signs in latitude and longitude', async () => {
    const rows = ['0', '-0', '0.01', '-0.01'].flatMap((lat, i) =>
      ['0', '-0', '0.01', '-0.01'].map((lon, j) => ({
        site_id: `${i}${j}`,
        name: `${i}${j}`,
        primary_latitude_decimal_val: lat,
        primary_longitude_decimal_val: lon,
      })),
    );
    stubFakeDmap({ 'sems.envirofacts_site': rows });
    const result = await makeService().searchSuperfund(
      { latitude: 0, longitude: 0, radiusMiles: 5 },
      createMockContext(),
    );
    expect(result.items.map((site) => site.siteId).sort()).toEqual([
      '00',
      '01',
      '02',
      '03',
      '10',
      '11',
      '12',
      '13',
      '20',
      '21',
      '22',
      '23',
      '30',
      '31',
      '32',
      '33',
    ]);
  });

  it('exhausts stable pages and orders a later nearer site before applying limit', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => ({
      site_id: String(i + 1).padStart(7, '0'),
      name: `SITE ${i}`,
      primary_latitude_decimal_val: i === 500 ? '40.7357' : '40.79',
      primary_longitude_decimal_val: '-74.1724',
    }));
    const urls = stubFakeDmap({ 'sems.envirofacts_site': rows });
    const result = await makeService().searchSuperfund(
      { latitude: 40.7357, longitude: -74.1724, radiusMiles: 5, limit: 1 },
      createMockContext(),
    );
    expect(result.items.map((site) => site.siteId)).toEqual(['0000501']);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('/primary_longitude_decimal_val/beginsWith/-74/');
    expect(urls[0]).toContain('/sort/sems.envirofacts_site.site_id:asc/1:500/json');
    expect(urls[1]).toContain('/501:1000/json');
  });

  it('rejects repeated pages instead of claiming complete results', async () => {
    const page = Array.from({ length: 500 }, (_, i) => ({
      site_id: String(i),
      name: `SITE ${i}`,
      primary_latitude_decimal_val: '40.7357',
      primary_longitude_decimal_val: '-74.1724',
    }));
    const urls = stubDmapFetch([{ match: '/sems.envirofacts_site/', rows: page }]);
    await expect(
      makeService().searchSuperfund(
        { latitude: 40.7357, longitude: -74.1724, radiusMiles: 5 },
        createMockContext(),
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    expect(urls).toHaveLength(2);
  });

  it('searches a ZIP by prefix without coordinates', async () => {
    const urls = stubFakeDmap({
      'sems.envirofacts_site': [{ site_id: 'S1', name: 'SPARSE', zip_code: '98104' }],
    });
    const sites = await makeService().searchSuperfund(
      { zipCode: '98104', limit: 1 },
      createMockContext(),
    );
    expect(sites).toEqual({ items: [{ siteId: 'S1', name: 'SPARSE', zip: '98104' }] });
    expect(urls).toEqual([
      'https://data.epa.gov/dmapservice/sems.envirofacts_site/zip_code/beginsWith/98104/sort/sems.envirofacts_site.site_id:asc/1:2/json',
    ]);
  });

  it('finds a ZIP+4 search across the whole 5-digit ZIP on both surfaces', async () => {
    // sems.envirofacts_site rows with zip_code beginning 07631 (live, 2026-11-01), and a neighbor.
    const rows = [
      ['0206741', '07631-2720'],
      ['0203738', '07631'],
      ['0203613', '07631'],
      ['0200991', '07631'],
      ['0203182', '07631'],
      ['0206739', '07631-3445'],
      ['0203212', '07631'],
      ['0206740', '07631-2720'],
      ['0200701', '07631'],
      ['0200999', '07632'],
    ].map(([site_id, zip_code]) => ({
      site_id,
      name: `SITE ${site_id}`,
      zip_code,
      fk_ref_state_code: 'NJ',
    }));
    const urls = stubFakeDmap({ 'sems.envirofacts_site': rows });
    initDmapService({} as AppConfig, {} as StorageService);

    const call = await runToolContract(superfundSearchSitesTool, { zip_code: '07631-2720' });

    expect(call.isError).toBeFalsy();
    expect(urls).toEqual([
      'https://data.epa.gov/dmapservice/sems.envirofacts_site/zip_code/beginsWith/07631/sort/sems.envirofacts_site.site_id:asc/1:51/json',
    ]);
    const structured = call.structuredContent as {
      sites: Array<{ siteId: string; zip?: string }>;
      effectiveQuery?: string;
    };
    expect(structured.sites.map((s) => s.siteId)).toEqual(
      rows
        .slice(0, 9)
        .map((r) => r.site_id)
        .toSorted(),
    );
    expect(structured.sites.filter((s) => s.zip === '07631-2720').map((s) => s.siteId)).toEqual([
      '0206740',
      '0206741',
    ]);
    expect(structured.effectiveQuery).toBe('zip_code begins with 07631');
    const text = textOf(call.content);
    expect(text).toContain('**Returned:** 9');
    expect(text).toContain('07631-2720');
    expect(text).not.toContain('0200999');
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
    expect(sites.items.map((s) => s.siteId)).toEqual(['1002655']);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain(
      '/primary_latitude_decimal_val/beginsWith/47/and/primary_longitude_decimal_val/beginsWith/-122/',
    );
  });

  it.each([
    ['negative', -14.2, -170.7, -14.21, -170.7],
    ['equator', 0, 0, -0.01, 0],
    ['zero', 0, 0, 0, 0],
    ['9/10 boundary', 9.99, 0, 10.01, 0],
    ['negative 9/10 boundary', -9.99, 0, -10.01, 0],
    ['longitude wrap', 47.6, 179.99, 47.6, -179.99],
    ['westward longitude wrap', 47.6, -179.99, 47.6, 179.99],
    ['longitude 9/10 boundary', 0, 9.99, 0, 10.01],
    ['negative longitude 9/10 boundary', 0, -9.99, 0, -10.01],
    ['circle reaching north pole', 89.99, 0, 89.98, 180],
    ['circle reaching south pole', -89.99, 0, -89.98, 180],
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
      expect(sites.items.map((s) => s.siteId)).toEqual(['NEAR']);
      expect(urls.every((url) => url.includes('/primary_longitude_decimal_val/'))).toBe(
        Math.abs(latitude) < 89.9,
      );
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
      npl_status_code: 'F',
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
    expect(sites.items.map((s) => s.siteId)).toEqual(['S1']);
    expect(urls).toHaveLength(4);
    for (const url of urls)
      expect(decodeURIComponent(url)).toContain(
        '/fk_ref_state_code/equals/MO/and/city_name/contains/St_ Louis/and/zip_code/beginsWith/63101/and/npl_status_code/in/F,A/and/primary_latitude_decimal_val/beginsWith/',
      );
  });

  it.each([false, true])(
    'exhausts candidates and discloses only the caller result limit on both surfaces, nearby=%s',
    async (nearby) => {
      const rows = Array.from({ length: 600 }, (_, i) => ({
        site_id: `S${i}`,
        name: `SITE ${i}`,
        primary_latitude_decimal_val: i < 200 ? '9.99' : '10.01',
        primary_longitude_decimal_val: nearby ? '0' : '100',
      }));
      const urls = stubFakeDmap({ 'sems.envirofacts_site': rows });
      initDmapService({} as AppConfig, {} as StorageService);
      const call = await runToolContract(superfundSearchSitesTool, {
        latitude: 9.99,
        longitude: 0,
        radius_miles: 5,
        limit: 2,
      });
      expect(call.isError).toBeFalsy();
      const structured = call.structuredContent as {
        sites: unknown[];
        notice?: string;
        message?: string;
      };
      expect(structured.sites).toHaveLength(nearby ? 2 : 0);
      const text = textOf(call.content);
      if (nearby) {
        expect(structured.notice).toContain('Showing sites 1–2 of 600');
        expect(text).toContain(structured.notice);
      } else {
        expect(structured.notice).toContain(
          'Proximity searches match only sites with usable coordinates.',
        );
        expect(text).toContain('No Superfund sites found.');
        expect(text).toContain('**Total Found:** 0 | **Returned:** 0');
      }
      expect(urls.every((url) => url.includes('/sort/sems.envirofacts_site.site_id:asc/'))).toBe(
        true,
      );
      expect(urls.every((url) => url.includes('/1:500/json'))).toBe(true);
    },
  );

  it('carries uncapped proximity results with coordinate coverage on both surfaces', async () => {
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
    const call = await runToolContract(superfundSearchSitesTool, {
      latitude: 0,
      longitude: 0,
      radius_miles: 1,
    });
    expect(call.isError).toBeFalsy();
    expect(call.structuredContent).toMatchObject({
      sites: [{ siteId: 'ZERO', latitude: 0, longitude: 0 }],
      totalCount: 1,
    });
    expect(call.structuredContent).toMatchObject({
      notice: expect.stringContaining(
        'Proximity searches match only sites with usable coordinates.',
      ),
    });
    expect(textOf(call.content)).toContain('**Coordinates:** 0, 0');
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
    expect(sites.items.map((site) => site.siteId)).toEqual(['NEAR']);
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

/** Great-circle miles, as an independent check on the service's nearest-first order. */
function milesBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

describe('DmapService Superfund paging', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Seven NJ sites in shuffled upstream order: the sort, not DMAP's row order, fixes each page. */
  const NJ_IDS = ['0200007', '0200002', '0200005', '0200001', '0200006', '0200003', '0200004'];
  const njTable = () => ({
    'sems.envirofacts_site': NJ_IDS.map((site_id) => ({
      site_id,
      name: `SITE ${site_id}`,
      fk_ref_state_code: 'NJ',
    })),
  });
  const SORTED = '/sort/sems.envirofacts_site.site_id:asc';

  it('walks an administrative search in site ID order, each site once, until nextOffset is absent', async () => {
    const urls = stubFakeDmap(njTable());
    const service = makeService();
    const walked: string[] = [];
    const nextOffsets: Array<number | undefined> = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page = await service.searchSuperfund(
        { state: 'NJ', offset, limit: 3 },
        createMockContext(),
      );
      expect(page).not.toHaveProperty('totalCount');
      walked.push(...page.items.map((site) => site.siteId));
      nextOffsets.push(page.nextOffset);
      offset = page.nextOffset;
    }
    expect(walked).toEqual(NJ_IDS.toSorted());
    expect(nextOffsets).toEqual([3, 6, undefined]);
    expect(urls).toEqual(
      ['1:4', '4:7', '7:10'].map(
        (range) =>
          `https://data.epa.gov/dmapservice/sems.envirofacts_site/fk_ref_state_code/equals/NJ${SORTED}/${range}/json`,
      ),
    );
  });

  it.each([
    [2, ['0200003', '0200004', '0200005'], 5],
    [6, ['0200007'], undefined],
    [7, [], undefined],
    [50, [], undefined],
  ] as const)(
    'reads offset %s as upstream position, one row past the page',
    async (offset, ids, nextOffset) => {
      const urls = stubFakeDmap(njTable());
      const page = await makeService().searchSuperfund(
        { state: 'NJ', offset, limit: 3 },
        createMockContext(),
      );
      expect(page.items.map((site) => site.siteId)).toEqual(ids);
      expect(page.nextOffset).toBe(nextOffset);
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain(`${SORTED}/${offset + 1}:${offset + 4}/json`);
    },
  );

  it('continues a punctuated city from the next exact match, skipping dropped near-variants', async () => {
    const sites = [
      semsSite('0100001', "COEUR D'ALENE"),
      ...['0100002', '0100003', '0100004', '0100005'].map((id) => semsSite(id, 'COEUR D ALENE')),
      semsSite('0100006', "COEUR D'ALENE"),
      semsSite('0100007', "COEUR D'ALENE"),
    ].toReversed();
    const urls = stubFakeDmap({ 'sems.envirofacts_site': sites });
    const service = makeService();
    const pages: Array<{ ids: string[]; nextOffset?: number }> = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page = await service.searchSuperfund(
        { state: 'ID', city: "Coeur d'Alene", offset, limit: 1 },
        createMockContext(),
      );
      pages.push({
        ids: page.items.map((site) => site.siteId),
        ...(page.nextOffset !== undefined && { nextOffset: page.nextOffset }),
      });
      offset = page.nextOffset;
    }
    expect(pages).toEqual([
      { ids: ['0100001'], nextOffset: 5 },
      { ids: ['0100006'], nextOffset: 6 },
      { ids: ['0100007'] },
    ]);
    expect(urls.map((u) => /\/(\d+:\d+)\/json$/.exec(u)?.[1])).toEqual(['1:100', '6:105', '7:106']);
  });

  /** The Newark 5-mile reference: 203 matches (EPA DMAP capture, 2026-10-24). */
  const newark = { latitude: 40.7357, longitude: -74.1724, radiusMiles: 5 };
  const newarkRows = () =>
    newarkCoordinates.map(
      ([site_id, primary_latitude_decimal_val, primary_longitude_decimal_val]) => ({
        site_id,
        name: site_id,
        primary_latitude_decimal_val,
        primary_longitude_decimal_val,
      }),
    );

  it('pages the Newark proximity match nearest first, with no gap or repeat and a past-end page', async () => {
    stubFakeDmap({ 'sems.envirofacts_site': newarkRows() });
    const service = makeService();
    const pages = [];
    for (const offset of [0, 100, 200, 300]) {
      pages.push(
        await service.searchSuperfund({ ...newark, offset, limit: 100 }, createMockContext()),
      );
    }
    expect(pages.map((page) => page.items.length)).toEqual([100, 100, 3, 0]);
    expect(pages.map((page) => page.nextOffset)).toEqual([100, 200, undefined, undefined]);
    expect(pages.map((page) => page.totalCount)).toEqual([203, 203, 203, 203]);
    const joined = pages.flatMap((page) => page.items);
    expect(joined[0]?.siteId).toBe('0202764');
    expect(new Set(joined.map((site) => site.siteId)).size).toBe(203);
    const miles = joined.map((site) =>
      milesBetween(newark.latitude, newark.longitude, site.latitude!, site.longitude!),
    );
    expect(miles.every((distance, i) => i === 0 || distance >= miles[i - 1]!)).toBe(true);
    expect(miles.every((distance) => distance <= 5)).toBe(true);
  });

  it('breaks a distance tie by site ID across a page boundary', async () => {
    const at = { primary_latitude_decimal_val: '40.7357', primary_longitude_decimal_val: '-74.17' };
    stubFakeDmap({
      'sems.envirofacts_site': [
        { site_id: 'B2', name: 'B2', ...at },
        { site_id: 'A1', name: 'A1', ...at },
      ],
    });
    const service = makeService();
    const first = await service.searchSuperfund({ ...newark, limit: 1 }, createMockContext());
    const second = await service.searchSuperfund(
      { ...newark, offset: 1, limit: 1 },
      createMockContext(),
    );
    expect(first).toMatchObject({ items: [{ siteId: 'A1' }], nextOffset: 1, totalCount: 2 });
    expect(second).toMatchObject({ items: [{ siteId: 'B2' }], totalCount: 2 });
    expect(second).not.toHaveProperty('nextOffset');
  });

  it('epa_superfund_search_sites carries paging, the query echo, and the guidance on both surfaces', async () => {
    stubFakeDmap(njTable());
    initDmapService({} as AppConfig, {} as StorageService);
    const call = await runToolContract(superfundSearchSitesTool, {
      state: 'nj',
      offset: 3,
      limit: 3,
      exclude_archived: false,
    });
    expect(call.isError).toBeFalsy();
    const guidance = 'More records follow; call again with offset 6 to continue.';
    expect(call.structuredContent).toMatchObject({
      sites: [{ siteId: '0200004' }, { siteId: '0200005' }, { siteId: '0200006' }],
      effectiveQuery: 'state=NJ',
      nextOffset: 6,
      guidance,
    });
    expect(call.structuredContent).not.toHaveProperty('totalCount');
    const text = textOf(call.content);
    expect(text).toContain('**Returned:** 3');
    expect(text).toContain('Query: `state=NJ`');
    expect(text).toContain('**Next offset:** 6');
    expect(text).toContain(guidance);
  });

  it('epa_superfund_search_sites reports the proximity match count and page on both surfaces', async () => {
    stubFakeDmap({ 'sems.envirofacts_site': newarkRows() });
    initDmapService({} as AppConfig, {} as StorageService);
    const call = await runToolContract(superfundSearchSitesTool, {
      latitude: 40.7357,
      longitude: -74.1724,
      radius_miles: 5,
      limit: 3,
    });
    expect(call.isError).toBeFalsy();
    const structured = call.structuredContent as {
      sites: unknown[];
      totalCount?: number;
      notice?: string;
      nextOffset?: number;
      effectiveQuery?: string;
    };
    expect(structured.sites).toHaveLength(3);
    expect(structured.totalCount).toBe(203);
    expect(structured.nextOffset).toBe(3);
    expect(structured.notice).toContain(
      'Showing sites 1–3 of 203 matching Superfund sites within the radius, nearest first.',
    );
    expect(structured.effectiveQuery).toBe(
      'latitude=40.7357; longitude=-74.1724; radius_miles=5, nearest first',
    );
    const text = textOf(call.content);
    expect(text).toContain('**Total Found:** 203 | **Returned:** 3');
    expect(text).toContain('Showing sites 1–3 of 203');
    expect(text).toContain('**Next offset:** 3');
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

  it('sorts an explicit-year request by submission number and merges the per-medium breakdown', async () => {
    const urls = stubFakeDmap({
      'tri.tri_reporting_form': forms(),
      'tri.tri_release_qty': [qtyRow('D500', 'AIR STACK', '12')],
    });
    const page = await makeService().getTriReleases(
      { facilityId: 'FAC', year: 2024 },
      createMockContext(),
    );
    // Exactly 500 filings that year: the full page, and nothing follows it.
    expect(page.items).toHaveLength(500);
    expect(page).not.toHaveProperty('nextOffset');
    expect(page.items.at(-1)).toMatchObject({ reportingYear: 2024, releasesToAirInLbs: 12 });
    expect(urls[0]).toBe(
      `https://data.epa.gov/dmapservice/tri.tri_reporting_form/tri_facility_id/equals/FAC/and/reporting_year/equals/2024${NEWEST_FIRST_SORT}/1:501/json`,
    );
  });

  it('sorts capped all-years filings newest-first with a submission tiebreak', async () => {
    const urls = stubFakeDmap({ 'tri.tri_reporting_form': forms(), 'tri.tri_release_qty': [] });
    const { items: releases } = await makeService().getTriReleases(
      { facilityId: 'FAC', chemicalName: '1,3-Butadiene' },
      createMockContext(),
    );
    expect(releases).toHaveLength(500);
    expect(releases.every((r) => r.reportingYear === 2024)).toBe(true);
    expect(urls[0]).toContain(
      '/sort/tri.tri_reporting_form.reporting_year:desc,tri.tri_reporting_form.doc_ctrl_num:asc/1:501/json',
    );
    const docs = urls.filter((url) => url.includes('/tri.tri_release_qty/')).flatMap(docInFilter);
    expect(docs[0]).toBe('D001');
    expect(docs.at(-1)).toBe('D500');
    const { items: oldYear } = await makeService().getTriReleases(
      { facilityId: 'FAC', year: 1987 },
      createMockContext(),
    );
    expect(oldYear).toHaveLength(1);
    expect(oldYear[0]?.reportingYear).toBe(1987);
  });

  it.each([
    // 501 filings across all years: one follows the 500-filing page.
    [undefined, 500],
    // Exactly 500 in 2024: the page is full and nothing follows.
    [2024, undefined],
  ])(
    'discloses a capped lookup only when more filings follow, on both surfaces, year=%s',
    async (year, nextOffset) => {
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
      const call = await runToolContract(triGetFacilityReleasesTool, {
        facility_id: 'FAC',
        ...(year !== undefined && { year }),
      });
      expect(call.isError).toBeFalsy();
      const structured = call.structuredContent as { releases: unknown[]; guidance?: string };
      expect(structured.releases).toHaveLength(500);
      expect(structured).toMatchObject({ notice: 'Existing punctuation-scan notice.' });
      const text = textOf(call.content);
      expect(text).toContain('Existing punctuation-scan notice.');
      if (nextOffset === undefined) {
        for (const key of ['nextOffset', 'truncated', 'shown', 'cap', 'guidance'])
          expect(structured).not.toHaveProperty(key);
        return;
      }
      expect(structured).toMatchObject({
        nextOffset,
        truncated: true,
        shown: 500,
        cap: 500,
        guidance: `More records follow; call again with offset ${nextOffset} to continue.`,
      });
      expect(structured.guidance?.toLowerCase()).not.toContain('raise');
      expect(text).toContain(structured.guidance);
      expect(text).toContain(`**Next offset:** ${nextOffset}`);
      expect(text).toContain('**truncated:** true');
      expect(text).toContain('**shown:** 500');
      expect(text).toContain('**cap:** 500');
    },
  );

  it('omits cap fields below 500 and retains a successful empty result', async () => {
    stubFakeDmap({ 'tri.tri_reporting_form': [], 'tri.tri_release_qty': [] });
    initDmapService({} as AppConfig, {} as StorageService);
    const call = await runToolContract(triGetFacilityReleasesTool, { facility_id: 'FAC' });
    expect(call.isError).toBeFalsy();
    expect(call.structuredContent).toMatchObject({ releases: [], facilityId: 'FAC' });
    for (const key of ['truncated', 'shown', 'cap', 'guidance'])
      expect(call.structuredContent).not.toHaveProperty(key);
    expect(textOf(call.content)).toContain('No TRI releases found');
  });

  it.each([0, 2])(
    'sorts later exact-text pages and stops at exhaustion with %s matches',
    async (count) => {
      // One more than the 501-row page, so the exact matches always sit on a later page.
      const nearVariants = Array.from({ length: 501 }, (_, i) => ({
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
      const { items: releases } = await makeService().getTriReleases(
        { facilityId: 'FAC', chemicalName: '1,3-Butadiene' },
        ctx,
      );
      expect(releases).toHaveLength(count);
      expect(
        releases.every((r) => r.reportingYear === 2023 && r.chemicalName === '1,3-Butadiene'),
      ).toBe(true);
      const pages = urls.filter((url) => url.includes('/tri.tri_reporting_form/'));
      // A 500-filing page reads 501 rows a page, so one extra match proves more follow.
      expect(pages).toHaveLength(2);
      expect(pages[0]).toContain(`${NEWEST_FIRST_SORT}/1:501/json`);
      expect(pages[1]).toContain(`${NEWEST_FIRST_SORT}/502:1002/json`);
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
          qtyRow('D1', 'AIR FUG', 120),
          qtyRow('D1', 'AIR STACK', 100),
          {
            doc_ctrl_num: 'D1',
            environmental_medium: 'WATER',
            total_release: 50,
            release_na: '0',
            water_sequence_num: '1',
          },
          qtyRow('D1', 'RCRA C', 30),
          qtyRow('D1', 'OTH DISP', 5),
          qtyRow('D1', 'UNINJ I', 200),
        ],
      },
    ]);

    const { items: releases } = await makeService().getTriReleases(
      { facilityId: 'FAC1' },
      createMockContext(),
    );

    expect(releases).toHaveLength(1);
    const r = releases[0]!;
    expect(r.releasesToAirInLbs).toBe(220); // 120 + 100
    expect(r.releasesToWaterInLbs).toBe(50);
    expect(r.releasesToLandInLbs).toBe(35); // RCRA C 30 + OTH DISP 5
    expect(r.releasesToUndergroundInjectionInLbs).toBe(200);
    // one_time_release_qty keeps its own value, untouched by the breakdown.
    expect(r.oneTimeReleaseInLbs).toBe(0);
    expect(r.totalOnSiteReleasesInLbs).toBe(505);
    // The forms request, then one breakdown request on doc_ctrl_num ranged 30 rows per submission.
    expect(urls).toEqual([
      `https://data.epa.gov/dmapservice/tri.tri_reporting_form/tri_facility_id/equals/FAC1${NEWEST_FIRST_SORT}/1:501/json`,
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
        rows: [qtyRow('D1', 'AIR FUG', 10), qtyRow('D2', 'WATER', 40)],
      },
    ]);

    const { items: releases } = await makeService().getTriReleases(
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
          qtyRow('D3', 'AIR FUG', 75),
          // Not applicable to this submission — the 0 it carries must not surface as a release.
          {
            doc_ctrl_num: 'D3',
            environmental_medium: 'UNINJ I',
            total_release: 0,
            release_na: '1',
          },
          // A Form R surface impoundment line (5.5.3A, RCRA Subtitle C) is an on-site land release.
          qtyRow('D3', 'SI 5.5.3A', 8),
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

    const { items: releases } = await makeService().getTriReleases(
      { facilityId: 'FAC2' },
      createMockContext(),
    );

    // Only the hard AIR FUG and SI 5.5.3A quantities land; no other field, zero or otherwise. The
    // on-site total sums those two and leaves the range-coded water out.
    expect(releases).toEqual([
      {
        facilityId: 'FAC2',
        chemicalName: 'LEAD',
        reportingYear: 2019,
        releasesToAirInLbs: 75,
        releasesToLandInLbs: 8,
        totalOnSiteReleasesInLbs: 83,
      },
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

    const {
      items: [r],
    } = await makeService().getTriReleases({ facilityId: 'FAC3' }, createMockContext());

    // Unrounded: 0.0009080000000000001 and 0.30000000000000004.
    expect(r!.releasesToAirInLbs).toBe(0.000908);
    expect(r!.releasesToLandInLbs).toBe(0.3);
    expect(r!.releasesToWaterInLbs).toBe(12345.678);
    expect(r!.releasesToUndergroundInjectionInLbs).toBe(1e-7);
  });

  it('rolls the pre-2003 impoundment and pre-1996 landfill and injection codes into their media', async () => {
    stubDmapFetch([
      {
        match: '/tri.tri_reporting_form/',
        rows: [{ doc_ctrl_num: 'D5', tri_facility_id: 'FAC5', cas_chem_name: 'ARSENIC' }],
      },
      {
        match: '/tri.tri_release_qty/',
        rows: [
          qtyRow('D5', 'SURF IMP', 10),
          qtyRow('D5', 'LANDF8795', 3),
          qtyRow('D5', 'UNINJ8795', 7),
        ],
      },
    ]);

    const {
      items: [r],
    } = await makeService().getTriReleases({ facilityId: 'FAC5' }, createMockContext());

    expect(r).toMatchObject({ releasesToLandInLbs: 13, releasesToUndergroundInjectionInLbs: 7 });
  });

  it('adds both Form R surface impoundment lines to land: Rockport 2022 barium is 955,005 lb', async () => {
    stubDmapFetch([
      {
        match: '/tri.tri_reporting_form/',
        rows: [
          { ...ROCKPORT_BARIUM_FORM },
          // Only an N/A and a range-coded impoundment line: no land quantity, never a 0.
          triForm('D-RANGE', ROCKPORT_BARIUM_FORM.tri_facility_id, 'Mercury', 2022),
        ],
      },
      {
        match: '/tri.tri_release_qty/',
        rows: [
          ...ROCKPORT_BARIUM_RELEASE_QTY,
          qtyRow('D-RANGE', 'SI 5.5.3A', null, '1', null),
          qtyRow('D-RANGE', 'SI 5.5.3B', null, '0', '2'),
        ],
      },
    ]);

    const {
      items: [barium, mercury],
    } = await makeService().getTriReleases(
      { facilityId: ROCKPORT_BARIUM_FORM.tri_facility_id, year: 2022 },
      createMockContext(),
    );

    expect(barium).toEqual({
      facilityId: '47635RCKPR2791N',
      chemicalName: ROCKPORT_BARIUM_FORM.cas_chem_name,
      reportingYear: 2022,
      releasesToAirInLbs: 552,
      releasesToWaterInLbs: 1100,
      // OTH LANDF 740,000 + SI 5.5.3B 215,000 + OTH DISP 5; SI 5.5.3A is N/A.
      releasesToLandInLbs: 955005,
      totalOnSiteReleasesInLbs: 956657,
    });
    expect(mercury).toEqual({
      facilityId: '47635RCKPR2791N',
      chemicalName: 'Mercury',
      reportingYear: 2022,
    });
  });

  it('converts a gram-reported surface impoundment quantity to pounds like the other land codes', async () => {
    stubDmapFetch([
      {
        match: '/tri.tri_reporting_form/',
        rows: [{ ...DIOXIN_FACILITY_FORMS[1], one_time_release_qty: null }],
      },
      {
        match: '/tri.tri_release_qty/',
        rows: [
          qtyRow('1322220762367', 'SI 5.5.3A', 1, '0', null),
          qtyRow('1322220762367', 'SI 5.5.3B', 2, '0', null),
          qtyRow('1322220762367', 'LAND TREA', 0.0005809, '0', null),
        ],
      },
    ]);

    const {
      items: [dioxin],
    } = await makeService().getTriReleases({ facilityId: '96020CLLNS500MA' }, createMockContext());

    // 3.0005809 g / 453.59237 g per lb, rounded to 12 significant digits.
    expect(dioxin).toMatchObject({ reportedUnit: 'grams', releasesToLandInLbs: 0.00661514853083 });
  });
});

/** One tri.tri_release_qty row; `na` defaults to "0", and an omitted `range` leaves release_range_code off the wire. */
function qtyRow(
  doc: unknown,
  medium: string,
  total: number | string | null,
  na = '0',
  range?: string | null,
): DmapRow {
  return {
    doc_ctrl_num: doc,
    environmental_medium: medium,
    total_release: total,
    release_na: na,
    release_range_code: range,
  };
}

/** Rockport Plant (IN) 2022 barium compounds form, captured live from DMAP (2026-11-01). */
const ROCKPORT_BARIUM_FORM = {
  doc_ctrl_num: '1322221158328',
  tri_facility_id: '47635RCKPR2791N',
  tri_chem_id: 'N040',
  cas_chem_name: 'Barium compounds (except for barium sulfate (CAS No. 7727-43-7))',
  reporting_year: '2022',
  one_time_release_qty: null,
};

/** Every tri.tri_release_qty row of that form, captured live from DMAP (2026-11-01). */
const ROCKPORT_BARIUM_RELEASE_QTY = (
  [
    ['LAND TREA', null, '1'],
    ['OTH DISP', 5, '0'],
    ['SI 5.5.3B', 215000, '0'],
    ['SI 5.5.3A', null, '1'],
    ['OTH LANDF', 740000, '0'],
    ['RCRA C', null, '1'],
    ['UNINJ IIV', null, '1'],
    ['UNINJ I', null, '1'],
    ['AIR STACK', 547, '0'],
    ['AIR FUG', 5, '0'],
    ['WATER', 1100, '0'],
    ['WATER', 0, '0'],
    ['WATER', 0, '0'],
  ] as const
).map(([medium, total, na]) => qtyRow(ROCKPORT_BARIUM_FORM.doc_ctrl_num, medium, total, na, null));

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

    const {
      items: [lead, dioxin],
    } = await makeService().getTriReleases(
      { facilityId: '96020CLLNS500MA', year: 2022 },
      createMockContext(),
    );

    // 1 lb = 453.59237 g, rounded to 12 significant digits.
    expect(dioxin).toEqual({
      facilityId: '96020CLLNS500MA',
      chemicalName: 'Dioxin and dioxin-like compounds',
      reportingYear: 2022,
      reportedUnit: 'grams',
      oneTimeReleaseInLbs: 0.0044092452437,
      releasesToAirInLbs: 0.000162952476471,
      releasesToLandInLbs: 1.28066528103e-6,
      totalOnSiteReleasesInLbs: 0.000164233141752,
    });
    // Pound-reported chemicals pass through unconverted and unmarked.
    expect(lead).toEqual({
      facilityId: '96020CLLNS500MA',
      chemicalName: 'Lead compounds',
      reportingYear: 2022,
      releasesToAirInLbs: 2.21,
      releasesToLandInLbs: 26.3,
      totalOnSiteReleasesInLbs: 28.51,
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

    const {
      items: [dioxin],
    } = await makeService().getTriReleases({ facilityId: '96020CLLNS500MA' }, createMockContext());

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
    const { items: withBreakdown } = await makeService().searchTriReleases(
      { state: 'CA', county: 'PLUMAS', year: 2022, limit: 5, includeReleaseBreakdown: true },
      createMockContext(),
    );
    vi.restoreAllMocks();
    stubFakeDmap(tables);
    const { items: withoutBreakdown } = await makeService().searchTriReleases(
      { state: 'CA', county: 'PLUMAS', year: 2022, limit: 5 },
      createMockContext(),
    );

    expect(withBreakdown[1]).toMatchObject({
      reportedUnit: 'grams',
      oneTimeReleaseInLbs: 0.0044092452437,
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
      oneTimeReleaseInLbs: 0.0044092452437,
    });
  });
});

/**
 * tri.tri_release_qty rows captured live from DMAP (OR, reporting year 2022, 2026-10-08), trimmed
 * to the columns the rollup reads. 1322220659559 mixes a hard AIR STACK quantity with a range-coded
 * AIR FUG row and release_na rows (including the "SI 5.5.3*" impoundment lines); 1322220789794 is
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

    const { items: releases } = await makeService().searchTriReleases(
      { state: 'OR', year: 2022, limit: 10, includeReleaseBreakdown: true },
      createMockContext(),
    );

    // In submission-number order, the sort a single-year search sends.
    expect(releases).toEqual([
      {
        facilityId: '97321RCNPC3009S',
        facilityName: 'FACILITY A',
        countyName: 'LINN',
        chemicalName: 'Lead compounds',
        reportingYear: 2022,
        // one_time_release_qty keeps its own value; the media already count it.
        oneTimeReleaseInLbs: 4,
        // AIR STACK 17.123; the range-coded AIR FUG row adds nothing.
        releasesToAirInLbs: 17.123,
        totalOnSiteReleasesInLbs: 17.123,
      },
      // No tri_release_qty rows at all — none of the four fields.
      {
        facilityId: '97487MRCDS2500W',
        facilityName: 'FACILITY B',
        countyName: 'DOUGLAS',
        chemicalName: 'Ammonia',
        reportingYear: 2022,
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
        totalOnSiteReleasesInLbs: 0,
      },
    ]);

    const breakdownUrls = urls.filter((u) => u.includes('/tri.tri_release_qty/'));
    expect(breakdownUrls).toHaveLength(1);
    expect(breakdownUrls[0]).toContain(
      '/doc_ctrl_num/in/1322220659559%2C1322220687305%2C1322220789794%2C1322221249042/',
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
      qtyRow('EARLY', 'WATER', 12),
      qtyRow('LATE', 'UNINJ I', 9),
      qtyRow('LATE', 'LANDF8795', 3),
    ],
  };

  it('adds both Form R surface impoundment lines to land on a breakdown search', async () => {
    stubFakeDmap({
      'tri.tri_facility': [triFacility('47635RCKPR2791N', 'ROCKPORT PLANT', 'IN', 'SPENCER')],
      'tri.tri_reporting_form': [ROCKPORT_BARIUM_FORM],
      'tri.tri_release_qty': ROCKPORT_BARIUM_RELEASE_QTY,
    });

    const {
      items: [barium],
    } = await makeService().searchTriReleases(
      { state: 'IN', county: 'SPENCER', year: 2022, includeReleaseBreakdown: true },
      createMockContext(),
    );

    expect(barium).toMatchObject({
      facilityId: '47635RCKPR2791N',
      releasesToAirInLbs: 552,
      releasesToWaterInLbs: 1100,
      releasesToLandInLbs: 955005,
    });
  });

  it('makes exactly one breakdown request for matches anywhere in the state', async () => {
    const urls = stubFakeDmap(firstAndLast);

    const { items: releases } = await makeService().searchTriReleases(
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

    const { items: releases } = await makeService().searchTriReleases(
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

    const { items: releases } = await makeService().searchTriReleases(
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

    const { items: releases } = await makeService().searchTriReleases(
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
        oneTimeReleaseInLbs: 7,
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

  it('joins the forms to the state facilities in one request ranged 1:limit+1', async () => {
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

    const { items: releases } = await makeService().searchTriReleases(
      { state: 'WA', limit: 1 },
      createMockContext(),
    );

    expect(releases.map((r) => r.facilityId)).toEqual(['FAC1']);
    expect(urls).toEqual([
      `https://data.epa.gov/dmapservice/tri.tri_facility/state_abbr/equals/WA${joinPath}${NEWEST_FIRST_SORT}/1:2/json`,
    ]);
  });

  it('defaults to 50 joined rows, reading one more to see whether more follow', async () => {
    const urls = stubFakeDmap({ 'tri.tri_facility': [], 'tri.tri_reporting_form': [] });

    await makeService().searchTriReleases({ state: 'WA' }, createMockContext());

    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/\/1:51\/json$/);
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

    const { items: releases } = await makeService().searchTriReleases(
      { state: 'WA', county: 'KING', year: 2023, chemicalName: 'chromium compounds', limit: 5 },
      createMockContext(),
    );

    expect(releases).toEqual([]);
    expect(urls).toEqual([
      `https://data.epa.gov/dmapservice/tri.tri_facility/state_abbr/equals/WA/and/county_name/contains/KING${joinPath}/and/reporting_year/equals/2023/and/cas_chem_name/contains/chromium%20compounds${NEWEST_FIRST_SORT}/1:6/json`,
    ]);
  });

  it('encodes a multi-word county and returns nothing when no facility matches', async () => {
    const urls = stubFakeDmap({
      'tri.tri_facility': [triFacility('99701FRBNK', 'FAIRBANKS PLANT', 'AK', 'NORTH SLOPE')],
      'tri.tri_reporting_form': [triForm('F1', '99701FRBNK', 'Lead', 2022)],
    });

    const { items: releases } = await makeService().searchTriReleases(
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
    'tri.tri_release_qty': [qtyRow(`DOC${count - 1}`, 'AIR STACK', 5)],
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

    const { items: releases } = await makeService().searchTriReleases(
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

    const { items: releases } = await makeService().searchTriReleases(
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

    const { items: releases } = await makeService().searchTriReleases(
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

    const { items: releases } = await makeService().searchTriReleases(
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

    const { items: releases } = await makeService().searchTriReleases(
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

    const call = await runToolContract(triSearchReleasesTool, {
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
    const text = textOf(call.content);
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

    const { items: releases } = await makeService().searchTriReleases(
      { state: 'TX', year: 2022, limit: 200, includeReleaseBreakdown: true },
      createMockContext(),
    );

    expect(releases).toEqual([expect.objectContaining({ releasesToAirInLbs: 5 })]);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('/tri.tri_release_qty/doc_ctrl_num/in/DOC1999/');
  });
});

/** WA-style PWSID for system number `n` (1-based). */
const pwsidOf = (n: number) => `WA${String(n).padStart(7, '0')}`;

/** IDs a `sdwis.water_system` URL restricts on through its `pwsid/in/<ids>` filter. */
function pwsidInFilter(url: string): string[] | undefined {
  const match = /\/pwsid\/in\/([^/]+)\//.exec(url);
  return match ? decodeURIComponent(match[1]!).split(',') : undefined;
}

/** The `first:last` range a DMAP URL reads. */
const rangeOf = (url: string) => /\/(\d+:\d+)\/json$/.exec(url)?.[1];

const BY_PWSID_SORT = '/sort/sdwis.water_system.pwsid:asc';
const WATER_SYSTEM_URL = 'https://data.epa.gov/dmapservice/sdwis.water_system';

/** A WA water system row, number `n`, under WA primacy unless `extra` says otherwise. */
const waterSystem = (n: number, extra: DmapRow = {}): DmapRow => ({
  pwsid: pwsidOf(n),
  pws_name: `System ${n}`,
  primacy_agency_code: 'WA',
  ...extra,
});

/**
 * A current-violation lookup over a fixed violator set, recording every scope it is asked about:
 * a state scope answers that state's violators, a PWSID scope the listed ones, each in PWSID
 * order, as EchoService.findCurrentSdwViolators does.
 */
function fakeViolatorLookup(violators: Array<{ pwsid: string; state?: string }>) {
  const scopes: SdwViolatorScope[] = [];
  const lookup: CurrentViolatorLookup = async (scope) => {
    scopes.push(scope);
    const found = violators.filter((v) =>
      'pwsids' in scope ? scope.pwsids.includes(v.pwsid) : (v.state ?? 'WA') === scope.state,
    );
    return { pwsids: new Set(found.map((v) => v.pwsid).sort()) };
  };
  return { lookup, scopes };
}

describe('DmapService.searchWaterSystems paging', () => {
  afterEach(() => vi.restoreAllMocks());

  // Table order is not PWSID order, so only the sort can put System 1 first.
  const shuffled = [3, 1, 5, 2, 4].map((n) => waterSystem(n));

  it('reads limit + 1 rows in PWSID order and reports the next row as nextOffset', async () => {
    const urls = stubFakeDmap({ 'sdwis.water_system': shuffled });

    const page = await makeService().searchWaterSystems(
      { state: 'WA', limit: 2 },
      createMockContext(),
    );

    expect(page.items.map((s) => s.pwsid)).toEqual([pwsidOf(1), pwsidOf(2)]);
    expect(page.nextOffset).toBe(2);
    expect(page).not.toHaveProperty('totalCount');
    expect(urls).toEqual([
      `${WATER_SYSTEM_URL}/primacy_agency_code/equals/WA${BY_PWSID_SORT}/1:3/json`,
    ]);
  });

  it('continues from an unaligned offset to a last page that has no nextOffset', async () => {
    const urls = stubFakeDmap({ 'sdwis.water_system': shuffled });

    const page = await makeService().searchWaterSystems(
      { state: 'WA', offset: 3, limit: 2 },
      createMockContext(),
    );

    expect(page.items.map((s) => s.pwsid)).toEqual([pwsidOf(4), pwsidOf(5)]);
    // offset 3 hides the first rows, so the call never saw the whole match.
    expect(page).toEqual({ items: expect.any(Array) });
    expect(rangeOf(urls[0]!)).toBe('4:6');
  });

  it('returns an empty page with no nextOffset past the end', async () => {
    stubFakeDmap({ 'sdwis.water_system': shuffled });

    const page = await makeService().searchWaterSystems(
      { state: 'WA', offset: 50, limit: 2 },
      createMockContext(),
    );

    expect(page).toEqual({ items: [] });
  });

  it('sets totalCount when one page from offset 0 holds the whole match', async () => {
    stubFakeDmap({ 'sdwis.water_system': shuffled });

    const page = await makeService().searchWaterSystems(
      { state: 'WA', limit: 50 },
      createMockContext(),
    );

    expect(page.items).toHaveLength(5);
    expect(page.totalCount).toBe(5);
    expect(page).not.toHaveProperty('nextOffset');
  });

  it('matches stored ZIP+4 and nine-digit ZIPs by their five-digit prefix', async () => {
    const urls = stubFakeDmap({
      'sdwis.water_system': [
        waterSystem(1, { zip_code: '98104' }),
        waterSystem(2, { zip_code: '98104-3122' }),
        waterSystem(3, { zip_code: '981042017' }),
        waterSystem(4, { zip_code: '98105' }),
      ],
    });

    const page = await makeService().searchWaterSystems({ zipCode: '98104' }, createMockContext());

    expect(page.items.map((s) => s.zip)).toEqual(['98104', '98104-3122', '981042017']);
    expect(urls[0]).toBe(`${WATER_SYSTEM_URL}/zip_code/beginsWith/98104${BY_PWSID_SORT}/1:51/json`);
  });

  it('active_only keeps only activity code A; without it every code returns', async () => {
    const tables = {
      'sdwis.water_system': [
        waterSystem(1, { pws_activity_code: 'A' }),
        waterSystem(2, { pws_activity_code: 'I' }),
        waterSystem(3, { pws_activity_code: 'N' }),
      ],
    };
    const urls = stubFakeDmap(tables);

    const active = await makeService().searchWaterSystems(
      { state: 'WA', activeOnly: true },
      createMockContext(),
    );
    const all = await makeService().searchWaterSystems({ state: 'WA' }, createMockContext());

    expect(active.items.map((s) => s.pwsid)).toEqual([pwsidOf(1)]);
    expect(all.items).toHaveLength(3);
    expect(urls[0]).toContain('/primacy_agency_code/equals/WA/and/pws_activity_code/equals/A/');
    expect(urls[1]).not.toContain('pws_activity_code');
  });

  it.each([
    ['community', 'CWS'],
    ['non-transient', 'NTNCWS'],
    ['transient', 'TNCWS'],
  ] as const)('sends pws_type %s as pws_type_code %s', async (pwsType, code) => {
    const urls = stubFakeDmap({ 'sdwis.water_system': [] });

    await makeService().searchWaterSystems({ state: 'WA', pwsType }, createMockContext());

    expect(urls[0]).toContain(`/pws_type_code/equals/${code}/`);
  });
});

/** sdwis.geographic_area rows: one per system, with its counties served. */
const servedBy = (systems: DmapRow[]): DmapRow[] =>
  systems.map((s) => ({ pwsid: s.pwsid, county_served: s.county_served ?? null }));

/** Fake DMAP tables for systems that carry their `county_served` in the geographic_area table. */
function countyTables(systems: DmapRow[]) {
  return {
    'sdwis.water_system': systems.map(({ county_served: _, ...system }) => system),
    'sdwis.geographic_area': servedBy(systems),
  };
}

describe('DmapService.searchWaterSystems county served', () => {
  afterEach(() => vi.restoreAllMocks());

  const tx = (n: number, county: string) =>
    waterSystem(n, {
      pwsid: `TX${String(n).padStart(7, '0')}`,
      primacy_agency_code: 'TX',
      county_served: county,
    });

  it('joins geographic_area and keeps only systems serving the whole county', async () => {
    const urls = stubFakeDmap(
      countyTables([tx(1, 'Harris'), tx(2, 'Harrison'), tx(3, 'Harris'), tx(4, 'Dallas')]),
    );

    const page = await makeService().searchWaterSystems(
      { state: 'TX', county: 'HARRIS' },
      createMockContext(),
    );

    expect(page.items.map((s) => s.pwsid)).toEqual(['TX0000001', 'TX0000003']);
    expect(page.totalCount).toBe(2);
    expect(urls).toEqual([
      `${WATER_SYSTEM_URL}/primacy_agency_code/equals/TX/join/sdwis.geographic_area/pwsid/equals/pwsid/and/county_served/contains/HARRIS${BY_PWSID_SORT}/1:100/json`,
    ]);
  });

  it.each(['DALLAS', 'JOHNSON'])(
    'matches %s against each entry of a comma-joined county list',
    async (county) => {
      stubFakeDmap(countyTables([tx(1, 'Dallas,Johnson'), tx(2, 'Johnson County Line')]));

      const page = await makeService().searchWaterSystems(
        { state: 'TX', county },
        createMockContext(),
      );

      expect(page.items.map((s) => s.pwsid)).toEqual(['TX0000001']);
    },
  );

  it.each([
    [
      'a stored Parish suffix',
      'CALCASIEU',
      'Calcasieu Parish',
      'Calcasieu Lake Parish',
      'CALCASIEU',
    ],
    [
      'a period, sent as a wildcard',
      'ST. TAMMANY',
      'St. Tammany Parish',
      'St Tammany Parish',
      'ST_%20TAMMANY',
    ],
    [
      'an independent city beside its county',
      'BALTIMORE',
      'Baltimore',
      'Baltimore city',
      'BALTIMORE',
    ],
  ])('handles %s', async (_, county, stored, other, sent) => {
    const urls = stubFakeDmap(countyTables([tx(1, stored), tx(2, other)]));

    const page = await makeService().searchWaterSystems(
      { state: 'TX', county },
      createMockContext(),
    );

    expect(page.items.map((s) => s.pwsid)).toEqual(['TX0000001']);
    expect(urls[0]).toContain(`/county_served/contains/${sent}/`);
  });

  it('pages past rows the county test drops, each system once, in PWSID order', async () => {
    // PWSID order: 50 Harris systems, 70 Harrison, then 30 more Harris.
    const systems = Array.from({ length: 150 }, (_, i) =>
      tx(i + 1, i >= 50 && i < 120 ? 'Harrison' : 'Harris'),
    );
    const urls = stubFakeDmap(countyTables(systems));
    const service = makeService();

    const first = await service.searchWaterSystems(
      { state: 'TX', county: 'HARRIS', limit: 60 },
      createMockContext(),
    );
    const second = await service.searchWaterSystems(
      { state: 'TX', county: 'HARRIS', offset: first.nextOffset!, limit: 60 },
      createMockContext(),
    );

    // The first page takes Harris 1–50 and 121–130; the 61st match is row 131 (position 130).
    expect(first.items).toHaveLength(60);
    expect(first.nextOffset).toBe(130);
    expect(first).not.toHaveProperty('totalCount');
    expect(second.items.map((s) => s.pwsid)).toEqual(
      Array.from({ length: 20 }, (_, i) => `TX${String(i + 131).padStart(7, '0')}`),
    );
    expect(second).not.toHaveProperty('nextOffset');
    const seen = [...first.items, ...second.items].map((s) => s.pwsid);
    expect(new Set(seen).size).toBe(80);
    expect(seen).toEqual(seen.toSorted());
    expect(urls.map(rangeOf)).toEqual(['1:100', '101:200', '131:230']);
  });

  it('discloses a county walk its page limit ends short, continuing at the next row', async () => {
    const systems = [
      tx(1, 'Harris'),
      ...Array.from({ length: 349 }, (_, i) => tx(i + 2, 'Harrison')),
    ];
    stubFakeDmap(countyTables(systems));
    const ctx = createMockContext();

    const page = await makeService().searchWaterSystems(
      { state: 'TX', county: 'HARRIS', limit: 5 },
      ctx,
    );

    expect(page.items.map((s) => s.pwsid)).toEqual(['TX0000001']);
    expect(page.nextOffset).toBe(300);
    expect(getEnrichment(ctx)).toMatchObject({
      notice:
        '"HARRIS" was matched as part of a longer value and kept only as a whole entry, and the first 300 rows containing it held 1 match, so more may exist past them. Continue from nextOffset.',
    });
  });

  it.each([
    ['no letter or digit', '...', 'unmatchable_filter'],
    ['a name too long for one request', 'K'.repeat(4000), 'filter_too_long'],
  ])('rejects a county with %s before any request', async (_, county, reason) => {
    const urls = stubFakeDmap(countyTables([tx(1, 'Harris')]));

    await expect(
      makeService().searchWaterSystems({ state: 'TX', county }, createMockContext()),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError, data: { reason } });
    expect(urls).toEqual([]);
  });
});

describe('DmapService.searchWaterSystems current violators in a state', () => {
  afterEach(() => vi.restoreAllMocks());

  it('asks for the state violator list, then reads those rows under the state primacy filter', async () => {
    // ECHO's WA list also names a system in WA under EPA Region 10 primacy.
    const regionTen = { pwsid: '105300001', pws_name: 'Tribal System', primacy_agency_code: '10' };
    const urls = stubFakeDmap({
      'sdwis.water_system': [waterSystem(1), waterSystem(2), waterSystem(3), regionTen],
    });
    const { lookup, scopes } = fakeViolatorLookup([
      { pwsid: pwsidOf(3) },
      { pwsid: pwsidOf(1) },
      { pwsid: '105300001' },
    ]);

    const page = await makeService().searchWaterSystems(
      { state: 'WA', currentViolators: lookup },
      createMockContext(),
    );

    expect(page).toEqual({
      items: [
        expect.objectContaining({ pwsid: pwsidOf(1), hasViolation: true }),
        expect.objectContaining({ pwsid: pwsidOf(3), hasViolation: true }),
      ],
      totalCount: 2,
    });
    expect(scopes).toEqual([{ state: 'WA' }]);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(
      /\/sdwis\.water_system\/primacy_agency_code\/equals\/WA\/and\/pwsid\/in\/[^/]+\/1:3\/json$/,
    );
    expect(pwsidInFilter(urls[0]!)).toEqual(['105300001', pwsidOf(1), pwsidOf(3)]);
  });

  it('passes pws_type to the lookup and keeps active_only on the row read', async () => {
    const urls = stubFakeDmap({
      'sdwis.water_system': [waterSystem(1, { pws_type_code: 'NTNCWS', pws_activity_code: 'A' })],
    });
    const { lookup, scopes } = fakeViolatorLookup([{ pwsid: pwsidOf(1) }]);

    const page = await makeService().searchWaterSystems(
      { state: 'WA', pwsType: 'non-transient', activeOnly: true, currentViolators: lookup },
      createMockContext(),
    );

    expect(page.items.map((s) => s.pwsid)).toEqual([pwsidOf(1)]);
    expect(scopes).toEqual([{ state: 'WA', systemType: 'non-transient' }]);
    expect(urls[0]).toContain(
      '/primacy_agency_code/equals/WA/and/pws_type_code/equals/NTNCWS/and/pws_activity_code/equals/A/and/pwsid/in/',
    );
  });

  it('pages by violator-list position across 200-PWSID slices, each system once', async () => {
    // 450 violators; every third has no row under WA primacy, so the read keeps two of three.
    const violators = Array.from({ length: 450 }, (_, i) => ({ pwsid: pwsidOf(i + 1) }));
    const rows = violators.flatMap((_, i) => (i % 3 === 2 ? [] : [waterSystem(i + 1)]));
    const urls = stubFakeDmap({ 'sdwis.water_system': rows });
    const { lookup } = fakeViolatorLookup(violators);
    const service = makeService();

    const pages = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page = await service.searchWaterSystems(
        { state: 'WA', currentViolators: lookup, offset, limit: 150 },
        createMockContext(),
      );
      pages.push(page);
      offset = page.nextOffset;
    }

    // Slices 0–199 and 200–399 keep 267 > 150, so the 151st kept system (position 225) is next.
    expect(pages.map((p) => [p.items.length, p.nextOffset])).toEqual([
      [150, 225],
      [150, undefined],
    ]);
    expect(pages[0]).not.toHaveProperty('totalCount');
    const seen = pages.flatMap((p) => p.items.map((s) => s.pwsid));
    expect(seen).toEqual(rows.map((r) => r.pwsid));
    const slices = urls.map((u) => pwsidInFilter(u) ?? []);
    expect(slices.map((ids) => ids.length)).toEqual([200, 200, 200, 25]);
    expect(slices[2]![0]).toBe(pwsidOf(226));
  });

  it('reports totalCount beside nextOffset when one slice held the whole list', async () => {
    const violators = Array.from({ length: 166 }, (_, i) =>
      i < 40 ? { pwsid: `10${String(i).padStart(7, '0')}` } : { pwsid: pwsidOf(i) },
    );
    stubFakeDmap({
      'sdwis.water_system': [
        ...violators.slice(0, 40).map((v) => ({ pwsid: v.pwsid, primacy_agency_code: '10' })),
        ...violators.slice(40).map((v) => waterSystem(Number(v.pwsid.slice(2)))),
      ],
    });
    const { lookup } = fakeViolatorLookup(violators);

    const page = await makeService().searchWaterSystems(
      { state: 'WA', currentViolators: lookup, limit: 50 },
      createMockContext(),
    );

    expect(page.items).toHaveLength(50);
    expect(page.totalCount).toBe(126);
    expect(page.nextOffset).toBe(90);
  });

  it('makes no DMAP request when the lookup reports no violators', async () => {
    const urls = stubFakeDmap({ 'sdwis.water_system': [waterSystem(1)] });
    const { lookup } = fakeViolatorLookup([]);

    const page = await makeService().searchWaterSystems(
      { state: 'WA', currentViolators: lookup },
      createMockContext(),
    );

    expect(page).toEqual({ items: [], totalCount: 0 });
    expect(urls).toEqual([]);
  });

  it('returns an empty page past the end of the violator list', async () => {
    const urls = stubFakeDmap({ 'sdwis.water_system': [waterSystem(1)] });
    const { lookup } = fakeViolatorLookup([{ pwsid: pwsidOf(1) }]);

    const page = await makeService().searchWaterSystems(
      { state: 'WA', currentViolators: lookup, offset: 5 },
      createMockContext(),
    );

    expect(page).toEqual({ items: [] });
    expect(urls).toEqual([]);
  });
});

describe("DmapService.searchWaterSystems current violators among a ZIP's or county's systems", () => {
  afterEach(() => vi.restoreAllMocks());

  const zipSystems = (count: number) =>
    Array.from({ length: count }, (_, i) => waterSystem(i + 1, { zip_code: '98104' }));

  it("reads the ZIP's systems in one request, then looks them up by PWSID", async () => {
    const urls = stubFakeDmap({ 'sdwis.water_system': zipSystems(5) });
    // WA0000099 is a violator outside the ZIP; it must not appear.
    const { lookup, scopes } = fakeViolatorLookup([2, 4, 99].map((n) => ({ pwsid: pwsidOf(n) })));

    const page = await makeService().searchWaterSystems(
      { state: 'WA', zipCode: '98104', currentViolators: lookup },
      createMockContext(),
    );

    expect(page).toEqual({
      items: [
        expect.objectContaining({ pwsid: pwsidOf(2), hasViolation: true }),
        expect.objectContaining({ pwsid: pwsidOf(4), hasViolation: true }),
      ],
      totalCount: 2,
    });
    expect(scopes).toEqual([{ pwsids: [1, 2, 3, 4, 5].map(pwsidOf) }]);
    expect(urls).toEqual([
      `${WATER_SYSTEM_URL}/primacy_agency_code/equals/WA/and/zip_code/beginsWith/98104${BY_PWSID_SORT}/1:1000/json`,
    ]);
  });

  it("checks a county's systems by PWSID after the whole-county test", async () => {
    const tx = (n: number, county: string) =>
      waterSystem(n, { pwsid: `TX${n}`, primacy_agency_code: 'TX', county_served: county });
    const urls = stubFakeDmap(countyTables([tx(1, 'Harris'), tx(2, 'Harrison'), tx(3, 'Harris')]));
    const { lookup, scopes } = fakeViolatorLookup(['TX1', 'TX2'].map((pwsid) => ({ pwsid })));

    const page = await makeService().searchWaterSystems(
      { state: 'TX', county: 'HARRIS', currentViolators: lookup },
      createMockContext(),
    );

    expect(page.items.map((s) => s.pwsid)).toEqual(['TX1']);
    expect(scopes).toEqual([{ pwsids: ['TX1', 'TX3'] }]);
    expect(rangeOf(urls[0]!)).toBe('1:1000');
    expect(urls[0]).toContain('/join/sdwis.geographic_area/');
  });

  it('looks up 200 PWSIDs at a time and stops once limit + 1 violators are found', async () => {
    stubFakeDmap({ 'sdwis.water_system': zipSystems(450) });
    const { lookup, scopes } = fakeViolatorLookup(
      [5, 150, 250, 300].map((n) => ({ pwsid: pwsidOf(n) })),
    );

    const page = await makeService().searchWaterSystems(
      { zipCode: '98104', currentViolators: lookup, limit: 2 },
      createMockContext(),
    );

    expect(page.items.map((s) => s.pwsid)).toEqual([pwsidOf(5), pwsidOf(150)]);
    // The third violator, WA0000250, sits at row position 249.
    expect(page.nextOffset).toBe(249);
    expect(page).not.toHaveProperty('totalCount');
    expect(scopes.map((s) => ('pwsids' in s ? s.pwsids.length : 0))).toEqual([200, 200]);
  });

  it('continues a full read that leaves the page short from the next row, with a notice', async () => {
    const urls = stubFakeDmap({ 'sdwis.water_system': zipSystems(1200) });
    const { lookup, scopes } = fakeViolatorLookup([{ pwsid: pwsidOf(1100) }]);
    const ctx = createMockContext();
    const service = makeService();

    const first = await service.searchWaterSystems(
      { zipCode: '98104', currentViolators: lookup, limit: 10 },
      ctx,
    );
    const second = await service.searchWaterSystems(
      { zipCode: '98104', currentViolators: lookup, offset: first.nextOffset!, limit: 10 },
      createMockContext(),
    );

    expect(first).toEqual({ items: [], nextOffset: 1000 });
    expect(getEnrichment(ctx)).toMatchObject({
      notice:
        'The violation check read 1,000 systems from offset 0 and found 0 with a current violation; systems from offset 1,000 on were not checked in this call.',
    });
    expect(second.items.map((s) => s.pwsid)).toEqual([pwsidOf(1100)]);
    expect(second).not.toHaveProperty('nextOffset');
    expect(scopes).toHaveLength(6);
    expect(urls.map(rangeOf)).toEqual(['1:1000', '1001:2000']);
  });

  it('makes no lookup when the ZIP has no systems', async () => {
    stubFakeDmap({ 'sdwis.water_system': [] });
    const { lookup, scopes } = fakeViolatorLookup([{ pwsid: pwsidOf(1) }]);

    const page = await makeService().searchWaterSystems(
      { zipCode: '00000', currentViolators: lookup },
      createMockContext(),
    );

    expect(page).toEqual({ items: [], totalCount: 0 });
    expect(scopes).toEqual([]);
  });
});

describe('DmapService one-based row ranges', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getTriReleases requests 501 reporting-form rows and returns 500 with the next offset', async () => {
    const forms = Array.from({ length: 600 }, (_, i) => ({
      tri_facility_id: 'FAC1',
      cas_chem_name: `Chemical ${i + 1}`,
      reporting_year: '2022',
    }));
    const urls = stubPagedDmapFetch([{ match: '/tri.tri_reporting_form/', table: forms }]);

    const page = await makeService().getTriReleases({ facilityId: 'FAC1' }, createMockContext());

    expect(page.items).toHaveLength(500);
    expect(page.items.at(-1)?.chemicalName).toBe('Chemical 500');
    expect(page.nextOffset).toBe(500);
    expect(urls[0]).toContain('/1:501/json');
  });

  it('fetchReleaseBreakdown reads 30 rows per submission, the last one included', async () => {
    const qty = ['D1', 'D2'].flatMap((doc) =>
      Array.from({ length: 30 }, () => qtyRow(doc, 'AIR FUG', 1)),
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

    const { items: releases } = await makeService().getTriReleases(
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

    expect(result.items.map((s) => s.siteId)).toEqual(['S1', 'S2', 'S3']);
    expect(result.nextOffset).toBe(3);
    expect(urls[0]).toContain(
      '/fk_ref_state_code/equals/WA/sort/sems.envirofacts_site.site_id:asc/1:4/json',
    );
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

    expect(result.items.map((s) => s.siteId)).toEqual(['S20']);
    expect(urls[0]).toContain('/1:500/json');
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
    qtyRow('1324222469734', 'AIR STACK', 0.5),
    qtyRow('1392060208939', 'AIR FUG', 750),
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

    const { items: releases } = await makeService().searchTriReleases(
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
      `https://data.epa.gov/dmapservice/tri.tri_facility/state_abbr/equals/AK${joinPath}${NEWEST_FIRST_SORT}/1:7/json`,
    ]);
  });

  it('a smaller limit returns a prefix of a larger one', async () => {
    stubFakeDmap(AK_TABLES);
    const { items: first3 } = await makeService().searchTriReleases(
      { state: 'AK', limit: 3 },
      createMockContext(),
    );
    const { items: all } = await makeService().searchTriReleases(
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
    const { items: releases } = await makeService().searchTriReleases(
      { state: 'AK', county: 'BOROUGH', chemicalName: 'lead', limit: 1 },
      createMockContext(),
    );

    expect(releases.map(yearDoc)).toEqual(['2024 99901SCSTG1300S Lead']);
    expect(urls).toEqual([
      `https://data.epa.gov/dmapservice/tri.tri_facility/state_abbr/equals/AK/and/county_name/contains/BOROUGH${joinPath}/and/cas_chem_name/contains/lead${NEWEST_FIRST_SORT}/1:2/json`,
    ]);
  });

  it('with year sorts on the submission number instead of keeping table order', async () => {
    const urls = stubFakeDmap(AK_TABLES);

    const { items: releases } = await makeService().searchTriReleases(
      { state: 'AK', year: 2024, limit: 5 },
      createMockContext(),
    );

    expect(releases.map(yearDoc)).toEqual([
      '2024 99901SCSTG1300S Lead',
      '2024 99752RDDGP90MIL Cyanide compounds',
      '2024 99752RDDGP90MIL Ammonia',
      '2024 99752RDDGP90MIL Lead compounds',
    ]);
    expect(urls).toEqual([
      `https://data.epa.gov/dmapservice/tri.tri_facility/state_abbr/equals/AK${joinPath}/and/reporting_year/equals/2024${NEWEST_FIRST_SORT}/1:6/json`,
    ]);
  });

  it('adds the breakdown to the sorted records it keeps', async () => {
    const urls = stubFakeDmap(AK_TABLES);

    const { items: releases } = await makeService().searchTriReleases(
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
        totalOnSiteReleasesInLbs: 0.5,
      },
    ]);
    expect(urls[1]).toBe(
      'https://data.epa.gov/dmapservice/tri.tri_release_qty/doc_ctrl_num/in/1324222469734/1:30/json',
    );
  });

  it('carries the newest-first records on both tool surfaces', async () => {
    initDmapService({} as AppConfig, {} as StorageService);
    stubFakeDmap(AK_TABLES);

    const call = await runToolContract(triSearchReleasesTool, { state: 'AK', limit: 2 });

    expect(call.isError).toBeFalsy();
    const structured = call.structuredContent as { releases: Array<Record<string, unknown>> };
    expect(structured.releases.map((r) => r.reportingYear)).toEqual([2024, 2024]);
    const text = textOf(call.content);
    const headings = text.split('\n').filter((line) => line.startsWith('### '));
    expect(headings).toEqual([
      '### Lead — U.S. COAST GUARD BASE KETCHIKAN (99901SCSTG1300S) (2024)',
      '### Cyanide compounds — RED DOG OPERATIONS (99752RDDGP90MIL) (2024)',
    ]);
  });
});

describe('DmapService TRI paging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const joinPath = '/join/tri.tri_reporting_form/tri_facility_id/equals/tri_facility_id';
  const docsOf = (releases: unknown[], tables: Record<string, DmapRow[]>) =>
    releases.map((release) => {
      const { facilityId, chemicalName, reportingYear } = release as Record<string, unknown>;
      return tables['tri.tri_reporting_form']!.find(
        (form) =>
          form.tri_facility_id === facilityId &&
          form.cas_chem_name === chemicalName &&
          Number(form.reporting_year) === reportingYear,
      )?.doc_ctrl_num;
    });
  const rangeOf = (url: string) => /\/(\d+:\d+)\/json$/.exec(url)?.[1];

  it('searchTriReleases reads offset+1 through offset+limit+1 and returns nextOffset only while records follow', async () => {
    const urls = stubFakeDmap(AK_TABLES);
    const service = makeService();
    const all = await service.searchTriReleases({ state: 'AK', limit: 7 }, createMockContext());
    expect(all.items).toHaveLength(7);
    expect(all).not.toHaveProperty('nextOffset');

    const pages = [];
    for (const offset of [0, 3, 6, 7, 40]) {
      pages.push(
        await service.searchTriReleases({ state: 'AK', offset, limit: 3 }, createMockContext()),
      );
    }

    expect(urls.slice(1).map(rangeOf)).toEqual(['1:4', '4:7', '7:10', '8:11', '41:44']);
    expect(urls[1]).toBe(
      `https://data.epa.gov/dmapservice/tri.tri_facility/state_abbr/equals/AK${joinPath}${NEWEST_FIRST_SORT}/1:4/json`,
    );
    expect(pages.map((page) => page.nextOffset)).toEqual([3, 6, undefined, undefined, undefined]);
    expect(pages.map((page) => page.items.length)).toEqual([3, 3, 1, 0, 0]);
    // The walk returns every record once, in the order one larger read returns them.
    expect(
      docsOf(
        pages.flatMap((page) => page.items),
        AK_TABLES,
      ),
    ).toEqual(docsOf(all.items, AK_TABLES));
  });

  it('searchTriReleases sorts a single-year search on the submission number too', async () => {
    const urls = stubFakeDmap(AK_TABLES);

    const page = await makeService().searchTriReleases(
      { state: 'AK', year: 2024, offset: 1, limit: 2 },
      createMockContext(),
    );

    expect(urls).toEqual([
      `https://data.epa.gov/dmapservice/tri.tri_facility/state_abbr/equals/AK${joinPath}/and/reporting_year/equals/2024${NEWEST_FIRST_SORT}/2:4/json`,
    ]);
    // 2024 forms by submission number: …469734, …523639, …523641, …523654.
    expect(docsOf(page.items, AK_TABLES)).toEqual(['1324222523639', '1324222523641']);
    expect(page.nextOffset).toBe(3);
  });

  it('getTriReleases pages a facility newest first and reads the breakdown for the page only', async () => {
    const forms = Array.from({ length: 7 }, (_, n) =>
      triForm(`D${n}`, '47635RCKPR2791N', `Chemical ${n}`, 2020 + n),
    );
    const tables = {
      'tri.tri_reporting_form': forms,
      'tri.tri_release_qty': forms.map((form, n) =>
        qtyRow(form.doc_ctrl_num, 'AIR STACK', n, '0', null),
      ),
    };
    const urls = stubFakeDmap(tables);
    const service = makeService();

    const first = await service.getTriReleases(
      { facilityId: '47635RCKPR2791N', limit: 5 },
      createMockContext(),
    );
    const second = await service.getTriReleases(
      { facilityId: '47635RCKPR2791N', offset: 5, limit: 5 },
      createMockContext(),
    );
    const pastEnd = await service.getTriReleases(
      { facilityId: '47635RCKPR2791N', offset: 7, limit: 5 },
      createMockContext(),
    );

    expect(first.items.map((r) => r.reportingYear)).toEqual([2026, 2025, 2024, 2023, 2022]);
    expect(first.nextOffset).toBe(5);
    expect(second.items.map((r) => r.reportingYear)).toEqual([2021, 2020]);
    expect(second).not.toHaveProperty('nextOffset');
    expect(pastEnd).toEqual({ items: [] });
    const formUrls = urls.filter((url) => url.includes('/tri.tri_reporting_form/'));
    expect(formUrls.map(rangeOf)).toEqual(['1:6', '6:11', '8:13']);
    expect(formUrls[0]).toContain(`${NEWEST_FIRST_SORT}/1:6/json`);
    // The sixth row only proves more follow; its breakdown is never requested.
    expect(breakdownUrlsOf(urls).map(docInFilter)).toEqual([
      ['D6', 'D5', 'D4', 'D3', 'D2'],
      ['D1', 'D0'],
    ]);
  });

  it('getTriReleases sorts a single-year lookup on the submission number too', async () => {
    const urls = stubFakeDmap({ 'tri.tri_reporting_form': [], 'tri.tri_release_qty': [] });

    await makeService().getTriReleases({ facilityId: 'FAC', year: 2022 }, createMockContext());

    expect(urls).toEqual([
      `https://data.epa.gov/dmapservice/tri.tri_reporting_form/tri_facility_id/equals/FAC/and/reporting_year/equals/2022${NEWEST_FIRST_SORT}/1:501/json`,
    ]);
  });

  /**
   * One facility-year in submission order: an exact "C.I." name, 149 wildcard near-variants
   * (C_I_ also matches CHIC), then two more exact names.
   */
  const ciForms = () => [
    triForm('D000', BOEING, 'C.I. Red', 2023),
    ...Array.from({ length: 149 }, (_, n) =>
      triForm(`D${String(n + 1).padStart(3, '0')}`, BOEING, 'CHIC SOLVENT', 2023),
    ),
    triForm('D150', BOEING, 'C.I. Blue', 2023),
    triForm('D151', BOEING, 'C.I. Green', 2023),
  ];

  it('continues a punctuated filter from the next upstream position, past the rows it dropped', async () => {
    const urls = stubFakeDmap({ 'tri.tri_reporting_form': ciForms(), 'tri.tri_release_qty': [] });
    const service = makeService();
    const lookup = (offset: number) =>
      service.getTriReleases(
        { facilityId: BOEING, chemicalName: 'C.I.', offset, limit: 1 },
        createMockContext(),
      );

    const first = await lookup(0);
    const second = await lookup(first.nextOffset!);
    const third = await lookup(second.nextOffset!);

    expect([first, second, third].map((page) => chemicalsOf(page.items))).toEqual([
      ['C.I. Red'],
      ['C.I. Blue'],
      ['C.I. Green'],
    ]);
    expect([first.nextOffset, second.nextOffset, third.nextOffset]).toEqual([150, 151, undefined]);
    expect(urls.filter((url) => url.includes('/tri.tri_reporting_form/')).map(rangeOf)).toEqual([
      '1:100',
      '101:200',
      '151:250',
      '152:251',
    ]);
  });

  it('a punctuated walk cut short by its page limit returns where it stopped, with the notice', async () => {
    const forms = [
      ...Array.from({ length: 400 }, (_, n) =>
        triForm(`D${String(n).padStart(3, '0')}`, BOEING, 'CHIC SOLVENT', 2023),
      ),
      triForm('D400', BOEING, 'C.I. Blue', 2023),
    ];
    stubFakeDmap({ 'tri.tri_reporting_form': forms, 'tri.tri_release_qty': [] });
    const ctx = createMockContext();

    const page = await makeService().getTriReleases(
      { facilityId: BOEING, chemicalName: 'C.I.', offset: 50, limit: 5 },
      ctx,
    );

    expect(page).toEqual({ items: [], nextOffset: 350 });
    expect(getEnrichment(ctx)).toEqual({
      notice:
        '"C.I." was searched with a one-character wildcard in place of punctuation, and the 300 rows matching the wildcard after offset 50 held 0 matches spelled as given, so more may exist past them. Narrow the search with other filters or more of the text.',
    });
  });

  it('a punctuated page that finds limit+1 matches stops there and adds no notice', async () => {
    const forms = Array.from({ length: 600 }, (_, n) =>
      triForm(`D${String(n).padStart(3, '0')}`, BOEING, `C.I. Dye ${n}`, 2023),
    );
    const urls = stubFakeDmap({ 'tri.tri_reporting_form': forms, 'tri.tri_release_qty': [] });
    const ctx = createMockContext();

    const page = await makeService().getTriReleases(
      { facilityId: BOEING, chemicalName: 'C.I.' },
      ctx,
    );

    expect(page.items).toHaveLength(500);
    expect(page.nextOffset).toBe(500);
    expect(urls.filter((url) => url.includes('/tri.tri_reporting_form/')).map(rangeOf)).toEqual([
      '1:501',
    ]);
    expect(getEnrichment(ctx)).toEqual({});
  });
});

describe('DmapService TRI release totals and facility identifiers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names the one-time quantity oneTimeReleaseInLbs and sums the present media into an on-site total', async () => {
    stubFakeDmap({
      'tri.tri_reporting_form': [{ ...ROCKPORT_BARIUM_FORM, one_time_release_qty: 12 }],
      'tri.tri_release_qty': ROCKPORT_BARIUM_RELEASE_QTY,
    });

    const { items } = await makeService().getTriReleases(
      { facilityId: '47635RCKPR2791N', year: 2022 },
      createMockContext(),
    );

    expect(items).toEqual([
      {
        facilityId: '47635RCKPR2791N',
        chemicalName: ROCKPORT_BARIUM_FORM.cas_chem_name,
        reportingYear: 2022,
        oneTimeReleaseInLbs: 12,
        releasesToAirInLbs: 552,
        releasesToWaterInLbs: 1100,
        releasesToLandInLbs: 955005,
        // 552 + 1,100 + 955,005; the one-time quantity is already inside these.
        totalOnSiteReleasesInLbs: 956657,
      },
    ]);
    expect(items[0]).not.toHaveProperty('totalReleasesInLbs');
  });

  it('sums a gram-reported form after converting each medium, rounded like the media', async () => {
    stubFakeDmap({
      'tri.tri_reporting_form': DIOXIN_FACILITY_FORMS,
      'tri.tri_release_qty': DIOXIN_FACILITY_RELEASE_QTY,
    });

    const { items } = await makeService().getTriReleases(
      { facilityId: '96020CLLNS500MA', year: 2022 },
      createMockContext(),
    );
    const dioxin = items.find((r) => r.reportedUnit === 'grams');

    expect(dioxin).toMatchObject({
      oneTimeReleaseInLbs: 0.0044092452437,
      releasesToAirInLbs: 0.000162952476471,
      releasesToLandInLbs: 1.28066528103e-6,
      // 0.000162952476471 + 0.00000128066528103, to 12 significant digits.
      totalOnSiteReleasesInLbs: 0.000164233141752,
    });
    expect(items.find((r) => r.chemicalName === 'Lead compounds')).toMatchObject({
      totalOnSiteReleasesInLbs: 28.51,
    });
  });

  it('carries no on-site total when no medium has a hard quantity', async () => {
    stubFakeDmap({
      'tri.tri_reporting_form': [triForm('D-NA', '47635RCKPR2791N', 'Mercury', 2022)],
      'tri.tri_release_qty': [
        qtyRow('D-NA', 'SI 5.5.3A', null, '1', null),
        qtyRow('D-NA', 'SI 5.5.3B', null, '0', '2'),
      ],
    });

    const { items } = await makeService().getTriReleases(
      { facilityId: '47635RCKPR2791N' },
      createMockContext(),
    );

    expect(items).toEqual([
      { facilityId: '47635RCKPR2791N', chemicalName: 'Mercury', reportingYear: 2022 },
    ]);
  });

  it('returns the Registry ID and parent company from the search rows, with no added request', async () => {
    const urls = stubFakeDmap({
      'tri.tri_facility': [
        {
          ...triFacility('9867WSNRWD1981S', 'WOODLAND USNR LLC', 'WA', 'COWLITZ'),
          epa_registry_id: '110070322017',
          standardized_parent_company: 'WOOD TECHNOLOGIES INTERNATIONAL',
        },
        {
          ...triFacility('98421STMPS', 'NO PARENT PLANT', 'WA', 'PIERCE'),
          epa_registry_id: '110000460402',
          standardized_parent_company: 'NA',
        },
        {
          ...triFacility('98001OLDPL', 'UNREGISTERED PLANT', 'WA', 'KING'),
          epa_registry_id: null,
          standardized_parent_company: null,
        },
      ],
      'tri.tri_reporting_form': [
        triForm('D1', '9867WSNRWD1981S', 'Chromium', 2022),
        triForm('D2', '98421STMPS', 'Lead', 2022),
        triForm('D3', '98001OLDPL', 'Zinc', 2022),
      ],
    });

    const { items } = await makeService().searchTriReleases(
      { state: 'WA', year: 2022 },
      createMockContext(),
    );

    expect(urls).toHaveLength(1);
    expect(items).toEqual([
      {
        facilityId: '9867WSNRWD1981S',
        facilityName: 'WOODLAND USNR LLC',
        countyName: 'COWLITZ',
        registryId: '110070322017',
        parentCompany: 'WOOD TECHNOLOGIES INTERNATIONAL',
        chemicalName: 'Chromium',
        reportingYear: 2022,
      },
      {
        facilityId: '98421STMPS',
        facilityName: 'NO PARENT PLANT',
        countyName: 'PIERCE',
        registryId: '110000460402',
        chemicalName: 'Lead',
        reportingYear: 2022,
      },
      {
        facilityId: '98001OLDPL',
        facilityName: 'UNREGISTERED PLANT',
        countyName: 'KING',
        chemicalName: 'Zinc',
        reportingYear: 2022,
      },
    ]);
  });

  it('a search without the breakdown carries no on-site total', async () => {
    stubFakeDmap({
      'tri.tri_facility': [triFacility('47635RCKPR2791N', 'ROCKPORT PLANT', 'IN', 'SPENCER')],
      'tri.tri_reporting_form': [ROCKPORT_BARIUM_FORM],
      'tri.tri_release_qty': ROCKPORT_BARIUM_RELEASE_QTY,
    });
    const service = makeService();

    const without = await service.searchTriReleases({ state: 'IN' }, createMockContext());
    const withBreakdown = await service.searchTriReleases(
      { state: 'IN', includeReleaseBreakdown: true },
      createMockContext(),
    );

    expect(without.items[0]).not.toHaveProperty('totalOnSiteReleasesInLbs');
    expect(withBreakdown.items[0]).toMatchObject({ totalOnSiteReleasesInLbs: 956657 });
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
      ...middle.map((form, n) => qtyRow(form.doc_ctrl_num, 'AIR STACK', n + 1)),
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

    const { items: releases } = await makeService().getTriReleases(
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
      totalOnSiteReleasesInLbs: 0,
    });
    // Live 2024 form sorts first; the older form remains in a later breakdown chunk.
    expect(releases[0]).toEqual({
      facilityId: BOEING,
      chemicalName: 'Naphthalene',
      reportingYear: 2024,
      releasesToAirInLbs: 18.81,
      releasesToWaterInLbs: 0,
      totalOnSiteReleasesInLbs: 18.81,
    });
    expect(releases.slice(1, -1).map((r) => r.releasesToAirInLbs)).toEqual(
      Array.from({ length: 373 }, (_, n) => n + 1),
    );
  });

  it('epa_tri_get_facility_releases returns a many-form facility with its breakdown on both surfaces', async () => {
    initDmapService({} as AppConfig, {} as StorageService);
    stubFakeDmap(boeingTables());

    const call = await runToolContract(triGetFacilityReleasesTool, { facility_id: BOEING });

    expect(call.isError).toBeFalsy();
    const structured = call.structuredContent as { releases: Array<Record<string, unknown>> };
    expect(structured.releases).toHaveLength(375);
    expect(structured.releases[0]).toEqual({
      facilityId: BOEING,
      chemicalName: 'Naphthalene',
      reportingYear: 2024,
      releasesToAirInLbs: 18.81,
      releasesToWaterInLbs: 0,
      totalOnSiteReleasesInLbs: 18.81,
    });
    const text = textOf(call.content);
    expect(text).toContain('**Total On-Site Releases:** 18.81 lbs');
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
    const releaseQty = forms.map((form, n) => qtyRow(form.doc_ctrl_num, 'AIR STACK', n + 1));
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

    const { items: releases } = await makeService().getTriReleases(
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

    const { items: releases } = await makeService().searchTriReleases(
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
    const { items: releases } = await pending;

    const lastChunkRequests = breakdownUrlsOf(urls).filter((u) => u.includes('1324222981425'));
    expect(lastChunkRequests).toHaveLength(2);
    expect(releases[0]).toMatchObject({ releasesToAirInLbs: 18.81 });
  });

  it('settles a hung chunk as a Timeout under the 60-second client timeout', async () => {
    vi.useFakeTimers();
    stubFakeDmap(boeingTables(), (url, signal) =>
      url.includes('/tri.tri_release_qty/') ? hang(signal) : Promise.resolve(),
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

  it('carries the narrowing Timeout on both surfaces of epa_tri_get_facility_releases', async () => {
    vi.useFakeTimers();
    initDmapService({} as AppConfig, {} as StorageService);
    stubFakeDmap({}, (_url, signal) => hang(signal));

    let call: Awaited<ReturnType<typeof runToolContract>> | undefined;
    const pending = runToolContract(triGetFacilityReleasesTool, { facility_id: BOEING }).then(
      (result) => {
        call = result;
      },
    );
    await vi.advanceTimersByTimeAsync(55_000);
    await pending;

    expect(call?.isError).toBe(true);
    expect(call?.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.Timeout, data: { reason: 'retry_deadline_exceeded' } },
    });
    const text = call && textOf(call.content);
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

    const call = await runToolContract(triGetFacilityReleasesTool, { facility_id: BOEING });

    expect(call.isError).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(call.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InternalError },
    });
    const text = textOf(call.content);
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

    const { items: releases } = await makeService().searchTriReleases(
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

      const { items: releases } = await makeService().getTriReleases(
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

    const { items: releases } = await makeService().searchTriReleases(
      { state: 'MD', county: "PRINCE GEORGE'S", year: 2022, limit: 5 },
      createMockContext(),
    );

    expect(releases.map((r) => r.countyName)).toEqual(["PRINCE GEORGE'S"]);
    expect(urls[0]).toContain('/county_name/contains/PRINCE%20GEORGE_S/');
  });

  it('epa_tri_search_releases carries an apostrophe search on both surfaces', async () => {
    initDmapService({} as AppConfig, {} as StorageService);
    stubFakeDmap(PUNCTUATED_TABLES);

    const call = await runToolContract(triSearchReleasesTool, {
      state: 'TX',
      chemical_name: "Michler's ketone",
    });

    expect(call.isError).toBeFalsy();
    const structured = call.structuredContent as { releases: Array<Record<string, unknown>> };
    expect(structured.releases.map((r) => r.chemicalName)).toEqual(["Michler's ketone"]);
    const text = textOf(call.content);
    expect(text).toContain("### Michler's ketone — HOUSTON PLANT (77001HSTNP100MA) (2022)");
  });

  it('reads the next page when the exact match drops near-variants from a full page', async () => {
    // Superfund city names carry spelling variants: SEMS lists both COEUR D'ALENE and COEUR D ALENE.
    // Exact matches carry X ids, which sort after the V near-variants in site ID order.
    const sites = [
      ...Array.from({ length: 99 }, (_, n) => semsSite(`V${n}`, 'COEUR D ALENE')),
      semsSite('X1', "COEUR D'ALENE"),
      semsSite('X2', "COEUR D'ALENE"),
      semsSite('X3', "COEUR D'ALENE"),
    ];
    const urls = stubFakeDmap({ 'sems.envirofacts_site': sites });

    const result = await makeService().searchSuperfund(
      { state: 'ID', city: "Coeur d'Alene", limit: 2 },
      createMockContext(),
    );

    expect(result.items.map((s) => s.siteId)).toEqual(['X1', 'X2']);
    expect(result.nextOffset).toBe(101);
    expect(urls.map((u) => /\/(\d+:\d+)\/json$/.exec(u)?.[1])).toEqual(['1:100', '101:200']);
    expect(urls[0]).toContain('/city_name/contains/Coeur%20d_Alene/');
  });

  it('reads at most three pages of near-variants, says more matches may exist, and continues after them', async () => {
    const sites = [
      ...Array.from({ length: 300 }, (_, n) => semsSite(`V${n}`, 'COEUR D ALENE')),
      semsSite('X1', "COEUR D'ALENE"),
    ];
    const urls = stubFakeDmap({ 'sems.envirofacts_site': sites });
    const ctx = createMockContext();

    const result = await makeService().searchSuperfund(
      { state: 'ID', city: "Coeur d'Alene", limit: 5 },
      ctx,
    );

    expect(result).toEqual({ items: [], nextOffset: 300 });
    expect(urls).toHaveLength(3);
    expect(getEnrichment(ctx)).toEqual({ notice: WILDCARD_CAP_NOTICE("Coeur d'Alene", 300, 0) });
  });

  it('adds no notice when DMAP runs out of wildcard rows before the page limit', async () => {
    const sites = [
      ...Array.from({ length: 150 }, (_, n) => semsSite(`V${n}`, 'COEUR D ALENE')),
      semsSite('X1', "COEUR D'ALENE"),
    ];
    stubFakeDmap({ 'sems.envirofacts_site': sites });
    const ctx = createMockContext();

    const result = await makeService().searchSuperfund(
      { state: 'ID', city: "Coeur d'Alene", limit: 5 },
      ctx,
    );

    expect(result).toEqual({ items: [expect.objectContaining({ siteId: 'X1' })] });
    expect(getEnrichment(ctx)).not.toHaveProperty('notice');
  });

  it('adds no notice when the exact matches fill the limit within the page limit', async () => {
    // limit 1 reads one match past it, so X2 must also sit within the third page.
    const sites = [
      ...Array.from({ length: 298 }, (_, n) => semsSite(`V${n}`, 'COEUR D ALENE')),
      semsSite('X1', "COEUR D'ALENE"),
      semsSite('X2', "COEUR D'ALENE"),
    ];
    const urls = stubFakeDmap({ 'sems.envirofacts_site': sites });
    const ctx = createMockContext();

    const result = await makeService().searchSuperfund(
      { state: 'ID', city: "Coeur d'Alene", limit: 1 },
      ctx,
    );

    expect(result.items.map((s) => s.siteId)).toEqual(['X1']);
    expect(result.nextOffset).toBe(299);
    expect(urls).toHaveLength(3);
    expect(getEnrichment(ctx)).not.toHaveProperty('notice');
  });

  it('epa_tri_search_releases discloses a wildcard walk cut short, beside the records it found', async () => {
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

    const call = await runToolContract(triSearchReleasesTool, {
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
    const text = textOf(call.content);
    expect(text).toContain(notice);
    expect(text).toContain('### C.I. Food Red 15 — HOUSTON PLANT (77001HSTNP100MA) (2024)');
  });

  it('epa_tri_get_facility_releases discloses a wildcard walk cut short on both surfaces', async () => {
    initDmapService({} as AppConfig, {} as StorageService);
    // A 500-filing page walks 501-row pages; 1,600 near-variants outlast all three.
    const forms = Array.from({ length: 1600 }, (_, n) =>
      triForm(`1322230${String(n).padStart(6, '0')}`, BOEING, 'CHIC SOLVENT', 2023),
    );
    const urls = stubFakeDmap({ 'tri.tri_reporting_form': forms, 'tri.tri_release_qty': [] });

    const call = await runToolContract(triGetFacilityReleasesTool, {
      facility_id: BOEING,
      chemical_name: 'C.I.',
    });

    expect(call.isError).toBeFalsy();
    expect(urls.map((u) => /\/(\d+:\d+)\/json$/.exec(u)?.[1])).toEqual([
      '1:501',
      '502:1002',
      '1003:1503',
    ]);
    const notice = WILDCARD_CAP_NOTICE('C.I.', 1503, 0);
    const structured = call.structuredContent as { releases: unknown[]; notice?: string };
    expect(structured.releases).toEqual([]);
    expect(structured.notice).toBe(notice);
    // The walk stopped before DMAP ran out, so the next page starts where it stopped.
    expect(structured).toMatchObject({ nextOffset: 1503 });
    const text = textOf(call.content);
    expect(text).toContain(notice);
    expect(text).toContain('No TRI releases found');
  });

  it('epa_superfund_search_sites discloses a wildcard walk cut short on both surfaces', async () => {
    initDmapService({} as AppConfig, {} as StorageService);
    const sites = [
      ...Array.from({ length: 300 }, (_, n) => semsSite(`V${n}`, 'COEUR D ALENE')),
      semsSite('X1', "COEUR D'ALENE"),
    ];
    stubFakeDmap({ 'sems.envirofacts_site': sites });

    const call = await runToolContract(superfundSearchSitesTool, {
      state: 'ID',
      city: "Coeur d'Alene",
      limit: 5,
    });

    expect(call.isError).toBeFalsy();
    const notice = WILDCARD_CAP_NOTICE("Coeur d'Alene", 300, 0);
    const structured = call.structuredContent as {
      sites: unknown[];
      notice?: string;
      nextOffset?: number;
      effectiveQuery?: string;
    };
    expect(structured.sites).toEqual([]);
    expect(structured.notice).toBe(notice);
    // The walk stopped before DMAP ran out, so the next page starts where it stopped.
    expect(structured.nextOffset).toBe(300);
    expect(structured.effectiveQuery).toBe("state=ID; city contains Coeur d'Alene");
    const text = textOf(call.content);
    expect(text).toContain(notice);
    expect(text).toContain('No Superfund sites found.');
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

    const { items: releases } = await makeService().getTriReleases(
      { facilityId: '77001HSTNP100MA', chemicalName: 'C_12' },
      createMockContext(),
    );

    expect(chemicalsOf(releases)).toEqual(['C_12 resin']);
    expect(urls[0]).toContain('/cas_chem_name/contains/C_12/');
  });

  it('sends a plain text filter unchanged, in one sorted request ranged one row past the limit', async () => {
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

    expect(result).toEqual({ items: [expect.objectContaining({ siteId: 'K1' })], nextOffset: 1 });
    expect(urls).toEqual([
      'https://data.epa.gov/dmapservice/sems.envirofacts_site/fk_ref_state_code/equals/MT/and/city_name/contains/Kalispell/sort/sems.envirofacts_site.site_id:asc/1:2/json',
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
        data: { reason: 'unmatchable_filter', character },
      });
      expect(urls).toEqual([]);
    },
  );

  it('tells a comma-joined exact value to pass one value per call', async () => {
    initDmapService({} as AppConfig, {} as StorageService);
    const urls = stubFakeDmap(PUNCTUATED_TABLES);

    const call = await runToolContract(triGetFacilityReleasesTool, { facility_id: 'A,B' });

    expect(call.isError).toBe(true);
    expect(urls).toEqual([]);
    const message =
      '"A,B" contains ",", a character EPA\'s DMAP service cannot match in an exact-value filter. Pass one value per call.';
    expect(call.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        message,
        data: { reason: 'unmatchable_filter' },
      },
    });
    expect(JSON.stringify(call.content)).toContain('Pass one value per call.');
  });

  it.each([
    ['a trailing', '98108THBNG7500E/'],
    ['a leading', '/98108THBNG7500E'],
    ['repeated', '//98108THBNG7500E//'],
  ])('reads a TRI facility ID with %s slash as DMAP does, as the bare ID', async (_, id) => {
    const urls = stubFakeDmap(boeingTables(3));

    const { items: releases } = await makeService().getTriReleases(
      { facilityId: id },
      createMockContext(),
    );

    expect(urls[0]).toBe(
      `https://data.epa.gov/dmapservice/tri.tri_reporting_form/tri_facility_id/equals/${BOEING}${NEWEST_FIRST_SORT}/1:501/json`,
    );
    expect(releases.map((r) => r.chemicalName)).toEqual(['Naphthalene', 'Chemical 1', 'Toluene']);
  });

  it.each([
    [
      'a water-system ZIP',
      async () =>
        (await makeService().searchWaterSystems({ zipCode: '98104/' }, createMockContext())).items,
      '/sdwis.water_system/zip_code/beginsWith/98104/sort/sdwis.water_system.pwsid:asc/1:51/json',
    ],
    [
      'a Superfund ZIP',
      async () =>
        (await makeService().searchSuperfund({ zipCode: '/98104' }, createMockContext())).items,
      '/sems.envirofacts_site/zip_code/beginsWith/98104/sort/sems.envirofacts_site.site_id:asc/1:51/json',
    ],
    [
      'a Superfund city',
      async () =>
        (
          await makeService().searchSuperfund(
            { state: 'WA', city: 'Seattle/' },
            createMockContext(),
          )
        ).items,
      '/sems.envirofacts_site/fk_ref_state_code/equals/WA/and/city_name/contains/Seattle/sort/sems.envirofacts_site.site_id:asc/1:51/json',
    ],
    [
      'a TRI chemical name',
      async () =>
        (
          await makeService().getTriReleases(
            { facilityId: BOEING, chemicalName: 'Toluene/' },
            createMockContext(),
          )
        ).items,
      `/tri_facility_id/equals/98108THBNG7500E/and/cas_chem_name/contains/Toluene${NEWEST_FIRST_SORT}/1:501/json`,
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
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'unmatchable_filter', character: '/' },
      });
    }
    expect(urls).toEqual([]);
  });

  it('sends a Superfund city as long as DMAP still answers, on both surfaces', async () => {
    initDmapService({} as AppConfig, {} as StorageService);
    const urls = stubFakeDmap({ 'sems.envirofacts_site': [semsSite('S1', 'SEATTLE', 'WA')] });

    // 3,990 letters at limit 1 make a 4,105-byte sorted request line, which DMAP counts as 4,094.
    const call = await runToolContract(superfundSearchSitesTool, {
      city: 'a'.repeat(3990),
      limit: 1,
    });

    expect(call.isError).toBeFalsy();
    expect(urls).toHaveLength(1);
    expect(Buffer.byteLength(requestLine(urls[0]!))).toBe(4105);
    const structured = call.structuredContent as { sites: unknown[]; message?: string };
    expect(structured.sites).toEqual([]);
    expect(structured.message).toContain('No Superfund sites found');
    const text = textOf(call.content);
    expect(text).toContain('No Superfund sites found');
  });

  it('sends an all-years chemical filter through the sorted request-line boundary', async () => {
    const urls = stubFakeDmap(boeingTables(3));

    const { items: releases } = await makeService().getTriReleases(
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
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'filter_too_long' },
      });
      expect(urls).toEqual([]);
    },
  );

  it('rejects one byte more than DMAP counts as its limit, before any request', async () => {
    const urls = stubFakeDmap({ 'sems.envirofacts_site': [] });

    await expect(
      makeService().searchSuperfund({ city: 'a'.repeat(3991), limit: 1 }, createMockContext()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message:
        "The search filters are too long for EPA's DMAP service: the request would be 4095 bytes, over its 4094-byte limit. Shorten the text filters.",
      data: { reason: 'filter_too_long', requestLineBytes: 4095 },
    });
    expect(urls).toEqual([]);
  });

  it('rejects a text filter with no letter or digit, before any request', async () => {
    const urls = stubFakeDmap(PUNCTUATED_TABLES);

    await expect(
      makeService().searchTriReleases({ state: 'TX', chemicalName: "'" }, createMockContext()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message:
        '"\'" has no letter or digit to search on. EPA\'s DMAP service matches text by its letters, digits, spaces, and hyphens.',
      data: { reason: 'unmatchable_filter', value: "'" },
    });
    expect(urls).toEqual([]);
  });

  it('rejects filters too long for DMAP request line as an input error, before any request', async () => {
    const urls = stubFakeDmap(PUNCTUATED_TABLES);

    await expect(
      makeService().getTriReleases({ facilityId: 'A'.repeat(5000) }, createMockContext()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'filter_too_long' },
    });
    expect(urls).toEqual([]);
  });
});

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

  it('renders proximity deadline failure on both surfaces without partial sites', async () => {
    vi.useFakeTimers();
    const urls = stubFakeDmap({ 'sems.envirofacts_site': [] }, (_url, signal) => hang(signal));
    initDmapService({} as AppConfig, {} as StorageService);
    const pending = runToolContract(superfundSearchSitesTool, {
      latitude: 40.7357,
      longitude: -74.1724,
      radius_miles: 5,
    });
    await vi.advanceTimersByTimeAsync(55_000);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'retry_deadline_exceeded', deadlineMs: 50_000 },
      },
    });
    expect(result.structuredContent).not.toHaveProperty('sites');
    expect(textOf(result.content)).toContain(
      'DMAP did not finish the Superfund site search within 50 seconds',
    );
    expect(urls).toHaveLength(1);
  });

  it('renders cancellation on both surfaces and stops before the next prefix', async () => {
    const controller = new AbortController();
    const urls = stubFakeDmap({ 'sems.envirofacts_site': [] }, abortWhileInFlight(controller));
    initDmapService({} as AppConfig, {} as StorageService);
    const result = await runToolContract(
      superfundSearchSitesTool,
      { latitude: 0, longitude: 0, radius_miles: 5 },
      { context: { signal: controller.signal } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(textOf(result.content)).toMatch(/operation was aborted/);
    expect(urls).toHaveLength(1);
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
      if (requests === 1) return answerAfter(30_000, signal, () => undefined);
      if (requests === 2) {
        await answerAfter(10_000, signal, () => undefined);
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
    expect(urls).toHaveLength(10);
    expect(urls[1]).toBe(urls[8]);
    expect(urls[0]).not.toBe(urls[1]);
  });

  it('settles a ZIP violation check against a hung DMAP as a Timeout under 60 seconds', async () => {
    vi.useFakeTimers();
    stubFakeDmap({ 'sdwis.water_system': zipSystems(5) }, (_url, signal) => hang(signal));
    const { lookup, scopes } = fakeViolatorLookup([{ pwsid: pwsidOf(1) }]);

    const settled = await settleWithin(
      () =>
        makeService().searchWaterSystems(
          { zipCode: '59901', currentViolators: lookup, limit: 10 },
          createMockContext(),
        ),
      55_000,
    );

    expect(settled).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'retry_deadline_exceeded' },
    });
    expect(scopes).toEqual([]);
  });

  const waterNarrowing = (upstream: string) =>
    `${upstream} did not finish the water system search within 50 seconds. Narrow it with zip_code, county, pws_type, or active_only, or call again later.`;

  it.each([
    [
      'a state violation search',
      () =>
        makeService().searchWaterSystems(
          {
            state: 'MT',
            currentViolators: fakeViolatorLookup([{ pwsid: 'MT0000001', state: 'MT' }]).lookup,
          },
          createMockContext(),
        ),
      waterNarrowing('DMAP and ECHO'),
    ],
    [
      'a plain water-system search',
      () => makeService().searchWaterSystems({ state: 'MT' }, createMockContext()),
      waterNarrowing('DMAP'),
    ],
    [
      'a Superfund search',
      () => makeService().searchSuperfund({ state: 'MT' }, createMockContext()),
      'DMAP did not finish the Superfund site search within 50 seconds. Narrow it with radius_miles, zip_code, city, or npl_status, or call again later.',
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

  it('rejects with the cancellation when the caller aborts during the ZIP read', async () => {
    const controller = new AbortController();
    stubFakeDmap({ 'sdwis.water_system': zipSystems(5) }, abortWhileInFlight(controller));
    const { lookup, scopes } = fakeViolatorLookup([{ pwsid: pwsidOf(1) }]);

    await expect(
      makeService().searchWaterSystems(
        { zipCode: '59901', currentViolators: lookup, limit: 10 },
        createMockContext({ signal: controller.signal }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(scopes).toEqual([]);
  });
});

const ECHO_URL = 'https://echodata.epa.gov/echo/';
const echoUrls = (urls: string[]) => urls.filter((u) => u.startsWith(ECHO_URL));

/** A system ECHO reports with a current violation, under the `p_st` it files the system in. */
type EchoViolator = { pwsid: string; st: string; type?: string };

/**
 * Answer ECHO sdw_rest_services the way the live service answers a current-violation lookup
 * (2026-11-01): get_systems with `p_cs=H,M,O,P,S` and `p_st` (narrowed by `p_systyp`) or `p_pid`
 * answers QueryRows and a QueryID and echoes no parameters; get_qid pages that query's systems,
 * every row with CurrVioFlag "1".
 */
function echoSdwResponse(url: URL, violators: EchoViolator[], queries: Map<string, string[]>) {
  const p = url.searchParams;
  const endpoint = url.pathname.split('/').at(-1);
  if (endpoint === 'sdw_rest_services.get_systems') {
    if (p.get('p_cs') !== 'H,M,O,P,S') throw new Error(`Lookup without p_cs: ${url}`);
    const pids = p.get('p_pid')?.split(',');
    const found = violators
      .filter((v) =>
        pids
          ? pids.includes(v.pwsid)
          : v.st === p.get('p_st') && (!p.get('p_systyp') || v.type === p.get('p_systyp')),
      )
      .map((v) => v.pwsid);
    const qid = String(queries.size + 1);
    queries.set(qid, found);
    const rows = String(found.length);
    return Response.json({
      Results: { Message: 'Success', QueryRows: rows, CVRows: rows, QueryID: qid },
    });
  }
  if (endpoint === 'sdw_rest_services.get_qid') {
    const found = queries.get(p.get('qid') ?? '') ?? [];
    const pageno = Number(p.get('pageno'));
    const page = found.slice((pageno - 1) * 1000, pageno * 1000);
    return Response.json({
      Results: {
        PageNo: String(pageno),
        QueryRows: String(found.length),
        WaterSystems: page.map((id) => ({ PWSId: id, PWSName: id, CurrVioFlag: '1' })),
      },
    });
  }
  throw new Error(`Fake ECHO has no endpoint ${endpoint}`);
}

/**
 * Stub fetch with the fake DMAP over `tables` and the fake ECHO SDW lookup over `violators`,
 * recording every URL. `beforeResponse` can hold, fail, or answer any request first.
 */
function stubWaterUpstreams(
  tables: Record<string, DmapRow[]>,
  violators: EchoViolator[],
  beforeResponse?: (url: string, signal: AbortSignal | undefined) => Promise<unknown>,
): string[] {
  const urls: string[] = [];
  const queries = new Map<string, string[]>();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    urls.push(url);
    const held = await beforeResponse?.(url, init?.signal ?? undefined);
    if (held instanceof Response) return held;
    if (url.startsWith(ECHO_URL)) return echoSdwResponse(new URL(url), violators, queries);
    return Response.json(evaluateDmapUrl(url, tables));
  });
  return urls;
}

describe('epa_water_search_systems current violations from ECHO', () => {
  beforeEach(() => {
    initDmapService({} as AppConfig, {} as StorageService);
    initEchoService(
      { pkg: { name: 'epa-mcp-server', version: '0.0.0' } } as AppConfig,
      {} as StorageService,
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /**
   * Live WA shapes (2026-11-01): WA5300484 and WA5300552 carry unresolved (K) SDWIS violations
   * ECHO reports as no current violation; WA5301483 has a current violation; 105300009 is a
   * system ECHO files under p_st=WA that is under EPA Region 10 primacy.
   */
  const waTables = {
    'sdwis.water_system': [
      waterSystem(0, { pwsid: 'WA5300484', pws_type_code: 'CWS' }),
      waterSystem(0, { pwsid: 'WA5300552', pws_type_code: 'CWS' }),
      waterSystem(0, { pwsid: 'WA5301483', pws_type_code: 'NTNCWS' }),
      { pwsid: '105300009', pws_name: 'Tribal System', primacy_agency_code: '10' },
    ],
    'sdwis.violation': ['WA5300484', 'WA5300552', 'WA5301483'].map((pwsid) => ({
      pwsid,
      primacy_agency_code: 'WA',
      compliance_status_code: 'K',
    })),
  };
  const waViolators: EchoViolator[] = [
    { pwsid: 'WA5301483', st: 'WA', type: 'NTNCWS' },
    { pwsid: '105300009', st: 'WA', type: 'CWS' },
  ];

  it('returns the systems ECHO flags, not every system SDWIS lists as unresolved', async () => {
    stubWaterUpstreams(waTables, waViolators);

    const call = await runToolContract(waterSearchSystemsTool, {
      state: 'WA',
      has_violation: true,
    });

    expect(call.isError).toBeFalsy();
    expect(call.structuredContent).toMatchObject({
      systems: [{ pwsid: 'WA5301483', hasViolation: true }],
      totalCount: 1,
      effectiveQuery: 'state=WA; has_violation=true, current SDWA violation per ECHO',
    });
    const text = textOf(call.content);
    expect(text).toContain('### System 0 ⚠️ CURRENT VIOLATION');
    expect(text).toContain('**Current Violation:** Yes');
    expect(text).not.toContain('WA5300484');
  });

  it('sends exactly the ECHO lookup parameters, p_systyp=NTNCWS for non-transient', async () => {
    const urls = stubWaterUpstreams(waTables, waViolators);

    const call = await runToolContract(waterSearchSystemsTool, {
      state: 'WA',
      has_violation: true,
      pws_type: 'non-transient',
    });

    expect(call.structuredContent).toMatchObject({ systems: [{ pwsid: 'WA5301483' }] });
    const [lookup, page] = echoUrls(urls).map((u) => new URL(u));
    expect(lookup!.pathname).toBe('/echo/sdw_rest_services.get_systems');
    expect(Object.fromEntries(lookup!.searchParams)).toEqual({
      output: 'JSON',
      responseset: '1000',
      p_cs: 'H,M,O,P,S',
      p_st: 'WA',
      p_systyp: 'NTNCWS',
    });
    expect(page!.pathname).toBe('/echo/sdw_rest_services.get_qid');
  });

  it('makes no ECHO request without has_violation', async () => {
    const urls = stubWaterUpstreams(waTables, waViolators);

    const call = await runToolContract(waterSearchSystemsTool, { state: 'WA' });

    expect(echoUrls(urls)).toEqual([]);
    expect(call.structuredContent).toMatchObject({ totalCount: 3 });
  });

  it('returns the systems a ZIP stores as ZIP+4 beside its five-digit ones', async () => {
    // Live 98104 (2026-11-01): WA5302462 is stored as 98104-3122, WA5359090 as 98104-2017.
    stubWaterUpstreams(
      {
        'sdwis.water_system': [
          waterSystem(0, { pwsid: 'WA5302462', zip_code: '98104-3122' }),
          waterSystem(0, { pwsid: 'WA5307390', zip_code: '98104' }),
          waterSystem(0, { pwsid: 'WA5359090', zip_code: '98104-2017' }),
          waterSystem(0, { pwsid: 'WA5377050', zip_code: '98134' }),
        ],
      },
      [],
    );

    const call = await runToolContract(waterSearchSystemsTool, { zip_code: '98104' });

    const { systems } = call.structuredContent as { systems: Array<{ pwsid: string }> };
    expect(systems.map((s) => s.pwsid)).toEqual(['WA5302462', 'WA5307390', 'WA5359090']);
  });

  it('returns only systems serving the county, for every spelling of its name', async () => {
    const tables = countyTables([
      waterSystem(1, { county_served: 'King' }),
      waterSystem(2, { county_served: 'Kingston' }),
      waterSystem(3, { county_served: 'Pierce,King' }),
    ]);
    stubWaterUpstreams(tables, []);

    for (const county of ['King', 'KING', 'king', 'King County']) {
      const call = await runToolContract(waterSearchSystemsTool, { state: 'WA', county });
      expect(call.structuredContent).toMatchObject({
        systems: [{ pwsid: pwsidOf(1) }, { pwsid: pwsidOf(3) }],
        totalCount: 2,
        effectiveQuery: 'state=WA; county=KING',
      });
    }
  });

  it("checks a ZIP's systems with one p_pid batch", async () => {
    const urls = stubWaterUpstreams(
      {
        'sdwis.water_system': [1, 2, 3].map((n) =>
          waterSystem(n, { pwsid: `MT000000${n}`, primacy_agency_code: 'MT', zip_code: '59901' }),
        ),
      },
      [
        { pwsid: 'MT0000002', st: 'MT' },
        { pwsid: 'MT0000009', st: 'MT' },
      ],
    );

    const call = await runToolContract(waterSearchSystemsTool, {
      zip_code: '59901',
      has_violation: true,
    });

    expect(call.structuredContent).toMatchObject({
      systems: [{ pwsid: 'MT0000002', hasViolation: true }],
      totalCount: 1,
    });
    const lookup = new URL(echoUrls(urls)[0]!);
    expect(lookup.searchParams.get('p_pid')).toBe('MT0000001,MT0000002,MT0000003');
    expect(lookup.searchParams.has('p_st')).toBe(false);
  });

  it('fails the call when ECHO fails, never reading as no violations', async () => {
    vi.useFakeTimers();
    stubWaterUpstreams(waTables, waViolators, async (url) =>
      url.startsWith(ECHO_URL) ? new Response('upstream busy', { status: 503 }) : undefined,
    );

    const pending = runToolContract(waterSearchSystemsTool, { state: 'WA', has_violation: true });
    await vi.advanceTimersByTimeAsync(55_000);
    const call = await pending;

    expect(call.isError).toBe(true);
    expect(call.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ServiceUnavailable },
    });
    expect(call.structuredContent).not.toHaveProperty('systems');
  });

  it('shares one 50-second deadline across the DMAP read and every ECHO lookup', async () => {
    vi.useFakeTimers();
    // 1,000 ZIP systems: the DMAP read, then five 200-PWSID ECHO lookups of 12 s each — 60 s in
    // all, so only a deadline shared across both upstreams settles the call by 55 s.
    const urls = stubWaterUpstreams(
      {
        'sdwis.water_system': Array.from({ length: 1000 }, (_, i) =>
          waterSystem(i + 1, { zip_code: '59901' }),
        ),
      },
      [],
      (url, signal) =>
        url.startsWith(ECHO_URL) ? answerAfter(12_000, signal, () => undefined) : Promise.resolve(),
    );

    const pending = runToolContract(waterSearchSystemsTool, {
      zip_code: '59901',
      has_violation: true,
    });
    await vi.advanceTimersByTimeAsync(55_000);
    const call = await pending;

    expect(call.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'retry_deadline_exceeded', deadlineMs: 50_000 },
      },
    });
    expect(textOf(call.content)).toContain(
      'DMAP and ECHO did not finish the water system search within 50 seconds',
    );
    expect(echoUrls(urls)).toHaveLength(5);
  });

  it('renders cancellation during an ECHO lookup as RequestCancelled', async () => {
    const controller = new AbortController();
    const abort = abortWhileInFlight(controller);
    stubWaterUpstreams(waTables, waViolators, (url, signal) =>
      url.startsWith(ECHO_URL) ? abort(url, signal) : Promise.resolve(),
    );

    const call = await runToolContract(
      waterSearchSystemsTool,
      { state: 'WA', has_violation: true },
      { context: { signal: controller.signal } },
    );

    expect(call.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
  });
});

/** A 200 response whose body stream fails after its first bytes, as a dropped connection does. */
function truncatedBody(): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('[{"pwsid":'));
        controller.error(new TypeError('terminated'));
      },
    }),
  );
}

describe('DmapService.fetchTable retry classification', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const system = { pwsid: 'WA5377050', pws_name: 'SEATTLE PUBLIC UTILITIES' };

  it.each([
    ['a rejected fetch', () => Promise.reject(new TypeError('fetch failed'))],
    ['a body read that fails mid-stream', async () => truncatedBody()],
    ['an HTTP 503', async () => new Response('upstream busy', { status: 503 })],
    ['an HTTP 429', async () => new Response('slow down', { status: 429 })],
    [
      'an HTML page in place of JSON',
      async () => new Response('<!DOCTYPE html><html><body>Busy</body></html>'),
    ],
  ])('retries %s and returns the next attempt', async (_, firstAttempt) => {
    vi.useFakeTimers();
    let attempts = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      attempts++;
      return attempts === 1 ? firstAttempt() : Promise.resolve(Response.json([system]));
    });

    const pending = makeService().searchWaterSystems({ state: 'WA' }, createMockContext());
    await vi.runAllTimersAsync();

    expect((await pending).items).toEqual([
      { pwsid: 'WA5377050', name: 'SEATTLE PUBLIC UTILITIES' },
    ]);
    expect(attempts).toBe(2);
  });

  it('fails a fully read malformed body once as a SerializationError carrying the parse error', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('{ broken'));

    const pending = makeService()
      .searchWaterSystems({ state: 'WA' }, createMockContext())
      .catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const error = await pending;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
      message: 'EPA DMAP returned a response that is not JSON. Call again later.',
    });
    expect((error as Error).cause).toBeInstanceOf(SyntaxError);
    expect(vi.getTimerCount()).toBe(0);
  });
});
