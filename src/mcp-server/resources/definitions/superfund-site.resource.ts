/**
 * @fileoverview Resource for fetching a Superfund site record by SEMS site ID.
 * @module mcp-server/resources/definitions/superfund-site.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { getDmapService } from '@/services/dmap/dmap-service.js';

export const superfundSiteResource = resource('epa://superfund/{site_id}', {
  name: 'epa-superfund-site',
  description:
    'Superfund site record from EPA SEMS by site ID. Returns NPL status, cleanup status, location, and coordinates.',
  mimeType: 'application/json',
  params: z.object({
    site_id: z.string().describe('EPA SEMS Superfund site ID (obtained from epa_search_superfund)'),
  }),

  async handler(params, ctx) {
    ctx.log.info('epa://superfund resource', { siteId: params.site_id });

    // DMAP supports direct column equality filters — use site_id/equals/{id} directly
    const sites = await getDmapService().searchSuperfundById(params.site_id, ctx);
    const site = sites[0];

    if (!site) {
      throw notFound(
        `No Superfund site found with site ID "${params.site_id}". Use epa_search_superfund to discover valid site IDs.`,
        { siteId: params.site_id },
      );
    }

    return site;
  },
});
