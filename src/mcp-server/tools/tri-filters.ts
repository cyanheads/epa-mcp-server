/**
 * @fileoverview The chemical filters and the empty-result hints both TRI tools share: one
 * `chemical_name` / `chemical_id` input description each, and the recovery hints that name the
 * year and chemical filters to loosen.
 * @module mcp-server/tools/tri-filters
 */

import { z } from '@cyanheads/mcp-ts-core';
import { optionalChemicalIdSchema } from '@/mcp-server/tools/input-formats.js';

/** Optional `chemical_name` input: a case-insensitive partial name match. */
export const chemicalNameSchema = z
  .string()
  .max(4094)
  .optional()
  .describe(
    'Optional filter to restrict results to a specific chemical (partial match, case-insensitive). Commas, apostrophes, brackets, and Greek letters are matched as written, e.g. "4,4\'-Methylenedianiline".',
  );

/** Optional `chemical_id` input: an exact TRI chemical ID. Pair with `normalizeChemicalId`. */
export const triChemicalIdSchema = optionalChemicalIdSchema(
  'TRI chemical ID to match exactly, where chemical_name matches any name containing its text: a CAS Registry Number, hyphens and leading zeros optional, with a valid check digit; a TRI category code, N and three digits in any case; or a chemicalId an earlier result returned.',
);

/**
 * Hints for an empty first page: TRI's reporting lag, an earlier year to try, and the chemical
 * filters to remove. The caller appends the hints specific to its tool.
 */
export function triEmptyResultHints({
  year,
  chemicalName,
  chemicalId,
}: {
  year: number | undefined;
  chemicalName: string | undefined;
  chemicalId: string | undefined;
}): string[] {
  const hints = ['TRI data lags ~18 months.'];
  if (year !== undefined) {
    const earlierYear = Math.min(year - 1, new Date().getFullYear() - 2);
    hints.push(
      earlierYear >= 1987
        ? `For an earlier reporting period, try year ${earlierYear}, or remove year to search all available years.`
        : 'Remove year to search all available years.',
    );
  }
  const chemicalFilter = [chemicalName && 'chemical_name', chemicalId && 'chemical_id']
    .filter(Boolean)
    .join(' or ');
  if (chemicalFilter) hints.push(`Remove ${chemicalFilter} to include other chemicals.`);
  return hints;
}
