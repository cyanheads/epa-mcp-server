/**
 * @fileoverview Builds the `effectiveQuery` echo the search tools return: the request as the
 * server sent it upstream, in the tool's own input names. Built from the values the server sent,
 * never from an upstream's own parameter echo, which can list values the upstream ignored and
 * defaults the server never sent.
 * @module mcp-server/tools/effective-query
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';

/** Enrichment field for a search tool's `enrichment` block. */
export const effectiveQueryEnrichment = {
  effectiveQuery: z
    .string()
    .optional()
    .describe(
      'The search as the server sent it upstream, in this tool\'s input names: normalized values, how each text filter matched ("=" exact, "contains", "begins with", "has words"), and defaults that change what comes back. Terms are separated by "; ".',
    ),
};

/** `name=value`: an exact match, a code, or a setting. */
export const equalsTerm = (name: string, value: string | number | boolean): string =>
  `${name}=${value}`;

/** `name contains value`: a case-insensitive substring match. */
export const containsTerm = (name: string, value: string): string => `${name} contains ${value}`;

/** `name begins with value`: a prefix match. */
export const beginsWithTerm = (name: string, value: string): string =>
  `${name} begins with ${value}`;

/**
 * Writes `effectiveQuery`: the terms that applied, in order, joined with "; ". A falsy term is a
 * filter the call did not send. Call once per successful call, empty results included.
 */
export function echoQuery(ctx: Context, terms: ReadonlyArray<string | false | undefined>): void {
  ctx.enrich.echo(terms.filter((term): term is string => Boolean(term)).join('; '));
}
