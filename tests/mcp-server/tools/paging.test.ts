/**
 * @fileoverview Tests for the shared paging contract.
 * @module tests/mcp-server/tools/paging.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clampLimit,
  continueGuidance,
  limitSchema,
  offsetSchema,
  pageLabel,
  pagingTrailer,
  wholeListLimitSchema,
} from '@/mcp-server/tools/paging.js';

/**
 * Every value recorded on a counter from the framework's `createCounter`, with the counter's name.
 * The seam is the factory rather than a global MeterProvider: `@opentelemetry/api` is not one of
 * this package's dependencies.
 */
const counted = vi.hoisted(() => [] as Array<{ name: string; value: number; attributes: unknown }>);

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createCounter: (name: string) => ({
    add: (value: number, attributes?: unknown) => {
      counted.push({ name, value, attributes });
    },
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('limitSchema', () => {
  const schema = limitSchema({ cap: 200, defaultLimit: 25, noun: 'sites' });

  it('defaults, and accepts any positive integer: no maximum above the cap', () => {
    expect(schema.parse(undefined)).toBe(25);
    expect(schema.parse(1)).toBe(1);
    expect(schema.parse(201)).toBe(201);
    expect(schema.parse(5001)).toBe(5001);
    expect(schema.parse(1_000_000)).toBe(1_000_000);
  });

  it('rejects values below 1 and non-integers', () => {
    for (const value of [0, -1, 1.5]) expect(schema.safeParse(value).success).toBe(false);
  });

  it('advertises no maximum in its JSON Schema beyond the integer bound', () => {
    const json = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
    expect(json.maximum ?? Number.MAX_SAFE_INTEGER).toBe(Number.MAX_SAFE_INTEGER);
    expect(json.minimum).toBe(1);
  });

  it('describes the default, the clamp, and how to continue', () => {
    expect(schema.description).toContain('Default 25');
    expect(schema.description).toContain('at most 200 and says so');
    expect(schema.description).not.toContain('5,000');
    expect(schema.description).toContain('offset and nextOffset');
    const inspections = limitSchema({
      cap: 5000,
      defaultLimit: 25,
      noun: 'inspections',
      offsetParam: 'inspections_offset',
      nextOffsetField: 'inspectionsNextOffset',
    });
    expect(inspections.description).toContain('at most 5,000');
    expect(inspections.description).toContain('inspections_offset and inspectionsNextOffset');
  });

  it.each(['false', 'no', '0'])(
    'with EPA_CLAMP_LIMITS=%s, makes the cap a strict maximum',
    async (value) => {
      vi.resetModules();
      vi.stubEnv('EPA_CLAMP_LIMITS', value);
      const paging = await import('@/mcp-server/tools/paging.js');
      const strict = paging.limitSchema({ cap: 200, defaultLimit: 25, noun: 'sites' });
      expect(strict.parse(200)).toBe(200);
      expect(strict.safeParse(201).success).toBe(false);
      const json = z.toJSONSchema(strict, { io: 'input' }) as Record<string, unknown>;
      expect(json.maximum).toBe(200);
      expect(strict.description).toContain('1–200');
      expect(strict.description).not.toContain('says so');
    },
  );

  it.each(['true', '', `\${EPA_CLAMP_LIMITS}`])(
    'with EPA_CLAMP_LIMITS=%j, keeps clamping',
    async (value) => {
      vi.resetModules();
      vi.stubEnv('EPA_CLAMP_LIMITS', value);
      const paging = await import('@/mcp-server/tools/paging.js');
      const lenient = paging.limitSchema({ cap: 200, defaultLimit: 25, noun: 'sites' });
      expect(lenient.parse(201)).toBe(201);
    },
  );
});

describe('wholeListLimitSchema', () => {
  const options = {
    defaultLimit: 10,
    noun: 'effluent exceedances',
    offsetParam: 'effluent_exceedances_offset',
    nextOffsetField: 'effluentExceedancesNextOffset',
  };

  it.each(['true', 'false'])(
    'with EPA_CLAMP_LIMITS=%s, defaults and accepts any positive integer with no maximum',
    async (value) => {
      vi.resetModules();
      vi.stubEnv('EPA_CLAMP_LIMITS', value);
      const paging = await import('@/mcp-server/tools/paging.js');
      const schema = paging.wholeListLimitSchema(options);
      expect(schema.parse(undefined)).toBe(10);
      expect(schema.parse(1_000_000)).toBe(1_000_000);
      for (const bad of [0, 1.5]) expect(schema.safeParse(bad).success).toBe(false);
      const json = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
      expect(json.maximum ?? Number.MAX_SAFE_INTEGER).toBe(Number.MAX_SAFE_INTEGER);
    },
  );

  it('describes the default, the rest of the list, and how to continue', () => {
    const { description } = wholeListLimitSchema(options);
    expect(description).toContain('Default 10');
    expect(description).toContain('returns the rest of the list');
    expect(description).toContain('effluent_exceedances_offset and effluentExceedancesNextOffset');
    expect(description).not.toContain('at most');
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
    expect(clampLimit(200, 200, { tool: 'test_tool' })).toEqual({ limit: 200 });
    expect(clampLimit(5, 200, { tool: 'test_tool' })).toEqual({ limit: 5 });
  });

  it('clamps a limit above the cap and names the parameter, the request, and the cap', () => {
    const result = clampLimit(5000, 200, { tool: 'test_tool' });
    expect(result.limit).toBe(200);
    expect(result.notice).toContain('limit 5000');
    expect(result.notice).toContain('200');
    expect(
      clampLimit(150, 100, { tool: 'test_tool', param: 'inspections_limit' }).notice,
    ).toContain('inspections_limit 150');
  });

  it('logs the first clamp of each tool input once per process, never a call under the cap', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    clampLimit(10, 200, { tool: 'log_once_tool' });
    expect(info).not.toHaveBeenCalled();
    clampLimit(300, 200, { tool: 'log_once_tool' });
    clampLimit(400, 200, { tool: 'log_once_tool' });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toContain('log_once_tool limit 300');
    expect(info.mock.calls[0]?.[0]).toContain('EPA_CLAMP_LIMITS=false');
    clampLimit(300, 200, { tool: 'log_once_tool', param: 'inspections_limit' });
    clampLimit(300, 200, { tool: 'other_tool' });
    expect(info).toHaveBeenCalledTimes(3);
  });

  it('counts every clamp in epa.input.count_clamped by tool and field, never a call at or under the cap', () => {
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    counted.length = 0;
    clampLimit(200, 200, { tool: 'count_tool' });
    clampLimit(5, 200, { tool: 'count_tool' });
    expect(counted).toEqual([]);

    // A repeat clamp of one input is logged once but counted each time.
    clampLimit(300, 200, { tool: 'count_tool' });
    clampLimit(400, 200, { tool: 'count_tool' });
    clampLimit(150, 100, { tool: 'count_tool', param: 'inspections_limit' });

    const clamp = (field: string) => ({
      name: 'epa.input.count_clamped',
      value: 1,
      attributes: { tool: 'count_tool', field },
    });
    expect(counted).toEqual([clamp('limit'), clamp('limit'), clamp('inspections_limit')]);
  });
});

describe('pageLabel', () => {
  it('shows the total for a whole list, the range for a page, and an empty page past the end', () => {
    expect(pageLabel(115, 115, undefined)).toBe('115');
    expect(pageLabel(25, 115, 25)).toBe('1–25 of 115');
    expect(pageLabel(25, 115, 50)).toBe('26–50 of 115');
    expect(pageLabel(15, 115, undefined)).toBe('101–115 of 115');
    expect(pageLabel(0, 115, undefined)).toBe('none on this page of 115');
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
