/**
 * @fileoverview Renders the address, county, and coordinate lines shared by facility and site tool output.
 * @module mcp-server/tools/format-location
 */

interface LocatedRecord {
  city?: string | undefined;
  county?: string | undefined;
  fipsCode?: string | undefined;
  latitude?: number | undefined;
  longitude?: number | undefined;
  state?: string | undefined;
  street?: string | undefined;
  zip?: string | undefined;
}

/** Markdown lines for a record's address, county (with FIPS), and coordinates; absent parts are skipped. */
export function formatLocationLines(r: LocatedRecord): string[] {
  const lines: string[] = [];
  const address = [r.street, r.city, r.state, r.zip].filter(Boolean).join(', ');
  if (address) lines.push(`**Location:** ${address}`);
  if (r.county) lines.push(`**County:** ${r.county}${r.fipsCode ? ` (FIPS: ${r.fipsCode})` : ''}`);
  else if (r.fipsCode) lines.push(`**County FIPS:** ${r.fipsCode}`);
  if (r.latitude !== undefined && r.longitude !== undefined) {
    lines.push(`**Coordinates:** ${r.latitude}, ${r.longitude}`);
  } else if (r.latitude !== undefined) {
    lines.push(`**Latitude:** ${r.latitude}`);
  } else if (r.longitude !== undefined) {
    lines.push(`**Longitude:** ${r.longitude}`);
  }
  return lines;
}
