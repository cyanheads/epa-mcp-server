/**
 * @fileoverview Tool for searching EPA enforcement cases by location, program, or date range.
 * @module mcp-server/tools/definitions/search-violations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEchoService } from '@/services/echo/echo-service.js';

export const searchViolationsTool = tool('epa_search_violations', {
  title: 'Search EPA Enforcement Cases',
  description:
    "Search EPA civil and criminal enforcement cases by state, regulatory program, or date range. Returns case identifier, regulated facility name and Registry ID, programs involved, penalty assessed, settlement date, and case type. Designed for area-level violation discovery — for a single known facility's enforcement history use epa_get_facility instead. At least one of state or zip_code is required.",
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    state: z
      .string()
      .optional()
      .describe('2-letter US state abbreviation to filter cases (e.g. "TX", "CA")'),
    zip_code: z.string().optional().describe('5-digit ZIP code to filter cases near that area'),
    program: z
      .enum(['CAA', 'CWA', 'RCRA', 'SDWA', 'CERCLA', 'FIFRA', 'TSCA'])
      .optional()
      .describe(
        'Filter by regulatory program: CAA=Clean Air Act, CWA=Clean Water Act, RCRA=hazardous waste, SDWA=drinking water, CERCLA=Superfund, FIFRA=pesticides, TSCA=toxic substances',
      ),
    case_type: z
      .enum(['civil', 'criminal', 'all'])
      .default('all')
      .describe(
        'Filter by case type: civil (regulatory violations), criminal (willful violations), or all',
      ),
    date_filed_start: z
      .string()
      .optional()
      .describe('Start date for case filing date range (ISO 8601: YYYY-MM-DD)'),
    date_filed_end: z
      .string()
      .optional()
      .describe('End date for case filing date range (ISO 8601: YYYY-MM-DD)'),
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
                'Regulated facility name — not available in ECHO enforcement case records; use epa_get_facility with a Registry ID for facility details',
              ),
            registryId: z
              .string()
              .optional()
              .describe(
                'EPA Registry ID — not returned in enforcement case search results; obtain via epa_search_facilities',
              ),
            programsViolated: z
              .string()
              .optional()
              .describe('Primary regulatory law cited (e.g. "CERCLA", "CAA", "CWA")'),
            caseType: z
              .string()
              .optional()
              .describe('Case category (e.g. "Judicial", "Administrative")'),
            penaltyAssessedInDollars: z
              .number()
              .optional()
              .describe('Federal penalty assessed in dollars (parsed from ECHO dollar string)'),
            settlementDate: z.string().optional().describe('Settlement or resolution date'),
            filedDate: z.string().optional().describe('Date the enforcement case was filed'),
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

  errors: [
    {
      reason: 'no_geographic_filter',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Neither state nor zip_code was provided.',
      recovery: 'Provide at least one of state or zip_code to scope the enforcement case search.',
    },
  ],

  async handler(input, ctx) {
    if (!input.state?.trim() && !input.zip_code?.trim()) {
      throw ctx.fail(
        'no_geographic_filter',
        'At least one of state or zip_code is required to search enforcement cases.',
        {
          ...ctx.recoveryFor('no_geographic_filter'),
        },
      );
    }

    ctx.log.info('epa_search_violations', {
      state: input.state,
      program: input.program,
      caseType: input.case_type,
    });

    const state = input.state?.trim();
    const zipCode = input.zip_code?.trim();
    const dateFiledStart = input.date_filed_start?.trim();
    const dateFiledEnd = input.date_filed_end?.trim();
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

    ctx.log.info('epa_search_violations completed', { count: cases.length, totalCount });

    if (cases.length === 0) {
      const parts: string[] = [];
      if (input.state) parts.push(`state="${input.state}"`);
      if (input.zip_code) parts.push(`zip_code="${input.zip_code}"`);
      if (input.program) parts.push(`program="${input.program}"`);
      if (input.case_type && input.case_type !== 'all')
        parts.push(`case_type="${input.case_type}"`);
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
