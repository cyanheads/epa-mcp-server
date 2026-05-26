# epa-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `epa_search_facilities` | Search EPA-regulated facilities by location, industry, or compliance status across all environmental programs (CAA, CWA, RCRA, TRI, SDWA). Returns facility name, EPA Registry ID, coordinates, county FIPS, per-program compliance flags, inspection counts, penalty totals, and TRI release totals. Registry IDs returned here feed `epa_get_facility` and `epa_get_tri_releases`. | `zip_code`, `state`, `city`, `active_only` (boolean), `programs` (enum array: CAA/CWA/RCRA/TRI/SDWA), `has_violation` (boolean), `limit` | `readOnlyHint: true` |
| `epa_get_facility` | Retrieve a full compliance profile for a single EPA-regulated facility: compliance status per regulatory program, inspection dates, formal enforcement actions, penalty amounts, and TRI annual release totals. Aggregates multiple ECHO DFR endpoints in parallel. | `registry_id` | `readOnlyHint: true` |
| `epa_search_violations` | Search EPA civil and criminal enforcement cases by state, regulatory program, or date range. Returns case identifier, regulated facility name and Registry ID, programs involved, penalty assessed, settlement date, and case type (civil/criminal). Designed for area-level violation discovery; for a single facility's enforcement history use `epa_get_facility`. | `state`, `zip_code`, `program` (enum: CAA/CWA/RCRA/SDWA/CERCLA/FIFRA/TSCA), `case_type` (civil/criminal/all), `date_filed_start`, `date_filed_end` (ISO 8601 dates), `limit` | `readOnlyHint: true` |
| `epa_get_air_quality` | Get AQI observations or forecasts for a location. Returns per-pollutant AQI values (PM2.5, ozone, CO, SO2, NO2), AQI category (Good through Hazardous), reporting area name, and observation timestamp. Data is preliminary — suitable for awareness and informational use, not regulatory decisions. | `zip_code` OR `latitude`+`longitude`, `mode` (enum: `current`/`forecast`), `forecast_date` (ISO 8601 date, required when `mode='forecast'`) | `readOnlyHint: true` |
| `epa_get_tri_releases` | Query Toxic Release Inventory annual chemical release data for a specific facility. Returns per-chemical release quantities by medium (air, water, land, underground injection) and reporting year. TRI data lags ~18 months — the most recent available year is typically 2 years prior to the current calendar year. | `facility_id` (TRI facility ID from `epa_search_facilities`), `year` (optional; defaults to most recent available), `chemical_name` (optional filter) | `readOnlyHint: true` |
| `epa_search_tri_releases` | Search Toxic Release Inventory data across facilities in a state or county for a given year. Returns facility name, TRI ID, chemical name, total releases by medium, and facility coordinates. Use to identify top polluters in an area or build an environmental exposure profile. | `state`, `county` (optional), `year`, `chemical_name` (optional), `limit` | `readOnlyHint: true` |
| `epa_search_superfund` | Search Superfund (CERCLA/SEMS) sites by location or NPL listing status. Returns site name, EPA ID, NPL status (listed/not listed/removed), cleanup status, coordinates, and county FIPS. Accepts either state/city/ZIP or a lat/lng + radius for proximity searches. | `state`, `city`, `zip_code` OR `latitude`+`longitude`+`radius_miles`, `npl_status` (listed/not-listed/proposed/all), `limit` | `readOnlyHint: true` |
| `epa_search_water_systems` | Search drinking water systems (SDWIS) by state or ZIP code. Returns system name, PWSID, population served, primary water source, and active violation status. Use to identify community water systems with current or recent violations. | `state`, `zip_code`, `has_violation` (boolean), `pws_type` (enum: community/non-transient/transient), `limit` | `readOnlyHint: true` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `epa://facility/{registry_id}` | Full compliance profile for a facility by EPA Registry ID (same data as `epa_get_facility`) | No |
| `epa://superfund/{site_id}` | Superfund site record by SEMS site ID | No |

### Prompts

None. This server is data-oriented.

---

## Overview

`epa-mcp-server` exposes EPA environmental data across three complementary systems — ECHO (facility compliance), Envirofacts/DMAP (TRI chemical releases, Superfund, drinking water), and AirNow (real-time air quality) — as a unified "environmental data" tool surface. Tools are designed around agent workflows, not API boundaries.

