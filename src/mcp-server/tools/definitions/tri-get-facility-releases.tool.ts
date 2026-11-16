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
  normalizeChemicalId,
  normalizeTriFacilityId,
  triFacilityIdSchema,
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
import { getDmapService } from '@/services/dmap/dmap-service.js';

/**
 * Most filings one call returns: the always-on breakdown of a full page is one wave, three
 * side-by-side `doc_ctrl_num in` requests of 233 submissions (dmap-service BREAKDOWN_CONCURRENCY).
 */
const LOOKUP_CAP = 699;

export const triGetFacilityReleasesTool = tool('epa_tri_get_facility_releases', {
  title: 'Get TRI Chemical Releases for Facility',
  description:
    'TRI: Query Toxic Release Inventory annual chemical release data for a specific facility. Returns per-chemical release records with chemical name, TRI chemical ID and CAS number, reporting year, on-site releases by medium (air, water, land, underground injection) and their total, and the Form R one-time release quantity, newest reporting year first; page through them with offset and nextOffset. Quantities are in pounds; dioxin and dioxin-like compounds, which TRI has facilities report in grams, are converted and marked with reportedUnit. TRI data lags ~18 months — the most recent available year is typically 2 years prior to the current calendar year. facility_id is the 15-character TRI facility ID: take it from the facilityId field of epa_tri_search_releases, or from the triFacilityIds of epa_echo_get_facility for a facility you already hold a Registry ID for. A 12-digit EPA Registry ID is a different identifier and fails validation.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    facility_id: triFacilityIdSchema(
      '15-character TRI facility ID (e.g. "9867WSNRWD1981S") — the facilityId field returned by epa_tri_search_releases, or an entry of epa_echo_get_facility triFacilityIds. Case, surrounding whitespace, and end slashes are ignored; a 12-digit EPA Registry ID fails validation.',
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
    chemical_name: chemicalNameSchema,
    chemical_id: triChemicalIdSchema,
    limit: limitSchema({ cap: LOOKUP_CAP, defaultLimit: 25, noun: 'filings' }),
    offset: offsetSchema('filings'),
  }),

  output: z.object({
    releases: z
      .array(
        z
          .object({
            facilityId: z.string().describe('TRI facility ID'),
            ...triReleaseSchema.shape,
          })
          .describe('One chemical-year filing'),
      )
      .describe('Per-chemical annual filings'),
    facilityId: z.string().describe('ID queried, uppercased, without whitespace or slashes'),
    message: z.string().optional().describe('Recovery hint on an empty result; absent otherwise.'),
  }),

  enrichment: {
    ...pagingEnrichment,
    truncated: z
      .boolean()
      .optional()
      .describe('True when more filings may follow; absent on the last page.'),
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
        'Present when a punctuated chemical_name filter hit its read limit first, so more matches may exist.',
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
      when: 'chemical_name has no letter or digit.',
      recovery: 'Include a letter or digit in chemical_name, or remove it.',
      thrownBy: 'service',
    },
    {
      reason: 'filter_too_long',
      code: JsonRpcErrorCode.ValidationError,
      when: 'chemical_name makes the request too long.',
      recovery: 'Shorten chemical_name to a distinctive part of the name and retry.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const { limit, notice: limitNotice } = clampLimit(input.limit, LOOKUP_CAP, {
      tool: 'epa_tri_get_facility_releases',
    });
    if (limitNotice) ctx.enrich({ limitNotice });
    const facilityId = normalizeTriFacilityId(input.facility_id);
    ctx.log.info('epa_tri_get_facility_releases', {
      facilityId,
      year: input.year,
      offset: input.offset,
    });

    const chemicalName = input.chemical_name?.trim();
    const chemicalId = normalizeChemicalId(input.chemical_id);
    const page = await getDmapService().getTriReleases(
      {
        facilityId,
        ...(input.year !== undefined && { year: input.year }),
        ...(chemicalId && { chemicalId }),
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
          facilityId,
          message: `No TRI releases found for facility "${facilityId}" at offset ${input.offset}${pastEndSuffix(page.nextOffset, 'lookup', 'records')}`,
        };
      }
      const yearNote = input.year ? ` for year ${input.year}` : '';
      const chemNote = [
        input.chemical_name && ` matching chemical "${input.chemical_name}"`,
        chemicalId && ` with chemical ID ${chemicalId}`,
      ]
        .filter(Boolean)
        .join('');
      const hints = triEmptyResultHints({ year: input.year, chemicalName, chemicalId });
      hints.push(
        "Verify the facility ID with epa_tri_search_releases — facility_id is its 15-character facilityId, not a 12-digit EPA Registry ID; epa_echo_get_facility returns a Registry ID's TRI IDs as triFacilityIds.",
      );
      return {
        releases: [],
        facilityId,
        message: `No TRI releases found for facility "${facilityId}"${yearNote}${chemNote}. ${hints.join(' ')}`,
      };
    }

    return { releases, facilityId };
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
