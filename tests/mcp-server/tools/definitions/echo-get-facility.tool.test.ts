/**
 * @fileoverview Tests for echoGetFacilityTool.
 * @module tests/mcp-server/tools/definitions/echo-get-facility.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import MarkdownIt from 'markdown-it';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { echoGetFacilityTool } from '@/mcp-server/tools/definitions/echo-get-facility.tool.js';
import type { FacilitySlices } from '@/services/echo/echo-service.js';
import { describeLocationRendering, textOf } from '../../../helpers.js';
import { DFR_SDWIS_WA5300484 } from '../../../services/echo/echo-fixtures.js';

const mockGetFacility = vi.fn();

vi.mock('@/services/echo/echo-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/echo/echo-service.js')>()),
  getEchoService: () => ({
    getFacility: mockGetFacility,
    searchFacilities: vi.fn(),
    searchViolations: vi.fn(),
  }),
}));

/** The slice argument a default call passes to getFacility. */
const DEFAULT_SLICE = {
  drinkingWaterViolations: { limit: 50, offset: 0 },
  inspections: { limit: 100, offset: 0 },
};

/**
 * The profile EchoService.getFacility builds from the get_dfr body for registry 110015969941
 * (tests/services/echo/echo-fixtures.ts), with complianceStatus and compliance as a p_frs
 * facility row supplies them.
 */
const fullProfile = {
  registryId: '110015969941',
  name: 'NUCOR STEEL SEATTLE INC',
  street: '2424 SW ANDOVER ST',
  city: 'SEATTLE',
  state: 'WA',
  zip: '98106',
  county: 'King County',
  fipsCode: '53033',
  latitude: 47.569331,
  longitude: -122.367332,
  complianceStatus: 'Violation Identified',
  programs: { air: true, water: true, rcra: true, tri: true, sdwa: false },
  triFacilityIds: ['98106SLMNB2424S', '98106HCKTT2424S', '98106STTLS2414S'],
  naics: [
    { code: '2123', description: 'Nonmetallic Mineral Mining and Quarrying' },
    { code: '23721', description: 'Land Subdivision' },
    { code: '331110', description: 'Iron and Steel Mills and Ferroalloy Manufacturing' },
    { code: '331111', description: 'Iron and Steel Mills' },
    { code: '331221', description: 'Rolled Steel Shape Manufacturing' },
    { code: '332618', description: 'Other Fabricated Wire Product Manufacturing' },
  ],
  triReleasesTransfersInLbs: 5830668,
  triReleasesTransfersYear: 2024,
  compliance: { quartersInViolation: 12 },
  programCompliance: [
    {
      statute: 'CAA',
      currentStatus: 'No Violation Identified',
      quartersInNoncompliance: 0,
      quartersInSignificantNoncompliance: 0,
      inspections: 5,
      lastInspectionDate: '03/10/2026',
      informalActions: 3,
      formalActions: 1,
      totalPenaltiesInDollars: 2000,
      threeYearPeriodStart: '10/01/2023',
      fiveYearPeriodStart: '10/10/2021',
      periodEnd: '09/30/2026',
    },
    {
      statute: 'CWA',
      currentStatus: 'Violation Identified',
      quartersInNoncompliance: 12,
      quartersInSignificantNoncompliance: 0,
      inspections: 2,
      lastInspectionDate: '07/14/2026',
      threeYearPeriodStart: '07/01/2023',
      fiveYearPeriodStart: '10/10/2021',
      periodEnd: '06/30/2026',
    },
    {
      statute: 'RCRA',
      currentStatus: 'No Violation Identified',
      quartersInNoncompliance: 0,
      quartersInSignificantNoncompliance: 0,
      inspections: 1,
      lastInspectionDate: '12/07/2022',
      informalActions: 1,
      threeYearPeriodStart: '10/01/2023',
      fiveYearPeriodStart: '10/10/2021',
      periodEnd: '09/30/2026',
    },
  ],
  inspections: [
    {
      category: 'Inspection/Evaluation',
      activityType: 'Base Program - Evaluation (IU)',
      activityDate: '07/14/2026',
      statute: 'CWA',
      sourceId: 'WA0031305',
      leadAgency: 'State',
    },
    {
      category: 'Inspection/Evaluation',
      activityType: 'PCE Off-Site',
      activityDate: '07/08/2026',
      statute: 'CAA',
      sourceId: 'WAPSC0005303300006',
      leadAgency: 'Local',
    },
    {
      activityType: 'Facility Self Disclosure',
      activityDate: '05/04/2023',
      description: 'No Violations Or Compliance Issues Were Found',
      statute: 'RCRA',
      sourceId: 'WAD988487583',
      leadAgency: 'State',
    },
  ],
  inspectionsTotal: 3,
  drinkingWaterViolations: [],
  drinkingWaterViolationsTotal: 0,
  formalActions: [
    {
      caseId: 'WAPSCAF000000000000000409',
      settlementDate: '06/16/2022',
      penaltyAssessedInDollars: 2000,
      actionType: 'Administrative Order',
      actionDate: '06/16/2022',
      statute: 'CAA',
      sourceId: 'WAPSC0005303300006',
      leadAgency: 'Local',
    },
  ],
  airCompliance: {
    programId: 'WAPSC0005303300006',
    status: 'No Violation Identified',
    statusDate: '09/30/2026',
  },
  waterCompliance: { status: 'Violation Identified', permitId: 'WA0031305' },
};