Target agent workflows:
- **Facility compliance audit**: `epa_search_facilities` → `epa_get_facility` → `epa_search_violations`
- **Environmental justice analysis**: `epa_search_facilities` (by ZIP) → `epa_search_tri_releases` (by state/county) → chain `FacFIPSCode` to Census API for demographics
- **Air quality check**: `epa_get_air_quality` (current) → `epa_get_air_quality` (forecast)
- **Superfund proximity**: `epa_search_superfund` (lat/lng + radius) → `epa_get_facility` if responsible party is still regulated
- **Drinking water safety**: `epa_search_water_systems` (by ZIP) → identify violating systems

All APIs are US federal government data (public domain, 17 USC §105). ECHO and Envirofacts/DMAP require no authentication. AirNow requires a free API key with no redistribution restrictions.

---

## Requirements

- Read-only access to three EPA APIs: ECHO (`echodata.epa.gov`), Envirofacts DMAP (`data.epa.gov`), AirNow (`www.airnowapi.org`)
- AirNow requires `AIRNOW_API_KEY` (free registration at docs.airnowapi.org); ECHO and DMAP are unauthenticated
- AirNow rate limits by key per hour — responses should be cached for ~1 hour TTL
- No write operations; all tools are read-only
- Cannot imply EPA endorsement in output
- AirNow data is preliminary — not for regulatory, trend, or enforcement purposes (stated in descriptions)
- ECHO searches must always include at least one geographic filter (state, ZIP, or city) — unscoped searches return millions of rows and time out

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `EchoService` | ECHO REST API (`echodata.epa.gov/echo/`) | `epa_search_facilities`, `epa_get_facility`, `epa_search_violations` |
| `DmapService` | Envirofacts DMAP REST API (`data.epa.gov/dmapservice/`) | `epa_get_tri_releases`, `epa_search_tri_releases`, `epa_search_superfund`, `epa_search_water_systems` |
| `AirNowService` | AirNow API (`www.airnowapi.org/aq/`) | `epa_get_air_quality` |

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `AIRNOW_API_KEY` | Yes | AirNow API key. Free registration at https://docs.airnowapi.org/account/request/ |
| `EPA_ECHO_BASE_URL` | No | ECHO API base URL (default: `https://echodata.epa.gov/echo`) |
| `EPA_DMAP_BASE_URL` | No | DMAP API base URL (default: `https://data.epa.gov/dmapservice`) |
| `EPA_AIRNOW_BASE_URL` | No | AirNow API base URL (default: `https://www.airnowapi.org/aq`) |

---

## Implementation Order

1. Config and server setup (`AIRNOW_API_KEY`, base URLs)
2. `EchoService` — facility search, facility detail, enforcement cases
3. `DmapService` — DMAP REST table queries (TRI, SEMS, SDWIS)
4. `AirNowService` — current/forecast observations by ZIP and lat/lng
5. `epa_search_facilities` (ECHO `get_facility_info`)
6. `epa_get_facility` (ECHO `dfr_rest_services`, multi-endpoint aggregation)
7. `epa_search_violations` (ECHO `case_rest_services`)
8. `epa_get_air_quality` (AirNow current + forecast)
9. `epa_get_tri_releases` (DMAP `tri.tri_reporting_form` by `tri_facility_id`)
10. `epa_search_tri_releases` (DMAP `tri.tri_facility` + `tri.tri_reporting_form` join by state)
11. `epa_search_superfund` (DMAP `sems.envirofacts_site`)
12. `epa_search_water_systems` (DMAP `sdwis.water_system`)
13. Resources (facility and superfund URI handlers)

Each step is independently testable.

---

## Domain Mapping

### ECHO (Enforcement and Compliance History Online)

| Noun | Operations | Endpoint |
|:-----|:-----------|:---------|
| Facility | search (by geo/program/compliance) | `echo_rest_services.get_facility_info` |
| Facility | get detail (all programs) | `dfr_rest_services.*` — multi-call, parallelized |
| Enforcement Case | search (civil + criminal) | `case_rest_services.get_case_info` |

ECHO search supports a QID-based paginated flow (`get_facilities` → `get_qid`) for large result sets, but `get_facility_info` is self-contained and suitable for the typical <500-facility search. Use `get_facility_info` directly with `p_limit` capped to avoid timeouts.

Key `p_*` parameters for `get_facility_info`:
- `p_zip` — ZIP code
- `p_state` — 2-letter state abbreviation
- `p_city` — city name (must pair with `p_state`)
- `p_act=Y` — active facilities only
- `p_limit` — row cap (recommended ≤ 100)
- `p_qcolumns` — limit payload to specific column IDs

