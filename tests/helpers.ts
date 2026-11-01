/**
 * @fileoverview Fakes and assertions shared by the tool and service suites: the text of a result's
 * `content[]` blocks, the dual-surface validation rejection envelope, the location-line rendering
 * suite every located-record tool repeats, the real server over HTTP, and stubbed fetches that hold or delay their answer
 * until the caller's signal fires.
 * @module tests/helpers
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import { invalidStateError } from '@/mcp-server/tools/input-formats.js';

/** The text blocks of a `content[]` array joined with newlines. */
export const textOf = (content: ReadonlyArray<{ type: string; text?: string }>): string =>
  content.flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : [])).join('\n');

/** A tool result as `runToolContract` returns it. */
type ToolCall = {
  content: ReadonlyArray<{ type: string; text?: string }>;
  structuredContent?: unknown;
};

/** Assert a validation error carries `reason`, its recovery `hint`, and `message` on both surfaces. */
export function expectValidationRejection(
  call: ToolCall,
  expected: { reason: string; hint: string; message: string },
): void {
  expect(call.structuredContent).toMatchObject({
    error: {
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining(expected.message),
      data: { reason: expected.reason, recovery: { hint: expected.hint } },
    },
  });
  const text = textOf(call.content);
  expect(text).toContain(expected.hint);
  expect(text).toContain(expected.reason);
}

/** Assert an unrecognized two-letter `state` was rejected as `invalid_state`, naming its recovery. */
export function expectInvalidState(call: ToolCall): void {
  const hint = invalidStateError.recovery;
  expect(call.structuredContent).toMatchObject({
    error: {
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_state', state: 'ZZ', recovery: { hint } },
    },
  });
  const text = textOf(call.content);
  expect(text).toContain(hint);
  expect(text).toContain('invalid_state');
}

