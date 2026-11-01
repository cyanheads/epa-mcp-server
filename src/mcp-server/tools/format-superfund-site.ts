/**
 * @fileoverview Render the site fields shared by Superfund search and detail tools.
 * @module mcp-server/tools/format-superfund-site
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import type { superfundSiteSchema } from '@/mcp-server/superfund-site-schema.js';
import { formatHeading } from './format-heading.js';
import { formatLocationLines } from './format-location.js';

/** Preserve source metadata literally at the Markdown boundary. */
export function formatSuperfundSite(site: z.infer<typeof superfundSiteSchema>): string[] {
  const lines = [
    `### ${formatHeading(site.name)}`,
    `**Site ID:** ${escapeMarkdownInline(site.siteId)}`,
    ...formatLocationLines(site),
  ];
  if (site.nplStatus !== undefined)
    lines.push(`**NPL Status:** ${escapeMarkdownInline(site.nplStatus)}`);
  if (site.nplStatusName !== undefined)
    lines.push(`**NPL Status Name:** ${escapeMarkdownInline(site.nplStatusName)}`);
  if (site.nonNplStatusName !== undefined)
    lines.push(`**Non-NPL Assessment:** ${escapeMarkdownInline(site.nonNplStatusName)}`);
  if (site.archivedInd !== undefined)
    lines.push(`**Archived Indicator:** ${escapeMarkdownInline(site.archivedInd)}`);
  if (site.epaId !== undefined) lines.push(`**EPA ID:** ${escapeMarkdownInline(site.epaId)}`);
  if (site.federalFacilityInd !== undefined)
    lines.push(`**Federal Facility Indicator:** ${escapeMarkdownInline(site.federalFacilityInd)}`);
  return lines;
}
