/**
 * @fileoverview Shared input formats for state codes, ZIP codes (single values, and the lists the
 * ECHO searches take), calendar dates, and TRI facility and chemical IDs: the advertised schemas,
 * and the normalizers that turn a parsed value into what the upstreams match.
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
const ZIP_PATTERN = /^\s*\d{5}(?:-?\d{4})?\s*$/;
const OPTIONAL_ZIP_PATTERN = /^\s*(?:\d{5}(?:-?\d{4})?\s*)?$/;
const OPTIONAL_DATE_PATTERN = /^\s*(?:\d{4}-\d{2}-\d{2}\s*)?$/;
/**
 * Every tri.tri_facility ID is 15 letters or digits (all 64,990 rows, 2026-11-15); DMAP answers
 * one the same with surrounding whitespace, end slashes, or lowercase letters.
 */
const TRI_FACILITY_ID_PATTERN = /^\s*\/*[0-9A-Za-z]{15}\/*\s*$/;
/**
 * A TRI chemical ID (all 860 tri.tri_chem_info rows, 2026-11-15): a CAS Registry Number of at
 * most 10 digits, hyphenated or not, leading zeros optional; a category code, N and three digits;
 * or one of TRI's four placeholders.
 */
const OPTIONAL_CHEMICAL_ID_PATTERN =
  /^\s*(?:(?:\d{2,7}-\d{2}-\d|\d{5,10}|[Nn]\d{3}|MIXTURE|TRD SECRT|NA|INVALID)\s*)?$/;

const STATE_FORM =
  'Expected a 2-letter USPS code such as "WA" or "PR". Tribal water systems, searched with epa_water_search_systems, file under an EPA region code 01–10.';
const ZIP_FORM =
  'Expected a 5-digit ZIP code such as "98108"; a ZIP+4 such as "98108-1234" is also accepted.';
const DATE_FORM = 'Expected a calendar date as YYYY-MM-DD, such as "2026-11-02".';
const TRI_FACILITY_ID_FORM =
  'Expected a 15-character TRI facility ID such as "98108THBNG7500E", the facilityId epa_tri_search_releases returns. A 12-digit EPA Registry ID is a different identifier; epa_echo_get_facility lists its TRI facility IDs as triFacilityIds.';
const CHEMICAL_ID_FORM =
  'Expected a CAS Registry Number such as "71-43-2" (hyphens and leading zeros optional, at most 10 digits), a TRI category code such as "N420", or a chemicalId as the TRI tools return it.';

/** Required `state` input. Pair with {@link normalizeState} and spread {@link invalidStateError} into `errors[]`. */
export const stateSchema = (description: string) =>
  z.string().regex(STATE_PATTERN, STATE_FORM).describe(description);

/** Optional `state` input; a blank value reads as omitted. */
export const optionalStateSchema = (description: string) =>
  z.string().regex(OPTIONAL_STATE_PATTERN, STATE_FORM).optional().describe(description);

/** Optional `zip_code` input: 5 digits or a ZIP+4, hyphenated or not; a blank value reads as omitted. */
export const optionalZipSchema = (description: string) =>
  z.string().regex(OPTIONAL_ZIP_PATTERN, ZIP_FORM).optional().describe(description);

/**
 * Most codes one ECHO search list takes. ECHO stops processing a request's filter values at about
 * 2,900 characters, shared across parameters (487 ZIP codes pass, 496 fail), and 100 state codes
 * beside 300 ZIP codes pass on both ECHO searches with every other filter set. Time sets the lower
 * ZIP bound: ECHO's facility discovery grows faster than the ZIP list (150 ZIPs 2–3 s, 200 ZIPs
 * 9–13 s, 300 ZIPs 41–58 s against the 58 s search budget). A state list costs by its match, not
 * its length, so its bound stays at the character limit.
 */
const STATE_LIST_MAX = 100;
const ZIP_LIST_MAX = 200;

/**
 * A list input's elements, before the schema checks them: a string is a comma-joined list, or a
 * JSON-stringified one when it opens with `[`. Blank elements drop out, and an empty list reads as
 * omitted. A list longer than `max` keeps one element past it, so the schema rejects its length
 * without checking and reporting every element.
 */
const asList =
  (max: number) =>
  (value: unknown): unknown => {
    const list = typeof value === 'string' ? splitList(value) : value;
    if (!Array.isArray(list)) return list;
    const kept = list.filter((element) => typeof element !== 'string' || element.trim() !== '');
    return kept.length > 0 ? kept.slice(0, max + 1) : undefined;
  };

/** A list sent as one string: parsed when it opens with `[` and is JSON, else split on commas. */
function splitList(text: string): unknown {
  if (text.trimStart().startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      // Not JSON ("[WA"): split like any other string, so the element fails the code form.
    }
  }
  return text.split(',');
}

/**
 * Optional list of 2-character `state` codes for the ECHO searches, at most 100. A plain or
 * comma-joined string is read as the list it names. Pair with {@link normalizeStateList}.
 */
