/**
 * @fileoverview Tool for searching EPA-regulated facilities by location, industry, or compliance status.
 * @module mcp-server/tools/definitions/search-facilities.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEchoService } from '@/services/echo/echo-service.js';

export const searchFacilitiesTool = tool('epa_search_facilities', {
  title: 'Search EPA Facilities',
  description:
    'Search EPA-regulated facilities by location, industry program, or compliance status across all environmental programs (CAA, CWA, RCRA, TRI, SDWA). Returns facility name, EPA Registry ID, coordinates, county FIPS code, per-program registration flags, inspection counts, penalty totals, and TRI release totals. Registry IDs returned here feed epa_get_facility and epa_get_tri_releases. At least one geographic filter (zip_code, state, or city+state) is required — unscoped searches time out.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    zip_code: z.string().optional().describe('5-digit ZIP code to search within'),
    state: z.string().optional().describe('2-letter US state abbreviation (e.g. "WA", "CA")'),
    city: z.string().optional().describe('City name. Pair with state for best results.'),
    active_only: z.boolean().optional().describe('When true, return only active facilities'),
    programs: z
      .array(z.enum(['CAA', 'CWA', 'RCRA', 'TRI', 'SDWA']))
      .optional()
      .describe(
        'Restrict results to facilities registered in these environmental programs. CAA=air, CWA=water, RCRA=waste, TRI=toxic releases, SDWA=drinking water.',
      ),
    has_violation: z
      .boolean()
      .optional()
      .describe('When true, return only facilities with recent significant violations'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50)
      .describe('Maximum number of facilities to return (1–100)'),
  }),

  output: z.object({
    facilities: z
      .array(
        z
          .object({
            registryId: z
              .string()
              .describe(
                'EPA FRS Registry ID — use as input to epa_get_facility and epa_get_tri_releases',
              ),
            name: z.string().describe('Facility name'),
            street: z.string().optional().describe('Street address'),
            city: z.string().optional().describe('City'),
            state: z.string().optional().describe('2-letter state abbreviation'),
            zip: z.string().optional().describe('ZIP code'),
            county: z.string().optional().describe('County name'),
            fipsCode: z
              .string()
              .optional()
              .describe('5-digit county FIPS code — use with Census API for demographics'),
            latitude: z.number().optional().describe('Latitude in decimal degrees'),
            longitude: z.number().optional().describe('Longitude in decimal degrees'),
            complianceStatus: z
              .string()
              .optional()
              .describe('Overall compliance status text from ECHO'),
            programs: z
              .object({
                air: z.boolean().describe('Registered under Clean Air Act (CAA)'),
                water: z.boolean().describe('Registered under Clean Water Act (CWA)'),
                rcra: z
                  .boolean()
                  .describe('Registered under Resource Conservation and Recovery Act (RCRA)'),
                tri: z.boolean().describe('Participates in Toxic Release Inventory (TRI)'),
                sdwa: z.boolean().describe('Regulated under Safe Drinking Water Act (SDWA)'),
              })
              .describe('Program registration flags'),
            triReleasesTransfersInLbs: z
              .number()
              .optional()
              .describe(
                'Total TRI on/off-site releases and transfers in pounds (summary). Use epa_get_tri_releases for per-chemical breakdown.',
              ),
            inspectionCount: z.number().optional().describe('Number of EPA inspections on record'),
            totalPenaltiesInDollars: z
              .number()
              .optional()
              .describe('Total assessed penalties in dollars across all programs'),
          })
          .describe(
            'EPA facility record with Registry ID, location, program flags, and compliance summary',
          ),
      )
      .describe('Matching EPA facilities'),
    totalCount: z.number().describe('Total facilities matched before the limit was applied'),
    message: z
      .string()
      .optional()
      .describe(
        'Recovery hint when no results are found — echoes applied filters and suggests how to broaden the search. Absent when results are returned.',
      ),
  }),

  errors: [
    {
      reason: 'no_geographic_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No geographic filter (zip_code, state, or city) was provided.',
      recovery: 'Provide at least one of zip_code, state, or city to scope the search.',
    },
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'No facilities matched the search criteria.',
      recovery: 'Broaden the search by removing filters or expanding the geographic area.',
    },
  ],

  async handler(input, ctx) {
    // Enforce geographic scoping requirement
    if (!input.zip_code?.trim() && !input.state?.trim() && !input.city?.trim()) {
      throw ctx.fail(
        'no_geographic_filter',
        'At least one geographic filter (zip_code, state, or city) is required.',
        {
          ...ctx.recoveryFor('no_geographic_filter'),
        },
      );
    }

    ctx.log.info('epa_search_facilities', {
      zip: input.zip_code,
      state: input.state,
      city: input.city,
      programs: input.programs,
    });

    const zipCode = input.zip_code?.trim();
    const state = input.state?.trim();
    const city = input.city?.trim();
    const { facilities, totalCount } = await getEchoService().searchFacilities(
      {
        ...(zipCode && { zipCode }),
        ...(state && { state }),
        ...(city && { city }),
        ...(input.active_only && { activeOnly: input.active_only }),
        ...(input.programs?.length && { programs: input.programs }),
        ...(input.has_violation && { hasViolation: input.has_violation }),
        limit: input.limit,
      },
      ctx,
    );

    ctx.log.info('epa_search_facilities completed', { count: facilities.length, totalCount });

    if (facilities.length === 0) {
      const parts: string[] = [];
      if (input.zip_code) parts.push(`zip_code="${input.zip_code}"`);
      if (input.state) parts.push(`state="${input.state}"`);
      if (input.city) parts.push(`city="${input.city}"`);
      if (input.programs?.length) parts.push(`programs=[${input.programs.join(', ')}]`);
      if (input.has_violation) parts.push('has_violation=true');
      return {
        facilities: [],
        totalCount: 0,
        message: `No facilities matched: ${parts.join(', ')}. Try broadening the geographic area or removing program/violation filters.`,
      };
    }

    return { facilities, totalCount };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## EPA Facility Search Results`);
    lines.push(`**Total Found:** ${result.totalCount} | **Returned:** ${result.facilities.length}`);
    if (result.message) lines.push(`\n> ${result.message}`);

    for (const f of result.facilities) {
      lines.push(`\n### ${f.name}`);
      lines.push(`**Registry ID:** ${f.registryId}`);
      const location = [f.street, f.city, f.state, f.zip].filter(Boolean).join(', ');
      if (location) lines.push(`**Location:** ${location}`);
      if (f.county)
        lines.push(`**County:** ${f.county}${f.fipsCode ? ` (FIPS: ${f.fipsCode})` : ''}`);
      if (f.latitude !== undefined && f.longitude !== undefined) {
        lines.push(`**Coordinates:** ${f.latitude}, ${f.longitude}`);
      }
      if (f.complianceStatus) lines.push(`**Compliance Status:** ${f.complianceStatus}`);

      const activePrograms = Object.entries(f.programs)
        .filter(([, v]) => v)
        .map(([k]) => k.toUpperCase())
        .join(', ');
      if (activePrograms) lines.push(`**Programs:** ${activePrograms}`);

      if (f.triReleasesTransfersInLbs !== undefined) {
        lines.push(
          `**TRI Releases+Transfers:** ${f.triReleasesTransfersInLbs.toLocaleString()} lbs`,
        );
      }
      if (f.inspectionCount !== undefined) lines.push(`**Inspections:** ${f.inspectionCount}`);
      if (f.totalPenaltiesInDollars !== undefined) {
        lines.push(`**Total Penalties:** $${f.totalPenaltiesInDollars.toLocaleString()}`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
