/**
 * @fileoverview Resource for fetching a full EPA facility compliance profile by Registry ID or EPA program ID.
 * @module mcp-server/resources/definitions/facility.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEchoService } from '@/services/echo/echo-service.js';

export const facilityResource = resource('epa://facility/{registry_id}', {
  name: 'epa-facility',
  description:
    "Full compliance profile for an EPA-regulated facility by EPA FRS Registry ID or EPA program ID, such as a public water system PWSID. Returns the same data as epa_echo_get_facility at its default pages of drinking-water violations and inspections (drinkingWaterViolationsNextOffset and inspectionsNextOffset mark more; page them with that tool), with its notice as a `notice` field when ECHO's facility status lookup failed.",
  mimeType: 'application/json',
  params: z.object({
    registry_id: z
      .string()
      .describe(
        'EPA FRS Registry ID for the facility, or an EPA program ID ECHO resolves to one: a public water system PWSID (from epa_water_search_systems), a TRI facility ID, an NPDES permit, or a RCRA handler ID',
      ),
  }),

  errors: [
    {
      reason: 'facility_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'ECHO has no facility for the given Registry ID or program ID.',
      recovery:
        'Verify the ID: find Registry IDs with epa_echo_search_facilities or PWSIDs with epa_water_search_systems, then read this resource again.',
      thrownBy: 'service',
    },
  ],

  async handler(params, ctx) {
    ctx.log.info('epa://facility resource', { registryId: params.registry_id });
    const { profile, notice } = await getEchoService().getFacilityReport(params.registry_id, ctx);
    return notice ? { ...profile, notice } : profile;
  },
});