describe('echoGetFacilityTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns facility profile for valid registry ID', async () => {
    mockGetFacility.mockResolvedValue(fullProfile);
    const ctx = createMockContext({ errors: echoGetFacilityTool.errors });
    const input = echoGetFacilityTool.input.parse({ registry_id: '110000350509' });
    const result = await echoGetFacilityTool.handler(input, ctx);
    expect(mockGetFacility).toHaveBeenCalledWith('110000350509', ctx, DEFAULT_SLICE);
    expect(result).toEqual(fullProfile);
  });

  it('trims whitespace from registry_id before calling service', async () => {
    mockGetFacility.mockResolvedValue(fullProfile);
    const ctx = createMockContext({ errors: echoGetFacilityTool.errors });
    const input = echoGetFacilityTool.input.parse({ registry_id: '  110000350509  ' });
    await echoGetFacilityTool.handler(input, ctx);
    expect(mockGetFacility).toHaveBeenCalledWith(
      '110000350509',
      expect.anything(),
      expect.anything(),
    );
  });

  it('carries the status-lookup notice on both surfaces', async () => {
    const notice =
      "ECHO's facility search request failed, so this profile has no complianceStatus or compliance.quartersInViolation. Every other field comes from ECHO's detailed facility report; calling again may fill them.";
    const { complianceStatus: _status, compliance: _compliance, ...withoutStatus } = fullProfile;
    mockGetFacility.mockImplementation((_id: string, ctx: Context) => {
      ctx.enrich.notice(notice);
      return Promise.resolve(withoutStatus);
    });

    const result = await runToolContract(echoGetFacilityTool, { registry_id: '110015969941' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ ...withoutStatus, notice });
    expect(JSON.stringify(result.content)).toContain(notice);
  });

  it('carries every profile field to structuredContent', async () => {
    mockGetFacility.mockResolvedValue(fullProfile);
    const result = await runToolContract(echoGetFacilityTool, { registry_id: '110015969941' });
    expect(result.structuredContent).toEqual(fullProfile);
  });

  it('formats full profile including all sections', () => {
    const blocks = echoGetFacilityTool.format!(fullProfile);
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { type: string; text: string }).text.split('\n')).toEqual([
      '## NUCOR STEEL SEATTLE INC',
      '**Registry ID:** 110015969941',
      '**Location:** 2424 SW ANDOVER ST, SEATTLE, WA, 98106',
      '**County:** King County (FIPS: 53033)',
      '**Coordinates:** 47.569331, -122.367332',
      '**Compliance Status:** Violation Identified',
      '**Programs:** AIR, WATER, RCRA, TRI',
      '**NAICS:** 2123 Nonmetallic Mineral Mining and Quarrying; 23721 Land Subdivision; 331110 Iron and Steel Mills and Ferroalloy Manufacturing; 331111 Iron and Steel Mills; 331221 Rolled Steel Shape Manufacturing; 332618 Other Fabricated Wire Product Manufacturing',
      '**TRI Facility IDs:** 98106SLMNB2424S, 98106HCKTT2424S, 98106STTLS2414S (most recent first; for epa_tri_get_facility_releases)',
      '**TRI Releases+Transfers (2024):** 5,830,668 lbs',
      '',
      '### Compliance Summary',
      '**Quarters in Violation (3yr):** 12',
      '',
      '### Program Compliance',
      '- **CAA:** No Violation Identified \\| Quarters in noncompliance: 0 of 12 \\| in significant noncompliance: 0 \\| Inspections: 5 \\| last 03/10/2026 \\| Informal actions: 3 \\| Formal actions: 1 \\| Penalties: $2,000 \\| 3-year window from 10/01/2023 \\| 5-year window from 10/10/2021 \\| through 09/30/2026',
      '- **CWA:** Violation Identified \\| Quarters in noncompliance: 12 of 12 \\| in significant noncompliance: 0 \\| Inspections: 2 \\| last 07/14/2026 \\| 3-year window from 07/01/2023 \\| 5-year window from 10/10/2021 \\| through 06/30/2026',
      '- **RCRA:** No Violation Identified \\| Quarters in noncompliance: 0 of 12 \\| in significant noncompliance: 0 \\| Inspections: 1 \\| last 12/07/2022 \\| Informal actions: 1 \\| 3-year window from 10/01/2023 \\| 5-year window from 10/10/2021 \\| through 09/30/2026',
      '',
      '### Inspections (3)',
      '- 07/14/2026 — CWA WA0031305 — Inspection/Evaluation: Base Program - Evaluation (IU) — State lead',
      '- 07/08/2026 — CAA WAPSC0005303300006 — Inspection/Evaluation: PCE Off-Site — Local lead',
      '- 05/04/2023 — RCRA WAD988487583 — Facility Self Disclosure — State lead — No Violations Or Compliance Issues Were Found',
      '',
      '### Formal Enforcement Actions',
      '- 06/16/2022 — CAA WAPSC0005303300006 — Administrative Order \\| Penalty: $2,000 \\| Case WAPSCAF000000000000000409 \\| Settled 06/16/2022 \\| Local lead',
      '',
      '### Air (CAA) Compliance',
      '**Program ID:** WAPSC0005303300006',
      '**Status:** No Violation Identified',
      '**Status Date:** 09/30/2026',
      '',
      '### Water (CWA) Compliance',
      '**Status:** Violation Identified',
      '**NPDES Permit:** WA0031305',
    ]);
  });

  describe('regression #62: drinking-water violations', () => {
    /** Routes getFacility to the real service over a fetch stub serving the WA5300484 report. */
    async function serveWa5300484() {
      const { EchoService } = await vi.importActual<
        typeof import('@/services/echo/echo-service.js')
      >('@/services/echo/echo-service.js');
      const echo = new EchoService(
        { pkg: { name: '@cyanheads/epa-mcp-server', version: '0.0.0-test' } } as AppConfig,
        {} as StorageService,
      );
      mockGetFacility.mockImplementation((id: string, ctx: Context, slices: FacilitySlices) =>
        echo.getFacility(id, ctx, slices),
      );
      vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              String(input).includes('get_dfr')
                ? DFR_SDWIS_WA5300484
                : { Results: { Facilities: [] } },
            ),
          ),
        ),
      );
    }
    const structured = (result: { structuredContent?: unknown }) =>
      result.structuredContent as {
        drinkingWaterViolations: Array<Record<string, unknown>>;
        drinkingWaterViolationsTotal: number;
        drinkingWaterViolationsNextOffset?: number;
        truncated?: boolean;
        limitNotice?: string;
      };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("pages a PWSID's violations and renders every entry and action in content[]", async () => {
      await serveWa5300484();

      const result = await runToolContract(echoGetFacilityTool, {
        registry_id: 'WA5300484',
        drinking_water_violations_limit: 5,
      });

      expect(result.isError).toBeFalsy();
      const sc = structured(result);
      expect(sc).toMatchObject({
        registryId: '110012873658',
        drinkingWaterViolationsTotal: 17,
        drinkingWaterViolationsNextOffset: 5,
        truncated: true,
      });
      expect(sc.drinkingWaterViolations).toHaveLength(5);
      const lines = textOf(result.content).split('\n');
      expect(lines).toEqual(
        expect.arrayContaining([
          '### Drinking-Water Violations (1–5 of 17)',
          '**Next offset:** 5 (pass as drinking_water_violations_offset)',
          '- 01/01/2026–03/31/2026 — WA5300484 — Violation 3410601 — Stage 2 Disinfectants and Disinfection Byproducts Rule — TTHM — MCL: Maximum Contaminant Level Violation — Measure 148.37 UG/L — Federal MCL 0.080 mg/L — Archived — resolved 03/31/2026',
          '  - Enforcement: 02/23/2023 — Formal — State Administrative/Compliance Order without penalty issued — State',
          '- 10/01/2025–12/31/2025 — WA5300484 — Violation 25829961005 — Arsenic Rule — Arsenic — MR: Monitoring and Reporting — Resolved — resolved 10/08/2025',
          '  - Enforcement: 10/08/2025 — Resolving — State Compliance achieved — State',
          '**Truncated:** true',
        ]),
      );
      // Every value on structuredContent, nested actions included, reaches content[].
      const text = textOf(result.content);
      const values = sc.drinkingWaterViolations.flatMap((v) =>
        Object.values(v).flatMap((value) =>
          Array.isArray(value) ? value.flatMap((action) => Object.values(action)) : [value],
        ),
      );
      for (const value of values) expect(text).toContain(String(value));
    });

    it('the last page carries no next offset and no truncated flag', async () => {
      await serveWa5300484();

      const result = await runToolContract(echoGetFacilityTool, {
        registry_id: 'WA5300484',
        drinking_water_violations_limit: 5,
        drinking_water_violations_offset: 15,
      });

      const sc = structured(result);
      expect(sc.drinkingWaterViolations.map((v) => v.violationId)).toEqual(['2849133', '2849132']);
      expect(sc).not.toHaveProperty('drinkingWaterViolationsNextOffset');
      expect(sc).not.toHaveProperty('truncated');
      expect(textOf(result.content)).toContain('### Drinking-Water Violations (16–17 of 17)');
      expect(textOf(result.content)).not.toContain('Next offset');
    });

    it('an offset past the end returns an empty page that still states the total', async () => {
      await serveWa5300484();

      const result = await runToolContract(echoGetFacilityTool, {
        registry_id: 'WA5300484',
        drinking_water_violations_offset: 40,
      });

      const sc = structured(result);
      expect(sc.drinkingWaterViolations).toEqual([]);
      expect(sc.drinkingWaterViolationsTotal).toBe(17);
      expect(sc).not.toHaveProperty('drinkingWaterViolationsNextOffset');
      expect(textOf(result.content)).toContain(
        '### Drinking-Water Violations (none on this page of 17)',
      );
    });

    it('clamps a limit above the cap to it and says so on both surfaces', async () => {
      mockGetFacility.mockResolvedValue(fullProfile);

      const result = await runToolContract(echoGetFacilityTool, {
        registry_id: '110015969941',
        drinking_water_violations_limit: 900,
      });

      const notice =
        "drinking_water_violations_limit 900 is above this tool's cap of 200, so at most 200 records were returned.";
      expect(mockGetFacility).toHaveBeenCalledWith('110015969941', expect.anything(), {
        ...DEFAULT_SLICE,
        drinkingWaterViolations: { limit: 200, offset: 0 },
      });
      expect(structured(result).limitNotice).toBe(notice);
      expect(textOf(result.content)).toContain(notice);
    });

    it.each([
      [
        'a limit of 0',
        { drinking_water_violations_limit: 0 },
        'too_small',
        'drinking_water_violations_limit',
      ],
      [
        'a limit above the 5,000 ceiling',
        { drinking_water_violations_limit: 5001 },
        'too_big',
        'drinking_water_violations_limit',
      ],
      [
        'a negative offset',
        { drinking_water_violations_offset: -1 },
        'too_small',
        'drinking_water_violations_offset',
      ],
    ])('rejects %s at its bound before any request', async (_label, args, code, field) => {
      const result = await runToolContract(echoGetFacilityTool, {
        registry_id: 'WA5300484',
        ...args,
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { data: { issues: [expect.objectContaining({ code, path: [field] })] } },
      });
      expect(mockGetFacility).not.toHaveBeenCalled();
    });

    it('renders a water system with no violations as a zero count, and an open period from its start', () => {
      const water = {
        registryId: '110049537202',
        name: 'TRAILS WEST SUBDIVISION',
        programs: { air: false, water: false, rcra: false, tri: false, sdwa: true },
        triFacilityIds: [],
        naics: [],
        programCompliance: [],
        inspections: [],
        inspectionsTotal: 0,
        formalActions: [],
      };
      const none = (
        echoGetFacilityTool.format!({
          ...water,
          drinkingWaterViolations: [],
          drinkingWaterViolationsTotal: 0,
        })[0] as { text: string }
      ).text;
      const open = (
        echoGetFacilityTool.format!({
          ...water,
          drinkingWaterViolations: [
            {
              sourceId: 'WA5389080',
              violationId: '2679696',
              compliancePeriodBeginDate: '01/01/2026',
              federalRule: 'Lead and Copper Rule',
              contaminantName: 'Lead and Copper Rule',
              violationCategoryCode: 'MR',
              violationCategory: 'Monitoring and Reporting',
              status: 'Unaddressed',
            },
          ],
          drinkingWaterViolationsTotal: 1,
        })[0] as { text: string }
      ).text;

      expect(none.split('\n')).toContain('### Drinking-Water Violations (0)');
      expect(open.split('\n')).toEqual(
        expect.arrayContaining([
          '### Drinking-Water Violations (1)',
          '- from 01/01/2026 — WA5389080 — Violation 2679696 — Lead and Copper Rule — Lead and Copper Rule — MR: Monitoring and Reporting — Unaddressed',
        ]),
      );
    });

    it('renders a state MCL beside the federal one', () => {
      const text = (
        echoGetFacilityTool.format!({
          registryId: '110012873658',
          name: 'TOWNSHIP 29 WATER ASSOCIATION FACILITY',
          programs: { air: false, water: false, rcra: false, tri: false, sdwa: true },
          triFacilityIds: [],
          naics: [],
          programCompliance: [],
          inspections: [],
          inspectionsTotal: 0,
          formalActions: [],
          drinkingWaterViolations: [
            {
              violationId: '3410601',
              contaminantName: 'TTHM',
              stateMcl: '0.060 mg/L',
              federalMcl: '0.080 mg/L',
            },
          ],
          drinkingWaterViolationsTotal: 1,
        })[0] as { text: string }
      ).text;

      expect(text.split('\n')).toContain(
        '- Violation 3410601 — TTHM — State MCL 0.060 mg/L — Federal MCL 0.080 mg/L',
      );
    });

    it('renders upstream violation and action text literally, without links, HTML, or headings', () => {
      const value = 'A *plant* [name](https://example.com) <b>raw</b>\n# second line';
      const source = (
        echoGetFacilityTool.format!({
          registryId: '1',
          name: 'X',
          programs: { air: false, water: false, rcra: false, tri: false, sdwa: true },
          triFacilityIds: [],
          naics: [],
          programCompliance: [],
          inspections: [],
          inspectionsTotal: 0,
          formalActions: [],
          drinkingWaterViolations: [
            {
              contaminantName: value,
              status: value,
              enforcementActions: [{ description: value, agency: value }],
            },
          ],
          drinkingWaterViolationsTotal: 1,
        })[0] as { text: string }
      ).text;
      const tokens = new MarkdownIt().parse(source, {});
      const inline = tokens.flatMap((token) => token.children ?? []);

      expect(inline.some((t) => t.type === 'link_open' || t.type === 'html_inline')).toBe(false);
      expect(tokens.filter((t) => t.type === 'heading_open')).toHaveLength(2);
      const text = inline
        .filter((t) => t.type === 'text')
        .map((t) => t.content)
        .join('\n');
      expect(text.split(value)).toHaveLength(5);
    });

    it('flags truncated when the inspection list is cut, with every violation shown', async () => {
      mockGetFacility.mockResolvedValue({
        ...fullProfile,
        inspectionsTotal: 120,
        inspectionsNextOffset: 3,
      });

      const result = await runToolContract(echoGetFacilityTool, { registry_id: '110015969941' });

      expect(structured(result).truncated).toBe(true);
    });

    it('names the PWSID chain in the tool and registry_id descriptions', () => {
      expect(echoGetFacilityTool.description).toContain('PWSID from epa_water_search_systems');
      expect(echoGetFacilityTool.input.shape.registry_id.description).toContain(
        'public water system PWSID (from epa_water_search_systems',
      );
    });
  });

  it('regression #68: declares no field ECHO never populates', () => {
    const { compliance, waterCompliance, airCompliance } = echoGetFacilityTool.output.shape;
    expect(Object.keys(compliance.unwrap().shape)).toEqual(['quartersInViolation']);
    expect(Object.keys(waterCompliance.unwrap().shape)).toEqual(['status', 'permitId']);
    expect(Object.keys(airCompliance.unwrap().shape)).toEqual([
      'programId',
      'status',
      'statusDate',
    ]);
  });

  it('renders zero quarters in violation as a reading, not an absence', () => {
    const text = (
      echoGetFacilityTool.format!({
        ...fullProfile,
        compliance: { quartersInViolation: 0 },
      })[0] as {
        text: string;
      }
    ).text;
    expect(text.split('\n')).toContain('**Quarters in Violation (3yr):** 0');
  });

  it('renders a sub-0.001 TRI releases+transfers total at full precision', () => {
    const text = (
      echoGetFacilityTool.format!({ ...fullProfile, triReleasesTransfersInLbs: 0.00062 })[0] as {
        text: string;
      }
    ).text;
    expect(text).toContain('**TRI Releases+Transfers (2024):** 0.00062 lbs');
  });

  describeLocationRendering(
    (fields) =>
      (
        echoGetFacilityTool.format!({
          registryId: 'COORD001',
          name: 'COORD FACILITY',
          programs: { air: false, water: false, rcra: false, tri: false, sdwa: false },
          triFacilityIds: [],
          naics: [],
          programCompliance: [],
          inspections: [],
          inspectionsTotal: 0,
          drinkingWaterViolations: [],
          drinkingWaterViolationsTotal: 0,
          formalActions: [],
          ...fields,
        })[0] as { text: string }
      ).text,
  );

  it('formats sparse profile (minimal required fields only)', () => {
    const sparse = {
      registryId: 'ABC123',
      name: 'SPARSE FACILITY',
      programs: { air: false, water: false, rcra: false, tri: false, sdwa: false },
      triFacilityIds: [],
      naics: [],
      programCompliance: [],
      inspections: [],
      inspectionsTotal: 0,
      drinkingWaterViolations: [],
      drinkingWaterViolationsTotal: 0,
      formalActions: [],
    };
    const blocks = echoGetFacilityTool.format!(sparse);
    const text = (blocks[0] as { type: string; text: string }).text;
    // Header lines only: no empty sections, no Programs line when every flag is false.
    expect(text).toBe('## SPARSE FACILITY\n**Registry ID:** ABC123');
  });

  it('formats a get_dfr-shaped profile: TRI year, sourced inspections, and joined actions', () => {
    const text = (
      echoGetFacilityTool.format!({
        registryId: '110005318012',
        name: 'RCRA FACILITY',
        complianceStatus: 'Significant Violation',
        programs: { air: false, water: false, rcra: true, tri: true, sdwa: false },
        triFacilityIds: ['9867WSNRWD1981S'],
        naics: [],
        triReleasesTransfersInLbs: 75223,
        triReleasesTransfersYear: 2024,
        programCompliance: [
          { statute: 'RCRA', currentStatus: 'Significant Noncomplier', formalActions: 2 },
        ],
        inspections: [
          {
            activityType: 'Compliance Evaluation Inspection',
            activityDate: '02/12/2025',
            description: 'Violations Or Compliance Issues Were Found',
            statute: 'RCRA',
            sourceId: 'WAD027470111',
            leadAgency: 'State',
          },
        ],
        inspectionsTotal: 1,
        drinkingWaterViolations: [],
        drinkingWaterViolationsTotal: 0,
        formalActions: [
          {
            settlementDate: '02/12/2026',
            actionType: 'FINAL PENALTY',
            actionDate: '02/12/2026',
            statute: 'RCRA',
            sourceId: 'WAD027470111',
            leadAgency: 'State',
          },
        ],
      })[0] as { text: string }
    ).text;
    const lines = text.split('\n');

    expect(lines).toContain('**TRI Releases+Transfers (2024):** 75,223 lbs');
    expect(lines).toContain(
      '**TRI Facility IDs:** 9867WSNRWD1981S (most recent first; for epa_tri_get_facility_releases)',
    );
    expect(lines).toContain('- **RCRA:** Significant Noncomplier \\| Formal actions: 2');
    expect(lines).toContain(
      '- 02/12/2025 — RCRA WAD027470111 — Compliance Evaluation Inspection — State lead — Violations Or Compliance Issues Were Found',
    );
    expect(lines).toContain(
      '- 02/12/2026 — RCRA WAD027470111 — FINAL PENALTY \\| Settled 02/12/2026 \\| State lead',
    );
    expect(text).not.toContain('Case ');
  });

  it('names the page range, total, and next offset when the inspection list is cut', () => {
    const text = (
      echoGetFacilityTool.format!({
        registryId: '110041990913',
        name: 'REFINERY',
        programs: { air: true, water: false, rcra: false, tri: false, sdwa: false },
        triFacilityIds: [],
        naics: [],
        programCompliance: [],
        inspections: [
          {
            category: 'Compliance Investigation',
            activityType: 'Investigation',
            activityDate: '09/17/2026',
            statute: 'CAA',
          },
        ],
        inspectionsTotal: 581,
        inspectionsNextOffset: 1,
        drinkingWaterViolations: [],
        drinkingWaterViolationsTotal: 0,
        formalActions: [],
      })[0] as { text: string }
    ).text;
    expect(text.split('\n')).toEqual(
      expect.arrayContaining([
        '### Inspections (1–1 of 581)',
        '**Next offset:** 1 (pass as inspections_offset)',
        '- 09/17/2026 — CAA — Compliance Investigation: Investigation',
      ]),
    );
  });

  describe('regression #53: inspection pages', () => {
    /** 150 records on distinct dates, the newest dated 01/10/2027. */
    const Inspection = Array.from({ length: 150 }, (_, i) => ({
      Statute: 'CAA',
      SourceID: 'TX0000004824500018',
      ActivityType: 'Compliance Investigation',
      InspectionType: 'Investigation',
      LeadAgency: 'State',
      Date: `01/${String((i % 28) + 1).padStart(2, '0')}/${2022 + Math.floor(i / 28)}`,
    }));
    const newestFirst = [...Inspection].reverse().map((record) => record.Date);

    /** Routes getFacility to the real service over a fetch stub serving a 150-record report. */
    async function serveRefinery() {
      const { EchoService } = await vi.importActual<
        typeof import('@/services/echo/echo-service.js')
      >('@/services/echo/echo-service.js');
      const echo = new EchoService(
        { pkg: { name: '@cyanheads/epa-mcp-server', version: '0.0.0-test' } } as AppConfig,
        {} as StorageService,
      );
      mockGetFacility.mockImplementation((id: string, ctx: Context, slices: FacilitySlices) =>
        echo.getFacility(id, ctx, slices),
      );
      const dfr = {
        Results: {
          RegistryID: '110041990913',
          Permits: [
            { EPASystem: 'FRS', FacilityName: 'EXXONMOBIL BEAUMONT REFINERY' },
            { EPASystem: 'ICIS-Air', SourceID: 'TX0000004824500018' },
          ],
          ComplianceHistory: { Inspection },
        },
      };
      vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              String(input).includes('get_dfr') ? dfr : { Results: { Facilities: [] } },
            ),
          ),
        ),
      );
    }
    const structured = (result: { structuredContent?: unknown }) =>
      result.structuredContent as {
        inspections: Array<{ activityDate?: string }>;
        inspectionsTotal: number;
        inspectionsNextOffset?: number;
        truncated?: boolean;
        limitNotice?: string;
      };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns the page at inspections_offset with the offset that continues it, on both surfaces', async () => {
      await serveRefinery();

      const result = await runToolContract(echoGetFacilityTool, {
        registry_id: '110041990913',
        inspections_limit: 40,
        inspections_offset: 80,
      });

      expect(result.isError).toBeFalsy();
      const sc = structured(result);
      expect(sc.inspections.map((record) => record.activityDate)).toEqual(
        newestFirst.slice(80, 120),
      );
      expect(sc).toMatchObject({
        inspectionsTotal: 150,
        inspectionsNextOffset: 120,
        truncated: true,
      });
      const lines = textOf(result.content).split('\n');
      expect(lines).toEqual(
        expect.arrayContaining([
          '### Inspections (81–120 of 150)',
          '**Next offset:** 120 (pass as inspections_offset)',
          '**Truncated:** true',
        ]),
      );
    });

    it('the last page carries no next offset and no truncated flag', async () => {
      await serveRefinery();

      const result = await runToolContract(echoGetFacilityTool, {
        registry_id: '110041990913',
        inspections_offset: 100,
      });

      const sc = structured(result);
      expect(sc.inspections.map((record) => record.activityDate)).toEqual(newestFirst.slice(100));
      expect(sc).not.toHaveProperty('inspectionsNextOffset');
      expect(sc).not.toHaveProperty('truncated');
      expect(textOf(result.content)).toContain('### Inspections (101–150 of 150)');
      expect(textOf(result.content)).not.toContain('pass as inspections_offset');
    });

    it('the default page is the newest 100, flagged as cut', async () => {
      await serveRefinery();

      const result = await runToolContract(echoGetFacilityTool, { registry_id: '110041990913' });

      const sc = structured(result);
      expect(sc.inspections).toHaveLength(100);
      expect(sc).toMatchObject({ inspectionsNextOffset: 100, truncated: true });
      expect(textOf(result.content)).toContain('### Inspections (1–100 of 150)');
    });

    it('an offset past the end returns an empty page that still states the total', async () => {
      await serveRefinery();

      const result = await runToolContract(echoGetFacilityTool, {
        registry_id: '110041990913',
        inspections_offset: 150,
      });

      const sc = structured(result);
      expect(sc.inspections).toEqual([]);
      expect(sc.inspectionsTotal).toBe(150);
      expect(sc).not.toHaveProperty('inspectionsNextOffset');
      expect(textOf(result.content)).toContain('### Inspections (none on this page of 150)');
    });

    it('clamps an inspections_limit above the cap, joining the notice with the violations one', async () => {
      mockGetFacility.mockResolvedValue(fullProfile);

      const result = await runToolContract(echoGetFacilityTool, {
        registry_id: '110015969941',
        inspections_limit: 500,
        drinking_water_violations_limit: 900,
      });

      expect(mockGetFacility).toHaveBeenCalledWith('110015969941', expect.anything(), {
        drinkingWaterViolations: { limit: 200, offset: 0 },
        inspections: { limit: 100, offset: 0 },
      });
      expect(structured(result).limitNotice).toBe(
        "drinking_water_violations_limit 900 is above this tool's cap of 200, so at most 200 records were returned. inspections_limit 500 is above this tool's cap of 100, so at most 100 records were returned.",
      );
    });

    it.each([
      ['a limit of 0', { inspections_limit: 0 }, 'too_small', 'inspections_limit'],
      [
        'a limit above the 5,000 ceiling',
        { inspections_limit: 5001 },
        'too_big',
        'inspections_limit',
      ],
      ['a negative offset', { inspections_offset: -1 }, 'too_small', 'inspections_offset'],
    ])('rejects %s at its bound before any request', async (_label, args, code, field) => {
      const result = await runToolContract(echoGetFacilityTool, {
        registry_id: '110041990913',
        ...args,
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { data: { issues: [expect.objectContaining({ code, path: [field] })] } },
      });
      expect(mockGetFacility).not.toHaveBeenCalled();
    });
  });

  it('regression #61: renders NAICS codes without descriptions as bare codes', () => {
    const text = (
      echoGetFacilityTool.format!({
        registryId: 'NAICS001',
        name: 'NAICS FACILITY',
        programs: { air: false, water: false, rcra: false, tri: false, sdwa: false },
        triFacilityIds: [],
        naics: [{ code: '3364' }, { code: '336411', description: 'Aircraft Manufacturing' }],
        programCompliance: [],
        inspections: [],
        inspectionsTotal: 0,
        drinkingWaterViolations: [],
        drinkingWaterViolationsTotal: 0,
        formalActions: [],
      })[0] as { text: string }
    ).text;
    expect(text.split('\n')).toContain('**NAICS:** 3364; 336411 Aircraft Manufacturing');
  });

  it('regression #61: names the NAICS output in the tool description', () => {
    expect(echoGetFacilityTool.description).toContain('NAICS industry codes');
    expect(echoGetFacilityTool.output.shape.naics.description).toContain('each code once');
  });
});
