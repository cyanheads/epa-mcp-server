<div align="center">
  <h1>@cyanheads/epa-mcp-server</h1>
  <p><b>Search and retrieve EPA environmental data: facility compliance (ECHO), toxic releases (TRI), Superfund sites, drinking water systems, environmental-justice screening (EJScreen), and real-time air quality (AirNow). STDIO or Streamable HTTP.</b>
  </p>
  <div>9 Tools • 2 Resources</div>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/epa-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/epa-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/epa-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/epa-mcp-server/releases/latest/download/epa-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=epa-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZXBhLW1jcC1zZXJ2ZXIiXSwiZW52Ijp7IkFJUk5PV19BUElfS0VZIjoieW91ci1hcGkta2V5In19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22epa-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fepa-mcp-server%22%5D%2C%22env%22%3A%7B%22AIRNOW_API_KEY%22%3A%22your-api-key%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

EPA environmental data across five federal programs — facility compliance (ECHO), toxic chemical releases (TRI), Superfund cleanup sites, drinking water systems (SDWIS), and environmental-justice screening (EJScreen) — plus real-time air quality via AirNow. Search facilities by location or compliance status, pull inspection and enforcement history, track toxic releases across a region, and screen a point for environmental-justice risk from any MCP client. Runs as a stdio process or a local Streamable HTTP server.

### Tools

| Tool | Description |
|:---|:---|
| `epa_search_facilities` | Search EPA-regulated facilities by location, industry program, or compliance status across CAA, CWA, RCRA, TRI, and SDWA |
| `epa_get_facility` | Full compliance profile for one facility by EPA Registry ID — inspections, enforcement actions, and penalties |
| `epa_search_violations` | Search EPA civil and criminal enforcement cases by state, program, or date range |
| `epa_get_air_quality` | Current AQI observations or next-day forecasts from AirNow |
| `epa_get_tri_releases` | Per-chemical Toxic Release Inventory data for a single facility |
| `epa_search_tri_releases` | Toxic Release Inventory records across facilities in a state or county |
| `epa_search_superfund` | Search Superfund (CERCLA/SEMS) sites by location or NPL listing status |
| `epa_search_water_systems` | Search drinking water systems (SDWIS) by state or ZIP code |
| `epa_get_ejscreen` | EJScreen environmental-justice indicators for a point and buffer |

### Resources

| Resource | Description |
|:---|:---|
| `epa://facility/{registry_id}` | Full compliance profile for a facility by EPA Registry ID (same data as `epa_get_facility`) |
| `epa://superfund/{site_id}` | Superfund site record by SEMS site ID |

All resource data is also reachable via tools — use `epa_get_facility` and `epa_search_superfund` for programmatic access in tool-only MCP clients.

## Capability reference

### `epa_search_facilities` <sub>tool</sub>

- Geographic filters: ZIP code, state, city (pair with state), or latitude + longitude + radius_miles (max 100 miles) for proximity search — at least one is required
- Optional `programs` filter narrows to CAA, CWA, RCRA, TRI, or SDWA registrants; `has_violation` surfaces only non-compliant facilities
- Returns `registryId` for `epa_get_facility`, plus `fipsCode` when available for Census chaining
- Up to 100 results per call (default 50)

---

### `epa_get_facility` <sub>tool</sub>

- Input: `registry_id`, obtained from `epa_search_facilities`
- Aggregates 3–5 ECHO DFR endpoints in parallel — program flags and TRI totals, compliance summary, inspection/enforcement history, CAA details, CWA/NPDES permit details
- Uses `Promise.allSettled` — partial data is returned even when one upstream endpoint fails
- `airCompliance` / `waterCompliance` are present only when the facility is registered under that program
- `facility_not_found` when ECHO has no record for the Registry ID

---

### `epa_search_violations` <sub>tool</sub>

- At least one of `state` or `zip_code` is required
- `program` filter covers CAA, CWA, RCRA, SDWA, CERCLA, FIFRA, or TSCA; `case_type` is civil, criminal, or all (default all)
- Date range filter by filing date (ISO 8601 `date_filed_start` / `date_filed_end`)
- `facilityName` and `registryId` are not populated by ECHO's enforcement-case endpoint — chain into `epa_get_facility` for facility detail
- Up to 100 cases per call (default 50)

---

### `epa_get_air_quality` <sub>tool</sub>

- Provide `zip_code` or both `latitude` and `longitude`
- `mode`: `current` (default) or `forecast` (requires `forecast_date`, ISO 8601)
- Per-pollutant AQI (PM2.5, ozone, CO, SO2, NO2) with numeric `categoryNumber` (1 Good – 6 Hazardous) and `categoryName`
- `distance_miles` sets the reporting-station search radius (default 25, max 300)
- Data is preliminary — informational use only, not for regulatory decisions; responses are cached ~1 hour
- Only registered when `AIRNOW_API_KEY` is set

---

### `epa_get_tri_releases` <sub>tool</sub>

- `facility_id` is the TRI `facilityId` from `epa_search_tri_releases`; optional `year` (1987–2030, defaults to all available years) and `chemical_name` (partial match)
- Per-chemical breakdown by medium — air, water, land, underground injection — plus a separate one-time/non-routine release total
- TRI data lags ~18 months; the most recent available year is typically 2 years prior to the current year

---

### `epa_search_tri_releases` <sub>tool</sub>

- `state` is required (2-letter); optional `county` (partial match), `year`, and `chemical_name`
- Up to 200 records per call (default 50); an enrichment flag marks the result truncated when it hits the limit
- Complement to `epa_get_tri_releases` — use this for area discovery, then drill into a specific facility

---

