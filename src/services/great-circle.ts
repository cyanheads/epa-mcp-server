/**
 * @fileoverview Great-circle distance between two coordinates, shared by the proximity searches
 * that rank or report how far a row lies from the search point.
 * @module services/great-circle
 */

/** Mean Earth radius in miles: the sphere every proximity bound and distance is computed on. */
export const EARTH_RADIUS_MILES = 3958.8;

/** Haversine distance in miles between two points given in decimal degrees. */
export function greatCircleMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_MILES * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
