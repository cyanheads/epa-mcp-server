/**
 * @fileoverview Tests for the shared state, ZIP, and date input formats.
 * @module tests/mcp-server/tools/input-formats.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import {
  invalidStateError,
  normalizeDate,
  normalizeState,
  normalizeStateCode,
  normalizeZip,
  optionalDateSchema,
  optionalStateSchema,
  optionalZipSchema,
  STATE_CODES,
  stateSchema,
} from '@/mcp-server/tools/input-formats.js';
import { expectLinearCpu } from '../../helpers.js';

/** The `pattern` a schema advertises in tools/list, compiled the way a JSON Schema client would. */
function advertisedPattern(schema: z.ZodType): RegExp {
  const json = z.toJSONSchema(schema, { io: 'input' }) as { pattern?: string };
  expect(json.pattern).toBeTypeOf('string');
  return new RegExp(json.pattern as string, 'u');
}

const accepts = (schema: z.ZodType, value: string) => schema.safeParse(value).success;

describe('STATE_CODES', () => {
  it('holds the 50 states, DC, territories, freely associated states, UM, NN, and regions 01–10', () => {
    expect(STATE_CODES.size).toBe(50 + 1 + 5 + 3 + 1 + 1 + 10);
    for (const code of ['WA', 'DC', 'PR', 'VI', 'GU', 'AS', 'MP', 'FM', 'MH', 'PW', 'UM', 'NN']) {
      expect(STATE_CODES.has(code)).toBe(true);
    }
    for (let region = 1; region <= 10; region++) {
      expect(STATE_CODES.has(String(region).padStart(2, '0'))).toBe(true);
    }
    expect(STATE_CODES.has('ZZ')).toBe(false);
    expect(STATE_CODES.has('11')).toBe(false);
  });
});

