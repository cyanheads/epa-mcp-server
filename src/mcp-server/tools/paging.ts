/**
 * @fileoverview Shared paging contract for list tools: a capped `limit` with a hard ceiling, an
 * `offset`, and the `nextOffset` / `limitNotice` enrichment fields that disclose continuation
 * and clamping.
 * @module mcp-server/tools/paging
 */

import { z } from '@cyanheads/mcp-ts-core';
import { formatNotice } from '@/mcp-server/tools/format-notice.js';

/**
 * Hard ceiling on every `limit`-style input: the largest page the upstreams serve. A value above
 * a tool's cap and within this ceiling clamps to the cap with a notice; above it fails the schema.
 */
export const LIMIT_CEILING = 5000;

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

/** A `limit`-style input. Resolve the value a call applies with {@link clampLimit}. */
export const limitSchema = ({
  cap,
  defaultLimit,
  noun,
  offsetParam = 'offset',
  nextOffsetField = 'nextOffset',
}: LimitOptions) =>
  z
    .number()
    .int()
    .min(1)
    .max(LIMIT_CEILING)
    .default(defaultLimit)
    .describe(
      `Maximum number of ${noun} to return in one call (1–${cap}, default ${defaultLimit}). A larger value, up to ${LIMIT_CEILING.toLocaleString('en-US')}, returns ${cap} with a notice. Page past it with ${offsetParam} and ${nextOffsetField}.`,
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
 * more than one list.
 */
export function clampLimit(
  requested: number,
  cap: number,
  param = 'limit',
): { limit: number; notice?: string } {
  if (requested <= cap) return { limit: requested };
  return {
    limit: cap,
    notice: `${param} ${requested} is above this tool's cap of ${cap}, so at most ${cap} records were returned.`,
  };
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
  nextOffset: z
    .number()
    .optional()
    .describe(
      'Offset of the next page: present exactly when more records follow, absent on the last page. Pass it as offset to continue.',
    ),
  limitNotice: z
    .string()
    .optional()
    .describe('Present when limit was above the cap and the call returned the cap instead.'),
};

/** `enrichmentTrailer` entries for {@link pagingEnrichment}. */
export const pagingTrailer = {
  nextOffset: { label: 'Next offset' },
  limitNotice: { render: formatNotice },
};