Key output fields per facility:
- `RegistryID` — EPA FRS Registry ID (primary join key to DFR and DFR endpoints)
- `FacComplianceStatus` — overall compliance text
- `FacFIPSCode` — 5-digit county FIPS (for Census/OSM chaining)
- `FacLat` / `FacLon` — decimal degrees
- `TRIFlag` / `AIRFlag` / `CWAFlag` / `RCRFlag` / `SDWAFlag` — program registration flags
- `TRIReleasesTransfers` — total TRI on/off-site releases in lbs (summary; use `epa_get_tri_releases` for detail)

### Envirofacts DMAP REST

| Noun | Operations | Table(s) |
|:-----|:-----------|:---------|
| TRI Facility | list by state | `tri.tri_facility` |
| TRI Release | get by `tri_facility_id` and/or year | `tri.tri_reporting_form` |
| Superfund Site | search by state/NPL status | `sems.envirofacts_site` |
| Drinking Water System | search by state | `sdwis.water_system` |

URL format: `https://data.epa.gov/dmapservice/{schema}.{table}/{column}/{operator}/{value}/[{first}:{last}]`
Operators: `equals`, `notEquals`, `lessThan`, `greaterThan`, `beginsWith`, `contains`, `in`
Combine filters: `/and/` or `/or/`
Default format: JSON. Append `/csv` etc. for other formats.
Max timeout: 15 minutes. Paginate with positional `first:last`.

**Verified column names** (probing revealed several obvious guesses are wrong):

| Table | Correct column | Notes |
|:------|:--------------|:------|
| `tri.tri_facility` | `state_abbr` | State filter |
| `tri.tri_facility` | `tri_facility_id` | Primary key, join to `tri.tri_reporting_form` |
| `tri.tri_reporting_form` | `tri_facility_id` | Join from `tri_facility` |
| `tri.tri_reporting_form` | `reporting_year` | Year filter (string: `"2022"`) |
| `sems.envirofacts_site` | `fk_ref_state_code` | State filter |
| `sems.envirofacts_site` | `npl_status_code` | `"N"` = not listed, `"NPL"` = listed |
| `sems.envirofacts_site` | `site_id` | Primary key |
| `sdwis.water_system` | `primacy_agency_code` | 2-letter state code |
| `sdwis.water_system` | `pws_type_code` | `CWS`/`NTNCWS`/`TNCWS` |
| `sdwis.water_system` | `pwsid` | Primary key |