describe('state', () => {
  const accepted = ['WA', 'wa', 'tX', ' WA ', '\tWA\n', '09', 'NN', 'ZZ'];
  const rejected = ['Washington', 'W', 'WAS', 'W A', 'W.', '9'];

  it('accepts the 2-character form padded or in any case, and rejects other forms', () => {
    for (const value of accepted) expect(accepts(stateSchema('s'), value)).toBe(true);
    for (const value of rejected) expect(accepts(stateSchema('s'), value)).toBe(false);
    expect(accepts(stateSchema('s'), '')).toBe(false);
  });

  it('reads a blank optional state as omitted', () => {
    for (const value of ['', '   ']) expect(accepts(optionalStateSchema('s'), value)).toBe(true);
    expect(accepts(optionalStateSchema('s'), undefined as unknown as string)).toBe(true);
    for (const value of rejected) expect(accepts(optionalStateSchema('s'), value)).toBe(false);
    expect(normalizeState('')).toBeUndefined();
    expect(normalizeState('  ')).toBeUndefined();
    expect(normalizeState(undefined)).toBeUndefined();
  });

  it('advertises a pattern that accepts every form the schema accepts', () => {
    const required = advertisedPattern(stateSchema('s'));
    const optional = advertisedPattern(optionalStateSchema('s'));
    for (const value of accepted) {
      expect(required.test(value)).toBe(true);
      expect(optional.test(value)).toBe(true);
    }
    expect(optional.test('')).toBe(true);
    for (const value of rejected) {
      expect(required.test(value)).toBe(false);
      expect(optional.test(value)).toBe(false);
    }
  });

  it('normalizes to the trimmed uppercase code', () => {
    expect(normalizeState(' wa ')).toBe('WA');
    expect(normalizeState('09')).toBe('09');
    expect(normalizeState('nn')).toBe('NN');
  });

  it('normalizes a code outside the set without the membership check for the ECHO searches', () => {
    expect(normalizeStateCode(' dm ')).toBe('DM');
    expect(normalizeStateCode('wa')).toBe('WA');
    expect(normalizeStateCode('  ')).toBeUndefined();
    expect(normalizeStateCode(undefined)).toBeUndefined();
  });

  it('rejects a well-formed code outside the set with the invalid_state reason', () => {
    let thrown: unknown;
    try {
      normalizeState(' zz ');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(McpError);
    const error = thrown as McpError;
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({ reason: 'invalid_state', state: 'ZZ' });
    expect(error.message).toContain('"ZZ"');
  });

  it('declares a contract entry whose recovery names the code form', () => {
    expect(invalidStateError.reason).toBe('invalid_state');
    expect(invalidStateError.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(invalidStateError.recovery).toContain('2-letter');
    expect(invalidStateError.recovery).toContain('01–10');
  });
});

describe('zip_code', () => {
  const accepted = ['98108', ' 98108 ', '98108-1234', '981081234', '07631-2720'];
  const rejected = ['9810', '2134', 'abcde', '98108-12', '98108 1234', '9810812345', '98108-'];

  it('accepts 5 digits or a ZIP+4, hyphenated or not, and rejects other forms', () => {
    for (const value of accepted) {
      expect(accepts(optionalZipSchema('z'), value)).toBe(true);
    }
    for (const value of rejected) {
      expect(accepts(optionalZipSchema('z'), value)).toBe(false);
    }
    expect(accepts(optionalZipSchema('z'), '')).toBe(true);
  });

  it('names the 5-digit form when it rejects', () => {
    const result = optionalZipSchema('z').safeParse('9810');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('5-digit');
  });

  it('advertises a pattern that accepts every form the schema accepts', () => {
    const optional = advertisedPattern(optionalZipSchema('z'));
    for (const value of accepted) {
      expect(optional.test(value)).toBe(true);
    }
    expect(optional.test('')).toBe(true);
    for (const value of rejected) {
      expect(optional.test(value)).toBe(false);
    }
  });

  it('normalizes to the first five digits', () => {
    expect(normalizeZip('98108-1234')).toBe('98108');
    expect(normalizeZip(' 981081234 ')).toBe('98108');
    expect(normalizeZip('98108')).toBe('98108');
    expect(normalizeZip('')).toBeUndefined();
    expect(normalizeZip(undefined)).toBeUndefined();
  });
});

describe('optional date', () => {
  const accepted = ['2026-11-02', ' 2026-11-02 ', '2024-02-29', ''];
  const rejected = ['11/02/2026', '2026-02-30', '2026-13-01', '2025-02-29', '2026-1-2', '20261102'];

  it('accepts a real YYYY-MM-DD day, padded or blank, and rejects other forms', () => {
    for (const value of accepted) expect(accepts(optionalDateSchema('d'), value)).toBe(true);
    for (const value of rejected) expect(accepts(optionalDateSchema('d'), value)).toBe(false);
  });

  it('reports one message per rejection: the form, or the calendar check', () => {
    const wrongForm = optionalDateSchema('d').safeParse('11/02/2026');
    expect(wrongForm.error?.issues).toHaveLength(1);
    expect(wrongForm.error?.issues[0]?.message).toContain('YYYY-MM-DD');
    const notADay = optionalDateSchema('d').safeParse('2026-02-30');
    expect(notADay.error?.issues).toHaveLength(1);
    expect(notADay.error?.issues[0]?.message).toContain('Not a calendar date');
  });

  it('advertises a pattern that accepts every form the schema accepts', () => {
    const pattern = advertisedPattern(optionalDateSchema('d'));
    for (const value of accepted) expect(pattern.test(value)).toBe(true);
    expect(pattern.test('11/02/2026')).toBe(false);
  });

  it('normalizes to the trimmed date, or undefined when blank', () => {
    expect(normalizeDate(' 2026-11-02 ')).toBe('2026-11-02');
    expect(normalizeDate('  ')).toBeUndefined();
    expect(normalizeDate(undefined)).toBeUndefined();
  });
});

describe('pattern cost', () => {
  it.each([
    ['state', stateSchema('s')],
    ['optional state', optionalStateSchema('s')],
    ['zip_code', optionalZipSchema('z')],
    ['date', optionalDateSchema('d')],
  ] as const)('checks a long %s value in time linear in its length', (_, schema) => {
    expectLinearCpu((value) => schema.safeParse(value));
  });
});
