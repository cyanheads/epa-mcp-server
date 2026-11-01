/**
 * @fileoverview Tests for the shared paging contract.
 * @module tests/mcp-server/tools/paging.test
 */

import { describe, expect, it } from 'vitest';
import {
  clampLimit,
  continueGuidance,
  LIMIT_CEILING,
  limitSchema,
  offsetSchema,
  pagingTrailer,
} from '@/mcp-server/tools/paging.js';

describe('limitSchema', () => {
  const schema = limitSchema({ cap: 200, defaultLimit: 50, noun: 'sites' });

  it('defaults, and accepts values up to the 5,000 ceiling', () => {
    expect(schema.parse(undefined)).toBe(50);
    expect(schema.parse(1)).toBe(1);
    expect(schema.parse(201)).toBe(201);
    expect(schema.parse(LIMIT_CEILING)).toBe(5000);
  });

  it('rejects values outside 1–5,000 and non-integers', () => {
    for (const value of [0, -1, 5001, 1.5]) expect(schema.safeParse(value).success).toBe(false);
  });

  it('describes the cap, the clamp, and how to continue', () => {
    expect(schema.description).toContain('1–200');
    expect(schema.description).toContain('5,000');
    expect(schema.description).toContain('offset and nextOffset');
    const inspections = limitSchema({
      cap: 100,
      defaultLimit: 100,
      noun: 'inspections',
      offsetParam: 'inspections_offset',
      nextOffsetField: 'inspectionsNextOffset',
    });
    expect(inspections.description).toContain('inspections_offset and inspectionsNextOffset');
  });
});

describe('offsetSchema', () => {
  it('defaults to 0 and rejects negative or fractional offsets', () => {
    const schema = offsetSchema('sites');
    expect(schema.parse(undefined)).toBe(0);
    expect(schema.parse(4800)).toBe(4800);
    for (const value of [-1, 0.5]) expect(schema.safeParse(value).success).toBe(false);
  });
});

describe('clampLimit', () => {
  it('passes a limit at or under the cap through without a notice', () => {
    expect(clampLimit(200, 200)).toEqual({ limit: 200 });
    expect(clampLimit(5, 200)).toEqual({ limit: 5 });
  });

  it('clamps a limit above the cap and names the parameter, the request, and the cap', () => {
    const result = clampLimit(5000, 200);
    expect(result.limit).toBe(200);
    expect(result.notice).toContain('limit 5000');
    expect(result.notice).toContain('200');
    expect(clampLimit(150, 100, 'inspections_limit').notice).toContain('inspections_limit 150');
  });
});

describe('continueGuidance', () => {
  it('names the next offset and never suggests raising the cap', () => {
    const guidance = continueGuidance(200);
    expect(guidance).toContain('offset 200');
    expect(guidance.toLowerCase()).not.toContain('raise');
    expect(continueGuidance(100, 'inspections_offset')).toContain('inspections_offset 100');
  });
});

describe('pagingTrailer', () => {
  it('renders the clamp notice as a blockquote', () => {
    expect(pagingTrailer.limitNotice.render('limit 300 is above')).toBe('> limit 300 is above');
  });
});
