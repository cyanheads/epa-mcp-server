/**
 * @fileoverview Tool for retrieving one civil enforcement case and the facilities, defendants,
 * and settlements behind it.
 * @module mcp-server/tools/definitions/echo-get-case.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { dollars } from '@/mcp-server/tools/format-dollars.js';
import { formatHeading } from '@/mcp-server/tools/format-heading.js';
import {
  nextOffsetLine,
  offsetSchema,
  pageLabel,
  wholeListLimitSchema,
} from '@/mcp-server/tools/paging.js';
import { getEchoService } from '@/services/echo/echo-service.js';
import { slicePage } from '@/services/page.js';

/** ECHO's criminal case numbers ("CR_1270"); its civil case report rejects them. */
const CRIMINAL_CASE_NUMBER = /^CR_/i;

/** "named in complaint" / "not named in complaint"; nothing when ECHO leaves the flag unset. */
const namedIn = (flag: boolean | undefined, document: string): string | undefined =>
  flag === undefined ? undefined : `${flag ? 'named' : 'not named'} in ${document}`;

/** `**Label:** value` for each set money field, joined on one line. */
function moneyLine(fields: Array<[label: string, amount: number | undefined]>): string | undefined {
  const parts = fields.flatMap(([label, amount]) =>
    amount === undefined ? [] : [`**${label}:** ${dollars(amount)}`],
  );
  return parts.length > 0 ? parts.join(' | ') : undefined;
}

