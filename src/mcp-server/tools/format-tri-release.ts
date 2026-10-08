/**
 * @fileoverview Renders the unit note and release-quantity lines shared by the TRI tools' text output.
 * @module mcp-server/tools/format-tri-release
 */

import { formatLbs } from '@/mcp-server/tools/format-lbs.js';

interface TriReleaseQuantities {
  releasesToAirInLbs?: number | undefined;
  releasesToLandInLbs?: number | undefined;
  releasesToUndergroundInjectionInLbs?: number | undefined;
  releasesToWaterInLbs?: number | undefined;
  reportedUnit?: 'grams' | undefined;
  totalReleasesInLbs?: number | undefined;
}

/** Markdown lines for a TRI record's reported unit and per-medium and one-time quantities; absent fields are skipped. */
export function formatTriReleaseLines(r: TriReleaseQuantities): string[] {
  const lines: string[] = [];
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
  if (r.totalReleasesInLbs !== undefined)
    lines.push(`**One-Time / Non-Routine Release:** ${formatLbs(r.totalReleasesInLbs)}`);
  return lines;
}
