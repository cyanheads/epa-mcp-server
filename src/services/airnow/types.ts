/**
 * @fileoverview AirNow API response types and normalized domain types for the 2026
 * web services: `observation/current/ziplatlong/` and `forecast/current/`.
 * @module services/airnow/types
 */

/** Where to look up air quality: a ZIP code, or a latitude/longitude point. */
export type AirNowLocation =
  | { kind: 'zip'; zipCode: string }
  | { kind: 'latlng'; latitude: number; longitude: number };

/** Raw record from `observation/current/ziplatlong/` — one pollutant from its closest monitor. */
export interface RawObservation {
  aqiCategoryName?: string;
  dateObserved?: string;
  /** Local hour as `"HH:00"`. */
  hourObserved?: string;
  localTimeZone?: string;
  nowcastAQI?: number;
  parameterName?: string;
  reportingAgency?: string;
  reportingAreaName?: string;
  siteID?: string;
  siteName?: string;
}

/** Raw record from `forecast/current/` — one pollutant for one valid date. */
export interface RawForecast {
  actionDay?: boolean;
  /** Forecast AQI, or `-1` when the agency issued a category only. */
  aqi?: number;
  categoryName?: string;
  categoryNumber?: number;
  dateIssue?: string;
  dateValid?: string;
  /** Agency discussion, repeated on every row of a reporting area; often empty. */
  discussion?: string;
  forecastAgency?: string;
  parameterName?: string;
  reportingArea?: string;
  reportingAreaCode?: string;
  stateCode?: string;
}

/** Normalized AQI reading for a single pollutant (observation or forecast day). */
export interface AqiReading {
  actionDay?: boolean;
  /** Omitted when upstream supplied no AQI number (category-only forecast). */
  aqi?: number;
  categoryName?: string;
  categoryNumber?: number;
  dateIssue?: string;
  dateValid?: string;
  forecastAgency?: string;
  parameterName: string;
  reportingAgency?: string;
  siteID?: string;
  siteName?: string;
}

/** Normalized readings for one reporting area (and, for observations, one observed hour). */
export interface AirQualityArea {
  dateObserved?: string;
  discussion?: string;
  hourObserved?: string;
  localTimeZone?: string;
  readings: AqiReading[];
  reportingArea?: string;
  reportingAreaCode?: string;
  stateCode?: string;
}

/** Result of one AirNow lookup. */
export interface AirQualityLookup {
  areas: AirQualityArea[];
  /** AirNow's own explanation, verbatim, when it answered HTTP 200 with no data for the location. */
  noDataMessage?: string;
}
