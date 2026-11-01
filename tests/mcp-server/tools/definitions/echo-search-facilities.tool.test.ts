/**
 * @fileoverview Tests for echoSearchFacilitiesTool.
 * @module tests/mcp-server/tools/definitions/echo-search-facilities.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { echoSearchFacilitiesTool } from '@/mcp-server/tools/definitions/echo-search-facilities.tool.js';
import { describeLocationRendering, expectLinearCpu } from '../../../helpers.js';

const mockSearchFacilities = vi.fn();

vi.mock('@/services/echo/echo-service.js', () => ({
  getEchoService: () => ({
    searchFacilities: mockSearchFacilities,
    getFacility: vi.fn(),
    searchViolations: vi.fn(),
  }),
}));

const boeingFacility = {
  registryId: '110000350509',
  name: 'BOEING COMMERCIAL AIRPLANES',
  street: '3003 W CASINO RD',
  city: 'EVERETT',
  state: 'WA',
  zip: '98204',
  county: 'SNOHOMISH',
  fipsCode: '53061',
  latitude: 47.917,
  longitude: -122.248,
  complianceStatus: 'No Recent Activity',
  programs: { air: true, water: true, rcra: false, tri: true, sdwa: false },
  triFacilityIds: ['98204BNGCM3003W'],
  triReleasesTransfersInLbs: 48210,
  inspectionCount: 5,
  totalPenaltiesInDollars: 15000,
};

const noPrograms = { air: false, water: false, rcra: false, tri: false, sdwa: false };

const mockContext = () => createMockContext({ errors: echoSearchFacilitiesTool.errors });

/** Runs the handler on parsed `args`, returning its result and the call's enrichment. */
async function run(args: Record<string, unknown>) {
  const ctx = mockContext();
  const result = await echoSearchFacilitiesTool.handler(
    echoSearchFacilitiesTool.input.parse(args),
    ctx,
  );
  return { result, enrichment: getEnrichment(ctx), ctx };
}

