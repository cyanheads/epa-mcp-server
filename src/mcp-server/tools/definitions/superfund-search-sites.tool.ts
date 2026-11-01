/**
 * @fileoverview Tool for searching Superfund (CERCLA/SEMS) sites by location or NPL status.
 * @module mcp-server/tools/definitions/superfund-search-sites.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { superfundSiteSchema } from '@/mcp-server/superfund-site-schema.js';
import { formatNotice } from '@/mcp-server/tools/format-notice.js';
import { formatSuperfundSite } from '@/mcp-server/tools/format-superfund-site.js';
import { getDmapService } from '@/services/dmap/dmap-service.js';

export const superfundSearchSitesTool = tool('epa_superfund_search_sites', {
  title: 'Search Superfund Sites',
  description:
    'Superfund: Search Superfund (CERCLA/SEMS) sites by location or NPL listing status. Returns site identifiers, source NPL status labels, non-NPL assessment and archive metadata when available, coordinates, and county FIPS code. Accepts either state/city/ZIP or latitude+longitude+radius for proximity searches, ordered nearest first. Proximity searches match only sites with usable coordinates and share a 50-second deadline; narrow the radius or add filters if the search times out. Use epa_superfund_get_site with a returned siteId for contaminant associations.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    state: z.string().optional().describe('2-letter US state abbreviation to filter sites'),
    city: z
      .string()
      .max(4094)
      .optional()
      .describe(
        'City name (partial match within state, case-insensitive). Punctuation is matched as written ("St. Louis", "Coeur d\'Alene").',
      ),
    zip_code: z.string().optional().describe('5-digit ZIP code to filter sites'),
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe('Latitude for proximity search (use with longitude and radius_miles)'),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .optional()
      .describe('Longitude for proximity search (use with latitude and radius_miles)'),
    radius_miles: z
      .number()
      .min(0.1)
      .max(500)
      .optional()
      .describe(
        'Search radius in miles from the given coordinates. Required when using latitude+longitude.',
      ),
    npl_status: z
      .enum(['listed', 'not-listed', 'proposed', 'deleted', 'removed', 'withdrawn', 'all'])
      .default('all')
      .describe(
        'Filter by NPL status: listed=final or part of an NPL site (F,A), not-listed=N, proposed=P, deleted=D, removed=R, withdrawn=W, all=include all',
      ),
    exclude_archived: z
      .boolean()
      .default(false)
      .describe(
        'Exclude archived sites by requiring SEMS archived_ind=N; false retains all archive statuses',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe('Maximum number of sites to return (1–200)'),
  }),

  output: z.object({
    sites: z.array(superfundSiteSchema).describe('Matching Superfund sites'),
    totalCount: z
      .number()
      .describe('Number of sites returned (may be less than available if limit applied)'),
    message: z
      .string()
      .optional()
      .describe('Recovery hint when no sites are found. Absent when sites are returned.'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Proximity coordinate-coverage limitation, combined with any omitted-match notice; also present when a non-proximity punctuated city filter reaches its page limit.',
      ),
  },
  enrichmentTrailer: { notice: { render: formatNotice } },

  errors: [
    {
      reason: 'incomplete_proximity',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Only part of latitude, longitude, and radius_miles was supplied, except latitude+longitude without radius_miles.',
      recovery:
        'Provide latitude, longitude, and radius_miles together, or omit all three for an administrative search.',
    },
    {
      reason: 'no_location_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No location filter (state, city, zip_code, or latitude+longitude) was provided.',
      recovery:
        'Provide at least one location filter: state, city, zip_code, or latitude+longitude+radius_miles.',
    },
    {
      reason: 'radius_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Latitude and longitude were provided without radius_miles.',
      recovery: 'Provide radius_miles together with latitude and longitude for a proximity search.',
    },
  ],

  async handler(input, ctx) {
    const hasGeo = !!input.state?.trim() || !!input.city?.trim() || !!input.zip_code?.trim();
    const hasLatLng = input.latitude !== undefined && input.longitude !== undefined;

    if (hasLatLng && input.radius_miles === undefined) {
      throw ctx.fail(
        'radius_required',
        'Provide radius_miles when using latitude+longitude for proximity search.',
      );
    }
    const hasProximityInput =
      input.latitude !== undefined ||
      input.longitude !== undefined ||
      input.radius_miles !== undefined;
    if (hasProximityInput && (!hasLatLng || input.radius_miles === undefined)) {
      throw ctx.fail(
        'incomplete_proximity',
        'Provide latitude, longitude, and radius_miles together for a proximity search.',
      );
    }

    if (!hasGeo && !hasLatLng) {
      throw ctx.fail(
        'no_location_filter',
        'At least one location filter is required to search Superfund sites.',
      );
    }

    ctx.log.info('epa_superfund_search_sites', {
      state: input.state,
      lat: input.latitude,
      nplStatus: input.npl_status,
    });

    const state = input.state?.trim();
    const city = input.city?.trim();
    const zipCode = input.zip_code?.trim();
    const sites = await getDmapService().searchSuperfund(
      {
        ...(state && { state }),
        ...(city && { city }),
        ...(zipCode && { zipCode }),
        ...(input.latitude !== undefined && { latitude: input.latitude }),
        ...(input.longitude !== undefined && { longitude: input.longitude }),
        ...(input.radius_miles !== undefined && { radiusMiles: input.radius_miles }),
        ...(input.npl_status !== 'all' && { nplStatus: input.npl_status }),
        ...(input.exclude_archived && { excludeArchived: true }),
        limit: input.limit,
      },
      ctx,
    );

    ctx.log.info('epa_superfund_search_sites completed', { count: sites.length });

    if (sites.length === 0) {
      const location = hasLatLng
        ? `lat=${input.latitude}, lng=${input.longitude}, radius=${input.radius_miles} miles`
        : [input.state, input.city, input.zip_code].filter(Boolean).join(', ');
      return {
        sites: [],
        totalCount: 0,
        message: `No Superfund sites found near ${location} with npl_status="${input.npl_status}". Try expanding the area, removing NPL status filter, or using a different location.`,
      };
    }

    return { sites, totalCount: sites.length };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## Superfund Sites`);
    lines.push(`**Found:** ${result.totalCount}`);
    if (result.message) lines.push(`\n> ${escapeMarkdownInline(result.message)}`);

    for (const s of result.sites) {
      lines.push('', ...formatSuperfundSite(s));
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
