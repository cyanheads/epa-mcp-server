/**
 * @fileoverview The bare county name every county filter matches on, shared by the tool inputs and
 * the SDWIS `county_served` row check.
 * @module services/county-name
 */

/** County-equivalent suffixes; "city and borough" precedes "borough" so Juneau keeps no "CITY AND". */
const COUNTY_SUFFIX = /\s(city and borough|county|parish|borough|census area|municipality)$/i;

/**
 * A county name trimmed, uppercased, and without a trailing county-equivalent suffix (County,
 * Parish, Borough, City and Borough, Census Area, Municipality): "KING", never "KING COUNTY", so a
 * suffixed input still matches. Linear in the name: the suffix match anchors on one whitespace
 * character rather than a run of them.
 */
export function bareCountyName(county: string): string {
  const name = county.trim();
  const suffix = COUNTY_SUFFIX.exec(name);
  return (suffix ? name.slice(0, suffix.index).trimEnd() : name).toUpperCase();
}
