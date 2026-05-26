/**
 * @fileoverview Tool for querying TRI annual chemical release data for a specific facility.
 * @module mcp-server/tools/definitions/get-tri-releases.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getDmapService } from '@/services/dmap/dmap-service.js';

export const getTriReleasesTool = tool('epa_get_tri_releases', {
  title: 'Get TRI Chemical Releases for Facility',
  description:
    'Query Toxic Release Inventory annual chemical release data for a specific facility. Returns per-chemical release records with chemical name, total release quantity, and reporting year. TRI data lags ~18 months — the most recent available year is typically 2 years prior to the current calendar year. Obtain facility_id (TRI facility ID) from epa_search_facilities. Use epa_search_tri_releases to identify top emitters across a region.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    facility_id: z
      .string()
      .min(1)
      .describe('TRI facility ID (from the RegistryID field returned by epa_search_facilities)'),
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
            totalReleasesInLbs: z
              .number()
              .optional()
              .describe('One-time release quantity in pounds (from tri_reporting_form)'),
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
        'Verify the facility ID via epa_search_facilities. TRI data lags 18 months — try an earlier year.',
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
        message: `No TRI releases found for facility "${input.facility_id}"${yearNote}${chemNote}. TRI data lags ~18 months — try year ${new Date().getFullYear() - 2} or earlier. Verify the facility ID with epa_search_facilities.`,
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
      if (r.totalReleasesInLbs !== undefined)
        lines.push(`**Release Quantity:** ${r.totalReleasesInLbs.toLocaleString()} lbs`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
