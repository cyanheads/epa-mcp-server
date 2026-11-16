/**
 * @fileoverview Tool for retrieving EJScreen environmental-justice indicators for a
 * point + buffer, backed by the community-maintained EJAM API.
 * @module mcp-server/tools/definitions/ejscreen-get-scores.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, markdownLink } from '@cyanheads/mcp-ts-core/utils';
import { formatHeading } from '@/mcp-server/tools/format-heading.js';
import { formatNotice } from '@/mcp-server/tools/format-notice.js';
import { EJAM_MAX_BUFFER_MILES, getEjscreenService } from '@/services/ejscreen/ejscreen-service.js';

/** Miles-per-kilometer conversion factor. */
const MILES_PER_KM = 0.621371;

export const ejscreenGetScoresTool = tool('epa_ejscreen_get_scores', {
  title: 'Get EJScreen Environmental Justice Indicators',
  description:
    "EJScreen: Get EJScreen environmental-justice indicators for a point and surrounding buffer. Returns the 13 EJScreen environmental indicators (PM2.5, ozone, diesel particulate, NO2, lead paint, traffic proximity, Superfund/RMP/hazardous-waste/wastewater proximity, underground storage tanks, drinking-water non-compliance, and RSEI toxic air releases) and 6 demographic indicators (people of color, low income, limited English, less than high school, under 5, over 64), each with national and state percentiles plus EJ Index values, along with the Demographic Index and Supplemental Demographic Index and their national averages. Data is EJAM's ACS 2018–2022 release of EJScreen (EJScreen 2.3 method), served via the community-maintained EJAM API (api.ejanalysis.com, Public Environmental Data Partners), which rehosts EJScreen after EPA discontinued public access in 2025 — not a live EPA endpoint. Provide latitude, longitude, and a buffer distance (default 1 mile, max 15 miles). When EJScreen has no indicators — the point is outside its US bounds, the buffer holds no Census block, or its blocks have no residents — coverage.valid is false and coverage.note says which, and whether a larger distance may help.",
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
        latitude: z.number().describe('Queried latitude, decimal degrees.'),
        longitude: z.number().describe('Queried longitude, decimal degrees.'),
        bufferMiles: z.number().describe('Buffer radius in miles (kilometer input converted).'),
        state: z.string().optional().describe('2-letter state code.'),
        stateName: z.string().optional().describe('State name.'),
        population: z
          .number()
          .optional()
          .describe('Area-weighted population in the buffer; 0 when its blocks have no residents.'),
        blockGroupCount: z
          .number()
          .optional()
          .describe('Census block groups intersecting the buffer.'),
      })
      .describe(
        'Queried point and buffer; state, stateName, population, and blockGroupCount are absent when the buffer holds no Census block.',
      ),
    environmental: z
      .array(
        z
          .object({
            code: z.string().describe('EJScreen environmental indicator code.'),
            label: z.string().describe('Indicator name.'),
            value: z.number().describe('Raw value, in unit.'),
            unit: z.string().optional().describe('Unit or scale of value.'),
            usPercentile: z.number().optional().describe('National percentile (0–100) of value.'),
            statePercentile: z.number().optional().describe('State percentile (0–100) of value.'),
            ejIndex: z
              .number()
              .optional()
              .describe(
                "EJ Index: the Demographic Index × this indicator's US percentile, per block group, population-weighted over the buffer.",
              ),
            ejIndexUsPercentile: z
              .number()
              .optional()
              .describe('National percentile (0–100) of ejIndex.'),
            ejIndexStatePercentile: z
              .number()
              .optional()
              .describe('State percentile (0–100) of ejIndex.'),
          })
          .describe('One environmental indicator.'),
      )
      .describe('Empty when coverage.valid is false.'),
    demographic: z
      .array(
        z
          .object({
            code: z.string().describe('EJScreen demographic indicator code.'),
            label: z.string().describe('Indicator name.'),
            percent: z.number().describe('Share of the buffer population, 0–100.'),
            usPercentile: z.number().optional().describe('National percentile (0–100) of percent.'),
            statePercentile: z.number().optional().describe('State percentile (0–100) of percent.'),
          })
          .describe('One demographic indicator.'),
      )
      .describe('Empty when coverage.valid is false.'),
    demographicIndex: z
      .object({
        value: z
          .number()
          .describe(
            'Mean of the national z-scores for percent low income and percent people of color, shifted so the lowest block group scores 0. Unitless; higher is more disadvantaged.',
          ),
        usAverage: z
          .number()
          .optional()
          .describe('National average; absent when EJScreen omits it.'),
        usPercentile: z.number().optional().describe('National percentile (0–100).'),
        statePercentile: z
          .number()
          .optional()
          .describe(
            'State percentile (0–100) of the state-normalized index, built from z-scores within the state.',
          ),
      })
      .optional()
      .describe('Absent when coverage.valid is false.'),
    supplementalDemographicIndex: z
      .object({
        value: z
          .number()
          .describe(
            'Mean of the national z-scores for percent low income, limited English, less than high school education, and with disabilities, plus low life expectancy (four when it is missing), shifted so the lowest block group scores 0. Unitless; higher is more disadvantaged.',
          ),
        usAverage: z
          .number()
          .optional()
          .describe('National average; absent when EJScreen omits it.'),
        usPercentile: z.number().optional().describe('National percentile (0–100).'),
        statePercentile: z
          .number()
          .optional()
          .describe(
            'State percentile (0–100) of the state-normalized index, built from z-scores within the state.',
          ),
      })
      .optional()
      .describe('Absent when coverage.valid is false.'),
    reportUrl: z
      .string()
      .optional()
      .describe('Absolute URL of the full EJScreen report for this point and buffer.'),
    coverage: z
      .object({
        valid: z
          .boolean()
          .describe(
            'False when EJScreen has no indicators: the point is outside its US bounds, or the buffer holds no Census block or no residents.',
          ),
        note: z
          .string()
          .optional()
          .describe(
            'Present when valid is false: what EJScreen found, and whether a larger distance may reach data.',
          ),
      })
      .describe('Whether EJScreen had data for the buffer.'),
    dataSource: z.string().describe('Provenance and vintage of the data.'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('The coverage note as guidance, when no indicators were returned.'),
  },
  enrichmentTrailer: { notice: { render: formatNotice } },

  errors: [
    {
      reason: 'buffer_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: "The buffer exceeds the EJAM API's 15-mile cap (kilometers converted first).",
      recovery: 'Reduce distance so the miles-equivalent is 15 or less (about 24 km) and retry.',
    },
    {
      reason: 'upstream_rejected',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The EJAM API answered HTTP 400 for a point inside its accepted bounds, so the failure is at EJAM, not in the coordinates.',
      recovery:
        'Check that latitude and longitude name the intended point and retry; if EJAM rejects it again, the EJAM API is failing for this location.',
    },
  ],

  async handler(input, ctx) {
    const bufferMiles =
      input.unit === 'kilometers' ? input.distance * MILES_PER_KM : input.distance;
    if (bufferMiles > EJAM_MAX_BUFFER_MILES) {
      throw ctx.fail(
        'buffer_too_large',
        `Buffer of ${bufferMiles.toFixed(2)} miles exceeds the EJAM API limit of ${EJAM_MAX_BUFFER_MILES} miles.`,
      );
    }

    ctx.log.info('epa_ejscreen_get_scores', {
      lat: input.latitude,
      lon: input.longitude,
      bufferMiles,
    });

    const result = await getEjscreenService().getIndicators(
      { latitude: input.latitude, longitude: input.longitude, bufferMiles },
      ctx,
    );

    ctx.log.info('epa_ejscreen_get_scores completed', {
      valid: result.coverage.valid,
      environmental: result.environmental.length,
      demographic: result.demographic.length,
    });

    if (!result.coverage.valid) ctx.enrich.notice(result.coverage.note);

    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    const loc = result.location;
    const place = loc.stateName ?? loc.state;
    lines.push(
      `## EJScreen Environmental Justice — ${loc.latitude}, ${loc.longitude}${place ? ` (${formatHeading(place)})` : ''}`,
    );
    lines.push(`**Buffer:** ${loc.bufferMiles} miles`);
    if (loc.state) lines.push(`**State:** ${escapeMarkdownInline(loc.state)}`);
    if (loc.stateName) lines.push(`**State name:** ${escapeMarkdownInline(loc.stateName)}`);
    if (loc.population !== undefined) lines.push(`**Population in buffer:** ${loc.population}`);
    if (loc.blockGroupCount !== undefined) {
      lines.push(`**Block groups intersected:** ${loc.blockGroupCount}`);
    }
    lines.push(`**Coverage valid:** ${result.coverage.valid ? 'yes' : 'no'}`);
    if (result.coverage.note) lines.push(`> ${escapeMarkdownInline(result.coverage.note)}`);

    if (result.environmental.length > 0) {
      lines.push('\n### Environmental indicators');
      for (const e of result.environmental) {
        const parts = [
          `**${escapeMarkdownInline(e.label)}** (\`${e.code}\`): ${e.value}${e.unit ? ` ${escapeMarkdownInline(e.unit)}` : ''}`,
        ];
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
        const parts = [`**${escapeMarkdownInline(d.label)}** (\`${d.code}\`): ${d.percent}%`];
        if (d.usPercentile !== undefined) parts.push(`US pctile ${d.usPercentile}`);
        if (d.statePercentile !== undefined) parts.push(`state pctile ${d.statePercentile}`);
        lines.push(`- ${parts.join(' · ')}`);
      }
    }

    if (result.demographicIndex) {
      const di = result.demographicIndex;
      const parts = [`**Demographic Index:** ${di.value}`];
      if (di.usAverage !== undefined) parts.push(`US avg ${di.usAverage}`);
      if (di.usPercentile !== undefined) parts.push(`US pctile ${di.usPercentile}`);
      if (di.statePercentile !== undefined) parts.push(`state pctile ${di.statePercentile}`);
      lines.push(`\n${parts.join(' · ')}`);
    }
    if (result.supplementalDemographicIndex) {
      const si = result.supplementalDemographicIndex;
      const parts = [`**Supplemental Demographic Index:** ${si.value}`];
      if (si.usAverage !== undefined) parts.push(`US avg ${si.usAverage}`);
      if (si.usPercentile !== undefined) parts.push(`US pctile ${si.usPercentile}`);
      if (si.statePercentile !== undefined) parts.push(`state pctile ${si.statePercentile}`);
      lines.push(parts.join(' · '));
    }

    if (result.reportUrl)
      lines.push(`\n**EJScreen report:** ${markdownLink(result.reportUrl, result.reportUrl)}`);
    lines.push(`\n_Source: ${escapeMarkdownInline(result.dataSource)}_`);

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
