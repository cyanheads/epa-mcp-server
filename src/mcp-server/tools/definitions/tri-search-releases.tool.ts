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
  normalizeChemicalId,
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
import {
  chemicalNameSchema,
  triChemicalIdSchema,
  triEmptyResultHints,
} from '@/mcp-server/tools/tri-filters.js';
import { triReleaseSchema } from '@/mcp-server/tri-release-schema.js';
import { bareCountyName } from '@/services/county-name.js';
import { getDmapService } from '@/services/dmap/dmap-service.js';

/**
 * Most release records one call returns: the breakdown of a full page is one wave, three
 * side-by-side `doc_ctrl_num in` requests of 233 submissions (dmap-service BREAKDOWN_CONCURRENCY).
 */
const SEARCH_CAP = 699;

export const triSearchReleasesTool = tool('epa_tri_search_releases', {
  title: 'Search TRI Releases by Region',
  description:
    'TRI: Search Toxic Release Inventory data across facilities in a state or county, for one reporting year or, without year, every available year newest first. Returns facility name and county, TRI facility ID, EPA Registry ID (the registry_id epa_echo_get_facility takes), parent company, chemical name and TRI chemical ID with its CAS number, and the Form R one-time release quantity; set include_release_breakdown to add on-site releases by medium (air, water, land, and underground-injection) and their total, at the cost of a slower call. Quantities are in pounds; dioxin and dioxin-like compounds, which TRI has facilities report in grams, are converted and marked with reportedUnit. Records come in reporting-year order, not ranked by quantity; page through a large match with offset and nextOffset. Use to build an environmental exposure profile for an area. Use epa_tri_get_facility_releases for detailed release records for a single facility. TRI data lags ~18 months from the current calendar year.',
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
    chemical_name: chemicalNameSchema,
    chemical_id: triChemicalIdSchema,
    limit: limitSchema({ cap: SEARCH_CAP, defaultLimit: 25, noun: 'release records' }),
    offset: offsetSchema('release records'),
    include_release_breakdown: z
      .boolean()
      .default(false)
      .describe(
        'Add on-site releases by medium (air, water, land, underground injection) and their total to each record. Costs up to three extra upstream requests, made side by side, which can add about 20 seconds when EPA has not cached them.',
      ),
  }),

  output: z.object({
    releases: z
      .array(
        z
          .object({
            facilityId: z.string().describe('TRI facility ID'),
            facilityName: z.string().optional().describe('Facility name'),
            countyName: z
              .string()
              .optional()
              .describe('As TRI records it; county matches partially, so check this field'),
            registryId: z
              .string()
              .optional()
              .describe(
                '12-digit FRS Registry ID; pass it as registry_id to epa_echo_get_facility. Absent when TRI records none.',
              ),
            parentCompany: z
              .string()
              .optional()
              .describe(
                'As TRI standardizes it; absent when TRI records none (its NA placeholder)',
              ),
            ...triReleaseSchema.shape,
          })
          .describe(
            'One facility-chemical-year record; per-medium releases and their total only with include_release_breakdown',
          ),
      )
      .describe('Matching TRI records'),
    state: z.string().describe('State searched, uppercase'),
    message: z.string().optional().describe('Recovery hint on an empty result; absent otherwise.'),
  }),

  enrichment: {
    ...effectiveQueryEnrichment,
    ...pagingEnrichment,
    truncated: z
      .boolean()
      .optional()
      .describe('True when more records may follow; absent on the last page.'),
    shown: z.number().optional().describe('Present only when truncated.'),
    cap: z
      .number()
      .optional()
      .describe('Requested limit after the cap; present only when truncated.'),
    guidance: z.string().optional().describe('Present when truncated: the continuing offset.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Present when a punctuated county or chemical_name filter hit its read limit first, so more matches may exist.',
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
      when: 'county or chemical_name has no letter or digit.',
      recovery:
        'Include a letter or digit in whichever of county or chemical_name has none, or remove that filter.',
      thrownBy: 'service',
    },
    {
      reason: 'filter_too_long',
      code: JsonRpcErrorCode.ValidationError,
      when: 'county and chemical_name make the request too long.',
      recovery: 'Shorten county or chemical_name to a distinctive part of the name and retry.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const state = normalizeState(input.state);
    const { limit, notice: limitNotice } = clampLimit(input.limit, SEARCH_CAP, {
      tool: 'epa_tri_search_releases',
    });
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
    const chemicalId = normalizeChemicalId(input.chemical_id);
    const page = await getDmapService().searchTriReleases(
      {
        state,
        ...(county && { county }),
        ...(input.year !== undefined && { year: input.year }),
        ...(chemicalId && { chemicalId }),
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
      chemicalId && equalsTerm('chemical_id', chemicalId),
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
      const hints = triEmptyResultHints({ year: input.year, chemicalName, chemicalId });
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
