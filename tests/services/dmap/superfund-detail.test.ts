/**
 * @fileoverview Superfund exact identity, sparse metadata, filters, and detail retrieval contracts.
 * @module tests/services/dmap/superfund-detail.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import MarkdownIt from 'markdown-it';
import { afterEach, expect, it, vi } from 'vitest';
import { superfundSiteResource } from '@/mcp-server/resources/definitions/superfund-site.resource.js';
import { superfundGetSiteTool } from '@/mcp-server/tools/definitions/superfund-get-site.tool.js';
import { superfundSearchSitesTool } from '@/mcp-server/tools/definitions/superfund-search-sites.tool.js';
import { DmapService, initDmapService } from '@/services/dmap/dmap-service.js';
import { answerAfter, hang, textOf } from '../../helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const rawSite = {
  site_id: '0200048',
  name: 'KERR GLASS',
  street_addr_txt: '1 MAIN',
  fips_code: '34011',
};
const site = { siteId: '0200048', name: 'KERR GLASS', street: '1 MAIN', fipsCode: '34011' };
const makeService = () => new DmapService({} as AppConfig, {} as StorageService);

it('characterizes exact leading-zero lookup and flat resource fields', async () => {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    urls.push(String(input));
    return Response.json(String(input).includes('envirofacts_contaminants') ? [] : [rawSite]);
  });
  initDmapService({} as AppConfig, {} as StorageService);
  expect(
    await superfundSiteResource.handler(
      { site_id: '0200048' },
      createMockContext({ errors: superfundSiteResource.errors }),
    ),
  ).toMatchObject(site);
  expect(urls.filter((url) => url.includes('envirofacts_site'))).toHaveLength(1);
  expect(
    urls
      .filter((url) => url.includes('envirofacts_site'))
      .every((url) => url.includes('/site_id/equals/0200048/1:1/json')),
  ).toBe(true);
});

it.each([
  ['listed', 'in', 'F,A'],
  ['not-listed', 'equals', 'N'],
  ['proposed', 'equals', 'P'],
  ['deleted', 'equals', 'D'],
  ['removed', 'equals', 'R'],
  ['withdrawn', 'equals', 'W'],
])('maps %s before the geographic result selection', async (nplStatus, operator, code) => {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    urls.push(decodeURIComponent(String(input)));
    return Response.json([]);
  });
  await makeService().searchSuperfund({ state: 'WA', nplStatus }, createMockContext());
  expect(urls[0]).toContain(`/npl_status_code/${operator}/${code}/`);
});

it('preserves source assessment and archive metadata while dropping unsupported cleanupStatus', async () => {
  detailFetch(
    [],
    [
      {
        ...rawSite,
        npl_status_code: 'A',
        npl_status_name: 'Site is Part of NPL Site',
        archived_ind: 'Y',
        epa_id: 'NJD123',
        federal_facility_ind: 'N',
        non_npl_status_name: 'Assessment',
        cleanup_status: 'Unsupported',
      },
    ],
  );
  expect((await makeService().getSuperfundSite('0200048', createMockContext())).site).toEqual({
    ...site,
    nplStatus: 'A',
    nplStatusName: 'Site is Part of NPL Site',
    archivedInd: 'Y',
    epaId: 'NJD123',
    federalFacilityInd: 'N',
    nonNplStatusName: 'Assessment',
  });
});

it('passes opt-in archived exclusion before administrative pagination', async () => {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    urls.push(String(input));
    return Response.json([]);
  });
  await makeService().searchSuperfund({ state: 'WA', excludeArchived: true }, createMockContext());
  expect(urls[0]).toContain('/archived_ind/equals/N/');
});

it('adds contaminants to the existing flat resource record', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
    Response.json(
      String(input).includes('envirofacts_contaminants')
        ? [
            {
              preferred_contaminant_name: 'ARSENIC',
              media_name: 'Sediment',
              operable_unit_num: '01',
              action_name: 'Record of Decision',
              type_code: 'RO',
              seq: 1,
            },
          ]
        : [rawSite],
    ),
  );
  initDmapService({} as AppConfig, {} as StorageService);
  expect(
    await superfundSiteResource.handler(
      { site_id: '0200048' },
      createMockContext({ errors: superfundSiteResource.errors }),
    ),
  ).toEqual({
    ...site,
    contaminants: [
      {
        name: 'ARSENIC',
        medium: 'Sediment',
        operableUnit: '01',
        action: 'Record of Decision',
        typeCode: 'RO',
      },
    ],
  });
});

/** Fake only external HTTP; apply DMAP's inclusive range to a supplied relation. */
function detailFetch(rows: unknown[], rawSites: unknown[] = [rawSite]) {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    urls.push(decodeURIComponent(url));
    if (url.includes('/sems.envirofacts_site/')) return Response.json(rawSites);
    if (!url.includes('/sems.envirofacts_contaminants/')) throw new Error('Unexpected route');
    const range = /\/(\d+):(\d+)\/json$/.exec(url)!;
    return Response.json(rows.slice(Number(range[1]) - 1, Number(range[2])));
  });
  initDmapService({} as AppConfig, {} as StorageService);
  return urls;
}

