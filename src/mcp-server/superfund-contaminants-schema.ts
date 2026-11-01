/**
 * @fileoverview Sparse SEMS contaminant association output shared by tool and resource.
 * @module mcp-server/superfund-contaminants-schema
 */
import { z } from '@cyanheads/mcp-ts-core';

/** All source association rows, without inferring exposure, concentrations, or current risk. */
export const superfundContaminantsSchema = z
  .array(
    z
      .object({
        name: z.string().optional().describe('Preferred contaminant name'),
        medium: z.string().optional().describe('Environmental medium associated with the action'),
        operableUnit: z
          .string()
          .optional()
          .describe('Operable unit identifier, preserving leading zeros'),
        action: z.string().optional().describe('EPA action associated with the contaminant'),
        typeCode: z.string().optional().describe('Raw SEMS action type code'),
      })
      .describe('One contaminant association; repeated chemicals and source rows are retained'),
  )
  .describe('Every SEMS contaminant association for the site; empty when none are recorded');