Note: DMAP coordinate encoding varies by table. `sems.envirofacts_site` uses decimal degrees (`primary_latitude_decimal_val`). `tri.tri_facility` uses integer DDMMSS (`fac_latitude: 482730` = 48°27'30"N) — service layer must convert.

### AirNow

| Noun | Operations | Endpoint |
|:-----|:-----------|:---------|
| Current Observation | by ZIP | `/observation/zipCode/current/?zipCode={zip}&distance={miles}&API_KEY={key}` |
| Current Observation | by lat/lng | `/observation/latLong/current/?latitude={lat}&longitude={lon}&distance={miles}&API_KEY={key}` |
| Forecast | by ZIP | `/forecast/zipCode/?zipCode={zip}&date={YYYY-MM-DD}&distance={miles}&API_KEY={key}` |
| Forecast | by lat/lng | `/forecast/latLong/?latitude={lat}&longitude={lon}&date={YYYY-MM-DD}&distance={miles}&API_KEY={key}` |

All return `format=application/json`. Response is an array; each element:
```json
{
  "DateObserved": "2026-05-25 ",
  "HourObserved": 14,
  "LocalTimeZone": "PST",
  "ReportingArea": "Seattle-Tacoma-Bellevue, WA",
  "StateCode": "WA",
  "Latitude": 47.6,
  "Longitude": -122.3,
  "ParameterName": "PM2.5",
  "AQI": 42,
  "Category": { "Number": 1, "Name": "Good" }
}
```

AQI Categories: 1=Good, 2=Moderate, 3=Unhealthy for Sensitive Groups, 4=Unhealthy, 5=Very Unhealthy, 6=Hazardous.

---

## Workflow Analysis

### `epa_get_facility` (3–5 upstream calls, parallelized)

Returns a comprehensive profile aggregated from multiple ECHO DFR endpoints.

| # | Call | Purpose | Condition |
|:--|:-----|:--------|:----------|
| 1 | `echo_rest_services.get_facility_info?p_id={id}` | Program flags, TRI totals, RCRA status, facility metadata | always |
| 2 | `dfr_rest_services.get_compliance_summary?p_id={id}` | Per-program compliance status, quarters in violation | always |
| 3 | `dfr_rest_services.get_inspection_enforcement?p_id={id}` | Inspection history, formal actions, penalty amounts | always |
| 4 | `dfr_rest_services.get_air?p_id={id}` | CAA-specific compliance details | only if `AIRFlag='Y'` from step 1 |
| 5 | `dfr_rest_services.get_water?p_id={id}` | CWA/NPDES permit details, effluent violations | only if `CWAFlag='Y'` from step 1 |

Step 1 runs first (it provides flags needed to gate steps 4–5). Steps 2–5 run in parallel after step 1. Use `Promise.allSettled` — a 5xx on step 4 should not prevent returning the core compliance data from steps 1–3.

### `epa_search_facilities` + environmental justice chain

Typical agent chain:
1. `epa_search_facilities(zip_code='98101', has_violation=true)` → list with `RegistryID`, `FacFIPSCode`, `TRIFlag`
2. `epa_search_tri_releases(state='WA', year=2022)` → top chemical emitters in region
3. `epa_get_facility(registry_id)` for highest-emission or highest-penalty facility
4. [External] `census_query_data` using `FacFIPSCode` → demographics of surrounding county
5. [External] `openstreetmap_query_nearby` using `FacLat`/`FacLon` → proximity of schools, hospitals

---

## Design Decisions

**Unified `epa_` prefix, not per-API prefixes.** All tools share `epa_` rather than `echo_`, `tri_`, or `airnow_` prefixes. An agent scanning the tool list sees a coherent environmental data surface, not three sub-server fragments.

**Split TRI into two tools.** The original design had a single `epa_get_tri_releases` that accepted either a facility ID or a state search — two very different query shapes with different outputs. These are now separate tools: `epa_get_tri_releases` (facility-scoped, detailed release breakdown) and `epa_search_tri_releases` (area search, identifies top emitters). Cleaner inputs, clearer use cases.

**`epa_search_violations` vs `epa_get_facility` separation.** `epa_search_violations` is for area-level enforcement discovery (what cases have been filed in WA under RCRA?). `epa_get_facility` includes the enforcement history for a single known facility. The descriptions explicitly cross-reference each other.

**`epa_search_facilities` uses ECHO, not DMAP.** ECHO's `get_facility_info` returns cross-program compliance status in a single call. DMAP's individual program tables require separate queries per program. ECHO is the right API for facility discovery.

**`epa_get_tri_releases` uses DMAP, not ECHO.** ECHO shows TRI totals in facility search results but not per-chemical-per-medium breakdowns. DMAP's `tri.tri_reporting_form` has chemical name, release quantity, and medium for each annual filing.

**Superfund and drinking water via DMAP.** ECHO's CERCLA and SDWA data is summary-level. DMAP's `sems.envirofacts_site` and `sdwis.water_system` tables have the full records.

**`epa_search_superfund` accepts lat/lng + radius.** Superfund proximity searches are a primary use case (is there a Superfund site near my house?). ZIP-only search misses this. The tool accepts either state/city/ZIP or coordinates + radius.

**No `epa_get_air_quality_history` tool.** AirNow's rate limits make bulk historical queries impractical. AirNow itself recommends not using the API to build historical databases. Historical air quality data is better sourced via NOAA or EPA's AQS system. Deferred.

**No GraphQL API.** DMAP offers a GraphQL-like API for more complex queries. Deferred — the REST table service covers all target use cases without the additional query composition complexity.

**Renamed `epa_get_water_systems` to `epa_search_water_systems`.** The verb `get` implies retrieving a single known item by ID. This tool searches across multiple systems. Verb alignment: `search_*` for lists, `get_*` for single items.

---

## Known Limitations

- **AirNow rate limits**: Rate-limited by key per hour. Caching responses at ~1 hour TTL is strongly recommended. Data is preliminary — not valid for regulatory or trend analysis.
- **DMAP column name fragility**: The DMAP REST API requires exact column names in URL paths. Column names differ by table and aren't documented in a machine-readable schema. Verified column names are recorded in the Domain Mapping section above.
- **ECHO geographic scoping required**: Unscoped ECHO searches return millions of rows and time out. All search tools enforce at least one geographic parameter at the input validation layer.
- **TRI data lag**: TRI reporting year N data becomes available approximately Q1 of year N+2. The most recent available year is typically 2 years behind the current calendar year.
- **Superfund proximity requires coordinate conversion**: `epa_search_superfund` with lat/lng + radius cannot be expressed as a single DMAP query (DMAP has no radius filter). Implementation requires fetching a state-filtered result set and computing distances in the service layer, or using a bounding-box approximation.
- **Coordinate encoding inconsistency**: `tri.tri_facility` encodes lat/lng as DDMMSS integers (e.g., `482730` = 48°27'30"); `sems.envirofacts_site` uses decimal degrees. Service layer must handle both formats.