it.each([0, 100, 200, 202, 301])(
  'exhausts %s rows including complete pages, past-end, and duplicate associations',
  async (count) => {
    const rows = Array.from({ length: count }, (_, index) => ({
      preferred_contaminant_name: 'ARSENIC',
      media_name: index < 100 ? 'Sediment' : 'Groundwater',
      operable_unit_num: '01',
      action_name: index < 200 ? 'Record of Decision' : 'Removal',
      type_code: 'RO',
      seq: 1,
    }));
    const urls = detailFetch(rows);
    const result = await makeService().getSuperfundSite('0200048', createMockContext());
    expect(result.site).toEqual(site);
    expect(result.contaminants).toHaveLength(count);
    expect(result.contaminants).toEqual(
      rows.map((row) => ({
        name: 'ARSENIC',
        medium: row.media_name,
        operableUnit: '01',
        action: row.action_name,
        typeCode: 'RO',
      })),
    );
    const pages = urls.filter((url) => url.includes('envirofacts_contaminants'));
    expect(pages).toHaveLength(Math.floor(count / 100) + 1);
    for (const [index, url] of pages.entries()) {
      expect(url).toContain('/fk_site_id/equals/0200048/');
      expect(url).toContain(
        `/sort/sems.envirofacts_contaminants.preferred_contaminant_name:asc,sems.envirofacts_contaminants.media_name:asc,sems.envirofacts_contaminants.operable_unit_num:asc,sems.envirofacts_contaminants.action_name:asc,sems.envirofacts_contaminants.type_code:asc,sems.envirofacts_contaminants.seq:asc/${index * 100 + 1}:${index * 100 + 100}/json`,
      );
    }
  },
);

it('preserves sparse/null association values without inventing names or units', async () => {
  detailFetch([
    {},
    {
      preferred_contaminant_name: null,
      media_name: null,
      operable_unit_num: null,
      action_name: null,
      type_code: null,
    },
    { preferred_contaminant_name: '', media_name: 'Water', operable_unit_num: '00' },
  ]);
  const result = await runToolContract(superfundGetSiteTool, { site_id: '0200048' });
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toEqual({
    site,
    contaminants: [{}, {}, { name: '', medium: 'Water', operableUnit: '00' }],
  });
  expect(JSON.stringify(result.content)).not.toContain('undefined');
});

it('renders every raw site and association field literally on both tool surfaces', async () => {
  const special = 'A *name* [x](https://example.com)\n- another';
  detailFetch(
    [
      {
        preferred_contaminant_name: special,
        media_name: 'Water',
        operable_unit_num: '01',
        action_name: 'Record of Decision',
        type_code: 'RO',
      },
    ],
    [
      {
        ...rawSite,
        npl_status_code: 'A',
        npl_status_name: special,
        non_npl_status_name: special,
        archived_ind: 'Y',
        federal_facility_ind: 'N',
        epa_id: 'EPA001',
        primary_latitude_decimal_val: '0',
        primary_longitude_decimal_val: '0',
      },
    ],
  );
  const result = await runToolContract(superfundGetSiteTool, { site_id: '0200048' });
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toMatchObject({
    site: {
      ...site,
      nplStatus: 'A',
      nplStatusName: special,
      nonNplStatusName: special,
      archivedInd: 'Y',
      federalFacilityInd: 'N',
      epaId: 'EPA001',
      latitude: 0,
      longitude: 0,
    },
    contaminants: [
      {
        name: special,
        medium: 'Water',
        operableUnit: '01',
        action: 'Record of Decision',
        typeCode: 'RO',
      },
    ],
  });
  const tokens = new MarkdownIt().parse(textOf(result.content), {});
  const inline = tokens.flatMap((token) => token.children ?? []);
  expect(inline.some((token) => token.type === 'link_open')).toBe(false);
  const text = inline
    .filter((token) => token.type === 'text')
    .map((token) => token.content)
    .join('\n');
  for (const value of [
    '0200048',
    'KERR GLASS',
    '1 MAIN',
    '34011',
    special,
    'A',
    'Y',
    'N',
    'EPA001',
    '0, 0',
    'Water',
    '01',
    'Record of Decision',
    'RO',
  ])
    expect(text).toContain(value);
});

