<div align="center">
  <h1>@cyanheads/epa-mcp-server</h1>
  <p><b>Search and retrieve EPA environmental data: facility compliance (ECHO), toxic releases (TRI), Superfund sites, drinking water systems, environmental-justice screening (EJScreen), and real-time air quality (AirNow). STDIO or Streamable HTTP.</b>
  </p>
  <div>9 Tools • 2 Resources</div>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.5.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/epa-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/epa-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/epa-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/epa-mcp-server/releases/latest/download/epa-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=epa-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZXBhLW1jcC1zZXJ2ZXIiXSwiZW52Ijp7IkFJUk5PV19BUElfS0VZIjoieW91ci1hcGkta2V5In19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22epa-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fepa-mcp-server%22%5D%2C%22env%22%3A%7B%22AIRNOW_API_KEY%22%3A%22your-api-key%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://epa.caseyjhand.com/mcp](https://epa.caseyjhand.com/mcp)

</div>

---

## Overview

EPA environmental data across five federal programs — facility compliance (ECHO), toxic releases (TRI), Superfund sites, drinking water systems (SDWIS), and environmental-justice screening (EJScreen) — plus real-time AirNow air quality. Pull a facility's inspection and enforcement history, track toxic releases across a region, or screen any point for environmental-justice risk.

### Tools

| Tool | Description |
|:---|:---|
| `epa_echo_search_facilities` | Search EPA-regulated facilities by location, environmental program, or compliance status across CAA, CWA, RCRA, TRI, and SDWA |
| `epa_echo_get_facility` | Full compliance profile for one facility by EPA Registry ID — compliance status, inspections, enforcement actions, penalties, and TRI IDs |
| `epa_echo_search_violations` | Search EPA civil and criminal enforcement cases by state, program, or date range |
| `epa_airnow_get_conditions` | Current AQI observations or the issued AQI forecast from AirNow |
| `epa_tri_get_facility_releases` | Per-chemical Toxic Release Inventory data for a single facility |
| `epa_tri_search_releases` | Toxic Release Inventory records across facilities in a state or county |
| `epa_superfund_search_sites` | Search Superfund (CERCLA/SEMS) sites by location or NPL listing status |
| `epa_water_search_systems` | Search drinking water systems (SDWIS) by state or ZIP code |
| `epa_ejscreen_get_scores` | EJScreen environmental-justice indicators for a point and buffer |

### Resources

| Resource | Description |
|:---|:---|
| `epa://facility/{registry_id}` | Full compliance profile for a facility by EPA Registry ID (same data as `epa_echo_get_facility`) |
| `epa://superfund/{site_id}` | Superfund site record by SEMS site ID |

All resource data is also reachable via tools — use `epa_echo_get_facility` and `epa_superfund_search_sites` for programmatic access in tool-only MCP clients.

## Capability reference

### `epa_echo_search_facilities` <sub>tool</sub>

- Provide ZIP code, state, city (prefix match, preferably with state), or latitude + longitude + radius_miles (max 100 miles); up to 100 results (default 50)
- Returns `registryId` for `epa_echo_get_facility`, county and `fipsCode`, coordinates, per-program flags, and five-year inspection and penalty totals
- `programs` takes one of CAA, CWA, RCRA, TRI, or SDWA; `has_violation` keeps facilities in significant noncompliance; `active_only` keeps facilities with an active permit

---

### `epa_echo_get_facility` <sub>tool</sub>

- `registry_id` comes from `epa_echo_search_facilities`
- Returns `complianceStatus`, a per-statute `programCompliance` summary, the newest 100 inspections from the last five years (`inspectionsTotal` counts them all), five years of enforcement actions with penalties, the latest TRI total with `triReleasesTransfersYear`, and `triFacilityIds` for `epa_tri_get_facility_releases`
- If the status lookup fails, the profile returns without `complianceStatus` and a `notice` says so; an unknown ID fails as `facility_not_found`

---

### `epa_echo_search_violations` <sub>tool</sub>

- Requires `state` or `zip_code`; up to 100 cases (default 50)
- `program` filters CAA, CWA, RCRA, SDWA, CERCLA, FIFRA, or TSCA, matching any law a case cites; `case_type` is civil, criminal, or all (default)
- `date_filed_start` / `date_filed_end` (YYYY-MM-DD, inclusive) bound the filing date. Only civil cases carry filing dates, so with a date `all` returns civil cases with a `notice`, and `criminal` is rejected

---

### `epa_airnow_get_conditions` <sub>tool</sub>

- Provide `zip_code` or both `latitude` and `longitude`; `mode` is current (default) or forecast
- Current mode returns each pollutant's latest hourly NowCast AQI from the closest monitor within 50 miles; forecast mode returns each issued day with `dateValid`, `actionDay`, and `discussion`, and `forecast_date` (YYYY-MM-DD) keeps one day
- Readings carry `categoryName` and `categoryNumber` (1 Good–6 Hazardous); `attribution` marks the data preliminary and unsuitable for regulatory or enforcement decisions
- Registered only when `AIRNOW_API_KEY` is set; responses cache for about one hour

---

### `epa_tri_get_facility_releases` <sub>tool</sub>

- `facility_id` is the TRI `facilityId` from `epa_tri_search_releases` or `epa_echo_get_facility` `triFacilityIds`; optional `year` (1987–2030) and partial `chemical_name`
- Returns per-chemical air, water, land, and underground-injection releases plus a one-time/non-routine total, newest reporting year first when `year` is omitted. At 500 filings, both response surfaces warn that more may exist; narrow with `year` or `chemical_name`
- Quantities are in pounds; dioxin records reported in grams are converted and carry `reportedUnit: "grams"`

