/**
 * @fileoverview HTTP session posture on the 2025-11-25 protocol revision.
 * @module tests/http-session.test
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';

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

/** The `result` of the JSON-RPC response in a reply body (plain JSON or SSE `data:` frames). */
function rpcResult(reply: string): Record<string, unknown> {
  const payloads = reply.trimStart().startsWith('{')
    ? [reply]
    : reply
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter((data) => data !== '');
  const message = payloads
    .map((data) => JSON.parse(data) as { id?: unknown; result?: Record<string, unknown> })
    .find((parsed) => 'id' in parsed);
  if (!message?.result) throw new Error(`Expected a JSON-RPC result, got: ${reply}`);
  return message.result;
}

/** Tools served without AIRNOW_API_KEY: every keyless tool, never epa_get_air_quality. */
const KEYLESS_TOOL_NAMES = [
  'epa_get_ejscreen',
  'epa_get_facility',
  'epa_get_tri_releases',
  'epa_search_facilities',
  'epa_search_superfund',
  'epa_search_tri_releases',
  'epa_search_violations',
  'epa_search_water_systems',
];

async function inspectSession(mode: string | undefined, expected: 'stateful' | 'stateless') {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MCP_TRANSPORT_TYPE: 'http',
    MCP_HTTP_PORT: String(address.port),
    MCP_HTTP_HOST: '127.0.0.1',
    MCP_AUTH_MODE: 'none',
    AIRNOW_API_KEY: '',
    OTEL_ENABLED: 'false',
    MCP_LOG_LEVEL: 'error',
    LOGS_DIR: '/tmp/epa-maintenance-http-logs',
  };
  if (mode === undefined) delete env.MCP_SESSION_MODE;
  else env.MCP_SESSION_MODE = mode;
  const child = spawn('bun', ['--no-env-file', 'src/index.ts'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => {
    output += String(data);
  });
  child.stderr.on('data', (data) => {
    output += String(data);
  });
  const exited = once(child, 'exit');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(output);
      try {
        ready = (await fetch(`${origin}/healthz`)).ok;
      } catch {
        /* Still starting. */
      }
      if (ready) break;
      await setTimeout(50);
    }
    if (!ready) throw new Error(`Server did not start: ${output}`);
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
    child.kill('SIGTERM');
    await exited;
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
