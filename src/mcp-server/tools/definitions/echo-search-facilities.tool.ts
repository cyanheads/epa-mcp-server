/**
 * @fileoverview Tool for searching EPA-regulated facilities by location, industry, or compliance status.
 * @module mcp-server/tools/definitions/echo-search-facilities.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatLbs } from '@/mcp-server/tools/format-lbs.js';
import { formatLocationLines } from '@/mcp-server/tools/format-location.js';
import { getEchoService } from '@/services/echo/echo-service.js';

export const echoSearchFacilitiesTool = tool('epa_echo_search_facilities', {
  title: 'Search EPA Facilities',
  description:
    'ECHO: Search EPA-regulated facilities by location, environmental program, or compliance status across CAA, CWA, RCRA, TRI, and SDWA. Returns facility name, EPA Registry ID, coordinates, county FIPS code, per-program registration flags, five-year inspection and penalty totals, and TRI release totals. Registry IDs returned here feed epa_echo_get_facility. Supports proximity search via latitude + longitude + radius_miles. At least one geographic filter (zip_code, state, city, or a complete latitude+longitude+radius_miles triple) is required — unscoped searches time out.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    zip_code: z.string().optional().describe('5-digit ZIP code to search within'),
    state: z.string().optional().describe('2-letter US state abbreviation (e.g. "WA", "CA")'),
    city: z
      .string()
      .optional()
      .describe(
        'City name, case-insensitive; matches cities that begin with it ("TACOMA", or "SEAT" for SEATTLE and SEATAC). Pair with state.',
      ),
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe(
        'Latitude in decimal degrees. Pair with longitude and radius_miles for proximity search.',
      ),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .optional()
      .describe(
        'Longitude in decimal degrees. Pair with latitude and radius_miles for proximity search.',
      ),
    radius_miles: z
      .number()
      .positive()
      .max(100)
      .optional()
      .describe(
        'Search radius in miles around the given latitude/longitude (max 100). Requires latitude and longitude.',
      ),
    active_only: z
      .boolean()
      .optional()
      .describe('When true, return only facilities with an active permit'),
    programs: z
      .array(z.enum(['CAA', 'CWA', 'RCRA', 'TRI', 'SDWA']))
      .max(1)
      .optional()
      .describe(
        'Restrict results to facilities registered in one environmental program — ECHO filters on a single program per search, so pass one value. CAA=air, CWA=water, RCRA=hazardous waste, TRI=toxic releases, SDWA=drinking water.',
      ),
    has_violation: z
      .boolean()
      .optional()
      .describe(
        'When true, return only facilities with at least one program in significant noncompliance (complianceStatus "Significant Violation")',
      ),
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
              .describe('EPA FRS Registry ID — use as input to epa_echo_get_facility'),
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
                air: z
                  .boolean()
                  .describe('Has a Clean Air Act (CAA) stationary-source record in ICIS-Air'),
                water: z
                  .boolean()
                  .describe('Has a Clean Water Act (CWA) discharge permit record in ICIS-NPDES'),
                rcra: z.boolean().describe('Has an RCRA hazardous waste handler record'),
                tri: z
                  .boolean()
                  .describe(
                    'Has a Toxics Release Inventory (TRI) facility ID, whether or not it reported in the latest year',
                  ),
                sdwa: z
                  .boolean()
                  .describe('Has a Safe Drinking Water Act (SDWA) public water system record'),
              })
              .describe(
                'Program registration flags — the same programs the programs filter selects',
              ),
            triReleasesTransfersInLbs: z
              .number()
              .optional()
              .describe(
                "Total TRI on/off-site releases and transfers in pounds for ECHO's latest TRI year (summary). For the per-chemical breakdown, call epa_tri_get_facility_releases with the TRI facility ID that epa_tri_search_releases returns as facilityId — the Registry ID is not a TRI facility ID.",
              ),
            inspectionCount: z
              .number()
              .optional()
              .describe('Inspections over the last five years, across programs'),
            totalPenaltiesInDollars: z
              .number()
              .optional()
              .describe(
                'Penalties from formal enforcement actions over the last five years, across programs, in dollars',
              ),
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
      when: 'No geographic filter (zip_code, state, city, or a latitude+longitude+radius_miles triple) was provided.',
      recovery:
        'Provide at least one of zip_code, state, or city, or a complete latitude + longitude + radius_miles triple, to scope the search.',
    },
    {
      reason: 'incomplete_proximity',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A proximity search was started but latitude, longitude, and radius_miles were not all provided.',
      recovery:
        'Proximity search needs all three of latitude, longitude, and radius_miles. Provide the missing value, or use zip_code / state / city instead.',
    },
  ],

  async handler(input, ctx) {
    // Proximity search needs the full latitude/longitude/radius_miles triple.
    // Coordinates of 0 (equator / prime meridian) are valid, so test presence
    // with !== undefined, never a truthy check.
    const { latitude, longitude, radius_miles: radiusMiles } = input;
    const hasProximity =
      latitude !== undefined && longitude !== undefined && radiusMiles !== undefined;
    const anyProximity =
      latitude !== undefined || longitude !== undefined || radiusMiles !== undefined;
    if (anyProximity && !hasProximity) {
      throw ctx.fail(
        'incomplete_proximity',
        'Proximity search needs all three of latitude, longitude, and radius_miles.',
      );
    }

    // Enforce geographic scoping requirement
    const zipCode = input.zip_code?.trim();
    const state = input.state?.trim();
    const city = input.city?.trim();
    if (!zipCode && !state && !city && !hasProximity) {
      throw ctx.fail(
        'no_geographic_filter',
        'At least one geographic filter (zip_code, state, city, or a latitude+longitude+radius_miles triple) is required.',
      );
    }

    ctx.log.info('epa_echo_search_facilities', {
      zip: input.zip_code,
      state: input.state,
      city: input.city,
      ...(hasProximity && { latitude, longitude, radiusMiles }),
      programs: input.programs,
    });
    const { facilities, totalCount } = await getEchoService().searchFacilities(
      {
        ...(zipCode && { zipCode }),
        ...(state && { state }),
        ...(city && { city }),
        ...(latitude !== undefined && { latitude }),
        ...(longitude !== undefined && { longitude }),
        ...(radiusMiles !== undefined && { radiusMiles }),
        ...(input.active_only && { activeOnly: input.active_only }),
        ...(input.programs?.[0] && { program: input.programs[0] }),
        ...(input.has_violation && { hasViolation: input.has_violation }),
        limit: input.limit,
      },
      ctx,
    );

    ctx.log.info('epa_echo_search_facilities completed', { count: facilities.length, totalCount });

    if (facilities.length === 0) {
      const parts: string[] = [];
      if (input.zip_code) parts.push(`zip_code="${input.zip_code}"`);
      if (input.state) parts.push(`state="${input.state}"`);
      if (input.city) parts.push(`city="${input.city}"`);
      if (hasProximity) parts.push(`within ${radiusMiles} mi of (${latitude}, ${longitude})`);
      if (input.active_only) parts.push('active_only=true');
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
      lines.push(...formatLocationLines(f));
      if (f.complianceStatus) lines.push(`**Compliance Status:** ${f.complianceStatus}`);

      const activePrograms = Object.entries(f.programs)
        .filter(([, v]) => v)
        .map(([k]) => k.toUpperCase())
        .join(', ');
      if (activePrograms) lines.push(`**Programs:** ${activePrograms}`);

      if (f.triReleasesTransfersInLbs !== undefined) {
        lines.push(`**TRI Releases+Transfers:** ${formatLbs(f.triReleasesTransfersInLbs)}`);
      }
      if (f.inspectionCount !== undefined) lines.push(`**Inspections:** ${f.inspectionCount}`);
      if (f.totalPenaltiesInDollars !== undefined) {
        lines.push(`**Total Penalties:** $${f.totalPenaltiesInDollars.toLocaleString()}`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