export const echoGetCaseTool = tool('epa_echo_get_case', {
  title: 'Get EPA Enforcement Case',
  description:
    "ECHO: Retrieve one civil enforcement case by case number, with the facilities, defendants, and settlements behind it. Returns the case's category, enforcement type, status, lead agency, relief sought, outcome, court and DOJ docket numbers, summary, and penalty, cost-recovery, compliance-action, and SEP totals; the laws and sections cited; the facilities the case names, one per EPA Registry ID, with address, NAICS and SIC codes, and the program IDs the case links (pass a registryId to epa_echo_get_facility for its compliance profile); defendants; pollutants; milestones; and the enforcement conclusions (orders, consent decrees, or other settlements), each with its facilities, dates, penalties and costs, complying actions, pollutant reductions, and Supplemental Environmental Projects. Facilities and enforcement conclusions come a page at a time and everything else whole on every page; each call re-reads the whole case report, so one call with a larger limit costs less than several pages. Take the case number from epa_echo_search_violations or from a formal action's caseId in epa_echo_get_facility. Civil cases only: a criminal CR_ case number fails before any request.",
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    case_id: z
      .string()
      .trim()
      .min(1)
      .describe(
        'Civil enforcement case number: a caseId from epa_echo_search_violations (e.g. "03-2014-7010", "WA-100446") or a formal action\'s caseId from epa_echo_get_facility (e.g. "WAPSCAF000000000000000416"). Criminal case numbers ("CR_1270") are rejected.',
      ),
    facilities_limit: wholeListLimitSchema({
      defaultLimit: 25,
      noun: 'facilities',
      offsetParam: 'facilities_offset',
      nextOffsetField: 'facilitiesNextOffset',
    }),
    facilities_offset: offsetSchema('facilities', 'facilitiesNextOffset'),
    enforcement_conclusions_limit: wholeListLimitSchema({
      defaultLimit: 10,
      noun: 'enforcement conclusions',
      offsetParam: 'enforcement_conclusions_offset',
      nextOffsetField: 'enforcementConclusionsNextOffset',
    }),
    enforcement_conclusions_offset: offsetSchema(
      'enforcement conclusions',
      'enforcementConclusionsNextOffset',
    ),
  }),

  output: z.object({
    caseId: z.string().describe('Case number'),
    caseName: z.string().optional().describe('Absent when ECHO records none'),
    caseCategoryCode: z
      .string()
      .optional()
      .describe('"JDC" civil judicial, "AFR" administrative formal'),
    enforcementType: z.string().optional().describe('Kind of enforcement action'),
    caseStatus: z.string().optional().describe('Case status'),
    caseStatusDate: z.string().optional().describe('MM/DD/YYYY'),
    leadAgency: z.string().optional().describe('"EPA" or "State"'),
    reliefSought: z.string().optional().describe('Absent when ECHO records none'),
    enforcementOutcome: z.string().optional().describe('How the case was resolved'),
    courtDocketNumber: z.string().optional().describe("Court's or region's docket number"),
    dojDocketNumber: z.string().optional().describe('DOJ docket number'),
    violations: z.string().optional().describe('Violation description'),
    summary: z.string().optional().describe('As EPA wrote it'),
    penaltyAssessedInDollars: z.number().optional().describe('Federal, whole case, in dollars'),
    stateLocalPenaltyInDollars: z
      .number()
      .optional()
      .describe('State or local, whole case, in dollars'),
    penaltyCollectedInDollars: z.number().optional().describe('Recorded as collected, in dollars'),
    supplementalProjectCostInDollars: z.number().optional().describe('Agreed SEP cost, in dollars'),
    complianceActionCostInDollars: z
      .number()
      .optional()
      .describe('Estimated cost of injunctive relief to return to compliance, in dollars'),
    costRecoveryInDollars: z
      .number()
      .optional()
      .describe('Response costs agreed or ordered repaid (CERCLA), in dollars'),
    lawsAndSections: z
      .array(
        z
          .object({
            law: z.string().optional().describe('Statute'),
            sections: z.string().optional().describe('Comma-separated'),
            programs: z.string().optional().describe('Programs the sections fall under'),
          })
          .describe('One statute'),
      )
      .describe('Statutes and sections cited'),
    facilities: z
      .array(
        z
          .object({
            registryId: z
              .string()
              .optional()
              .describe(
                'Pass as registry_id to epa_echo_get_facility; absent when ECHO records none',
              ),
            name: z.string().optional().describe('Facility name'),
            street: z.string().optional().describe('Street address'),
            city: z.string().optional().describe('City'),
            state: z.string().optional().describe('State code'),
            zip: z.string().optional().describe('ZIP code'),
            naicsCodes: z.array(z.string()).describe("Each once, ECHO's order"),
            sicCodes: z.array(z.string()).describe("Each once, ECHO's order"),
            programIds: z
              .array(
                z
                  .object({
                    id: z.string().describe('Program ID'),
                    system: z.string().optional().describe('System of the ID'),
                  })
                  .describe('One program ID'),
              )
              .describe("Linked program IDs, ECHO's order"),
            noLongerExists: z
              .boolean()
              .optional()
              .describe('True when FRS marks it no longer existing'),
          })
          .describe('One facility'),
      )
      .describe('One per Registry ID, possibly in several states'),
    facilitiesTotal: z.number().describe('Across every page'),
    facilitiesNextOffset: z
      .number()
      .optional()
      .describe('Next facilities_offset; absent on the last page'),
    defendants: z
      .array(
        z
          .object({
            name: z.string().optional().describe('Defendant name'),
            namedInComplaint: z.boolean().optional().describe('True when the complaint names them'),
            namedInSettlement: z.boolean().optional().describe('True when a settlement names them'),
          })
          .describe('One defendant'),
      )
      .describe('Empty when ECHO records none, as on many state cases'),
    pollutants: z
      .array(
        z
          .object({
            name: z.string().optional().describe('Pollutant name'),
            casNumber: z.string().optional().describe('CAS number without hyphens'),
          })
          .describe('One pollutant'),
      )
      .describe('Pollutants the case concerns'),
    milestones: z
      .array(
        z
          .object({
            event: z.string().optional().describe('Milestone'),
            date: z.string().optional().describe('MM/DD/YYYY'),
          })
          .describe('One milestone'),
      )
      .describe("ECHO's order"),
    enforcementConclusions: z
      .array(
        z
          .object({
            conclusionId: z.string().optional().describe('Conclusion ID'),
            conclusionNumber: z.string().optional().describe('Number within the case'),
            type: z.string().optional().describe('Kind of conclusion'),
            name: z.string().optional().describe('Conclusion name'),
            registryIds: z.array(z.string()).describe('Facilities it covers'),
            enteredDate: z.string().optional().describe('Settlement entered, MM/DD/YYYY'),
            lodgedDate: z.string().optional().describe('Settlement lodged, MM/DD/YYYY'),
            penaltyAssessedInDollars: z.number().optional().describe('Federal, in dollars'),
            stateLocalPenaltyInDollars: z
              .number()
              .optional()
              .describe('State or local, in dollars'),
            supplementalProjectCostInDollars: z
              .number()
              .optional()
              .describe('SEP cost, in dollars'),
            complianceActionCostInDollars: z.number().optional().describe('Estimated, in dollars'),
            costRecoveryInDollars: z.number().optional().describe('Recovered, in dollars'),
            closedDate: z.string().optional().describe('MM/DD/YYYY'),
            terminationDate: z.string().optional().describe('Settlement termination, MM/DD/YYYY'),
            complyingActions: z
              .array(
                z
                  .object({
                    type: z.string().optional().describe('Action code'),
                    description: z.string().optional().describe('Action'),
                    category: z.string().optional().describe('Action category'),
                  })
                  .describe('One action'),
              )
              .describe('Actions required to return to compliance'),
            pollutantReductions: z
              .array(
                z
                  .object({
                    pollutant: z.string().optional().describe('Pollutant reduced'),
                    annualAmount: z.number().optional().describe('Per year, in units'),
                    units: z.string().optional().describe('Units of annualAmount'),
                    media: z.string().optional().describe('Medium'),
                    source: z
                      .enum(['complying action', 'supplemental project'])
                      .optional()
                      .describe('Complying action or SEP'),
                  })
                  .describe('One reduction'),
              )
              .describe('Expected pollutant reductions'),
            supplementalProjects: z
              .array(
                z
                  .object({
                    category: z.string().optional().describe('SEP category code'),
                    description: z.string().optional().describe('SEP category name'),
                    text: z.string().optional().describe('As the settlement describes it'),
                    costInDollars: z.number().optional().describe('In dollars'),
                  })
                  .describe('One SEP'),
              )
              .describe('Supplemental Environmental Projects (SEPs) required'),
          })
          .describe('One settlement or order concluding part of the case'),
      )
      .describe("ECHO's order; empty fields absent"),
    enforcementConclusionsTotal: z.number().describe('Across every page'),
    enforcementConclusionsNextOffset: z
      .number()
      .optional()
      .describe('Next enforcement_conclusions_offset; absent on the last page'),
  }),

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe('True when facilities or enforcementConclusions has more pages; absent otherwise.'),
  },
  enrichmentTrailer: {
    truncated: { label: 'Truncated' },
  },

  errors: [
    {
      reason: 'criminal_case',
      code: JsonRpcErrorCode.ValidationError,
      when: 'case_id is a criminal (CR_) case number.',
      recovery:
        'Pass a civil case number instead; for a criminal case, use its row from epa_echo_search_violations with case_type criminal.',
    },
    {
      reason: 'case_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'ECHO has no civil case report for case_id.',
      recovery:
        "Check the case number: find civil case IDs with epa_echo_search_violations, or a formal action's caseId with epa_echo_get_facility, then retry.",
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const caseId = input.case_id;
    if (CRIMINAL_CASE_NUMBER.test(caseId)) {
      throw ctx.fail(
        'criminal_case',
        `Case ${caseId} is a criminal case number. ECHO's case report covers civil cases only, so no request was made.`,
        { caseId },
      );
    }
    ctx.log.info('epa_echo_get_case', { caseId });

    const report = await getEchoService().getCase(caseId, ctx);
    const facilities = slicePage(report.facilities, {
      limit: input.facilities_limit,
      offset: input.facilities_offset,
    });
    const conclusions = slicePage(report.enforcementConclusions, {
      limit: input.enforcement_conclusions_limit,
      offset: input.enforcement_conclusions_offset,
    });
    if (facilities.nextOffset !== undefined || conclusions.nextOffset !== undefined) {
      ctx.enrich({ truncated: true });
    }

    ctx.log.info('epa_echo_get_case completed', {
      caseId: report.caseId,
      facilities: facilities.items.length,
      facilitiesTotal: facilities.totalCount,
      enforcementConclusions: conclusions.items.length,
      enforcementConclusionsTotal: conclusions.totalCount,
    });
    return {
      ...report,
      facilities: facilities.items,
      facilitiesTotal: facilities.totalCount,
      ...(facilities.nextOffset !== undefined && { facilitiesNextOffset: facilities.nextOffset }),
      enforcementConclusions: conclusions.items,
      enforcementConclusionsTotal: conclusions.totalCount,
      ...(conclusions.nextOffset !== undefined && {
        enforcementConclusionsNextOffset: conclusions.nextOffset,
      }),
    };
  },

  format: (r) => {
    const lines: string[] = [];
    lines.push(`## ${formatHeading(r.caseName ?? r.caseId)}`);
    lines.push(`**Case ID:** ${escapeMarkdownInline(r.caseId)}`);
    const details: Array<[label: string, value: string | undefined]> = [
      ['Category Code', r.caseCategoryCode],
      ['Enforcement Type', r.enforcementType],
      ['Status', r.caseStatus],
      ['Status Date', r.caseStatusDate],
      ['Lead', r.leadAgency],
      ['Relief Sought', r.reliefSought],
      ['Outcome', r.enforcementOutcome],
      ['Court Docket', r.courtDocketNumber],
      ['DOJ Docket', r.dojDocketNumber],
      ['Violations', r.violations],
    ];
    for (const [label, value] of details) {
      if (value) lines.push(`**${label}:** ${escapeMarkdownInline(value)}`);
    }
    const money = moneyLine([
      ['Federal Penalty', r.penaltyAssessedInDollars],
      ['State/Local Penalty', r.stateLocalPenaltyInDollars],
      ['Penalty Collected', r.penaltyCollectedInDollars],
      ['SEP Cost', r.supplementalProjectCostInDollars],
      ['Compliance Action Cost', r.complianceActionCostInDollars],
      ['Cost Recovery', r.costRecoveryInDollars],
    ]);
    if (money) lines.push(money);
    if (r.summary) lines.push('\n### Summary', escapeMarkdownInline(r.summary));

    if (r.lawsAndSections.length > 0) {
      lines.push('\n### Laws and Sections');
      for (const entry of r.lawsAndSections) {
        const parts = [entry.law, entry.sections, entry.programs].filter(Boolean).join(' — ');
        lines.push(`- ${escapeMarkdownInline(parts || 'Law not recorded')}`);
      }
    }

    lines.push(
      `\n### Facilities (${pageLabel(r.facilities.length, r.facilitiesTotal, r.facilitiesNextOffset)})`,
    );
    if (r.facilitiesNextOffset !== undefined) {
      lines.push(nextOffsetLine(r.facilitiesNextOffset, 'facilities_offset'));
    }
    if (r.facilitiesTotal === 0) {
      lines.push('ECHO lists no facility for this case.');
    } else if (r.facilities.length > 0) {
      lines.push('Pass a Registry ID to epa_echo_get_facility for its compliance profile.');
    }
    for (const f of r.facilities) {
      const address = [f.street, f.city, f.state, f.zip].filter(Boolean).join(', ');
      const programIds = f.programIds
        .map((p) => [p.system, p.id].filter(Boolean).join(' '))
        .join(', ');
      const parts = [
        f.name,
        address,
        f.naicsCodes.length > 0 && `NAICS ${f.naicsCodes.join(', ')}`,
        f.sicCodes.length > 0 && `SIC ${f.sicCodes.join(', ')}`,
        programIds && `program IDs ${programIds}`,
        f.noLongerExists !== undefined &&
          (f.noLongerExists ? 'no longer exists (FRS)' : 'exists (FRS)'),
      ]
        .filter(Boolean)
        .join(' — ');
      const id = f.registryId ? `**${escapeMarkdownInline(f.registryId)}**` : 'No Registry ID';
      lines.push(`- ${id}${parts ? ` — ${escapeMarkdownInline(parts)}` : ''}`);
    }

    if (r.defendants.length > 0) {
      lines.push(`\n### Defendants (${r.defendants.length})`);
      for (const d of r.defendants) {
        const parts = [
          d.name ?? 'Name not recorded',
          namedIn(d.namedInComplaint, 'complaint'),
          namedIn(d.namedInSettlement, 'settlement'),
        ]
          .filter(Boolean)
          .join(' — ');
        lines.push(`- ${escapeMarkdownInline(parts)}`);
      }
    }

    if (r.pollutants.length > 0) {
      lines.push('\n### Pollutants');
      for (const p of r.pollutants) {
        const text = [p.name, p.casNumber && `CAS ${p.casNumber}`].filter(Boolean).join(' — ');
        lines.push(`- ${escapeMarkdownInline(text || 'Pollutant not recorded')}`);
      }
    }

    if (r.milestones.length > 0) {
      lines.push('\n### Milestones');
      for (const m of r.milestones) {
        const text = [m.date, m.event].filter(Boolean).join(' — ');
        lines.push(`- ${escapeMarkdownInline(text || 'Milestone not recorded')}`);
      }
    }

    if (r.enforcementConclusionsTotal > 0) {
      const shown = pageLabel(
        r.enforcementConclusions.length,
        r.enforcementConclusionsTotal,
        r.enforcementConclusionsNextOffset,
      );
      lines.push(`\n### Enforcement Conclusions (${shown})`);
      if (r.enforcementConclusionsNextOffset !== undefined) {
        lines.push(
          nextOffsetLine(r.enforcementConclusionsNextOffset, 'enforcement_conclusions_offset'),
        );
      }
    }
    for (const c of r.enforcementConclusions) {
      const title = [c.conclusionNumber && `Conclusion ${c.conclusionNumber}`, c.name ?? c.type]
        .filter(Boolean)
        .join(': ');
      lines.push(`\n#### ${formatHeading(title || 'Conclusion')}`);
      const facts: Array<[label: string, value: string | undefined]> = [
        ['Conclusion ID', c.conclusionId],
        ['Type', c.name ? c.type : undefined],
        ['Facilities', c.registryIds.length > 0 ? c.registryIds.join(', ') : undefined],
        ['Entered', c.enteredDate],
        ['Lodged', c.lodgedDate],
        ['Closed', c.closedDate],
        ['Terminated', c.terminationDate],
      ];
      for (const [label, value] of facts) {
        if (value) lines.push(`**${label}:** ${escapeMarkdownInline(value)}`);
      }
      const conclusionMoney = moneyLine([
        ['Federal Penalty', c.penaltyAssessedInDollars],
        ['State/Local Penalty', c.stateLocalPenaltyInDollars],
        ['SEP Cost', c.supplementalProjectCostInDollars],
        ['Compliance Action Cost', c.complianceActionCostInDollars],
        ['Cost Recovery', c.costRecoveryInDollars],
      ]);
      if (conclusionMoney) lines.push(conclusionMoney);
      for (const a of c.complyingActions) {
        const text = [[a.type, a.description].filter(Boolean).join(' '), a.category]
          .filter(Boolean)
          .join(' — ');
        lines.push(`- Complying action: ${escapeMarkdownInline(text || 'no detail')}`);
      }
      for (const p of c.pollutantReductions) {
        const amount =
          p.annualAmount !== undefined &&
          `${p.annualAmount.toLocaleString('en-US')}${p.units ? ` ${p.units}` : ''} a year`;
        const text = [p.pollutant, amount || p.units, p.media, p.source && `by ${p.source}`]
          .filter(Boolean)
          .join(' — ');
        lines.push(`- Pollutant reduction: ${escapeMarkdownInline(text || 'no detail')}`);
      }
      for (const s of c.supplementalProjects) {
        const text = [
          [s.category, s.description].filter(Boolean).join(' '),
          s.costInDollars !== undefined && dollars(s.costInDollars),
          s.text,
        ]
          .filter(Boolean)
          .join(' — ');
        lines.push(`- SEP: ${escapeMarkdownInline(text || 'no detail')}`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
