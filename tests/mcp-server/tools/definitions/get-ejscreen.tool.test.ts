/**
 * @fileoverview Tests for getEjscreenTool — happy path, km→miles conversion, the
 * buffer-too-large error contract, out-of-coverage handling, and format() rendering.
 * The service is mocked so the handler is exercised in isolation.
 * @module tests/mcp-server/tools/definitions/get-ejscreen.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getEjscreenTool } from '@/mcp-server/tools/definitions/get-ejscreen.tool.js';
import type { EjscreenResult } from '@/services/ejscreen/types.js';

const mockGetIndicators = vi.fn();

vi.mock('@/services/ejscreen/ejscreen-service.js', () => ({
  getEjscreenService: () => ({ getIndicators: mockGetIndicators }),
}));

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
  demographicIndex: { value: 1.949, usPercentile: 76, statePercentile: 78 },
  supplementalDemographicIndex: { value: 1.9334, usPercentile: 71, statePercentile: 81 },
  reportUrl: 'https://api.ejanalysis.com/report?lat=39.2904&lon=-76.6122&buffer=1',
  coverage: { valid: true },
  dataSource: 'EJScreen v2.2 (2022 data) via the community-maintained EJAM API.',
};

const oceanResult: EjscreenResult = {
  location: { latitude: 0, longitude: 0, bufferMiles: 1 },
  environmental: [],
  demographic: [],
  coverage: { valid: false, note: 'The site is not located within the United States.' },
  dataSource: 'EJScreen v2.2 (2022 data) via the community-maintained EJAM API.',
};

describe('getEjscreenTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns indicators for a valid point and passes miles through unchanged', async () => {
    mockGetIndicators.mockResolvedValue(validResult);
    const ctx = createMockContext({ errors: getEjscreenTool.errors });
    const input = getEjscreenTool.input.parse({ latitude: 39.2904, longitude: -76.6122 });
    const result = await getEjscreenTool.handler(input, ctx);

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
    const ctx = createMockContext({ errors: getEjscreenTool.errors });
    // 20 km is over 15 as a raw number but ≈ 12.43 miles, inside the cap once converted.
    const input = getEjscreenTool.input.parse({
      latitude: 39.2904,
      longitude: -76.6122,
      distance: 20,
      unit: 'kilometers',
    });
    await getEjscreenTool.handler(input, ctx);

    expect(mockGetIndicators).toHaveBeenCalledWith(
      { latitude: 39.2904, longitude: -76.6122, bufferMiles: expect.closeTo(12.42742, 5) },
      ctx,
    );
  });

  it('throws buffer_too_large before calling the service when miles exceed 15', async () => {
    const ctx = createMockContext({ errors: getEjscreenTool.errors });
    const input = getEjscreenTool.input.parse({
      latitude: 39.2904,
      longitude: -76.6122,
      distance: 15.01,
    });

    await expect(getEjscreenTool.handler(input, ctx)).rejects.toMatchObject({
      message: 'Buffer of 15.01 miles exceeds the EJAM API limit of 15 miles.',
      data: { reason: 'buffer_too_large' },
    });
    expect(mockGetIndicators).not.toHaveBeenCalled();

    // Exactly 15 miles is the cap itself, not over it.
    mockGetIndicators.mockResolvedValue(validResult);
    const atCap = getEjscreenTool.input.parse({
      latitude: 39.2904,
      longitude: -76.6122,
      distance: 15,
    });
    await getEjscreenTool.handler(atCap, ctx);
    expect(mockGetIndicators).toHaveBeenCalledWith(
      expect.objectContaining({ bufferMiles: 15 }),
      ctx,
    );
  });

  it('throws buffer_too_large when a kilometers distance converts above 15 miles', async () => {
    const ctx = createMockContext({ errors: getEjscreenTool.errors });
    // 30 km ≈ 18.64 miles.
    const input = getEjscreenTool.input.parse({
      latitude: 39.2904,
      longitude: -76.6122,
      distance: 30,
      unit: 'kilometers',
    });

    await expect(getEjscreenTool.handler(input, ctx)).rejects.toMatchObject({
      message: 'Buffer of 18.64 miles exceeds the EJAM API limit of 15 miles.',
      data: { reason: 'buffer_too_large' },
    });
    expect(mockGetIndicators).not.toHaveBeenCalled();
  });

  it('surfaces a coverage notice when the point is out of coverage', async () => {
    mockGetIndicators.mockResolvedValue(oceanResult);
    const ctx = createMockContext({ errors: getEjscreenTool.errors });
    const input = getEjscreenTool.input.parse({ latitude: 0, longitude: 0 });
    const result = await getEjscreenTool.handler(input, ctx);

    expect(result.coverage.valid).toBe(false);
    expect(result.environmental).toEqual([]);
    expect(getEnrichment(ctx).notice).toBe(
      'EJScreen has no coverage for this point: The site is not located within the United States.',
    );
  });

  it('formats a valid result with location, indicators, indices, and source', () => {
    const blocks = getEjscreenTool.format!(validResult);
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
      '**Demographic Index:** 1.949 · US pctile 76 · state pctile 78',
      '**Supplemental Demographic Index:** 1.9334 · US pctile 71 · state pctile 81',
      '**EJScreen report:** https://api.ejanalysis.com/report?lat=39.2904&lon=-76.6122&buffer=1',
      '_Source: EJScreen v2.2 (2022 data) via the community-maintained EJAM API._',
    ]) {
      expect(lines).toContain(line);
    }
  });

  it('formats an out-of-coverage result with the coverage note and no fabricated indicators', () => {
    const blocks = getEjscreenTool.format!(oceanResult);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('Coverage valid:** no');
    expect(text).toContain('not located within the United States');
    expect(text).not.toContain('### Environmental indicators');
  });
});
