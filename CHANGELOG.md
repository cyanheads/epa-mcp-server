# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.3.1](changelog/0.3.x/0.3.1.md) — 2026-08-22

Modern MCP protocol support and bounded EPA search pagination.

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-07-10

New epa_get_ejscreen tool: EJScreen environmental-justice indicators (13 environmental + 6 demographic, each with national/state percentiles and EJ Index) for a point + buffer, served via the community-maintained EJAM API rehosting EJScreen v2.2 (2022).

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-07-10

Per-medium TRI release breakdown on epa_get_tri_releases, ECHO proximity search radius fix, and mcp-ts-core 0.10.14 adoption clearing 9 dependency advisories

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-06-21

Optional AIRNOW_API_KEY (server runs the 7 keyless tools without it) and latitude/longitude/radius proximity search on epa_search_facilities

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-06-12

Adopt mcp-ts-core ^0.10.6 — ValidationError codes, explicit server identity, TRI truncation enrichment, Docker healthcheck, plugin manifests

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-06-10

AirNow cache key fix, ECHO facility DFR endpoint fix, ECHO violations two-step case query fix

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-05-26

Ecosystem metadata alignment — scoped package scripts, author/funding fields, FUNDING.yml, README install badges

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-05-26

mcpName for MCP Registry, publish-mcp script, Dockerfile build-stage fix

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-05-25

Bug fixes from field testing — TRI field mapping, Superfund site lookup, SDWIS query, AirNow cache keys, ECHO headers, and server.json env var config

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-25

Initial release — EPA environmental data server (ECHO, TRI, Superfund, SDWIS, AirNow)
