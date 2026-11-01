/**
 * @fileoverview Tool for searching EPA enforcement cases by location, program, or date range,
 * one page at a time.
 * @module mcp-server/tools/definitions/echo-search-violations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import {
  echoQuery,
  effectiveQueryEnrichment,
  equalsTerm,
} from '@/mcp-server/tools/effective-query.js';
import { dollars } from '@/mcp-server/tools/format-dollars.js';
import { formatHeading } from '@/mcp-server/tools/format-heading.js';
import { formatNotice } from '@/mcp-server/tools/format-notice.js';
import {
  isCalendarDate,
  normalizeStateCode,
  normalizeZip,
  optionalStateSchema,
  optionalZipSchema,
} from '@/mcp-server/tools/input-formats.js';
import {
  clampLimit,
  continueGuidance,
  limitSchema,
  offsetSchema,
  pagingEnrichment,
  pagingTrailer,
} from '@/mcp-server/tools/paging.js';
import { getEchoService } from '@/services/echo/echo-service.js';

/** Default and most cases one call returns; a full page of 100 measures about 36 KB. */
const CASE_PAGE = { defaultLimit: 50, cap: 100 } as const;

/** The notice a date-bounded case_type "all" search carries. */
const CRIMINAL_EXCLUSION_NOTICE =
  'Criminal cases are excluded: ECHO records filing dates for civil cases only, so a filing-date range returns civil cases. Search case_type "criminal" without dates for criminal cases.';

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

