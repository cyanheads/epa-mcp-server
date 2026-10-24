/**
 * @fileoverview Tool for searching EPA enforcement cases by location, program, or date range.
 * @module mcp-server/tools/definitions/echo-search-violations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEchoService } from '@/services/echo/echo-service.js';

/**
 * A YYYY-MM-DD date, or a blank string for none; surrounding whitespace is trimmed. Calendar
 * validity is checked in the handler.
 */
const filingDate = z.union([
  z.string().trim().length(0).describe('No bound'),
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD form, e.g. 2024-01-31.')
    .describe('Date in YYYY-MM-DD form'),
]);

/** True when a YYYY-MM-DD string names a real calendar day (rejects 2024-02-30). */
const isCalendarDate = (iso: string): boolean => {
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(iso);
};

export const echoSearchViolationsTool = tool('epa_echo_search_violations', {
  title: 'Search EPA Enforcement Cases',
  description:
    "ECHO: Search EPA civil and criminal enforcement cases by state, ZIP code, regulatory program, case type, or filing-date range. Returns case identifier, programs involved, penalty assessed, settlement and filing dates, and case type. Designed for area-level violation discovery — for a single known facility's enforcement history use epa_echo_get_facility instead. At least one of state or zip_code is required.",
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    state: z
      .string()
      .optional()
      .describe('2-letter US state abbreviation to filter cases (e.g. "TX", "CA")'),
    zip_code: z.string().optional().describe("5-digit ZIP code of the case's facility location"),
    program: z
      .enum(['CAA', 'CWA', 'RCRA', 'SDWA', 'CERCLA', 'FIFRA', 'TSCA'])
      .optional()
      .describe(
        "Filter by regulatory program: CAA=Clean Air Act, CWA=Clean Water Act, RCRA=hazardous waste, SDWA=drinking water, CERCLA=Superfund, FIFRA=pesticides, TSCA=toxic substances. Matches any law a case cites, so a returned case's programsViolated (its primary law) can differ.",
      ),
    case_type: z
      .enum(['civil', 'criminal', 'all'])
      .default('all')
      .describe(
        'Filter by case type: civil (regulatory violations), criminal (willful violations), or all. A filing-date range covers civil cases only: with a date, all returns civil cases and criminal is rejected.',
      ),
    date_filed_start: filingDate
      .optional()
      .describe(
        'Earliest filing date, inclusive (YYYY-MM-DD). Civil cases only. Omit, or pass "", for no lower bound.',
      ),
    date_filed_end: filingDate
      .optional()
      .describe(
        'Latest filing date, inclusive (YYYY-MM-DD). Civil cases only. Omit, or pass "", for no upper bound.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50)
      .describe('Maximum number of cases to return (1–100)'),
  }),

  output: z.object({
    cases: z
      .array(
        z
          .object({
            caseId: z
              .string()
              .optional()
              .describe(
                'Case number / docket identifier (e.g. "03-2014-7010") — primary case reference',
              ),
            caseName: z.string().optional().describe('Case name or docket number'),
            facilityName: z
              .string()
              .optional()
              .describe(
                'Regulated facility name — not available in ECHO enforcement case records; use epa_echo_get_facility with a Registry ID for facility details',
              ),
            registryId: z
              .string()
              .optional()
              .describe(
                'EPA Registry ID — not returned in enforcement case search results; obtain via epa_echo_search_facilities',
              ),
            programsViolated: z
              .string()
              .optional()
              .describe('Primary regulatory law cited (e.g. "CERCLA", "CAA", "CWA")'),
            caseType: z
              .string()
              .optional()
              .describe('Case category (e.g. "Judicial", "Administrative - Formal")'),
            penaltyAssessedInDollars: z
              .number()
              .optional()
              .describe('Federal penalty assessed in dollars (parsed from ECHO dollar string)'),
            settlementDate: z
              .string()
              .optional()
              .describe('Settlement or resolution date (MM/DD/YYYY)'),
            filedDate: z
              .string()
              .optional()
              .describe(
                'Date the enforcement case was filed (MM/DD/YYYY) — the date the filing-date range bounds',
              ),
            state: z
              .string()
              .optional()
              .describe(
                'State where the facility is located — not returned in enforcement case search results',
              ),
          })
          .describe('EPA enforcement case record with case number, program, and penalty details'),
      )
      .describe('Matching enforcement cases'),
    totalCount: z.number().describe('Total cases matched before the limit was applied'),
    message: z
      .string()
      .optional()
      .describe(
        'Recovery hint when no cases are found — echoes filters and suggests broadening. Absent when cases are returned.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Present when a filing-date range with case_type "all" left criminal cases out of the results.',
      ),
  },

  errors: [
    {
      reason: 'no_geographic_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither state nor zip_code was provided.',
      recovery: 'Provide at least one of state or zip_code to scope the enforcement case search.',
    },
    {
      reason: 'invalid_date',
      code: JsonRpcErrorCode.ValidationError,
      when: 'date_filed_start or date_filed_end is not a real calendar date, such as 2024-02-30.',
      recovery: 'Pass a real calendar date in YYYY-MM-DD form, such as 2024-02-29.',
    },
    {
      reason: 'date_range_inverted',
      code: JsonRpcErrorCode.ValidationError,
      when: 'date_filed_start is later than date_filed_end.',
      recovery: 'Swap the two dates so date_filed_start is on or before date_filed_end.',
    },
    {
      reason: 'criminal_date_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'case_type "criminal" was combined with a filing-date bound, which ECHO records for civil cases only.',
      recovery:
        'Drop date_filed_start and date_filed_end to search criminal cases, or set case_type to civil.',
    },
  ],

  async handler(input, ctx) {
    if (!input.state?.trim() && !input.zip_code?.trim()) {
      throw ctx.fail(
        'no_geographic_filter',
        'At least one of state or zip_code is required to search enforcement cases.',
      );
    }

    const dateFiledStart = input.date_filed_start || undefined;
    const dateFiledEnd = input.date_filed_end || undefined;
    for (const [field, value] of [
      ['date_filed_start', dateFiledStart],
      ['date_filed_end', dateFiledEnd],
    ] as const) {
      if (value !== undefined && !isCalendarDate(value)) {
        throw ctx.fail('invalid_date', `${field} "${value}" is not a calendar date.`, { field });
      }
    }
    if (dateFiledStart && dateFiledEnd && dateFiledStart > dateFiledEnd) {
      throw ctx.fail(
        'date_range_inverted',
        `date_filed_start ${dateFiledStart} is after date_filed_end ${dateFiledEnd}.`,
      );
    }
    const dated = dateFiledStart !== undefined || dateFiledEnd !== undefined;
    if (dated && input.case_type === 'criminal') {
      throw ctx.fail(
        'criminal_date_filter',
        'ECHO records filing dates for civil cases only, so a filing-date range cannot select criminal cases.',
      );
    }

    ctx.log.info('epa_echo_search_violations', {
      state: input.state,
      program: input.program,
      caseType: input.case_type,
      dateFiledStart,
      dateFiledEnd,
    });

    const state = input.state?.trim();
    const zipCode = input.zip_code?.trim();
    const { cases, totalCount } = await getEchoService().searchViolations(
      {
        ...(state && { state }),
        ...(zipCode && { zipCode }),
        ...(input.program && { program: input.program }),
        ...(input.case_type && { caseType: input.case_type }),
        ...(dateFiledStart && { dateFiledStart }),
        ...(dateFiledEnd && { dateFiledEnd }),
        limit: input.limit,
      },
      ctx,
    );

    ctx.log.info('epa_echo_search_violations completed', { count: cases.length, totalCount });
    if (dated && input.case_type === 'all') {
      ctx.enrich.notice(
        'Criminal cases are excluded: ECHO records filing dates for civil cases only, so a filing-date range returns civil cases. Search case_type "criminal" without dates for criminal cases.',
      );
    }

    if (cases.length === 0) {
      const parts: string[] = [];
      if (input.state) parts.push(`state="${input.state}"`);
      if (input.zip_code) parts.push(`zip_code="${input.zip_code}"`);
      if (input.program) parts.push(`program="${input.program}"`);
      if (input.case_type && input.case_type !== 'all')
        parts.push(`case_type="${input.case_type}"`);
      if (dateFiledStart) parts.push(`date_filed_start="${dateFiledStart}"`);
      if (dateFiledEnd) parts.push(`date_filed_end="${dateFiledEnd}"`);
      return {
        cases: [],
        totalCount: 0,
        message: `No enforcement cases matched: ${parts.join(', ')}. Try removing program or date filters, or expanding the geographic area.`,
      };
    }

    return { cases, totalCount };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## EPA Enforcement Cases`);
    lines.push(`**Total Found:** ${result.totalCount} | **Returned:** ${result.cases.length}`);
    if (result.message) lines.push(`\n> ${result.message}`);

    for (const c of result.cases) {
      lines.push(`\n### ${c.caseName ?? c.caseId ?? 'Unnamed Case'}`);
      if (c.caseId) lines.push(`**Case ID:** ${c.caseId}`);
      if (c.facilityName) lines.push(`**Facility:** ${c.facilityName}`);
      if (c.registryId) lines.push(`**Registry ID:** ${c.registryId}`);
      if (c.state) lines.push(`**State:** ${c.state}`);
      if (c.programsViolated) lines.push(`**Programs:** ${c.programsViolated}`);
      if (c.caseType) lines.push(`**Type:** ${c.caseType}`);
      if (c.penaltyAssessedInDollars !== undefined) {
        lines.push(`**Penalty:** $${c.penaltyAssessedInDollars.toLocaleString()}`);
      }
      if (c.filedDate) lines.push(`**Filed:** ${c.filedDate}`);
      if (c.settlementDate) lines.push(`**Settlement:** ${c.settlementDate}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
