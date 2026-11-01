/**
 * @fileoverview Tool for retrieving a full compliance profile for a single EPA-regulated facility.
 * @module mcp-server/tools/definitions/echo-get-facility.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { dollars } from '@/mcp-server/tools/format-dollars.js';
import { formatHeading } from '@/mcp-server/tools/format-heading.js';
import { formatLbs } from '@/mcp-server/tools/format-lbs.js';
import { formatLocationLines } from '@/mcp-server/tools/format-location.js';
import { formatNotice } from '@/mcp-server/tools/format-notice.js';
import {
  clampLimit,
  limitSchema,
  offsetSchema,
  pagingEnrichment,
  pagingTrailer,
} from '@/mcp-server/tools/paging.js';
import {
  DRINKING_WATER_VIOLATION_SLICE,
  getEchoService,
  INSPECTION_SLICE,
} from '@/services/echo/echo-service.js';

/**
 * A list page's heading count: the total for a whole list, else the 1-based range the page
 * covers. A page ends at its next offset, or at the end of the list when it is the last one.
 */
function pageLabel(shown: number, total: number, nextOffset: number | undefined): string {
  if (shown === total) return `${total}`;
  if (shown === 0) return `none on this page of ${total}`;
  const start = (nextOffset ?? total) - shown;
  return `${start + 1}–${start + shown} of ${total}`;
}

