/**
 * @fileoverview Tests for DmapService TRI and drinking-water retrieval, including per-medium
 * breakdowns and bounded regional-search pagination. `fetch` is stubbed — routed by table path, or
 * answered by an in-memory DMAP evaluator that applies filters, joins, and row ranges — so the
 * built URLs are observable.
 * @module tests/services/dmap/dmap-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

/** Apply one DMAP filter. Text comparisons are case-insensitive, as DMAP documents. */
function dmapRowMatches(row: DmapRow, filter: DmapFilter): boolean {
  const cell = String(row[filter.column] ?? '').toLowerCase();
  const value = filter.value.toLowerCase();
  if (filter.operator === 'equals') return cell === value;
  if (filter.operator === 'contains') return cell.includes(value);
  if (filter.operator === 'in') return value.split(',').includes(cell);
  throw new Error(`Fake DMAP has no operator ${filter.operator}`);
}

/** Read `col/op/val[/and/col/op/val…]` from `segments` at `start`, stopping at a non-`and` word. */
function readDmapFilters(segments: string[], start: number): [DmapFilter[], number] {
  const filters: DmapFilter[] = [];
  let i = start;
  while (i + 2 < segments.length && !/^\d+:\d+$/.test(segments[i]!) && segments[i] !== 'join') {
    filters.push({ column: segments[i]!, operator: segments[i + 1]!, value: segments[i + 2]! });
    i += 3;
    if (segments[i] !== 'and') break;
    i += 1;
  }
  return [filters, i];
}

/**
 * Evaluate a DMAP URL against in-memory tables, the way the live service does (2026-10-08):
 * `{table}/{filters}[/join/{table}/{left}/equals/{right}[/and/{filter}…]]/{first}:{last}/json`.
 * Filters before the join bind to the first table and a filter on a column it lacks is an error;
 * `and` filters after the join comparison bind to the joined table; joined rows come out in
 * first-table order, each carrying both tables' columns; the range is 1-based and inclusive.
 */
function evaluateDmapUrl(url: string, tables: Record<string, DmapRow[]>): DmapRow[] {
  const path = url.replace(/^https:\/\/data\.epa\.gov\/dmapservice\//, '').replace(/\/json$/, '');
  const segments = path.split('/').map(decodeURIComponent);
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

  if (segments[i] === 'join') {
    const joinName = segments[i + 1]!;
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

  const range = /^(\d+):(\d+)$/.exec(segments[i] ?? '');
  if (!range) throw new Error(`No first:last range in ${url}`);
  return rows.slice(Math.max(Number(range[1]), 1) - 1, Number(range[2]));
}

/**
 * Stub fetch with a fake DMAP over `tables`, recording every URL. `beforeResponse` runs before each
 * response and can hold or fail it (the abort tests park a request there).
 */
function stubFakeDmap(
  tables: Record<string, DmapRow[]>,
  beforeResponse?: (url: string, signal: AbortSignal | undefined) => Promise<void>,
): string[] {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    urls.push(url);
    await beforeResponse?.(url, init?.signal ?? undefined);
    let rows: DmapRow[];
    try {
      rows = evaluateDmapUrl(url, tables);
    } catch (error) {
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
      'https://data.epa.gov/dmapservice/tri.tri_reporting_form/tri_facility_id/equals/FAC1/1:500/json',
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
        triForm('DROP3', 'FAC1', 'Xylene', 2022),
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
      `https://data.epa.gov/dmapservice/tri.tri_facility/state_abbr/equals/WA${joinPath}/1:1/json`,
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

  it('caps the records at limit in facility order', async () => {
    stubFakeDmap(tables);

    const releases = await makeService().searchTriReleases(
      { state: 'WA', limit: 3 },
      createMockContext(),
    );

    expect(releases.map((r) => `${r.facilityId}/${r.chemicalName}/${r.reportingYear}`)).toEqual([
      '98001KINGA/Lead/2022',
      '98001KINGA/Lead compounds/2021',
      '98001KINGA/Toluene/2022',
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
    expect(urls[0]).toContain('/1:20/json');
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
