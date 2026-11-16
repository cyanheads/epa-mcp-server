/**
 * @fileoverview Shared paging contract for list tools: a `limit` clamped to a per-tool cap, an
 * `offset`, and the `nextOffset` / `limitNotice` enrichment fields that disclose continuation
 * and clamping.
 * @module mcp-server/tools/paging
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createCounter, logger } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { formatNotice } from '@/mcp-server/tools/format-notice.js';

const clampCounter = createCounter(
  'epa.input.count_clamped',
  'Count inputs served at the tool cap instead of the requested value',
  '{calls}',
);

/** `tool:param` pairs whose first clamp this process has logged. */
const loggedClamps = new Set<string>();

interface LimitOptions {
  /** Most records one call returns. */
  cap: number;
  defaultLimit: number;
  /** Field that carries the next offset; defaults to `nextOffset`. */
  nextOffsetField?: string;
  /** Plural record noun for the description, e.g. "facilities". */
  noun: string;
  /** Input that continues the list; defaults to `offset`. */
  offsetParam?: string;
}

/**
 * A `limit`-style input with no schema maximum: resolve the value a call applies with
 * {@link clampLimit}. With `EPA_CLAMP_LIMITS=false` the cap becomes a strict maximum instead.
 * Reads the server config when the schema is built, so `.env` must load before tool modules
 * evaluate (`src/load-env.ts`).
 */
export const limitSchema = ({
  cap,
  defaultLimit,
  noun,
  offsetParam = 'offset',
  nextOffsetField = 'nextOffset',
}: LimitOptions) => {
  const capText = cap.toLocaleString('en-US');
  const paging = `Page past it with ${offsetParam} and ${nextOffsetField}.`;
  if (!getServerConfig().clampLimits) {
    return z
      .number()
      .int()
      .min(1)
      .max(cap)
      .default(defaultLimit)
      .describe(
        `Number of ${noun} to return in one call, 1–${capText} (default ${defaultLimit}). ${paging}`,
      );
  }
  return z
    .number()
    .int()
    .min(1)
    .default(defaultLimit)
    .describe(
      `Number of ${noun} to return in one call. Default ${defaultLimit}; a larger value returns at most ${capText} and says so. ${paging}`,
    );
};

/**
 * A `limit`-style input over a list the tool already holds whole and that never nears a size cap
 * (a slice of one upstream report): no maximum in either `EPA_CLAMP_LIMITS` mode, and a larger
 * value returns the rest of the list, so it needs no {@link clampLimit}.
 */
export const wholeListLimitSchema = ({
  defaultLimit,
  noun,
  offsetParam,
  nextOffsetField,
}: Omit<LimitOptions, 'cap'> & { nextOffsetField: string; offsetParam: string }) =>
  z
    .number()
    .int()
    .min(1)
    .default(defaultLimit)
    .describe(
      `Number of ${noun} to return in one call. Default ${defaultLimit}; a larger value returns the rest of the list. Page past it with ${offsetParam} and ${nextOffsetField}.`,
    );

/** An `offset`-style input: zero-based position of the first record to return. */
export const offsetSchema = (noun: string, nextOffsetField = 'nextOffset') =>
  z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      `Number of ${noun} to skip before this page (default 0). Pass the previous call's ${nextOffsetField} to continue; a value past the end returns an empty page.`,
    );

/**
 * The limit a call applies: the requested value, or `cap` when it asks for more, with the notice
 * that discloses the clamp. Write the notice to `limitNotice`; join several when one call clamps
 * more than one list. A clamp increments `epa.input.count_clamped` and logs once per tool and
 * parameter per process.
 */
export function clampLimit(
  requested: number,
  cap: number,
  { tool, param = 'limit' }: { tool: string; param?: string },
): { limit: number; notice?: string } {
  if (requested <= cap) return { limit: requested };
  clampCounter.add(1, { tool, field: param });
  const key = `${tool}:${param}`;
  if (!loggedClamps.has(key)) {
    loggedClamps.add(key);
    logger.info(
      `${tool} ${param} ${requested} served at its cap of ${cap}; later clamps of this input are counted in epa.input.count_clamped, not logged. EPA_CLAMP_LIMITS=false rejects values above the cap instead.`,
    );
  }
  return {
    limit: cap,
    notice: `${param} ${requested} is above this tool's cap of ${cap}, so at most ${cap} records were returned.`,
  };
}

/**
 * A list page's heading count: the total for a whole list, else the 1-based range the page
 * covers. A page ends at its next offset, or at the end of the list when it is the last one.
 */
export function pageLabel(shown: number, total: number, nextOffset: number | undefined): string {
  if (shown === total) return `${total}`;
  if (shown === 0) return `none on this page of ${total}`;
  const start = (nextOffset ?? total) - shown;
  return `${start + 1}–${start + shown} of ${total}`;
}

/** The `content[]` line under a paged section's heading: the offset that continues that section. */
export function nextOffsetLine(nextOffset: number, offsetParam: string): string {
  return `**Next offset:** ${nextOffset} (pass as ${offsetParam})`;
}

/** Guidance for a capped page: names the offset that continues it, never a larger limit. */
export function continueGuidance(nextOffset: number, offsetParam = 'offset'): string {
  return `More records follow; call again with ${offsetParam} ${nextOffset} to continue.`;
}

/**
 * Ending for a "No X found at offset N" message on an empty page: a page past the end of the
 * result says so and how to recover; an empty page with more records ahead ends the sentence.
 */
export function pastEndSuffix(nextOffset: number | undefined, scope: string, noun: string): string {
  return nextOffset === undefined
    ? `: the ${scope} has no ${noun} past it. Lower offset, or start again at offset 0.`
    : '.';
}

/** Enrichment fields for a list tool's `enrichment` block. Pair with {@link pagingTrailer}. */
export const pagingEnrichment = {
  nextOffset: z.number().optional().describe('Next offset; absent on the last page.'),
  limitNotice: z
    .string()
    .optional()
    .describe('Present when a smaller limit than requested applied; says why.'),
};

/** `enrichmentTrailer` entries for {@link pagingEnrichment}. */
export const pagingTrailer = {
  nextOffset: { label: 'Next offset' },
  limitNotice: { render: formatNotice },
};
