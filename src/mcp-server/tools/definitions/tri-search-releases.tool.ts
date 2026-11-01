/**
 * @fileoverview Tool for searching TRI release data across facilities in a state or county.
 * @module mcp-server/tools/definitions/tri-search-releases.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import {
  containsTerm,
  echoQuery,
  effectiveQueryEnrichment,
  equalsTerm,
} from '@/mcp-server/tools/effective-query.js';
import { formatHeading } from '@/mcp-server/tools/format-heading.js';
import { formatNotice } from '@/mcp-server/tools/format-notice.js';
import { formatTriReleaseLines } from '@/mcp-server/tools/format-tri-release.js';
import {
  invalidStateError,
  normalizeState,
  stateSchema,
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
import { bareCountyName } from '@/services/county-name.js';
import { getDmapService } from '@/services/dmap/dmap-service.js';

/** Most release records one call returns. */
const SEARCH_CAP = 200;

export const triSearchReleasesTool = tool('epa_tri_search_releases', {
  title: 'Search TRI Releases by Region',
  description:
    'TRI: Search Toxic Release Inventory data across facilities in a state or county, for one reporting year or, without year, every available year newest first. Returns facility name and county, TRI facility ID, EPA Registry ID (the registry_id epa_echo_get_facility takes), parent company, chemical name, and the Form R one-time release quantity; set include_release_breakdown to add on-site releases by medium (air, water, land, and underground-injection) and their total, at the cost of a slower call. Quantities are in pounds; dioxin and dioxin-like compounds, which TRI has facilities report in grams, are converted and marked with reportedUnit. Records come in reporting-year order, not ranked by quantity; page through a large match with offset and nextOffset. Use to build an environmental exposure profile for an area. Use epa_tri_get_facility_releases for detailed release records for a single facility. TRI data lags ~18 months from the current calendar year.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    state: stateSchema('2-letter US state or territory code (required, e.g. "WA", "TX", "PR")'),
    county: z
      .string()
      .max(4094)
      .optional()
      .describe(
        'County name to narrow results within the state, e.g. "King". Case-insensitive partial match on the bare name, so a short name can also match a longer one (LAKE matches LAKE OF THE WOODS; check countyName on each record); a trailing "County", "Parish", "Borough", "City and Borough", "Census Area", or "Municipality" is dropped before matching. Punctuation is matched as written ("Prince George\'s").',
      ),
    year: z
      .number()
      .int()
      .min(1987)
      .max(2030)
      .optional()
      .describe(
        'Reporting year. Omit to search every available year in the state, newest reporting year first, so the first page holds the most recent filings. TRI data lags ~18 months.',
      ),
    chemical_name: z
      .string()
      .max(4094)
      .optional()
      .describe(
        'Optional filter to restrict results to a specific chemical (partial match, case-insensitive). Commas, apostrophes, brackets, and Greek letters are matched as written, e.g. "4,4\'-Methylenedianiline".',
      ),
    limit: limitSchema({ cap: SEARCH_CAP, defaultLimit: 50, noun: 'release records' }),
    offset: offsetSchema('release records'),
    include_release_breakdown: z
      .boolean()
      .default(false)
      .describe(
        'Add on-site releases by medium (air, water, land, underground injection) and their total to each record. Costs one extra upstream request, which can add about 20 seconds when EPA has not cached it.',
      ),
  }),

  output: z.object({
    releases: z
      .array(
        z
          .object({
            facilityId: z.string().describe('TRI facility identifier'),
            facilityName: z.string().optional().describe('Facility name'),
            countyName: z
              .string()
              .optional()
              .describe(
                'County as TRI records the facility\'s location (e.g. "KING", "CALCASIEU PARISH"). The county filter is a partial match, so a short name can also match a longer one (LAKE matches LAKE OF THE WOODS); check this field to keep only the county you meant.',
              ),
            registryId: z
              .string()
              .optional()
              .describe(
                "12-digit EPA Facility Registry Service ID; pass it as registry_id to epa_echo_get_facility for the facility's compliance profile. Absent when TRI records none.",
              ),
            parentCompany: z
              .string()
              .optional()
              .describe(
                'Parent company as TRI standardizes its name. Absent when TRI records no parent company (its placeholder is NA).',
              ),
            chemicalName: z.string().describe('Chemical name as reported to TRI'),
            reportingYear: z.number().describe('Year of the TRI submission'),
            reportedUnit: z
              .literal('grams')
              .optional()
              .describe(
                'Present as "grams" when TRI had the facility report this chemical in grams (dioxin and dioxin-like compounds); its quantities here are converted to pounds (1 lb = 453.59237 g). Absent for chemicals reported in pounds.',
              ),
            oneTimeReleaseInLbs: z
              .number()
              .optional()
              .describe(
                'Form R Section 8.8 one-time release quantity in pounds (remedial actions, catastrophic events, and other one-time events not associated with production). It is already counted in the per-medium releases and the off-site transfers, so it is never added to them.',
              ),
            releasesToAirInLbs: z
              .number()
              .optional()
              .describe(
                'On-site air releases (fugitive + stack emissions) in pounds, summed across air release types for this submission. Only with include_release_breakdown.',
              ),
            releasesToWaterInLbs: z
              .number()
              .optional()
              .describe(
                'On-site releases to surface water in pounds, summed across all reported outfalls for this submission. Only with include_release_breakdown.',
              ),
            releasesToLandInLbs: z
              .number()
              .optional()
              .describe(
                'On-site land releases in pounds — landfills, land treatment, surface impoundment, and other on-site disposal, summed for this submission. Only with include_release_breakdown.',
              ),
            releasesToUndergroundInjectionInLbs: z
              .number()
              .optional()
              .describe(
                'On-site releases via underground injection wells in pounds, summed across injection well classes for this submission. Only with include_release_breakdown.',
              ),
            totalOnSiteReleasesInLbs: z
              .number()
              .optional()
              .describe(
                "Sum of the per-medium on-site releases present on this record (Form R Sections 5.1–5.5.4), in pounds. A medium TRI recorded only as a range code is left out, as it is from the per-medium fields; TRI's published on-site total counts a range at its midpoint, so it can be higher. Only with include_release_breakdown, and absent when no medium has a quantity.",
              ),
          })
          .describe('TRI release record for a facility-chemical-year combination'),
      )
      .describe('TRI release records for facilities in the queried state and filters'),
    state: z.string().describe('State queried, as the search sent it (uppercase code)'),
    message: z
      .string()
      .optional()
      .describe('Recovery hint when no releases are found. Absent when releases are returned.'),
  }),

  enrichment: {
    ...effectiveQueryEnrichment,
    ...pagingEnrichment,
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when more release records may follow this page; nextOffset continues it. Absent on the last page.',
      ),
    shown: z
      .number()
      .optional()
      .describe('Number of release records returned. Present only when truncated.'),
    cap: z.number().optional().describe('The limit that was applied. Present only when truncated.'),
    guidance: z
      .string()
      .optional()
      .describe('Present when truncated: the offset that continues the search.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Present when a punctuated county or chemical_name filter read its page limit before finding limit matches spelled as given, so more matching records may exist.',
      ),
  },
  enrichmentTrailer: {
    ...pagingTrailer,
    guidance: { render: formatNotice },
    notice: { render: formatNotice },
  },

  errors: [
    invalidStateError,
    {
      reason: 'unmatchable_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: "county or chemical_name has no letter or digit for EPA's DMAP service to match on.",
      recovery:
        'Include a letter or digit in whichever of county or chemical_name has none, or remove that filter.',
      thrownBy: 'service',
    },
    {
      reason: 'filter_too_long',
      code: JsonRpcErrorCode.ValidationError,
      when: "county and chemical_name make a request longer than EPA's DMAP service accepts.",
      recovery: 'Shorten county or chemical_name to a distinctive part of the name and retry.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const state = normalizeState(input.state);
    const { limit, notice: limitNotice } = clampLimit(input.limit, SEARCH_CAP);
    if (limitNotice) ctx.enrich({ limitNotice });
    ctx.log.info('epa_tri_search_releases', {
      state,
      year: input.year,
      county: input.county,
      offset: input.offset,
      includeReleaseBreakdown: input.include_release_breakdown,
    });

    const county = input.county === undefined ? undefined : bareCountyName(input.county);
    const chemicalName = input.chemical_name?.trim();
    const page = await getDmapService().searchTriReleases(
      {
        state,
        ...(county && { county }),
        ...(input.year !== undefined && { year: input.year }),
        ...(chemicalName && { chemicalName }),
        offset: input.offset,
        limit,
        includeReleaseBreakdown: input.include_release_breakdown,
      },
      ctx,
    );
    const releases = page.items;

    ctx.log.info('epa_tri_search_releases completed', { count: releases.length });
    // include_release_breakdown adds fields to each record but never changes which records match.
    echoQuery(ctx, [
      equalsTerm('state', state),
      county && containsTerm('county', county),
      equalsTerm('year', input.year ?? 'all, newest first'),
      chemicalName && containsTerm('chemical_name', chemicalName),
    ]);
    if (page.nextOffset !== undefined) {
      ctx.enrich({
        nextOffset: page.nextOffset,
        truncated: true,
        shown: releases.length,
        cap: limit,
        guidance: continueGuidance(page.nextOffset),
      });
    }

    if (releases.length === 0) {
      if (input.offset > 0) {
        return {
          releases: [],
          state,
          message: `No TRI releases found at offset ${input.offset}${pastEndSuffix(page.nextOffset, 'search', 'records')}`,
        };
      }
      const earlierYear =
        input.year === undefined
          ? undefined
          : Math.min(input.year - 1, new Date().getFullYear() - 2);
      const hints = ['TRI data lags ~18 months.'];
      if (earlierYear !== undefined) {
        hints.push(
          earlierYear >= 1987
            ? `For an earlier reporting period, try year ${earlierYear}, or remove year to search all available years.`
            : 'Remove year to search all available years.',
        );
      }
      if (chemicalName) hints.push('Remove chemical_name to include other chemicals.');
      if (county) hints.push('Remove county to search the whole state.');
      hints.push('Verify the state abbreviation or search a different state.');
      return { releases: [], state, message: `No TRI releases found. ${hints.join(' ')}` };
    }

    return { releases, state };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## TRI Releases — ${formatHeading(result.state)}`);
    lines.push(`**Records:** ${result.releases.length}`);
    if (result.message) lines.push(`\n> ${escapeMarkdownInline(result.message)}`);

    for (const r of result.releases) {
      const facilityLabel = r.facilityName ? `${r.facilityName} (${r.facilityId})` : r.facilityId;
      lines.push(
        `\n### ${formatHeading(r.chemicalName)} — ${formatHeading(facilityLabel)} (${r.reportingYear})`,
      );
      if (r.countyName) lines.push(`**County:** ${escapeMarkdownInline(r.countyName)}`);
      if (r.registryId) lines.push(`**Registry ID:** ${escapeMarkdownInline(r.registryId)}`);
      if (r.parentCompany)
        lines.push(`**Parent Company:** ${escapeMarkdownInline(r.parentCompany)}`);
      lines.push(...formatTriReleaseLines(r));
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
