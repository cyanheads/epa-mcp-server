/**
 * @fileoverview Tool for retrieving a full compliance profile for a single EPA-regulated facility.
 * @module mcp-server/tools/definitions/echo-get-facility.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatLbs } from '@/mcp-server/tools/format-lbs.js';
import { formatLocationLines } from '@/mcp-server/tools/format-location.js';
import { getEchoService } from '@/services/echo/echo-service.js';

export const echoGetFacilityTool = tool('epa_echo_get_facility', {
  title: 'Get EPA Facility Compliance Profile',
  description:
    "ECHO: Retrieve a full compliance profile for a single EPA-regulated facility by EPA Registry ID. Returns facility metadata, ECHO's facility-level compliance status, a per-statute (CAA, CWA, RCRA, SDWA, and others ECHO tracks) compliance summary, the newest 100 inspections and other compliance monitoring records from the last five years, five years of formal enforcement actions with penalties, the latest TRI release total, and the facility's TRI facility IDs for epa_tri_get_facility_releases. Use epa_echo_search_facilities to discover Registry IDs. For area-level enforcement discovery use epa_echo_search_violations instead.",
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    registry_id: z
      .string()
      .trim()
      .min(1)
      .describe('EPA FRS Registry ID for the facility (obtained from epa_echo_search_facilities)'),
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
        mediaStatusCode: z
          .string()
          .optional()
          .describe('Not populated: no ECHO response this tool reads carries a media status code.'),
        mediaStatusDescription: z
          .string()
          .optional()
          .describe(
            'Not populated: no ECHO response this tool reads carries a media status description. See complianceStatus and programCompliance.',
          ),
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
        'Inspections, evaluations, investigations, and other compliance monitoring records over the 5-year window, newest first; at most 100 (inspectionsTotal gives the full count)',
      ),
    inspectionsTotal: z
      .number()
      .describe(
        "Compliance monitoring records in ECHO's 5-year history for this facility; inspections lists the newest 100 when there are more",
      ),
    formalActions: z
      .array(
        z
          .object({
            caseId: z
              .string()
              .optional()
              .describe(
                'Enforcement case identifier; absent when ECHO records the action without one, as for RCRA and SDWA actions',
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
        programId: z
          .string()
          .optional()
          .describe(
            'Not populated: the CWA program ID is the NPDES permit ID, returned as permitId.',
          ),
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
  },

  errors: [
    {
      reason: 'facility_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'ECHO has no facility for the given Registry ID.',
      recovery:
        'Verify the Registry ID using epa_echo_search_facilities and retry with a valid ID.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('epa_echo_get_facility', { registryId: input.registry_id });

    const profile = await getEchoService().getFacility(input.registry_id, ctx);

    ctx.log.info('epa_echo_get_facility completed', {
      registryId: profile.registryId,
      inspections: profile.inspections.length,
      formalActions: profile.formalActions.length,
    });

    return profile;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## ${result.name}`);
    lines.push(`**Registry ID:** ${result.registryId}`);

    lines.push(...formatLocationLines(result));
    if (result.complianceStatus) lines.push(`**Compliance Status:** ${result.complianceStatus}`);

    const activePrograms = Object.entries(result.programs)
      .filter(([, v]) => v)
      .map(([k]) => k.toUpperCase())
      .join(', ');
    if (activePrograms) lines.push(`**Programs:** ${activePrograms}`);

    if (result.triFacilityIds.length > 0) {
      lines.push(
        `**TRI Facility IDs:** ${result.triFacilityIds.join(', ')} (most recent first; for epa_tri_get_facility_releases)`,
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
      if (result.compliance.mediaStatusCode)
        lines.push(`**Status Code:** ${result.compliance.mediaStatusCode}`);
      if (result.compliance.mediaStatusDescription)
        lines.push(`**Description:** ${result.compliance.mediaStatusDescription}`);
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
            `Penalties: $${p.totalPenaltiesInDollars.toLocaleString('en-US')}`,
          p.threeYearPeriodStart && `3-year window from ${p.threeYearPeriodStart}`,
          p.fiveYearPeriodStart && `5-year window from ${p.fiveYearPeriodStart}`,
          p.periodEnd && `through ${p.periodEnd}`,
        ].filter(Boolean);
        lines.push(`- **${p.statute}:** ${parts.join(' | ') || 'no summary values'}`);
      }
    }

    if (result.inspections.length > 0) {
      const shown =
        result.inspectionsTotal > result.inspections.length
          ? `newest ${result.inspections.length} of ${result.inspectionsTotal}`
          : `${result.inspectionsTotal}`;
      lines.push(`\n### Inspections (${shown})`);
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
        lines.push(`- ${parts || 'Inspection record (no detail)'}`);
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
            `Penalty: $${fa.penaltyAssessedInDollars.toLocaleString('en-US')}`,
          fa.caseId && `Case ${fa.caseId}`,
          fa.settlementDate && `Settled ${fa.settlementDate}`,
          fa.leadAgency && `${fa.leadAgency} lead`,
        ]
          .filter(Boolean)
          .join(' | ');
        lines.push(`- ${where ? `${where} — ` : ''}${details}`);
      }
    }

    if (result.airCompliance) {
      lines.push('\n### Air (CAA) Compliance');
      if (result.airCompliance.programId)
        lines.push(`**Program ID:** ${result.airCompliance.programId}`);
      if (result.airCompliance.status) lines.push(`**Status:** ${result.airCompliance.status}`);
      if (result.airCompliance.statusDate)
        lines.push(`**Status Date:** ${result.airCompliance.statusDate}`);
    }

    if (result.waterCompliance) {
      lines.push('\n### Water (CWA) Compliance');
      if (result.waterCompliance.programId)
        lines.push(`**Program ID:** ${result.waterCompliance.programId}`);
      if (result.waterCompliance.status) lines.push(`**Status:** ${result.waterCompliance.status}`);
      if (result.waterCompliance.permitId)
        lines.push(`**NPDES Permit:** ${result.waterCompliance.permitId}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
