<div align="center">
  <h1>@cyanheads/epa-mcp-server</h1>
  <p><b>Access EPA environmental data — facility compliance (ECHO), toxic releases (TRI), Superfund sites, drinking water systems, and real-time air quality (AirNow) via MCP. STDIO or Streamable HTTP.</b>
  <div>8 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Tools

8 tools spanning EPA facility compliance, toxic chemical releases, Superfund cleanup sites, drinking water safety, and real-time air quality:

| Tool | Description |
|:---|:---|
| `epa_search_facilities` | Search EPA-regulated facilities by location, industry, or compliance status across all environmental programs (CAA, CWA, RCRA, TRI, SDWA). Returns facility name, EPA Registry ID, coordinates, county FIPS, per-program compliance flags, inspection counts, penalty totals, and TRI release totals. |
| `epa_get_facility` | Retrieve a full compliance profile for a single EPA-regulated facility: compliance status per program, inspection dates, formal enforcement actions, penalty amounts, and TRI annual release totals. Aggregates multiple ECHO DFR endpoints in parallel. |
| `epa_search_violations` | Search EPA civil and criminal enforcement cases by state, regulatory program, or date range. Returns case identifier, facility name and Registry ID, programs involved, penalty assessed, settlement date, and case type. |
| `epa_get_air_quality` | Get AQI observations or forecasts for a location. Returns per-pollutant AQI values (PM2.5, ozone, CO, SO2, NO2), AQI category (Good through Hazardous), reporting area name, and observation timestamp. |
| `epa_get_tri_releases` | Query Toxic Release Inventory annual chemical release data for a specific facility by medium (air, water, land, underground injection) and reporting year. |
| `epa_search_tri_releases` | Search Toxic Release Inventory data across facilities in a state or county for a given year. Returns facility name, TRI ID, chemical name, total releases by medium, and facility coordinates. |
| `epa_search_superfund` | Search Superfund (CERCLA/SEMS) sites by location or NPL listing status. Accepts state/city/ZIP or lat/lng + radius for proximity searches. Returns site name, EPA ID, NPL status, cleanup status, and coordinates. |
| `epa_search_water_systems` | Search drinking water systems (SDWIS) by state or ZIP code. Returns system name, PWSID, population served, primary water source, and active violation status. |

### `epa_search_facilities`

Search for EPA-regulated facilities with cross-program compliance data.

- Geographic filters: ZIP code, state, city (city requires state)
- Program filter: narrow to CAA, CWA, RCRA, TRI, or SDWA registrants
- Compliance filter: `has_violation` flag to surface only non-compliant facilities
- Returns `RegistryID` (key for `epa_get_facility`), `FacFIPSCode` (county FIPS for Census chaining), and coordinates
- Results cap enforced — unscoped searches are prohibited at the input validation layer

---

### `epa_get_facility`

Retrieve a comprehensive compliance profile by EPA Registry ID.

- Aggregates 3–5 ECHO DFR endpoints in parallel: program flags and TRI totals, compliance summary, inspection/enforcement history, CAA details (if registered), CWA/NPDES permit details (if registered)
- Uses `Promise.allSettled` — partial data returned even if one upstream endpoint fails
- Includes formal enforcement actions, penalty amounts, and inspection dates across all programs

---

### `epa_search_violations`

Search area-level EPA enforcement cases — distinct from per-facility history in `epa_get_facility`.

- Program filter: CAA, CWA, RCRA, SDWA, CERCLA, FIFRA, or TSCA
- Case type: civil, criminal, or all
- Date range filtering by filing date (ISO 8601)
- Returns case identifier, affected facility name and Registry ID for downstream `epa_get_facility` lookup

---

### `epa_get_air_quality`

Get current AQI observations or daily forecasts from AirNow.

- Accepts ZIP code or latitude/longitude coordinates
- `mode: current` returns the latest observed AQI per pollutant; `mode: forecast` returns daily AQI forecasts (requires `forecast_date`)
- AQI categories: Good (1) through Hazardous (6) with numeric and text category
- Data is preliminary — suitable for awareness, not regulatory or enforcement decisions
- AirNow responses cached at ~1 hour TTL to respect rate limits

---

### `epa_get_tri_releases`

Query per-chemical release breakdown for a single TRI facility.

