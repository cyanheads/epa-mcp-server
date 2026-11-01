/**
 * @fileoverview HTTP session posture on the 2025-11-25 protocol revision.
 * @module tests/http-session.test
 */
import { describe, expect, it } from 'vitest';
import { rpcResponse, startHttpServer } from './helpers.js';

async function readReply(response: Response): Promise<string> {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) return response.text();
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
      const events = text.split('\n\n');
      if (
        events.slice(0, -1).some((event) =>
          event.split('\n').some((line) => {
            if (!line.startsWith('data:')) return false;
            const data = line.slice(5).trim();
            return data !== '' && 'id' in JSON.parse(data);
          }),
        )
      )
        break;
    }
    return text;
  } finally {
    await reader.cancel();
  }
}

/** The `result` of the JSON-RPC response in a reply body. */
function rpcResult(reply: string): Record<string, unknown> {
  const { result } = rpcResponse(reply);
  if (!result) throw new Error(`Expected a JSON-RPC result, got: ${reply}`);
  return result;
}

/** Tools served without AIRNOW_API_KEY: every keyless tool, never epa_airnow_get_conditions. */
const KEYLESS_TOOL_NAMES = [
  'epa_echo_get_case',
  'epa_echo_get_facility',
  'epa_echo_search_facilities',
  'epa_echo_search_violations',
  'epa_ejscreen_get_scores',
  'epa_superfund_get_site',
  'epa_superfund_search_sites',
  'epa_tri_get_facility_releases',
  'epa_tri_search_releases',
  'epa_water_search_systems',
];

async function inspectSession(mode: string | undefined, expected: 'stateful' | 'stateless') {
  const { origin, stop } = await startHttpServer({
    LOGS_DIR: '/tmp/epa-maintenance-http-logs',
    MCP_SESSION_MODE: mode,
  });
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    const initialized = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'epa-session-test', version: '1' },
        },
      }),
    });
    expect(initialized.ok).toBe(true);
    expect(rpcResult(await readReply(initialized)).protocolVersion).toBe('2025-11-25');
    const sid = initialized.headers.get('mcp-session-id');
    if (expected === 'stateful') expect(sid).toBeTruthy();
    else expect(sid).toBeNull();
    headers['MCP-Protocol-Version'] = '2025-11-25';
    if (sid) headers['Mcp-Session-Id'] = sid;
    const notification = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    await notification.text();
    const listed = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(listed.ok).toBe(true);
    const tools = rpcResult(await readReply(listed)).tools as { name: string }[];
    expect(tools.map((t) => t.name).sort()).toEqual(KEYLESS_TOOL_NAMES);
    const card = await fetch(`${origin}/.well-known/mcp.json`).then((response) => response.json());
    expect(card).toMatchObject({
      _meta: { 'io.github.cyanheads.mcp-ts-core/sessionMode': expected },
    });
  } finally {
    await stop();
  }
}

describe('explicit HTTP session overrides', () => {
  it.each(['stateful', 'auto'])(
    '%s allocates a 2025-era session',
    async (mode) => {
      await inspectSession(mode, 'stateful');
    },
    15_000,
  );
  it('stateless serves requests without a session id', async () => {
    await inspectSession('stateless', 'stateless');
  }, 15_000);
});

describe('server HTTP session default', () => {
  it.each([undefined, '', `\${MCP_SESSION_MODE}`])(
    'falls through %j to stateless',
    async (mode) => {
      await inspectSession(mode, 'stateless');
    },
    15_000,
  );
});
