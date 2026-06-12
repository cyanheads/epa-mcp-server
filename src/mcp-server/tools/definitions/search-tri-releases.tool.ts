/**
 * @fileoverview Tool for searching TRI release data across facilities in a state or county.
 * @module mcp-server/tools/definitions/search-tri-releases.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getDmapService } from '@/services/dmap/dmap-service.js';

export const searchTriReleasesTool = tool('epa_search_tri_releases', {
  title: 'Search TRI Releases by Region',
  description:
    'Search Toxic Release Inventory data across facilities in a state or county for a given reporting year. Returns facility name, TRI ID, chemical name, and release quantity. Use to identify top polluters in an area or build an environmental exposure profile. Use epa_get_tri_releases for detailed release records for a single facility. TRI data lags ~18 months from the current calendar year.',
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
      .describe('County name to narrow results within the state (partial match)'),
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
  }),

  output: z.object({
    releases: z
      .array(
        z
          .object({
            facilityId: z.string().describe('TRI facility identifier'),
            facilityName: z.string().optional().describe('Facility name'),
            chemicalName: z.string().describe('Chemical name as reported to TRI'),
            reportingYear: z.number().describe('Year of the TRI submission'),
            totalReleasesInLbs: z
              .number()
              .optional()
              .describe('One-time release quantity in pounds (from tri_reporting_form)'),
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
      .describe('True when the result list was capped at the limit — more records may exist.'),
    shown: z.number().describe('Number of release records returned.'),
    cap: z.number().describe('The limit that was applied.'),
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
    });

    const county = input.county?.trim();
    const chemicalName = input.chemical_name?.trim();
    const releases = await getDmapService().searchTriReleases(
      {
        state: input.state.trim().toUpperCase(),
        ...(county && { county }),
        ...(input.year !== undefined && { year: input.year }),
        ...(chemicalName && { chemicalName }),
        limit: input.limit,
      },
      ctx,
    );

    ctx.log.info('epa_search_tri_releases completed', { count: releases.length });

    if (releases.length === 0) {
      const yearNote = input.year ? ` for year ${input.year}` : '';
      const countyNote = input.county ? ` in ${input.county} county` : '';
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
      if (r.totalReleasesInLbs !== undefined)
        lines.push(`**Release Quantity:** ${r.totalReleasesInLbs.toLocaleString()} lbs`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
