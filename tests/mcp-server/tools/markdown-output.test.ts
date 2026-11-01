/**
 * @fileoverview Upstream strings survive every tool formatter as literal CommonMark text.
 * @module tests/mcp-server/tools/markdown-output.test
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { formatLocationLines } from '@/mcp-server/tools/format-location.js';
import { formatNotice } from '@/mcp-server/tools/format-notice.js';

const markdown = new MarkdownIt();
const value = 'A *plant* [name](https://example.com) <b>raw</b>\n# second line';
const message = { message: value };
const programs = { air: false, water: false, rcra: false, tri: false, sdwa: false };
const cases: Record<string, unknown> = {
  epa_echo_search_facilities: {
    facilities: [{ name: value, registryId: '1', programs }],
    totalCount: 1,
    ...message,
  },
  epa_echo_get_facility: {
    name: value,
    registryId: '1',
    programs,
    triFacilityIds: [],
    programCompliance: [],
    inspections: [],
    inspectionsTotal: 0,
    formalActions: [],
  },
  epa_echo_search_violations: { cases: [{ caseName: value }], totalCount: 1, ...message },
  epa_airnow_get_conditions: {
    mode: 'current',
    observations: [{ reportingArea: value, readings: [] }],
    attribution: value,
    ...message,
  },
  epa_tri_get_facility_releases: { facilityId: value, releases: [], ...message },
  epa_tri_search_releases: { state: value, releases: [], ...message },
  epa_superfund_search_sites: { sites: [{ siteId: '1', name: value }], totalCount: 1, ...message },
  epa_superfund_get_site: {
    site: { siteId: '1', name: value },
    contaminants: [
      { name: value, medium: value, operableUnit: value, action: value, typeCode: value },
    ],
  },
  epa_water_search_systems: { systems: [{ pwsid: '1', name: value }], totalCount: 1, ...message },
  epa_ejscreen_get_scores: {
    location: { latitude: 0, longitude: 0, bufferMiles: 1, stateName: value },
    environmental: [],
    demographic: [],
    coverage: { valid: false, note: value },
    dataSource: value,
  },
};

describe('literal upstream Markdown', () => {
  it.each(allToolDefinitions)(
    '$name preserves text without introducing links or HTML',
    (definition) => {
      const structured = structuredClone(cases[definition.name]);
      const output = definition.output!.parse(structured);
      const beforeFormat = structuredClone(output);
      // The heterogeneous table keeps each formatter paired with its own parsed output schema.
      const format = definition.format as (
        value: unknown,
      ) => ReturnType<NonNullable<typeof definition.format>>;
      const content = format(output);
      const source = content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n');
      const tokens = markdown.parse(source, {});
      const headingTexts = tokens.flatMap((token, index) =>
        token.type === 'heading_open'
          ? [(tokens[index + 1]?.children ?? []).map((child) => child.content).join('')]
          : [],
      );
      expect(headingTexts.some((heading) => heading.includes(value))).toBe(true);
      const inline = tokens.flatMap((token) => token.children ?? []);
      expect(
        inline.some((token) => token.type === 'link_open' || token.type === 'html_inline'),
      ).toBe(false);
      expect(
        inline
          .filter((token) => token.type === 'text')
          .map((token) => token.content)
          .join('\n'),
      ).toContain(value);
      expect(output).toEqual(beforeFormat);
      if (
        'enrichment' in definition &&
        definition.enrichment &&
        'notice' in definition.enrichment
      ) {
        expect(definition.enrichmentTrailer?.notice?.render).toBe(formatNotice);
      }
    },
  );

  it('renders shared location strings literally, including a line break', () => {
    const address = 'A *street*\n- injected list';
    const tokens = markdown.parse(formatLocationLines({ street: address }).join('\n'), {});
    expect(tokens.some((token) => token.type === 'bullet_list_open')).toBe(false);
    const text = tokens
      .flatMap((token) => token.children ?? [])
      .filter((token) => token.type === 'text')
      .map((token) => token.content)
      .join('\n');
    expect(text).toContain(address);
  });

  it('keeps a multiline enrichment notice raw in structuredContent and quoted in content', async () => {
    const notice = `${value}\n- another line`;
    const definition = tool('literal_notice_test', {
      description: 'Verify literal enrichment notice rendering.',
      input: z.object({}),
      output: z.object({}),
      format: () => [],
      enrichment: { notice: z.string().optional().describe('Raw notice text.') },
      enrichmentTrailer: { notice: { render: formatNotice } },
      handler(_input, ctx) {
        ctx.enrich.notice(notice);
        return {};
      },
    });
    const result = await runToolContract(definition, {});
    expect(result.structuredContent).toEqual({ notice });
    const source = result.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
    const tokens = markdown.parse(source, {});
    expect(tokens.filter((token) => token.type === 'blockquote_open')).toHaveLength(1);
    expect(tokens.some((token) => token.type === 'bullet_list_open')).toBe(false);
    const inline = tokens.flatMap((token) => token.children ?? []);
    expect(inline.some((token) => token.type === 'link_open')).toBe(false);
    expect(
      inline
        .filter((token) => token.type === 'text')
        .map((token) => token.content)
        .join('\n'),
    ).toBe(notice);
  });
});
