/**
 * @fileoverview Keeps runtime skill modules while stripping dependency-root agent documents.
 * @module tests/scripts/bundle-agent-docs.test
 */
import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';
import { AGENT_DOC_ENTRY } from '../../scripts/lint-packaging.js';

describe('bundle agent documentation boundaries', () => {
  it.each([
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
    'node_modules/parent/node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
    'node_modules/example/dist/skills/runtime.js',
    'skills/epa-guide/SKILL.md',
  ])('retains runtime or published skill %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([]);
    expect(AGENT_DOC_ENTRY.test(entry)).toBe(false);
  });

  it.each([
    'node_modules/example/skills/guide/SKILL.md',
    'node_modules/@scope/example/framework-skills/add-tool/SKILL.md',
    'node_modules/parent/node_modules/@scope/example/.claude/skills/guide/SKILL.md',
    'node_modules/@scope/parent/node_modules/example/.agents/skills/guide/SKILL.md',
    'node_modules/example/SKILL.md',
  ])('removes dependency-root agent document %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([entry]);
    expect(AGENT_DOC_ENTRY.test(entry)).toBe(true);
  });
});
