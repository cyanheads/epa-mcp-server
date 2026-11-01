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
import { getEchoService } from '@/services/echo/echo-service.js';

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
    "ECHO: Retrieve one civil enforcement case by case number, with the facilities, defendants, and settlements behind it. Returns the case's category, enforcement type, status, lead agency, relief sought, outcome, court and DOJ docket numbers, summary, and penalty, cost-recovery, compliance-action, and SEP totals; the laws and sections cited; the facilities the case names, one per EPA Registry ID, with address, NAICS and SIC codes, and the program IDs the case links (pass a registryId to epa_echo_get_facility for its compliance profile); defendants; pollutants; milestones; and every enforcement conclusion (order, consent decree, or other settlement) with its facilities, dates, penalties and costs, complying actions, pollutant reductions, and Supplemental Environmental Projects. Take the case number from epa_echo_search_violations or from a formal action's caseId in epa_echo_get_facility. Civil cases only: a criminal CR_ case number fails before any request.",
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    case_id: z
      .string()
      .trim()
      .min(1)
      .describe(
        'Civil enforcement case number: a caseId from epa_echo_search_violations (e.g. "03-2014-7010", "WA-100446") or a formal action\'s caseId from epa_echo_get_facility (e.g. "WAPSCAF000000000000000416"). Criminal case numbers ("CR_1270") are rejected.',
      ),
  }),

  output: z.object({
    caseId: z.string().describe('Case number, as ECHO records it'),
    caseName: z.string().optional().describe('Case name; absent when ECHO records none'),
    caseCategoryCode: z
      .string()
      .optional()
      .describe('Case category code: "JDC" civil judicial, "AFR" administrative formal'),
    enforcementType: z
      .string()
      .optional()
      .describe(
        'Kind of enforcement action, e.g. "Administrative Order", "Bankruptcy", "CERCLA 120E Federal Facility Agreement (FFA)"',
      ),
    caseStatus: z
      .string()
      .optional()
      .describe('Case status, e.g. "Final Order Entered", "Resolved", "Closed"'),
    caseStatusDate: z.string().optional().describe('Date caseStatus took effect (MM/DD/YYYY)'),
    leadAgency: z.string().optional().describe('Agency leading the case: "EPA" or "State"'),
    reliefSought: z
      .string()
      .optional()
      .describe('Relief the case seeks, e.g. "Cost Recovery"; absent when ECHO records none'),
    enforcementOutcome: z
      .string()
      .optional()
      .describe('How the case was resolved, e.g. "Final Order No Penalty"'),
    courtDocketNumber: z
      .string()
      .optional()
      .describe('The court\'s or region\'s docket number, e.g. "18-195"'),
    dojDocketNumber: z
      .string()
      .optional()
      .describe('Department of Justice docket number, e.g. "90-11-3-06663/2"'),
    violations: z
      .string()
      .optional()
      .describe('Violation description ECHO records, e.g. "Oil Spill Violation Under CWA/OPA"'),
    summary: z.string().optional().describe('Case summary as EPA wrote it'),
    penaltyAssessedInDollars: z
      .number()
      .optional()
      .describe('Federal penalty assessed across the case, in dollars'),
    stateLocalPenaltyInDollars: z
      .number()
      .optional()
      .describe('State or local penalty assessed across the case, in dollars'),
    penaltyCollectedInDollars: z
      .number()
      .optional()
      .describe('Penalty ECHO records as collected, in dollars'),
    supplementalProjectCostInDollars: z
      .number()
      .optional()
      .describe('Cost of the Supplemental Environmental Projects agreed, in dollars'),
    complianceActionCostInDollars: z
      .number()
      .optional()
      .describe(
        'Estimated cost of the injunctive relief and other actions required to return to compliance, in dollars',
      ),
    costRecoveryInDollars: z
      .number()
      .optional()
      .describe(
        'Response costs the parties agreed or were ordered to repay, in dollars — the outcome of a CERCLA cost-recovery case',
      ),
    lawsAndSections: z
      .array(
        z
          .object({
            law: z.string().optional().describe('Statute, e.g. "CERCLA", "CAA"'),
            sections: z
              .string()
              .optional()
              .describe('Sections cited, comma-separated, e.g. "107A: Cost Recovery"'),
            programs: z
              .string()
              .optional()
              .describe('Programs the sections fall under, e.g. "Cost Recovery/Financial"'),
          })
          .describe('One statute the case cites'),
      )
      .describe('Statutes and sections the case cites'),
    facilities: z
      .array(
        z
          .object({
            registryId: z
              .string()
              .optional()
              .describe(
                'EPA FRS Registry ID — pass it as registry_id to epa_echo_get_facility for the compliance profile. Absent on a facility row ECHO records without one.',
              ),
            name: z.string().optional().describe('Facility name'),
            street: z.string().optional().describe('Street address'),
            city: z.string().optional().describe('City'),
            state: z.string().optional().describe('2-letter state abbreviation'),
            zip: z.string().optional().describe('ZIP code'),
            naicsCodes: z
              .array(z.string())
              .describe(
                "NAICS codes the case records for the facility, each once, in ECHO's order",
              ),
            sicCodes: z
              .array(z.string())
              .describe("SIC codes the case records for the facility, each once, in ECHO's order"),
            programIds: z
              .array(
                z
                  .object({
                    id: z.string().describe('Program ID, e.g. an NPDES permit or SEMS site ID'),
                    system: z
                      .string()
                      .optional()
                      .describe('Program system the ID belongs to, e.g. "ICIS", "SEMS", "AIR"'),
                  })
                  .describe('One program ID the case links to the facility'),
              )
              .describe("Program-system IDs the case links to the facility, in ECHO's order"),
            noLongerExists: z
              .boolean()
              .optional()
              .describe('True when FRS marks the facility as no longer existing'),
          })
          .describe('One facility the case names'),
      )
      .describe(
        "Facilities the case names, one per Registry ID in ECHO's order; a case can span several states",
      ),
    defendants: z
      .array(
        z
          .object({
            name: z.string().optional().describe('Defendant name'),
            namedInComplaint: z
              .boolean()
              .optional()
              .describe('True when the complaint names the defendant'),
            namedInSettlement: z
              .boolean()
              .optional()
              .describe('True when a settlement names the defendant'),
          })
          .describe('One defendant'),
      )
      .describe('Defendants the case names; empty when ECHO records none, as on many state cases'),
    pollutants: z
      .array(
        z
          .object({
            name: z.string().optional().describe('Pollutant name'),
            casNumber: z
              .string()
              .optional()
              .describe('Chemical Abstracts Service number, without hyphens (e.g. "7440382")'),
          })
          .describe('One pollutant'),
      )
      .describe('Pollutants the case concerns'),
    milestones: z
      .array(
        z
          .object({
            event: z.string().optional().describe('Milestone, e.g. "Complaint Filed With Court"'),
            date: z.string().optional().describe('Date reached (MM/DD/YYYY)'),
          })
          .describe('One case milestone'),
      )
      .describe("Case milestones in ECHO's order"),
    enforcementConclusions: z
      .array(
        z
          .object({
            conclusionId: z.string().optional().describe('Enforcement conclusion ID'),
            conclusionNumber: z
              .string()
              .optional()
              .describe("The conclusion's number within the case"),
            type: z
              .string()
              .optional()
              .describe(
                'Kind of conclusion, e.g. "Consent Decree or Court Order Resolving a Civil Judicial Action", "State/Local Action"',
              ),
            name: z.string().optional().describe('Conclusion name'),
            registryIds: z
              .array(z.string())
              .describe('Registry IDs of the facilities the conclusion covers'),
            enteredDate: z.string().optional().describe('Settlement entered date (MM/DD/YYYY)'),
            lodgedDate: z.string().optional().describe('Settlement lodged date (MM/DD/YYYY)'),
            penaltyAssessedInDollars: z
              .number()
              .optional()
              .describe('Federal penalty this conclusion assesses, in dollars'),
            stateLocalPenaltyInDollars: z
              .number()
              .optional()
              .describe('State or local penalty this conclusion assesses, in dollars'),
            supplementalProjectCostInDollars: z
              .number()
              .optional()
              .describe(
                "Cost of this conclusion's Supplemental Environmental Projects, in dollars",
              ),
            complianceActionCostInDollars: z
              .number()
              .optional()
              .describe("Estimated cost of this conclusion's compliance actions, in dollars"),
            costRecoveryInDollars: z
              .number()
              .optional()
              .describe('Response costs this conclusion recovers, in dollars'),
            closedDate: z
              .string()
              .optional()
              .describe('Date the enforcement action was closed (MM/DD/YYYY)'),
            terminationDate: z
              .string()
              .optional()
              .describe('Date the settlement terminated (MM/DD/YYYY)'),
            complyingActions: z
              .array(
                z
                  .object({
                    type: z.string().optional().describe('Action code, e.g. "WEM"'),
                    description: z
                      .string()
                      .optional()
                      .describe('Action, e.g. "Environmental Management Review"'),
                    category: z
                      .string()
                      .optional()
                      .describe('Action category, e.g. "Work Practices"'),
                  })
                  .describe('One complying action'),
              )
              .describe('Actions the conclusion requires to return to compliance'),
            pollutantReductions: z
              .array(
                z
                  .object({
                    pollutant: z.string().optional().describe('Pollutant reduced'),
                    annualAmount: z.number().optional().describe('Annual amount reduced, in units'),
                    units: z.string().optional().describe('Units of annualAmount, e.g. "gal"'),
                    media: z
                      .string()
                      .optional()
                      .describe('Medium the reduction is in, e.g. "Land", "Soil"'),
                    source: z
                      .enum(['complying action', 'supplemental project'])
                      .optional()
                      .describe('Whether a complying action or a SEP achieves the reduction'),
                  })
                  .describe('One pollutant reduction'),
              )
              .describe('Pollutant reductions the conclusion expects'),
            supplementalProjects: z
              .array(
                z
                  .object({
                    category: z.string().optional().describe('SEP category code, e.g. "EPP"'),
                    description: z
                      .string()
                      .optional()
                      .describe('SEP category, e.g. "Emergency Planning and Preparedness"'),
                    text: z
                      .string()
                      .optional()
                      .describe('The project as the settlement describes it'),
                    costInDollars: z.number().optional().describe('Project cost, in dollars'),
                  })
                  .describe('One Supplemental Environmental Project'),
              )
              .describe('Supplemental Environmental Projects (SEPs) the conclusion requires'),
          })
          .describe(
            'One order, consent decree, or other settlement that concluded part of the case',
          ),
      )
      .describe("Enforcement conclusions in ECHO's order; fields ECHO leaves empty are absent"),
  }),

  errors: [
    {
      reason: 'criminal_case',
      code: JsonRpcErrorCode.ValidationError,
      when: "case_id is a criminal case number (CR_ prefix), which ECHO's civil case report rejects.",
      recovery:
        'Pass a civil case number instead; for a criminal case, use its row from epa_echo_search_violations with case_type criminal.',
    },
    {
      reason: 'case_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'ECHO has no civil case report for the case number.',
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

    ctx.log.info('epa_echo_get_case completed', {
      caseId: report.caseId,
      facilities: report.facilities.length,
      enforcementConclusions: report.enforcementConclusions.length,
    });
    return report;
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

    lines.push(`\n### Facilities (${r.facilities.length})`);
    if (r.facilities.length === 0) {
      lines.push('ECHO lists no facility for this case.');
    } else {
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

    if (r.enforcementConclusions.length > 0) {
      lines.push(`\n### Enforcement Conclusions (${r.enforcementConclusions.length})`);
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
