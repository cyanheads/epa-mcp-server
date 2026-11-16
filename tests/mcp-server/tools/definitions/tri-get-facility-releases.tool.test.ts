/**
 * @fileoverview Tests for triGetFacilityReleasesTool.
 * @module tests/mcp-server/tools/definitions/tri-get-facility-releases.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { triGetFacilityReleasesTool } from '@/mcp-server/tools/definitions/tri-get-facility-releases.tool.js';
import { DmapService } from '@/services/dmap/dmap-service.js';
import { expectValidationRejection, textOf } from '../../../helpers.js';

const mockGetTriReleases = vi.fn();

/** When set, getDmapService() returns this real service instead of the stub. */
const liveService: { current: DmapService | undefined } = { current: undefined };

vi.mock('@/services/dmap/dmap-service.js', async (importActual) => ({
  ...(await importActual<typeof import('@/services/dmap/dmap-service.js')>()),
  getDmapService: () =>
    liveService.current ?? {
      getTriReleases: mockGetTriReleases,
      searchTriReleases: vi.fn(),
      searchSuperfund: vi.fn(),
      searchWaterSystems: vi.fn(),
    },
}));

const benzeneRelease = {
  facilityId: '98101WA0001234X',
  chemicalName: 'BENZENE',
  reportingYear: 2022,
  oneTimeReleaseInLbs: 1240,
};

const fullBreakdownRelease = {
  facilityId: '98101WA0005678X',
  chemicalName: 'TOLUENE',
  reportingYear: 2021,
  oneTimeReleaseInLbs: 0,
  releasesToAirInLbs: 15000,
  releasesToWaterInLbs: 200,
  releasesToLandInLbs: 3400,
  releasesToUndergroundInjectionInLbs: 90000,
};

