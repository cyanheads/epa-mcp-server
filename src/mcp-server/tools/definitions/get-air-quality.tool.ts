/**
 * @fileoverview Tool for getting current AQI observations or the issued AQI forecast for a
 * location from AirNow.
 * @module mcp-server/tools/definitions/get-air-quality.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getAirNowService } from '@/services/airnow/airnow-service.js';
import type { AirNowLocation, AirQualityArea } from '@/services/airnow/types.js';

const AIRNOW_PROGRAM = 'the U.S. EPA AirNow program (www.airnow.gov)';
const PRELIMINARY_NOTICE =
  'AirNow data are preliminary and unverified; do not use them for regulatory, trend, or enforcement decisions.';

/** Credit line naming the agencies behind the returned readings and the AirNow program. */
function attributionFor(mode: 'current' | 'forecast', areas: AirQualityArea[]): string {
  const agencies = [
    ...new Set(
      areas.flatMap((area) =>
        area.readings.flatMap((r) => {
          const agency = r.reportingAgency ?? r.forecastAgency;
          return agency ? [agency] : [];
        }),
      ),
    ),
  ];
  const list = (items: string[]) =>
    new Intl.ListFormat('en', { type: 'conjunction' }).format(items);
  const credit =
    mode === 'current'
      ? `Data courtesy of ${list([...agencies, AIRNOW_PROGRAM])}.`
      : agencies.length > 0
        ? `Forecasts issued by ${list(agencies)} and distributed by ${AIRNOW_PROGRAM}.`
        : `Forecasts distributed by ${AIRNOW_PROGRAM}.`;
  return `${credit} ${PRELIMINARY_NOTICE}`;
}

