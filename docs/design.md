# epa-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `epa_search_facilities` | Search EPA-regulated facilities by location, industry, or compliance status across all environmental programs (CAA, CWA, RCRA, TRI, SDWA). Returns facility name, EPA Registry ID, coordinates, county FIPS, per-program compliance flags, inspection counts, penalty totals, and TRI release totals. Registry IDs returned here feed `epa_get_facility`. | `zip_code`, `state`, `city`, `active_only` (boolean), `programs` (enum array: CAA/CWA/RCRA/TRI/SDWA), `has_violation` (boolean), `limit` | `readOnlyHint: true` |
| `epa_get_facility` | Retrieve a full compliance profile for a single EPA-regulated facility: compliance status per regulatory program, inspection dates, formal enforcement actions, penalty amounts, and TRI annual release totals. Aggregates multiple ECHO DFR endpoints in parallel. | `registry_id` | `readOnlyHint: true` |
| `epa_search_violations` | Search EPA civil and criminal enforcement cases by state, regulatory program, or date range. Returns case identifier, regulated facility name and Registry ID, programs involved, penalty assessed, settlement date, and case type (civil/criminal). Designed for area-level violation discovery; for a single facility's enforcement history use `epa_get_facility`. | `state`, `zip_code`, `program` (enum: CAA/CWA/RCRA/SDWA/CERCLA/FIFRA/TSCA), `case_type` (civil/criminal/all), `date_filed_start`, `date_filed_end` (ISO 8601 dates), `limit` | `readOnlyHint: true` |
| `epa_get_air_quality` | Get current AQI observations or the issued AQI forecast for a location. Current mode returns each pollutant's hourly NowCast AQI from the closest monitor within 50 miles, with site and reporting agency; forecast mode returns every issued forecast day with category, action-day flag, and the agency discussion. Output credits the agencies and the U.S. EPA AirNow program. Data is preliminary — suitable for awareness and informational use, not regulatory decisions. | `zip_code` OR `latitude`+`longitude`, `mode` (enum: `current`/`forecast`), `forecast_date` (optional ISO 8601 date, forecast mode only; filters the forecast to one valid date) | `readOnlyHint: true` |
| `epa_get_tri_releases` | Query Toxic Release Inventory annual chemical release data for a specific facility. Returns per-chemical release quantities by medium (air, water, land, underground injection) and reporting year. TRI data lags ~18 months — the most recent available year is typically 2 years prior to the current calendar year. | `facility_id` (15-character TRI facility ID — the `facilityId` from `epa_search_tri_releases`; a 12-digit FRS Registry ID matches nothing), `year` (optional; defaults to all available years), `chemical_name` (optional filter) | `readOnlyHint: true` |
| `epa_search_tri_releases` | Search Toxic Release Inventory data across facilities in a state or county for a given year. Returns facility name and county, TRI facility ID, chemical name, and the one-time/non-routine quantity; `include_release_breakdown` adds routine releases by medium (air, water, land, underground injection) from one extra `tri.tri_release_qty` request. Use to identify top polluters in an area or build an environmental exposure profile. | `state`, `county` (optional; bare name, trailing County/Parish/Borough dropped; partial match, so `LAKE` also matches `LAKE OF THE WOODS` — each record's `countyName` says which), `year` (optional), `chemical_name` (optional), `limit`, `include_release_breakdown` (boolean, default false) | `readOnlyHint: true` |
| `epa_search_superfund` | Search Superfund (CERCLA/SEMS) sites by location or NPL listing status. Returns site name, EPA ID, NPL status (listed/not listed/removed), cleanup status, coordinates, and county FIPS. Accepts either state/city/ZIP or a lat/lng + radius for proximity searches. | `state`, `city`, `zip_code` OR `latitude`+`longitude`+`radius_miles`, `npl_status` (listed/not-listed/proposed/all), `limit` | `readOnlyHint: true` |
| `epa_search_water_systems` | Search drinking water systems (SDWIS) by state or ZIP code. Returns system name, PWSID, population served, primary water source, and activity status. With `has_violation`, returns only systems with an open (unresolved) violation, by state or ZIP. | `state`, `zip_code`, `has_violation` (boolean), `pws_type` (enum: community/non-transient/transient), `limit` | `readOnlyHint: true` |

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
- **Drinking water safety**: `epa_search_water_systems` (by state, or by the ZIP of a system's address of record) with `has_violation` → identify systems with open violations

ECHO and Envirofacts/DMAP are US federal government data (public domain, 17 USC §105) and require no authentication. AirNow requires a free API key, and redistribution follows the [AirNow Data Exchange Guidelines](https://docs.airnowapi.org/docs/DataUseGuidelines.pdf): credit the reporting agency and EPA AirNow, mark observations preliminary, pass values, forecasts, and advisories unaltered, and register the product with AirNow (signed form to dmc@airnowtech.org).

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
| `AIRNOW_API_KEY` | No | AirNow API key; enables `epa_get_air_quality` (not registered without it). Free registration at https://docs.airnowapi.org/account/request/ |
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
12. `epa_search_water_systems` (DMAP `sdwis.water_system` + `sdwis.violation`)
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
- `TRIReleasesTransfers` — total TRI on/off-site releases in lbs (summary; for per-chemical detail, call `epa_get_tri_releases` with the TRI facility ID from `epa_search_tri_releases`; `epa_search_facilities` returns no TRI facility ID)

### Envirofacts DMAP REST

| Noun | Operations | Table(s) |
|:-----|:-----------|:---------|
| TRI Facility | filter by state/county, joined to its reporting forms in one request | `tri.tri_facility` |
| TRI Release | get by `tri_facility_id` and/or year; per-medium quantities by `doc_ctrl_num` | `tri.tri_reporting_form`, `tri.tri_release_qty` |
| Superfund Site | search by state/NPL status | `sems.envirofacts_site` |
| Drinking Water System | search by state or ZIP; open violators by `pwsid in` over a state's open violation rows, or over a ZIP's systems | `sdwis.water_system`, `sdwis.violation` |

URL format: `https://data.epa.gov/dmapservice/{schema}.{table}/{column}/{operator}/{value}/[{first}:{last}]`
Operators: `equals`, `notEquals`, `lessThan`, `greaterThan`, `beginsWith`, `contains`, `in`
Combine filters: `/and/` or `/or/`
Join: `…/{filters}/join/{schema}.{table}/{leftColumn}/equals/{rightColumn}/and/{filters}/{first}:{last}` is an inner join. Filters before `join` bind to the first table only (DMAP rejects a column that table lacks: `The column, tri.tri_facility.reporting_year does not exist`); filters after the join comparison bind to the joined table; the range counts joined rows, returned in first-table order with both tables' columns.
Default format: JSON. Append `/csv` etc. for other formats.
Max timeout: 15 minutes. Paginate with positional `first:last`: rows are 1-based and inclusive (`1:50` is 50 rows), and a `first` of 0 reads as row 1, so `0:49` returns 49.

**Verified column names** (probing revealed several obvious guesses are wrong):

| Table | Correct column | Notes |
|:------|:--------------|:------|
| `tri.tri_facility` | `state_abbr` | State filter |
| `tri.tri_facility` | `county_name` | County filter (`contains`, case-insensitive). Bare names (`KING`, never `KING COUNTY`); some states also store a suffixed form (`CALCASIEU PARISH`, `FAIRBANKS NORTH STAR BORO`). There is no `county` column |
| `tri.tri_facility` | `tri_facility_id` | Primary key, join to `tri.tri_reporting_form` |
| `tri.tri_reporting_form` | `tri_facility_id` | Join from `tri_facility` |
| `tri.tri_reporting_form` | `reporting_year` | Year filter (string: `"2022"`) |
| `tri.tri_reporting_form` | `tri_chem_id` | Chemical or category ID; `N150` (dioxin and dioxin-like compounds) is reported in grams |
| `sems.envirofacts_site` | `fk_ref_state_code` | State filter |
| `sems.envirofacts_site` | `npl_status_code` | `"N"` = not listed, `"NPL"` = listed |
| `sems.envirofacts_site` | `site_id` | Primary key |
| `sdwis.water_system` | `primacy_agency_code` | 2-letter state code |
| `sdwis.water_system` | `pws_type_code` | `CWS`/`NTNCWS`/`TNCWS` |
| `sdwis.water_system` | `pwsid` | Primary key |
| `sdwis.violation` | `compliance_status_code` | `K` / `O` open; `R` returned to compliance; `I` closed out at system deactivation |

Note: DMAP coordinate encoding varies by table. `sems.envirofacts_site` uses decimal degrees (`primary_latitude_decimal_val`). `tri.tri_facility` uses integer DDMMSS (`fac_latitude: 482730` = 48°27'30"N) — no tool returns TRI facility coordinates; convert before exposing them.

### AirNow

| Noun | Operations | Endpoint |
|:-----|:-----------|:---------|
| Current Observation | by ZIP or lat/lng | `/observation/current/ziplatlong/?zipCode={zip}` or `?latitude={lat}&longitude={lon}` |
| Forecast | by ZIP or lat/lng | `/forecast/current/?zipCode={zip}` or `?latitude={lat}&longitude={lon}` |

Both take `format=application/json&API_KEY={key}`. AirNow retired the `observation/zipCode/current/`, `observation/latLong/current/`, `forecast/zipCode/`, and `forecast/latLong/` services on 2026-10-01 (HTTP 410). The replacements ignore `distance` (observations use a fixed 50-mile lookup boundary) and `date` (the forecast returns every issued day), so the tool takes neither and filters `forecast_date` locally against `dateValid`. One cache entry per location serves every `forecast_date`.

An observation is one record per pollutant from the closest monitor, so one reporting area can draw pollutants from different sites. There is no category number, coordinates, or `stateCode`; the tool derives `categoryNumber` from `aqiCategoryName`:
```json
{
  "dateObserved": "2026-10-08",
  "hourObserved": "03:00",
  "localTimeZone": "PDT",
  "reportingAreaName": "Seattle-Bellevue-Kent Valley",
  "siteID": "530330030",
  "siteName": "Seattle-10th & Weller",
  "parameterName": "PM2.5",
  "nowcastAQI": 62,
  "aqiCategoryName": "Moderate",
  "reportingAgency": "Washington Department of Ecology",
  "lookupBehavior": "Closest Reading By Pollutant",
  "consideredMonitors": "All",
  "lookupBoundary": "50 Miles"
}
```

A forecast is one record per pollutant per `dateValid`. `aqi` is `-1` when the agency forecasts a category only; the tool omits `aqi` there rather than reporting `-1`. `discussion` repeats on every row of an area (often empty) and is passed through once per area, verbatim:
```json
{
  "dateIssue": "2026-10-07",
  "dateValid": "2026-10-08",
  "reportingArea": "Seattle-Bellevue-Kent Valley",
  "reportingAreaCode": "wa004",
  "stateCode": "WA",
  "parameterName": "PM2.5",
  "aqi": 39,
  "forecastAgency": "Puget Sound Clean Air Agency",
  "categoryNumber": 1,
  "categoryName": "Good",
  "actionDay": false,
  "discussion": "For Oct 7-12 (Wed-Mon): Expect GOOD to MODERATE air quality through early next week."
}
```

When AirNow has no data for a location it answers HTTP 200 with `{"WebServiceError":[{"Message":"…"}]}` (no monitors within 50 miles, no reporting area, no forecast issued); the tool returns an empty result that relays the message. Any other non-array body is an error. An invalid ZIP is HTTP 400 `Invalid zipCode provided`, surfaced as `invalid_zip_code`.

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

**`epa_get_tri_releases` uses DMAP, not ECHO.** ECHO shows TRI totals in facility search results but not per-chemical-per-medium breakdowns. DMAP's `tri.tri_reporting_form` has the chemical name and reporting year of each annual filing, and `tri.tri_release_qty` its per-medium quantities, joined on `doc_ctrl_num`.

**`epa_search_tri_releases` is one joined request.** `tri.tri_reporting_form` carries no state or county column, so the search joins it to `tri.tri_facility` in one DMAP URL: state and county filters on the facilities, year and chemical filters on the forms, and `1:limit` over the joined rows. The earlier design walked the state's facilities 50 at a time, two requests per batch, until `limit` records turned up — a sparse filter in a large state never stopped (`TX`, 2022, limit 200 ran past 400 seconds; `WA`, 2022, limit 200 took 20 requests and 30 seconds). Joined, those take one request: about 5 seconds for Texas and 4 for Washington, and the plain `WA` search drops from two requests to one. A bounded walk with a partial-scan notice was the alternative; the join returns every match in the state without one.

**The per-medium breakdown is opt-in on `epa_search_tri_releases`.** It costs one batched `tri.tri_release_qty` request after the search request. That request takes about 20 seconds when DMAP has not cached it (about 1 second when it has), against a 2–5 second search, so `include_release_breakdown` defaults to false and its description states the cost.

**Dioxin quantities are converted from grams to pounds.** EPA's TRI program has facilities report dioxin and dioxin-like compounds (TRI chemical ID `N150`) in grams and every other chemical in pounds (TRI Basic Data Files documentation, `UNIT_OF_MEASURE`). DMAP's `tri.tri_reporting_form` and `tri.tri_release_qty` carry no unit column, so `tri_chem_id = N150` is the marker on their rows (`tri.tri_chem_info.unit_of_measure` records `Grams` for N150, the only gram-reported chemical). The TRI tools divide those quantities by 453.59237 and set `reportedUnit: "grams"` on the record, rather than passing grams through: every quantity field is named and described in pounds, and an agent summing or ranking releases across chemicals would otherwise mix units. The marker lets a reader reconcile the value with EPA's gram figures. Per-medium sums and conversions are rounded to 12 significant digits, the precision `formatLbs` renders, so both output surfaces carry the same number.

**`has_violation` on `epa_search_water_systems` reads a bounded slice of `sdwis.violation`.** `sdwis.water_system` has no violation flag, so with `state` alone the tool reads the first 1,000 open violation rows for the state and looks up the systems they name, 200 PWSIDs per `pwsid in` request, stopping once `limit` is filled — at most six requests. A state's full violation table is far larger (Washington's exceeds 15,000 rows, at 10–25 seconds per 5,000-row page; its open rows alone number about 4,800), so reading all of it is unbounded; a scan that reaches 1,000 rows says so in an enrichment `notice` instead.

**A water system's ZIP is its address of record.** `sdwis.water_system.zip_code`, like its `state_code`, is the owner's or operator's address, not the service area: ZIP 98104 (Seattle) returns Alaska and Montana systems run from Seattle offices. The `zip_code` input says so rather than promising a geographic search.

**A ZIP's violation check runs by PWSID.** `sdwis.violation` has no ZIP column, so a `zip_code` search (with or without `state`) reads the ZIP's systems first — up to 1,000, one request — and asks `sdwis.violation` for their open rows 200 PWSIDs at a time, stopping once `limit` is filled: at most six requests. Measured ZIPs hold far fewer systems (98104: 8, 98382: 109, 59901: 194), so a typical check is two requests of about 3–4 seconds each. Either read that fills its 1,000-row cap adds a `notice`. This was chosen over rejecting a ZIP-only `has_violation` call because the PWSID check is exact and stays within the state scan's request budget.

**`has_violation` means an open violation.** `sdwis.violation.compliance_status_code` carries four values in live data: K and O have no `rtc_date` (unresolved); R has an `rtc_date` and a resolving enforcement (returned to compliance, back to 2004 in Washington); I has an `rtc_date` equal to the system's `pws_deactivation_date` (closed out when the system was deactivated). Of Washington's first 1,000 violation rows, 819 were R and 73 were I. Both violation reads filter `compliance_status_code in (K, O)`, so a resolved violation never marks a system.

**Superfund and drinking water via DMAP.** ECHO's CERCLA and SDWA data is summary-level. DMAP's `sems.envirofacts_site` and `sdwis.water_system` tables have the full records.

**`epa_search_superfund` accepts lat/lng + radius.** Superfund proximity searches are a primary use case (is there a Superfund site near my house?). ZIP-only search misses this. The tool accepts either state/city/ZIP or coordinates + radius.

**No `epa_get_air_quality_history` tool.** AirNow's rate limits make bulk historical queries impractical. AirNow itself recommends not using the API to build historical databases. Historical air quality data is better sourced via NOAA or EPA's AQS system. Deferred. AirNow's 2026 services add daily reporting-area history by state (from July 2017) and site-level daily data by bounding box, which removes the rate-limit objection but not the rest: the Data Exchange Guidelines bar AirNow data from trend analysis and point to AQS for validated history, so historical tools belong to an AQS integration (`epa_aqs_*`), not to AirNow.

**No GraphQL API.** DMAP offers a GraphQL-like API for more complex queries. Deferred — the REST table service covers all target use cases without the additional query composition complexity.

**Renamed `epa_get_water_systems` to `epa_search_water_systems`.** The verb `get` implies retrieving a single known item by ID. This tool searches across multiple systems. Verb alignment: `search_*` for lists, `get_*` for single items.

---

## Known Limitations

- **AirNow rate limits**: Rate-limited by key per hour. Caching responses at ~1 hour TTL is strongly recommended. Data is preliminary — not valid for regulatory or trend analysis.
- **DMAP column name fragility**: The DMAP REST API requires exact column names in URL paths. Column names differ by table and aren't documented in a machine-readable schema. Verified column names are recorded in the Domain Mapping section above.
- **ECHO geographic scoping required**: Unscoped ECHO searches return millions of rows and time out. All search tools enforce at least one geographic parameter at the input validation layer.
- **TRI data lag**: TRI reporting year N data becomes available approximately Q1 of year N+2. The most recent available year is typically 2 years behind the current calendar year.
- **Superfund proximity requires coordinate conversion**: `epa_search_superfund` with lat/lng + radius cannot be expressed as a single DMAP query (DMAP has no radius filter). Implementation requires fetching a state-filtered result set and computing distances in the service layer, or using a bounding-box approximation.
- **Coordinate encoding inconsistency**: `tri.tri_facility` encodes lat/lng as DDMMSS integers (e.g., `482730` = 48°27'30"); `sems.envirofacts_site` uses decimal degrees. Only the SEMS coordinates are exposed today; a tool that returns TRI facility coordinates must convert DDMMSS first.
