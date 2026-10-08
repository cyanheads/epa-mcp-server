/**
 * @fileoverview Tests for facilityResource.
 * @module tests/mcp-server/resources/definitions/facility.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { facilityResource } from '@/mcp-server/resources/definitions/facility.resource.js';

const mockGetFacility = vi.fn();

vi.mock('@/services/echo/echo-service.js', () => ({
  getEchoService: () => ({
    getFacility: mockGetFacility,
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
  inspections: [],
  formalActions: [],
};

describe('facilityResource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns facility profile for valid registry ID', async () => {
    mockGetFacility.mockResolvedValue(boeingProfile);
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = facilityResource.params!.parse({ registry_id: '110000350509' });
    const result = await facilityResource.handler(params, ctx);
    expect(result).toEqual(boeingProfile);
    expect(mockGetFacility).toHaveBeenCalledWith('110000350509', ctx);
  });

  it('throws NotFound when service returns profile without registryId', async () => {
    mockGetFacility.mockResolvedValue({
      registryId: '',
      name: '',
      programs: { air: false, water: false, rcra: false, tri: false, sdwa: false },
      inspections: [],
      formalActions: [],
    });
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = facilityResource.params!.parse({ registry_id: 'DOESNOTEXIST' });
    await expect(facilityResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: expect.stringContaining('Registry ID "DOESNOTEXIST"'),
      data: { registryId: 'DOESNOTEXIST' },
    });
  });

  it('propagates service errors upward', async () => {
    mockGetFacility.mockRejectedValue(new Error('Network timeout'));
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = facilityResource.params!.parse({ registry_id: '110000350509' });
    await expect(facilityResource.handler(params, ctx)).rejects.toThrow('Network timeout');
  });
});
