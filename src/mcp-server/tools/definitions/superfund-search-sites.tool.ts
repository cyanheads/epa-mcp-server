/**
 * @fileoverview Tool for searching Superfund (CERCLA/SEMS) sites by location or NPL status.
 * @module mcp-server/tools/definitions/superfund-search-sites.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { superfundSiteSchema } from '@/mcp-server/superfund-site-schema.js';
import {
  distanceMilesField,
  formatDistanceLine,
  roundMiles,
} from '@/mcp-server/tools/distance-field.js';
import {
  beginsWithTerm,
  containsTerm,
  echoQuery,
  effectiveQueryEnrichment,
  equalsTerm,
} from '@/mcp-server/tools/effective-query.js';
import { formatNotice } from '@/mcp-server/tools/format-notice.js';
import { formatSuperfundSite } from '@/mcp-server/tools/format-superfund-site.js';
import {
  invalidStateError,
  normalizeState,
  normalizeZip,
  optionalStateSchema,
  optionalZipSchema,
} from '@/mcp-server/tools/input-formats.js';
import {
  clampLimit,
  continueGuidance,
  limitSchema,
  offsetSchema,
  pagingEnrichment,
  pagingTrailer,
  pastEndSuffix,
} from '@/mcp-server/tools/paging.js';
import { getDmapService, NPL_STATUS_CODES } from '@/services/dmap/dmap-service.js';

/** Most sites one call returns: a full CA page of 2,500 is about 0.9 MB on either surface. */
const SEARCH_CAP = 2500;

