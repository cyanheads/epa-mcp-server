/**
 * @fileoverview Tool for searching drinking water systems (SDWIS) by state, ZIP code, or county
 * served, optionally only those ECHO reports with a current SDWA violation.
 * @module mcp-server/tools/definitions/water-search-systems.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import {
  beginsWithTerm,
  echoQuery,
  effectiveQueryEnrichment,
  equalsTerm,
} from '@/mcp-server/tools/effective-query.js';
import { formatHeading } from '@/mcp-server/tools/format-heading.js';
import { formatNotice } from '@/mcp-server/tools/format-notice.js';
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
import { bareCountyName } from '@/services/county-name.js';
import { getDmapService } from '@/services/dmap/dmap-service.js';
import { getEchoService } from '@/services/echo/echo-service.js';

/** Most systems one call returns. */
const SEARCH_CAP = 200;

export const waterSearchSystemsTool = tool('epa_water_search_systems', {
  title: 'Search Drinking Water Systems',
  description:
    "Drinking water (SDWIS): Search public water systems by state, ZIP code, or county served. Returns system name, PWSID, population served, primary water source, and activity status, in PWSID order; page through a large match with offset and nextOffset. zip_code matches a system's address of record, often an owner's or operator's office far from the area it serves; county (with state) finds the systems serving an area. With has_violation, returns only systems with a current SDWA violation in EPA's ECHO, which applies EPA's Enforcement Response Policy, so it flags fewer systems than SDWIS's unresolved violation records. At least one of state or zip_code is required. Pass a returned pwsid as registry_id to epa_echo_get_facility for the system's drinking-water violations: contaminant, measured level, MCL, status, and enforcement actions.",
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    state: optionalStateSchema(
      '2-letter US state or territory code (e.g. "WA", "CA"), or an EPA region code 01–10 for tribal systems, whose primacy agency is the EPA region',
    ),
    zip_code: optionalZipSchema(
      "5-digit ZIP code of the water system's address of record — often its owner's or operator's office, which can be far from the area the system serves. Matches stored ZIP+4s within it; a ZIP+4 searches its 5-digit ZIP. Use county for the systems serving an area.",
    ),
    county: z
      .string()
      .max(4094)
      .optional()
      .describe(
        'County the system serves, e.g. "King"; requires state. Case-insensitive, and a trailing "County", "Parish", "Borough", "City and Borough", "Census Area", or "Municipality" is dropped, so "Anchorage" matches Anchorage Municipality. A system matches when one of the counties it serves is this county, so "Harris" does not match Harrison. Punctuation is matched as written ("St. Tammany").',
      ),
    has_violation: z
      .boolean()
      .optional()
      .describe(
        "When true, return only systems with a current SDWA violation in EPA's ECHO, its compliance status for the system, which clears violations SDWIS still lists as unresolved. Works with state, zip_code, county, or a combination.",
      ),
    pws_type: z
      .enum(['community', 'non-transient', 'transient'])
      .optional()
      .describe(
        'Filter by public water system type: community=permanent residences, non-transient=regular non-residents (schools, businesses), transient=occasional users (campgrounds)',
      ),
    active_only: z
      .boolean()
      .default(false)
      .describe(
        'When true, return only systems SDWIS lists as active (activity code A). The default false also returns inactive systems and ones changed to non-public.',
      ),
    limit: limitSchema({ cap: SEARCH_CAP, defaultLimit: 50, noun: 'systems' }),
    offset: offsetSchema('systems'),
  }),

  output: z.object({
    systems: z
      .array(
        z
          .object({
            pwsid: z.string().describe('Public Water System ID (PWSID) — unique system identifier'),
            name: z.string().describe('Water system name'),
            state: z
              .string()
              .optional()
              .describe(
                'Primacy agency code: a 2-letter state abbreviation, or the EPA region code 01–10 of a tribal system',
              ),
            city: z
              .string()
              .optional()
              .describe(
                "City of the water system's address of record — often its owner's or operator's office, not necessarily the area it serves",
              ),
            zip: z
              .string()
              .optional()
              .describe(
                "ZIP code of the water system's address of record (the value zip_code matches)",
              ),
            type: z
              .string()
              .optional()
              .describe(
                'PWS type code: CWS=Community, NTNCWS=Non-transient non-community, TNCWS=Transient non-community',
              ),
            populationServed: z
              .number()
              .optional()
              .describe('Estimated population served by this water system'),
            primarySourceCode: z
              .string()
              .optional()
              .describe('Primary water source code (e.g. GW=groundwater, SW=surface water)'),
            hasViolation: z
              .boolean()
              .optional()
              .describe(
                'True when ECHO reports a current SDWA violation for this system. Present only on has_violation searches, which return only such systems.',
              ),
            isActive: z
              .boolean()
              .optional()
              .describe('Whether this water system is currently active'),
          })
          .describe(
            'Public water system record with PWSID, population served, and violation status',
          ),
      )
      .describe('Matching public water systems, in PWSID order'),
    totalCount: z
      .number()
      .optional()
      .describe(
        "Systems matched before limit and offset. Present when the call saw the whole match: a search from offset 0 with no nextOffset, or a state has_violation search that checked ECHO's whole violator list. Absent otherwise, since EPA's DMAP service reports no match count (follow nextOffset instead).",
      ),
    message: z
      .string()
      .optional()
      .describe('Recovery hint when no systems are found. Absent when systems are returned.'),
  }),

  enrichment: {
    ...effectiveQueryEnrichment,
    ...pagingEnrichment,
    guidance: z
      .string()
      .optional()
      .describe('Present when more systems may follow: the offset that continues the search.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Present when a check ended before the page filled: a ZIP or county has_violation check read its 1,000-system limit, or the county check reached its read limit with few whole-name matches. nextOffset continues from where it stopped.',
      ),
  },
  enrichmentTrailer: {
    ...pagingTrailer,
    guidance: { render: formatNotice },
    notice: { render: formatNotice },
  },

  errors: [
    {
      reason: 'no_geographic_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither state nor zip_code was provided.',
      recovery: 'Provide at least one of state or zip_code to search drinking water systems.',
    },
    {
      reason: 'county_requires_state',
      code: JsonRpcErrorCode.ValidationError,
      when: 'county was provided without state.',
      recovery:
        'Add state, the 2-letter code of the state the county is in, e.g. state "WA" with county "King".',
    },
    invalidStateError,
    {
      reason: 'unmatchable_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: "county has no letter or digit for EPA's DMAP service to match on.",
      recovery: 'Include a letter or digit in county, or search by state or zip_code alone.',
      thrownBy: 'service',
    },
    {
      reason: 'filter_too_long',
      code: JsonRpcErrorCode.ValidationError,
      when: "county makes a request longer than EPA's DMAP service accepts.",
      recovery: "Shorten county to the county's name alone and retry.",
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const state = normalizeState(input.state);
    const zipCode = normalizeZip(input.zip_code);
    const county = input.county?.trim() ? bareCountyName(input.county) : undefined;
    if (county && !state) {
      throw ctx.fail(
        'county_requires_state',
        "county requires state: add state, the 2-letter code of the county's state.",
      );
    }
    if (!state && !zipCode) {
      throw ctx.fail('no_geographic_filter', 'At least one of state or zip_code is required.');
    }
    const { limit, notice: limitNotice } = clampLimit(input.limit, SEARCH_CAP);
    if (limitNotice) ctx.enrich({ limitNotice });

    ctx.log.info('epa_water_search_systems', {
      state,
      zip: zipCode,
      county,
      hasViolation: input.has_violation,
      type: input.pws_type,
      activeOnly: input.active_only,
      offset: input.offset,
    });

    const page = await getDmapService().searchWaterSystems(
      {
        ...(state && { state }),
        ...(zipCode && { zipCode }),
        ...(county && { county }),
        ...(input.pws_type && { pwsType: input.pws_type }),
        ...(input.active_only && { activeOnly: true }),
        ...(input.has_violation && {
          currentViolators: (scope, budget) =>
            getEchoService().findCurrentSdwViolators(scope, ctx, budget),
        }),
        offset: input.offset,
        limit,
      },
      ctx,
    );
    const systems = page.items;

    ctx.log.info('epa_water_search_systems completed', { count: systems.length });
    echoQuery(ctx, [
      state && equalsTerm('state', state),
      zipCode && beginsWithTerm('zip_code', zipCode),
      county && equalsTerm('county', county),
      input.pws_type && equalsTerm('pws_type', input.pws_type),
      input.active_only && equalsTerm('active_only', true),
      input.has_violation && equalsTerm('has_violation', 'true, current SDWA violation per ECHO'),
    ]);
    if (page.nextOffset !== undefined) {
      ctx.enrich({ nextOffset: page.nextOffset, guidance: continueGuidance(page.nextOffset) });
    }
    const matched = page.totalCount !== undefined && { totalCount: page.totalCount };

    if (systems.length === 0) {
      if (input.offset > 0) {
        return {
          systems: [],
          ...matched,
          message: `No water systems found at offset ${input.offset}${pastEndSuffix(page.nextOffset, 'search', 'systems')}`,
        };
      }
      const hints: string[] = [];
      if (input.has_violation) {
        hints.push('Remove has_violation to include systems without a current violation.');
      }
      if (county) hints.push("Check the county's spelling, or remove county to search the state.");
      if (zipCode) {
        hints.push(
          "zip_code matches a system's address of record, not the area it serves; try county with state.",
        );
      }
      if (input.active_only) hints.push('Remove active_only to include inactive systems.');
      if (input.pws_type) hints.push('Remove pws_type to include every system type.');
      if (state) {
        hints.push(
          'Check the state code: tribal systems file under their EPA region code (01–10), not the state they sit in.',
        );
      }
      return { systems: [], ...matched, message: `No water systems found. ${hints.join(' ')}` };
    }

    return { systems, ...matched };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## Drinking Water Systems`);
    lines.push(
      result.totalCount === undefined
        ? `**Returned:** ${result.systems.length}`
        : `**Total Found:** ${result.totalCount} | **Returned:** ${result.systems.length}`,
    );
    if (result.message) lines.push(`\n> ${escapeMarkdownInline(result.message)}`);

    for (const s of result.systems) {
      const violationFlag = s.hasViolation === true ? ' ⚠️ CURRENT VIOLATION' : '';
      lines.push(`\n### ${formatHeading(s.name)}${violationFlag}`);
      lines.push(`**PWSID:** ${escapeMarkdownInline(s.pwsid)}`);
      const location = [s.city, s.state, s.zip].filter(Boolean).join(', ');
      if (location) lines.push(`**Location:** ${escapeMarkdownInline(location)}`);
      if (s.type) lines.push(`**Type:** ${escapeMarkdownInline(s.type)}`);
      if (s.populationServed !== undefined)
        lines.push(`**Population Served:** ${s.populationServed.toLocaleString()}`);
      if (s.primarySourceCode)
        lines.push(`**Primary Source:** ${escapeMarkdownInline(s.primarySourceCode)}`);
      if (s.hasViolation !== undefined)
        lines.push(`**Current Violation:** ${s.hasViolation ? 'Yes' : 'No'}`);
      if (s.isActive !== undefined) lines.push(`**Active:** ${s.isActive ? 'Yes' : 'No'}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
