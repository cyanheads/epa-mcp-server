# epa-mcp-server - Directory Structure

Generated on: 2026-10-24 11:38:02

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
│   ├── 0.4.x/
│   ├── 0.5.x/
│   ├── 0.6.x/
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
│   │       ├── definitions/
│   │       │   ├── airnow-get-conditions.tool.ts
│   │       │   ├── echo-get-facility.tool.ts
│   │       │   ├── echo-search-facilities.tool.ts
│   │       │   ├── echo-search-violations.tool.ts
│   │       │   ├── ejscreen-get-scores.tool.ts
│   │       │   ├── index.ts
│   │       │   ├── superfund-search-sites.tool.ts
│   │       │   ├── tri-get-facility-releases.tool.ts
│   │       │   ├── tri-search-releases.tool.ts
│   │       │   └── water-search-systems.tool.ts
│   │       ├── format-lbs.ts
│   │       ├── format-location.ts
│   │       └── format-tri-release.ts
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
│   │   ├── ejscreen/
│   │   │   ├── ejscreen-service.ts
│   │   │   └── types.ts
│   │   └── call-budget.ts
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
│   │           ├── airnow-get-conditions.tool.test.ts
│   │           ├── echo-get-facility.tool.test.ts
│   │           ├── echo-search-facilities.tool.test.ts
│   │           ├── echo-search-violations.tool.test.ts
│   │           ├── ejscreen-get-scores.tool.test.ts
│   │           ├── superfund-search-sites.tool.test.ts
│   │           ├── tool-definitions.test.ts
│   │           ├── tri-get-facility-releases.tool.test.ts
│   │           ├── tri-search-releases.tool.test.ts
│   │           └── water-search-systems.tool.test.ts
│   ├── prompts/
│   ├── resources/
│   ├── services/
│   │   ├── airnow/
│   │   │   ├── airnow-fixtures.ts
│   │   │   └── airnow-service.test.ts
│   │   ├── dmap/
│   │   │   ├── fixtures/
│   │   │   │   ├── newark-superfund-coordinates.json
│   │   │   │   └── seattle-superfund-coordinates.json
│   │   │   └── dmap-service.test.ts
│   │   ├── echo/
│   │   │   ├── echo-fixtures.ts
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
