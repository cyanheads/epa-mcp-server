/**
 * @fileoverview Tests for getFacilityTool.
 * @module tests/mcp-server/tools/definitions/get-facility.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFacilityTool } from '@/mcp-server/tools/definitions/get-facility.tool.js';

const mockGetFacility = vi.fn();

vi.mock('@/services/echo/echo-service.js', () => ({
  getEchoService: () => ({
    getFacility: mockGetFacility,
    searchFacilities: vi.fn(),
    searchViolations: vi.fn(),
  }),
}));

const fullProfile = {
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
  triReleasesTransfersInLbs: 48210,
  compliance: {
    mediaStatusCode: 'No Viol',
    mediaStatusDescription: 'No violation found',
    quartersInViolation: 0,
  },
  inspections: [
    { activityType: 'EI', activityDate: '2022-04-15', description: 'Evaluation/Investigation' },
  ],
  formalActions: [
    {
      caseId: 'CAA-10-2020-0001',
      settlementDate: '2020-12-01',
      penaltyAssessedInDollars: 15000,
      actionType: 'Penalty Order',
    },
  ],
  airCompliance: { programId: 'CAA-WA-1234', status: 'In Compliance', statusDate: '2023-01-01' },
  waterCompliance: {
    programId: 'CWA-WA-5678',
    status: 'In Compliance',
    permitId: 'WA0001234',
  },
};

describe('getFacilityTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns facility profile for valid registry ID', async () => {
    mockGetFacility.mockResolvedValue(fullProfile);
    const ctx = createMockContext({ errors: getFacilityTool.errors });
    const input = getFacilityTool.input.parse({ registry_id: '110000350509' });
    const result = await getFacilityTool.handler(input, ctx);
    expect(mockGetFacility).toHaveBeenCalledWith('110000350509', ctx);
    expect(result).toEqual(fullProfile);
  });

  it('trims whitespace from registry_id before calling service', async () => {
    mockGetFacility.mockResolvedValue(fullProfile);
    const ctx = createMockContext({ errors: getFacilityTool.errors });
    const input = getFacilityTool.input.parse({ registry_id: '  110000350509  ' });
    await getFacilityTool.handler(input, ctx);
    expect(mockGetFacility).toHaveBeenCalledWith('110000350509', expect.anything());
  });

  it('throws facility_not_found when service returns profile without registryId', async () => {
    mockGetFacility.mockResolvedValue({
      registryId: '',
      name: '',
      programs: { air: false, water: false, rcra: false, tri: false, sdwa: false },
      inspections: [],
      formalActions: [],
    });
    const ctx = createMockContext({ errors: getFacilityTool.errors });
    const input = getFacilityTool.input.parse({ registry_id: 'NOTREAL' });
    await expect(getFacilityTool.handler(input, ctx)).rejects.toMatchObject({
      message: 'No facility found for Registry ID "NOTREAL".',
      data: { reason: 'facility_not_found' },
    });
  });

  it('formats full profile including all sections', () => {
    const blocks = getFacilityTool.format!(fullProfile);
    expect(blocks).toHaveLength(1);
    const lines = (blocks[0] as { type: string; text: string }).text.split('\n');
    for (const line of [
      '## BOEING COMMERCIAL AIRPLANES',
      '**Registry ID:** 110000350509',
      '**Location:** 3003 W CASINO RD, EVERETT, WA, 98204',
      '**County:** SNOHOMISH (FIPS: 53061)',
      '**Coordinates:** 47.917, -122.248',
      '**Compliance Status:** No Recent Activity',
      '**Programs:** AIR, WATER, TRI',
      '**TRI Releases+Transfers:** 48,210 lbs',
      '**Status Code:** No Viol',
      '**Description:** No violation found',
      // Zero quarters in violation is a reading, not an absence.
      '**Quarters in Violation (3yr):** 0',
      '- 2022-04-15 — EI — Evaluation/Investigation',
      '- CAA-10-2020-0001: Penalty Order | Penalty: $15,000 (2020-12-01)',
      '**Program ID:** CAA-WA-1234',
      '**Status Date:** 2023-01-01',
      '**Program ID:** CWA-WA-5678',
      '**NPDES Permit:** WA0001234',
    ]) {
      expect(lines).toContain(line);
    }
    expect(lines.filter((line) => line === '**Status:** In Compliance')).toHaveLength(2);
  });

  it('renders a sub-0.001 TRI releases+transfers total at full precision', () => {
    const text = (
      getFacilityTool.format!({ ...fullProfile, triReleasesTransfersInLbs: 0.00062 })[0] as {
        text: string;
      }
    ).text;
    expect(text).toContain('**TRI Releases+Transfers:** 0.00062 lbs');
  });

  describe('coordinate and FIPS rendering', () => {
    type Extra = { latitude?: number; longitude?: number; county?: string; fipsCode?: string };
    const render = (extra: Extra) =>
      (
        getFacilityTool.format!({
          registryId: 'COORD001',
          name: 'COORD FACILITY',
          programs: { air: false, water: false, rcra: false, tri: false, sdwa: false },
          inspections: [],
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
      inspections: [],
      formalActions: [],
    };
    const blocks = getFacilityTool.format!(sparse);
    const text = (blocks[0] as { type: string; text: string }).text;
    // Header lines only: no empty sections, no Programs line when every flag is false.
    expect(text).toBe('## SPARSE FACILITY\n**Registry ID:** ABC123');
  });
});
