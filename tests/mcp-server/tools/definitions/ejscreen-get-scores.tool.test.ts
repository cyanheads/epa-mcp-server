/**
 * @fileoverview Tests for ejscreenGetScoresTool — happy path, km→miles conversion, the
 * buffer-too-large error contract, no-data handling, and format() rendering. The service
 * accessor is mocked so the handler is exercised in isolation; the no-data notes themselves
 * are tested against recorded EJAM shapes in tests/services/ejscreen/ejscreen-service.test.ts.
 * @module tests/mcp-server/tools/definitions/ejscreen-get-scores.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ejscreenGetScoresTool } from '@/mcp-server/tools/definitions/ejscreen-get-scores.tool.js';
import type { EjscreenResult } from '@/services/ejscreen/types.js';

const mockGetIndicators = vi.fn();

vi.mock('@/services/ejscreen/ejscreen-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/ejscreen/ejscreen-service.js')>()),
  getEjscreenService: () => ({ getIndicators: mockGetIndicators }),
}));

const DATA_SOURCE = "EJScreen indicators from EJAM's ACS 2018–2022 release (EJScreen 2.3 method).";

const validResult: EjscreenResult = {
  location: {
    latitude: 39.2904,
    longitude: -76.6122,
    bufferMiles: 1,
    state: 'MD',
    stateName: 'Maryland',
    population: 38776.2,
    blockGroupCount: 51,
  },
  environmental: [
    {
      code: 'pm',
      label: 'PM2.5',
      value: 6.925,
      unit: 'µg/m³',
      usPercentile: 17,
      statePercentile: 51,
      ejIndex: 32.9204,
      ejIndexUsPercentile: 39,
      ejIndexStatePercentile: 76,
    },
  ],
  demographic: [
    {
      code: 'pctmin',
      label: 'People of color',
      percent: 63.07,
      usPercentile: 74,
      statePercentile: 62,
    },
  ],
  demographicIndex: { value: 1.949, usAverage: 1.3407, usPercentile: 76, statePercentile: 78 },
  supplementalDemographicIndex: {
    value: 1.9334,
    usAverage: 1.6423,
    usPercentile: 71,
    statePercentile: 81,
  },
  reportUrl: 'https://api.ejanalysis.com/report?lat=39.2904&lon=-76.6122&buffer=1',
  coverage: { valid: true },
  dataSource: DATA_SOURCE,
};

/** Central Nevada at 15 miles: blocks found, no residents. */
const zeroResidentResult: EjscreenResult = {
  location: {
    latitude: 38,
    longitude: -116,
    bufferMiles: 15,
    state: 'NV',
    stateName: 'Nevada',
    population: 0,
    blockGroupCount: 3,
  },
  environmental: [],
  demographic: [],
  coverage: {
    valid: false,
    note: 'EJScreen found Census blocks within the buffer but no residents, so it has no population-weighted indicators to report.',
  },
  dataSource: DATA_SOURCE,
};

/** Yellowstone at 1 mile: EJAM answered `{}`. */
const noBlockResult: EjscreenResult = {
  location: { latitude: 44.5, longitude: -110.5, bufferMiles: 1 },
  environmental: [],
  demographic: [],
  coverage: {
    valid: false,
    note: 'EJScreen found no Census block within the buffer. Either none lies this close to the point, and a larger distance (up to 15 miles) may reach one, or the point is somewhere EJScreen does not cover, such as open water or a place outside the 50 states, DC, and Puerto Rico.',
  },
  dataSource: DATA_SOURCE,
};