it('returns an existing site with no associations as success on both surfaces', async () => {
  detailFetch([]);
  const result = await runToolContract(superfundGetSiteTool, { site_id: '0200048' });
  expect(result.structuredContent).toEqual({ site, contaminants: [] });
  expect(JSON.stringify(result.content)).toContain('No contaminant associations recorded');
});

/** Lower Duwamish Waterway as sems.envirofacts_site holds it (live 2026-11-15), trimmed. */
const duwamish = {
  site_id: '1002020',
  name: 'LOWER DUWAMISH WATERWAY',
  city_name: 'SEATTLE',
  fk_ref_state_code: 'WA',
  epa_id: 'WA0002329803',
};
const duwamishContaminants = [
  { preferred_contaminant_name: 'ARSENIC', media_name: 'Sediment', fk_site_id: '1002020' },
  { preferred_contaminant_name: 'PCBS', media_name: 'Sediment', fk_site_id: '1002020' },
];

/**
 * Fake DMAP for the two SEMS tables that answers by the URL's filter: a site row only for its own
 * site_id or epa_id (case-insensitive, as DMAP's `equals` is), contaminants only for their
 * fk_site_id. Unknown routes fail.
 */
function semsByFilter() {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = decodeURIComponent(String(input));
    urls.push(url);
    const filter = /\/(site_id|epa_id|fk_site_id)\/equals\/([^/]+)\//.exec(url);
    if (!filter) throw new Error(`Unexpected route ${url}`);
    const [, column, value] = filter;
    const rows = url.includes('/sems.envirofacts_contaminants/')
      ? duwamishContaminants
      : [duwamish];
    return Response.json(
      rows.filter(
        (row) => String(row[column as keyof typeof row]).toLowerCase() === value!.toLowerCase(),
      ),
    );
  });
  initDmapService({} as AppConfig, {} as StorageService);
  return urls;
}

const SITES = 'https://data.epa.gov/dmapservice/sems.envirofacts_site';

it.each([
  ['an EPA ID', 'WA0002329803', '/epa_id/equals/WA0002329803/1:1/json'],
  ['a lowercase EPA ID', 'wa0002329803', '/epa_id/equals/WA0002329803/1:1/json'],
  ['a mixed-case EPA ID', 'Wa0002329803', '/epa_id/equals/WA0002329803/1:1/json'],
  ['a padded EPA ID', ' WA0002329803 ', '/epa_id/equals/WA0002329803/1:1/json'],
  ['an EPA ID with end slashes', '/WA0002329803/ ', '/epa_id/equals/WA0002329803/1:1/json'],
  ['the site ID', '1002020', '/site_id/equals/1002020/1:1/json'],
])(
  'opens Lower Duwamish Waterway from %s on the tool, with contaminants read by its site ID',
  async (_, site_id, lookup) => {
    const urls = semsByFilter();
    const result = await runToolContract(superfundGetSiteTool, { site_id });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      site: {
        siteId: '1002020',
        name: 'LOWER DUWAMISH WATERWAY',
        city: 'SEATTLE',
        state: 'WA',
        epaId: 'WA0002329803',
      },
      contaminants: [
        { name: 'ARSENIC', medium: 'Sediment' },
        { name: 'PCBS', medium: 'Sediment' },
      ],
    });
    const text = textOf(result.content);
    expect(text).toContain('**Site ID:** 1002020');
    expect(text).toContain('**EPA ID:** WA0002329803');
    expect(text).toContain('PCBS');
    expect(urls[0]).toBe(`${SITES}${lookup}`);
    expect(urls.slice(1)).toHaveLength(1);
    expect(urls[1]).toContain('/sems.envirofacts_contaminants/fk_site_id/equals/1002020/');
  },
);

