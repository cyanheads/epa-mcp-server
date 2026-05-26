/**
 * @fileoverview Tool for getting AQI observations or forecasts for a location from AirNow.
 * @module mcp-server/tools/definitions/get-air-quality.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getAirNowService } from '@/services/airnow/airnow-service.js';
import type { AirQualityResult } from '@/services/airnow/types.js';

export const getAirQualityTool = tool('epa_get_air_quality', {
  title: 'Get Air Quality Index',
  description:
    'Get current AQI observations or forecasts for a location from the AirNow API. Returns per-pollutant AQI values (PM2.5, ozone, CO, SO2, NO2), AQI category (Good through Hazardous), reporting area name, and observation timestamp. Provide either zip_code or both latitude and longitude. Set mode to "forecast" and provide forecast_date for next-day projections. Data is preliminary — suitable for awareness and informational use, not regulatory decisions. Responses are cached for ~1 hour.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    zip_code: z.string().optional().describe('5-digit ZIP code for the location'),
    latitude: z
      .number()
      .optional()
      .describe('Latitude in decimal degrees (use with longitude instead of zip_code)'),
    longitude: z
      .number()
      .optional()
      .describe('Longitude in decimal degrees (use with latitude instead of zip_code)'),
    mode: z
      .enum(['current', 'forecast'])
      .default('current')
      .describe(
        'Data mode: "current" for latest AQI observations, "forecast" for next-day projections',
      ),
    forecast_date: z
      .string()
      .optional()
      .describe(
        'Date for forecast in ISO 8601 format (YYYY-MM-DD). Required when mode is "forecast".',
      ),
    distance_miles: z
      .number()
      .int()
      .min(0)
      .max(300)
      .default(25)
      .describe('Search radius in miles for finding reporting stations. Default 25 miles.'),
  }),

  output: z.object({
    observations: z
      .array(
        z
          .object({
            reportingArea: z
              .string()
              .optional()
              .describe('Name of the AQI reporting area (e.g. "Seattle-Tacoma-Bellevue, WA")'),
            stateCode: z.string().optional().describe('2-letter state code of the reporting area'),
            latitude: z.number().optional().describe('Latitude of the reporting area centroid'),
            longitude: z.number().optional().describe('Longitude of the reporting area centroid'),
            dateObserved: z
              .string()
              .optional()
              .describe('Observation or forecast date (YYYY-MM-DD)'),
            hourObserved: z
              .number()
              .optional()
              .describe('Hour of observation (0–23) in local time. Absent for daily forecasts.'),
            localTimeZone: z
              .string()
              .optional()
              .describe('Local time zone abbreviation (e.g. "PST")'),
            readings: z
              .array(
                z
                  .object({
                    parameterName: z
                      .string()
                      .describe('Pollutant name (e.g. "PM2.5", "Ozone", "CO")'),
                    aqi: z.number().describe('Air Quality Index value for this pollutant'),
                    categoryNumber: z
                      .number()
                      .optional()
                      .describe(
                        'AQI category number: 1=Good, 2=Moderate, 3=Unhealthy for Sensitive Groups, 4=Unhealthy, 5=Very Unhealthy, 6=Hazardous',
                      ),
                    categoryName: z
                      .string()
                      .optional()
                      .describe('AQI category name (e.g. "Good", "Moderate", "Unhealthy")'),
                  })
                  .describe('AQI reading for a single pollutant parameter'),
              )
              .describe('Per-pollutant AQI readings for this reporting area and time'),
          })
          .describe('AQI observation or forecast record for a single reporting area'),
      )
      .describe('AQI observation or forecast records grouped by reporting area'),
    mode: z.string().describe('Data mode used: "current" or "forecast"'),
    message: z
      .string()
      .optional()
      .describe(
        'Recovery hint when no observations are returned — suggests trying a different location or increasing distance_miles. Absent when data is returned.',
      ),
  }),

  errors: [
    {
      reason: 'no_location',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Neither zip_code nor latitude+longitude was provided.',
      recovery: 'Provide either zip_code or both latitude and longitude to identify the location.',
    },
    {
      reason: 'forecast_date_required',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Mode is "forecast" but forecast_date was not provided.',
      recovery: 'Provide forecast_date as YYYY-MM-DD when using mode="forecast".',
    },
  ],

  async handler(input, ctx) {
    // Validate location
    const hasZip = !!input.zip_code?.trim();
    const hasLatLng = input.latitude !== undefined && input.longitude !== undefined;
    if (!hasZip && !hasLatLng) {
      throw ctx.fail('no_location', 'Provide either zip_code or both latitude and longitude.', {
        ...ctx.recoveryFor('no_location'),
      });
    }

    // Validate forecast date
    if (input.mode === 'forecast' && !input.forecast_date?.trim()) {
      throw ctx.fail(
        'forecast_date_required',
        'forecast_date (YYYY-MM-DD) is required when mode is "forecast".',
        {
          ...ctx.recoveryFor('forecast_date_required'),
        },
      );
    }

    ctx.log.info('epa_get_air_quality', {
      mode: input.mode,
      zip: input.zip_code,
      lat: input.latitude,
    });

    const service = getAirNowService();
    let observations: AirQualityResult[];

    if (input.mode === 'current') {
      if (hasZip) {
        observations = await service.getCurrentByZip(
          { zipCode: input.zip_code!, distanceMiles: input.distance_miles },
          ctx,
        );
      } else {
        observations = await service.getCurrentByLatLng(
          {
            latitude: input.latitude!,
            longitude: input.longitude!,
            distanceMiles: input.distance_miles,
          },
          ctx,
        );
      }
    } else {
      if (hasZip) {
        observations = await service.getForecastByZip(
          {
            zipCode: input.zip_code!,
            date: input.forecast_date!,
            distanceMiles: input.distance_miles,
          },
          ctx,
        );
      } else {
        observations = await service.getForecastByLatLng(
          {
            latitude: input.latitude!,
            longitude: input.longitude!,
            date: input.forecast_date!,
            distanceMiles: input.distance_miles,
          },
          ctx,
        );
      }
    }

    ctx.log.info('epa_get_air_quality completed', { areas: observations.length });

    if (observations.length === 0) {
      const location = hasZip
        ? `zip_code="${input.zip_code}"`
        : `lat=${input.latitude}, lng=${input.longitude}`;
      return {
        observations: [],
        mode: input.mode,
        message: `No AQI data found for ${location} within ${input.distance_miles} miles. Try increasing distance_miles or check that the location is within the US.`,
      };
    }

    return { observations, mode: input.mode };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(
      `## Air Quality Index — ${result.mode === 'forecast' ? 'Forecast' : 'Current Observations'} (mode: ${result.mode})`,
    );
    if (result.message) lines.push(`\n> ${result.message}`);

    for (const obs of result.observations) {
      lines.push(`\n### ${obs.reportingArea ?? 'Unknown Area'}`);
      if (obs.stateCode) lines.push(`**State:** ${obs.stateCode}`);
      if (obs.dateObserved) {
        const timeStr =
          obs.hourObserved !== undefined
            ? ` at ${obs.hourObserved}:00 ${obs.localTimeZone ?? ''}`
            : '';
        lines.push(`**Date:** ${obs.dateObserved}${timeStr}`);
      }
      if (obs.latitude !== undefined && obs.longitude !== undefined) {
        lines.push(`**Coordinates:** ${obs.latitude}, ${obs.longitude}`);
      }
      for (const reading of obs.readings) {
        const category = reading.categoryName ? ` (${reading.categoryName})` : '';
        const catNum =
          reading.categoryNumber !== undefined ? ` [category ${reading.categoryNumber}]` : '';
        lines.push(`**${reading.parameterName}:** AQI ${reading.aqi}${category}${catNum}`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
