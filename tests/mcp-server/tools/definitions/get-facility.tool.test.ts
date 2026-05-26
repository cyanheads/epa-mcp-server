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
    const ctx = createMockContext();
    const input = getFacilityTool.input.parse({ registry_id: '110000350509' });
    const result = await getFacilityTool.handler(input, ctx);
    expect(result.registryId).toBe('110000350509');
    expect(result.name).toBe('BOEING COMMERCIAL AIRPLANES');
    expect(result.programs.air).toBe(true);
    expect(result.inspections).toHaveLength(1);
    expect(result.formalActions).toHaveLength(1);
  });

  it('trims whitespace from registry_id before calling service', async () => {
    mockGetFacility.mockResolvedValue(fullProfile);
    const ctx = createMockContext();
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
      data: { reason: 'facility_not_found' },
    });
  });

  it('formats full profile including all sections', () => {
    const blocks = getFacilityTool.format!(fullProfile);
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('BOEING COMMERCIAL AIRPLANES');
    expect(text).toContain('110000350509');
    expect(text).toContain('EVERETT');
    expect(text).toContain('SNOHOMISH');
    expect(text).toContain('FIPS: 53061');
    expect(text).toContain('47.917');
    expect(text).toContain('No Recent Activity');
    expect(text).toContain('AIR');
    expect(text).toContain('WATER');
    expect(text).toContain('TRI');
    expect(text).toContain('48,210');
    expect(text).toContain('No Viol');
    expect(text).toContain('Evaluation/Investigation');
    expect(text).toContain('CAA-10-2020-0001');
    expect(text).toContain('$15,000');
    expect(text).toContain('CAA-WA-1234');
    expect(text).toContain('WA0001234');
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
    expect(text).toContain('SPARSE FACILITY');
    expect(text).toContain('ABC123');
    // No sections for empty inspections/formalActions
    expect(text).not.toContain('Inspections\n');
    expect(text).not.toContain('Formal Enforcement Actions\n');
  });
});
