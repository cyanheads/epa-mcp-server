/**
 * @fileoverview Tests for echoGetCaseTool, through the real EchoService with `fetch` stubbed at
 * the HTTP boundary over recorded get_case_report bodies (#59).
 * @module tests/mcp-server/tools/definitions/echo-get-case.tool.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import MarkdownIt from 'markdown-it';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { echoGetCaseTool } from '@/mcp-server/tools/definitions/echo-get-case.tool.js';
import { initEchoService } from '@/services/echo/echo-service.js';
import { textOf } from '../../../helpers.js';
import {
  CASE_REPORT_03_2014_7010,
  CASE_REPORT_06_2001_0066,
  CASE_REPORT_10_2026_0276,
  CASE_REPORT_INVALID,
  CASE_REPORT_WA_100446,
} from '../../../services/echo/echo-fixtures.js';

const markdown = new MarkdownIt();

/** Answers every request with `body` and records each requested URL. */
function serve(body: unknown): URL[] {
  const urls: URL[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    urls.push(new URL(String(input)));
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });
  return urls;
}

/**
 * The rendered Markdown as a CommonMark client reads it: each heading's text mapped to the text of
 * every line of the paragraphs and list items under it, in order. Consecutive `**Label:** value`
 * lines form one paragraph, so a soft break separates entries; a hard break stays inside one.
 * Text before the first heading sits under "".
 */
function readSections(text: string): Map<string, string[]> {
  const tokens = markdown.parse(text, {});
  const sections = new Map<string, string[]>([['', []]]);
  let heading = '';
  tokens.forEach((token, index) => {
    if (token.type !== 'inline') return;
    const lines = [''];
    for (const child of token.children ?? []) {
      if (child.type === 'softbreak') lines.push('');
      else lines[lines.length - 1] += child.type === 'hardbreak' ? '\n' : child.content;
    }
    if (tokens[index - 1]?.type === 'heading_open') {
      heading = lines.join('\n');
      sections.set(heading, []);
    } else {
      sections.get(heading)!.push(...lines);
    }
  });
  return sections;
}

const CASE_REGISTRY_IDS = [
  '110009259729',
  '110009281767',
  '110013802572',
  '110015665528',
  '110025329829',
  '110033144817',
  '110070408553',
];

/** ECHO's answer to get_case_report?p_id=CR_1270: the report covers civil cases only. */
const CRIMINAL_REFUSAL = {
  Error: { ErrorMessage: 'Case Number or Activity Id CR_1270 is invalid.' },
};

const CRIMINAL_HINT =
  'Pass a civil case number instead; for a criminal case, use its row from epa_echo_search_violations with case_type criminal.';
const NOT_FOUND_HINT =
  "Check the case number: find civil case IDs with epa_echo_search_violations, or a formal action's caseId with epa_echo_get_facility, then retry.";