describe('ejscreenGetScoresTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns indicators for a valid point and passes miles through unchanged', async () => {
    mockGetIndicators.mockResolvedValue(validResult);
    const ctx = createMockContext({ errors: ejscreenGetScoresTool.errors });
    const input = ejscreenGetScoresTool.input.parse({ latitude: 39.2904, longitude: -76.6122 });
    const result = await ejscreenGetScoresTool.handler(input, ctx);

    expect(mockGetIndicators).toHaveBeenCalledWith(
      { latitude: 39.2904, longitude: -76.6122, bufferMiles: 1 },
      ctx,
    );
    expect(result).toEqual(validResult);
    // A covered point carries no coverage notice.
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('converts kilometers to miles before calling the service', async () => {
    mockGetIndicators.mockResolvedValue(validResult);
    const ctx = createMockContext({ errors: ejscreenGetScoresTool.errors });
    // 20 km is over 15 as a raw number but ≈ 12.43 miles, inside the cap once converted.
    const input = ejscreenGetScoresTool.input.parse({
      latitude: 39.2904,
      longitude: -76.6122,
      distance: 20,
      unit: 'kilometers',
    });
    await ejscreenGetScoresTool.handler(input, ctx);

    expect(mockGetIndicators).toHaveBeenCalledWith(
      { latitude: 39.2904, longitude: -76.6122, bufferMiles: expect.closeTo(12.42742, 5) },
      ctx,
    );
  });

  it('throws buffer_too_large before calling the service when miles exceed 15', async () => {
    const ctx = createMockContext({ errors: ejscreenGetScoresTool.errors });
    const input = ejscreenGetScoresTool.input.parse({
      latitude: 39.2904,
      longitude: -76.6122,
      distance: 15.01,
    });

    await expect(ejscreenGetScoresTool.handler(input, ctx)).rejects.toMatchObject({
      message: 'Buffer of 15.01 miles exceeds the EJAM API limit of 15 miles.',
      data: { reason: 'buffer_too_large' },
    });
    expect(mockGetIndicators).not.toHaveBeenCalled();

    // Exactly 15 miles is the cap itself, not over it.
    mockGetIndicators.mockResolvedValue(validResult);
    const atCap = ejscreenGetScoresTool.input.parse({
      latitude: 39.2904,
      longitude: -76.6122,
      distance: 15,
    });
    await ejscreenGetScoresTool.handler(atCap, ctx);
    expect(mockGetIndicators).toHaveBeenCalledWith(
      expect.objectContaining({ bufferMiles: 15 }),
      ctx,
    );
  });

  it('throws buffer_too_large when a kilometers distance converts above 15 miles', async () => {
    const ctx = createMockContext({ errors: ejscreenGetScoresTool.errors });
    // 30 km ≈ 18.64 miles.
    const input = ejscreenGetScoresTool.input.parse({
      latitude: 39.2904,
      longitude: -76.6122,
      distance: 30,
      unit: 'kilometers',
    });

    await expect(ejscreenGetScoresTool.handler(input, ctx)).rejects.toMatchObject({
      message: 'Buffer of 18.64 miles exceeds the EJAM API limit of 15 miles.',
      data: { reason: 'buffer_too_large' },
    });
    expect(mockGetIndicators).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'no Census block', result: noBlockResult },
    { name: 'zero residents', result: zeroResidentResult },
  ])(
    'the notice for $name repeats the coverage note and claims nothing else',
    async ({ result: noData }) => {
      mockGetIndicators.mockResolvedValue(noData);
      const ctx = createMockContext({ errors: ejscreenGetScoresTool.errors });
      const input = ejscreenGetScoresTool.input.parse({
        latitude: noData.location.latitude,
        longitude: noData.location.longitude,
        distance: noData.location.bufferMiles,
      });
      const result = await ejscreenGetScoresTool.handler(input, ctx);

      expect(result.coverage.valid).toBe(false);
      expect(result.environmental).toEqual([]);
      expect(getEnrichment(ctx).notice).toBe(
        noData.coverage.valid ? undefined : noData.coverage.note,
      );
      expect(getEnrichment(ctx).notice).toBeTypeOf('string');
      expect(getEnrichment(ctx).notice).not.toContain('no coverage');
    },
  );

  it('formats a valid result with location, indicators, indices, and source', () => {
    const blocks = ejscreenGetScoresTool.format!(validResult);
    const lines = (blocks[0] as { type: string; text: string }).text.split('\n');
    for (const line of [
      '## EJScreen Environmental Justice — 39.2904, -76.6122 (Maryland)',
      '**Buffer:** 1 miles',
      '**State:** MD',
      '**Population in buffer:** 38776.2',
      '**Block groups intersected:** 51',
      '**Coverage valid:** yes',
      '- **PM2.5** (`pm`): 6.925 µg/m³ · US pctile 17 · state pctile 51 · EJ Index 32.9204 · EJ Index US pctile 39 · EJ Index state pctile 76',
      '- **People of color** (`pctmin`): 63.07% · US pctile 74 · state pctile 62',
      '**Demographic Index:** 1.949 · US avg 1.3407 · US pctile 76 · state pctile 78',
      '**Supplemental Demographic Index:** 1.9334 · US avg 1.6423 · US pctile 71 · state pctile 81',
      '**EJScreen report:** [https://api.ejanalysis.com/report?lat=39.2904&lon=-76.6122&buffer=1](<https://api.ejanalysis.com/report?lat=39.2904&lon=-76.6122&buffer=1>)',
      "_Source: EJScreen indicators from EJAM's ACS 2018–2022 release (EJScreen 2.3 method)._",
    ]) {
      expect(lines).toContain(line);
    }
  });

  it('formats an index without a US average as value and percentiles', () => {
    const { usAverage: _avg, ...index } = validResult.demographicIndex!;
    const blocks = ejscreenGetScoresTool.format!({ ...validResult, demographicIndex: index });
    const lines = (blocks[0] as { type: string; text: string }).text.split('\n');
    expect(lines).toContain('**Demographic Index:** 1.949 · US pctile 76 · state pctile 78');
  });

  it('formats a zero-resident result with its location context, note, and no fabricated indicators', () => {
    const blocks = ejscreenGetScoresTool.format!(zeroResidentResult);
    const lines = (blocks[0] as { type: string; text: string }).text.split('\n');
    for (const line of [
      '**State:** NV',
      '**Population in buffer:** 0',
      '**Block groups intersected:** 3',
      '**Coverage valid:** no',
      '> EJScreen found Census blocks within the buffer but no residents, so it has no population-weighted indicators to report.',
    ]) {
      expect(lines).toContain(line);
    }
    const text = lines.join('\n');
    expect(text).not.toContain('### Environmental indicators');
    expect(text).not.toContain('Demographic Index');
  });

  it('describes each index by its components and scale, and ejIndex as a product', () => {
    const shape = ejscreenGetScoresTool.output.shape;
    const indexDescriptions = [shape.demographicIndex, shape.supplementalDemographicIndex].map(
      (field) => {
        const inner = field.unwrap().shape;
        return {
          value: inner.value.description ?? '',
          statePercentile: inner.statePercentile.description ?? '',
          usAverage: inner.usAverage.description ?? '',
        };
      },
    );
    for (const index of indexDescriptions) {
      expect(index.value).not.toMatch(/share/i);
      expect(index.value).toContain('Unitless');
      expect(index.value).toContain('percent low income');
      expect(index.statePercentile).toContain('state-normalized');
      expect(index.usAverage).toContain('National average');
    }
    expect(indexDescriptions[0]?.value).toContain('percent people of color');
    expect(indexDescriptions[1]?.value).toContain('low life expectancy');
    const ejIndex = shape.environmental.element.shape.ejIndex.description ?? '';
    expect(ejIndex).toContain("Demographic Index × this indicator's US percentile");
  });
});
