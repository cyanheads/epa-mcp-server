/**
 * @fileoverview Shared Superfund site output contract for search, detail, and resource records.
 * @module mcp-server/superfund-site-schema
 */
import { z } from '@cyanheads/mcp-ts-core';

/** Site metadata as reported by SEMS; assessment labels are not cleanup progress. */
export const superfundSiteSchema = z
  .object({
    siteId: z.string().describe('SEMS site ID'),
    name: z.string().describe('Site name'),
    street: z.string().optional().describe('Street address'),
    city: z.string().optional().describe('City'),
    state: z.string().optional().describe('State code'),
    zip: z.string().optional().describe('ZIP code'),
    county: z.string().optional().describe('County name'),
    fipsCode: z.string().optional().describe('5-digit county FIPS code'),
    nplStatus: z
      .string()
      .optional()
      .describe(
        'F final, A part of an NPL site, N not listed, P proposed, D deleted, R removed, W withdrawn',
      ),
    nplStatusName: z.string().optional().describe('NPL status label'),
    nonNplStatusName: z
      .string()
      .optional()
      .describe('Non-NPL assessment label; not cleanup progress'),
    archivedInd: z.string().optional().describe('Y or N'),
    epaId: z.string().optional().describe('EPA ID, distinct from siteId'),
    federalFacilityInd: z.string().optional().describe('Y or N'),
    latitude: z.number().optional().describe('Decimal degrees'),
    longitude: z.number().optional().describe('Decimal degrees'),
  })
  .describe('Site as SEMS records it');
