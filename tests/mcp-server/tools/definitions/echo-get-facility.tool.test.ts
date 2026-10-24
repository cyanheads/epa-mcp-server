/**
 * @fileoverview Tests for echoGetFacilityTool.
 * @module tests/mcp-server/tools/definitions/echo-get-facility.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { echoGetFacilityTool } from '@/mcp-server/tools/definitions/echo-get-facility.tool.js';

const mockGetFacility = vi.fn();

vi.mock('@/services/echo/echo-service.js', () => ({
  getEchoService: () => ({
    getFacility: mockGetFacility,
    searchFacilities: vi.fn(),
    searchViolations: vi.fn(),
  }),
}));

/**
 * The profile EchoService.getFacility builds from the get_dfr body for registry 110015969941
 * (tests/services/echo/echo-fixtures.ts), with complianceStatus and compliance as a p_frs
 * facility row supplies them. ECHO populates no mediaStatus field and no waterCompliance.programId.
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
    expect(mockGetFacility).toHaveBeenCalledWith('110000350509', ctx);
    expect(result).toEqual(fullProfile);
  });

  it('trims whitespace from registry_id before calling service', async () => {
    mockGetFacility.mockResolvedValue(fullProfile);
    const ctx = createMockContext({ errors: echoGetFacilityTool.errors });
    const input = echoGetFacilityTool.input.parse({ registry_id: '  110000350509  ' });
    await echoGetFacilityTool.handler(input, ctx);
    expect(mockGetFacility).toHaveBeenCalledWith('110000350509', expect.anything());
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
      '**TRI Facility IDs:** 98106SLMNB2424S, 98106HCKTT2424S, 98106STTLS2414S (most recent first; for epa_tri_get_facility_releases)',
      '**TRI Releases+Transfers (2024):** 5,830,668 lbs',
      '',
      '### Compliance Summary',
      '**Quarters in Violation (3yr):** 12',
      '',
      '### Program Compliance',
      '- **CAA:** No Violation Identified | Quarters in noncompliance: 0 of 12 | in significant noncompliance: 0 | Inspections: 5 | last 03/10/2026 | Informal actions: 3 | Formal actions: 1 | Penalties: $2,000 | 3-year window from 10/01/2023 | 5-year window from 10/10/2021 | through 09/30/2026',
      '- **CWA:** Violation Identified | Quarters in noncompliance: 12 of 12 | in significant noncompliance: 0 | Inspections: 2 | last 07/14/2026 | 3-year window from 07/01/2023 | 5-year window from 10/10/2021 | through 06/30/2026',
      '- **RCRA:** No Violation Identified | Quarters in noncompliance: 0 of 12 | in significant noncompliance: 0 | Inspections: 1 | last 12/07/2022 | Informal actions: 1 | 3-year window from 10/01/2023 | 5-year window from 10/10/2021 | through 09/30/2026',
      '',
      '### Inspections (3)',
      '- 07/14/2026 — CWA WA0031305 — Inspection/Evaluation: Base Program - Evaluation (IU) — State lead',
      '- 07/08/2026 — CAA WAPSC0005303300006 — Inspection/Evaluation: PCE Off-Site — Local lead',
      '- 05/04/2023 — RCRA WAD988487583 — Facility Self Disclosure — State lead — No Violations Or Compliance Issues Were Found',
      '',
      '### Formal Enforcement Actions',
      '- 06/16/2022 — CAA WAPSC0005303300006 — Administrative Order | Penalty: $2,000 | Case WAPSCAF000000000000000409 | Settled 06/16/2022 | Local lead',
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

  describe('coordinate and FIPS rendering', () => {
    type Extra = { latitude?: number; longitude?: number; county?: string; fipsCode?: string };
    const render = (extra: Extra) =>
      (
        echoGetFacilityTool.format!({
          registryId: 'COORD001',
          name: 'COORD FACILITY',
          programs: { air: false, water: false, rcra: false, tri: false, sdwa: false },
          triFacilityIds: [],
          programCompliance: [],
          inspections: [],
          inspectionsTotal: 0,
          formalActions: [],
          ...extra,
        })[0] as { text: string }
      ).text;

    it.each([
      [
        'both',
        { latitude: 47.60634, longitude: -122.33207 },
        '**Coordinates:** 47.60634, -122.33207',
      ],
      ['both zero', { latitude: 0, longitude: 0 }, '**Coordinates:** 0, 0'],
      ['latitude only', { latitude: 47.60634 }, '**Latitude:** 47.60634'],
      ['longitude only', { longitude: -122.33207 }, '**Longitude:** -122.33207'],
      ['zero latitude only', { latitude: 0 }, '**Latitude:** 0'],
      ['zero longitude only', { longitude: 0 }, '**Longitude:** 0'],
    ] as const)('renders %s', (_label, coords, line) => {
      const text = render(coords);
      const coordLines = text.split('\n').filter((l) => /Coordinates|Latitude|Longitude/.test(l));
      expect(coordLines).toEqual([line]);
    });

    it('renders no coordinate line when neither is present', () => {
      expect(render({})).not.toMatch(/Coordinates|Latitude|Longitude/);
    });

    it('renders county with its FIPS code on one line', () => {
      expect(render({ county: 'KING', fipsCode: '53033' })).toContain(
        '**County:** KING (FIPS: 53033)',
      );
    });

    it('renders a FIPS code that arrives without a county name', () => {
      const text = render({ fipsCode: '53033' });
      expect(text).toContain('**County FIPS:** 53033');
      expect(text).not.toContain('**County:**');
    });
  });

  it('formats sparse profile (minimal required fields only)', () => {
    const sparse = {
      registryId: 'ABC123',
      name: 'SPARSE FACILITY',
      programs: { air: false, water: false, rcra: false, tri: false, sdwa: false },
      triFacilityIds: [],
      programCompliance: [],
      inspections: [],
      inspectionsTotal: 0,
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
    expect(lines).toContain('- **RCRA:** Significant Noncomplier | Formal actions: 2');
    expect(lines).toContain(
      '- 02/12/2025 — RCRA WAD027470111 — Compliance Evaluation Inspection — State lead — Violations Or Compliance Issues Were Found',
    );
    expect(lines).toContain(
      '- 02/12/2026 — RCRA WAD027470111 — FINAL PENALTY | Settled 02/12/2026 | State lead',
    );
    expect(text).not.toContain('Case ');
  });

  it('names the shown and total counts when the inspection list is capped', () => {
    const text = (
      echoGetFacilityTool.format!({
        registryId: '110041990913',
        name: 'REFINERY',
        programs: { air: true, water: false, rcra: false, tri: false, sdwa: false },
        triFacilityIds: [],
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
        formalActions: [],
      })[0] as { text: string }
    ).text;
    expect(text.split('\n')).toEqual(
      expect.arrayContaining([
        '### Inspections (newest 1 of 581)',
        '- 09/17/2026 — CAA — Compliance Investigation: Investigation',
      ]),
    );
  });
});
