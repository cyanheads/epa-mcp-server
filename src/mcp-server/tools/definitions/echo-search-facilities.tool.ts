/**
 * @fileoverview Tool for searching EPA-regulated facilities by location, county, facility name,
 * NAICS code, program, or compliance status, one page at a time.
 * @module mcp-server/tools/definitions/echo-search-facilities.tool
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
import { dollars } from '@/mcp-server/tools/format-dollars.js';
import { formatHeading } from '@/mcp-server/tools/format-heading.js';
import { formatLbs } from '@/mcp-server/tools/format-lbs.js';
import { formatLocationLines } from '@/mcp-server/tools/format-location.js';
import { formatNotice } from '@/mcp-server/tools/format-notice.js';
import {
  normalizeStateCode,
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
} from '@/mcp-server/tools/paging.js';
import { bareCountyName } from '@/services/county-name.js';
import { getEchoService } from '@/services/echo/echo-service.js';

/** Default and most facilities one call returns; a full page of 100 measures about 60 KB. */
const SEARCH_PAGE = { defaultLimit: 50, cap: 100 } as const;

/*
 * Advertised patterns accept every form the handler answers: surrounding whitespace is trimmed and
 * a blank value reads as omitted. Each is linear: no two adjacent quantified parts match the same
 * character.
 */
const COUNTY_FIPS_PATTERN = /^\s*(?:\d{5}\s*)?$/;
const NAICS_PATTERN = /^\s*(?:\d{2,6}\s*)?$/;
const NO_COMMA_PATTERN = /^[^,]*$/;