---

### `epa_tri_search_releases` <sub>tool</sub>

- Requires 2-letter `state`; optional `county` (partial match, case-insensitive), partial `chemical_name`, and `year`; up to 200 records (default 50), newest reporting year first when `year` is omitted
- Returns `facilityId` for `epa_tri_get_facility_releases` and each record's one-time/non-routine total; `include_release_breakdown: true` adds air, water, land, and underground-injection releases at the cost of one more upstream request (up to ~20 seconds when EPA has not cached it)
- Dioxin records reported in grams are converted to pounds and carry `reportedUnit: "grams"`

---

### `epa_superfund_search_sites` <sub>tool</sub>

- Provide `state`/`city`/`zip_code`, or `latitude` + `longitude` + `radius_miles` (0.1–500); up to 200 sites (default 50)
- Returns site identifiers, location, NPL, and cleanup status; `npl_status` filters listed, not-listed, proposed, or all (default)
- Proximity searches page latitude/longitude candidates to exhaustion, apply exact distance, and return the nearest sites first. A `notice` says how many matching sites the result limit omitted; sites without coordinates cannot be located. All candidate pages share a 50-second deadline — narrow the radius or add filters if it times out

---

### `epa_water_search_systems` <sub>tool</sub>

- Requires `state` or `zip_code`; up to 200 systems (default 50). `zip_code` matches each system's address of record, not its service area
- `has_violation` keeps systems with an open SDWIS violation; `pws_type` is community, non-transient, or transient, returned as CWS / NTNCWS / TNCWS in `type`
- `has_violation` reads at most 1,000 records; when that fills, a `notice` says the list may miss violating systems

---

### `epa_ejscreen_get_scores` <sub>tool</sub>

- Requires `latitude` and `longitude`; `distance` defaults to 1, `unit` to miles (kilometers accepted); buffer capped at 15 miles
- Returns 13 environmental and 6 demographic indicators with national/state percentiles and demographic indices; outside coverage, `coverage.valid: false` carries a note
- EJScreen v2.2 (2022) comes from the community-maintained EJAM API (Public Environmental Data Partners)

---

### `epa://facility/{registry_id}` <sub>resource</sub>

- `registry_id` comes from `epa_echo_search_facilities`
- Returns the `epa_echo_get_facility` compliance profile; errors when no facility resolves

---

### `epa://superfund/{site_id}` <sub>resource</sub>

- `site_id` comes from `epa_superfund_search_sites`
- Returns the Superfund site record; errors when no SEMS record resolves

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

EPA-specific:

- One `epa_` tool surface over ECHO (facility compliance), Envirofacts DMAP (TRI, Superfund, SDWIS), AirNow (air quality), and the community-maintained EJAM API (EJScreen v2.2, 2022)
- AirNow responses cache for about one hour to stay within per-key rate limits
- TRI reporting lags about 18 months; the latest reporting year is typically two years behind

Agent-friendly output:

- Search results carry the IDs the next tool needs: `registryId`, `fipsCode`, `facilityId`, and `triFacilityIds`
- `epa_echo_get_facility` returns a partial profile with a `notice` when the status lookup fails
- Empty searches return a `message` that echoes the applied filters and suggests how to broaden them

## Getting started

### Public Hosted Instance

A public instance is available at `https://epa.caseyjhand.com/mcp` — no installation required. It runs without an AirNow key, so `epa_airnow_get_conditions` is not available there; the other 8 tools are. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "epa-mcp-server": {
      "type": "streamable-http",
      "url": "https://epa.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file. An AirNow API key is optional — set `AIRNOW_API_KEY` to enable `epa_airnow_get_conditions` (register free at [docs.airnowapi.org](https://docs.airnowapi.org/account/request/)); without it the server starts with the other 8 tools. ECHO, DMAP, and EJScreen tools work without authentication.

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

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+); development and Docker use Bun v1.4.4.
- (Optional) An AirNow API key to enable `epa_airnow_get_conditions` — register free at [docs.airnowapi.org/account/request](https://docs.airnowapi.org/account/request/). Without it the server runs the other 8 tools. ECHO, DMAP, and EJScreen tools require no API key.

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
| `AIRNOW_API_KEY` | **Optional.** Enables `epa_airnow_get_conditions`. | — |
| `EPA_ECHO_BASE_URL` | ECHO API base URL | `https://echodata.epa.gov/echo` |
| `EPA_DMAP_BASE_URL` | Envirofacts DMAP API base URL | `https://data.epa.gov/dmapservice` |
| `EPA_AIRNOW_BASE_URL` | AirNow API base URL | `https://www.airnowapi.org/aq` |
| `EJSCREEN_API_BASE_URL` | EJScreen (EJAM) API base URL | `https://api.ejanalysis.com` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path | `/mcp` |
| `MCP_SESSION_MODE` | HTTP sessions: `auto`, `stateful`, or `stateless` | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424) | `info` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log failed calls' arguments and results with key-name redaction. Secrets inside free-form values remain visible. | `false` |
| `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` | Byte cap per logged payload | `16384` |
| `LOGS_DIR` | Directory for log files (Node.js only) | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1` | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) tracing and metrics | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP base URL | — |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Per-signal endpoint overrides | — |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Enables OTLP log export | — |

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
