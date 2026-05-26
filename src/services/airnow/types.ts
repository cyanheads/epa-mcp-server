/**
 * @fileoverview AirNow API response types and normalized domain types.
 * @module services/airnow/types
 */

/** Raw AirNow observation/forecast record from the JSON API. */
export interface RawAirNowRecord {
  AQI?: number;
  Category?: {
    Number?: number;
    Name?: string;
  };
  DateObserved?: string;
  HourObserved?: number;
  Latitude?: number;
  LocalTimeZone?: string;
  Longitude?: number;
  ParameterName?: string;
  ReportingArea?: string;
  StateCode?: string;
}

/** Normalized AQI reading for a single pollutant. */
export interface AqiReading {
  aqi: number;
  categoryName?: string;
  categoryNumber?: number;
  parameterName: string;
}

/** Normalized AirNow observation/forecast result. */
export interface AirQualityResult {
  dateObserved?: string;
  hourObserved?: number;
  latitude?: number;
  localTimeZone?: string;
  longitude?: number;
  readings: AqiReading[];
  reportingArea?: string;
  stateCode?: string;
}