describe('echoSearchFacilitiesTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchFacilities.mockResolvedValue({ items: [boeingFacility], totalCount: 1 });
  });

  it('returns facilities for valid state filter', async () => {
    mockSearchFacilities.mockResolvedValue({ items: [boeingFacility], totalCount: 412 });
    const { result, ctx } = await run({ state: ' WA ' });
    expect(mockSearchFacilities).toHaveBeenCalledWith({ state: 'WA', limit: 50, offset: 0 }, ctx);
    expect(result).toEqual({ facilities: [boeingFacility], totalCount: 412 });
  });

  it('returns facilities for valid zip_code filter', async () => {
    const { result, ctx } = await run({ zip_code: '98204' });
    expect(mockSearchFacilities).toHaveBeenCalledWith(
      { zipCode: '98204', limit: 50, offset: 0 },
      ctx,
    );
    expect(result.facilities).toEqual([boeingFacility]);
  });

  it('returns facilities for city+state filter', async () => {
    const { result, ctx } = await run({ city: 'EVERETT', state: 'WA' });
    expect(mockSearchFacilities).toHaveBeenCalledWith(
      { state: 'WA', city: 'EVERETT', limit: 50, offset: 0 },
      ctx,
    );
    expect(result.facilities).toEqual([boeingFacility]);
  });

  it('regression #38: passes the one program and the violation and activity filters to the service', async () => {
    const { ctx } = await run({
      state: 'WA',
      programs: ['TRI'],
      has_violation: true,
      active_only: true,
    });
    expect(mockSearchFacilities).toHaveBeenCalledWith(
      {
        state: 'WA',
        program: 'TRI',
        hasViolation: true,
        activeOnly: true,
        limit: 50,
        offset: 0,
      },
      ctx,
    );
  });

  it('regression #38: rejects more than one program at the schema', () => {
    // ECHO's p_med takes one media code; a list ran the search unfiltered.
    const parsed = echoSearchFacilitiesTool.input.safeParse({
      state: 'WA',
      programs: ['TRI', 'CAA'],
    });
    expect(parsed.success).toBe(false);
    expect(echoSearchFacilitiesTool.input.safeParse({ state: 'WA', programs: [] }).success).toBe(
      true,
    );
  });

  it('sends no program for an empty programs list', async () => {
    const { ctx } = await run({ state: 'WA', programs: [] });
    expect(mockSearchFacilities).toHaveBeenCalledWith({ state: 'WA', limit: 50, offset: 0 }, ctx);
  });

  it('throws no_geographic_filter when no location provided', async () => {
    await expect(run({ active_only: true })).rejects.toMatchObject({
      data: { reason: 'no_geographic_filter' },
    });
  });

  it('throws no_geographic_filter when all location fields are blank strings', async () => {
    await expect(
      run({ state: '  ', city: '  ', zip_code: '  ', county_fips: ' ' }),
    ).rejects.toMatchObject({ data: { reason: 'no_geographic_filter' } });
    expect(mockSearchFacilities).not.toHaveBeenCalled();
  });

  it('returns facilities for a latitude+longitude+radius_miles proximity filter', async () => {
    const { result } = await run({ latitude: 47.917, longitude: -122.248, radius_miles: 10 });
    expect(result.facilities).toHaveLength(1);
    expect(mockSearchFacilities).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: 47.917, longitude: -122.248, radiusMiles: 10 }),
      expect.anything(),
    );
  });

  it('accepts latitude/longitude of 0 (equator / prime meridian) as a complete triple', async () => {
    mockSearchFacilities.mockResolvedValue({ items: [], totalCount: 0 });
    await run({ latitude: 0, longitude: 0, radius_miles: 25 });
    // 0 is a valid coordinate — the triple is complete and forwarded, not dropped by a truthy guard.
    expect(mockSearchFacilities).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: 0, longitude: 0, radiusMiles: 25 }),
      expect.anything(),
    );
  });

  it('throws incomplete_proximity when only latitude is provided', async () => {
    await expect(run({ latitude: 47.6 })).rejects.toMatchObject({
      data: { reason: 'incomplete_proximity' },
    });
  });

  it('throws incomplete_proximity when latitude+longitude are given without radius_miles', async () => {
    await expect(run({ latitude: 47.6, longitude: -122.3 })).rejects.toMatchObject({
      data: { reason: 'incomplete_proximity' },
    });
  });

  describe('regression #70: the empty-result message keeps its advice without restating filters', () => {
    it('says nothing matched', async () => {
      mockSearchFacilities.mockResolvedValue({ items: [], totalCount: 0 });
      const { result } = await run({
        zip_code: '98108',
        programs: ['SDWA'],
        active_only: true,
        has_violation: true,
      });
      expect(result).toEqual({
        facilities: [],
        totalCount: 0,
        message:
          'No facilities matched. Try broadening the geographic area or removing the name, NAICS, program, or violation filters.',
      });
    });

    it('names an offset past the end, keeping the matched total', async () => {
      mockSearchFacilities.mockResolvedValue({ items: [], totalCount: 147 });
      const { result, enrichment } = await run({ state: 'WA', offset: 150 });
      expect(result).toEqual({
        facilities: [],
        totalCount: 147,
        message:
          'offset 150 is past the last of the 147 matching facilities; call again with a smaller offset.',
      });
      expect(enrichment).not.toHaveProperty('nextOffset');
    });
  });

  describe('regression #61: name, county, FIPS, and NAICS filters', () => {
    it.each(['county_fips', 'naics', 'facility_name'] as const)(
      'checks a long %s in time linear in its length',
      (field) => {
        const schema = echoSearchFacilitiesTool.input.shape[field];
        expectLinearCpu((value) => schema.safeParse(value));
      },
    );

    it('sends county without its suffix, uppercased, alongside state', async () => {
      const { ctx } = await run({ state: 'wa', county: ' King County ' });
      expect(mockSearchFacilities).toHaveBeenCalledWith(
        { state: 'WA', county: 'KING', limit: 50, offset: 0 },
        ctx,
      );
    });

    it('rejects county without state before any request', async () => {
      await expect(run({ county: 'KING', zip_code: '98108' })).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'county_requires_state' },
      });
      expect(mockSearchFacilities).not.toHaveBeenCalled();
    });

    it('scopes a search with county_fips alone', async () => {
      const { ctx } = await run({ county_fips: ' 53033 ' });
      expect(mockSearchFacilities).toHaveBeenCalledWith(
        { countyFips: '53033', limit: 50, offset: 0 },
        ctx,
      );
    });

    it.each([
      ['facility_name', { facility_name: 'BOEING' }],
      ['naics', { naics: '3364' }],
    ])('still needs a geographic filter with %s alone', async (_field, args) => {
      await expect(run(args)).rejects.toMatchObject({ data: { reason: 'no_geographic_filter' } });
      expect(mockSearchFacilities).not.toHaveBeenCalled();
    });

    it('sends facility_name and naics trimmed', async () => {
      const { ctx } = await run({ state: 'WA', facility_name: ' BOEING PLANT ', naics: '3364' });
      expect(mockSearchFacilities).toHaveBeenCalledWith(
        { state: 'WA', facilityName: 'BOEING PLANT', naics: '3364', limit: 50, offset: 0 },
        ctx,
      );
    });

    it('rejects a comma in facility_name at the schema, naming why', () => {
      const parsed = echoSearchFacilitiesTool.input.safeParse({
        state: 'WA',
        facility_name: 'BOEING,PACCAR',
      });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toContain('list separator');
    });

    /** The advertised JSON Schema pattern of an input field. */
    const pattern = (field: string) => {
      const schema = z.toJSONSchema(echoSearchFacilitiesTool.input) as {
        properties: Record<string, { pattern?: string }>;
      };
      return new RegExp(schema.properties[field]!.pattern!);
    };

    it.each([
      ['county_fips', ['53033', ' 53033 ', ''], ['5303', '530330', '53O33', '53']],
      ['naics', ['33', '3364', '33641', '336411', ' 3364 ', ''], ['3', '3364111', '33-64', 'ab']],
    ])(
      '%s advertises a pattern that accepts each answered form and rejects the rest',
      (field, accepted, rejected) => {
        for (const value of accepted) {
          expect(pattern(field).test(value)).toBe(true);
          expect(echoSearchFacilitiesTool.input.safeParse({ [field]: value }).success).toBe(true);
        }
        for (const value of rejected) {
          expect(pattern(field).test(value)).toBe(false);
          expect(echoSearchFacilitiesTool.input.safeParse({ [field]: value }).success).toBe(false);
        }
      },
    );
  });

  describe('regression #56: state and ZIP formats', () => {
    it('normalizes a lowercase, padded state and searches a ZIP+4 by its first five digits', async () => {
      const { ctx } = await run({ state: ' wa ', zip_code: '98108-1234' });
      expect(mockSearchFacilities).toHaveBeenCalledWith(
        { state: 'WA', zipCode: '98108', limit: 50, offset: 0 },
        ctx,
      );
    });

    it('sends a 2-character code outside the USPS set to ECHO, which files offshore platforms under DM', async () => {
      const { ctx } = await run({ state: ' dm ' });
      expect(mockSearchFacilities).toHaveBeenCalledWith({ state: 'DM', limit: 50, offset: 0 }, ctx);
      expect(echoSearchFacilitiesTool.errors?.map((e) => e.reason)).not.toContain('invalid_state');
    });

    it.each([{ state: 'Washington' }, { zip_code: '9810' }])('rejects %o at the schema', (args) => {
      expect(echoSearchFacilitiesTool.input.safeParse(args).success).toBe(false);
    });
  });

  describe('regression #70: effectiveQuery echoes what was sent upstream', () => {
    it('states normalized values and how each text filter matched', async () => {
      const { enrichment } = await run({
        state: 'wa',
        county: 'King County',
        city: 'SEAT',
        facility_name: 'BOEING',
        naics: '3364',
        programs: ['CAA'],
        has_violation: true,
        active_only: true,
      });
      expect(enrichment.effectiveQuery).toBe(
        'state=WA; city begins with SEAT; county begins with KING; facility_name has words BOEING; naics begins with 3364; active_only=true; programs=CAA; has_violation=true',
      );
    });

    it('echoes on an empty result, a ZIP+4 as its five digits, and the proximity triple', async () => {
      mockSearchFacilities.mockResolvedValue({ items: [], totalCount: 0 });
      const zip = await run({ zip_code: '981081234', state: '' });
      expect(zip.enrichment.effectiveQuery).toBe('zip_code=98108');

      const near = await run({ latitude: 0, longitude: -122.3, radius_miles: 5 });
      expect(near.enrichment.effectiveQuery).toBe('latitude=0; longitude=-122.3; radius_miles=5');
    });

    it('echoes county_fips exactly', async () => {
      const { enrichment } = await run({ county_fips: '53033' });
      expect(enrichment.effectiveQuery).toBe('county_fips=53033');
    });
  });

  describe('regression #53: paging', () => {
    it('passes offset, and returns nextOffset with guidance naming it when more follow', async () => {
      mockSearchFacilities.mockResolvedValue({
        items: [boeingFacility],
        totalCount: 147,
        nextOffset: 51,
      });
      const { enrichment, ctx } = await run({ state: 'WA', facility_name: 'BOEING', offset: 50 });
      expect(mockSearchFacilities).toHaveBeenCalledWith(
        { state: 'WA', facilityName: 'BOEING', limit: 50, offset: 50 },
        ctx,
      );
      expect(enrichment).toMatchObject({
        nextOffset: 51,
        notice: 'More records follow; call again with offset 51 to continue.',
      });
    });

    it('returns no nextOffset or notice on the last page', async () => {
      const { enrichment } = await run({ state: 'WA' });
      expect(enrichment).not.toHaveProperty('nextOffset');
      expect(enrichment).not.toHaveProperty('notice');
    });

    it('clamps a limit above the cap to 100 with a notice, and rejects one above 5,000', async () => {
      const { enrichment, ctx } = await run({ state: 'WA', limit: 1000 });
      expect(mockSearchFacilities).toHaveBeenCalledWith(
        { state: 'WA', limit: 100, offset: 0 },
        ctx,
      );
      expect(enrichment.limitNotice).toBe(
        "limit 1000 is above this tool's cap of 100, so at most 100 records were returned.",
      );
      expect(echoSearchFacilitiesTool.input.safeParse({ state: 'WA', limit: 5001 }).success).toBe(
        false,
      );
      expect(echoSearchFacilitiesTool.input.safeParse({ state: 'WA', offset: -1 }).success).toBe(
        false,
      );
    });

    it('carries the page, its continuation, and the echo on both surfaces', async () => {
      mockSearchFacilities.mockResolvedValue({
        items: [boeingFacility],
        totalCount: 147,
        nextOffset: 100,
      });
      const result = await runToolContract(echoSearchFacilitiesTool, {
        state: 'WA',
        facility_name: 'BOEING',
        offset: 99,
        limit: 1,
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        facilities: [boeingFacility],
        totalCount: 147,
        effectiveQuery: 'state=WA; facility_name has words BOEING',
        nextOffset: 100,
        notice: 'More records follow; call again with offset 100 to continue.',
      });
      const text = (result.content as Array<{ text?: string }>).map((b) => b.text).join('\n');
      expect(text).toContain('**Next offset:** 100');
      expect(text).toContain('> More records follow; call again with offset 100 to continue.');
      expect(text).toContain('`state=WA; facility_name has words BOEING`');
      expect(text).toContain('**TRI Facility IDs:** 98204BNGCM3003W');
    });
  });

  it('formats results with registry IDs, programs, TRI IDs, and penalty data', () => {
    const output = {
      facilities: [{ ...boeingFacility, triFacilityIds: ['98106HCKTT2424S', '98106SLMNB2424S'] }],
      totalCount: 412,
    };
    const blocks = echoSearchFacilitiesTool.format!(output);
    expect(blocks).toHaveLength(1);
    const lines = (blocks[0] as { type: string; text: string }).text.split('\n');
    for (const line of [
      '## EPA Facility Search Results',
      '**Total Found:** 412 | **Returned:** 1',
      '### BOEING COMMERCIAL AIRPLANES',
      '**Registry ID:** 110000350509',
      '**Location:** 3003 W CASINO RD, EVERETT, WA, 98204',
      '**County:** SNOHOMISH (FIPS: 53061)',
      '**Coordinates:** 47.917, -122.248',
      '**Compliance Status:** No Recent Activity',
      '**Programs:** AIR, WATER, TRI',
      '**TRI Facility IDs:** 98106HCKTT2424S, 98106SLMNB2424S',
      '**TRI Releases+Transfers:** 48,210 lbs',
      '**Inspections:** 5',
      '**Total Penalties:** $15,000',
    ]) {
      expect(lines).toContain(line);
    }
  });

  it('renders a sub-0.001 TRI releases+transfers total at full precision', () => {
    const text = (
      echoSearchFacilitiesTool.format!({
        facilities: [{ ...boeingFacility, triReleasesTransfersInLbs: 0.00062 }],
        totalCount: 1,
      })[0] as { text: string }
    ).text;
    expect(text).toContain('**TRI Releases+Transfers:** 0.00062 lbs');
  });

  it('formats empty result with message', () => {
    const output = {
      facilities: [],
      totalCount: 0,
      message: 'No facilities matched.',
    };
    const blocks = echoSearchFacilitiesTool.format!(output);
    const lines = (blocks[0] as { type: string; text: string }).text.split('\n');
    expect(lines).toContain('**Total Found:** 0 | **Returned:** 0');
    expect(lines).toContain('> No facilities matched.');
  });

  describe('ID handoff wording', () => {
    const facilityShape = echoSearchFacilitiesTool.output.shape.facilities.element.shape;

    it('description sends Registry IDs to epa_echo_get_facility and TRI IDs to epa_tri_get_facility_releases', () => {
      expect(echoSearchFacilitiesTool.description).toContain(
        'Registry IDs returned here feed epa_echo_get_facility; TRI facility IDs feed epa_tri_get_facility_releases',
      );
    });

    it('registryId .describe() names only epa_echo_get_facility', () => {
      const text = facilityShape.registryId.description ?? '';
      expect(text).toContain('epa_echo_get_facility');
      expect(text).not.toContain('epa_tri_get_facility_releases');
    });

    it('regression #61: triReleasesTransfersInLbs takes the TRI facility ID from triFacilityIds, not another search', () => {
      const text = facilityShape.triReleasesTransfersInLbs.description ?? '';
      expect(text).toContain('triFacilityIds');
      expect(text).toContain('epa_tri_get_facility_releases');
      expect(text).not.toContain('epa_tri_search_releases');
    });

    it('regression #61: triFacilityIds claims no reporting-year order', () => {
      const text = facilityShape.triFacilityIds.description ?? '';
      expect(text).toContain('not reporting-year order');
      expect(text).not.toContain('most recent');
    });
  });

  it('formats sparse facility (minimal fields)', () => {
    const sparse = {
      facilities: [
        {
          registryId: 'SPARSE001',
          name: 'SPARSE FACILITY',
          programs: noPrograms,
          triFacilityIds: [],
        },
      ],
      totalCount: 1,
    };
    const blocks = echoSearchFacilitiesTool.format!(sparse);
    const text = (blocks[0] as { type: string; text: string }).text;
    // Absent fields render no lines at all — no Programs or TRI line when nothing is recorded.
    expect(text.slice(text.indexOf('### '))).toBe(
      '### SPARSE FACILITY\n**Registry ID:** SPARSE001',
    );
  });

  describeLocationRendering(
    (fields) =>
      (
        echoSearchFacilitiesTool.format!({
          facilities: [
            {
              registryId: 'COORD001',
              name: 'COORD FACILITY',
              programs: noPrograms,
              triFacilityIds: [],
              ...fields,
            },
          ],
          totalCount: 1,
        })[0] as { text: string }
      ).text,
  );
});