export const echoSearchViolationsTool = tool('epa_echo_search_violations', {
  title: 'Search EPA Enforcement Cases',
  description:
    "ECHO: Search EPA civil and criminal enforcement cases by state, ZIP code, regulatory program, case type, or filing-date range. Returns case identifier, case type and status, lead agency (EPA or state), primary law and section, enforcement outcome, federal and state penalties, cost recovery, compliance action and SEP costs, and filing, settlement, and closing dates. Case rows name no facility: pass a civil caseId to epa_echo_get_case for the facilities, defendants, and settlements behind it. Designed for area-level violation discovery — for a single known facility's enforcement history use epa_echo_get_facility instead. At least one of state or zip_code is required. Page past limit with offset and nextOffset.",
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    state: optionalStateSchema(
      '2-letter state or territory code where the case is located (e.g. "TX", "PR"), case-insensitive. A case spanning several states matches each of them. ECHO also files some cases under codes outside the USPS set; any 2-character code is searched as written.',
    ),
    zip_code: optionalZipSchema(
      '5-digit ZIP code of the case\'s facility location; a ZIP+4 such as "98108-1234" searches its first five digits',
    ),
    program: z
      .enum(['CAA', 'CWA', 'RCRA', 'SDWA', 'CERCLA', 'EPCRA', 'FIFRA', 'TSCA'])
      .optional()
      .describe(
        "Filter by regulatory program: CAA=Clean Air Act, CWA=Clean Water Act, RCRA=hazardous waste, SDWA=drinking water, CERCLA=Superfund, EPCRA=emergency planning and community right-to-know (the statute behind TRI), FIFRA=pesticides, TSCA=toxic substances. Matches any law a case cites, so a returned case's programsViolated (its primary law) can differ.",
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
    limit: limitSchema({ ...CASE_PAGE, noun: 'cases' }),
    offset: offsetSchema('cases'),
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
                'Case number (e.g. "03-2014-7010"; criminal cases read "CR_1270") — pass a civil one to epa_echo_get_case',
              ),
            caseName: z.string().optional().describe('Case name or docket number'),
            caseType: z
              .string()
              .optional()
              .describe(
                'Case category: "Judicial" or "Administrative - Formal" for civil cases, "Criminal" for every criminal case',
              ),
            caseStatus: z
              .string()
              .optional()
              .describe(
                'Civil case status, e.g. "Closed", "Final Order Issued", "Final Order Entered", "Complaint Filed". Absent on criminal cases.',
              ),
            enforcementOutcome: z
              .string()
              .optional()
              .describe(
                'How the case was resolved, e.g. "Final Order With Penalty", "Final Order No Penalty". Absent when ECHO records none, and on criminal cases.',
              ),
            leadAgency: z.string().optional().describe('Agency leading the case: "EPA" or "State"'),
            programsViolated: z
              .string()
              .optional()
              .describe('Primary regulatory law cited (e.g. "CERCLA", "CAA", "CWA")'),
            primarySection: z
              .string()
              .optional()
              .describe(
                'Section of the primary law (e.g. "107A"); a criminal case cites the U.S. Code (e.g. "33 U.S.C. 1908(a)")',
              ),
            penaltyAssessedInDollars: z
              .number()
              .optional()
              .describe('Federal penalty assessed in dollars (parsed from ECHO dollar string)'),
            stateLocalPenaltyInDollars: z
              .number()
              .optional()
              .describe('State or local penalty assessed in dollars. Absent on criminal cases.'),
            costRecoveryInDollars: z
              .number()
              .optional()
              .describe(
                'Response costs the parties agreed or were ordered to repay, in dollars — the outcome of a CERCLA cost-recovery case. Absent on criminal cases.',
              ),
            complianceActionCostInDollars: z
              .number()
              .optional()
              .describe(
                'Estimated cost of the injunctive relief and other actions required to return to compliance, in dollars. Absent on criminal cases.',
              ),
            supplementalProjectCostInDollars: z
              .number()
              .optional()
              .describe(
                'Cost of Supplemental Environmental Projects the parties agreed to, in dollars. Absent on criminal cases.',
              ),
            filedDate: z
              .string()
              .optional()
              .describe(
                'Date the enforcement case was filed (MM/DD/YYYY) — the date the filing-date range bounds',
              ),
            settlementDate: z
              .string()
              .optional()
              .describe('Settlement or resolution date (MM/DD/YYYY)'),
            closedDate: z
              .string()
              .optional()
              .describe('Date the case was closed (MM/DD/YYYY). Absent while it is open.'),
          })
          .describe('EPA enforcement case record with case number, status, law, and outcome'),
      )
      .describe("One page of matching enforcement cases, in ECHO's order: limit cases from offset"),
    totalCount: z.number().describe('Cases matched before limit and offset were applied'),
    message: z
      .string()
      .optional()
      .describe(
        'Recovery hint when the page is empty: no case matched, or offset is past the last match. Absent when cases are returned.',
      ),
  }),

  enrichment: {
    ...effectiveQueryEnrichment,
    ...pagingEnrichment,
    notice: z
      .string()
      .optional()
      .describe(
        'Present when a filing-date range with case_type "all" left criminal cases out of the results, or when more cases follow (names the offset that continues the list).',
      ),
  },
  enrichmentTrailer: {
    ...pagingTrailer,
    notice: { render: formatNotice },
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
    // A blank optional value reads as omitted.
    const state = normalizeStateCode(input.state);
    const zipCode = normalizeZip(input.zip_code);
    if (!state && !zipCode) {
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

    const { limit, notice: limitNotice } = clampLimit(input.limit, CASE_PAGE.cap);
    if (limitNotice) ctx.enrich({ limitNotice });

    ctx.log.info('epa_echo_search_violations', {
      state,
      program: input.program,
      caseType: input.case_type,
      dateFiledStart,
      dateFiledEnd,
      limit,
      offset: input.offset,
    });

    const page = await getEchoService().searchViolations(
      {
        ...(state && { state }),
        ...(zipCode && { zipCode }),
        ...(input.program && { program: input.program }),
        ...(input.case_type && { caseType: input.case_type }),
        ...(dateFiledStart && { dateFiledStart }),
        ...(dateFiledEnd && { dateFiledEnd }),
        limit,
        offset: input.offset,
      },
      ctx,
    );

    // case_type "all" sends no filter; a date bound sends both ends, an open one as 1900 or today.
    echoQuery(ctx, [
      state && equalsTerm('state', state),
      zipCode && equalsTerm('zip_code', zipCode),
      input.program && equalsTerm('program', input.program),
      input.case_type !== 'all' && equalsTerm('case_type', input.case_type),
      page.filedDateRange && equalsTerm('date_filed_start', page.filedDateRange.start),
      page.filedDateRange && equalsTerm('date_filed_end', page.filedDateRange.end),
    ]);
    if (page.nextOffset !== undefined) ctx.enrich({ nextOffset: page.nextOffset });
    const notice = [
      dated && input.case_type === 'all' && CRIMINAL_EXCLUSION_NOTICE,
      page.nextOffset !== undefined && continueGuidance(page.nextOffset),
    ]
      .filter(Boolean)
      .join(' ');
    if (notice) ctx.enrich.notice(notice);

    ctx.log.info('epa_echo_search_violations completed', {
      count: page.items.length,
      totalCount: page.totalCount,
    });

    if (page.items.length === 0) {
      return {
        cases: [],
        totalCount: page.totalCount,
        message:
          page.totalCount === 0
            ? 'No enforcement cases matched. Try removing program or date filters, or expanding the geographic area.'
            : `offset ${input.offset} is past the last of the ${page.totalCount} matching cases; call again with a smaller offset.`,
      };
    }

    return { cases: page.items, totalCount: page.totalCount };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## EPA Enforcement Cases`);
    lines.push(`**Total Found:** ${result.totalCount} | **Returned:** ${result.cases.length}`);
    if (result.message) lines.push(`\n> ${escapeMarkdownInline(result.message)}`);

    for (const c of result.cases) {
      lines.push(`\n### ${formatHeading(c.caseName ?? c.caseId ?? 'Unnamed Case')}`);
      if (c.caseId) lines.push(`**Case ID:** ${escapeMarkdownInline(c.caseId)}`);
      if (c.programsViolated)
        lines.push(`**Programs:** ${escapeMarkdownInline(c.programsViolated)}`);
      if (c.primarySection)
        lines.push(`**Primary Section:** ${escapeMarkdownInline(c.primarySection)}`);
      if (c.caseType) lines.push(`**Type:** ${escapeMarkdownInline(c.caseType)}`);
      if (c.caseStatus) lines.push(`**Status:** ${escapeMarkdownInline(c.caseStatus)}`);
      if (c.leadAgency) lines.push(`**Lead:** ${escapeMarkdownInline(c.leadAgency)}`);
      if (c.enforcementOutcome)
        lines.push(`**Outcome:** ${escapeMarkdownInline(c.enforcementOutcome)}`);
      if (c.penaltyAssessedInDollars !== undefined) {
        lines.push(`**Penalty:** ${dollars(c.penaltyAssessedInDollars)}`);
      }
      if (c.stateLocalPenaltyInDollars !== undefined) {
        lines.push(`**State/Local Penalty:** ${dollars(c.stateLocalPenaltyInDollars)}`);
      }
      if (c.costRecoveryInDollars !== undefined) {
        lines.push(`**Cost Recovery:** ${dollars(c.costRecoveryInDollars)}`);
      }
      if (c.complianceActionCostInDollars !== undefined) {
        lines.push(`**Compliance Action Cost:** ${dollars(c.complianceActionCostInDollars)}`);
      }
      if (c.supplementalProjectCostInDollars !== undefined) {
        lines.push(`**SEP Cost:** ${dollars(c.supplementalProjectCostInDollars)}`);
      }
      if (c.filedDate) lines.push(`**Filed:** ${escapeMarkdownInline(c.filedDate)}`);
      if (c.settlementDate) lines.push(`**Settlement:** ${escapeMarkdownInline(c.settlementDate)}`);
      if (c.closedDate) lines.push(`**Closed:** ${escapeMarkdownInline(c.closedDate)}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
