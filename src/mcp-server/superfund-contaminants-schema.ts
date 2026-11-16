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
        name: z.string().optional().describe('Preferred name'),
        medium: z.string().optional().describe('Environmental medium'),
        operableUnit: z.string().optional().describe('Leading zeros kept'),
        action: z.string().optional().describe('EPA action'),
        typeCode: z.string().optional().describe('SEMS action type code'),
      })
      .describe('One association; repeats are kept'),
  )
  .describe('Every SEMS contaminant association for the site');
