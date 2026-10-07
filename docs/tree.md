# epa-mcp-server - Directory Structure

Generated on: 2026-10-07 11:16:41

```text
epa-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.2.x/
│   ├── 0.3.x/
│   └── template.md
├── docs/
│   ├── design.md
│   └── idea.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── install-otel.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── prune-musl-packages.ts
│   ├── release-github.ts
│   └── tree.ts
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── facility.resource.ts
│   │   │       ├── index.ts
│   │   │       └── superfund-site.resource.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── get-air-quality.tool.ts
│   │           ├── get-ejscreen.tool.ts
│   │           ├── get-facility.tool.ts
│   │           ├── get-tri-releases.tool.ts
│   │           ├── index.ts
│   │           ├── search-facilities.tool.ts
│   │           ├── search-superfund.tool.ts
│   │           ├── search-tri-releases.tool.ts
│   │           ├── search-violations.tool.ts
│   │           └── search-water-systems.tool.ts
│   ├── services/
│   │   ├── airnow/
│   │   │   ├── airnow-service.ts
│   │   │   └── types.ts
│   │   ├── dmap/
│   │   │   ├── dmap-service.ts
│   │   │   └── types.ts
│   │   ├── echo/
│   │   │   ├── echo-service.ts
│   │   │   └── types.ts
│   │   └── ejscreen/
│   │       ├── ejscreen-service.ts
│   │       └── types.ts
│   └── index.ts
├── tests/
│   ├── config/
│   │   └── server-config.test.ts
│   ├── mcp-server/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── facility.resource.test.ts
│   │   │       └── superfund-site.resource.test.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── get-air-quality.tool.test.ts
│   │           ├── get-ejscreen.tool.test.ts
│   │           ├── get-facility.tool.test.ts
│   │           ├── get-tri-releases.tool.test.ts
│   │           ├── search-facilities.tool.test.ts
│   │           ├── search-superfund.tool.test.ts
│   │           ├── search-tri-releases.tool.test.ts
│   │           ├── search-violations.tool.test.ts
│   │           ├── search-water-systems.tool.test.ts
│   │           └── tool-definitions.test.ts
│   ├── prompts/
│   ├── resources/
│   ├── services/
│   │   ├── airnow/
│   │   │   └── airnow-service.test.ts
│   │   ├── dmap/
│   │   │   └── dmap-service.test.ts
│   │   ├── echo/
│   │   │   └── echo-service.test.ts
│   │   ├── ejscreen/
│   │   │   └── ejscreen-service.test.ts
│   │   └── error-responses.test.ts
│   ├── tools/
│   ├── http-session.test.ts
│   └── maintenance-contracts.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