describe('triGetFacilityReleasesTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns TRI releases for valid facility ID', async () => {
    mockGetTriReleases.mockResolvedValue({ items: [benzeneRelease] });
    const ctx = createMockContext({ errors: triGetFacilityReleasesTool.errors });
    const input = triGetFacilityReleasesTool.input.parse({ facility_id: '98101WA0001234X' });
    const result = await triGetFacilityReleasesTool.handler(input, ctx);
    expect(result).toEqual({ releases: [benzeneRelease], facilityId: '98101WA0001234X' });
    expect(mockGetTriReleases).toHaveBeenCalledWith(
      { facilityId: '98101WA0001234X', offset: 0, limit: 25 },
      ctx,
    );
  });

  it('passes year and chemical_name filters to service', async () => {
    mockGetTriReleases.mockResolvedValue({ items: [benzeneRelease] });
    const ctx = createMockContext({ errors: triGetFacilityReleasesTool.errors });
    const input = triGetFacilityReleasesTool.input.parse({
      facility_id: '98101WA0001234X',
      year: 2022,
      chemical_name: 'BENZENE',
    });
    await triGetFacilityReleasesTool.handler(input, ctx);
    expect(mockGetTriReleases).toHaveBeenCalledWith(
      { facilityId: '98101WA0001234X', year: 2022, chemicalName: 'BENZENE', offset: 0, limit: 25 },
      expect.anything(),
    );
  });

  it('returns message when no releases found', async () => {
    mockGetTriReleases.mockResolvedValue({ items: [] });
    const ctx = createMockContext({ errors: triGetFacilityReleasesTool.errors });
    const input = triGetFacilityReleasesTool.input.parse({ facility_id: 'NOFACILITY00000' });
    const result = await triGetFacilityReleasesTool.handler(input, ctx);
    expect(result.releases).toEqual([]);
    expect(result.facilityId).toBe('NOFACILITY00000');
    expect(result.message).toMatch(
      /^No TRI releases found for facility "NOFACILITY00000"\. TRI data lags/,
    );
  });

  it('includes year in no-results message when year filter provided', async () => {
    mockGetTriReleases.mockResolvedValue({ items: [] });
    const ctx = createMockContext({ errors: triGetFacilityReleasesTool.errors });
    const input = triGetFacilityReleasesTool.input.parse({
      facility_id: '98101WA0001234X',
      year: 2019,
    });
    const result = await triGetFacilityReleasesTool.handler(input, ctx);
    expect(result.message).toMatch(
      /^No TRI releases found for facility "98101WA0001234X" for year 2019\. /,
    );
  });

  it('includes chemical name in no-results message when filter provided', async () => {
    mockGetTriReleases.mockResolvedValue({ items: [] });
    const ctx = createMockContext({ errors: triGetFacilityReleasesTool.errors });
    const input = triGetFacilityReleasesTool.input.parse({
      facility_id: '98101WA0001234X',
      chemical_name: 'LEAD',
    });
    const result = await triGetFacilityReleasesTool.handler(input, ctx);
    expect(result.message).toMatch(
      /^No TRI releases found for facility "98101WA0001234X" matching chemical "LEAD"\. /,
    );
  });

  it('trims whitespace from facility_id and chemical_name', async () => {
    mockGetTriReleases.mockResolvedValue({ items: [benzeneRelease] });
    const ctx = createMockContext({ errors: triGetFacilityReleasesTool.errors });
    const input = triGetFacilityReleasesTool.input.parse({
      facility_id: '  98101WA0001234X  ',
      chemical_name: '  benzene  ',
    });
    await triGetFacilityReleasesTool.handler(input, ctx);
    expect(mockGetTriReleases).toHaveBeenCalledWith(
      { facilityId: '98101WA0001234X', chemicalName: 'benzene', offset: 0, limit: 25 },
      expect.anything(),
    );
  });

  describe('facility_id form', () => {
    it.each([
      '98108THBNG7500E',
      '98108thbng7500e',
      ' 98108THBNG7500E ',
      '98108THBNG7500E/',
      '/98108THBNG7500E',
      '\t//98108Thbng7500E//\n',
    ])('sends %j as 98108THBNG7500E and echoes that ID on both surfaces', async (facility_id) => {
      mockGetTriReleases.mockResolvedValue({ items: [] });

      const call = await runToolContract(triGetFacilityReleasesTool, { facility_id });

      expect(call.isError).toBeFalsy();
      expect(mockGetTriReleases.mock.calls[0]![0]).toMatchObject({ facilityId: '98108THBNG7500E' });
      const structured = call.structuredContent as { facilityId: string; message: string };
      expect(structured.facilityId).toBe('98108THBNG7500E');
      expect(structured.message).toContain('facility "98108THBNG7500E"');
      expect(textOf(call.content)).toContain('## TRI Chemical Releases — Facility 98108THBNG7500E');
    });

    it.each([
      ['a 12-digit EPA Registry ID', '110017848105'],
      ['a 14-character value', '98108THBNG7500'],
      ['a 16-character value', '98108THBNG7500EX'],
      ['a comma-joined pair', '98108THBNG7500E,98108THBNG7500F'],
      ['a slash inside the ID', '98108THBNG/7500E'],
      ['whitespace inside the ID', '98108THBNG 7500E'],
      ['an empty value', ''],
      ['a number', 98108],
    ])(
      'rejects %s at the schema, naming the 15-character form, before any request',
      async (_, facility_id) => {
        const call = await runToolContract(triGetFacilityReleasesTool, { facility_id } as never);

        expect(call.structuredContent).toMatchObject({
          error: { code: JsonRpcErrorCode.InvalidParams },
        });
        const text = textOf(call.content);
        expect(text).toContain('15-character TRI facility ID');
        expect(text).toContain('triFacilityIds');
        expect(mockGetTriReleases).not.toHaveBeenCalled();
      },
    );

    it('advertises a pattern that accepts the raw forms and rejects a Registry ID', () => {
      const json = z.toJSONSchema(triGetFacilityReleasesTool.input.shape.facility_id, {
        io: 'input',
      }) as { pattern: string };
      const pattern = new RegExp(json.pattern, 'u');
      for (const id of ['98108thbng7500e', ' 98108THBNG7500E/'])
        expect(pattern.test(id)).toBe(true);
      for (const id of ['110017848105', '98108THBNG7500']) expect(pattern.test(id)).toBe(false);
    });
  });

  describe('chemical_id', () => {
    const benzeneById = {
      ...benzeneRelease,
      chemicalName: 'Benzene',
      chemicalId: '0000071432',
      casNumber: '71-43-2',
    };

    it.each(['71-43-2', '71432', '0000071432', ' 71-43-2 '])(
      'sends %j as the 10-digit padded CAS number',
      async (chemical_id) => {
        mockGetTriReleases.mockResolvedValue({ items: [benzeneById] });

        const call = await runToolContract(triGetFacilityReleasesTool, {
          facility_id: '98101WA0001234X',
          chemical_id,
          chemical_name: 'benzene',
          year: 2023,
          offset: 5,
          limit: 2,
        });

        expect(call.isError).toBeFalsy();
        expect(mockGetTriReleases.mock.calls[0]![0]).toEqual({
          facilityId: '98101WA0001234X',
          year: 2023,
          chemicalId: '0000071432',
          chemicalName: 'benzene',
          offset: 5,
          limit: 2,
        });
      },
    );

    it.each([
      ['n420', 'N420'],
      ['N420', 'N420'],
      ['TRD SECRT', 'TRD SECRT'],
    ])('sends %j as %j', async (chemical_id, sent) => {
      mockGetTriReleases.mockResolvedValue({ items: [] });

      await runToolContract(triGetFacilityReleasesTool, {
        facility_id: '98101WA0001234X',
        chemical_id,
      });

      expect(mockGetTriReleases.mock.calls[0]![0]).toMatchObject({ chemicalId: sent });
    });

    it('omits a blank chemical_id', async () => {
      mockGetTriReleases.mockResolvedValue({ items: [] });

      await runToolContract(triGetFacilityReleasesTool, {
        facility_id: '98101WA0001234X',
        chemical_id: '  ',
      });

      expect(mockGetTriReleases.mock.calls[0]![0]).not.toHaveProperty('chemicalId');
    });

    it('rejects a CAS number whose check digit fails, naming the expected form, before any request', async () => {
      const call = await runToolContract(triGetFacilityReleasesTool, {
        facility_id: '98101WA0001234X',
        chemical_id: '71-43-1',
      });

      expect(call.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      const text = textOf(call.content);
      expect(text).toContain('fails its check digit');
      expect(text).toContain('"71-43-2"');
      expect(mockGetTriReleases).not.toHaveBeenCalled();
    });

    it('carries chemicalId and casNumber on both surfaces', async () => {
      const category = { ...benzeneRelease, chemicalName: 'Lead compounds', chemicalId: 'N420' };
      mockGetTriReleases.mockResolvedValue({ items: [benzeneById, category] });

      const call = await runToolContract(triGetFacilityReleasesTool, {
        facility_id: '98101WA0001234X',
      });

      expect((call.structuredContent as { releases: unknown[] }).releases).toEqual([
        benzeneById,
        category,
      ]);
      const [benzeneText, leadText] = textOf(call.content).split('\n### ').slice(1);
      expect(benzeneText).toContain('**Chemical ID:** 0000071432\n**CAS Number:** 71-43-2');
      expect(leadText).toContain('**Chemical ID:** N420');
      expect(leadText).not.toContain('CAS Number');
    });

    it('names chemical_id in the empty-result message and its recovery', async () => {
      mockGetTriReleases.mockResolvedValue({ items: [] });

      const call = await runToolContract(triGetFacilityReleasesTool, {
        facility_id: '98101WA0001234X',
        chemical_id: '71-43-2',
      });

      const { message } = call.structuredContent as { message: string };
      expect(message).toMatch(
        /^No TRI releases found for facility "98101WA0001234X" with chemical ID 0000071432\. /,
      );
      expect(message).toContain('Remove chemical_id to include other chemicals.');
    });

    it('describes chemicalId and casNumber with their absent-when rules', () => {
      const item = triGetFacilityReleasesTool.output.shape.releases.element.shape;
      expect(item.chemicalId.description).toBe(
        'TRI chemical ID (a 10-digit zero-padded CAS number, an N-prefixed category code, or a placeholder); pass it as chemical_id for an exact match. Absent when TRI records none.',
      );
      expect(item.casNumber.description).toBe(
        'CAS Registry Number, hyphenated. Absent for a category code or placeholder.',
      );
    });
  });

  it('formats output with chemical name, year, and release amounts', () => {
    const output = { releases: [benzeneRelease], facilityId: '98101WA0001234X' };
    const blocks = triGetFacilityReleasesTool.format!(output);
    expect(blocks).toEqual([
      {
        type: 'text',
        text: [
          '## TRI Chemical Releases — Facility 98101WA0001234X',
          '**Records:** 1',
          '',
          '### BENZENE (2022)',
          '**Facility ID:** 98101WA0001234X',
          '**One-Time Release:** 1,240 lbs',
        ].join('\n'),
      },
    ]);
  });

  it('formats empty result with message', () => {
    const output = {
      releases: [],
      facilityId: '98101WA0001234X',
      message: 'No TRI releases found.',
    };
    const blocks = triGetFacilityReleasesTool.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toBe(
      [
        '## TRI Chemical Releases — Facility 98101WA0001234X',
        '**Records:** 0',
        '',
        '> No TRI releases found.',
      ].join('\n'),
    );
  });

  it('renders sub-0.001 quantities and medium sums at full precision', () => {
    const output = {
      releases: [
        {
          facilityId: '36701GLBMTOLDMO',
          chemicalName: 'Dioxin and dioxin-like compounds',
          reportingYear: 2022,
          oneTimeReleaseInLbs: 0.00062,
          // AIR STACK 0.000894 + AIR FUG 0.000014, as the breakdown rollup sums them.
          releasesToAirInLbs: 0.000894 + 0.000014,
          releasesToWaterInLbs: 0.0000001,
          releasesToLandInLbs: 0.0005809,
          releasesToUndergroundInjectionInLbs: 2134695,
        },
      ],
      facilityId: '36701GLBMTOLDMO',
    };
    const text = (triGetFacilityReleasesTool.format!(output)[0] as { type: string; text: string })
      .text;
    expect(text).toContain('**One-Time Release:** 0.00062 lbs');
    expect(text).toContain('**Air Releases:** 0.000908 lbs');
    expect(text).toContain('**Water Releases:** 0.0000001 lbs');
    expect(text).toContain('**Land Releases:** 0.0005809 lbs');
    expect(text).toContain('**Underground Injection:** 2,134,695 lbs');
  });

  it('formats sparse release (only required fields)', () => {
    const sparse = {
      releases: [{ facilityId: 'WA9999', chemicalName: 'MERCURY', reportingYear: 2020 }],
      facilityId: 'WA9999',
    };
    const blocks = triGetFacilityReleasesTool.format!(sparse);
    const text = (blocks[0] as { type: string; text: string }).text;
    // Heading and per-record facility line only — no unit or quantity line.
    expect(text).toBe(
      [
        '## TRI Chemical Releases — Facility WA9999',
        '**Records:** 1',
        '',
        '### MERCURY (2020)',
        '**Facility ID:** WA9999',
      ].join('\n'),
    );
  });

  describe('facility_id source pointers', () => {
    it('description sources facility_id from epa_tri_search_releases, never epa_echo_search_facilities', () => {
      expect(triGetFacilityReleasesTool.description).toContain('epa_tri_search_releases');
      expect(triGetFacilityReleasesTool.description).toContain('15-character TRI facility ID');
      expect(triGetFacilityReleasesTool.description).not.toContain('epa_echo_search_facilities');
    });

    it('facility_id .describe() names the 15-character TRI ID from epa_tri_search_releases', () => {
      const text = triGetFacilityReleasesTool.input.shape.facility_id.description ?? '';
      expect(text).toContain('15-character TRI facility ID');
      expect(text).toContain('facilityId');
      expect(text).toContain('epa_tri_search_releases');
      expect(text).not.toContain('epa_echo_search_facilities');
      expect(text).not.toContain('RegistryID');
    });

    it('empty-result message points at epa_tri_search_releases', async () => {
      mockGetTriReleases.mockResolvedValue({ items: [] });
      const ctx = createMockContext({ errors: triGetFacilityReleasesTool.errors });
      const input = triGetFacilityReleasesTool.input.parse({
        facility_id: '98101WA0001234X',
        year: 2022,
      });
      const result = await triGetFacilityReleasesTool.handler(input, ctx);
      expect(result.message).toContain('epa_tri_search_releases');
      expect(result.message).not.toContain('epa_echo_search_facilities');
      const text = (triGetFacilityReleasesTool.format!(result)[0] as { text: string }).text;
      expect(text).toContain('epa_tri_search_releases');
      expect(text).not.toContain('epa_echo_search_facilities');
    });

    it('regression #31: every source pointer also names epa_echo_get_facility triFacilityIds', async () => {
      mockGetTriReleases.mockResolvedValue({ items: [] });
      const input = triGetFacilityReleasesTool.input.parse({ facility_id: '98101WA0001234X' });
      const result = await triGetFacilityReleasesTool.handler(
        input,
        createMockContext({ errors: triGetFacilityReleasesTool.errors }),
      );
      for (const text of [
        triGetFacilityReleasesTool.description,
        triGetFacilityReleasesTool.input.shape.facility_id.description ?? '',
        result.message ?? '',
      ]) {
        expect(text).toContain('epa_echo_get_facility');
        expect(text).toContain('triFacilityIds');
      }
    });
  });

  it("bounds chemical_name at 4,094 characters, DMAP's whole request-line limit", () => {
    const longestChemical =
      '2-Propenoic acid, butyl ester, telomer with 2-[[(heptadecafluorooctyl)sulfonyl]methylamino]ethyl 2-propenoate, 2-[methyl[(nonafluorobutyl)sulfonyl]amino]ethyl 2-propenoate, α-(2-methyl-1-oxo-2-propenyl)-ω-hydroxypoly(oxy-1,4-butanediyl), α-(2-methyl-1-oxo-2-propenyl)-ω-[(2-methyl-1-oxo-2-propenyl)oxy]poly(oxy-1,4-butanediyl), 2-[methyl[(pentadecafluoroheptyl)sulfonyl]amino]ethyl 2-propenoate, 2-[methyl[(tridecafluorohexyl)sulfonyl]amino]ethyl 2-propenoate, 2-[methyl[(undecafluoropentyl)sulfonyl]amino]ethyl 2-propenoate and 1-octanethiol';
    const parse = (chemical_name: string) =>
      triGetFacilityReleasesTool.input.safeParse({ facility_id: '98108THBNG7500E', chemical_name })
        .success;
    expect(longestChemical).toHaveLength(542);
    expect(parse(longestChemical)).toBe(true);
    expect(parse('x'.repeat(4094))).toBe(true);
    expect(parse('x'.repeat(4095))).toBe(false);
    expect(triGetFacilityReleasesTool.input.shape.chemical_name.description).toContain(
      'matched as written',
    );
  });

  it('carries every per-medium field through the output schema to structuredContent', async () => {
    mockGetTriReleases.mockResolvedValue({ items: [fullBreakdownRelease] });
    const call = await runToolContract(triGetFacilityReleasesTool, {
      facility_id: '98101WA0005678X',
    });
    expect(call.isError).toBeFalsy();
    expect(call.structuredContent).toEqual({
      releases: [fullBreakdownRelease],
      facilityId: '98101WA0005678X',
    });
  });

  it('formats all four media plus the distinct one-time release line', () => {
    const output = { releases: [fullBreakdownRelease], facilityId: '98101WA0005678X' };
    const text = (triGetFacilityReleasesTool.format!(output)[0] as { type: string; text: string })
      .text;
    // one_time_release_qty is a separate TRI category, rendered after the per-medium releases.
    expect(text.split('\n').slice(3)).toEqual([
      '### TOLUENE (2021)',
      '**Facility ID:** 98101WA0005678X',
      '**Air Releases:** 15,000 lbs',
      '**Water Releases:** 200 lbs',
      '**Land Releases:** 3,400 lbs',
      '**Underground Injection:** 90,000 lbs',
      '**One-Time Release:** 0 lbs',
    ]);
  });

  describe('gram-reported chemicals', () => {
    const dioxin = {
      facilityId: '96020CLLNS500MA',
      chemicalName: 'Dioxin and dioxin-like compounds',
      reportingYear: 2022,
      reportedUnit: 'grams' as const,
      releasesToAirInLbs: 0.000162952476471,
      releasesToLandInLbs: 1.28066528103e-6,
    };

    it('carries reportedUnit and the converted pounds on both surfaces', async () => {
      mockGetTriReleases.mockResolvedValue({ items: [dioxin, benzeneRelease] });
      const call = await runToolContract(triGetFacilityReleasesTool, {
        facility_id: '96020CLLNS500MA',
        year: 2022,
      });
      expect(call.isError).toBeFalsy();
      const structured = call.structuredContent as { releases: Array<Record<string, unknown>> };
      expect(structured.releases).toEqual([dioxin, benzeneRelease]);
      const text = textOf(call.content);
      expect(text).toContain(
        '**Reported Unit:** grams — any quantities shown are converted to pounds (1 lb = 453.59237 g)',
      );
      expect(text).toContain('**Air Releases:** 0.000162952476471 lbs');
      expect(text).toContain('**Land Releases:** 0.00000128066528103 lbs');
      // A pound-reported chemical gets no unit line.
      expect(text.match(/Reported Unit/g)).toHaveLength(1);
    });

    it('formats a gram-reported record with no quantities without promising any', () => {
      const text = (
        triGetFacilityReleasesTool.format!({
          releases: [
            {
              facilityId: '98421STMPS',
              chemicalName: 'Dioxin and dioxin-like compounds',
              reportingYear: 2022,
              reportedUnit: 'grams',
            },
          ],
          facilityId: '98421STMPS',
        })[0] as { text: string }
      ).text;
      expect(text).toContain(
        '**Reported Unit:** grams — any quantities shown are converted to pounds (1 lb = 453.59237 g)',
      );
      expect(text).not.toMatch(/below|lbs/);
    });

    it('describes reportedUnit as the dioxin grams marker and the quantities as pounds', () => {
      const item = triGetFacilityReleasesTool.output.shape.releases.element.shape;
      expect(item.reportedUnit.description).toMatch(/dioxin/i);
      expect(item.reportedUnit.description).toMatch(/converted to pounds/i);
      expect(triGetFacilityReleasesTool.description).toMatch(/grams/);
    });
  });

  describe('paging', () => {
    it('defaults to 25 filings from offset 0 and passes limit and offset to the service', async () => {
      mockGetTriReleases.mockResolvedValue({ items: [benzeneRelease] });

      await runToolContract(triGetFacilityReleasesTool, { facility_id: '98101WA0001234X' });
      await runToolContract(triGetFacilityReleasesTool, {
        facility_id: '98101WA0001234X',
        offset: 5,
        limit: 5,
      });

      expect(mockGetTriReleases.mock.calls.map(([params]) => params)).toEqual([
        { facilityId: '98101WA0001234X', offset: 0, limit: 25 },
        { facilityId: '98101WA0001234X', offset: 5, limit: 5 },
      ]);
    });

    it('continues a capped lookup with nextOffset and guidance on both surfaces', async () => {
      mockGetTriReleases.mockResolvedValue({ items: [benzeneRelease], nextOffset: 501 });

      const call = await runToolContract(triGetFacilityReleasesTool, {
        facility_id: '98101WA0001234X',
        offset: 500,
        limit: 1,
      });

      expect(call.structuredContent).toMatchObject({
        nextOffset: 501,
        truncated: true,
        shown: 1,
        cap: 1,
        guidance: 'More records follow; call again with offset 501 to continue.',
      });
      const text = textOf(call.content);
      expect(text).toContain('**Next offset:** 501');
      expect(text).toContain('More records follow; call again with offset 501 to continue.');
      expect(text.toLowerCase()).not.toContain('raise');
    });

    it('serves limit 699 unclamped and clamps 700 to 699 with a notice', async () => {
      mockGetTriReleases.mockResolvedValue({ items: [benzeneRelease] });

      const atCap = await runToolContract(triGetFacilityReleasesTool, {
        facility_id: '98101WA0001234X',
        limit: 699,
      });
      const call = await runToolContract(triGetFacilityReleasesTool, {
        facility_id: '98101WA0001234X',
        limit: 700,
      });

      expect(atCap.structuredContent).not.toHaveProperty('limitNotice');
      expect(call.isError).toBeFalsy();
      expect(mockGetTriReleases.mock.calls.map(([params]) => params.limit)).toEqual([699, 699]);
      const notice = (call.structuredContent as { limitNotice?: string }).limitNotice;
      expect(notice).toBe(
        "limit 700 is above this tool's cap of 699, so at most 699 records were returned.",
      );
      expect(textOf(call.content)).toContain(`> ${notice}`);
      expect(triGetFacilityReleasesTool.input.shape.limit.description).toBe(
        'Number of filings to return in one call. Default 25; a larger value returns at most 699 and says so. Page past it with offset and nextOffset.',
      );
    });

    it('says an empty page past the end is past the end', async () => {
      mockGetTriReleases.mockResolvedValue({ items: [] });

      const call = await runToolContract(triGetFacilityReleasesTool, {
        facility_id: '98101WA0001234X',
        offset: 40,
      });

      const structured = call.structuredContent as { releases: unknown[]; message: string };
      expect(structured.message).toBe(
        'No TRI releases found for facility "98101WA0001234X" at offset 40: the lookup has no records past it. Lower offset, or start again at offset 0.',
      );
      expect(structured).not.toHaveProperty('nextOffset');
      expect(structured).not.toHaveProperty('truncated');
    });

    it('stays a lookup: no effectiveQuery echo', async () => {
      mockGetTriReleases.mockResolvedValue({ items: [benzeneRelease] });

      const call = await runToolContract(triGetFacilityReleasesTool, {
        facility_id: '98101WA0001234X',
        year: 2022,
      });

      expect(call.isError).toBeFalsy();
      expect(call.structuredContent).toMatchObject({ releases: [benzeneRelease] });
      expect(call.structuredContent).not.toHaveProperty('effectiveQuery');
    });
  });

  describe('release totals', () => {
    it('carries the one-time quantity and the on-site total on both surfaces', async () => {
      const release = {
        ...fullBreakdownRelease,
        oneTimeReleaseInLbs: 25,
        totalOnSiteReleasesInLbs: 108600,
      };
      mockGetTriReleases.mockResolvedValue({ items: [release] });

      const call = await runToolContract(triGetFacilityReleasesTool, {
        facility_id: '98101WA0005678X',
      });

      expect((call.structuredContent as { releases: unknown[] }).releases).toEqual([release]);
      const text = textOf(call.content);
      expect(text).toContain('**Total On-Site Releases:** 108,600 lbs');
      expect(text).toContain('**One-Time Release:** 25 lbs');
    });

    it('describes the fields without calling the media routine or the tool a ranking', () => {
      const item = triGetFacilityReleasesTool.output.shape.releases.element.shape;
      expect(item).not.toHaveProperty('totalReleasesInLbs');
      expect(item.oneTimeReleaseInLbs.description).toContain('already counted');
      expect(item.totalOnSiteReleasesInLbs.description).toContain('midpoint');
      for (const text of [
        triGetFacilityReleasesTool.description,
        ...Object.values(item).map((field) => field.description ?? ''),
      ]) {
        expect(text).not.toMatch(/routine/i);
        expect(text).not.toMatch(/top (polluters|emitters)/i);
        expect(text).not.toContain('NOT the sum');
      }
    });
  });

  describe('DMAP input rejections through the real service', () => {
    beforeEach(() => {
      liveService.current = new DmapService({} as AppConfig, {} as StorageService);
    });
    afterEach(() => {
      liveService.current = undefined;
      vi.restoreAllMocks();
    });

    const unmatchableHint = 'Include a letter or digit in chemical_name, or remove it.';
    const tooLongHint = 'Shorten chemical_name to a distinctive part of the name and retry.';

    it.each([
      [
        'a chemical_name with no letter or digit',
        { facility_id: '98108THBNG7500E', chemical_name: "'''" },
        'unmatchable_filter',
        unmatchableHint,
        'has no letter or digit',
      ],
      [
        'a chemical_name past the request line',
        { facility_id: '98108THBNG7500E', chemical_name: 'a'.repeat(4000) },
        'filter_too_long',
        tooLongHint,
        'too long',
      ],
    ])(
      'rejects %s with its declared reason and recovery on both surfaces, before any request',
      async (_, args, reason, hint, message) => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        const call = await runToolContract(triGetFacilityReleasesTool, args);

        expectValidationRejection(call, { reason, hint, message });
        expect(fetchSpy).not.toHaveBeenCalled();
      },
    );
  });

  it('omits absent media in format without fabricating zero', () => {
    const airOnly = {
      releases: [
        {
          facilityId: 'WA0009999',
          chemicalName: 'XYLENE',
          reportingYear: 2020,
          releasesToAirInLbs: 500,
        },
      ],
      facilityId: 'WA0009999',
    };
    const text = (triGetFacilityReleasesTool.format!(airOnly)[0] as { type: string; text: string })
      .text;
    expect(text).toContain('**Air Releases:** 500 lbs');
    expect(text).not.toContain('Water Releases');
    expect(text).not.toContain('Land Releases');
    expect(text).not.toContain('Underground Injection');
    expect(text).not.toContain('One-Time Release');
  });
});
