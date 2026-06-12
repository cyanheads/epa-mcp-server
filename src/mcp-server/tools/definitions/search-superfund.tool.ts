/**
 * @fileoverview Tool for searching Superfund (CERCLA/SEMS) sites by location or NPL status.
 * @module mcp-server/tools/definitions/search-superfund.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getDmapService } from '@/services/dmap/dmap-service.js';

export const searchSuperfundTool = tool('epa_search_superfund', {
  title: 'Search Superfund Sites',
  description:
    'Search Superfund (CERCLA/SEMS) sites by location or NPL listing status. Returns site name, EPA site ID, NPL status (listed/not listed/proposed), cleanup status, coordinates, and county FIPS code. Accepts either state/city/ZIP or latitude+longitude+radius for proximity searches. Use for "are there Superfund sites near X" questions.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    state: z.string().optional().describe('2-letter US state abbreviation to filter sites'),
    city: z.string().optional().describe('City name (partial match within state)'),
    zip_code: z.string().optional().describe('5-digit ZIP code to filter sites'),
    latitude: z
      .number()
      .optional()
      .describe('Latitude for proximity search (use with longitude and radius_miles)'),
    longitude: z
      .number()
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
      .enum(['listed', 'not-listed', 'proposed', 'all'])
      .default('all')
      .describe(
        'Filter by NPL (National Priorities List) status: listed=final NPL, not-listed=not on NPL, proposed=proposed for listing, all=include all',
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
    sites: z
      .array(
        z
          .object({
            siteId: z.string().describe('EPA SEMS site identifier'),
            name: z.string().describe('Superfund site name'),
            street: z.string().optional().describe('Street address'),
            city: z.string().optional().describe('City'),
            state: z.string().optional().describe('2-letter state abbreviation'),
            zip: z.string().optional().describe('ZIP code'),
            county: z.string().optional().describe('County name'),
            fipsCode: z.string().optional().describe('5-digit county FIPS code'),
            nplStatus: z
              .string()
              .optional()
              .describe('NPL status code: NPL=listed, N=not listed, P=proposed'),
            cleanupStatus: z.string().optional().describe('Current cleanup stage or status'),
            latitude: z.number().optional().describe('Latitude in decimal degrees'),
            longitude: z.number().optional().describe('Longitude in decimal degrees'),
          })
          .describe('Superfund site record with location, NPL status, and cleanup status'),
      )
      .describe('Matching Superfund sites'),
    totalCount: z
      .number()
      .describe('Number of sites returned (may be less than available if limit applied)'),
    message: z
      .string()
      .optional()
      .describe('Recovery hint when no sites are found. Absent when sites are returned.'),
  }),

  errors: [
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

    if (!hasGeo && !hasLatLng) {
      throw ctx.fail(
        'no_location_filter',
        'At least one location filter is required to search Superfund sites.',
        {
          ...ctx.recoveryFor('no_location_filter'),
        },
      );
    }

    if (hasLatLng && !input.radius_miles) {
      throw ctx.fail(
        'radius_required',
        'Provide radius_miles when using latitude+longitude for proximity search.',
        {
          ...ctx.recoveryFor('radius_required'),
        },
      );
    }

    ctx.log.info('epa_search_superfund', {
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
        limit: input.limit,
      },
      ctx,
    );

    ctx.log.info('epa_search_superfund completed', { count: sites.length });

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
    if (result.message) lines.push(`\n> ${result.message}`);

    for (const s of result.sites) {
      lines.push(`\n### ${s.name}`);
      lines.push(`**Site ID:** ${s.siteId}`);
      const location = [s.street, s.city, s.state, s.zip].filter(Boolean).join(', ');
      if (location) lines.push(`**Location:** ${location}`);
      if (s.county)
        lines.push(`**County:** ${s.county}${s.fipsCode ? ` (FIPS: ${s.fipsCode})` : ''}`);
      if (s.latitude !== undefined && s.longitude !== undefined) {
        lines.push(`**Coordinates:** ${s.latitude}, ${s.longitude}`);
      }
      if (s.nplStatus) lines.push(`**NPL Status:** ${s.nplStatus}`);
      if (s.cleanupStatus) lines.push(`**Cleanup Status:** ${s.cleanupStatus}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
