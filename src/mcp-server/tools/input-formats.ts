/**
 * @fileoverview Shared input formats for state codes, ZIP codes, and calendar dates: the
 * advertised schemas, and the normalizers that turn a parsed value into what the upstreams match.
 * @module mcp-server/tools/input-formats
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';

/**
 * Every code an EPA upstream files records under: the 50 states, DC, the five inhabited
 * territories (PR, VI, GU, AS, MP), the freely associated states (FM, MH, PW), UM (US Minor
 * Outlying Islands), NN (Navajo Nation), and the EPA region codes 01–10 that SDWIS uses as
 * `primacy_agency_code` for tribal water systems.
 */
export const STATE_CODES: ReadonlySet<string> = new Set(
  'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR VI GU AS MP FM MH PW UM NN 01 02 03 04 05 06 07 08 09 10'.split(
    ' ',
  ),
);

/*
 * Advertised patterns accept every form the server answers. Zod drops regex flags from the JSON
 * Schema, so case lives in the character class. The optional variants also accept a blank value,
 * which the normalizers read as omitted. Each pattern is linear: no two adjacent quantified parts
 * can match the same character.
 */
const STATE_PATTERN = /^\s*[A-Za-z0-9]{2}\s*$/;
const OPTIONAL_STATE_PATTERN = /^\s*(?:[A-Za-z0-9]{2}\s*)?$/;
const OPTIONAL_ZIP_PATTERN = /^\s*(?:\d{5}(?:-?\d{4})?\s*)?$/;
const OPTIONAL_DATE_PATTERN = /^\s*(?:\d{4}-\d{2}-\d{2}\s*)?$/;

const STATE_FORM =
  'Expected a 2-letter USPS code such as "WA" or "PR". Tribal water systems, searched with epa_water_search_systems, file under an EPA region code 01–10.';
const ZIP_FORM =
  'Expected a 5-digit ZIP code such as "98108"; a ZIP+4 such as "98108-1234" is also accepted.';
const DATE_FORM = 'Expected a calendar date as YYYY-MM-DD, such as "2026-11-02".';

/** Required `state` input. Pair with {@link normalizeState} and spread {@link invalidStateError} into `errors[]`. */
export const stateSchema = (description: string) =>
  z.string().regex(STATE_PATTERN, STATE_FORM).describe(description);

/** Optional `state` input; a blank value reads as omitted. */
export const optionalStateSchema = (description: string) =>
  z.string().regex(OPTIONAL_STATE_PATTERN, STATE_FORM).optional().describe(description);

/** Optional `zip_code` input: 5 digits or a ZIP+4, hyphenated or not; a blank value reads as omitted. */
export const optionalZipSchema = (description: string) =>
  z.string().regex(OPTIONAL_ZIP_PATTERN, ZIP_FORM).optional().describe(description);

/** Optional YYYY-MM-DD input that must name a real calendar day; a blank value reads as omitted. */
export const optionalDateSchema = (description: string) =>
  z
    .string()
    // A value that fails the form never reaches the calendar check, so it carries one message.
    .regex(OPTIONAL_DATE_PATTERN, { message: DATE_FORM, abort: true })
    .refine((value) => {
      const date = value.trim();
      return date === '' || isCalendarDate(date);
    }, `Not a calendar date. ${DATE_FORM}`)
    .optional()
    .describe(description);

/** True when `date` (YYYY-MM-DD) names a day that exists, so "2026-02-30" is false. */
export function isCalendarDate(date: string): boolean {
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

/**
 * Error contract entry for {@link normalizeState}'s membership check. Spread into the `errors[]`
 * of every tool that calls it.
 */
export const invalidStateError = {
  reason: 'invalid_state',
  code: JsonRpcErrorCode.ValidationError,
  when: 'state has the 2-character form but is not a US state, DC, territory, freely associated state, UM, NN, or EPA region code.',
  recovery:
    'Use a 2-letter USPS code such as WA, DC, or PR. Tribal water systems, searched with epa_water_search_systems, file under an EPA region code 01–10.',
  thrownBy: 'service',
} as const;

/**
 * A parsed `state` value as the upstreams match it: trimmed and uppercased, or `undefined` for a
 * blank optional value.
 * @throws McpError `ValidationError` with reason `invalid_state` when the code is not in {@link STATE_CODES}.
 */
export function normalizeState(raw: string): string;
export function normalizeState(raw: string | undefined): string | undefined;
export function normalizeState(raw: string | undefined): string | undefined {
  const code = normalizeStateCode(raw);
  if (!code) return;
  if (!STATE_CODES.has(code)) {
    throw validationError(`state "${code}" is not a US state, DC, territory, or EPA region code.`, {
      reason: invalidStateError.reason,
      state: code,
    });
  }
  return code;
}

/**
 * A parsed `state` value trimmed and uppercased, or `undefined` for a blank optional value, with
 * no membership check. For the ECHO searches: ECHO files records under codes outside
 * {@link STATE_CODES} (DM for offshore Gulf of Mexico platforms, Canadian provinces, MX), so a
 * well-formed code it holds nothing under is an empty result, not an error.
 */
export function normalizeStateCode(raw: string | undefined): string | undefined {
  return raw?.trim().toUpperCase() || undefined;
}

/** A parsed `zip_code` value as its first five digits, or `undefined` for a blank optional value. */
export function normalizeZip(raw: string): string;
export function normalizeZip(raw: string | undefined): string | undefined;
export function normalizeZip(raw: string | undefined): string | undefined {
  return raw?.trim().slice(0, 5) || undefined;
}

/** A parsed optional date, trimmed, or `undefined` for a blank value. */
export function normalizeDate(raw: string | undefined): string | undefined {
  return raw?.trim() || undefined;
}
