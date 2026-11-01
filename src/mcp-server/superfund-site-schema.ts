/**
 * @fileoverview Shared Superfund site output contract for search, detail, and resource records.
 * @module mcp-server/superfund-site-schema
 */
import { z } from '@cyanheads/mcp-ts-core';

/** Site metadata as reported by SEMS; assessment labels are not cleanup progress. */
export const superfundSiteSchema = z
  .object({
    siteId: z.string().describe('EPA SEMS site identifier'),
    name: z.string().describe('Superfund site name'),
    street: z.string().optional().describe('Street address'),
    city: z.string().optional().describe('City'),
    state: z.string().optional().describe('2-letter state abbreviation'),
    zip: z.string().optional().describe('ZIP code'),
    county: z.string().optional().describe('County name'),
    fipsCode: z.string().optional().describe('5-digit county FIPS code'),
    nplStatus: z
      .string()
      .optional()
      .describe(
        'Raw NPL code: F=final, A=part of an NPL site, N=not listed, P=proposed, D=deleted, R=removed, W=withdrawn',
      ),
    nplStatusName: z.string().optional().describe('NPL status label reported by SEMS'),
    nonNplStatusName: z
      .string()
      .optional()
      .describe('Non-NPL assessment label reported by SEMS; not cleanup progress'),
    archivedInd: z.string().optional().describe('Raw SEMS archive indicator, such as Y or N'),
    epaId: z.string().optional().describe('EPA site identifier distinct from the SEMS site ID'),
    federalFacilityInd: z
      .string()
      .optional()
      .describe('Raw SEMS federal facility indicator, such as Y or N'),
    latitude: z.number().optional().describe('Latitude in decimal degrees'),
    longitude: z.number().optional().describe('Longitude in decimal degrees'),
  })
  .describe('Superfund site record with source status and assessment metadata');