export const getAirQualityTool = tool('epa_get_air_quality', {
  title: 'Get Air Quality Index',
  description:
    "Get current AQI observations or the issued AQI forecast for a US location from the AirNow API. Provide either zip_code or both latitude and longitude. Current mode returns the latest hourly NowCast AQI for each pollutant (PM2.5, ozone, PM10) from the closest monitor within 50 miles, with the monitor site name, site ID, and reporting agency; pollutants in one reporting area can come from different monitors. Forecast mode returns every day the reporting area's agency has issued (typically one to five), each with the AQI category, an action-day flag, and the issue date, plus the agency's forecast discussion when one exists; some agencies forecast a category without an AQI number. In forecast mode, set forecast_date to keep only the forecast valid on that date; current mode rejects it. Data are preliminary — suitable for awareness, not regulatory, trend, or enforcement decisions. Responses are cached for ~1 hour.",
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    zip_code: z.string().optional().describe('5-digit US ZIP code for the location'),
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
        'Data mode: "current" for the latest hourly observations, "forecast" for every forecast day the reporting area has issued',
      ),
    forecast_date: z
      .string()
      .optional()
      .describe(
        'Forecast mode only (rejected in current mode): keep just the forecast valid on this date (YYYY-MM-DD). Omit to get every issued forecast day. When no issued day matches, the result is empty and its message lists the issued dates.',
      ),
  }),

  output: z.object({
    observations: z
      .array(
        z
          .object({
            reportingArea: z
              .string()
              .optional()
              .describe('Name of the AQI reporting area (e.g. "Seattle-Bellevue-Kent Valley")'),
            reportingAreaCode: z
              .string()
              .optional()
              .describe('AirNow reporting area code (e.g. "wa004"). Forecast mode only.'),
            stateCode: z
              .string()
              .optional()
              .describe('2-letter state code of the reporting area. Forecast mode only.'),
            dateObserved: z
              .string()
              .optional()
              .describe('Observation date (YYYY-MM-DD). Current mode only.'),
            hourObserved: z
              .string()
              .optional()
              .describe('Local hour of the observation as "HH:00". Current mode only.'),
            localTimeZone: z
              .string()
              .optional()
              .describe(
                'Local time zone abbreviation for hourObserved (e.g. "PDT"). Current mode only.',
              ),
            discussion: z
              .string()
              .optional()
              .describe(
                "The forecasting agency's discussion for this area, verbatim (may contain HTML). Forecast mode only; omitted when the agency issued none.",
              ),
            readings: z
              .array(
                z
                  .object({
                    parameterName: z
                      .string()
                      .describe(
                        'Pollutant name as AirNow reports it (e.g. "PM2.5", "OZONE", "PM10")',
                      ),
                    aqi: z
                      .number()
                      .optional()
                      .describe(
                        'Air Quality Index value. Omitted when the agency issued only a category (category-only forecast).',
                      ),
                    categoryNumber: z
                      .number()
                      .optional()
                      .describe(
                        'AQI category number: 1=Good, 2=Moderate, 3=Unhealthy for Sensitive Groups, 4=Unhealthy, 5=Very Unhealthy, 6=Hazardous. Omitted when AirNow reports an unrecognized category.',
                      ),
                    categoryName: z
                      .string()
                      .optional()
                      .describe('AQI category name (e.g. "Good", "Moderate", "Unhealthy")'),
                    siteName: z
                      .string()
                      .optional()
                      .describe('Monitor site that produced this observation. Current mode only.'),
                    siteID: z
                      .string()
                      .optional()
                      .describe('AirNow ID of the monitor site. Current mode only.'),
                    reportingAgency: z
                      .string()
                      .optional()
                      .describe('Agency that reported this observation. Current mode only.'),
                    dateIssue: z
                      .string()
                      .optional()
                      .describe('Date the forecast was issued (YYYY-MM-DD). Forecast mode only.'),
                    dateValid: z
                      .string()
                      .optional()
                      .describe('Date the forecast applies to (YYYY-MM-DD). Forecast mode only.'),
                    forecastAgency: z
                      .string()
                      .optional()
                      .describe('Agency that issued the forecast. Forecast mode only.'),
                    actionDay: z
                      .boolean()
                      .optional()
                      .describe(
                        'True when the agency declared an air quality action day for this date. Forecast mode only.',
                      ),
                  })
                  .describe(
                    'AQI reading for one pollutant (and, in forecast mode, one valid date)',
                  ),
              )
              .describe('Per-pollutant AQI readings for this reporting area'),
          })
          .describe(
            'AQI readings for one reporting area — per observed hour in current mode, per area across all forecast days in forecast mode',
          ),
      )
      .describe('AQI observation or forecast records grouped by reporting area'),
    mode: z.string().describe('Data mode used: "current" or "forecast"'),
    message: z
      .string()
      .optional()
      .describe(
        "Why the result is empty: AirNow's own explanation, the issued forecast dates when forecast_date matched none, or a coverage hint. Absent when data is returned.",
      ),
    attribution: z
      .string()
      .describe(
        'Credit to the reporting or forecasting agencies and the U.S. EPA AirNow program, with the preliminary-data notice. Reproduce it when passing this data on.',
      ),
  }),

  errors: [
    {
      reason: 'no_location',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither zip_code nor latitude+longitude was provided.',
      recovery: 'Provide either zip_code or both latitude and longitude to identify the location.',
    },
    {
      reason: 'forecast_date_needs_forecast_mode',
      code: JsonRpcErrorCode.ValidationError,
      when: 'forecast_date was set while mode is "current", where it has no effect.',
      recovery: 'Set mode to "forecast" to filter by forecast_date, or omit forecast_date.',
    },
    {
      reason: 'invalid_zip_code',
      code: JsonRpcErrorCode.ValidationError,
      when: 'AirNow rejected zip_code as invalid (HTTP 400).',
      recovery:
        'Check that zip_code is a valid 5-digit US ZIP code, or pass latitude and longitude instead.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    // Zip takes precedence over lat/lng; a blank zip (form clients) falls through to lat/lng.
    const zip = input.zip_code?.trim();
    const location: AirNowLocation | undefined = zip
      ? { kind: 'zip', zipCode: zip }
      : input.latitude !== undefined && input.longitude !== undefined
        ? { kind: 'latlng', latitude: input.latitude, longitude: input.longitude }
        : undefined;
    if (!location) {
      throw ctx.fail('no_location', 'Provide either zip_code or both latitude and longitude.');
    }
    const forecastDate = input.forecast_date?.trim() || undefined;
    if (forecastDate && input.mode === 'current') {
      throw ctx.fail(
        'forecast_date_needs_forecast_mode',
        `forecast_date "${forecastDate}" only filters forecasts; current mode returns the latest observations.`,
      );
    }

    ctx.log.info('epa_get_air_quality', {
      mode: input.mode,
      location: location.kind,
      forecastDate,
    });

    const service = getAirNowService();
    const lookup =
      input.mode === 'forecast'
        ? await service.getForecast(location, ctx)
        : await service.getCurrent(location, ctx);

    const observations =
      input.mode === 'forecast' && forecastDate
        ? lookup.areas.flatMap((area) => {
            const readings = area.readings.filter((r) => r.dateValid === forecastDate);
            return readings.length > 0 ? [{ ...area, readings }] : [];
          })
        : lookup.areas;

    ctx.log.info('epa_get_air_quality completed', { areas: observations.length });

    const attribution = attributionFor(input.mode, observations);
    if (observations.length > 0) return { observations, mode: input.mode, attribution };

    const where =
      location.kind === 'zip'
        ? `zip_code="${location.zipCode}"`
        : `latitude=${location.latitude}, longitude=${location.longitude}`;
    let message: string;
    if (lookup.noDataMessage !== undefined) {
      message = `AirNow returned no data for ${where}: "${lookup.noDataMessage}"`;
    } else if (lookup.areas.length > 0) {
      const issued = [
        ...new Set(lookup.areas.flatMap((a) => a.readings.flatMap((r) => r.dateValid ?? []))),
      ].sort();
      message = `No forecast valid on ${forecastDate} for ${where}. ${issued.length > 0 ? `Issued forecast dates: ${issued.join(', ')}.` : 'AirNow listed no valid dates.'} Omit forecast_date to get every issued day.`;
    } else {
      message = `No AQI data found for ${where}. AirNow observations come from monitors within 50 miles and forecasts from the location's reporting area; check that the location is in the US, or try a nearby ZIP code.`;
    }
    return { observations: [], mode: input.mode, message, attribution };
  },

  format: (result) => {
    const lines: string[] = [
      `## Air Quality Index — ${result.mode === 'forecast' ? 'Forecast' : 'Current Observations'} (mode: ${result.mode})`,
    ];
    if (result.message) lines.push(`\n> ${result.message}`);

    for (const area of result.observations) {
      lines.push(`\n### ${area.reportingArea ?? 'Unknown Area'}`);
      const meta = [
        area.stateCode && `**State:** ${area.stateCode}`,
        area.reportingAreaCode && `**Reporting area code:** ${area.reportingAreaCode}`,
      ].filter(Boolean);
      if (meta.length > 0) lines.push(meta.join(' | '));
      if (area.dateObserved || area.hourObserved) {
        const time = area.hourObserved
          ? ` at ${area.hourObserved}${area.localTimeZone ? ` ${area.localTimeZone}` : ''}`
          : '';
        lines.push(`**Observed:** ${area.dateObserved ?? 'date not reported'}${time}`);
      }
      for (const r of area.readings) {
        const label = r.dateValid ? `${r.dateValid} ${r.parameterName}` : r.parameterName;
        const value =
          r.aqi !== undefined
            ? `AQI ${r.aqi}${r.categoryName ? ` (${r.categoryName})` : ''}`
            : (r.categoryName ?? 'Category not reported');
        const category = r.categoryNumber !== undefined ? ` [category ${r.categoryNumber}]` : '';
        const categoryOnly = r.aqi === undefined ? ' (category only, no AQI number)' : '';
        const site =
          r.siteName || r.siteID
            ? ` — ${[r.siteName, r.siteID && `site ${r.siteID}`].filter(Boolean).join(', ')}`
            : '';
        const details = [
          r.reportingAgency,
          (r.dateIssue || r.forecastAgency) &&
            ['issued', r.dateIssue, r.forecastAgency && `by ${r.forecastAgency}`]
              .filter(Boolean)
              .join(' '),
          r.actionDay !== undefined && `action day: ${r.actionDay ? 'yes' : 'no'}`,
        ].filter(Boolean);
        lines.push(
          `- **${label}:** ${value}${category}${categoryOnly}${site}${details.length > 0 ? ` · ${details.join(' · ')}` : ''}`,
        );
      }
      if (area.discussion) lines.push(`\n**Discussion:**\n${area.discussion}`);
    }

    lines.push(`\n**Source:** ${result.attribution}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
