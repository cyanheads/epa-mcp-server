/**
 * @fileoverview Retrieve a Superfund site and its contaminant associations by exact SEMS site ID
 * or EPA ID.
 * @module mcp-server/tools/definitions/superfund-get-site.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { superfundContaminantsSchema } from '@/mcp-server/superfund-contaminants-schema.js';
import { superfundSiteSchema } from '@/mcp-server/superfund-site-schema.js';
import { formatSuperfundSite } from '@/mcp-server/tools/format-superfund-site.js';
import { getDmapService } from '@/services/dmap/dmap-service.js';

/** Tool-only access to site metadata and all recorded contaminant associations. */
export const superfundGetSiteTool = tool('epa_superfund_get_site', {
  title: 'Get Superfund Site',
  description:
    'Superfund: Retrieve a site by exact SEMS site ID from epa_superfund_search_sites or by EPA ID, the SEMS program ID epa_echo_get_case lists, with all recorded contaminant associations and their media, operable units, and EPA actions. Repeated chemicals in different contexts and duplicate source rows are retained. An existing site without contaminant records returns an empty array. Associations do not establish current exposure, concentrations, or current risk. Site and contaminant requests share a 50-second deadline.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    site_id: z
      .string()
      .trim()
      .min(1)
      .describe(
        "SEMS siteId from epa_superfund_search_sites (7 digits; preserve leading zeros), or the site's EPA ID (2 letters and 10 letters or digits, any case)",
      ),
  }),
  output: z.object({ site: superfundSiteSchema, contaminants: superfundContaminantsSchema }),
  errors: [
    {
      reason: 'site_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No SEMS site has this site ID or EPA ID.',
      recovery:
        'Pass a SEMS site ID (7 digits) or an EPA ID (2 letters and 10 letters or digits), or find the site with epa_superfund_search_sites by name or location, and retry.',
      thrownBy: 'service',
    },
    {
      reason: 'unmatchable_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'site_id holds a character DMAP cannot match exactly.',
      recovery: 'Pass one SEMS site ID exactly as epa_superfund_search_sites returns it.',
      thrownBy: 'service',
    },
    {
      reason: 'filter_too_long',
      code: JsonRpcErrorCode.ValidationError,
      when: 'site_id makes the request too long.',
      recovery: 'Pass one SEMS site ID exactly as epa_superfund_search_sites returns it.',
      thrownBy: 'service',
    },
  ],
  handler(input, ctx) {
    return getDmapService().getSuperfundSite(input.site_id, ctx);
  },
  format(result) {
    const lines = [
      '## Superfund Site',
      ...formatSuperfundSite(result.site),
      '\n## Contaminant Associations',
    ];
    if (result.contaminants.length === 0)
      lines.push('No contaminant associations recorded for this site.');
    for (const contaminant of result.contaminants) {
      lines.push('\n### Association');
      if (contaminant.name !== undefined)
        lines.push(`**Name:** ${escapeMarkdownInline(contaminant.name)}`);
      if (contaminant.medium !== undefined)
        lines.push(`**Medium:** ${escapeMarkdownInline(contaminant.medium)}`);
      if (contaminant.operableUnit !== undefined)
        lines.push(`**Operable Unit:** ${escapeMarkdownInline(contaminant.operableUnit)}`);
      if (contaminant.action !== undefined)
        lines.push(`**Action:** ${escapeMarkdownInline(contaminant.action)}`);
      if (contaminant.typeCode !== undefined)
        lines.push(`**Type Code:** ${escapeMarkdownInline(contaminant.typeCode)}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
