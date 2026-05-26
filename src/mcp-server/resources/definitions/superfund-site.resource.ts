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
    'Superfund site record from EPA SEMS by site ID. Returns NPL status, cleanup status, location, and coordinates. The SEMS dataset is large — this resource performs a broad scan and may be slow for rare site IDs.',
  mimeType: 'application/json',
  params: z.object({
    site_id: z.string().describe('EPA SEMS Superfund site ID (obtained from epa_search_superfund)'),
  }),

  async handler(params, ctx) {
    ctx.log.info('epa://superfund resource', { siteId: params.site_id });

    // DMAP has no single-record-by-ID endpoint for SEMS. We use the site_id value
    // as a state-code prefix heuristic — SEMS site IDs often start with a 2-letter state code.
    // Fall back to a broader unfiltered search when that fails.
    const stateGuess =
      params.site_id.length >= 2 ? params.site_id.slice(0, 2).toUpperCase() : undefined;

    let sites = await getDmapService().searchSuperfund(
      { ...(stateGuess && { state: stateGuess }), nplStatus: 'all', limit: 200 },
      ctx,
    );

    let site = sites.find((s) => s.siteId === params.site_id);

    // If not found by state guess, do a broader search without state filter
    if (!site && stateGuess) {
      sites = await getDmapService().searchSuperfund({ nplStatus: 'all', limit: 500 }, ctx);
      site = sites.find((s) => s.siteId === params.site_id);
    }

    if (!site) {
      throw notFound(
        `No Superfund site found with site ID "${params.site_id}". Use epa_search_superfund to discover valid site IDs.`,
        { siteId: params.site_id },
      );
    }

    return site;
  },
});