/** A request that never answers; it rejects with the abort reason once its signal fires, as fetch does. */
export function hang(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** Answer `value()` after `ms`, unless the signal fires first and rejects with its reason. */
export function answerAfter<T>(
  ms: number,
  signal: AbortSignal | null | undefined,
  value: () => T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(value()), ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** The location fields a located record may carry. */
type LocationFields = { latitude?: number; longitude?: number; county?: string; fipsCode?: string };

/**
 * Register the coordinate, county, and FIPS rendering cases for a tool whose output uses the shared
 * location lines. `render` formats a record carrying `fields` and returns its markdown text.
 */
export function describeLocationRendering(render: (fields: LocationFields) => string): void {
  describe('coordinate and FIPS rendering', () => {
    it.each([
      [
        'both',
        { latitude: 47.60634, longitude: -122.33207 },
        '**Coordinates:** 47.60634, -122.33207',
      ],
      ['both zero', { latitude: 0, longitude: 0 }, '**Coordinates:** 0, 0'],
      ['latitude only', { latitude: 47.60634 }, '**Latitude:** 47.60634'],
      ['longitude only', { longitude: -122.33207 }, '**Longitude:** -122.33207'],
      ['zero latitude only', { latitude: 0 }, '**Latitude:** 0'],
      ['zero longitude only', { longitude: 0 }, '**Longitude:** 0'],
    ] as const)('renders %s', (_label, coords, line) => {
      const text = render(coords);
      const coordLines = text.split('\n').filter((l) => /Coordinates|Latitude|Longitude/.test(l));
      expect(coordLines).toEqual([line]);
    });

    it('renders no coordinate line when neither is present', () => {
      expect(render({})).not.toMatch(/Coordinates|Latitude|Longitude/);
    });

    it('renders county with its FIPS code on one line', () => {
      expect(render({ county: 'KING', fipsCode: '53033' })).toContain(
        '**County:** KING (FIPS: 53033)',
      );
    });

    it('renders a FIPS code that arrives without a county name', () => {
      const text = render({ fipsCode: '53033' });
      expect(text).toContain('**County FIPS:** 53033');
      expect(text).not.toContain('**County:**');
    });
  });
}

/** A JSON-RPC response as the server sends it. */
type RpcResponse = {
  id: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

/** The JSON-RPC response carrying an `id` in a reply body (plain JSON or SSE `data:` frames). */
export function rpcResponse(reply: string): RpcResponse {
  const payloads = reply.trimStart().startsWith('{')
    ? [reply]
    : reply
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter((data) => data !== '');
  const message = payloads.map((data) => JSON.parse(data) as RpcResponse).find((m) => 'id' in m);
  if (!message) throw new Error(`Expected a JSON-RPC response, got: ${reply}`);
  return message;
}

/** The real server running over HTTP on a loopback port. */
export type HttpServer = { origin: string; stop: () => Promise<void> };

/**
 * Spawn `src/index.ts` over HTTP without auth or telemetry on a free loopback port and wait for
 * `/healthz`. `env` overrides the defaults; an `undefined` value removes the variable. Callers
 * stop the server in a `finally`; a server that fails to start is stopped before this throws.
 */
export async function startHttpServer(
  env: Record<string, string | undefined>,
): Promise<HttpServer> {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    MCP_TRANSPORT_TYPE: 'http',
    MCP_HTTP_PORT: String(address.port),
    MCP_HTTP_HOST: '127.0.0.1',
    MCP_AUTH_MODE: 'none',
    AIRNOW_API_KEY: '',
    OTEL_ENABLED: 'false',
    MCP_LOG_LEVEL: 'error',
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  const child = spawn('bun', ['--no-env-file', 'src/index.ts'], {
    env: childEnv,
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
  const stop = async () => {
    child.kill('SIGTERM');
    await exited;
  };
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt++) {
      if (child.exitCode !== null) throw new Error(output);
      ready = await fetch(`${origin}/healthz`).then(
        (response) => response.ok,
        () => false,
      );
      if (!ready) await sleep(50);
    }
    if (!ready) throw new Error(`Server did not start: ${output}`);
  } catch (error) {
    await stop();
    throw error;
  }
  return { origin, stop };
}

/**
 * Assert `run` takes thread CPU time linear in its input's length, against a long line, breaks
 * throughout, and the same breaks between two letters (which a trim cannot remove). Each shape is
 * timed from 5,000 to 320,000 characters, doubling, with an absolute bound on one call at every
 * size (a quadratic scan fails it at 5,000, before any repeat runs), and the full 64× span must
 * stay under 256× the per-call time. Never wall clock.
 */
export function expectLinearCpu(run: (input: string) => unknown): void {
  const shapes: Record<string, (size: number) => string> = {
    'long line': (size) => `${'§1 x'.repeat(size / 4)}\ny`,
    'breaks throughout': (size) => '  \r\n'.repeat(size / 4),
    'breaks between letters': (size) => `x${'  \r\n'.repeat(size / 4)}y`,
  };
  const cpuMicrosPerCall = (input: string, calls: number) => {
    const start = process.threadCpuUsage();
    for (let i = 0; i < calls; i++) run(input);
    const used = process.threadCpuUsage(start);
    return (used.user + used.system) / calls;
  };
  for (const [shape, build] of Object.entries(shapes)) {
    const perCall: number[] = [];
    for (let size = 5_000; size <= 320_000; size *= 2) {
      const input = build(size);
      expect(cpuMicrosPerCall(input, 1), `${shape}, ${size} characters`).toBeLessThan(
        1_000 + size / 10,
      );
      // ~3.2 million characters a measurement keeps the smallest size above clock resolution.
      const calls = Math.ceil(3_200_000 / size);
      perCall.push(Math.min(...[0, 1, 2].map(() => cpuMicrosPerCall(input, calls))));
    }
    const ratio = perCall.at(-1)! / perCall[0]!;
    expect(ratio, `${shape}: 64× the input took ${ratio.toFixed(1)}× the CPU time`).toBeLessThan(
      256,
    );
  }
}

/** Records whether `call` has settled and how, without awaiting it. */
export function track(call: Promise<unknown>) {
  const state: { settled: boolean; value?: unknown; error?: unknown } = { settled: false };
  call.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error: unknown) => Object.assign(state, { settled: true, error }),
  );
  return state;
}
