/**
 * @fileoverview Renders the chemical ID, unit note, and release-quantity lines shared by the TRI
 * tools' text output.
 * @module mcp-server/tools/format-tri-release
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { formatLbs } from '@/mcp-server/tools/format-lbs.js';
import type { triReleaseSchema } from '@/mcp-server/tri-release-schema.js';

/**
 * Markdown lines for a TRI record's chemical ID and CAS number, reported unit, per-medium
 * quantities, their on-site total, and the one-time quantity; absent fields are skipped.
 */
export function formatTriReleaseLines(r: z.infer<typeof triReleaseSchema>): string[] {
  const lines: string[] = [];
  if (r.chemicalId) lines.push(`**Chemical ID:** ${escapeMarkdownInline(r.chemicalId)}`);
  if (r.casNumber) lines.push(`**CAS Number:** ${escapeMarkdownInline(r.casNumber)}`);
  if (r.reportedUnit)
    lines.push(
      `**Reported Unit:** ${r.reportedUnit} — any quantities shown are converted to pounds (1 lb = 453.59237 g)`,
    );
  if (r.releasesToAirInLbs !== undefined)
    lines.push(`**Air Releases:** ${formatLbs(r.releasesToAirInLbs)}`);
  if (r.releasesToWaterInLbs !== undefined)
    lines.push(`**Water Releases:** ${formatLbs(r.releasesToWaterInLbs)}`);
  if (r.releasesToLandInLbs !== undefined)
    lines.push(`**Land Releases:** ${formatLbs(r.releasesToLandInLbs)}`);
  if (r.releasesToUndergroundInjectionInLbs !== undefined)
    lines.push(`**Underground Injection:** ${formatLbs(r.releasesToUndergroundInjectionInLbs)}`);
  if (r.totalOnSiteReleasesInLbs !== undefined)
    lines.push(`**Total On-Site Releases:** ${formatLbs(r.totalOnSiteReleasesInLbs)}`);
  if (r.oneTimeReleaseInLbs !== undefined)
    lines.push(`**One-Time Release:** ${formatLbs(r.oneTimeReleaseInLbs)}`);
  return lines;
}
