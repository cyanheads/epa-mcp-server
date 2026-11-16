/**
 * @fileoverview Tests for the shared state, ZIP, date, and TRI facility and chemical ID input formats.
 * @module tests/mcp-server/tools/input-formats.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import {
  invalidStateError,
  normalizeChemicalId,
  normalizeDate,
  normalizeState,
  normalizeStateList,
  normalizeTriFacilityId,
  normalizeZip,
  normalizeZipList,
  optionalChemicalIdSchema,
  optionalDateSchema,
  optionalStateSchema,
  optionalZipSchema,
  STATE_CODES,
  stateListSchema,
  stateSchema,
  triFacilityIdSchema,
  zipListSchema,
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
    expect(normalizeStateList([' dm '])).toEqual(['DM']);
    expect(normalizeStateList(['wa'])).toEqual(['WA']);
    expect(normalizeStateList([])).toBeUndefined();
    expect(normalizeStateList(undefined)).toBeUndefined();
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

describe('regression #73: ECHO state and ZIP lists', () => {
  const states = stateListSchema('s');
  const zips = zipListSchema('z');
  const parsed = (schema: z.ZodType, value: unknown) => {
    const result = schema.safeParse(value);
    expect(result.success, JSON.stringify(value)).toBe(true);
    return result.data;
  };
  const codes = (count: number) =>
    Array.from({ length: count }, (_, i) => `${String.fromCharCode(65 + (i % 26))}${i % 10}`);
  const zipCodes = (count: number) => Array.from({ length: count }, (_, i) => String(10000 + i));

  it.each([
    ['WA', ['WA']],
    [' wa ', [' wa ']],
    ['WA,OR', ['WA', 'OR']],
    ['WA, OR', ['WA', ' OR']],
    ['WA,', ['WA']],
    [',WA', ['WA']],
    ['WA,,OR', ['WA', 'OR']],
    [
      ['WA', 'OR'],
      ['WA', 'OR'],
    ],
    [['WA', '', ' '], ['WA']],
    ['["WA","OR"]', ['WA', 'OR']],
    [' [" wa ", ""] ', [' wa ']],
  ])('reads state %j as the list %j', (value, list) => {
    expect(parsed(states, value)).toEqual(list);
  });

  it.each(['', '   ', ',', ' , ', [], [''], [' ', '']])('reads state %j as omitted', (value) => {
    expect(parsed(states, value)).toBeUndefined();
    expect(parsed(zips, value)).toBeUndefined();
  });

  it.each([
    'WA OR',
    'Washington',
    'W',
    'WA;OR',
    '[WA',
    '["WA OR"]',
    ['WA,OR'],
    ['WA', 'Washington'],
  ])('rejects state %j, naming the code form', (value) => {
    const issues = states.safeParse(value).error?.issues ?? [];
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.message).toContain('2-letter USPS code');
  });

  it('takes 100 state codes and rejects a 101st, naming the bound', () => {
    expect(parsed(states, codes(100))).toHaveLength(100);
    expect(parsed(states, codes(100).join(','))).toHaveLength(100);
    const issues = states.safeParse(codes(101)).error?.issues ?? [];
    expect(issues.map((issue) => issue.message)).toEqual([
      'Pass at most 100 state codes; split a longer list across calls.',
    ]);
  });

  it.each([
    ['98108', ['98108']],
    ['98108-1234', ['98108-1234']],
    ['981081234', ['981081234']],
    [' 98108 ', [' 98108 ']],
    ['98108,98109', ['98108', '98109']],
    [
      ['98108-1234', '98109'],
      ['98108-1234', '98109'],
    ],
    ['["98108","98109"]', ['98108', '98109']],
  ])('reads zip_code %j as the list %j', (value, list) => {
    expect(parsed(zips, value)).toEqual(list);
  });

  it.each(['9810', '98108 98109', '98108-12', '98108;98109', ['98108,98109'], ['98108', 'abcde']])(
    'rejects zip_code %j, naming the ZIP form',
    (value) => {
      const issues = zips.safeParse(value).error?.issues ?? [];
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0]?.message).toContain('5-digit ZIP code');
    },
  );

  it('takes 200 ZIP codes and rejects a 201st, naming the bound', () => {
    expect(parsed(zips, zipCodes(200))).toHaveLength(200);
    const issues = zips.safeParse(zipCodes(201).join(',')).error?.issues ?? [];
    expect(issues.map((issue) => issue.message)).toEqual([
      'Pass at most 200 ZIP codes; split a longer list across calls.',
    ]);
  });

  it('rejects an over-long list of bad codes by its length and the first 101, not every element', () => {
    const issues = states.safeParse(Array(50_000).fill('Washington')).error?.issues ?? [];
    expect(issues.length).toBeLessThanOrEqual(102);
    expect(issues.map((issue) => issue.message)).toContain(
      'Pass at most 100 state codes; split a longer list across calls.',
    );
  });

  it('advertises an array of the single-value element patterns, bounded by maxItems', () => {
    const stateJson = z.toJSONSchema(states, { io: 'input' }) as {
      type?: string;
      maxItems?: number;
      items?: { pattern?: string };
    };
    const zipJson = z.toJSONSchema(zips, { io: 'input' }) as typeof stateJson;
    expect(stateJson).toMatchObject({ type: 'array', maxItems: 100 });
    expect(zipJson).toMatchObject({ type: 'array', maxItems: 200 });
    const statePattern = new RegExp(stateJson.items!.pattern!, 'u');
    const zipPattern = new RegExp(zipJson.items!.pattern!, 'u');
    for (const code of ['WA', ' wa ', 'DM', '09']) expect(statePattern.test(code)).toBe(true);
    for (const code of ['', 'WA OR', 'Washington', 'WA,OR'])
      expect(statePattern.test(code)).toBe(false);
    for (const zip of ['98108', '98108-1234', '981081234', ' 98108 ']) {
      expect(zipPattern.test(zip)).toBe(true);
    }
    for (const zip of ['', '9810', '98108,98109']) expect(zipPattern.test(zip)).toBe(false);
  });

  it('normalizes each state to its trimmed uppercase code, once, in first-seen order', () => {
    expect(normalizeStateList(['wa', ' OR ', 'WA'])).toEqual(['WA', 'OR']);
    expect(normalizeStateList(parsed(states, 'or, wa, OR') as string[])).toEqual(['OR', 'WA']);
  });

  it('normalizes each ZIP to its first five digits, once, in first-seen order', () => {
    expect(normalizeZipList(['98108-1234', '98109'])).toEqual(['98108', '98109']);
    expect(normalizeZipList(['98109', '981081234', ' 98108 ', '98109-0001'])).toEqual([
      '98109',
      '98108',
    ]);
    expect(normalizeZipList([])).toBeUndefined();
    expect(normalizeZipList(undefined)).toBeUndefined();
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

describe('TRI facility_id', () => {
  // Every form 0.8.0 answers with Boeing Field's records, and the shapes it answered as empty.
  const accepted = [
    '98108THBNG7500E',
    '98108thbng7500e',
    '98108Thbng7500E',
    ' 98108THBNG7500E ',
    '98108THBNG7500E/',
    '/98108THBNG7500E',
    '\t//98108THBNG7500E//\n',
  ];
  const rejected = [
    '110017848105',
    '98108THBNG7500',
    '98108THBNG7500EX',
    '98108THBNG 7500E',
    '98108THBNG/7500E',
    '/ 98108THBNG7500E',
    '98108THBNG7500E,X',
    '98108THBNG7500É',
    '',
  ];

  it('accepts 15 letters or digits inside whitespace and end slashes, and rejects other forms', () => {
    for (const value of accepted) expect(accepts(triFacilityIdSchema('f'), value)).toBe(true);
    for (const value of rejected) expect(accepts(triFacilityIdSchema('f'), value)).toBe(false);
  });

  it('names the 15-character form and where a Registry ID holder finds it', () => {
    const issue = triFacilityIdSchema('f').safeParse('110017848105').error?.issues[0];
    expect(issue?.message).toContain('Expected a 15-character TRI facility ID such as');
    expect(issue?.message).toContain('triFacilityIds');
  });

  it('advertises a pattern that accepts every form the schema accepts', () => {
    const pattern = advertisedPattern(triFacilityIdSchema('f'));
    for (const value of accepted) expect(pattern.test(value)).toBe(true);
    for (const value of rejected) expect(pattern.test(value)).toBe(false);
  });

  it('normalizes every accepted form to the uppercase 15 characters', () => {
    for (const value of accepted) expect(normalizeTriFacilityId(value)).toBe('98108THBNG7500E');
  });
});

describe('optional chemical_id', () => {
  const accepted = [
    '71-43-2',
    '71432',
    '0000071432',
    '0000071-43-2',
    ' 71-43-2 ',
    '100-41-4',
    '7440-47-3',
    '1336-36-3',
    'N420',
    'n420',
    'MIXTURE',
    'TRD SECRT',
    'NA',
    'INVALID',
    '',
    '  ',
  ];
  const wrongForm = [
    'benzene',
    'N42',
    'n4200',
    '71-432',
    '7-43-2',
    '1234',
    '00000071-43-2',
    'mixture',
  ];
  const badCheckDigit = ['71-43-1', '71431', '0000071431', '100-41-5', '7440-47-0'];

  it('accepts CAS numbers with a valid check digit, category codes, placeholders, and a blank', () => {
    for (const value of accepted) expect(accepts(optionalChemicalIdSchema('c'), value)).toBe(true);
    for (const value of [...wrongForm, ...badCheckDigit]) {
      expect(accepts(optionalChemicalIdSchema('c'), value)).toBe(false);
    }
  });

  it('reports one message per rejection: the form, or the check digit', () => {
    for (const value of wrongForm) {
      const issues = optionalChemicalIdSchema('c').safeParse(value).error?.issues ?? [];
      expect(issues).toHaveLength(1);
      expect(issues[0]?.message).toMatch(/^Expected a CAS Registry Number such as "71-43-2"/);
    }
    for (const value of badCheckDigit) {
      const issues = optionalChemicalIdSchema('c').safeParse(value).error?.issues ?? [];
      expect(issues).toHaveLength(1);
      expect(issues[0]?.message).toMatch(
        /^The CAS Registry Number fails its check digit\. Expected a CAS Registry Number/,
      );
    }
  });

  it('advertises a pattern that accepts every form the schema accepts', () => {
    const pattern = advertisedPattern(optionalChemicalIdSchema('c'));
    for (const value of accepted) expect(pattern.test(value)).toBe(true);
    for (const value of wrongForm) expect(pattern.test(value)).toBe(false);
  });

  it('normalizes a CAS number to 10 padded digits and a category code to uppercase', () => {
    expect(normalizeChemicalId('71-43-2')).toBe('0000071432');
    expect(normalizeChemicalId(' 71432 ')).toBe('0000071432');
    expect(normalizeChemicalId('0000071-43-2')).toBe('0000071432');
    expect(normalizeChemicalId('1336-36-3')).toBe('0001336363');
    expect(normalizeChemicalId('n420')).toBe('N420');
    expect(normalizeChemicalId('TRD SECRT')).toBe('TRD SECRT');
    expect(normalizeChemicalId('  ')).toBeUndefined();
    expect(normalizeChemicalId(undefined)).toBeUndefined();
  });
});

describe('pattern cost', () => {
  it.each([
    ['state', stateSchema('s')],
    ['optional state', optionalStateSchema('s')],
    ['zip_code', optionalZipSchema('z')],
    ['date', optionalDateSchema('d')],
    ['facility_id', triFacilityIdSchema('f')],
    ['chemical_id', optionalChemicalIdSchema('c')],
  ] as const)(
    'checks a long %s value in time linear in its length',
    (_, schema) => {
      expectLinearCpu((value) => schema.safeParse(value));
    },
    0,
  );

  // Slash runs are the facility_id pattern's other unbounded part: the same shapes, slashed.
  it('checks a long facility_id of slash runs in time linear in its length', () => {
    const schema = triFacilityIdSchema('f');
    expectLinearCpu((value) => schema.safeParse(value.replace(/\s/g, '/')));
  }, 0);

  it('normalizes a long facility_id in time linear in its length', () => {
    expectLinearCpu((value) => normalizeTriFacilityId(value));
  }, 0);

  /*
   * The list splitter runs on caller text before the list bound does: as sent, as comma runs
   * (one blank element per comma), and as a run of `[` openers with no closer (JSON.parse reads
   * to the end, then the comma split runs).
   */
  it.each([
    ['state list', stateListSchema('s')],
    ['zip_code list', zipListSchema('z')],
  ] as const)(
    'splits and checks a long %s in time linear in its length',
    (_, schema) => {
      expectLinearCpu((value) => schema.safeParse(value));
      expectLinearCpu((value) => schema.safeParse(value.replace(/\s/g, ',')));
      expectLinearCpu((value) => schema.safeParse(`[${value.replace(/\s/g, '[')}`));
    },
    0,
  );

  it('normalizes a long list element in time linear in its length', () => {
    expectLinearCpu((value) => normalizeStateList([value, value]));
    expectLinearCpu((value) => normalizeZipList([value, value]));
  }, 0);
});
