/**
 * @fileoverview Renders a whole-dollar amount for tool text output.
 * @module mcp-server/tools/format-dollars
 */

/** Format an amount as `"$1,750"`. */
export const dollars = (amount: number): string => `$${amount.toLocaleString('en-US')}`;
