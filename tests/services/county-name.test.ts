/**
 * @fileoverview Tests for the bare county name every county filter matches on.
 * @module tests/services/county-name.test
 */

import { describe, expect, it } from 'vitest';
import { bareCountyName } from '@/services/county-name.js';
import { expectLinearCpu } from '../helpers.js';

describe('bareCountyName', () => {
  it('drops a trailing County, Parish, or Borough and uppercases', () => {
    expect(bareCountyName('King County')).toBe('KING');
    expect(bareCountyName('  King \t County ')).toBe('KING');
    expect(bareCountyName('Calcasieu Parish')).toBe('CALCASIEU');
    expect(bareCountyName('North Slope Borough')).toBe('NORTH SLOPE');
    expect(bareCountyName('St. Tammany')).toBe('ST. TAMMANY');
    expect(bareCountyName('Countyline')).toBe('COUNTYLINE');
  });

  it('drops the Alaska county-equivalent suffixes', () => {
    expect(bareCountyName('Anchorage Municipality')).toBe('ANCHORAGE');
    expect(bareCountyName('Bethel Census Area')).toBe('BETHEL');
    expect(bareCountyName('Juneau City and Borough')).toBe('JUNEAU');
    expect(bareCountyName('JUNEAU CITY AND BOROUGH')).toBe('JUNEAU');
    expect(bareCountyName('Anchorage')).toBe('ANCHORAGE');
  });

  it('strips a suffix in time linear in the name length', () => {
    // A `\s+` suffix pattern backtracks over each run of inner whitespace: quadratic.
    expectLinearCpu(bareCountyName);
  });
});
