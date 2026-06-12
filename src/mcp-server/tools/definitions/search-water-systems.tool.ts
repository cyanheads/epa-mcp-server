/**
 * @fileoverview Tool for searching drinking water systems (SDWIS) by state or ZIP code.
 * @module mcp-server/tools/definitions/search-water-systems.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getDmapService } from '@/services/dmap/dmap-service.js';

export const searchWaterSystemsTool = tool('epa_search_water_systems', {
  title: 'Search Drinking Water Systems',
  description:
    'Search drinking water systems (SDWIS) by state or ZIP code. Returns system name, PWSID, population served, primary water source, and active violation status. Use to identify community water systems with current or recent compliance violations. At least one of state or zip_code is required.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    state: z.string().optional().describe('2-letter US state abbreviation (e.g. "WA", "CA")'),
    zip_code: z.string().optional().describe('5-digit ZIP code to search within'),
    has_violation: z
      .boolean()
      .optional()
      .describe('When true, return only systems with active violations'),
    pws_type: z
      .enum(['community', 'non-transient', 'transient'])
      .optional()
      .describe(
        'Filter by public water system type: community=permanent residences, non-transient=regular non-residents (schools, businesses), transient=occasional users (campgrounds)',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe('Maximum number of systems to return (1–200)'),
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
              .describe('2-letter state abbreviation (primacy agency code)'),
            city: z.string().optional().describe('City served by this water system'),
            zip: z.string().optional().describe('ZIP code'),
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
              .describe('Whether this system has an active compliance violation on record'),
            isActive: z
              .boolean()
              .optional()
              .describe('Whether this water system is currently active'),
          })
          .describe(
            'Public water system record with PWSID, population served, and violation status',
          ),
      )
      .describe('Matching public water systems'),
    totalCount: z.number().describe('Number of systems returned'),
    message: z
      .string()
      .optional()
      .describe('Recovery hint when no systems are found. Absent when systems are returned.'),
  }),

  errors: [
    {
      reason: 'no_geographic_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither state nor zip_code was provided.',
      recovery: 'Provide at least one of state or zip_code to search drinking water systems.',
    },
  ],

  async handler(input, ctx) {
    if (!input.state?.trim() && !input.zip_code?.trim()) {
      throw ctx.fail('no_geographic_filter', 'At least one of state or zip_code is required.', {
        ...ctx.recoveryFor('no_geographic_filter'),
      });
    }

    ctx.log.info('epa_search_water_systems', {
      state: input.state,
      zip: input.zip_code,
      hasViolation: input.has_violation,
      type: input.pws_type,
    });

    const state = input.state?.trim();
    const zipCode = input.zip_code?.trim();
    const systems = await getDmapService().searchWaterSystems(
      {
        ...(state && { state }),
        ...(zipCode && { zipCode }),
        ...(input.has_violation && { hasViolation: input.has_violation }),
        ...(input.pws_type && { pwsType: input.pws_type }),
        limit: input.limit,
      },
      ctx,
    );

    ctx.log.info('epa_search_water_systems completed', { count: systems.length });

    if (systems.length === 0) {
      const parts: string[] = [];
      if (input.state) parts.push(`state="${input.state}"`);
      if (input.zip_code) parts.push(`zip_code="${input.zip_code}"`);
      if (input.has_violation) parts.push('has_violation=true');
      if (input.pws_type) parts.push(`pws_type="${input.pws_type}"`);
      return {
        systems: [],
        totalCount: 0,
        message: `No water systems found matching: ${parts.join(', ')}. Try removing the violation or type filter, or checking the state abbreviation.`,
      };
    }

    return { systems, totalCount: systems.length };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## Drinking Water Systems`);
    lines.push(`**Found:** ${result.totalCount}`);
    if (result.message) lines.push(`\n> ${result.message}`);

    for (const s of result.systems) {
      const violationFlag = s.hasViolation === true ? ' ⚠️ VIOLATION' : '';
      lines.push(`\n### ${s.name}${violationFlag}`);
      lines.push(`**PWSID:** ${s.pwsid}`);
      const location = [s.city, s.state, s.zip].filter(Boolean).join(', ');
      if (location) lines.push(`**Location:** ${location}`);
      if (s.type) lines.push(`**Type:** ${s.type}`);
      if (s.populationServed !== undefined)
        lines.push(`**Population Served:** ${s.populationServed.toLocaleString()}`);
      if (s.primarySourceCode) lines.push(`**Primary Source:** ${s.primarySourceCode}`);
      if (s.hasViolation !== undefined)
        lines.push(`**Active Violation:** ${s.hasViolation ? 'Yes' : 'No'}`);
      if (s.isActive !== undefined) lines.push(`**Active:** ${s.isActive ? 'Yes' : 'No'}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
