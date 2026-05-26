/**
 * @fileoverview Resource for fetching a full EPA facility compliance profile by Registry ID.
 * @module mcp-server/resources/definitions/facility.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { getEchoService } from '@/services/echo/echo-service.js';

export const facilityResource = resource('epa://facility/{registry_id}', {
  name: 'epa-facility',
  description:
    'Full compliance profile for an EPA-regulated facility by EPA FRS Registry ID. Returns the same data as epa_get_facility.',
  mimeType: 'application/json',
  params: z.object({
    registry_id: z.string().describe('EPA FRS Registry ID for the facility'),
  }),

  async handler(params, ctx) {
    ctx.log.info('epa://facility resource', { registryId: params.registry_id });

    const profile = await getEchoService().getFacility(params.registry_id, ctx);

    if (!profile.registryId) {
      throw notFound(
        `No facility found for Registry ID "${params.registry_id}". Use epa_search_facilities to discover valid Registry IDs.`,
        { registryId: params.registry_id },
      );
    }

    return profile;
  },
});
