/**
 * @fileoverview EJScreen (EJAM API) response and normalized domain types.
 * Data is EJScreen v2.2 (2022) served via the community-maintained EJAM API
 * (api.ejanalysis.com, Public Environmental Data Partners), which rehosts
 * EJScreen after EPA discontinued public access in 2025.
 * @module services/ejscreen/types
 */

/**
 * Raw EJAM `POST /data` response row. The upstream returns a JSON array of one
 * object with ~683 columns following a systematic naming convention
 * (`<x>`, `pctile.<x>`, `state.pctile.<x>`, `EJ.DISPARITY.<x>.eo`, …). Only the
 * columns mapped by the service are read; the row is typed as a dynamic bag.
 */
export type RawEjamRow = Record<string, unknown>;

/** One EJScreen environmental indicator, with percentiles and its EJ Index. */
export interface EjEnvironmentalIndicator {
  code: string;
  ejIndex?: number;
  ejIndexStatePercentile?: number;
  ejIndexUsPercentile?: number;
  label: string;
  statePercentile?: number;
  unit?: string;
  usPercentile?: number;
  value: number;
}

/** One EJScreen demographic indicator, expressed as a percentage share. */
export interface EjDemographicIndicator {
  code: string;
  label: string;
  percent: number;
  statePercentile?: number;
  usPercentile?: number;
}

/** A composite index value (Demographic Index / Supplemental Demographic Index). */
export interface EjIndexValue {
  statePercentile?: number;
  usPercentile?: number;
  value: number;
}

/** Normalized EJScreen result for a point + buffer. Mirrors the tool output schema. */
export interface EjscreenResult {
  coverage: {
    valid: boolean;
    note?: string;
  };
  dataSource: string;
  demographic: EjDemographicIndicator[];
  demographicIndex?: EjIndexValue;
  environmental: EjEnvironmentalIndicator[];
  location: {
    latitude: number;
    longitude: number;
    bufferMiles: number;
    state?: string;
    stateName?: string;
    population?: number;
    blockGroupCount?: number;
  };
  reportUrl?: string;
  supplementalDemographicIndex?: EjIndexValue;
}
