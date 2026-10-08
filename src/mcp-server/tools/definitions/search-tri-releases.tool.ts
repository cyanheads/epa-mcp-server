/**
 * @fileoverview Tool for searching TRI release data across facilities in a state or county.
 * @module mcp-server/tools/definitions/search-tri-releases.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatTriReleaseLines } from '@/mcp-server/tools/format-tri-release.js';
import { getDmapService } from '@/services/dmap/dmap-service.js';

export const searchTriReleasesTool = tool('epa_search_tri_releases', {
  title: 'Search TRI Releases by Region',
  description:
    'Search Toxic Release Inventory data across facilities in a state or county for a given reporting year. Returns facility name and county, TRI facility ID, chemical name, and the one-time / non-routine release quantity; set include_release_breakdown to add routine on-site releases by medium (air, water, land, and underground-injection), at the cost of a slower call. Quantities are in pounds; dioxin and dioxin-like compounds, which TRI has facilities report in grams, are converted and marked with reportedUnit. Use to identify top polluters in an area or build an environmental exposure profile. Use epa_get_tri_releases for detailed release records for a single facility. TRI data lags ~18 months from the current calendar year.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    state: z
      .string()
      .min(2)
      .max(2)
      .describe('2-letter US state abbreviation (required, e.g. "WA", "TX")'),
    county: z
      .string()
      .optional()
      .describe(
        'County name to narrow results within the state, e.g. "King". Case-insensitive partial match on the bare name, so a short name can also match a longer one (LAKE matches LAKE OF THE WOODS; check countyName on each record); a trailing "County", "Parish", or "Borough" is dropped before matching.',
      ),
    year: z
      .number()
      .int()
      .min(1987)
      .max(2030)
      .optional()
      .describe(
        'Reporting year. Defaults to all available years in the state. TRI data lags ~18 months.',
      ),
    chemical_name: z
      .string()
      .optional()
      .describe(
        'Optional filter to restrict results to a specific chemical (partial match, case-insensitive)',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe('Maximum number of release records to return (1–200)'),
    include_release_breakdown: z
      .boolean()
      .default(false)
      .describe(
        'Add routine on-site releases by medium (air, water, land, underground injection) to each record. Costs one extra upstream request, which can add about 20 seconds when EPA has not cached it.',
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
                'On-site routine air releases (fugitive + stack emissions) in pounds, summed across air release types for this submission. Only with include_release_breakdown.',
              ),
            releasesToWaterInLbs: z
              .number()
              .optional()
              .describe(
                'On-site routine releases to surface water in pounds, summed across all reported outfalls for this submission. Only with include_release_breakdown.',
              ),
            releasesToLandInLbs: z
              .number()
              .optional()
              .describe(
                'On-site routine land releases in pounds — landfills, land treatment, surface impoundment, and other on-site disposal, summed for this submission. Only with include_release_breakdown.',
              ),
            releasesToUndergroundInjectionInLbs: z
              .number()
              .optional()
              .describe(
                'On-site routine releases via underground injection wells in pounds, summed across injection well classes for this submission. Only with include_release_breakdown.',
              ),
          })
          .describe('TRI release record for a facility-chemical-year combination'),
      )
      .describe('TRI release records for facilities in the queried state and filters'),
    state: z.string().describe('State queried'),
    message: z
      .string()
      .optional()
      .describe('Recovery hint when no releases are found. Absent when releases are returned.'),
  }),

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when the result list was capped at the limit — more records may exist. Absent below the limit.',
      ),
    shown: z
      .number()
      .optional()
      .describe('Number of release records returned. Present only when truncated.'),
    cap: z.number().optional().describe('The limit that was applied. Present only when truncated.'),
  },

  errors: [
    {
      reason: 'no_releases_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No TRI records found for the given state and filters.',
      recovery:
        'Verify the state abbreviation is valid. TRI data lags 18 months — try removing the year filter or using an earlier year.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('epa_search_tri_releases', {
      state: input.state,
      year: input.year,
      county: input.county,
      includeReleaseBreakdown: input.include_release_breakdown,
    });

    // TRI stores bare county names ("KING", never "KING COUNTY"), so a suffixed input would match nothing.
    const county = input.county
      ?.trim()
      .replace(/\s+(county|parish|borough)$/i, '')
      .toUpperCase();
    const chemicalName = input.chemical_name?.trim();
    const releases = await getDmapService().searchTriReleases(
      {
        state: input.state.trim().toUpperCase(),
        ...(county && { county }),
        ...(input.year !== undefined && { year: input.year }),
        ...(chemicalName && { chemicalName }),
        limit: input.limit,
        includeReleaseBreakdown: input.include_release_breakdown,
      },
      ctx,
    );

    ctx.log.info('epa_search_tri_releases completed', { count: releases.length });

    if (releases.length === 0) {
      const yearNote = input.year ? ` for year ${input.year}` : '';
      const countyNote = county ? ` in ${county} county` : '';
      const chemNote = input.chemical_name ? ` for chemical "${input.chemical_name}"` : '';
      return {
        releases: [],
        state: input.state,
        message: `No TRI releases found in ${input.state}${countyNote}${yearNote}${chemNote}. TRI data lags ~18 months — try year ${new Date().getFullYear() - 2} or removing filters.`,
      };
    }

    if (releases.length >= input.limit) {
      ctx.enrich.truncated({ shown: releases.length, cap: input.limit });
    }

    return { releases, state: input.state };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## TRI Releases — ${result.state}`);
    lines.push(`**Records:** ${result.releases.length}`);
    if (result.message) lines.push(`\n> ${result.message}`);

    for (const r of result.releases) {
      const facilityLabel = r.facilityName ? `${r.facilityName} (${r.facilityId})` : r.facilityId;
      lines.push(`\n### ${r.chemicalName} — ${facilityLabel} (${r.reportingYear})`);
      if (r.countyName) lines.push(`**County:** ${r.countyName}`);
      lines.push(...formatTriReleaseLines(r));
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
