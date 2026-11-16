/**
 * @fileoverview The shared `distanceMiles` field: rounding and rendering.
 * @module tests/mcp-server/tools/distance-field.test
 */

import { describe, expect, it } from 'vitest';
import {
  distanceMilesField,
  formatDistanceLine,
  roundMiles,
} from '@/mcp-server/tools/distance-field.js';

describe('distanceMiles field', () => {
  it('rounds to two decimals', () => {
    expect(roundMiles(0.8685)).toBe(0.87);
    expect(roundMiles(4.9998)).toBe(5);
    expect(roundMiles(0)).toBe(0);
    expect(roundMiles(12.344)).toBe(12.34);
  });

  it('renders the content[] line in miles', () => {
    expect(formatDistanceLine(0.87)).toBe('**Distance:** 0.87 mi');
    expect(formatDistanceLine(5)).toBe('**Distance:** 5 mi');
  });

  it('is optional, so administrative rows and rows without coordinates omit it', () => {
    expect(distanceMilesField.safeParse(undefined).success).toBe(true);
    expect(distanceMilesField.description).toContain(
      'absent without a search point or row coordinates',
    );
  });
});
