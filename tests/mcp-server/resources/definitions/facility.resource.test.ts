/**
 * @fileoverview Tests for facilityResource.
 * @module tests/mcp-server/resources/definitions/facility.resource.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { facilityResource } from '@/mcp-server/resources/definitions/facility.resource.js';
import {
  DFR_SDWIS_WA5389080,
  INVALID_ID_110000350509,
} from '../../../services/echo/echo-fixtures.js';

const mockGetFacility = vi.fn();

vi.mock('@/services/echo/echo-service.js', () => ({
  getEchoService: () => ({
    getFacilityReport: mockGetFacility,
    searchFacilities: vi.fn(),
    searchViolations: vi.fn(),
  }),
}));

const boeingProfile = {
  registryId: '110000350509',
  name: 'BOEING COMMERCIAL AIRPLANES',
  street: '3003 W CASINO RD',
  city: 'EVERETT',
  state: 'WA',
  zip: '98204',
  programs: { air: true, water: true, rcra: false, tri: true, sdwa: false },
  triFacilityIds: ['98204BNGCM3003W'],
  naics: [],
  programCompliance: [],
  inspections: [],
  inspectionsTotal: 0,
  drinkingWaterViolations: [],
  drinkingWaterViolationsTotal: 0,
  formalActions: [],
};

const mockContext = () =>
  createMockContext({ tenantId: 'test-tenant', errors: facilityResource.errors });

describe('facilityResource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns facility profile for valid registry ID', async () => {
    mockGetFacility.mockResolvedValue({ profile: boeingProfile });
    const ctx = mockContext();
    const params = facilityResource.params!.parse({ registry_id: '110000350509' });
    const result = await facilityResource.handler(params, ctx);
    expect(result).toEqual(boeingProfile);
    expect(mockGetFacility).toHaveBeenCalledWith('110000350509', ctx);
  });

  it('returns the status-lookup notice in the profile when the lookup failed', async () => {
    const notice =
      "ECHO's facility search request failed, so this profile has no complianceStatus.";
    mockGetFacility.mockResolvedValue({ profile: boeingProfile, notice });
    const params = facilityResource.params!.parse({ registry_id: '110000350509' });
    const result = await facilityResource.handler(params, mockContext());
    expect(result).toEqual({ ...boeingProfile, notice });
  });

  it('rejects an ECHO invalid-ID body as facility_not_found, the reason its declared recovery covers', async () => {
    const { EchoService } = await vi.importActual<typeof import('@/services/echo/echo-service.js')>(
      '@/services/echo/echo-service.js',
    );
    const echo = new EchoService(
      { pkg: { name: '@cyanheads/epa-mcp-server', version: '0.0.0-test' } } as AppConfig,
      {} as StorageService,
    );
    mockGetFacility.mockImplementation((id: string, ctx: Context) =>
      echo.getFacilityReport(id, ctx),
    );
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify(INVALID_ID_110000350509)));
    const params = facilityResource.params!.parse({ registry_id: '110000350509' });

    const error = await Promise.resolve(facilityResource.handler(params, mockContext())).catch(
      (e: unknown) => e,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: 'No facility found for ID "110000350509".',
      data: { reason: 'facility_not_found', registryId: '110000350509' },
    });
    // The framework fills the caller's recovery hint from the contract matching the thrown reason.
    const reason = (error as McpError).data?.reason;
    expect(facilityResource.errors?.find((contract) => contract.reason === reason)).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      recovery:
        'Verify the ID: find Registry IDs with epa_echo_search_facilities or PWSIDs with epa_water_search_systems, then read this resource again.',
    });
  });

  it("regression #62: returns a PWSID's profile with the default page of drinking-water violations", async () => {
    const { EchoService } = await vi.importActual<typeof import('@/services/echo/echo-service.js')>(
      '@/services/echo/echo-service.js',
    );
    const echo = new EchoService(
      { pkg: { name: '@cyanheads/epa-mcp-server', version: '0.0.0-test' } } as AppConfig,
      {} as StorageService,
    );
    mockGetFacility.mockImplementation((id: string, ctx: Context) =>
      echo.getFacilityReport(id, ctx),
    );
    const [row] = DFR_SDWIS_WA5389080.Results.ViolationsEnforcementActions.Sources[0]!.Violations;
    const dfr = {
      Results: {
        ...DFR_SDWIS_WA5389080.Results,
        ViolationsEnforcementActions: {
          Sources: [
            {
              Violations: Array.from({ length: 60 }, (_, i) => ({
                ...row,
                ViolationID: String(1000 + i),
              })),
            },
          ],
        },
      },
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).includes('get_dfr')
        ? new Response(JSON.stringify(dfr))
        : new Response(JSON.stringify({ Results: { Facilities: [] } })),
    );
    const params = facilityResource.params!.parse({ registry_id: 'WA5389080' });

    const result = (await facilityResource.handler(params, mockContext())) as {
      registryId: string;
      programs: { sdwa: boolean };
      drinkingWaterViolations: unknown[];
      drinkingWaterViolationsTotal: number;
      drinkingWaterViolationsNextOffset?: number;
    };

    expect(result.registryId).toBe('110049537202');
    expect(result.programs.sdwa).toBe(true);
    expect(result.drinkingWaterViolations).toHaveLength(50);
    expect(result.drinkingWaterViolationsTotal).toBe(60);
    expect(result.drinkingWaterViolationsNextOffset).toBe(50);
  });

  it('names the PWSID input in its description and registry_id parameter', () => {
    expect(facilityResource.description).toContain('public water system PWSID');
    expect(facilityResource.params!.shape.registry_id.description).toContain(
      'PWSID (from epa_water_search_systems)',
    );
  });

  it('propagates service errors upward', async () => {
    mockGetFacility.mockRejectedValue(new Error('Network timeout'));
    const params = facilityResource.params!.parse({ registry_id: '110000350509' });
    await expect(facilityResource.handler(params, mockContext())).rejects.toThrow(
      'Network timeout',
    );
  });
});