it.each(['WA0002329803', 'wa0002329803', '1002020'])(
  'opens Lower Duwamish Waterway from %s on the resource, with its contaminants',
  async (site_id) => {
    const urls = semsByFilter();
    expect(
      await superfundSiteResource.handler(
        { site_id },
        createMockContext({ errors: superfundSiteResource.errors }),
      ),
    ).toMatchObject({
      siteId: '1002020',
      epaId: 'WA0002329803',
      contaminants: [{ name: 'ARSENIC' }, { name: 'PCBS' }],
    });
    expect(urls.at(-1)).toContain('/fk_site_id/equals/1002020/');
  },
);

const notFoundHint =
  'Pass a SEMS site ID (7 digits) or an EPA ID (2 letters and 10 letters or digits), or find the site with epa_superfund_search_sites by name or location, and retry.';

it('fails an EPA ID with no site as site_not_found on both surfaces, naming the EPA ID', async () => {
  const urls = semsByFilter();
  const result = await runToolContract(superfundGetSiteTool, { site_id: 'wad000000000' });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: {
      code: JsonRpcErrorCode.NotFound,
      message: expect.stringContaining('EPA ID "WAD000000000"'),
      data: { reason: 'site_not_found', epaId: 'WAD000000000', recovery: { hint: notFoundHint } },
    },
  });
  const text = textOf(result.content);
  expect(text).toContain('site_not_found');
  expect(text).toContain(notFoundHint);
  expect(urls).toEqual([`${SITES}/epa_id/equals/WAD000000000/1:1/json`]);
  await expect(
    superfundSiteResource.handler(
      { site_id: 'WAD000000000' },
      createMockContext({ errors: superfundSiteResource.errors }),
    ),
  ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound, data: { reason: 'site_not_found' } });
});

it('names the EPA ID in the get tool, resource, and site_not_found recovery', () => {
  expect(superfundGetSiteTool.input.shape.site_id.description).toContain('EPA ID');
  expect(superfundSiteResource.params!.shape.site_id.description).toContain('EPA ID');
  for (const errors of [superfundGetSiteTool.errors, superfundSiteResource.errors]) {
    expect(errors?.find((e) => e.reason === 'site_not_found')?.recovery).toBe(notFoundHint);
  }
});

it('reports missing site and recovery on both surfaces without querying contaminants', async () => {
  const urls = detailFetch([], []);
  const result = await runToolContract(superfundGetSiteTool, { site_id: 'MISSING' });
  const hint = notFoundHint;
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: {
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'site_not_found', siteId: 'MISSING', recovery: { hint } },
    },
  });
  expect(JSON.stringify(result.content)).toContain(hint);
  expect(JSON.stringify(result.content)).toContain('site_not_found');
  expect(urls).toHaveLength(1);
  await expect(
    superfundSiteResource.handler(
      { site_id: 'MISSING' },
      createMockContext({ errors: superfundSiteResource.errors }),
    ),
  ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound, data: { reason: 'site_not_found' } });
});

it.each([
  ['a name', 'MISSING'],
  ['a 7-digit ID with no site', '9999999'],
  ['13 characters', 'WA00023298031'],
  ['11 characters', 'WA000232980'],
  ['a digit in the first two places', 'W10002329803'],
])(
  'looks up a value of neither form (%s) as a site ID and fails site_not_found on both surfaces',
  async (_, site_id) => {
    const urls = detailFetch([], []);
    const result = await runToolContract(superfundGetSiteTool, { site_id });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'site_not_found' } },
    });
    expect(JSON.stringify(result.content)).toContain('site_not_found');
    expect(urls).toEqual([
      `https://data.epa.gov/dmapservice/sems.envirofacts_site/site_id/equals/${site_id}/1:1/json`,
    ]);
    await expect(
      superfundSiteResource.handler(
        { site_id },
        createMockContext({ errors: superfundSiteResource.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'site_not_found' },
    });
  },
);