export const echoSearchFacilitiesTool = tool('epa_echo_search_facilities', {
  title: 'Search EPA Facilities',
  description:
    'ECHO: Search EPA-regulated facilities by location, county, facility name, NAICS industry code, environmental program, or compliance status across CAA, CWA, RCRA, TRI, and SDWA. Returns facility name, EPA Registry ID, coordinates, county FIPS code, per-program registration flags, TRI facility IDs, five-year inspection and penalty totals, and TRI release totals. Registry IDs returned here feed epa_echo_get_facility; TRI facility IDs feed epa_tri_get_facility_releases. Supports proximity search via latitude + longitude + radius_miles. At least one geographic filter (zip_code, state, city, county_fips, or a complete latitude+longitude+radius_miles triple) is required — unscoped searches time out. Page past limit with offset and nextOffset.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    zip_code: optionalZipSchema(
      '5-digit ZIP code to search within; a ZIP+4 such as "98108-1234" searches its first five digits',
    ),
    state: optionalStateSchema(
      '2-letter state or territory code (e.g. "WA", "PR"), case-insensitive. Required with county. ECHO also files facilities under codes outside the USPS set, such as DM for offshore Gulf of Mexico platforms; any 2-character code is searched as written.',
    ),
    city: z
      .string()
      .optional()
      .describe(
        'City name, case-insensitive; matches cities that begin with it ("TACOMA", or "SEAT" for SEATTLE and SEATAC). Pair with state.',
      ),
    county: z
      .string()
      .optional()
      .describe(
        'County name, case-insensitive. A trailing County, Parish, Borough, City and Borough, Census Area, or Municipality is dropped ("King County" searches KING), then it matches recorded county names that begin with it, so KING in VA also matches KING GEORGE. Requires state. Covers every registration ECHO places in the county, including ones with no program record that county_fips leaves out.',
      ),
    county_fips: z
      .string()
      .regex(COUNTY_FIPS_PATTERN, 'Expected a 5-digit county FIPS code such as "53033".')
      .optional()
      .describe(
        '5-digit county FIPS code, state + county (e.g. "53033" for King County, WA); matches it exactly and scopes a search on its own. Leaves out registrations with no program record, which county includes.',
      ),
    facility_name: z
      .string()
      .regex(
        NO_COMMA_PATTERN,
        'facility_name cannot contain a comma: ECHO reads a comma as a list separator.',
      )
      .optional()
      .describe(
        'Facility name words, case-insensitive: every word must appear as a whole word, in any order, in a name ECHO records for the facility, so "BOEING" matches BOEING PLANT 2 and "OEING" matches nothing. A match can come from another name ECHO records for the facility, so a returned name can lack the words. No commas. Pair with a geographic filter.',
      ),
    naics: z
      .string()
      .regex(NAICS_PATTERN, 'Expected a NAICS code of 2 to 6 digits, such as "3364" or "336411".')
      .optional()
      .describe(
        'NAICS industry code, 2–6 digits; fewer than six match every code that begins with them ("3364" for aerospace product and parts manufacturing). Pair with a geographic filter.',
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
    limit: limitSchema({ ...SEARCH_PAGE, noun: 'facilities' }),
    offset: offsetSchema('facilities'),
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
                    'Has a Toxics Release Inventory (TRI) facility ID (triFacilityIds is non-empty), whether or not it reported in the latest year',
                  ),
                sdwa: z
                  .boolean()
                  .describe('Has a Safe Drinking Water Act (SDWA) public water system record'),
              })
              .describe(
                'Program registration flags — the same programs the programs filter selects',
              ),
            triFacilityIds: z
              .array(z.string())
              .describe(
                "15-character TRI facility IDs ECHO records for this facility, in ECHO's order, which is not reporting-year order — pass one as facility_id to epa_tri_get_facility_releases for per-chemical releases. A site can carry several from successive operators. Empty when the facility has no TRI facility ID.",
              ),
            triReleasesTransfersInLbs: z
              .number()
              .optional()
              .describe(
                "Total TRI on/off-site releases and transfers in pounds for ECHO's latest TRI year (summary). For the per-chemical breakdown, pass one of triFacilityIds to epa_tri_get_facility_releases — the Registry ID is not a TRI facility ID.",
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
      .describe(
        "One page of matching EPA facilities, in ECHO's order: limit facilities from offset",
      ),
    totalCount: z.number().describe('Facilities matched before limit and offset were applied'),
    message: z
      .string()
      .optional()
      .describe(
        'Recovery hint when the page is empty: no facility matched, or offset is past the last match. Absent when facilities are returned.',
      ),
  }),

  enrichment: {
    ...effectiveQueryEnrichment,
    ...pagingEnrichment,
    notice: z
      .string()
      .optional()
      .describe('Present when more facilities follow: names the offset that continues the list.'),
  },
  enrichmentTrailer: {
    ...pagingTrailer,
    notice: { render: formatNotice },
  },

  errors: [
    {
      reason: 'no_geographic_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No geographic filter (zip_code, state, city, county_fips, or a latitude+longitude+radius_miles triple) was provided.',
      recovery:
        'Provide at least one of zip_code, state, city, or county_fips, or a complete latitude + longitude + radius_miles triple, to scope the search.',
    },
    {
      reason: 'incomplete_proximity',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A proximity search was started but latitude, longitude, and radius_miles were not all provided.',
      recovery:
        'Proximity search needs all three of latitude, longitude, and radius_miles. Provide the missing value, or use zip_code / state / city instead.',
    },
    {
      reason: 'county_requires_state',
      code: JsonRpcErrorCode.ValidationError,
      when: 'county was provided without state.',
      recovery:
        'Add state with county, since county names repeat across states, or pass county_fips, which names one county on its own.',
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

    // A blank optional value reads as omitted.
    const state = normalizeStateCode(input.state);
    const zipCode = normalizeZip(input.zip_code);
    const city = input.city?.trim() || undefined;
    const county = input.county?.trim() ? bareCountyName(input.county) : undefined;
    const countyFips = input.county_fips?.trim() || undefined;
    const facilityName = input.facility_name?.trim() || undefined;
    const naics = input.naics?.trim() || undefined;
    const program = input.programs?.[0];

    if (county && !state) {
      throw ctx.fail('county_requires_state', `county "${county}" needs state.`);
    }
    if (!zipCode && !state && !city && !countyFips && !hasProximity) {
      throw ctx.fail(
        'no_geographic_filter',
        'At least one geographic filter (zip_code, state, city, county_fips, or a latitude+longitude+radius_miles triple) is required.',
      );
    }

    const { limit, notice: limitNotice } = clampLimit(input.limit, SEARCH_PAGE.cap);
    if (limitNotice) ctx.enrich({ limitNotice });

    ctx.log.info('epa_echo_search_facilities', {
      zip: zipCode,
      state,
      city,
      county,
      countyFips,
      naics,
      ...(hasProximity && { latitude, longitude, radiusMiles }),
      programs: input.programs,
      limit,
      offset: input.offset,
    });
    const page = await getEchoService().searchFacilities(
      {
        ...(zipCode && { zipCode }),
        ...(state && { state }),
        ...(city && { city }),
        ...(county && { county }),
        ...(countyFips && { countyFips }),
        ...(facilityName && { facilityName }),
        ...(naics && { naics }),
        ...(latitude !== undefined && { latitude }),
        ...(longitude !== undefined && { longitude }),
        ...(radiusMiles !== undefined && { radiusMiles }),
        ...(input.active_only && { activeOnly: input.active_only }),
        ...(program && { program }),
        ...(input.has_violation && { hasViolation: input.has_violation }),
        limit,
        offset: input.offset,
      },
      ctx,
    );

    echoQuery(ctx, [
      zipCode && equalsTerm('zip_code', zipCode),
      state && equalsTerm('state', state),
      city && beginsWithTerm('city', city),
      county && beginsWithTerm('county', county),
      countyFips && equalsTerm('county_fips', countyFips),
      facilityName && `facility_name has words ${facilityName}`,
      naics && beginsWithTerm('naics', naics),
      latitude !== undefined && equalsTerm('latitude', latitude),
      longitude !== undefined && equalsTerm('longitude', longitude),
      radiusMiles !== undefined && equalsTerm('radius_miles', radiusMiles),
      input.active_only && equalsTerm('active_only', true),
      program && equalsTerm('programs', program),
      input.has_violation && equalsTerm('has_violation', true),
    ]);
    if (page.nextOffset !== undefined) {
      ctx.enrich({ nextOffset: page.nextOffset });
      ctx.enrich.notice(continueGuidance(page.nextOffset));
    }

    ctx.log.info('epa_echo_search_facilities completed', {
      count: page.items.length,
      totalCount: page.totalCount,
    });

    if (page.items.length === 0) {
      return {
        facilities: [],
        totalCount: page.totalCount,
        message:
          page.totalCount === 0
            ? 'No facilities matched. Try broadening the geographic area or removing the name, NAICS, program, or violation filters.'
            : `offset ${input.offset} is past the last of the ${page.totalCount} matching facilities; call again with a smaller offset.`,
      };
    }

    return { facilities: page.items, totalCount: page.totalCount };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## EPA Facility Search Results`);
    lines.push(`**Total Found:** ${result.totalCount} | **Returned:** ${result.facilities.length}`);
    if (result.message) lines.push(`\n> ${escapeMarkdownInline(result.message)}`);

    for (const f of result.facilities) {
      lines.push(`\n### ${formatHeading(f.name)}`);
      lines.push(`**Registry ID:** ${escapeMarkdownInline(f.registryId)}`);
      lines.push(...formatLocationLines(f));
      if (f.complianceStatus)
        lines.push(`**Compliance Status:** ${escapeMarkdownInline(f.complianceStatus)}`);

      const activePrograms = Object.entries(f.programs)
        .filter(([, v]) => v)
        .map(([k]) => k.toUpperCase())
        .join(', ');
      if (activePrograms) lines.push(`**Programs:** ${activePrograms}`);

      if (f.triFacilityIds.length > 0) {
        lines.push(`**TRI Facility IDs:** ${escapeMarkdownInline(f.triFacilityIds.join(', '))}`);
      }
      if (f.triReleasesTransfersInLbs !== undefined) {
        lines.push(`**TRI Releases+Transfers:** ${formatLbs(f.triReleasesTransfersInLbs)}`);
      }
      if (f.inspectionCount !== undefined) lines.push(`**Inspections:** ${f.inspectionCount}`);
      if (f.totalPenaltiesInDollars !== undefined) {
        lines.push(`**Total Penalties:** ${dollars(f.totalPenaltiesInDollars)}`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
