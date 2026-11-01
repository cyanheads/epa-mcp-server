/**
 * @fileoverview Resource for fetching a Superfund site record by SEMS site ID.
 * @module mcp-server/resources/definitions/superfund-site.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { superfundContaminantsSchema } from '@/mcp-server/superfund-contaminants-schema.js';
import { superfundSiteSchema } from '@/mcp-server/superfund-site-schema.js';
import { getDmapService } from '@/services/dmap/dmap-service.js';

export const superfundSiteResource = resource('epa://superfund/{site_id}', {
  name: 'epa-superfund-site',
  description:
    'Superfund site record from EPA SEMS by exact site ID. Returns source status and assessment metadata, location, coordinates, and every contaminant association. Associations do not establish current exposure or concentrations.',
  mimeType: 'application/json',
  output: superfundSiteSchema.extend({ contaminants: superfundContaminantsSchema }),
  errors: [
    {
      reason: 'site_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No SEMS site matches the exact ID.',
      recovery: 'Use epa_superfund_search_sites to discover valid SEMS site IDs and retry.',
      thrownBy: 'service',
    },
  ],
  params: z.object({
    site_id: z
      .string()
      .describe('EPA SEMS Superfund site ID (obtained from epa_superfund_search_sites)'),
  }),

  async handler(params, ctx) {
    ctx.log.info('epa://superfund resource', { siteId: params.site_id });

    const { site, contaminants } = await getDmapService().getSuperfundSite(params.site_id, ctx);
    return { ...site, contaminants };
  },
});