it.each(['', '   '])('rejects blank new detail ID %j before any request', async (site_id) => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const result = await runToolContract(superfundGetSiteTool, { site_id });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: { code: JsonRpcErrorCode.InvalidParams },
  });
  expect(JSON.stringify(result.content)).toContain('site_id');
  expect(fetchSpy).not.toHaveBeenCalled();
});

const siteIdHint = 'Pass one SEMS site ID exactly as epa_superfund_search_sites returns it.';

it.each([
  [
    'a site_id with a character DMAP cannot match',
    'A.B',
    'unmatchable_filter',
    'Remove it and retry.',
  ],
  ['a site_id past the request line', 'A'.repeat(5000), 'filter_too_long', 'too long'],
])(
  'rejects %s with its declared reason and recovery on both surfaces, before any request',
  async (_, site_id, reason, message) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    initDmapService({} as AppConfig, {} as StorageService);

    const result = await runToolContract(superfundGetSiteTool, { site_id });

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringContaining(message),
        data: { reason, recovery: { hint: siteIdHint } },
      },
    });
    const text = JSON.stringify(result.content);
    expect(text).toContain(siteIdHint);
    expect(text).toContain(reason);
    expect(fetchSpy).not.toHaveBeenCalled();
  },
);

it.each([403, 429, 500])(
  'propagates contaminant HTTP %s after the site resolves, with real retries',
  async (status) => {
    vi.useFakeTimers();
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      urls.push(url);
      return url.includes('envirofacts_contaminants')
        ? new Response('Upstream failure', { status })
        : Response.json([rawSite]);
    });
    initDmapService({} as AppConfig, {} as StorageService);
    const pending = runToolContract(superfundGetSiteTool, { site_id: '0200048' });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code:
          status === 403
            ? JsonRpcErrorCode.Forbidden
            : status === 429
              ? JsonRpcErrorCode.RateLimited
              : JsonRpcErrorCode.ServiceUnavailable,
        data: { status },
      },
    });
    expect(JSON.stringify(result.content)).toContain(`HTTP ${status}`);
    expect(urls.filter((url) => url.includes('envirofacts_site'))).toHaveLength(1);
    expect(urls.filter((url) => url.includes('envirofacts_contaminants'))).toHaveLength(
      status === 403 ? 1 : 4,
    );
  },
);

it('rejects malformed contaminant schema once after fully reading the body', async () => {
  const urls = detailFetch([{ preferred_contaminant_name: 123 }]);
  const result = await runToolContract(superfundGetSiteTool, { site_id: '0200048' });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: { code: JsonRpcErrorCode.SerializationError },
  });
  expect(urls).toHaveLength(2);
});

it('shares the site request deadline with every later contaminant page', async () => {
  vi.useFakeTimers();
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    urls.push(url);
    return url.includes('envirofacts_site')
      ? answerAfter(30_000, init?.signal, () => Response.json([rawSite]))
      : hang(init?.signal);
  });
  initDmapService({} as AppConfig, {} as StorageService);
  const pending = runToolContract(superfundGetSiteTool, { site_id: '0200048' });
  await vi.advanceTimersByTimeAsync(50_000);
  const result = await pending;
  expect(result.structuredContent).toMatchObject({
    error: { code: JsonRpcErrorCode.Timeout, data: { reason: 'retry_deadline_exceeded' } },
  });
  expect(JSON.stringify(result.content)).toContain(
    'Superfund site and contaminant lookup within 50 seconds',
  );
  expect(urls).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('propagates cancellation during a later page without partial results or further requests', async () => {
  const controller = new AbortController();
  let contaminants = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input).includes('envirofacts_site')) return Response.json([rawSite]);
    contaminants++;
    if (contaminants === 1)
      return Response.json(
        Array.from({ length: 100 }, () => ({ preferred_contaminant_name: 'ARSENIC' })),
      );
    controller.abort();
    init!.signal!.throwIfAborted();
    throw new Error('Cancellation should have propagated');
  });
  initDmapService({} as AppConfig, {} as StorageService);
  const result = await runToolContract(
    superfundGetSiteTool,
    { site_id: '0200048' },
    { context: { signal: controller.signal } },
  );
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: { code: JsonRpcErrorCode.RequestCancelled },
  });
  expect(JSON.stringify(result.content)).toMatch(/cancel|abort/i);
  expect(contaminants).toBe(2);
});

