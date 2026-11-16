/**
 * @fileoverview The `distanceMiles` field proximity searches add to each row: its output schema,
 * its rounding, and its `content[]` line, shared so every tool reports the distance one way.
 * @module mcp-server/tools/distance-field
 */

import { z } from '@cyanheads/mcp-ts-core';

/** Output field for a proximity-search row. */
export const distanceMilesField = z
  .number()
  .optional()
  .describe(
    'Great-circle miles from the search point, to two decimals; absent without a search point or row coordinates.',
  );

/** Miles to two decimals, as `distanceMiles` reports them; rank on the unrounded value. */
export function roundMiles(miles: number): number {
  return Math.round(miles * 100) / 100;
}

/** The `content[]` line for a row's `distanceMiles`. */
export function formatDistanceLine(miles: number): string {
  return `**Distance:** ${miles} mi`;
}
