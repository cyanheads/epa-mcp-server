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
import { INVALID_ID_110000350509 } from '../../../services/echo/echo-fixtures.js';

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
  programCompliance: [],
  inspections: [],
  inspectionsTotal: 0,
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
      message: 'No facility found for Registry ID "110000350509".',
      data: { reason: 'facility_not_found', registryId: '110000350509' },
    });
    // The framework fills the caller's recovery hint from the contract matching the thrown reason.
    const reason = (error as McpError).data?.reason;
    expect(facilityResource.errors?.find((contract) => contract.reason === reason)).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      recovery:
        'Use epa_search_facilities to discover valid Registry IDs, then read this resource again.',
    });
  });

  it('propagates service errors upward', async () => {
    mockGetFacility.mockRejectedValue(new Error('Network timeout'));
    const params = facilityResource.params!.parse({ registry_id: '110000350509' });
    await expect(facilityResource.handler(params, mockContext())).rejects.toThrow(
      'Network timeout',
    );
  });
});