export const stateListSchema = (description: string) =>
  z
    .preprocess(
      asList(STATE_LIST_MAX),
      z
        .array(z.string().regex(STATE_PATTERN, STATE_FORM))
        .max(
          STATE_LIST_MAX,
          `Pass at most ${STATE_LIST_MAX} state codes; split a longer list across calls.`,
        )
        .optional(),
    )
    .describe(description);

/**
 * Optional list of `zip_code` values (5 digits or a ZIP+4) for the ECHO searches, at most 200. A
 * plain or comma-joined string is read as the list it names. Pair with {@link normalizeZipList}.
 */
export const zipListSchema = (description: string) =>
  z
    .preprocess(
      asList(ZIP_LIST_MAX),
      z
        .array(z.string().regex(ZIP_PATTERN, ZIP_FORM))
        .max(
          ZIP_LIST_MAX,
          `Pass at most ${ZIP_LIST_MAX} ZIP codes; split a longer list across calls.`,
        )
        .optional(),
    )
    .describe(description);

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

/** Required TRI `facility_id` input. Pair with {@link normalizeTriFacilityId}. */
export const triFacilityIdSchema = (description: string) =>
  z
    .string({ error: TRI_FACILITY_ID_FORM })
    .regex(TRI_FACILITY_ID_PATTERN, TRI_FACILITY_ID_FORM)
    .describe(description);

/**
 * Optional `chemical_id` input whose CAS number must carry a valid check digit; a blank value reads
 * as omitted. Pair with {@link normalizeChemicalId}.
 */
export const optionalChemicalIdSchema = (description: string) =>
  z
    .string()
    // A value that fails the form never reaches the check digit, so it carries one message.
    .regex(OPTIONAL_CHEMICAL_ID_PATTERN, { message: CHEMICAL_ID_FORM, abort: true })
    .refine((value) => {
      const id = value.trim();
      return !/^\d/.test(id) || casCheckDigitHolds(id.replaceAll('-', ''));
    }, `The CAS Registry Number fails its check digit. ${CHEMICAL_ID_FORM}`)
    .optional()
    .describe(description);

/**
 * Whether a CAS number's last digit is its check digit: the other digits, each times its place
 * counted from the right, summed mod 10. Leading zeros add nothing.
 */
function casCheckDigitHolds(digits: string): boolean {
  let sum = 0;
  for (let place = 1; place < digits.length; place++) {
    sum += Number(digits[digits.length - 1 - place]) * place;
  }
  return sum % 10 === Number(digits.at(-1));
}

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
  when: 'state is not a US state, territory, or EPA region code.',
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
  const code = raw?.trim().toUpperCase();
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
 * A parsed state list as ECHO matches it: each code trimmed and uppercased, once, in first-seen
 * order, or `undefined` when the list is omitted or empty. No membership check: ECHO files records
 * under codes outside {@link STATE_CODES} (DM for offshore Gulf of Mexico platforms, Canadian
 * provinces, MX), so a well-formed code it holds nothing under is an empty result, not an error.
 */
export function normalizeStateList(list: readonly string[] | undefined): string[] | undefined {
  return list?.length ? [...new Set(list.map((code) => code.trim().toUpperCase()))] : undefined;
}

/** A parsed `zip_code` value as its first five digits, or `undefined` for a blank optional value. */
export function normalizeZip(raw: string): string;
export function normalizeZip(raw: string | undefined): string | undefined;
export function normalizeZip(raw: string | undefined): string | undefined {
  return raw?.trim().slice(0, 5) || undefined;
}

/**
 * A parsed ZIP list as each code's first five digits (ECHO matches a ZIP+4 element to nothing),
 * once, in first-seen order, or `undefined` when the list is omitted or empty.
 */
export function normalizeZipList(list: readonly string[] | undefined): string[] | undefined {
  return list?.length ? [...new Set(list.map((zip) => normalizeZip(zip)))] : undefined;
}

/** A parsed optional date, trimmed, or `undefined` for a blank value. */
export function normalizeDate(raw: string | undefined): string | undefined {
  return raw?.trim() || undefined;
}

/**
 * A parsed TRI `facility_id` as DMAP matches it: its 15 characters, uppercased. The schema admits
 * only whitespace and slashes around them, so dropping both leaves the ID.
 */
export function normalizeTriFacilityId(raw: string): string {
  return raw.replace(/[\s/]/g, '').toUpperCase();
}

/**
 * A parsed `chemical_id` as DMAP matches tri_chem_id, or `undefined` for a blank value: a CAS
 * number as 10 zero-padded digits (DMAP matches no other form of it), a category code uppercased,
 * a placeholder as given.
 */
export function normalizeChemicalId(raw: string | undefined): string | undefined {
  const id = raw?.trim();
  if (!id) return;
  return /^\d/.test(id) ? id.replaceAll('-', '').padStart(10, '0') : id.toUpperCase();
}