beforeEach(() => {
  initEchoService(
    { pkg: { name: '@cyanheads/epa-mcp-server', version: '0.0.0' } } as AppConfig,
    {} as StorageService,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('echoGetCaseTool', () => {
  it('returns the 7 distinct facilities of 03-2014-7010 on both surfaces from one report request', async () => {
    const urls = serve(CASE_REPORT_03_2014_7010);

    const result = await runToolContract(echoGetCaseTool, { case_id: '03-2014-7010' });

    expect(result.isError).toBeFalsy();
    expect(urls).toHaveLength(1);
    expect(urls[0]!.pathname).toMatch(/\/case_rest_services\.get_case_report$/);
    expect(urls[0]!.searchParams.get('p_id')).toBe('03-2014-7010');
    const report = result.structuredContent as {
      facilities: Array<{ registryId?: string; state?: string }>;
      defendants: Array<{ name?: string }>;
      lawsAndSections: Array<{ law?: string; sections?: string }>;
    };
    expect(report.facilities.map((f) => f.registryId)).toEqual(CASE_REGISTRY_IDS);
    expect(report.facilities).toContainEqual(
      expect.objectContaining({ registryId: '110009259729', state: 'WA' }),
    );
    expect(report.facilities).toContainEqual(
      expect.objectContaining({ registryId: '110025329829', state: 'PA' }),
    );
    expect(report.defendants.map((d) => d.name)).toEqual(['HOME INSURANCE COMPANY']);
    expect(report.lawsAndSections).toEqual([
      { law: 'CERCLA', sections: '107A: Cost Recovery', programs: 'Cost Recovery/Financial' },
    ]);

    const sections = readSections(textOf(result.content));
    expect(sections.get('Facilities (7)')).toEqual([
      'Pass a Registry ID to epa_echo_get_facility for its compliance profile.',
      '110009259729 — LOWER DUWAMISH WATERWAY — RK 2.5 TO RK 10.8, SEATTLE, WA, 98168 — NAICS 331111 — program IDs ICIS 41027, SEMS WA0002329803 — exists (FRS)',
      '110009281767 — PETROLEUM PRODUCTS CORP. — 14000 BLOCK PEMBROKE ROAD, PEMBROKE PARK, FL, 33024 — NAICS 331111 — program IDs ICIS 3601131367, SEMS FLD980798698 — exists (FRS)',
      "110013802572 — LEE'S LANE LANDFILL — LEES LN @ OHIO RIV, LOUISVILLE, KY, 40216 — NAICS 331111 — program IDs ICIS 3601131366, SEMS KYD980557052 — exists (FRS)",
      '110015665528 — U.S. OIL RECOVERY — 400 N RICHEY ST, PASADENA, TX, 77506 — NAICS 331111 — program IDs SEMS TXN000607093, ICIS 1000005122 — exists (FRS)',
      '110025329829 — SHARON STEEL CORP (FARRELL WORKS DISPOSAL AREA) — 300 OHIO STREET, HERMITAGE, PA, 16159 — program IDs SEMS PAD001933175 — exists (FRS)',
      '110033144817 — SHARON STEEL CORP STEEL DIV — 15 ROEMER BLVD, FARRELL, PA, 16121 — NAICS 331513 — program IDs ICIS 3400053150 — exists (FRS)',
      '110070408553 — SAN GABRIEL VALLEY AREA 2 — SUNSET & SAN BERNARDINO FRWY, BALDWIN PARK, CA, 91706 — NAICS 331111 — program IDs ICIS 3601131351 — exists (FRS)',
    ]);
    expect(sections.get('Defendants (1)')).toEqual([
      'HOME INSURANCE COMPANY — named in complaint — named in settlement',
    ]);
    expect(sections.get('Laws and Sections')).toEqual([
      'CERCLA — 107A: Cost Recovery — Cost Recovery/Financial',
    ]);
    expect(sections.get('Pollutants')).toEqual([
      'Arsenic — CAS 7440382',
      'Barium — CAS 7440393',
      'Cadmium — CAS 7440439',
      'Chromium — CAS 7440473',
      'Lead — CAS 7439921',
    ]);
    expect(
      sections.get(
        'Conclusion 1: HOME INSURANCE COMPANY (SHARON STEEL CORP FARRELL WORKS DISPOSAL AREA)',
      ),
    ).toEqual([
      'Conclusion ID: 3600139220',
      'Type: Consent Decree or Court Order Resolving a Civil Judicial Action',
      `Facilities: ${CASE_REGISTRY_IDS.join(', ')}`,
      'Entered: 03/26/2019',
      'Lodged: 03/26/2019',
      'Federal Penalty: $0 | Compliance Action Cost: $0 | Cost Recovery: $27,044,146',
    ]);
  });

  it('renders every section of an administrative case: summary, laws, facility, defendants, pollutants, milestones, and a conclusion with complying actions and a pollutant reduction', async () => {
    serve(CASE_REPORT_10_2026_0276);

    const result = await runToolContract(echoGetCaseTool, { case_id: '10-2026-0276' });
    const sections = readSections(textOf(result.content));

    expect([...sections.keys()]).toEqual([
      '',
      'OLYMPIC PIPELINE',
      'Summary',
      'Laws and Sections',
      'Facilities (1)',
      'Defendants (2)',
      'Pollutants',
      'Milestones',
      'Enforcement Conclusions (1)',
      'Conclusion 1: OLYMPIC PIPELINE',
    ]);
    expect(sections.get('OLYMPIC PIPELINE')).toEqual([
      'Case ID: 10-2026-0276',
      'Category Code: AFR',
      'Enforcement Type: CWA 309A AO For Compliance',
      'Status: Final Order Issued',
      'Status Date: 09/30/2026',
      'Lead: EPA',
      'Relief Sought: Injunctive Relief',
      'Outcome: Final Order No Penalty',
      'Violations: Oil Spill Violation Under CWA/OPA',
      'Federal Penalty: $0 | State/Local Penalty: $0 | Penalty Collected: $0 | SEP Cost: $0 | Compliance Action Cost: $843,500 | Cost Recovery: $0',
    ]);
    expect(sections.get('Summary')).toEqual([
      CASE_REPORT_10_2026_0276.Results.CaseInformation.CaseSummary,
    ]);
    expect(sections.get('Laws and Sections')).toEqual([
      'CWA — 311B: Oil & Hazardous Substances Discharge — Spills',
    ]);
    expect(sections.get('Facilities (1)')).toEqual([
      'Pass a Registry ID to epa_echo_get_facility for its compliance profile.',
      '110071860973 — BP OLYMPIC PIPELINE — ,, MOUNT VERNON, WA, 98274 — NAICS 486110 — SIC 4612 — program IDs ICIS 3601735460 — exists (FRS)',
    ]);
    expect(sections.get('Defendants (2)')).toEqual([
      'BP Pipelines (North America) Inc. — named in complaint — named in settlement',
      'Olympic Pipe Line Company LLC — named in complaint — named in settlement',
    ]);
    expect(sections.get('Pollutants')).toEqual(['Gasoline — CAS 86290815']);
    expect(sections.get('Milestones')).toEqual([
      '09/03/2026 — Enforcement Action Data Entered',
      '09/30/2026 — Complaint Filed/Proposed Order',
      '09/30/2026 — Final Order Issued',
    ]);
    expect(sections.get('Conclusion 1: OLYMPIC PIPELINE')).toEqual([
      'Conclusion ID: 3600613803',
      'Type: Administrative Compliance Orders',
      'Facilities: 110071860973',
      'Entered: 09/30/2026',
      'Federal Penalty: $0 | Compliance Action Cost: $843,500 | Cost Recovery: $0',
      'Complying action: WEM Environmental Management Review — Work Practices',
      'Complying action: WRP Reporting — Work Practices',
      'Complying action: WWP Work Practices — Work Practices',
      'Complying action: WTA Training — Work Practices',
      'Complying action: WPL Planning — Work Practices',
      'Complying action: WMO Monitoring — Work Practices',
      'Complying action: XPI Plan Implementation — Prevention of Future Releases',
      'Pollutant reduction: Gasoline — 21,168 gal a year — Land — by complying action',
    ]);
  });

  it('renders Supplemental Environmental Projects with their cost, and a conclusion closing and termination', async () => {
    serve(CASE_REPORT_06_2001_0066);

    const result = await runToolContract(echoGetCaseTool, { case_id: '06-2001-0066' });
    const conclusion = readSections(textOf(result.content)).get(
      'Conclusion 1: AIR LIQUIDE AMERICA CORPORATION(NC)(LEAD)',
    );

    expect(conclusion).toEqual(
      expect.arrayContaining([
        'Lodged: 05/21/2001',
        'Closed: 05/01/2017',
        'Terminated: 05/01/2017',
        'Federal Penalty: $4,500,000 | SEP Cost: $500,000 | Compliance Action Cost: $12,000,000 | Cost Recovery: $0',
        'Pollutant reduction: HCFC [hydrochlorofluorocarbons] — 15 tons a year — Air — by complying action',
        'SEP: EPP Emergency Planning and Preparedness — $78,000 — Donate and deed property to Fire Protection District No. Two of Ward Four of Calcasieu Parish for construction of a new two-bay fire and emergency response station.',
        'SEP: PRD Pollution Reduction — $422,000 — Donate and deed parcel of land to be used as  green space  to Calcasieu Parish.  Land located in EJ community will not be developed for industrial use.',
      ]),
    );
  });

  it('omits the sections a state-led case leaves empty and keeps its facility', async () => {
    serve(CASE_REPORT_WA_100446);

    const result = await runToolContract(echoGetCaseTool, { case_id: 'WA-100446' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      caseId: 'WA-100446',
      leadAgency: 'State',
      defendants: [],
      pollutants: [],
      facilities: [expect.objectContaining({ registryId: '110015554425' })],
    });
    expect(result.structuredContent).not.toHaveProperty('summary');
    const sections = readSections(textOf(result.content));
    expect(sections.has('Summary')).toBe(false);
    expect([...sections.keys()].some((heading) => heading.startsWith('Defendants'))).toBe(false);
    expect(sections.has('Pollutants')).toBe(false);
    expect(sections.get('Facilities (1)')?.[1]).toMatch(/^110015554425 — VADER STP — /);
  });

  it('says so when a report lists no facility', () => {
    const blocks = echoGetCaseTool.format!({
      caseId: 'X-1',
      lawsAndSections: [],
      facilities: [],
      defendants: [],
      pollutants: [],
      milestones: [],
      enforcementConclusions: [],
    });

    expect((blocks[0] as { text: string }).text.split('\n')).toEqual([
      '## X-1',
      '**Case ID:** X-1',
      '',
      '### Facilities (0)',
      'ECHO lists no facility for this case.',
    ]);
  });

  it('trims the case number before the request', async () => {
    const urls = serve(CASE_REPORT_03_2014_7010);

    await runToolContract(echoGetCaseTool, { case_id: '  03-2014-7010\n' });

    expect(urls[0]!.searchParams.get('p_id')).toBe('03-2014-7010');
  });

  it.each([null, { ErrorMessage: '' }, { ErrorMessage: null }])(
    'maps a successful report that carries top-level Error %j',
    async (error) => {
      serve({ ...CASE_REPORT_WA_100446, Error: error });

      const result = await runToolContract(echoGetCaseTool, { case_id: 'WA-100446' });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ caseId: 'WA-100446' });
    },
  );

  describe('errors', () => {
    it.each(['CR_1270', 'cr_1270', ' CR_1270 '])(
      'refuses criminal case number %j as criminal_case before any request',
      async (caseId) => {
        const urls = serve(CRIMINAL_REFUSAL);
        const ctx = createMockContext({ errors: echoGetCaseTool.errors });

        await expect(
          echoGetCaseTool.handler(echoGetCaseTool.input.parse({ case_id: caseId }), ctx),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'criminal_case', caseId: caseId.trim() },
        });
        expect(urls).toHaveLength(0);
      },
    );

    it('carries the criminal_case recovery on both surfaces', async () => {
      const urls = serve(CRIMINAL_REFUSAL);

      const result = await runToolContract(echoGetCaseTool, { case_id: 'CR_1270' });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'criminal_case', recovery: { hint: CRIMINAL_HINT } },
        },
      });
      expect(textOf(result.content)).toContain(CRIMINAL_HINT);
      expect(urls).toHaveLength(0);
    });

    it('fails an unknown case number as case_not_found after one request, with its recovery on both surfaces', async () => {
      const urls = serve(CASE_REPORT_INVALID);

      const result = await runToolContract(echoGetCaseTool, { case_id: '99-9999-9999' });

      expect(urls).toHaveLength(1);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          data: {
            reason: 'case_not_found',
            caseId: '99-9999-9999',
            recovery: { hint: NOT_FOUND_HINT },
          },
        },
      });
      const text = textOf(result.content);
      expect(text).toContain('99-9999-9999');
      expect(text).toContain(NOT_FOUND_HINT);
    });

    it('rejects a blank case number at the schema without a request', async () => {
      const urls = serve(CASE_REPORT_INVALID);

      const result = await runToolContract(echoGetCaseTool, { case_id: '   ' });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expect(urls).toHaveLength(0);
    });
  });
});
