/**
 * @fileoverview Tool for retrieving a full compliance profile for a single EPA-regulated facility.
 * @module mcp-server/tools/definitions/get-facility.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEchoService } from '@/services/echo/echo-service.js';

export const getFacilityTool = tool('epa_get_facility', {
  title: 'Get EPA Facility Compliance Profile',
  description:
    'Retrieve a full compliance profile for a single EPA-regulated facility by EPA Registry ID. Aggregates facility metadata, per-program compliance status, inspection history, formal enforcement actions, penalty amounts, and TRI release totals from multiple ECHO DFR endpoints in parallel. Use epa_search_facilities to discover Registry IDs. For area-level enforcement discovery use epa_search_violations instead.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    registry_id: z
      .string()
      .min(1)
      .describe('EPA FRS Registry ID for the facility (obtained from epa_search_facilities)'),
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
    complianceStatus: z.string().optional().describe('Overall compliance status text'),
    programs: z
      .object({
        air: z.boolean().describe('Registered under Clean Air Act (CAA)'),
        water: z.boolean().describe('Registered under Clean Water Act (CWA)'),
        rcra: z.boolean().describe('Registered under RCRA (hazardous waste)'),
        tri: z.boolean().describe('Participates in Toxic Release Inventory (TRI)'),
        sdwa: z.boolean().describe('Regulated under Safe Drinking Water Act'),
      })
      .describe('Program registration flags'),
    triReleasesTransfersInLbs: z
      .number()
      .optional()
      .describe('Total TRI on/off-site releases and transfers in pounds'),
    compliance: z
      .object({
        mediaStatusCode: z.string().optional().describe('Compliance media status code'),
        mediaStatusDescription: z
          .string()
          .optional()
          .describe('Human-readable compliance status description'),
        quartersInViolation: z
          .number()
          .optional()
          .describe('Number of quarters with compliance violations in the past 3 years'),
      })
      .optional()
      .describe(
        'Compliance summary from DFR. Absent when ECHO DFR compliance endpoint unavailable.',
      ),
    inspections: z
      .array(
        z
          .object({
            activityType: z.string().optional().describe('Inspection activity type code'),
            activityDate: z.string().optional().describe('Date of inspection'),
            description: z.string().optional().describe('Activity type description'),
          })
          .describe('Single inspection record with activity type and date'),
      )
      .describe('Inspection history records'),
    formalActions: z
      .array(
        z
          .object({
            caseId: z.string().optional().describe('Enforcement case identifier'),
            settlementDate: z.string().optional().describe('Settlement or resolution date'),
            penaltyAssessedInDollars: z
              .number()
              .optional()
              .describe('Penalty amount assessed in dollars'),
            actionType: z.string().optional().describe('Type of formal enforcement action'),
          })
          .describe('Single formal enforcement action with case ID and penalty amount'),
      )
      .describe('Formal enforcement actions on record'),
    airCompliance: z
      .object({
        programId: z.string().optional().describe('CAA program identifier'),
        status: z.string().optional().describe('Air compliance status'),
        statusDate: z.string().optional().describe('Date of status determination'),
      })
      .optional()
      .describe(
        'CAA-specific compliance details. Present only when facility is registered under CAA (programs.air=true).',
      ),
    waterCompliance: z
      .object({
        programId: z.string().optional().describe('CWA program identifier'),
        status: z.string().optional().describe('Water compliance status'),
        permitId: z.string().optional().describe('NPDES permit ID'),
      })
      .optional()
      .describe(
        'CWA/NPDES permit and compliance details. Present only when facility is registered under CWA (programs.water=true).',
      ),
  }),

  errors: [
    {
      reason: 'facility_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'ECHO returned no facility record for the given Registry ID.',
      recovery: 'Verify the Registry ID using epa_search_facilities and retry with a valid ID.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('epa_get_facility', { registryId: input.registry_id });

    const profile = await getEchoService().getFacility(input.registry_id.trim(), ctx);

    if (!profile.registryId) {
      throw ctx.fail(
        'facility_not_found',
        `No facility found for Registry ID "${input.registry_id}".`,
        {
          ...ctx.recoveryFor('facility_not_found'),
        },
      );
    }

    ctx.log.info('epa_get_facility completed', {
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

    const location = [result.street, result.city, result.state, result.zip]
      .filter(Boolean)
      .join(', ');
    if (location) lines.push(`**Location:** ${location}`);
    if (result.county)
      lines.push(
        `**County:** ${result.county}${result.fipsCode ? ` (FIPS: ${result.fipsCode})` : ''}`,
      );
    if (result.latitude !== undefined && result.longitude !== undefined) {
      lines.push(`**Coordinates:** ${result.latitude}, ${result.longitude}`);
    }
    if (result.complianceStatus) lines.push(`**Compliance Status:** ${result.complianceStatus}`);

    const activePrograms = Object.entries(result.programs)
      .filter(([, v]) => v)
      .map(([k]) => k.toUpperCase())
      .join(', ');
    if (activePrograms) lines.push(`**Programs:** ${activePrograms}`);

    if (result.triReleasesTransfersInLbs !== undefined) {
      lines.push(
        `**TRI Releases+Transfers:** ${result.triReleasesTransfersInLbs.toLocaleString()} lbs`,
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

    if (result.inspections.length > 0) {
      lines.push('\n### Inspections');
      for (const insp of result.inspections) {
        const parts = [insp.activityDate, insp.activityType, insp.description]
          .filter(Boolean)
          .join(' — ');
        lines.push(`- ${parts || 'Inspection record (no detail)'}`);
      }
    }

    if (result.formalActions.length > 0) {
      lines.push('\n### Formal Enforcement Actions');
      for (const fa of result.formalActions) {
        const penalty =
          fa.penaltyAssessedInDollars !== undefined
            ? ` | Penalty: $${fa.penaltyAssessedInDollars.toLocaleString()}`
            : '';
        lines.push(
          `- ${fa.caseId ?? 'Case'}: ${fa.actionType ?? 'Action'}${penalty}${fa.settlementDate ? ` (${fa.settlementDate})` : ''}`,
        );
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
