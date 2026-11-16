/**
 * @fileoverview Great-circle distance on the 3958.8-mile sphere.
 * @module tests/services/great-circle.test
 */
import { describe, expect, it } from 'vitest';
import { greatCircleMiles } from '@/services/great-circle.js';

describe('greatCircleMiles', () => {
  it('is zero between a point and itself', () => {
    expect(greatCircleMiles(47.527, -122.318, 47.527, -122.318)).toBe(0);
  });

  it('measures one degree of a meridian as 2π·3958.8/360 miles', () => {
    expect(greatCircleMiles(0, 0, 1, 0)).toBeCloseTo(69.0941, 3);
  });

  it('measures a quarter meridian and a half circumference', () => {
    expect(greatCircleMiles(0, 0, 90, 0)).toBeCloseTo(6218.5, 0);
    expect(greatCircleMiles(0, 0, 0, 180)).toBeCloseTo(12437.0, 0);
  });

  it('takes the short way across the antimeridian', () => {
    expect(greatCircleMiles(0, 179.5, 0, -179.5)).toBeCloseTo(69.0941, 3);
  });

  it('is symmetric', () => {
    expect(greatCircleMiles(47.6, -122.3, 45.5, -122.7)).toBeCloseTo(
      greatCircleMiles(45.5, -122.7, 47.6, -122.3),
      9,
    );
  });
});
