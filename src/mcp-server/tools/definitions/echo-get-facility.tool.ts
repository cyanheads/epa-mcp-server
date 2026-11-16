/**
 * @fileoverview Tool for retrieving a full compliance profile for a single EPA-regulated facility.
 * @module mcp-server/tools/definitions/echo-get-facility.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, markdownLink } from '@cyanheads/mcp-ts-core/utils';
import { dollars } from '@/mcp-server/tools/format-dollars.js';
import { formatHeading } from '@/mcp-server/tools/format-heading.js';
import { formatLbs } from '@/mcp-server/tools/format-lbs.js';
import { formatLocationLines } from '@/mcp-server/tools/format-location.js';
import { formatNotice } from '@/mcp-server/tools/format-notice.js';
import {
  clampLimit,
  limitSchema,
  nextOffsetLine,
  offsetSchema,
  pageLabel,
  pagingEnrichment,
  pagingTrailer,
  wholeListLimitSchema,
} from '@/mcp-server/tools/paging.js';
import {
  DRINKING_WATER_VIOLATION_SLICE,
  EFFLUENT_EXCEEDANCE_SLICE,
  getEchoService,
  INSPECTION_SLICE,
  RCRA_VIOLATION_SLICE,
} from '@/services/echo/echo-service.js';

export const echoGetFacilityTool = tool('epa_echo_get_facility', {
  title: 'Get EPA Facility Compliance Profile',
  description:
    "ECHO: Retrieve a full compliance profile for a single EPA-regulated facility by EPA Registry ID or EPA program ID. Returns facility metadata, the NAICS industry codes its programs record, ECHO's facility-level compliance status, a per-statute (CAA, CWA, RCRA, SDWA, and others ECHO tracks) compliance summary, inspections and other compliance monitoring records from the last five years (newest first, paged), five years of formal enforcement actions with penalties, five years of drinking-water violations with contaminant, measure, MCL, status, and enforcement actions (paged), Clean Water Act effluent limit exceedances by pollutant and outfall and RCRA violations (both paged), Clean Air Act High Priority Violations, every program ID linked to the facility, the latest TRI release total, and the facility's TRI facility IDs for epa_tri_get_facility_releases. Use epa_echo_search_facilities to discover Registry IDs; pass a public water system's PWSID from epa_water_search_systems to get its drinking-water violations. For area-level enforcement discovery use epa_echo_search_violations instead.",
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
    effluent_exceedances_limit: wholeListLimitSchema({
      defaultLimit: EFFLUENT_EXCEEDANCE_SLICE.defaultLimit,
      noun: 'effluent exceedance series',
      offsetParam: 'effluent_exceedances_offset',
      nextOffsetField: 'effluentExceedancesNextOffset',
    }),
    effluent_exceedances_offset: offsetSchema(
      'effluent exceedance series',
      'effluentExceedancesNextOffset',
    ),
    rcra_violations_limit: wholeListLimitSchema({
      defaultLimit: RCRA_VIOLATION_SLICE.defaultLimit,
      noun: 'RCRA violations',
      offsetParam: 'rcra_violations_offset',
      nextOffsetField: 'rcraViolationsNextOffset',
    }),
    rcra_violations_offset: offsetSchema('RCRA violations', 'rcraViolationsNextOffset'),
  }),

  output: z.object({
    registryId: z.string().describe('FRS Registry ID'),
    name: z.string().describe('Facility name'),
    street: z.string().optional().describe('Street address'),
    city: z.string().optional().describe('City'),
    state: z.string().optional().describe('State code'),
    zip: z.string().optional().describe('ZIP code'),
    county: z.string().optional().describe('County name'),
    fipsCode: z.string().optional().describe('5-digit county FIPS code'),
    latitude: z.number().optional().describe('Decimal degrees'),
    longitude: z.number().optional().describe('Decimal degrees'),
    complianceStatus: z
      .string()
      .optional()
      .describe(
        'Facility-level status; absent when ECHO assigns none (as for TRI-only facilities) or its facility search failed (see notice)',
      ),
    programs: z
      .object({
        air: z
          .boolean()
          .describe(
            'Has an ICIS-Air (CAA) record; emissions-inventory, risk-management, or greenhouse-gas entries alone do not count',
          ),
        water: z.boolean().describe('Has an ICIS-NPDES (CWA) record'),
        rcra: z.boolean().describe('Has an RCRAInfo record'),
        tri: z.boolean().describe('True exactly when triFacilityIds is non-empty'),
        sdwa: z.boolean().describe('Has an SDWIS record'),
      })
      .describe("From the systems in the facility's detailed report"),
    triFacilityIds: z
      .array(z.string())
      .describe(
        '15-character IDs, most recently reported first; pass one as facility_id to epa_tri_get_facility_releases. Several mean successive operators.',
      ),
    naics: z
      .array(
        z
          .object({
            code: z.string().describe('2–6 digits'),
            description: z.string().optional().describe('Title as ECHO records it'),
          })
          .describe('One NAICS code'),
      )
      .describe('From the program records, each code once, ascending; programs can differ'),
    triReleasesTransfersInLbs: z
      .number()
      .optional()
      .describe(
        'TRI releases and transfers in pounds for triReleasesTransfersYear; absent without TRI history',
      ),
    triReleasesTransfersYear: z
      .number()
      .optional()
      .describe("ECHO's latest TRI year for the facility"),
    compliance: z
      .object({
        quartersInViolation: z
          .number()
          .optional()
          .describe('Of the last 12, with noncompliance under any program'),
      })
      .optional()
      .describe("From ECHO's facility search; absent when it reports none or fails"),
    programCompliance: z
      .array(
        z
          .object({
            statute: z.string().describe('Statute'),
            currentStatus: z.string().optional().describe('Current status'),
            quartersInNoncompliance: z.number().optional().describe('Of 12, 3-year window'),
            quartersInSignificantNoncompliance: z
              .number()
              .optional()
              .describe('Of 12, 3-year window'),
            inspections: z
              .number()
              .optional()
              .describe('Inspections or full evaluations, 5-year window'),
            lastInspectionDate: z.string().optional().describe('MM/DD/YYYY'),
            informalActions: z.number().optional().describe('5-year window'),
            formalActions: z.number().optional().describe('5-year window'),
            totalPenaltiesInDollars: z
              .number()
              .optional()
              .describe('Formal-action penalties, 5-year window, in dollars'),
            threeYearPeriodStart: z.string().optional().describe('MM/DD/YYYY'),
            fiveYearPeriodStart: z.string().optional().describe('MM/DD/YYYY'),
            periodEnd: z.string().optional().describe('End of both windows, MM/DD/YYYY'),
          })
          .describe("One statute's summary"),
      )
      .describe(
        'Per-statute summary; empty outside compliance-tracked programs, as for TRI-only facilities',
      ),
    inspections: z
      .array(
        z
          .object({
            category: z
              .string()
              .optional()
              .describe('Kind of record; absent for RCRA and SDWA records'),
            activityType: z.string().optional().describe('Inspection or evaluation type'),
            activityDate: z.string().optional().describe('MM/DD/YYYY'),
            description: z.string().optional().describe('Finding, if recorded'),
            statute: z.string().optional().describe('Statute'),
            sourceId: z.string().optional().describe('Program ID inspected'),
            leadAgency: z.string().optional().describe('EPA, State, or Local'),
          })
          .describe('One monitoring record'),
      )
      .describe('Inspections and other compliance monitoring, 5-year window, newest first'),
    inspectionsTotal: z.number().describe('Across every page'),
    inspectionsNextOffset: z
      .number()
      .optional()
      .describe('Next inspections_offset; absent on the last page'),
    drinkingWaterViolations: z
      .array(
        z
          .object({
            sourceId: z.string().optional().describe('PWSID recorded against'),
            violationId: z.string().optional().describe('SDWIS violation ID'),
            compliancePeriodBeginDate: z.string().optional().describe('MM/DD/YYYY'),
            compliancePeriodEndDate: z
              .string()
              .optional()
              .describe('MM/DD/YYYY; absent for an open period'),
            federalRule: z.string().optional().describe('Federal rule violated'),
            contaminantName: z.string().optional().describe('Contaminant or rule group'),
            violationCategoryCode: z
              .string()
              .optional()
              .describe('Code that violationCategory names'),
            violationCategory: z.string().optional().describe('Category name'),
            violationMeasure: z
              .string()
              .optional()
              .describe(
                'Measured level, units included; absent when unrecorded, as for monitoring violations',
              ),
            stateMcl: z.string().optional().describe('State MCL, units included'),
            federalMcl: z.string().optional().describe('Federal MCL, units included'),
            status: z
              .string()
              .optional()
              .describe(
                'Resolved; Archived (no longer counts toward current compliance, can still carry resolvedDate); Addressed (unresolved, formal enforcement); Unaddressed (unresolved, none)',
              ),
            resolvedDate: z.string().optional().describe('MM/DD/YYYY'),
            enforcementActions: z
              .array(
                z
                  .object({
                    date: z.string().optional().describe('MM/DD/YYYY'),
                    type: z.string().optional().describe('"Formal", "Informal", or "Resolving"'),
                    description: z.string().optional().describe('Action'),
                    agency: z.string().optional().describe('Agency that took it'),
                  })
                  .describe('One action'),
              )
              .optional()
              .describe('Linked enforcement actions; absent when none'),
          })
          .describe('One violation; empty fields absent, never defaulted'),
      )
      .describe(
        "ECHO's 5-year SDWIS report for a public water system, newest compliance period first",
      ),
    drinkingWaterViolationsTotal: z.number().describe('Across every page'),
    drinkingWaterViolationsNextOffset: z
      .number()
      .optional()
      .describe('Next drinking_water_violations_offset; absent on the last page'),
    formalActions: z
      .array(
        z
          .object({
            caseId: z
              .string()
              .optional()
              .describe(
                'Pass to epa_echo_get_case for the civil case report; absent when none, as for RCRA and SDWA actions',
              ),
            settlementDate: z.string().optional().describe('Case settlement, MM/DD/YYYY'),
            penaltyAssessedInDollars: z.number().optional().describe('In dollars'),
            actionType: z.string().optional().describe('Action type'),
            actionDate: z.string().optional().describe('MM/DD/YYYY'),
            statute: z.string().optional().describe('Statute'),
            sourceId: z.string().optional().describe('Program ID concerned'),
            leadAgency: z.string().optional().describe('EPA, State, or Local'),
          })
          .describe('One formal action'),
      )
      .describe('5-year window, newest first'),
    airCompliance: z
      .object({
        programId: z
          .string()
          .optional()
          .describe('ICIS-Air ID if exactly one; absent when several (see programIds)'),
        status: z.string().optional().describe('Current CAA status'),
        statusDate: z.string().optional().describe('End of the latest quarter covered, MM/DD/YYYY'),
      })
      .optional()
      .describe('Present only when programs.air is true and ECHO reports a CAA status'),
    waterCompliance: z
      .object({
        status: z.string().optional().describe('Current CWA status'),
        permitId: z
          .string()
          .optional()
          .describe('NPDES permit ID if exactly one; absent when several (see programIds)'),
      })
      .optional()
      .describe('Present only when programs.water is true and ECHO reports a CWA status'),
    effluentExceedances: z
      .array(
        z
          .object({
            permitId: z.string().optional().describe('NPDES permit ID'),
            parameterCode: z.string().optional().describe('5-digit NPDES code'),
            parameterName: z.string().optional().describe('Pollutant name'),
            outfall: z.string().optional().describe('Outfall code'),
            monitoringLocation: z.string().optional().describe('Where it is measured'),
            measurementType: z
              .string()
              .optional()
              .describe(
                'Mthly: monthly-average limit; NMth: non-monthly, usually a maximum; Neither: another kind',
              ),
            quarters: z
              .array(
                z
                  .object({
                    start: z.string().optional().describe('MM/DD/YYYY'),
                    end: z
                      .string()
                      .optional()
                      .describe("MM/DD/YYYY; the 13th ends at ECHO's last refresh"),
                    value: z
                      .string()
                      .describe(
                        'Highest percent over the limit as ECHO writes it, or LIMIT VIOLATION where that percent is not representative',
                      ),
                    status: z
                      .string()
                      .optional()
                      .describe("ECHO's code, S or R; absent when unsent"),
                  })
                  .describe('One quarter; omitted dates absent'),
              )
              .describe('Quarters with an exceedance, oldest first'),
          })
          .describe('One series; empty fields absent'),
      )
      .describe(
        'CWA effluent limit exceedances, 13-quarter window, one per permit, outfall, parameter, location, and measurement type, in that order',
      ),
    effluentExceedancesTotal: z.number().describe('Across every page'),
    effluentExceedancesNextOffset: z
      .number()
      .optional()
      .describe('Next effluent_exceedances_offset; absent on the last page'),
    rcraViolations: z
      .array(
        z
          .object({
            handlerId: z.string().optional().describe('RCRA handler ID'),
            violationType: z.string().optional().describe('National violation type code'),
            violation: z.string().optional().describe('Type name'),
            agency: z.string().optional().describe('State code or EPA'),
            determinedDate: z.string().optional().describe('MM/DD/YYYY; can precede the window'),
            returnedToComplianceDate: z
              .string()
              .optional()
              .describe('MM/DD/YYYY; absent while open'),
            reportUrl: z.string().optional().describe('ECHO report URL'),
          })
          .describe('One violation; empty fields absent'),
      )
      .describe('12-quarter window, newest determination first'),
    rcraViolationsTotal: z.number().describe('Across every page'),
    rcraViolationsNextOffset: z
      .number()
      .optional()
      .describe('Next rcra_violations_offset; absent on the last page'),
    highPriorityViolations: z
      .array(
        z
          .object({
            airProgramId: z.string().optional().describe('ICIS-Air ID'),
            violationId: z.string().optional().describe('ICIS-Air activity ID'),
            programs: z.string().optional().describe('Air program codes, comma-separated'),
            pollutants: z.string().optional().describe('Comma-separated'),
            agency: z.string().optional().describe('State code or EPA'),
            beginDate: z.string().optional().describe('MM/DD/YYYY; can precede the window'),
            resolvedDate: z.string().optional().describe('MM/DD/YYYY; absent while unresolved'),
          })
          .describe('One violation; empty fields absent'),
      )
      .describe('CAA High Priority Violations, 12-quarter window'),
    programIds: z
      .array(
        z
          .object({
            system: z.string().describe('EPA data system, as ECHO names it'),
            id: z.string().describe('Program ID'),
            statute: z.string().optional().describe('Statute'),
            status: z
              .string()
              .optional()
              .describe('Permit, operating, activity, or reporting status'),
            universe: z.string().optional().describe('Classification within the system'),
            expirationDate: z.string().optional().describe('Permit expiration, MM/DD/YYYY'),
          })
          .describe('One program ID; empty fields absent'),
      )
      .describe("FRS-linked program IDs besides the Registry ID, ECHO's order"),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        "Present when ECHO's facility search failed, leaving out complianceStatus and compliance.",
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when inspections, drinkingWaterViolations, effluentExceedances, or rcraViolations has more pages; absent otherwise.',
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
      when: 'ECHO has no facility for registry_id.',
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
      { tool: 'epa_echo_get_facility', param: 'drinking_water_violations_limit' },
    );
    const inspections = clampLimit(input.inspections_limit, INSPECTION_SLICE.cap, {
      tool: 'epa_echo_get_facility',
      param: 'inspections_limit',
    });
    const limitNotice = [violations.notice, inspections.notice].filter(Boolean).join(' ');
    if (limitNotice) ctx.enrich({ limitNotice });

    const profile = await getEchoService().getFacility(input.registry_id, ctx, {
      drinkingWaterViolations: {
        limit: violations.limit,
        offset: input.drinking_water_violations_offset,
      },
      inspections: { limit: inspections.limit, offset: input.inspections_offset },
      effluentExceedances: {
        limit: input.effluent_exceedances_limit,
        offset: input.effluent_exceedances_offset,
      },
      rcraViolations: { limit: input.rcra_violations_limit, offset: input.rcra_violations_offset },
    });
    if (
      profile.drinkingWaterViolationsNextOffset !== undefined ||
      profile.inspectionsNextOffset !== undefined ||
      profile.effluentExceedancesNextOffset !== undefined ||
      profile.rcraViolationsNextOffset !== undefined
    ) {
      ctx.enrich({ truncated: true });
    }

    ctx.log.info('epa_echo_get_facility completed', {
      registryId: profile.registryId,
      inspections: profile.inspections.length,
      drinkingWaterViolations: profile.drinkingWaterViolations.length,
      effluentExceedances: profile.effluentExceedances.length,
      rcraViolations: profile.rcraViolations.length,
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
        lines.push(nextOffsetLine(result.inspectionsNextOffset, 'inspections_offset'));
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
          nextOffsetLine(
            result.drinkingWaterViolationsNextOffset,
            'drinking_water_violations_offset',
          ),
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

    const effluentTotal = result.effluentExceedancesTotal;
    if (result.programs.water || effluentTotal > 0) {
      const next = result.effluentExceedancesNextOffset;
      const shown = pageLabel(result.effluentExceedances.length, effluentTotal, next);
      lines.push(`\n### CWA Effluent Exceedances (${shown})`);
      if (next !== undefined) {
        lines.push(nextOffsetLine(next, 'effluent_exceedances_offset'));
      }
      for (const series of result.effluentExceedances) {
        const parts = [
          series.permitId,
          series.outfall && `outfall ${series.outfall}`,
          [series.parameterCode, series.parameterName].filter(Boolean).join(' '),
          series.monitoringLocation && `monitoring location ${series.monitoringLocation}`,
          series.measurementType,
        ]
          .filter(Boolean)
          .join(' — ');
        lines.push(`- ${escapeMarkdownInline(parts || 'Exceedance series (no detail)')}`);
        for (const q of series.quarters) {
          const period = q.start && q.end ? `${q.start}–${q.end}` : (q.start ?? q.end);
          const detail = `${period ? `${period}: ` : ''}${q.value}${q.status ? ` (status ${q.status})` : ''}`;
          lines.push(`  - ${escapeMarkdownInline(detail)}`);
        }
      }
    }

    const rcraTotal = result.rcraViolationsTotal;
    if (result.programs.rcra || rcraTotal > 0) {
      const next = result.rcraViolationsNextOffset;
      lines.push(
        `\n### RCRA Violations (${pageLabel(result.rcraViolations.length, rcraTotal, next)})`,
      );
      if (next !== undefined) {
        lines.push(nextOffsetLine(next, 'rcra_violations_offset'));
      }
      for (const v of result.rcraViolations) {
        const parts = [
          v.handlerId,
          [v.violationType, v.violation].filter(Boolean).join(' '),
          v.agency,
          v.determinedDate && `determined ${v.determinedDate}`,
          v.returnedToComplianceDate && `returned to compliance ${v.returnedToComplianceDate}`,
        ]
          .filter(Boolean)
          .join(' — ');
        const report = v.reportUrl ? ` — ${markdownLink('violation report', v.reportUrl)}` : '';
        lines.push(`- ${escapeMarkdownInline(parts || 'RCRA violation (no detail)')}${report}`);
      }
    }

    const hpvs = result.highPriorityViolations;
    if (result.programs.air || hpvs.length > 0) {
      lines.push(`\n### CAA High Priority Violations (${hpvs.length})`);
      for (const h of hpvs) {
        const parts = [
          h.airProgramId,
          h.violationId && `violation ${h.violationId}`,
          h.programs && `programs ${h.programs}`,
          h.pollutants && `pollutants ${h.pollutants}`,
          h.agency,
          h.beginDate && `from ${h.beginDate}`,
          h.resolvedDate && `resolved ${h.resolvedDate}`,
        ]
          .filter(Boolean)
          .join(' — ');
        lines.push(`- ${escapeMarkdownInline(parts || 'High Priority Violation (no detail)')}`);
      }
    }

    if (result.programIds.length > 0) {
      lines.push(`\n### Program IDs (${result.programIds.length})`);
      for (const p of result.programIds) {
        const parts = [
          `${p.system} ${p.id}`,
          p.statute,
          p.status,
          p.universe,
          p.expirationDate && `expires ${p.expirationDate}`,
        ]
          .filter(Boolean)
          .join(' — ');
        lines.push(`- ${escapeMarkdownInline(parts)}`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
