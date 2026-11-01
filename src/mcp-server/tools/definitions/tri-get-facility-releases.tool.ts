/**
 * @fileoverview Tool for querying TRI annual chemical release data for a specific facility.
 * @module mcp-server/tools/definitions/tri-get-facility-releases.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { formatHeading } from '@/mcp-server/tools/format-heading.js';
import { formatNotice } from '@/mcp-server/tools/format-notice.js';
import { formatTriReleaseLines } from '@/mcp-server/tools/format-tri-release.js';
import {
  clampLimit,
  continueGuidance,
  limitSchema,
  offsetSchema,
  pagingEnrichment,
  pagingTrailer,
  pastEndSuffix,
} from '@/mcp-server/tools/paging.js';
import { getDmapService } from '@/services/dmap/dmap-service.js';

/** Most filings one call returns, and the default. */
const LOOKUP_CAP = 500;

export const triGetFacilityReleasesTool = tool('epa_tri_get_facility_releases', {
  title: 'Get TRI Chemical Releases for Facility',
  description:
    'TRI: Query Toxic Release Inventory annual chemical release data for a specific facility. Returns per-chemical release records with chemical name, reporting year, on-site releases by medium (air, water, land, underground injection) and their total, and the Form R one-time release quantity, newest reporting year first; page past 500 filings with offset and nextOffset. Quantities are in pounds; dioxin and dioxin-like compounds, which TRI has facilities report in grams, are converted and marked with reportedUnit. TRI data lags ~18 months — the most recent available year is typically 2 years prior to the current calendar year. facility_id is the 15-character TRI facility ID: take it from the facilityId field of epa_tri_search_releases, or from the triFacilityIds of epa_echo_get_facility for a facility you already hold a Registry ID for. A 12-digit EPA Registry ID is a different identifier and matches no TRI records.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    facility_id: z
      .string()
      .min(1)
      .describe(
        '15-character TRI facility ID (e.g. "9867WSNRWD1981S") — the facilityId field returned by epa_tri_search_releases, or an entry of epa_echo_get_facility triFacilityIds. A 12-digit EPA Registry ID matches no TRI records.',
      ),
    year: z
      .number()
      .int()
      .min(1987)
      .max(2030)
      .optional()
      .describe(
        'Reporting year to retrieve. Omit for all available years, newest first. TRI data is typically available through ~2 years prior to the current year.',
      ),
    chemical_name: z
      .string()
      .max(4094)
      .optional()
      .describe(
        'Optional filter to restrict results to a specific chemical (partial match, case-insensitive). Commas, apostrophes, brackets, and Greek letters are matched as written, e.g. "4,4\'-Methylenedianiline".',
      ),
    limit: limitSchema({ cap: LOOKUP_CAP, defaultLimit: LOOKUP_CAP, noun: 'filings' }),
    offset: offsetSchema('filings'),
  }),

  output: z.object({
    releases: z
      .array(
        z
          .object({
            facilityId: z.string().describe('TRI facility identifier'),
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
                'On-site air releases (fugitive + stack emissions) in pounds, summed across air release types for this submission.',
              ),
            releasesToWaterInLbs: z
              .number()
              .optional()
              .describe(
                'On-site releases to surface water in pounds, summed across all reported outfalls for this submission.',
              ),
            releasesToLandInLbs: z
              .number()
              .optional()
              .describe(
                'On-site land releases in pounds — landfills, land treatment, surface impoundment, and other on-site disposal, summed for this submission.',
              ),
            releasesToUndergroundInjectionInLbs: z
              .number()
              .optional()
              .describe(
                'On-site releases via underground injection wells in pounds, summed across injection well classes for this submission.',
              ),
            totalOnSiteReleasesInLbs: z
              .number()
              .optional()
              .describe(
                "Sum of the per-medium on-site releases present on this record (Form R Sections 5.1–5.5.4), in pounds. A medium TRI recorded only as a range code is left out, as it is from the per-medium fields; TRI's published on-site total counts a range at its midpoint, so it can be higher. Absent when no medium has a quantity.",
              ),
          })
          .describe('Per-chemical TRI release record for this facility and year'),
      )
      .describe('Per-chemical annual TRI release records for the queried facility'),
    facilityId: z.string().describe('TRI facility ID queried'),
    message: z
      .string()
      .optional()
      .describe(
        'Recovery hint when no releases are found — suggests alternative years or checking the facility ID. Absent when releases are returned.',
      ),
  }),

  enrichment: {
    ...pagingEnrichment,
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when more filings may follow this page; nextOffset continues it. Absent on the last page.',
      ),
    shown: z
      .number()
      .optional()
      .describe('Number of filings returned. Present only when truncated.'),
    cap: z.number().optional().describe('The limit that was applied. Present only when truncated.'),
    guidance: z
      .string()
      .optional()
      .describe('Present when truncated: the offset that continues the lookup.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Present when a punctuated chemical_name filter read its page limit before finding every filing spelled as given, so more matching records may exist.',
      ),
  },
  enrichmentTrailer: {
    ...pagingTrailer,
    guidance: { render: formatNotice },
    notice: { render: formatNotice },
  },

  errors: [
    {
      reason: 'unmatchable_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: "facility_id holds a character EPA's DMAP service cannot match exactly, or chemical_name has no letter or digit.",
      recovery:
        'Pass one 15-character TRI facility ID from epa_tri_search_releases, and include a letter or digit in chemical_name.',
      thrownBy: 'service',
    },
    {
      reason: 'filter_too_long',
      code: JsonRpcErrorCode.ValidationError,
      when: "facility_id and chemical_name make a request longer than EPA's DMAP service accepts.",
      recovery:
        'Pass one 15-character TRI facility ID and shorten chemical_name to a distinctive part of the name.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const { limit, notice: limitNotice } = clampLimit(input.limit, LOOKUP_CAP);
    if (limitNotice) ctx.enrich({ limitNotice });
    ctx.log.info('epa_tri_get_facility_releases', {
      facilityId: input.facility_id,
      year: input.year,
      offset: input.offset,
    });

    const chemicalName = input.chemical_name?.trim();
    const page = await getDmapService().getTriReleases(
      {
        facilityId: input.facility_id.trim(),
        ...(input.year !== undefined && { year: input.year }),
        ...(chemicalName && { chemicalName }),
        offset: input.offset,
        limit,
      },
      ctx,
    );
    const releases = page.items;

    ctx.log.info('epa_tri_get_facility_releases completed', { count: releases.length });
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
          facilityId: input.facility_id,
          message: `No TRI releases found for facility "${input.facility_id}" at offset ${input.offset}${pastEndSuffix(page.nextOffset, 'lookup', 'records')}`,
        };
      }
      const yearNote = input.year ? ` for year ${input.year}` : '';
      const chemNote = input.chemical_name ? ` matching chemical "${input.chemical_name}"` : '';
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
      hints.push(
        "Verify the facility ID with epa_tri_search_releases — facility_id is its 15-character facilityId, not a 12-digit EPA Registry ID; epa_echo_get_facility returns a Registry ID's TRI IDs as triFacilityIds.",
      );
      return {
        releases: [],
        facilityId: input.facility_id,
        message: `No TRI releases found for facility "${input.facility_id}"${yearNote}${chemNote}. ${hints.join(' ')}`,
      };
    }

    return { releases, facilityId: input.facility_id };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## TRI Chemical Releases — Facility ${formatHeading(result.facilityId)}`);
    lines.push(`**Records:** ${result.releases.length}`);
    if (result.message) lines.push(`\n> ${escapeMarkdownInline(result.message)}`);

    for (const r of result.releases) {
      lines.push(`\n### ${formatHeading(r.chemicalName)} (${r.reportingYear})`);
      lines.push(`**Facility ID:** ${escapeMarkdownInline(r.facilityId)}`);
      lines.push(...formatTriReleaseLines(r));
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
