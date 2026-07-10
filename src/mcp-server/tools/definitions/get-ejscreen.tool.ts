/**
 * @fileoverview Tool for retrieving EJScreen environmental-justice indicators for a
 * point + buffer, backed by the community-maintained EJAM API.
 * @module mcp-server/tools/definitions/get-ejscreen.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEjscreenService } from '@/services/ejscreen/ejscreen-service.js';

/** Miles-per-kilometer conversion factor. */
const MILES_PER_KM = 0.621371;
/** The EJAM API caps the buffer at 15 miles. */
const MAX_BUFFER_MILES = 15;

export const getEjscreenTool = tool('epa_get_ejscreen', {
  title: 'Get EJScreen Environmental Justice Indicators',
  description:
    'Get EJScreen environmental-justice indicators for a point and surrounding buffer. Returns the 13 EJScreen environmental indicators (PM2.5, ozone, diesel particulate, NO2, lead paint, traffic proximity, Superfund/RMP/hazardous-waste/wastewater proximity, underground storage tanks, drinking-water non-compliance, and RSEI toxic air releases) and 6 demographic indicators (people of color, low income, limited English, less than high school, under 5, over 64), each with national and state percentiles plus EJ Index values, along with the Demographic Index and Supplemental Demographic Index. Data is EJScreen v2.2 (2022) served via the community-maintained EJAM API (api.ejanalysis.com, Public Environmental Data Partners), which rehosts EJScreen after EPA discontinued public access in 2025 — not a live EPA endpoint. Provide latitude, longitude, and a buffer distance (default 1 mile, max 15 miles). Points outside US coverage return a coverage note instead of indicators.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    latitude: z.number().min(-90).max(90).describe('Latitude in decimal degrees.'),
    longitude: z.number().min(-180).max(180).describe('Longitude in decimal degrees.'),
    distance: z
      .number()
      .positive()
      .default(1)
      .describe(
        'Buffer radius around the point, in the given unit (default 1). The miles-equivalent must be 15 or less.',
      ),
    unit: z
      .enum(['miles', 'kilometers'])
      .default('miles')
      .describe(
        'Unit for distance. Kilometers are converted to miles (× 0.621371) before the request.',
      ),
  }),

  output: z.object({
    location: z
      .object({
        latitude: z.number().describe('Latitude of the queried point in decimal degrees.'),
        longitude: z.number().describe('Longitude of the queried point in decimal degrees.'),
        bufferMiles: z
          .number()
          .describe(
            'Buffer radius in miles used for the query (kilometers inputs converted first).',
          ),
        state: z
          .string()
          .optional()
          .describe(
            '2-letter state abbreviation for the area (e.g. "MD"). Absent when out of coverage.',
          ),
        stateName: z
          .string()
          .optional()
          .describe('Full state name (e.g. "Maryland"). Absent when out of coverage.'),
        population: z
          .number()
          .optional()
          .describe('Area-weighted population within the buffer. Absent when out of coverage.'),
        blockGroupCount: z
          .number()
          .optional()
          .describe(
            'Number of census block groups intersecting the buffer. Absent when out of coverage.',
          ),
      })
      .describe('The queried location and buffer context.'),
    environmental: z
      .array(
        z
          .object({
            code: z
              .string()
              .describe(
                'EJScreen environmental indicator code (e.g. "pm", "o3", "proximity.npl").',
              ),
            label: z.string().describe('Human-readable indicator name.'),
            value: z.number().describe('Raw indicator value, in the unit given by the unit field.'),
            unit: z.string().optional().describe('Unit or scale of the raw value.'),
            usPercentile: z
              .number()
              .optional()
              .describe('National percentile (0–100) for the raw value.'),
            statePercentile: z
              .number()
              .optional()
              .describe('State percentile (0–100) for the raw value.'),
            ejIndex: z
              .number()
              .optional()
              .describe('EJ Index (raw) — the indicator combined with the demographic index.'),
            ejIndexUsPercentile: z
              .number()
              .optional()
              .describe('National percentile (0–100) of the EJ Index.'),
            ejIndexStatePercentile: z
              .number()
              .optional()
              .describe('State percentile (0–100) of the EJ Index.'),
          })
          .describe('One environmental indicator with percentiles and its EJ Index.'),
      )
      .describe(
        'EJScreen environmental indicators present for the area. Empty when out of coverage.',
      ),
    demographic: z
      .array(
        z
          .object({
            code: z
              .string()
              .describe('EJScreen demographic indicator code (e.g. "pctmin", "pctlowinc").'),
            label: z.string().describe('Human-readable indicator name.'),
            percent: z
              .number()
              .describe('Share of the buffer population, as a percentage (0–100).'),
            usPercentile: z
              .number()
              .optional()
              .describe('National percentile (0–100) for the share.'),
            statePercentile: z
              .number()
              .optional()
              .describe('State percentile (0–100) for the share.'),
          })
          .describe('One demographic indicator with percentiles.'),
      )
      .describe(
        'EJScreen demographic indicators present for the area. Empty when out of coverage.',
      ),
    demographicIndex: z
      .object({
        value: z
          .number()
          .describe(
            'Demographic Index raw value (average of low-income and people-of-color shares).',
          ),
        usPercentile: z
          .number()
          .optional()
          .describe('National percentile (0–100) of the Demographic Index.'),
        statePercentile: z
          .number()
          .optional()
          .describe('State percentile (0–100) of the Demographic Index.'),
      })
      .optional()
      .describe('EJScreen Demographic Index. Absent when out of coverage.'),
    supplementalDemographicIndex: z
      .object({
        value: z
          .number()
          .describe('Supplemental Demographic Index raw value (five-factor average).'),
        usPercentile: z
          .number()
          .optional()
          .describe('National percentile (0–100) of the Supplemental Demographic Index.'),
        statePercentile: z
          .number()
          .optional()
          .describe('State percentile (0–100) of the Supplemental Demographic Index.'),
      })
      .optional()
      .describe('EJScreen Supplemental Demographic Index. Absent when out of coverage.'),
    reportUrl: z
      .string()
      .optional()
      .describe('Link (absolute URL) to the full EJScreen report for this point and buffer.'),
    coverage: z
      .object({
        valid: z
          .boolean()
          .describe(
            'True when EJScreen returned indicators for the point; false when the point is outside coverage.',
          ),
        note: z
          .string()
          .optional()
          .describe(
            'Explanation from EJScreen when coverage is unavailable (e.g. point outside the US).',
          ),
      })
      .describe('Whether EJScreen data was available for the point.'),
    dataSource: z.string().describe('Provenance and vintage of the data.'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the point is outside EJScreen coverage and no indicators were returned.',
      ),
  },

  errors: [
    {
      reason: 'buffer_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The buffer radius exceeds the EJAM API cap of 15 miles (after converting kilometers to miles).',
      recovery: 'Reduce distance so the miles-equivalent is 15 or less (about 24 km) and retry.',
    },
    {
      reason: 'upstream_rejected',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The EJAM API rejected the request, typically for invalid coordinates.',
      recovery:
        'Check that latitude and longitude are valid decimal-degree US coordinates and retry.',
    },
  ],

  async handler(input, ctx) {
    const bufferMiles =
      input.unit === 'kilometers' ? input.distance * MILES_PER_KM : input.distance;
    if (bufferMiles > MAX_BUFFER_MILES) {
      throw ctx.fail(
        'buffer_too_large',
        `Buffer of ${bufferMiles.toFixed(2)} miles exceeds the EJAM API limit of ${MAX_BUFFER_MILES} miles.`,
        { ...ctx.recoveryFor('buffer_too_large') },
      );
    }

    ctx.log.info('epa_get_ejscreen', {
      lat: input.latitude,
      lon: input.longitude,
      bufferMiles,
    });

    const result = await getEjscreenService().getIndicators(
      { latitude: input.latitude, longitude: input.longitude, bufferMiles },
      ctx,
    );

    ctx.log.info('epa_get_ejscreen completed', {
      valid: result.coverage.valid,
      environmental: result.environmental.length,
      demographic: result.demographic.length,
    });

    if (!result.coverage.valid) {
      ctx.enrich.notice(
        result.coverage.note
          ? `EJScreen has no coverage for this point: ${result.coverage.note}`
          : `EJScreen returned no indicators for lat=${input.latitude}, lon=${input.longitude}. EJScreen covers US locations only — verify the point is within the United States.`,
      );
    }

    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    const loc = result.location;
    const place = loc.stateName ?? loc.state;
    lines.push(
      `## EJScreen Environmental Justice — ${loc.latitude}, ${loc.longitude}${place ? ` (${place})` : ''}`,
    );
    lines.push(`**Buffer:** ${loc.bufferMiles} miles`);
    if (loc.state) lines.push(`**State:** ${loc.state}`);
    if (loc.stateName) lines.push(`**State name:** ${loc.stateName}`);
    if (loc.population !== undefined) lines.push(`**Population in buffer:** ${loc.population}`);
    if (loc.blockGroupCount !== undefined) {
      lines.push(`**Block groups intersected:** ${loc.blockGroupCount}`);
    }
    lines.push(`**Coverage valid:** ${result.coverage.valid ? 'yes' : 'no'}`);
    if (result.coverage.note) lines.push(`> ${result.coverage.note}`);

    if (result.environmental.length > 0) {
      lines.push('\n### Environmental indicators');
      for (const e of result.environmental) {
        const parts = [`**${e.label}** (\`${e.code}\`): ${e.value}${e.unit ? ` ${e.unit}` : ''}`];
        if (e.usPercentile !== undefined) parts.push(`US pctile ${e.usPercentile}`);
        if (e.statePercentile !== undefined) parts.push(`state pctile ${e.statePercentile}`);
        if (e.ejIndex !== undefined) parts.push(`EJ Index ${e.ejIndex}`);
        if (e.ejIndexUsPercentile !== undefined) {
          parts.push(`EJ Index US pctile ${e.ejIndexUsPercentile}`);
        }
        if (e.ejIndexStatePercentile !== undefined) {
          parts.push(`EJ Index state pctile ${e.ejIndexStatePercentile}`);
        }
        lines.push(`- ${parts.join(' · ')}`);
      }
    }

    if (result.demographic.length > 0) {
      lines.push('\n### Demographic indicators');
      for (const d of result.demographic) {
        const parts = [`**${d.label}** (\`${d.code}\`): ${d.percent}%`];
        if (d.usPercentile !== undefined) parts.push(`US pctile ${d.usPercentile}`);
        if (d.statePercentile !== undefined) parts.push(`state pctile ${d.statePercentile}`);
        lines.push(`- ${parts.join(' · ')}`);
      }
    }

    if (result.demographicIndex) {
      const di = result.demographicIndex;
      const parts = [`**Demographic Index:** ${di.value}`];
      if (di.usPercentile !== undefined) parts.push(`US pctile ${di.usPercentile}`);
      if (di.statePercentile !== undefined) parts.push(`state pctile ${di.statePercentile}`);
      lines.push(`\n${parts.join(' · ')}`);
    }
    if (result.supplementalDemographicIndex) {
      const si = result.supplementalDemographicIndex;
      const parts = [`**Supplemental Demographic Index:** ${si.value}`];
      if (si.usPercentile !== undefined) parts.push(`US pctile ${si.usPercentile}`);
      if (si.statePercentile !== undefined) parts.push(`state pctile ${si.statePercentile}`);
      lines.push(parts.join(' · '));
    }

    if (result.reportUrl) lines.push(`\n**EJScreen report:** ${result.reportUrl}`);
    lines.push(`\n_Source: ${result.dataSource}_`);

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
