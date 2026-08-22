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
      expect.anything(),
    );
    expect(result.coverage.valid).toBe(true);
    expect(result.environmental).toHaveLength(1);
    expect(result.demographic[0]?.percent).toBe(63.07);
  });

  it('converts kilometers to miles before calling the service', async () => {
    mockGetIndicators.mockResolvedValue(validResult);
    const ctx = createMockContext({ errors: getEjscreenTool.errors });
    const input = getEjscreenTool.input.parse({
      latitude: 39.2904,
      longitude: -76.6122,
      distance: 2,
      unit: 'kilometers',
    });
    await getEjscreenTool.handler(input, ctx);

    expect(mockGetIndicators).toHaveBeenCalledWith(
      expect.objectContaining({ bufferMiles: expect.closeTo(1.242742, 5) }),
      expect.anything(),
    );
  });

  it('throws buffer_too_large before calling the service when miles exceed 15', async () => {
    const ctx = createMockContext({ errors: getEjscreenTool.errors });
    const input = getEjscreenTool.input.parse({
      latitude: 39.2904,
      longitude: -76.6122,
      distance: 20,
    });

    await expect(getEjscreenTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'buffer_too_large' },
    });
    expect(mockGetIndicators).not.toHaveBeenCalled();
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
    const notice = getEnrichment(ctx).notice;
    expect(notice).toContain('not located within the United States');
  });

  it('formats a valid result with location, indicators, indices, and source', () => {
    const blocks = getEjscreenTool.format!(validResult);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('Maryland');
    expect(text).toContain('PM2.5');
    expect(text).toContain('6.925');
    expect(text).toContain('People of color');
    expect(text).toContain('63.07%');
    expect(text).toContain('Demographic Index');
    expect(text).toContain('1.949');
    expect(text).toContain('EJScreen v2.2');
    expect(text).toContain('https://api.ejanalysis.com/report');
  });

  it('formats an out-of-coverage result with the coverage note and no fabricated indicators', () => {
    const blocks = getEjscreenTool.format!(oceanResult);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('Coverage valid:** no');
    expect(text).toContain('not located within the United States');
    expect(text).not.toContain('### Environmental indicators');
  });
});
