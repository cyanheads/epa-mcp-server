/**
 * @fileoverview Tool for querying TRI annual chemical release data for a specific facility.
 * @module mcp-server/tools/definitions/tri-get-facility-releases.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { formatTriReleaseLines } from '@/mcp-server/tools/format-tri-release.js';
import { getDmapService } from '@/services/dmap/dmap-service.js';

export const triGetFacilityReleasesTool = tool('epa_tri_get_facility_releases', {
  title: 'Get TRI Chemical Releases for Facility',
  description:
    'TRI: Query Toxic Release Inventory annual chemical release data for a specific facility. Returns per-chemical release records with chemical name, reporting year, routine on-site releases by medium (air, water, land, underground injection), and the one-time / non-routine release quantity. Quantities are in pounds; dioxin and dioxin-like compounds, which TRI has facilities report in grams, are converted and marked with reportedUnit. TRI data lags ~18 months — the most recent available year is typically 2 years prior to the current calendar year. facility_id is the 15-character TRI facility ID: take it from the facilityId field of epa_tri_search_releases, which also identifies top emitters across a region, or from the triFacilityIds of epa_echo_get_facility for a facility you already hold a Registry ID for. A 12-digit EPA Registry ID is a different identifier and matches no TRI records.',
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
        'Reporting year to retrieve. Omit for all available years, newest first. At most 500 filings are returned; narrow with year or chemical_name when capped. TRI data is typically available through ~2 years prior to the current year.',
      ),
    chemical_name: z
      .string()
      .max(4094)
      .optional()
      .describe(
        'Optional filter to restrict results to a specific chemical (partial match, case-insensitive). Commas, apostrophes, brackets, and Greek letters are matched as written, e.g. "4,4\'-Methylenedianiline".',
      ),
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
            totalReleasesInLbs: z
              .number()
              .optional()
              .describe(
                'TRI one-time / non-routine release quantity in pounds (spills, accidents) — a distinct TRI category, NOT the sum of the per-medium routine releases below.',
              ),
            releasesToAirInLbs: z
              .number()
              .optional()
              .describe(
                'On-site routine air releases (fugitive + stack emissions) in pounds, summed across air release types for this submission.',
              ),
            releasesToWaterInLbs: z
              .number()
              .optional()
              .describe(
                'On-site routine releases to surface water in pounds, summed across all reported outfalls for this submission.',
              ),
            releasesToLandInLbs: z
              .number()
              .optional()
              .describe(
                'On-site routine land releases in pounds — landfills, land treatment, surface impoundment, and other on-site disposal, summed for this submission.',
              ),
            releasesToUndergroundInjectionInLbs: z
              .number()
              .optional()
              .describe(
                'On-site routine releases via underground injection wells in pounds, summed across injection well classes for this submission.',
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
    truncated: z
      .boolean()
      .optional()
      .describe('True when 500 filings were returned and more may exist.'),
    shown: z.number().optional().describe('Number of filings returned when capped.'),
    cap: z.number().optional().describe('The 500-filing lookup cap, present only when reached.'),
    guidance: z
      .string()
      .optional()
      .describe('How to narrow a capped lookup with year or a more specific chemical_name.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Present when a punctuated chemical_name filter read its page limit before finding every filing spelled as given, so more matching records may exist.',
      ),
  },

  async handler(input, ctx) {
    ctx.log.info('epa_tri_get_facility_releases', {
      facilityId: input.facility_id,
      year: input.year,
    });

    const chemicalName = input.chemical_name?.trim();
    const releases = await getDmapService().getTriReleases(
      {
        facilityId: input.facility_id.trim(),
        ...(input.year !== undefined && { year: input.year }),
        ...(chemicalName && { chemicalName }),
      },
      ctx,
    );

    ctx.log.info('epa_tri_get_facility_releases completed', { count: releases.length });

    if (releases.length === 0) {
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
    lines.push(`## TRI Chemical Releases — Facility ${result.facilityId}`);
    lines.push(`**Records:** ${result.releases.length}`);
    if (result.message) lines.push(`\n> ${result.message}`);

    for (const r of result.releases) {
      lines.push(`\n### ${r.chemicalName} (${r.reportingYear})`);
      lines.push(`**Facility ID:** ${r.facilityId}`);
      lines.push(...formatTriReleaseLines(r));
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
