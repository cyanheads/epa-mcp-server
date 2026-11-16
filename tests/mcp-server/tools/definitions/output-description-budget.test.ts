/**
 * @fileoverview Ceiling on the description bytes inside every tool's advertised `outputSchema`, read
 * from the real server's `tools/list` so the framework's own JSON Schema conversion is what counts.
 * @module tests/mcp-server/tools/definitions/output-description-budget.test
 */

import { describe, expect, it } from 'vitest';
import { triGetFacilityReleasesTool } from '@/mcp-server/tools/definitions/tri-get-facility-releases.tool.js';
import { triSearchReleasesTool } from '@/mcp-server/tools/definitions/tri-search-releases.tool.js';
import { triReleaseSchema } from '@/mcp-server/tri-release-schema.js';
import { rpcResponse, startHttpServer } from '../../../helpers.js';

/** The trimmed total (25,455 B) plus about 5%. Raise it only alongside a deliberate addition. */
const OUTPUT_DESCRIPTION_CEILING_BYTES = 26_700;

/** UTF-8 bytes of every `description` string in a JSON Schema. */
function descriptionBytes(node: unknown): number {
  if (Array.isArray(node))
    return node.reduce((sum: number, item) => sum + descriptionBytes(item), 0);
  if (node === null || typeof node !== 'object') return 0;
  let sum = 0;
  for (const [key, value] of Object.entries(node)) {
    sum +=
      key === 'description' && typeof value === 'string'
        ? Buffer.byteLength(value)
        : descriptionBytes(value);
  }
  return sum;
}

async function post(origin: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-11-25',
    },
    body: JSON.stringify(body),
  });
  const { result } = rpcResponse(await response.text());
  if (!result) throw new Error('Expected a JSON-RPC result');
  return result;
}

describe('output-schema description budget', () => {
  it('keeps every advertised output description within the ceiling', async () => {
    const { origin, stop } = await startHttpServer({ AIRNOW_API_KEY: 'test-key' });
    try {
      await post(origin, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'epa-description-budget', version: '1' },
        },
      });
      const { tools } = (await post(origin, { jsonrpc: '2.0', id: 2, method: 'tools/list' })) as {
        tools: Array<{ name: string; outputSchema?: unknown }>;
      };
      expect(tools).toHaveLength(11);
      const perTool = Object.fromEntries(
        tools.map((tool) => [tool.name, descriptionBytes(tool.outputSchema)]),
      );
      const total = Object.values(perTool).reduce((sum, bytes) => sum + bytes, 0);
      expect(total, JSON.stringify(perTool, null, 2)).toBeLessThanOrEqual(
        OUTPUT_DESCRIPTION_CEILING_BYTES,
      );
    } finally {
      await stop();
    }
  }, 20_000);

  it('declares the TRI release field set once, for both TRI tools', () => {
    const records = [triSearchReleasesTool, triGetFacilityReleasesTool].map(
      (tool) => tool.output.shape.releases.element.shape,
    );
    for (const [field, schema] of Object.entries(triReleaseSchema.shape)) {
      for (const record of records) expect(record[field as keyof typeof record]).toBe(schema);
    }
  });
});