it.each([false, true])(
  'wires archive exclusion %s with combined proximity and NPL filters before every page',
  async (exclude_archived) => {
    const urls = detailFetch([]);
    const result = await runToolContract(superfundSearchSitesTool, {
      state: 'WA',
      city: 'Seattle',
      zip_code: '98101',
      latitude: 47.6,
      longitude: -122.3,
      radius_miles: 1,
      npl_status: 'listed',
      exclude_archived,
    });
    expect(result.isError).toBeFalsy();
    for (const url of urls) {
      expect(url).toContain('/npl_status_code/in/F,A/');
      expect(url).toContain('/fk_ref_state_code/equals/WA/');
      expect(url).toContain('/city_name/contains/Seattle/');
      expect(url).toContain('/zip_code/beginsWith/98101/');
      expect(url.includes('/archived_ind/equals/N/')).toBe(exclude_archived);
    }
  },
);

it('preserves all seven observed source NPL names and sparse archive metadata in search output', async () => {
  const statuses = [
    ['F', 'Currently on the Final NPL'],
    ['A', 'Site is Part of NPL Site'],
    ['P', 'Proposed for NPL'],
    ['D', 'Deleted from the Final NPL'],
    ['R', 'Removed from Proposed NPL'],
    ['W', 'Withdrawn from the Final NPL'],
    ['N', 'Not on the NPL'],
  ];
  detailFetch(
    [],
    statuses.map(([code, name], index) => ({
      ...rawSite,
      site_id: String(index),
      npl_status_code: code,
      npl_status_name: name,
      archived_ind: index % 2 ? 'Y' : 'N',
      non_npl_status_name: null,
      federal_facility_ind: null,
      epa_id: null,
    })),
  );
  const result = await runToolContract(superfundSearchSitesTool, { state: 'WA' });
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toEqual({
    sites: statuses.map(([nplStatus, nplStatusName], index) => ({
      ...site,
      siteId: String(index),
      nplStatus,
      nplStatusName,
      archivedInd: index % 2 ? 'Y' : 'N',
    })),
    effectiveQuery: 'state=WA',
  });
  const text = textOf(result.content);
  for (const [, name] of statuses) expect(text).toContain(name);
  expect(text).not.toContain('Cleanup');
});

it('retries a later contaminant page without duplicating the earlier page', async () => {
  vi.useFakeTimers();
  let secondPageAttempts = 0;
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('envirofacts_site')) return Response.json([rawSite]);
    if (url.endsWith('/1:100/json'))
      return Response.json(
        Array.from({ length: 100 }, () => ({ preferred_contaminant_name: 'ARSENIC' })),
      );
    secondPageAttempts++;
    return secondPageAttempts === 1
      ? new Response('Retry later', { status: 500 })
      : Response.json([{ preferred_contaminant_name: 'VANADIUM' }]);
  });
  const pending = makeService().getSuperfundSite('0200048', createMockContext());
  await vi.runAllTimersAsync();
  const result = await pending;
  expect(result.contaminants).toHaveLength(101);
  expect(result.contaminants[100]).toEqual({ name: 'VANADIUM' });
  expect(secondPageAttempts).toBe(2);
  expect(urls).toHaveLength(4);
});

it('fails malformed JSON once as a SerializationError through the real fetch/retry path', async () => {
  vi.useFakeTimers();
  let attempts = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (String(input).includes('envirofacts_site')) return Response.json([rawSite]);
    attempts++;
    return new Response('{ broken');
  });
  initDmapService({} as AppConfig, {} as StorageService);
  const pending = runToolContract(superfundGetSiteTool, { site_id: '0200048' });
  await vi.runAllTimersAsync();
  const result = await pending;
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: {
      code: JsonRpcErrorCode.SerializationError,
      message: expect.stringContaining('EPA DMAP returned a response that is not JSON'),
    },
  });
  expect(JSON.stringify(result.content)).toContain('EPA DMAP returned a response that is not JSON');
  expect(attempts).toBe(1);
});