export const echoGetFacilityTool = tool('epa_echo_get_facility', {
  title: 'Get EPA Facility Compliance Profile',
  description:
    "ECHO: Retrieve a full compliance profile for a single EPA-regulated facility by EPA Registry ID or EPA program ID. Returns facility metadata, the NAICS industry codes its programs record, ECHO's facility-level compliance status, a per-statute (CAA, CWA, RCRA, SDWA, and others ECHO tracks) compliance summary, inspections and other compliance monitoring records from the last five years (newest first, paged), five years of formal enforcement actions with penalties, five years of drinking-water violations with contaminant, measure, MCL, status, and enforcement actions (paged), the latest TRI release total, and the facility's TRI facility IDs for epa_tri_get_facility_releases. Use epa_echo_search_facilities to discover Registry IDs; pass a public water system's PWSID from epa_water_search_systems to get its drinking-water violations. For area-level enforcement discovery use epa_echo_search_violations instead.",
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    registry_id: z
      .string()
      .trim()
      .min(1)
      .describe(
        'EPA FRS Registry ID for the facility (from epa_echo_search_facilities), or an EPA program ID ECHO resolves to one: a public water system PWSID (from epa_water_search_systems, e.g. WA5300484), a TRI facility ID, an NPDES permit, or a RCRA handler ID. The profile carries the resolved registryId.',
      ),
    drinking_water_violations_limit: limitSchema({
      cap: DRINKING_WATER_VIOLATION_SLICE.cap,
      defaultLimit: DRINKING_WATER_VIOLATION_SLICE.defaultLimit,
      noun: 'drinking-water violations',
      offsetParam: 'drinking_water_violations_offset',
      nextOffsetField: 'drinkingWaterViolationsNextOffset',
    }),
    drinking_water_violations_offset: offsetSchema(
      'drinking-water violations',
      'drinkingWaterViolationsNextOffset',
    ),
    inspections_limit: limitSchema({
      cap: INSPECTION_SLICE.cap,
      defaultLimit: INSPECTION_SLICE.defaultLimit,
      noun: 'inspections',
      offsetParam: 'inspections_offset',
      nextOffsetField: 'inspectionsNextOffset',
    }),
    inspections_offset: offsetSchema('inspections', 'inspectionsNextOffset'),
  }),

  output: z.object({
    registryId: z.string().describe('EPA FRS Registry ID'),
    name: z.string().describe('Facility name'),
    street: z.string().optional().describe('Street address'),
    city: z.string().optional().describe('City'),
    state: z.string().optional().describe('2-letter state abbreviation'),
    zip: z.string().optional().describe('ZIP code'),
    county: z.string().optional().describe('County name'),
    fipsCode: z.string().optional().describe('5-digit county FIPS code'),
    latitude: z.number().optional().describe('Latitude in decimal degrees'),
    longitude: z.number().optional().describe('Longitude in decimal degrees'),
    complianceStatus: z
      .string()
      .optional()
      .describe(
        'ECHO\'s facility-level compliance status, the same value epa_echo_search_facilities returns (e.g. "Significant Violation"). Absent when ECHO assigns none, as for TRI-only facilities, or when ECHO\'s facility search request fails (the notice field then says so).',
      ),
    programs: z
      .object({
        air: z
          .boolean()
          .describe(
            'Has an ICIS-Air record (Clean Air Act stationary-source compliance). Emissions-inventory, risk-management, and greenhouse-gas reporting entries alone do not count.',
          ),
        water: z.boolean().describe('Has an ICIS-NPDES record (Clean Water Act discharge permit)'),
        rcra: z.boolean().describe('Has an RCRAInfo record (RCRA hazardous waste handler)'),
        tri: z
          .boolean()
          .describe(
            'Has a Toxics Release Inventory record — true exactly when triFacilityIds is non-empty',
          ),
        sdwa: z
          .boolean()
          .describe('Has an SDWIS record (Safe Drinking Water Act public water system)'),
      })
      .describe(
        "Program registration flags, from the ECHO systems in the facility's detailed report",
      ),
    triFacilityIds: z
      .array(z.string())
      .describe(
        '15-character TRI facility IDs recorded for this facility, most recently reported first — pass one as facility_id to epa_tri_get_facility_releases for per-chemical releases. A site can carry several from successive operators. Empty when the facility has no TRI record.',
      ),
    naics: z
      .array(
        z
          .object({
            code: z.string().describe('NAICS code, 2–6 digits, e.g. "331110"'),
            description: z
              .string()
              .optional()
              .describe(
                'NAICS title as ECHO records it, e.g. "Iron and Steel Mills and Ferroalloy Manufacturing"',
              ),
          })
          .describe('One NAICS code'),
      )
      .describe(
        "NAICS industry codes the facility's program records carry, each code once, ascending by code. Programs can record different codes for one site. Empty when no program records one.",
      ),
    triReleasesTransfersInLbs: z
      .number()
      .optional()
      .describe(
        "Total TRI on- and off-site releases and transfers in pounds for triReleasesTransfersYear, ECHO's latest TRI year for this facility. Absent when ECHO holds no TRI history for it.",
      ),
    triReleasesTransfersYear: z
      .number()
      .optional()
      .describe('TRI reporting year triReleasesTransfersInLbs covers'),
    compliance: z
      .object({
        quartersInViolation: z
          .number()
          .optional()
          .describe(
            'Quarters (of the last 12) in which any program found the facility in noncompliance',
          ),
      })
      .optional()
      .describe(
        "Facility-level noncompliance count from ECHO's facility search record. Absent when ECHO reports none or the facility search request fails.",
      ),
    programCompliance: z
      .array(
        z
          .object({
            statute: z
              .string()
              .describe('Statute ECHO summarizes, e.g. CAA, CWA, RCRA, SDWA, TSCA, EPCRA'),
            currentStatus: z
              .string()
              .optional()
              .describe(
                'Current compliance status under this statute, e.g. "No Violation Identified"',
              ),
            quartersInNoncompliance: z
              .number()
              .optional()
              .describe('Quarters in noncompliance over the 3-year window (of 12)'),
            quartersInSignificantNoncompliance: z
              .number()
              .optional()
              .describe('Quarters in significant noncompliance over the 3-year window (of 12)'),
            inspections: z
              .number()
              .optional()
              .describe('Inspections or full compliance evaluations over the 5-year window'),
            lastInspectionDate: z
              .string()
              .optional()
              .describe('Date of the latest inspection (MM/DD/YYYY)'),
            informalActions: z
              .number()
              .optional()
              .describe('Informal enforcement actions over the 5-year window'),
            formalActions: z
              .number()
              .optional()
              .describe('Formal enforcement actions over the 5-year window'),
            totalPenaltiesInDollars: z
              .number()
              .optional()
              .describe(
                'Penalties from formal enforcement actions over the 5-year window, in dollars',
              ),
            threeYearPeriodStart: z
              .string()
              .optional()
              .describe('Start of the 3-year window (MM/DD/YYYY)'),
            fiveYearPeriodStart: z
              .string()
              .optional()
              .describe('Start of the 5-year window (MM/DD/YYYY)'),
            periodEnd: z.string().optional().describe('End of both windows (MM/DD/YYYY)'),
          })
          .describe("One statute's enforcement and compliance summary"),
      )
      .describe(
        "ECHO's per-statute enforcement and compliance summary. Empty when the facility is in no compliance-tracked program, as for TRI-only facilities.",
      ),
    inspections: z
      .array(
        z
          .object({
            category: z
              .string()
              .optional()
              .describe(
                'Kind of record, e.g. "Inspection/Evaluation", "Compliance Investigation", "Information Request", "Offsite Record Review"; absent for RCRA and SDWA records',
              ),
            activityType: z
              .string()
              .optional()
              .describe(
                'Inspection or evaluation type, e.g. "FCE On-Site", "PCE Stack Test", "Compliance Evaluation Inspection"',
              ),
            activityDate: z.string().optional().describe('Date of the record (MM/DD/YYYY)'),
            description: z
              .string()
              .optional()
              .describe('Finding ECHO records for the inspection, when it records one'),
            statute: z.string().optional().describe('Statute the record was under'),
            sourceId: z
              .string()
              .optional()
              .describe(
                'Program ID inspected, e.g. an ICIS-Air ID, NPDES permit, RCRA handler ID, or public water system ID',
              ),
            leadAgency: z.string().optional().describe('Lead agency: EPA, State, or Local'),
          })
          .describe('Single inspection or other compliance monitoring record'),
      )
      .describe(
        'Inspections, evaluations, investigations, and other compliance monitoring records over the 5-year window, newest first: one page of inspections_limit entries from inspections_offset.',
      ),
    inspectionsTotal: z
      .number()
      .describe(
        "Compliance monitoring records in ECHO's 5-year history for this facility, across every page",
      ),
    inspectionsNextOffset: z
      .number()
      .optional()
      .describe(
        'Offset of the next page of inspections: present exactly when more follow, absent on the last page. Pass it as inspections_offset.',
      ),
    drinkingWaterViolations: z
      .array(
        z
          .object({
            sourceId: z
              .string()
              .optional()
              .describe('Public water system ID (PWSID) the violation is recorded against'),
            violationId: z.string().optional().describe('SDWIS violation ID'),
            compliancePeriodBeginDate: z
              .string()
              .optional()
              .describe('Start of the compliance period (MM/DD/YYYY)'),
            compliancePeriodEndDate: z
              .string()
              .optional()
              .describe(
                'End of the compliance period (MM/DD/YYYY); absent when ECHO records none, as for an open period',
              ),
            federalRule: z
              .string()
              .optional()
              .describe(
                'Federal rule violated, e.g. "Lead and Copper Rule", "Stage 2 Disinfectants and Disinfection Byproducts Rule"',
              ),
            contaminantName: z
              .string()
              .optional()
              .describe(
                'Contaminant or rule group, e.g. "TTHM", "Arsenic", "Lead and Copper Rule"',
              ),
            violationCategoryCode: z
              .string()
              .optional()
              .describe(
                'Violation category code, e.g. MCL (maximum contaminant level), MR (monitoring and reporting), MON (monitoring), TT (treatment technique)',
              ),
            violationCategory: z
              .string()
              .optional()
              .describe('Violation category, e.g. "Maximum Contaminant Level Violation"'),
            violationMeasure: z
              .string()
              .optional()
              .describe(
                'Measured level as ECHO writes it, units included (e.g. "148.37 UG/L"); absent when ECHO records none, as for monitoring violations',
              ),
            stateMcl: z
              .string()
              .optional()
              .describe('State maximum contaminant level as ECHO writes it, units included'),
            federalMcl: z
              .string()
              .optional()
              .describe(
                'Federal maximum contaminant level as ECHO writes it, units included (e.g. "0.080 mg/L")',
              ),
            status: z
              .string()
              .optional()
              .describe(
                "ECHO's violation status: Resolved, Archived (no longer counts toward the system's current compliance status; an Archived entry can still carry a resolvedDate), Addressed (not resolved, with formal enforcement), or Unaddressed (not resolved, no formal enforcement)",
              ),
            resolvedDate: z
              .string()
              .optional()
              .describe('Date ECHO records the violation as resolved (MM/DD/YYYY)'),
            enforcementActions: z
              .array(
                z
                  .object({
                    date: z.string().optional().describe('Action date (MM/DD/YYYY)'),
                    type: z
                      .string()
                      .optional()
                      .describe('Action type: "Formal", "Informal", or "Resolving"'),
                    description: z
                      .string()
                      .optional()
                      .describe(
                        'Action, e.g. "State Administrative/Compliance Order without penalty issued"',
                      ),
                    agency: z.string().optional().describe('Agency that took it, e.g. State, EPA'),
                  })
                  .describe('Enforcement action ECHO links to the violation'),
              )
              .optional()
              .describe(
                'Enforcement actions ECHO links to the violation; absent when it lists none',
              ),
          })
          .describe(
            'Single drinking-water violation; fields ECHO leaves empty are absent, never defaulted',
          ),
      )
      .describe(
        "Drinking-water (SDWIS) violations in ECHO's 5-year report for a public water system, newest compliance period first: one page of drinking_water_violations_limit entries from drinking_water_violations_offset. Empty for a facility with no SDWIS record.",
      ),
    drinkingWaterViolationsTotal: z
      .number()
      .describe(
        "Drinking-water violations in ECHO's report for this facility, across every page; 0 when it has no SDWIS record",
      ),
    drinkingWaterViolationsNextOffset: z
      .number()
      .optional()
      .describe(
        'Offset of the next page of drinkingWaterViolations: present exactly when more follow, absent on the last page. Pass it as drinking_water_violations_offset.',
      ),
    formalActions: z
      .array(
        z
          .object({
            caseId: z
              .string()
              .optional()
              .describe(
                'Enforcement case identifier; pass it to epa_echo_get_case for the civil case report (facilities, defendants, conclusions). Absent when ECHO records the action without one, as for RCRA and SDWA actions',
              ),
            settlementDate: z
              .string()
              .optional()
              .describe('Settlement date of the enforcement case (MM/DD/YYYY)'),
            penaltyAssessedInDollars: z
              .number()
              .optional()
              .describe('Penalty amount assessed in dollars'),
            actionType: z
              .string()
              .optional()
              .describe('Type of formal enforcement action, e.g. "Administrative Order"'),
            actionDate: z.string().optional().describe('Date of the action (MM/DD/YYYY)'),
            statute: z.string().optional().describe('Statute the action was under'),
            sourceId: z.string().optional().describe('Program ID the action concerns'),
            leadAgency: z.string().optional().describe('Lead agency: EPA, State, or Local'),
          })
          .describe('Single formal enforcement action'),
      )
      .describe('Formal enforcement actions over the 5-year window, newest first'),
    airCompliance: z
      .object({
        programId: z
          .string()
          .optional()
          .describe('ICIS-Air ID when the facility has exactly one; absent when it has several'),
        status: z.string().optional().describe('Current Clean Air Act compliance status'),
        statusDate: z
          .string()
          .optional()
          .describe('End of the latest quarter the status covers (MM/DD/YYYY)'),
      })
      .optional()
      .describe(
        'Clean Air Act status. Present only when programs.air is true and ECHO reports a CAA status.',
      ),
    waterCompliance: z
      .object({
        status: z.string().optional().describe('Current Clean Water Act compliance status'),
        permitId: z
          .string()
          .optional()
          .describe(
            'NPDES permit ID when the facility has exactly one; absent when it has several',
          ),
      })
      .optional()
      .describe(
        'Clean Water Act status. Present only when programs.water is true and ECHO reports a CWA status.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        "Present when ECHO's facility search request failed, so complianceStatus and compliance are missing; every other field comes from the facility's detailed report.",
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when a list was cut at its limit: more drinking-water violations or inspections follow this page, and drinkingWaterViolationsNextOffset or inspectionsNextOffset continues it. Absent when neither list has more.',
      ),
    limitNotice: pagingEnrichment.limitNotice,
  },
  enrichmentTrailer: {
    notice: { render: formatNotice },
    truncated: { label: 'Truncated' },
    limitNotice: pagingTrailer.limitNotice,
  },

  errors: [
    {
      reason: 'facility_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'ECHO has no facility for the given Registry ID or program ID.',
      recovery:
        'Verify the ID: find Registry IDs with epa_echo_search_facilities or PWSIDs with epa_water_search_systems, then retry.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('epa_echo_get_facility', { registryId: input.registry_id });

    const violations = clampLimit(
      input.drinking_water_violations_limit,
      DRINKING_WATER_VIOLATION_SLICE.cap,
      'drinking_water_violations_limit',
    );
    const inspections = clampLimit(
      input.inspections_limit,
      INSPECTION_SLICE.cap,
      'inspections_limit',
    );
    const limitNotice = [violations.notice, inspections.notice].filter(Boolean).join(' ');
    if (limitNotice) ctx.enrich({ limitNotice });

    const profile = await getEchoService().getFacility(input.registry_id, ctx, {
      drinkingWaterViolations: {
        limit: violations.limit,
        offset: input.drinking_water_violations_offset,
      },
      inspections: { limit: inspections.limit, offset: input.inspections_offset },
    });
    if (
      profile.drinkingWaterViolationsNextOffset !== undefined ||
      profile.inspectionsNextOffset !== undefined
    ) {
      ctx.enrich({ truncated: true });
    }

    ctx.log.info('epa_echo_get_facility completed', {
      registryId: profile.registryId,
      inspections: profile.inspections.length,
      drinkingWaterViolations: profile.drinkingWaterViolations.length,
      formalActions: profile.formalActions.length,
    });

    return profile;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## ${formatHeading(result.name)}`);
    lines.push(`**Registry ID:** ${escapeMarkdownInline(result.registryId)}`);

    lines.push(...formatLocationLines(result));
    if (result.complianceStatus)
      lines.push(`**Compliance Status:** ${escapeMarkdownInline(result.complianceStatus)}`);

    const activePrograms = Object.entries(result.programs)
      .filter(([, v]) => v)
      .map(([k]) => k.toUpperCase())
      .join(', ');
    if (activePrograms) lines.push(`**Programs:** ${activePrograms}`);

    if (result.naics.length > 0) {
      const codes = result.naics.map((n) => [n.code, n.description].filter(Boolean).join(' '));
      lines.push(`**NAICS:** ${escapeMarkdownInline(codes.join('; '))}`);
    }

    if (result.triFacilityIds.length > 0) {
      lines.push(
        `**TRI Facility IDs:** ${escapeMarkdownInline(result.triFacilityIds.join(', '))} (most recent first; for epa_tri_get_facility_releases)`,
      );
    }
    if (result.triReleasesTransfersInLbs !== undefined) {
      const year =
        result.triReleasesTransfersYear !== undefined
          ? ` (${result.triReleasesTransfersYear})`
          : '';
      lines.push(
        `**TRI Releases+Transfers${year}:** ${formatLbs(result.triReleasesTransfersInLbs)}`,
      );
    }

    if (result.compliance) {
      lines.push('\n### Compliance Summary');
      if (result.compliance.quartersInViolation !== undefined) {
        lines.push(`**Quarters in Violation (3yr):** ${result.compliance.quartersInViolation}`);
      }
    }

    if (result.programCompliance.length > 0) {
      lines.push('\n### Program Compliance');
      for (const p of result.programCompliance) {
        const parts = [
          p.currentStatus,
          p.quartersInNoncompliance !== undefined &&
            `Quarters in noncompliance: ${p.quartersInNoncompliance} of 12`,
          p.quartersInSignificantNoncompliance !== undefined &&
            `in significant noncompliance: ${p.quartersInSignificantNoncompliance}`,
          p.inspections !== undefined && `Inspections: ${p.inspections}`,
          p.lastInspectionDate && `last ${p.lastInspectionDate}`,
          p.informalActions !== undefined && `Informal actions: ${p.informalActions}`,
          p.formalActions !== undefined && `Formal actions: ${p.formalActions}`,
          p.totalPenaltiesInDollars !== undefined &&
            `Penalties: ${dollars(p.totalPenaltiesInDollars)}`,
          p.threeYearPeriodStart && `3-year window from ${p.threeYearPeriodStart}`,
          p.fiveYearPeriodStart && `5-year window from ${p.fiveYearPeriodStart}`,
          p.periodEnd && `through ${p.periodEnd}`,
        ].filter(Boolean);
        lines.push(
          `- **${escapeMarkdownInline(p.statute)}:** ${escapeMarkdownInline(parts.join(' | ') || 'no summary values')}`,
        );
      }
    }

    if (result.inspectionsTotal > 0) {
      const shown = pageLabel(
        result.inspections.length,
        result.inspectionsTotal,
        result.inspectionsNextOffset,
      );
      lines.push(`\n### Inspections (${shown})`);
      if (result.inspectionsNextOffset !== undefined) {
        lines.push(`**Next offset:** ${result.inspectionsNextOffset} (pass as inspections_offset)`);
      }
      for (const insp of result.inspections) {
        const parts = [
          insp.activityDate,
          [insp.statute, insp.sourceId].filter(Boolean).join(' '),
          [insp.category, insp.activityType].filter(Boolean).join(': '),
          insp.leadAgency && `${insp.leadAgency} lead`,
          insp.description,
        ]
          .filter(Boolean)
          .join(' — ');
        lines.push(`- ${escapeMarkdownInline(parts || 'Inspection record (no detail)')}`);
      }
    }

    const violations = result.drinkingWaterViolations;
    const violationsTotal = result.drinkingWaterViolationsTotal;
    if (result.programs.sdwa || violationsTotal > 0) {
      const shown = pageLabel(
        violations.length,
        violationsTotal,
        result.drinkingWaterViolationsNextOffset,
      );
      lines.push(`\n### Drinking-Water Violations (${shown})`);
      if (result.drinkingWaterViolationsNextOffset !== undefined) {
        lines.push(
          `**Next offset:** ${result.drinkingWaterViolationsNextOffset} (pass as drinking_water_violations_offset)`,
        );
      }
      for (const v of violations) {
        const begin = v.compliancePeriodBeginDate;
        const end = v.compliancePeriodEndDate;
        const period =
          begin && end ? `${begin}–${end}` : begin ? `from ${begin}` : end && `through ${end}`;
        const parts = [
          period,
          v.sourceId,
          v.violationId && `Violation ${v.violationId}`,
          v.federalRule,
          v.contaminantName,
          [v.violationCategoryCode, v.violationCategory].filter(Boolean).join(': '),
          v.violationMeasure && `Measure ${v.violationMeasure}`,
          v.stateMcl && `State MCL ${v.stateMcl}`,
          v.federalMcl && `Federal MCL ${v.federalMcl}`,
          v.status,
          v.resolvedDate && `resolved ${v.resolvedDate}`,
        ]
          .filter(Boolean)
          .join(' — ');
        lines.push(`- ${escapeMarkdownInline(parts || 'Violation record (no detail)')}`);
        for (const action of v.enforcementActions ?? []) {
          const detail = [action.date, action.type, action.description, action.agency]
            .filter(Boolean)
            .join(' — ');
          lines.push(`  - Enforcement: ${escapeMarkdownInline(detail || 'no detail')}`);
        }
      }
    }

    if (result.formalActions.length > 0) {
      lines.push('\n### Formal Enforcement Actions');
      for (const fa of result.formalActions) {
        const where = [fa.actionDate, [fa.statute, fa.sourceId].filter(Boolean).join(' ')]
          .filter(Boolean)
          .join(' — ');
        const details = [
          fa.actionType ?? 'Action',
          fa.penaltyAssessedInDollars !== undefined &&
            `Penalty: ${dollars(fa.penaltyAssessedInDollars)}`,
          fa.caseId && `Case ${fa.caseId}`,
          fa.settlementDate && `Settled ${fa.settlementDate}`,
          fa.leadAgency && `${fa.leadAgency} lead`,
        ]
          .filter(Boolean)
          .join(' | ');
        lines.push(
          `- ${where ? `${escapeMarkdownInline(where)} — ` : ''}${escapeMarkdownInline(details)}`,
        );
      }
    }

    if (result.airCompliance) {
      lines.push('\n### Air (CAA) Compliance');
      if (result.airCompliance.programId)
        lines.push(`**Program ID:** ${escapeMarkdownInline(result.airCompliance.programId)}`);
      if (result.airCompliance.status)
        lines.push(`**Status:** ${escapeMarkdownInline(result.airCompliance.status)}`);
      if (result.airCompliance.statusDate)
        lines.push(`**Status Date:** ${escapeMarkdownInline(result.airCompliance.statusDate)}`);
    }

    if (result.waterCompliance) {
      lines.push('\n### Water (CWA) Compliance');
      if (result.waterCompliance.status)
        lines.push(`**Status:** ${escapeMarkdownInline(result.waterCompliance.status)}`);
      if (result.waterCompliance.permitId)
        lines.push(`**NPDES Permit:** ${escapeMarkdownInline(result.waterCompliance.permitId)}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