### `epa_search_superfund` <sub>tool</sub>

- Two input shapes: `state`/`city`/`zip_code`, or `latitude`+`longitude`+`radius_miles` (0.1–500 miles) — one is required
- `npl_status` filter: `listed`, `not-listed`, `proposed`, or `all` (default `all`)
- Up to 200 sites per call (default 50)

---

### `epa_search_water_systems` <sub>tool</sub>

- At least one of `state` or `zip_code` is required
- `has_violation` surfaces only systems with active violations; `pws_type` filters to `community`, `non-transient`, or `transient` (output `type` reports the SDWIS codes CWS / NTNCWS / TNCWS)
- Up to 200 systems per call (default 50)

---

### `epa_get_ejscreen` <sub>tool</sub>

- Input: `latitude`, `longitude`, `distance` (default 1), and `unit` (`miles` or `kilometers`, default `miles`); kilometers are converted to miles before the request, and the buffer is capped at 15 miles
- Returns 13 environmental and 6 demographic indicators, each with national/state percentiles, plus the Demographic Index and Supplemental Demographic Index
- Points outside US coverage return `coverage.valid: false` with a note instead of fabricated indicators
- Data source: EJScreen v2.2 (2022) via the community-maintained EJAM API (Public Environmental Data Partners) — not a live EPA endpoint

---

### `epa://facility/{registry_id}` <sub>resource</sub>

- Same data as `epa_get_facility`; `registry_id` comes from `epa_search_facilities`
- Errors when the Registry ID has no ECHO record

---

### `epa://superfund/{site_id}` <sub>resource</sub>

- Same data as `epa_search_superfund` records; `site_id` comes from `epa_search_superfund`
- Errors when the site ID has no SEMS record

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

EPA-specific:

- Multiple environmental data sources unified behind a single `epa_` tool surface: ECHO (facility compliance), Envirofacts DMAP (TRI, Superfund, SDWIS), AirNow (real-time air quality), and the community-maintained EJAM API rehosting EJScreen data (v2.2, 2022)
- Parallel ECHO DFR aggregation in `epa_get_facility` — 3–5 upstream calls resolved concurrently with `Promise.allSettled`
- AirNow response caching (~1 hour TTL) to stay within per-key rate limits

Agent-friendly output:

- Facility search supplies `registryId` for compliance lookups and `fipsCode` when available for Census queries; TRI search supplies `facilityId` for release details
- Structured partial failure — `epa_get_facility` returns available program data even when one DFR endpoint is unavailable, with `airCompliance`/`waterCompliance` present only when that program applies
- Recovery-hint messages on empty results — every search tool returns a `message` field that echoes the applied filters and suggests how to broaden the search

## Getting started

Add the following to your MCP client configuration file. An AirNow API key is optional — set `AIRNOW_API_KEY` to enable `epa_get_air_quality` (register free at [docs.airnowapi.org](https://docs.airnowapi.org/account/request/)); without it the server starts with the other 8 tools. ECHO, DMAP, and EJScreen tools work without authentication.

```json
{
  "mcpServers": {
    "epa-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/epa-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "AIRNOW_API_KEY": "your-airnow-key"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "epa-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/epa-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "AIRNOW_API_KEY": "your-airnow-key"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "epa-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-e", "AIRNOW_API_KEY=your-airnow-key",
        "ghcr.io/cyanheads/epa-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 AIRNOW_API_KEY=... bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- (Optional) An AirNow API key to enable `epa_get_air_quality` — register free at [docs.airnowapi.org/account/request](https://docs.airnowapi.org/account/request/). Without it the server runs the other 8 tools. ECHO, DMAP, and EJScreen tools require no API key.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/epa-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd epa-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# optionally set AIRNOW_API_KEY to enable the air quality tool
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/`. Key environment variables:

| Variable | Description | Default |
|:---|:---|:---|
| `AIRNOW_API_KEY` | **Optional.** Enables `epa_get_air_quality` when set; the server runs the other 8 tools without it. Free registration at [docs.airnowapi.org](https://docs.airnowapi.org/account/request/). | — |
| `EPA_ECHO_BASE_URL` | ECHO API base URL | `https://echodata.epa.gov/echo` |
| `EPA_DMAP_BASE_URL` | Envirofacts DMAP API base URL | `https://data.epa.gov/dmapservice` |
| `EPA_AIRNOW_BASE_URL` | AirNow API base URL | `https://www.airnowapi.org/aq` |
| `EJSCREEN_API_BASE_URL` | **Optional.** EJScreen (EJAM) API base URL used by `epa_get_ejscreen`. | `https://api.ejanalysis.com` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path | `/mcp` |
| `MCP_SESSION_MODE` | HTTP sessions: `auto`, `stateful`, or `stateless`. Explicit environment values override the server default; `auto` resolves to `stateful`. Tenant-scoped caching is independent of sessions. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424) | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only) | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1` | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) tracing and metrics | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t epa-mcp-server .
docker run --rm -e AIRNOW_API_KEY=your-key -p 3010:3010 epa-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/epa-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools/resources and inits services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Nine tools across ECHO, DMAP, EJAM, and AirNow. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). Facility and Superfund URI handlers. |
| `src/services/echo` | ECHO REST API service layer — facility search, facility detail, enforcement cases. |
| `src/services/dmap` | Envirofacts DMAP service layer — TRI releases, Superfund sites, drinking water systems. |
| `src/services/airnow` | AirNow service layer — current and forecast AQI observations. |
| `src/services/ejscreen` | EJScreen (EJAM) service layer — environmental-justice indicators for a point + buffer. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields
- ECHO searches must enforce at least one geographic parameter — unscoped queries time out against the live API

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
