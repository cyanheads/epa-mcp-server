/**
 * @fileoverview Renders a pound quantity for tool text output without rounding away small values.
 * @module mcp-server/tools/format-lbs
 */

/**
 * Format a quantity in pounds as `"<n> lbs"`, grouped and at full reported precision.
 *
 * Default `toLocaleString()` stops at 3 fraction digits, so a TRI release of 0.00062 lbs prints
 * as 0.001. TRI quantities carry at most 7 significant digits; 12 keeps every one of them, and
 * matches the 12 significant digits the DMAP service rounds its per-medium sums and gram-to-pound
 * conversions to, so text and structuredContent show one value.
 */
export function formatLbs(lbs: number): string {
  return `${lbs.toLocaleString(undefined, { maximumSignificantDigits: 12 })} lbs`;
}
