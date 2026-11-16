/**
 * @fileoverview Node startup registers optional tools from the working directory's .env.
 * @module tests/startup-env.test
 */
import { execFileSync, spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

/* One Node bundle of src/index.ts, built once and copied into each case's working directory. */
let bundleDir: string;
const bundle = () => join(bundleDir, 'index.mjs');

beforeAll(async () => {
  bundleDir = await mkdtemp(join(tmpdir(), 'epa-startup-bundle-'));
  execFileSync(
    'bun',
    ['build', 'src/index.ts', '--target=node', '--packages=external', `--outfile=${bundle()}`],
    { stdio: 'pipe' },
  );
});

afterAll(async () => {
  await rm(bundleDir, { recursive: true, force: true });
});

it.each([
  { port: undefined, envFile: 'file' },
  { port: '1.5', envFile: 'file' },
  { port: undefined, envFile: 'directory' },
] as const)(
  'loads .env and preserves framework config startup errors under Node, port=$port, .env=$envFile',
  async ({ port, envFile }) => {
    const scratch = await mkdtemp(join(tmpdir(), 'epa-startup-env-'));
    try {
      await symlink(resolve('node_modules'), join(scratch, 'node_modules'));
      await symlink(resolve('skills'), join(scratch, 'skills'));
      await copyFile(resolve('package.json'), join(scratch, 'package.json'));
      if (envFile === 'directory') await mkdir(join(scratch, '.env'));
      else
        await writeFile(
          join(scratch, '.env'),
          'AIRNOW_API_KEY=startup-test-placeholder\nEPA_CLAMP_LIMITS=false\n',
        );
      await copyFile(bundle(), join(scratch, 'index.mjs'));
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        MCP_TRANSPORT_TYPE: 'stdio',
        MCP_AUTH_MODE: 'none',
        OTEL_ENABLED: 'false',
        MCP_LOG_LEVEL: 'info',
        LOGS_DIR: join(scratch, 'logs'),
      };
      delete env.AIRNOW_API_KEY;
      delete env.EPA_CLAMP_LIMITS;
      if (port !== undefined) env.MCP_HTTP_PORT = port;
      const child = spawn('node', [join(scratch, 'index.mjs')], {
        cwd: scratch,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: AbortSignal.timeout(5000),
      });
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
      });
      const output = new Promise<{ stdout: string; code: number | null }>(
        (resolveOutput, reject) => {
          let stdout = '';
          child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
            stdout += chunk;
            if (stdout.includes('"id":2')) resolveOutput({ stdout, code: null });
          });
          child.on('error', reject);
          child.on('exit', (code) => resolveOutput({ stdout, code }));
        },
      );
      try {
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'startup-test', version: '1' } } })}\n`,
        );
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
        );
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
        const result = await output;
        if (envFile === 'directory') {
          /* An unreadable .env reaches createApp(), which reports it with its banner. */
          expect(result.code).toBe(1);
          expect(stderr).toContain('Configuration error — server failed to start');
          expect(stderr).toContain('Failed to load .env');
          expect(stderr).not.toContain('at process.loadEnvFile');
        } else if (port === undefined) {
          expect(result.stdout).toContain('epa_airnow_get_conditions');
          /* `.env`'s EPA_CLAMP_LIMITS=false reached the count-input schemas, which are built
             while the tool modules load: each limit advertises its cap as a strict maximum. */
          const list = result.stdout
            .split('\n')
            .filter((line) => line.includes('"id":2'))
            .map(
              (line) =>
                JSON.parse(line) as {
                  result: {
                    tools: {
                      name: string;
                      inputSchema: { properties: Record<string, { maximum?: number }> };
                    }[];
                  };
                },
            )[0];
          const superfund = list?.result.tools.find((t) => t.name === 'epa_superfund_search_sites');
          const maximum = superfund?.inputSchema.properties.limit?.maximum;
          expect(maximum).toBeLessThan(Number.MAX_SAFE_INTEGER);
        } else {
          expect(result.code).toBe(1);
          expect(stderr).toContain('Configuration error — server failed to start');
          expect(stderr).toContain('MCP_HTTP_PORT');
          expect(stderr).not.toContain('at parseConfig');
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise<void>((done) => child.once('exit', () => done()));
          child.kill('SIGTERM');
          await exited;
        }
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