export const superfundSearchSitesTool = tool('epa_superfund_search_sites', {
  title: 'Search Superfund Sites',
  description:
    "Superfund: Search Superfund (CERCLA/SEMS) sites by location, site name, or NPL listing status. Returns site identifiers, source NPL status labels, non-NPL assessment and archive metadata when available, coordinates, and county FIPS code. A state, city, ZIP, or name search returns sites in SEMS site ID order; latitude+longitude+radius returns them nearest first with each site's distanceMiles, and name narrows either. Page through a large match with offset and nextOffset. Proximity searches match only sites with usable coordinates and share a 50-second deadline; narrow the radius or add filters if the search times out. Use epa_superfund_get_site with a returned siteId for contaminant associations.",
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    state: optionalStateSchema('2-letter US state or territory code to filter sites, e.g. "WA"'),
    city: z
      .string()
      .max(4094)
      .optional()
      .describe(
        'City name (partial match within state, case-insensitive). Punctuation is matched as written ("St. Louis", "Coeur d\'Alene").',
      ),
    name: z
      .string()
      .max(4094)
      .optional()
      .describe(
        'Site name (partial match, case-insensitive), alone or with any other filter. Punctuation is matched as written.',
      ),
    zip_code: optionalZipSchema(
      '5-digit ZIP code to filter sites; a ZIP+4 searches its 5-digit ZIP. Matches sites recorded under the ZIP or any ZIP+4 within it.',
    ),
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
    limit: limitSchema({ cap: SEARCH_CAP, defaultLimit: 25, noun: 'sites' }),
    offset: offsetSchema('sites'),
  }),

  output: z.object({
    sites: z
      .array(superfundSiteSchema.extend({ distanceMiles: distanceMilesField }).describe('One site'))
      .describe('Matching sites'),
    totalCount: z
      .number()
      .optional()
      .describe(
        'Matches before limit and offset; present only on a proximity search (otherwise follow nextOffset).',
      ),
    message: z.string().optional().describe('Recovery hint on an empty result; absent otherwise.'),
  }),

  enrichment: {
    ...effectiveQueryEnrichment,
    ...pagingEnrichment,
    guidance: z
      .string()
      .optional()
      .describe('Present when more sites follow: the continuing offset.'),
    notice: z
      .string()
      .optional()
      .describe(
        "Proximity coordinate-coverage caveat with the page's place in the nearest-first match; also present when a punctuated city or name filter hits its page limit.",
      ),
  },
  enrichmentTrailer: {
    ...pagingTrailer,
    guidance: { render: formatNotice },
    notice: { render: formatNotice },
  },

  errors: [
    {
      reason: 'incomplete_proximity',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A proximity input came without both latitude and longitude.',
      recovery:
        'Provide latitude, longitude, and radius_miles together, or omit all three for an administrative search.',
    },
    {
      reason: 'no_location_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No state, city, zip_code, name, or latitude+longitude.',
      recovery:
        'Provide at least one of state, city, zip_code, name, or latitude+longitude+radius_miles.',
    },
    {
      reason: 'radius_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'latitude and longitude without radius_miles.',
      recovery: 'Provide radius_miles together with latitude and longitude for a proximity search.',
    },
    invalidStateError,
    {
      reason: 'unmatchable_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'city or name has no letter or digit.',
      recovery:
        'Include a letter or digit in city or name, or search by state or zip_code instead.',
      thrownBy: 'service',
    },
    {
      reason: 'filter_too_long',
      code: JsonRpcErrorCode.ValidationError,
      when: 'city or name makes the request too long.',
      recovery: 'Shorten city or name to a distinctive part of it and retry.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const state = normalizeState(input.state);
    const city = input.city?.trim();
    const name = input.name?.trim();
    const zipCode = normalizeZip(input.zip_code);
    const hasGeo = !!state || !!city || !!name || !!zipCode;
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
        'At least one of state, city, zip_code, name, or latitude+longitude is required to search Superfund sites.',
      );
    }

    const { limit, notice: limitNotice } = clampLimit(input.limit, SEARCH_CAP, {
      tool: 'epa_superfund_search_sites',
    });
    if (limitNotice) ctx.enrich({ limitNotice });
    ctx.log.info('epa_superfund_search_sites', {
      state,
      name,
      lat: input.latitude,
      nplStatus: input.npl_status,
      offset: input.offset,
    });

    const page = await getDmapService().searchSuperfund(
      {
        ...(state && { state }),
        ...(city && { city }),
        ...(name && { name }),
        ...(zipCode && { zipCode }),
        ...(input.latitude !== undefined && { latitude: input.latitude }),
        ...(input.longitude !== undefined && { longitude: input.longitude }),
        ...(input.radius_miles !== undefined && { radiusMiles: input.radius_miles }),
        ...(input.npl_status !== 'all' && { nplStatus: input.npl_status }),
        ...(input.exclude_archived && { excludeArchived: true }),
        offset: input.offset,
        limit,
      },
      ctx,
    );
    const sites = page.items.map((site) =>
      site.distanceMiles === undefined
        ? site
        : { ...site, distanceMiles: roundMiles(site.distanceMiles) },
    );

    ctx.log.info('epa_superfund_search_sites completed', { count: sites.length });
    const nplCodes = NPL_STATUS_CODES.get(input.npl_status);
    echoQuery(ctx, [
      state && equalsTerm('state', state),
      city && containsTerm('city', city),
      name && containsTerm('name', name),
      zipCode && beginsWithTerm('zip_code', zipCode),
      ...(input.latitude !== undefined && input.longitude !== undefined
        ? [
            equalsTerm('latitude', input.latitude),
            equalsTerm('longitude', input.longitude),
            equalsTerm('radius_miles', `${input.radius_miles}, nearest first`),
          ]
        : []),
      nplCodes && equalsTerm('npl_status', nplCodes),
      input.exclude_archived && equalsTerm('exclude_archived', true),
    ]);
    if (page.nextOffset !== undefined) {
      ctx.enrich({ nextOffset: page.nextOffset, guidance: continueGuidance(page.nextOffset) });
    }
    const matched = page.totalCount !== undefined && { totalCount: page.totalCount };

    if (sites.length === 0) {
      if (input.offset > 0) {
        return {
          sites: [],
          ...matched,
          message: `No Superfund sites found at offset ${input.offset}${pastEndSuffix(page.nextOffset, 'search', 'sites')}`,
        };
      }
      return {
        sites: [],
        ...matched,
        message: `No Superfund sites found. Try ${input.name ? 'a shorter name, ' : ''}expanding the area, removing NPL status filter, or using a different location.`,
      };
    }

    return { sites, ...matched };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## Superfund Sites`);
    lines.push(
      result.totalCount === undefined
        ? `**Returned:** ${result.sites.length}`
        : `**Total Found:** ${result.totalCount} | **Returned:** ${result.sites.length}`,
    );
    if (result.message) lines.push(`\n> ${escapeMarkdownInline(result.message)}`);

    for (const s of result.sites) {
      lines.push('', ...formatSuperfundSite(s));
      if (s.distanceMiles !== undefined) lines.push(formatDistanceLine(s.distanceMiles));
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
