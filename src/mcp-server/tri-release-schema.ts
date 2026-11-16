/**
 * @fileoverview Shared TRI release output contract: the chemical identity and release-quantity
 * fields both TRI tools return on each record.
 * @module mcp-server/tri-release-schema
 */
import { z } from '@cyanheads/mcp-ts-core';

/** One TRI submission's chemical and quantities; spread `.shape` into a tool's record schema. */
export const triReleaseSchema = z.object({
  chemicalName: z.string().describe('Name as reported to TRI'),
  chemicalId: z
    .string()
    .optional()
    .describe(
      'TRI chemical ID (a 10-digit zero-padded CAS number, an N-prefixed category code, or a placeholder); pass it as chemical_id for an exact match. Absent when TRI records none.',
    ),
  casNumber: z
    .string()
    .optional()
    .describe('CAS Registry Number, hyphenated. Absent for a category code or placeholder.'),
  reportingYear: z.number().describe('TRI reporting year'),
  reportedUnit: z
    .literal('grams')
    .optional()
    .describe(
      '"grams" when TRI has the chemical reported in grams (dioxin and dioxin-like compounds); quantities here are converted to pounds (1 lb = 453.59237 g). Absent otherwise.',
    ),
  oneTimeReleaseInLbs: z
    .number()
    .optional()
    .describe(
      'Form R Section 8.8 one-time release quantity in pounds; already counted in the per-medium releases and off-site transfers, so never added to them.',
    ),
  releasesToAirInLbs: z.number().optional().describe('On-site fugitive + stack air, in pounds'),
  releasesToWaterInLbs: z.number().optional().describe('On-site, all outfalls, in pounds'),
  releasesToLandInLbs: z.number().optional().describe('On-site, disposal included, in pounds'),
  releasesToUndergroundInjectionInLbs: z
    .number()
    .optional()
    .describe('On-site injection wells, all classes, in pounds'),
  totalOnSiteReleasesInLbs: z
    .number()
    .optional()
    .describe(
      "Sum of the per-medium fields present, in pounds; absent when none has a quantity. Media reported only as a range code are left out; TRI's published total counts their midpoint, so it can be higher.",
    ),
});
