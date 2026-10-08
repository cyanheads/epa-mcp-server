/**
 * @fileoverview Tests for getTriReleasesTool.
 * @module tests/mcp-server/tools/definitions/get-tri-releases.tool.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTriReleasesTool } from '@/mcp-server/tools/definitions/get-tri-releases.tool.js';

const mockGetTriReleases = vi.fn();

vi.mock('@/services/dmap/dmap-service.js', () => ({
  getDmapService: () => ({
    getTriReleases: mockGetTriReleases,
    searchTriReleases: vi.fn(),
    searchSuperfund: vi.fn(),
    searchWaterSystems: vi.fn(),
  }),
}));

const benzeneRelease = {
  facilityId: 'WA0001234',
  chemicalName: 'BENZENE',
  reportingYear: 2022,
  totalReleasesInLbs: 1240,
};

const fullBreakdownRelease = {
  facilityId: 'WA0005678',
  chemicalName: 'TOLUENE',
  reportingYear: 2021,
  totalReleasesInLbs: 0,
  releasesToAirInLbs: 15000,
  releasesToWaterInLbs: 200,
  releasesToLandInLbs: 3400,
  releasesToUndergroundInjectionInLbs: 90000,
};

describe('getTriReleasesTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns TRI releases for valid facility ID', async () => {
    mockGetTriReleases.mockResolvedValue([benzeneRelease]);
    const ctx = createMockContext({ errors: getTriReleasesTool.errors });
    const input = getTriReleasesTool.input.parse({ facility_id: 'WA0001234' });
    const result = await getTriReleasesTool.handler(input, ctx);
    expect(result).toEqual({ releases: [benzeneRelease], facilityId: 'WA0001234' });
    expect(mockGetTriReleases).toHaveBeenCalledWith({ facilityId: 'WA0001234' }, ctx);
  });

  it('passes year and chemical_name filters to service', async () => {
    mockGetTriReleases.mockResolvedValue([benzeneRelease]);
    const ctx = createMockContext({ errors: getTriReleasesTool.errors });
    const input = getTriReleasesTool.input.parse({
      facility_id: 'WA0001234',
      year: 2022,
      chemical_name: 'BENZENE',
    });
    await getTriReleasesTool.handler(input, ctx);
    expect(mockGetTriReleases).toHaveBeenCalledWith(
      { facilityId: 'WA0001234', year: 2022, chemicalName: 'BENZENE' },
      expect.anything(),
    );
  });

  it('returns message when no releases found', async () => {
    mockGetTriReleases.mockResolvedValue([]);
    const ctx = createMockContext({ errors: getTriReleasesTool.errors });
    const input = getTriReleasesTool.input.parse({ facility_id: 'NOFACILITY' });
    const result = await getTriReleasesTool.handler(input, ctx);
    expect(result.releases).toEqual([]);
    expect(result.facilityId).toBe('NOFACILITY');
    expect(result.message).toMatch(
      /^No TRI releases found for facility "NOFACILITY"\. TRI data lags/,
    );
  });

  it('includes year in no-results message when year filter provided', async () => {
    mockGetTriReleases.mockResolvedValue([]);
    const ctx = createMockContext({ errors: getTriReleasesTool.errors });
    const input = getTriReleasesTool.input.parse({ facility_id: 'WA0001234', year: 2019 });
    const result = await getTriReleasesTool.handler(input, ctx);
    expect(result.message).toMatch(
      /^No TRI releases found for facility "WA0001234" for year 2019\. /,
    );
  });

  it('includes chemical name in no-results message when filter provided', async () => {
    mockGetTriReleases.mockResolvedValue([]);
    const ctx = createMockContext({ errors: getTriReleasesTool.errors });
    const input = getTriReleasesTool.input.parse({
      facility_id: 'WA0001234',
      chemical_name: 'LEAD',
    });
    const result = await getTriReleasesTool.handler(input, ctx);
    expect(result.message).toMatch(
      /^No TRI releases found for facility "WA0001234" matching chemical "LEAD"\. /,
    );
  });

  it('trims whitespace from facility_id and chemical_name', async () => {
    mockGetTriReleases.mockResolvedValue([benzeneRelease]);
    const ctx = createMockContext({ errors: getTriReleasesTool.errors });
    const input = getTriReleasesTool.input.parse({
      facility_id: '  WA0001234  ',
      chemical_name: '  benzene  ',
    });
    await getTriReleasesTool.handler(input, ctx);
    expect(mockGetTriReleases).toHaveBeenCalledWith(
      { facilityId: 'WA0001234', chemicalName: 'benzene' },
      expect.anything(),
    );
  });

  it('formats output with chemical name, year, and release amounts', () => {
    const output = { releases: [benzeneRelease], facilityId: 'WA0001234' };
    const blocks = getTriReleasesTool.format!(output);
    expect(blocks).toEqual([
      {
        type: 'text',
        text: [
          '## TRI Chemical Releases — Facility WA0001234',
          '**Records:** 1',
          '',
          '### BENZENE (2022)',
          '**Facility ID:** WA0001234',
          '**One-Time / Non-Routine Release:** 1,240 lbs',
        ].join('\n'),
      },
    ]);
  });

  it('formats empty result with message', () => {
    const output = {
      releases: [],
      facilityId: 'WA0001234',
      message: 'No TRI releases found.',
    };
    const blocks = getTriReleasesTool.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toBe(
      [
        '## TRI Chemical Releases — Facility WA0001234',
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
          totalReleasesInLbs: 0.00062,
          // AIR STACK 0.000894 + AIR FUG 0.000014, as the breakdown rollup sums them.
          releasesToAirInLbs: 0.000894 + 0.000014,
          releasesToWaterInLbs: 0.0000001,
          releasesToLandInLbs: 0.0005809,
          releasesToUndergroundInjectionInLbs: 2134695,
        },
      ],
      facilityId: '36701GLBMTOLDMO',
    };
    const text = (getTriReleasesTool.format!(output)[0] as { type: string; text: string }).text;
    expect(text).toContain('**One-Time / Non-Routine Release:** 0.00062 lbs');
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
    const blocks = getTriReleasesTool.format!(sparse);
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
    const recovery = getTriReleasesTool.errors!.find(
      (e) => e.reason === 'no_releases_found',
    )!.recovery;

    it('description sources facility_id from epa_search_tri_releases, never epa_search_facilities', () => {
      expect(getTriReleasesTool.description).toContain('epa_search_tri_releases');
      expect(getTriReleasesTool.description).toContain('15-character TRI facility ID');
      expect(getTriReleasesTool.description).not.toContain('epa_search_facilities');
    });

    it('facility_id .describe() names the 15-character TRI ID from epa_search_tri_releases', () => {
      const text = getTriReleasesTool.input.shape.facility_id.description ?? '';
      expect(text).toContain('15-character TRI facility ID');
      expect(text).toContain('facilityId');
      expect(text).toContain('epa_search_tri_releases');
      expect(text).not.toContain('epa_search_facilities');
      expect(text).not.toContain('RegistryID');
    });

    it('no_releases_found recovery points at epa_search_tri_releases', () => {
      expect(recovery).toContain('epa_search_tri_releases');
      expect(recovery).not.toContain('epa_search_facilities');
    });

    it('empty-result message points at epa_search_tri_releases', async () => {
      mockGetTriReleases.mockResolvedValue([]);
      const ctx = createMockContext({ errors: getTriReleasesTool.errors });
      const input = getTriReleasesTool.input.parse({ facility_id: '110070322017', year: 2022 });
      const result = await getTriReleasesTool.handler(input, ctx);
      expect(result.message).toContain('epa_search_tri_releases');
      expect(result.message).not.toContain('epa_search_facilities');
      const text = (getTriReleasesTool.format!(result)[0] as { text: string }).text;
      expect(text).toContain('epa_search_tri_releases');
      expect(text).not.toContain('epa_search_facilities');
    });
  });

  it('carries every per-medium field through the output schema to structuredContent', async () => {
    mockGetTriReleases.mockResolvedValue([fullBreakdownRelease]);
    const call = await runToolContract(getTriReleasesTool, { facility_id: 'WA0005678' });
    expect(call.isError).toBeFalsy();
    expect(call.structuredContent).toEqual({
      releases: [fullBreakdownRelease],
      facilityId: 'WA0005678',
    });
  });

  it('formats all four media plus the distinct one-time release line', () => {
    const output = { releases: [fullBreakdownRelease], facilityId: 'WA0005678' };
    const text = (getTriReleasesTool.format!(output)[0] as { type: string; text: string }).text;
    // one_time_release_qty is a separate TRI category, rendered after the routine media.
    expect(text.split('\n').slice(3)).toEqual([
      '### TOLUENE (2021)',
      '**Facility ID:** WA0005678',
      '**Air Releases:** 15,000 lbs',
      '**Water Releases:** 200 lbs',
      '**Land Releases:** 3,400 lbs',
      '**Underground Injection:** 90,000 lbs',
      '**One-Time / Non-Routine Release:** 0 lbs',
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
      mockGetTriReleases.mockResolvedValue([dioxin, benzeneRelease]);
      const call = await runToolContract(getTriReleasesTool, {
        facility_id: '96020CLLNS500MA',
        year: 2022,
      });
      expect(call.isError).toBeFalsy();
      const structured = call.structuredContent as { releases: Array<Record<string, unknown>> };
      expect(structured.releases).toEqual([dioxin, benzeneRelease]);
      const text = call.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
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
        getTriReleasesTool.format!({
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
      const item = getTriReleasesTool.output.shape.releases.element.shape;
      expect(item.reportedUnit.description).toMatch(/dioxin/i);
      expect(item.reportedUnit.description).toMatch(/converted to pounds/i);
      expect(getTriReleasesTool.description).toMatch(/grams/);
    });
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
    const text = (getTriReleasesTool.format!(airOnly)[0] as { type: string; text: string }).text;
    expect(text).toContain('**Air Releases:** 500 lbs');
    expect(text).not.toContain('Water Releases');
    expect(text).not.toContain('Land Releases');
    expect(text).not.toContain('Underground Injection');
    expect(text).not.toContain('One-Time / Non-Routine Release');
  });
});