- Accepts TRI facility ID from `epa_search_facilities` results
- Returns release quantities by medium: air, water, land, underground injection
- Optional year filter (defaults to most recent available); optional chemical name filter
- TRI data lags ~18 months — most recent available year is typically 2 years prior to current

---

### `epa_search_tri_releases`

Identify top polluters in a region via TRI data.

- State and optional county scope; required year parameter
- Optional chemical name filter to focus on a specific substance
- Returns facility coordinates for downstream map or proximity analysis
- Complement to `epa_get_tri_releases` — use this for area discovery, then drill into a specific facility

---

### `epa_search_superfund`

Search Superfund (CERCLA/SEMS) sites by location or proximity.

- Two input shapes: state/city/ZIP for administrative filters, or lat/lng + radius for proximity
- NPL status filter: listed, not-listed, proposed, or all
- Returns site cleanup status and coordinates for downstream spatial analysis

---

### `epa_search_water_systems`

Identify drinking water systems with active or recent violations.

- State and optional ZIP code scope
- `has_violation` flag surfaces only systems with current violations
- PWS type filter: community (`CWS`), non-transient non-community (`NTNCWS`), or transient non-community (`TNCWS`)

## Resources and prompts

| Type | Name | Description |
|:---|:---|:---|
| Resource | `epa://facility/{registry_id}` | Full compliance profile for a facility by EPA Registry ID (same data as `epa_get_facility`) |
| Resource | `epa://superfund/{site_id}` | Superfund site record by SEMS site ID |

All resource data is also reachable via tools. Use `epa_get_facility` and `epa_search_superfund` for programmatic access in tool-only MCP clients.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool and resource definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

EPA-specific:

- Three complementary EPA APIs unified behind a single `epa_` tool surface: ECHO (facility compliance), Envirofacts DMAP (TRI, Superfund, SDWIS), and AirNow (real-time air quality)
- Parallel ECHO DFR aggregation in `epa_get_facility` — 3–5 upstream calls resolved concurrently with `Promise.allSettled`
- AirNow response caching (~1 hour TTL) to stay within per-key rate limits
- DMAP coordinate normalization — `tri.tri_facility` DDMMSS integers converted to decimal degrees

Agent-friendly output:

- Cross-tool join keys surfaced on every response — `RegistryID` and `FacFIPSCode` from facility search feed directly into compliance, TRI, and Census API workflows
- Typed enforcement and compliance status fields — agents branch on data values, not string parsing
- Structured partial failure — `epa_get_facility` returns available program data even when one DFR endpoint is unavailable, with per-section status

## Getting started

Add the following to your MCP client configuration file. An AirNow API key is required for `epa_get_air_quality` — register free at [docs.airnowapi.org](https://docs.airnowapi.org/account/request/). ECHO and DMAP tools work without authentication.

```json
{
  "mcpServers": {
    "epa": {
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
    "epa": {
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

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 AIRNOW_API_KEY=... bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
- An AirNow API key for `epa_get_air_quality` — register free at [docs.airnowapi.org/account/request](https://docs.airnowapi.org/account/request/). ECHO and DMAP tools require no API key.

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
# edit .env and set AIRNOW_API_KEY
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/`. Key environment variables:

| Variable | Description | Default |
|:---|:---|:---|
| `AIRNOW_API_KEY` | **Required for `epa_get_air_quality`.** Free registration at [docs.airnowapi.org](https://docs.airnowapi.org/account/request/). ECHO and DMAP tools work without it. | — |
| `EPA_ECHO_BASE_URL` | ECHO API base URL | `https://echodata.epa.gov/echo` |
| `EPA_DMAP_BASE_URL` | Envirofacts DMAP API base URL | `https://data.epa.gov/dmapservice` |
| `EPA_AIRNOW_BASE_URL` | AirNow API base URL | `https://www.airnowapi.org/aq` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path | `/mcp` |
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
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Eight tools across ECHO, DMAP, and AirNow. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). Facility and Superfund URI handlers. |
| `src/services/echo` | ECHO REST API service layer — facility search, facility detail, enforcement cases. |
| `src/services/dmap` | Envirofacts DMAP service layer — TRI releases, Superfund sites, drinking water systems. |
| `src/services/airnow` | AirNow service layer — current and forecast AQI observations. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields
- ECHO searches must enforce at least one geographic parameter — unscoped queries time out against the live API

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
