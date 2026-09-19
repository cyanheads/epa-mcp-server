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
    expect(await readReply(initialized)).toContain('2025-11-25');
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
    const list = await readReply(listed);
    expect(list).toContain('epa_search_facilities');
    expect(list).not.toContain('"name":"epa_get_air_quality"');
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
