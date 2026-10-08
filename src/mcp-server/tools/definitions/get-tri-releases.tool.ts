/**
 * @fileoverview Tool for querying TRI annual chemical release data for a specific facility.
 * @module mcp-server/tools/definitions/get-tri-releases.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatTriReleaseLines } from '@/mcp-server/tools/format-tri-release.js';
import { getDmapService } from '@/services/dmap/dmap-service.js';

export const getTriReleasesTool = tool('epa_get_tri_releases', {
  title: 'Get TRI Chemical Releases for Facility',
  description:
    'Query Toxic Release Inventory annual chemical release data for a specific facility. Returns per-chemical release records with chemical name, reporting year, routine on-site releases by medium (air, water, land, underground injection), and the one-time / non-routine release quantity. Quantities are in pounds; dioxin and dioxin-like compounds, which TRI has facilities report in grams, are converted and marked with reportedUnit. TRI data lags ~18 months — the most recent available year is typically 2 years prior to the current calendar year. facility_id is the 15-character TRI facility ID: take it from the facilityId field of epa_search_tri_releases, which also identifies top emitters across a region. A 12-digit EPA Registry ID is a different identifier and matches no TRI records.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    facility_id: z
      .string()
      .min(1)
      .describe(
        '15-character TRI facility ID (e.g. "9867WSNRWD1981S") — the facilityId field returned by epa_search_tri_releases. A 12-digit EPA Registry ID matches no TRI records.',
      ),
    year: z
      .number()
      .int()
      .min(1987)
      .max(2030)
      .optional()
      .describe(
        'Reporting year to retrieve. Defaults to all available years. TRI data is typically available through ~2 years prior to the current year.',
      ),
    chemical_name: z
      .string()
      .optional()
      .describe(
        'Optional filter to restrict results to a specific chemical (partial match, case-insensitive)',
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

  errors: [
    {
      reason: 'no_releases_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No TRI records found for the given facility ID and filters.',
      recovery:
        'Take the 15-character TRI facility ID from the facilityId field of epa_search_tri_releases. TRI data lags 18 months — try an earlier year.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('epa_get_tri_releases', { facilityId: input.facility_id, year: input.year });

    const chemicalName = input.chemical_name?.trim();
    const releases = await getDmapService().getTriReleases(
      {
        facilityId: input.facility_id.trim(),
        ...(input.year !== undefined && { year: input.year }),
        ...(chemicalName && { chemicalName }),
      },
      ctx,
    );

    ctx.log.info('epa_get_tri_releases completed', { count: releases.length });

    if (releases.length === 0) {
      const yearNote = input.year ? ` for year ${input.year}` : '';
      const chemNote = input.chemical_name ? ` matching chemical "${input.chemical_name}"` : '';
      return {
        releases: [],
        facilityId: input.facility_id,
        message: `No TRI releases found for facility "${input.facility_id}"${yearNote}${chemNote}. TRI data lags ~18 months — try year ${new Date().getFullYear() - 2} or earlier. Verify the facility ID with epa_search_tri_releases — facility_id is its 15-character facilityId, not a 12-digit EPA Registry ID.`,
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
