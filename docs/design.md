# epa-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `epa_echo_search_facilities` | Search EPA-regulated facilities by location, program, or compliance status across CAA, CWA, RCRA, TRI, and SDWA. Returns facility name, EPA Registry ID, coordinates, county FIPS, per-program registration flags, five-year inspection and penalty totals, and TRI release totals. Registry IDs returned here feed `epa_echo_get_facility`. | `zip_code`, `state`, `city` (prefix match), `latitude`+`longitude`+`radius_miles`, `active_only` (boolean), `programs` (enum array of at most one: CAA/CWA/RCRA/TRI/SDWA), `has_violation` (boolean: a program in significant noncompliance), `limit` | `readOnlyHint: true` |
| `epa_echo_get_facility` | Retrieve a full compliance profile for a single EPA-regulated facility: the facility-level compliance status, a per-statute compliance summary, the newest 100 compliance monitoring records and five years of formal enforcement actions with penalties, the latest TRI release total, and the facility's TRI facility IDs. Built from one ECHO `get_dfr` response plus a best-effort facility search row. | `registry_id` | `readOnlyHint: true` |
| `epa_echo_search_violations` | Search EPA civil and criminal enforcement cases by state, ZIP code, regulatory program, case type, or filing-date range. Returns case identifier, programs involved, penalty assessed, settlement and filing dates, and case category. Designed for area-level violation discovery; for a single facility's enforcement history use `epa_echo_get_facility`. | `state`, `zip_code`, `program` (enum: CAA/CWA/RCRA/SDWA/CERCLA/FIFRA/TSCA; matches any cited law), `case_type` (civil/criminal/all), `date_filed_start`, `date_filed_end` (YYYY-MM-DD, inclusive, civil cases only; `criminal` with a date is rejected), `limit` | `readOnlyHint: true` |
| `epa_airnow_get_conditions` | Get current AQI observations or the issued AQI forecast for a location. Current mode returns each pollutant's hourly NowCast AQI from the closest monitor within 50 miles, with site and reporting agency; forecast mode returns every issued forecast day with category, action-day flag, and the agency discussion. Output credits the agencies and the U.S. EPA AirNow program. Data is preliminary — suitable for awareness and informational use, not regulatory decisions. | `zip_code` OR `latitude`+`longitude`, `mode` (enum: `current`/`forecast`), `forecast_date` (optional ISO 8601 date, forecast mode only; filters the forecast to one valid date) | `readOnlyHint: true` |
| `epa_tri_get_facility_releases` | Query Toxic Release Inventory annual chemical release data for a specific facility. Returns per-chemical release quantities by medium (air, water, land, underground injection) and reporting year. TRI data lags ~18 months — the most recent available year is typically 2 years prior to the current calendar year. | `facility_id` (15-character TRI facility ID — the `facilityId` from `epa_tri_search_releases` or an entry of `epa_echo_get_facility` `triFacilityIds`; a 12-digit FRS Registry ID matches nothing), `year` (optional; defaults to all available years), `chemical_name` (optional filter) | `readOnlyHint: true` |
| `epa_tri_search_releases` | Search Toxic Release Inventory data across facilities in a state or county, for one reporting year or, without `year`, every available year newest first. Returns facility name and county, TRI facility ID, chemical name, and the one-time/non-routine quantity; `include_release_breakdown` adds routine releases by medium (air, water, land, underground injection) from one extra `tri.tri_release_qty` request. Use to identify top polluters in an area or build an environmental exposure profile. | `state`, `county` (optional; bare name, trailing County/Parish/Borough dropped; partial match, so `LAKE` also matches `LAKE OF THE WOODS` — each record's `countyName` says which), `year` (optional; omitted, records come newest reporting year first), `chemical_name` (optional), `limit`, `include_release_breakdown` (boolean, default false) | `readOnlyHint: true` |
| `epa_superfund_search_sites` | Search Superfund (CERCLA/SEMS) sites by location or NPL listing status. Returns site name, EPA ID, NPL status (listed/not listed/proposed), cleanup status, coordinates, and county FIPS. Accepts either state/city/ZIP or a lat/lng + radius for proximity searches. | `state`, `city`, `zip_code` OR `latitude`+`longitude`+`radius_miles`, `npl_status` (listed/not-listed/proposed/all), `limit` | `readOnlyHint: true` |
| `epa_water_search_systems` | Search drinking water systems (SDWIS) by state or ZIP code. Returns system name, PWSID, population served, primary water source, and activity status. With `has_violation`, returns only systems with an open (unresolved) violation, by state or ZIP. | `state`, `zip_code`, `has_violation` (boolean), `pws_type` (enum: community/non-transient/transient), `limit` | `readOnlyHint: true` |
| `epa_ejscreen_get_scores` | Get EJScreen environmental-justice indicators for a point and buffer: 13 environmental and 6 demographic indicators with national and state percentiles and EJ Index values, plus the Demographic and Supplemental Demographic Indices. EJScreen v2.2 (2022) from the community-maintained EJAM API, not a live EPA endpoint; a point outside US coverage returns a coverage note. | `latitude`, `longitude`, `distance` (default 1; miles-equivalent ≤ 15), `unit` (miles/kilometers) | `readOnlyHint: true` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `epa://facility/{registry_id}` | Full compliance profile for a facility by EPA Registry ID (same data as `epa_echo_get_facility`) | No |
| `epa://superfund/{site_id}` | Superfund site record by SEMS site ID | No |

### Prompts

None. This server is data-oriented.

---

## Overview

`epa-mcp-server` exposes EPA environmental data across four complementary systems — ECHO (facility compliance), Envirofacts/DMAP (TRI chemical releases, Superfund, drinking water), AirNow (real-time air quality), and EJScreen v2.2 through the community-maintained EJAM API (environmental-justice screening) — as a unified "environmental data" tool surface. Tools are designed around agent workflows, not API boundaries.

Target agent workflows:
- **Facility compliance audit**: `epa_echo_search_facilities` → `epa_echo_get_facility` → `epa_echo_search_violations`
- **Environmental justice analysis**: `epa_echo_search_facilities` (by ZIP) → `epa_tri_search_releases` (by state/county) → chain `fipsCode` to Census API for demographics
- **Air quality check**: `epa_airnow_get_conditions` (current) → `epa_airnow_get_conditions` (forecast)
- **Superfund proximity**: `epa_superfund_search_sites` (lat/lng + radius) → `epa_echo_get_facility` if responsible party is still regulated
- **Drinking water safety**: `epa_water_search_systems` (by state, or by the ZIP of a system's address of record) with `has_violation` → identify systems with open violations

ECHO and Envirofacts/DMAP are US federal government data (public domain, 17 USC §105) and require no authentication. AirNow requires a free API key, and redistribution follows the [AirNow Data Exchange Guidelines](https://docs.airnowapi.org/docs/DataUseGuidelines.pdf): credit the reporting agency and EPA AirNow, mark observations preliminary, pass values, forecasts, and advisories unaltered, and register the product with AirNow (signed form to dmc@airnowtech.org).

---

## Requirements

- Read-only access to three EPA APIs — ECHO (`echodata.epa.gov`), Envirofacts DMAP (`data.epa.gov`), AirNow (`www.airnowapi.org`) — plus the EJAM API (`api.ejanalysis.com`), which rehosts EJScreen
- AirNow requires `AIRNOW_API_KEY` (free registration at docs.airnowapi.org); ECHO, DMAP, and EJAM are unauthenticated
- AirNow rate limits by key per hour — responses should be cached for ~1 hour TTL
- No write operations; all tools are read-only
- Cannot imply EPA endorsement in output
- AirNow data is preliminary — not for regulatory, trend, or enforcement purposes (stated in descriptions)
- ECHO searches must always include at least one geographic filter (state, ZIP, or city) — unscoped searches return millions of rows and time out

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `EchoService` | ECHO REST API (`echodata.epa.gov/echo/`) | `epa_echo_search_facilities`, `epa_echo_get_facility`, `epa_echo_search_violations` |
| `DmapService` | Envirofacts DMAP REST API (`data.epa.gov/dmapservice/`) | `epa_tri_get_facility_releases`, `epa_tri_search_releases`, `epa_superfund_search_sites`, `epa_water_search_systems` |
| `AirNowService` | AirNow API (`www.airnowapi.org/aq/`) | `epa_airnow_get_conditions` |
| `EjscreenService` | EJAM API (`api.ejanalysis.com`), a community rehost of EJScreen v2.2 | `epa_ejscreen_get_scores` |

### Request deadlines

Every tool call runs under one wall-clock budget shared by every request it makes and every retry and backoff of each, so it ends with this server's own error before the 60-second default request timeout of MCP SDK clients. Each `withRetry` gets what is left of the budget as `deadlineMs` and passes its attempt signal to `fetch`, so the budget also stops a request in flight. An expired budget fails the call as `Timeout` with `data.reason: 'retry_deadline_exceeded'`. Caller cancellation still surfaces as cancellation, never as a timeout or a partial result. This table is the one record of every budget:

| Call | Budget | Requests it covers | Successful latency, measured live 2026-10-16 |
|:--|:--|:--|:--|
| `epa_echo_search_facilities` | 58 s | `get_facility_info`, then the `get_qid` page with what remains | ZIP 98108: 0.5–1.4 s; `p_st=CA` (986,998 rows): 39–42 s; 100 mi around Houston: 42 s; `p_ct=Los Angeles` (40,471 rows): 53.8–56.7 s (45.6 s + 11.1 s at the top) |
| `epa_echo_search_violations` | 58 s | `get_case_info`, then the `get_qid` page with what remains | ZIP 98108: 1.1 s; `p_state=CA`: 3.6 s; `p_state=CA` filed since 2000: 4.3 s; `p_state=WA` filed in 2024: 2.5 s |
| `epa_echo_get_facility`, `epa://facility/{registry_id}` | 50 s | `get_dfr`, then the best-effort `p_frs` row with what remains, capped at 10 s and two attempts | registry `110017848105`: 0.9–1.1 s |
| `epa_tri_get_facility_releases`, `epa_tri_search_releases`, `epa_superfund_search_sites`, `epa_water_search_systems`, `epa://superfund/{site_id}` | 50 s per `DmapService` call | the TRI forms request or join and its breakdown chunks; up to three pages for a non-proximity wildcarded text filter; every Superfund proximity prefix page; a ZIP's system read and up to five violation checks, or a state's violation scan and system lookups | WA 2022 TRI search: 2.7 s, 19.2 s with an uncached breakdown; Boeing Field TRI history (375 forms, two chunks): 8.5 s; facility `77506RPRDC1423H`, 2024, `chemical_name` `Chromium compounds (except for chromite`, uncached: 48.6 s (forms 31.8 s, breakdown 16.8 s), 1.7 s repeated; Superfund WA listed: 3.1 s; WA `has_violation`: 2.8 s; ZIP 98104 `has_violation`: 1.8 s |
| `epa_airnow_get_conditions` | 55 s | one AirNow request (a cached answer makes none) | 0.3 s |
| `epa_ejscreen_get_scores` | 55 s | one EJAM `POST /data` | 2.8–6.3 s up to a 15-mile buffer; 17.6 s for the session's first request |

The two ECHO searches and every `DmapService` call share one budget mechanism (`src/services/call-budget.ts`) that restates an expired budget as one Timeout naming the call and how to narrow it, since the framework's message would report only the expiring request's remaining milliseconds: `ECHO did not finish the facility search within 58 seconds. Narrow it with zip_code instead of city or state, …`, `DMAP did not finish the TRI release lookup within 50 seconds. Narrow it with year or chemical_name, or call again later.` The TRI search names `year`, `county`, `chemical_name`, and leaving `include_release_breakdown` off; the Superfund search `zip_code`, `city`, or `npl_status`; the water-system search `zip_code` or `pws_type`; a Superfund site lookup by ID only says to call again later. AirNow, EJAM, and `epa_echo_get_facility` keep the framework's message, which names the expiring request's operation and deadline (`AirNow request exceeded its 55000ms retry deadline after 1 attempt.`): each makes one request with no filter left to narrow. `EchoService.fetchJson` requires `deadlineMs`, so an ECHO request cannot be added without a budget.

**Decision: 58 seconds for the ECHO searches.** A legitimate `p_ct=Los Angeles` facility search takes 53.8–56.7 s; a 55-second budget would turn the slower runs into Timeouts, and 58 s keeps them while still answering before the client's 60-second cutoff. The cost is transport margin: a hung ECHO search fails 2 s before the client gives up, not 5.

**Decision: 55 seconds for AirNow and EJAM, 50 for `epa_echo_get_facility` and DMAP.** AirNow, EJAM, and `epa_echo_get_facility` finish far inside their budgets (slowest measured: 17.6 s), so a longer budget would rescue no answer and would only spend transport margin while an upstream hangs. DMAP can reach its budget: an uncached `epa_tri_get_facility_releases` with a punctuated `chemical_name` took 48.6 s, a 31.8 s forms request followed by a 16.8 s breakdown. DMAP caches both, so the same call repeated took 1.7 s, and an expiry names `year` and `chemical_name` as the levers that shrink the forms request.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `AIRNOW_API_KEY` | No | AirNow API key; enables `epa_airnow_get_conditions` (not registered without it). Free registration at https://docs.airnowapi.org/account/request/ |
| `EPA_ECHO_BASE_URL` | No | ECHO API base URL (default: `https://echodata.epa.gov/echo`) |
| `EPA_DMAP_BASE_URL` | No | DMAP API base URL (default: `https://data.epa.gov/dmapservice`) |
| `EPA_AIRNOW_BASE_URL` | No | AirNow API base URL (default: `https://www.airnowapi.org/aq`) |
| `EJSCREEN_API_BASE_URL` | No | EJAM API base URL for `epa_ejscreen_get_scores` (default: `https://api.ejanalysis.com`) |

---

## Implementation Order

1. Config and server setup (`AIRNOW_API_KEY`, base URLs)
2. `EchoService` — facility search, facility detail, enforcement cases
3. `DmapService` — DMAP REST table queries (TRI, SEMS, SDWIS)
4. `AirNowService` — current/forecast observations by ZIP and lat/lng
5. `epa_echo_search_facilities` (ECHO `get_facility_info`)
6. `epa_echo_get_facility` (ECHO `dfr_rest_services.get_dfr` plus a `get_facility_info?p_frs` status row)
7. `epa_echo_search_violations` (ECHO `case_rest_services`)
8. `epa_airnow_get_conditions` (AirNow current + forecast)
9. `epa_tri_get_facility_releases` (DMAP `tri.tri_reporting_form` by `tri_facility_id`)
10. `epa_tri_search_releases` (DMAP `tri.tri_facility` + `tri.tri_reporting_form` join by state)
11. `epa_superfund_search_sites` (DMAP `sems.envirofacts_site`)
12. `epa_water_search_systems` (DMAP `sdwis.water_system` + `sdwis.violation`)
13. `EjscreenService` and `epa_ejscreen_get_scores` (EJAM `POST /data`)
14. Resources (facility and superfund URI handlers)

Each step is independently testable.

---

## Domain Mapping

### ECHO (Enforcement and Compliance History Online)

| Noun | Operations | Endpoint |
|:-----|:-----------|:---------|
| Facility | search (by geo/program/compliance) | `echo_rest_services.get_facility_info` |
| Facility | get detail (all programs) | `dfr_rest_services.get_dfr`, plus `echo_rest_services.get_facility_info?p_frs=` for the facility-level status |
| Enforcement Case | search (civil + criminal) | `case_rest_services.get_case_info` |

Both searches are two requests: `get_facility_info` / `get_case_info` returns the match count and a `QueryID`, and `get_qid?qid=…&pageno=1` returns the first `responseset` rows (a one-row facility match comes back inline, with no `get_qid`). Neither has a row ceiling: a state-wide facility search (`p_st=WA`, 101,808 rows) takes about 2.7 s plus 1.5 s for the page, and a nationwide case search returns 312,945 rows (the queryset limit belongs to `get_facilities`; see the error table below).

ECHO runs a search without any parameter it does not recognize, and leaves that parameter out of `Results.QueryParameters`; a value it ignores is still echoed (`p_med=A,W`, `p_qiv=Y`). Both searches compare the sent `p_*` names against `QueryParameters` and fail with a non-retryable InternalError naming any that are missing (`data.droppedParameters`), so a renamed or retired parameter can never silently widen a search. Names only: ECHO also lists defaults it was not sent (`p_name_type=ANY`, `mapset`) and reformats values (`p_radius=0.5` as `.5`).

`get_facility_info` parameters `epa_echo_search_facilities` sends (ECHO OpenAPI: `swaggerx.swagger_json?p_prefix=ECHO`):
- `p_zip` — ZIP code
- `p_st` — state abbreviation (`p_state` is not a facility-search parameter: it is dropped and the search runs nationwide)
- `p_ct` — city, case-insensitive prefix match (`SEAT` matches SEATTLE and SEATAC)
- `p_lat` / `p_long` / `p_radius` — proximity, radius up to 100 miles
- `p_act=Y` — facilities with an active permit
- `p_cs=3` — facilities with one or more programs in significant noncompliance (`2` is any noncompliance, `4` more than one program in SNC)
- `p_med` — one media code: `A` air, `W` water, `R` RCRA, `T` TRI, `S` SDWA (also `E`, `M`, `C`, `G`, `TSCA`, `ALL` = air and water and RCRA). A comma list is echoed but not applied
- `responseset` — rows per page (≤ 1,000)
- `qcolumns` — the column IDs each row carries (`echo_rest_services.metadata`), sent to both `get_facility_info` and `get_qid`; the default row has no coordinates, program flags, or inspection and penalty counts

Output fields per facility row, by `qcolumns` name:
- `RegistryID` — EPA FRS Registry ID (the join key to `dfr_rest_services.get_dfr` and `get_facility_info?p_frs`)
- `FacComplianceStatus` — overall compliance text
- `FacCounty`, `FacFIPSCode` (falling back to `FacDerivedStctyFIPS`, the FIPS ECHO derives from the coordinates) — county and 5-digit county FIPS
- `FacLat` / `FacLong` — decimal degrees
- `AIRFlag` / `NPDESFlag` / `RCRAFlag` / `SDWISFlag` — `Y` exactly on the rows `p_med` `A` / `W` / `R` / `S` selects; TRI registration is a non-null `TRIIDs`, the rows `p_med=T` selects (`TRIFlag` marks current reporters only: 12 of 45 TRI facilities in ZIP 98108)
- `FacInspectionCount`, `FacTotalPenalties` — five-year totals across programs (registry 110017848105: 11 inspections and $1,750, the sums of its `get_dfr` five-year summaries)
- `TRIReleasesTransfers` — TRI on/off-site releases and transfers in lbs for the latest TRI year (summary; for per-chemical detail, call `epa_tri_get_facility_releases` with the TRI facility ID from `epa_tri_search_releases` or `epa_echo_get_facility` `triFacilityIds`; `epa_echo_search_facilities` returns no TRI facility ID)

`get_case_info` parameters `epa_echo_search_violations` sends (`swaggerx.swagger_json?p_prefix=CASE`):
- `p_state` — case location state
- `p_fac_zip` — facility ZIP (`p_zip` is dropped)
- `p_law` — one statute code; matches any law a case cites, so `programsViolated` (the case's primary law) can differ
- `p_civil_criminal_indicator` — `CI` civil, `CR` criminal; not sent for `all`
- `p_from_date` / `p_to_date` (MM/DD/YYYY) with `p_milestone=CMF,CPOA` — bounds `DateFiled`, both ends inclusive. ECHO requires both dates (one alone is an HTTP 200 error), so an open end reads `01/01/1900` or today (UTC); each end is clamped to that span, and a range that clamps empty (a start after today, an end before 1900) returns no cases without a request, since ECHO answers an inverted range with the in-band error `From_date must be earlier than or equal to to_date.` rather than an empty result. The dates alone match any case milestone (WA 2024: 303 cases, versus 87 filed in 2024); the two filing milestones are civil-only, so a date-bounded search returns no criminal case

ECHO reports a failed query as HTTP 200 with `{"Results":{"Error":{"ErrorMessage":"…"}}}`. `EchoService.fetchJson` classifies the message; HTTP 5xx keeps the framework's status classification and is retried.

| `ErrorMessage` | Endpoints | Classification |
|:--|:--|:--|
| `ID <id> is invalid.` | `get_dfr` | NotFound, not retried; `getFacility` rethrows it as `facility_not_found` with `registryId` |
| `QueryID <n> not found in ECHO.` | facility and case `get_qid` | ServiceUnavailable with `data.retryable: false`, not retried |
| anything else | any | retryable ServiceUnavailable |

A TRI or RCRA program ID is a valid `get_dfr` `p_id` that resolves to its Registry ID, so it is not a not-found case.

**Decision: no classification for the queryset-limit message.** `Rows Returned would be <n>. Queryset Limit would be exceeded…` comes only from `get_facilities` (`p_st=CA`: 986,998 rows), which no tool calls; the same state through `get_facility_info` answers in 39–42 s. A reason for it would be a contract entry no tool can reach; should ECHO ever send it to a search, it surfaces as a retryable ServiceUnavailable carrying ECHO's text.

### Envirofacts DMAP REST

| Noun | Operations | Table(s) |
|:-----|:-----------|:---------|
| TRI Facility | filter by state/county, joined to its reporting forms in one request | `tri.tri_facility` |
| TRI Release | get by `tri_facility_id` and/or year; per-medium quantities by `doc_ctrl_num` | `tri.tri_reporting_form`, `tri.tri_release_qty` |
| Superfund Site | search by state, city, ZIP, or NPL status | `sems.envirofacts_site` |
| Drinking Water System | search by state or ZIP; open violators by `pwsid in` over a state's open violation rows, or over a ZIP's systems | `sdwis.water_system`, `sdwis.violation` |

URL format: `https://data.epa.gov/dmapservice/{schema}.{table}/{column}/{operator}/{value}[/sort/{schema}.{table}.{column}:{asc|desc},…]/[{first}:{last}]/json`
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

### `epa_echo_get_facility` (2 upstream calls, sequential)

| # | Call | Purpose | Condition |
|:--|:-----|:--------|:----------|
| 1 | `dfr_rest_services.get_dfr?p_id={id}` | The whole profile (see the field map below) | always |
| 2 | `echo_rest_services.get_facility_info?p_frs={RegistryID}` | `FacComplianceStatus` → `complianceStatus`, `FacQtrsWithNC` → `compliance.quartersInViolation` | after step 1, with the Registry ID it confirmed; best-effort |

`get_dfr` takes a Registry ID or a program ID (a TRI or RCRA ID resolves to its Registry ID). `get_facility_info` ignores `p_id`, so step 2 passes the confirmed Registry ID as `p_frs`, which returns the one facility row directly with no `get_qid` follow-up. No DFR section carries the facility-level status that `epa_echo_search_facilities` reports, which is why step 2 exists.

| Output | `get_dfr` source |
|:--|:--|
| name, address, coordinates | the `Permits[]` record with `EPASystem` `FRS` (coordinates fall back to `SpatialMetadata`) |
| `county`, `fipsCode` | the first `Permits[]` entry with a non-null `FacilityCountyName` / `FacilityFipsCode` ("King County", "53033"; the FRS entry carries null), else the step 2 row's `FacCounty` / `FacFIPSCode` / `FacDerivedStctyFIPS`. `Permits[]` comes first so the value does not depend on whether step 2 succeeded |
| `programs.*` | `Permits[].EPASystem`: `ICIS-Air`, `ICIS-NPDES`, `RCRAInfo`, `TRI`, `SDWIS` |
| `triFacilityIds` | `SourceID` of the `TRI` permits, ordered by the year in `FacilityStatus` ("Last Reported for 2024"), newest first |
| `triReleasesTransfersInLbs`, `triReleasesTransfersYear` | `TRIHistory.Sources[].ReleaseYear[]`: the latest `Year`, its comma-formatted `TotalReleasesTransfers` summed |
| `programCompliance[]` | `EnforcementComplianceSummaries.Summaries[]` with `ProgramDates[]`; rows with no values (a statute the facility has no record in) are dropped |
| `inspections[]`, `inspectionsTotal` | `ComplianceHistory.Inspection[]`, newest first, capped at 100 (`ActivityType` → `category`, `InspectionType` → `activityType`); `inspectionsTotal` counts every record |
| `formalActions[]` | `FormalActions.Action[]`, newest first; `caseId` and `settlementDate` from the `CaseFormalActions.Action[]` entry with the same statute, source ID, and issue (or, when the issue date is absent or the `01/01/0001` placeholder, settlement) date; among same-day cases, the one whose settled federal + state/local penalty equals the action's penalty |
| `airCompliance`, `waterCompliance` | the CAA / CWA `programCompliance` row; `programId` / `permitId` only when the facility has exactly one ICIS-Air / ICIS-NPDES record |

Program flags key on `EPASystem` rather than `Statute`: `EIS`, `CEDRI`, `RMP`, and `GHGRP` entries carry `Statute` `CAA` without an ICIS-Air compliance record, and a TRI entry's statute is `EP313`.

`compliance.mediaStatusCode`, `compliance.mediaStatusDescription`, and `waterCompliance.programId` stay in the schema but no ECHO response carries them, so they are never set.

Step 2 gets two attempts and at most 10 seconds of the call's budget (see Request deadlines). When it fails, the profile returns without those two fields and an enrichment `notice` says so (the `epa://facility/{registry_id}` resource carries it as a `notice` field); caller cancellation still aborts the call.

**Decision: one `get_dfr` response, not five DFR endpoints.** The earlier design called `get_compliance_summary`, `get_inspection_enforcement`, `get_air`, and `get_water`. The last three are not in ECHO's DFR OpenAPI spec (`swaggerx.swagger_json?p_prefix=DFR`) and answer HTTP 500, so each was retried four times and dropped, and `get_compliance_summary` returns a shape the normalizer never read. For registry `110017848105` that took 10.2 seconds and 14 requests and returned empty compliance, inspections, and actions; `get_dfr` already carries all of it, and the two-request flow takes 1.1 seconds.

**Decision: cap `inspections[]` at the newest 100.** Texas refineries carry several hundred state compliance investigations in the five-year history (581 at `110041990913`, 129 KB per call uncapped). `inspectionsTotal` discloses the full count as an output field rather than `ctx.enrich.truncated()`, whose `notice` would collide with the status-lookup notice.

### `epa_echo_search_facilities` + environmental justice chain

Typical agent chain:
1. `epa_echo_search_facilities(zip_code='98101', has_violation=true)` → list with `registryId`, `fipsCode`, `programs.tri`
2. `epa_tri_search_releases(state='WA', year=2022)` → top chemical emitters in region
3. `epa_echo_get_facility(registry_id)` for highest-emission or highest-penalty facility
4. [External] `census_query_data` using `fipsCode` → demographics of surrounding county
5. [External] `openstreetmap_query_nearby` using `latitude`/`longitude` → proximity of schools, hospitals

---

## Design Decisions

**Program-first names under `epa_`.** Tools use `epa_<group>_<verb>_<object>` so alphabetic lists cluster each program's tools. Group tokens are the names practitioners use: `echo`, `tri`, `superfund`, `water`, `airnow`, and `ejscreen`. Facility-scoped TRI retrieval uses `get_facility_releases` to distinguish it from regional `search_releases`. Resource URIs remain stable.

**Split TRI into two tools.** The original design had a single `epa_tri_get_facility_releases` that accepted either a facility ID or a state search — two very different query shapes with different outputs. These are now separate tools: `epa_tri_get_facility_releases` (facility-scoped, detailed release breakdown) and `epa_tri_search_releases` (area search, identifies top emitters). Cleaner inputs, clearer use cases.

**`epa_echo_search_violations` vs `epa_echo_get_facility` separation.** `epa_echo_search_violations` is for area-level enforcement discovery (what cases have been filed in WA under RCRA?). `epa_echo_get_facility` includes the enforcement history for a single known facility. The descriptions explicitly cross-reference each other.

**`epa_echo_search_facilities` uses ECHO, not DMAP.** ECHO's `get_facility_info` returns cross-program compliance status in a single call. DMAP's individual program tables require separate queries per program. ECHO is the right API for facility discovery.

**`programs` takes one program.** ECHO's `p_med` filters on a single media code; a comma list is echoed but not applied, and a repeated parameter keeps only the first. Running one search per program and merging would make `totalCount` and the result page ambiguous, so the schema caps `programs` at one entry. It stays an array so existing single-program calls keep their shape.

**`has_violation` is significant noncompliance (`p_cs=3`).** The input promised "significant violations", and `p_cs=3` returns exactly the rows whose `complianceStatus` is "Significant Violation" (ZIP 98108: 18 of 1,322; `p_cs=2`, any noncompliance, adds 47 "Violation Identified" rows). ECHO's quarter filter `p_qiv` and the old `p_sv_flag` did not change the count.

**A filing-date range returns civil cases only.** `p_from_date`/`p_to_date` alone match any milestone date, so they need `p_milestone=CMF,CPOA` to bound the filing date, and those milestones exist only on civil cases. Rather than run a second criminal search with a different date meaning, a date-bounded `case_type: "all"` returns civil cases with an enrichment `notice` saying criminal cases were excluded, and `case_type: "criminal"` with a date is rejected before any request.

**`epa_tri_get_facility_releases` uses DMAP, not ECHO.** ECHO shows TRI totals in facility search results but not per-chemical-per-medium breakdowns. DMAP's `tri.tri_reporting_form` has the chemical name and reporting year of each annual filing, and `tri.tri_release_qty` its per-medium quantities, joined on `doc_ctrl_num`.

**Facility TRI lookups cap after ordering.** Without `year`, `epa_tri_get_facility_releases` uses the same newest-year/submission-number sort as regional searches, including every punctuation-matching page. Explicit-year requests retain table order. At 500 matching filings, `truncated`, `shown`, `cap`, and `guidance` disclose that more may exist on both response surfaces; `guidance` suggests `year` only when omitted and otherwise `chemical_name`. Cap guidance has its own field so a punctuation-scan `notice` survives. Empty TRI results remain successful messages, with hints tailored to the supplied filters and earlier accepted years rather than an unchanged retry.

All-years sorting consumes an additional 88 request-line bytes. Near-limit filters that fit an unsorted request can therefore exceed DMAP's unchanged 4,094-byte bound; shorten them when the validation message reports that limit. Explicit-year request lengths are unchanged.

**`epa_tri_search_releases` is one joined request.** `tri.tri_reporting_form` carries no state or county column, so the search joins it to `tri.tri_facility` in one DMAP URL: state and county filters on the facilities, year and chemical filters on the forms, and `1:limit` over the joined rows. The earlier design walked the state's facilities 50 at a time, two requests per batch, until `limit` records turned up — a sparse filter in a large state never stopped (`TX`, 2022, limit 200 ran past 400 seconds; `WA`, 2022, limit 200 took 20 requests and 30 seconds). Joined, those take one request: about 5 seconds for Texas and 4 for Washington, and the plain `WA` search drops from two requests to one. A bounded walk with a partial-scan notice was the alternative; the join returns every match in the state without one.

**Without `year`, the search sorts newest first.** DMAP returns joined rows in table order, which puts a state's oldest filings first: `AK` limit 50 came back as one facility's 1988–1994 forms. With no `year`, the URL carries `/sort/tri.tri_reporting_form.reporting_year:desc,tri.tri_reporting_form.doc_ctrl_num:asc` between the join filters and the row range, so `limit` keeps the most recent filings. Sorting keeps the documented "all available years" meaning of an omitted `year`; defaulting to the latest year would have changed it. The keys are table-qualified because DMAP resolves a bare column against the first table of the join (`reporting_year` there is HTTP 500), and the `doc_ctrl_num` tiebreak makes ranges page deterministically (on year alone, `AK` rows `1:50` and `51:100` shared 36 records). With `year`, the request is unchanged: table order already pages deterministically, and the sort adds nothing.

**The per-medium breakdown is opt-in on `epa_tri_search_releases`.** It costs one batched `tri.tri_release_qty` request after the search request. That request takes about 20 seconds when DMAP has not cached it (about 1 second when it has), against a 2–5 second search, so `include_release_breakdown` defaults to false and its description states the cost.

**The breakdown's `doc_ctrl_num` list is split to fit DMAP's request line.** DMAP's front end refuses a request line over 4,094 bytes with HTTP 400 ("Request Line is too large"). Each 13-digit submission number adds 16 bytes to the `in` list, so a facility with a few hundred filings overflowed it: Boeing Field (`98108THBNG7500E`, 375 forms) failed without `year`. The list is now packed into requests whose request line stays within 3,800 bytes (about 230 submissions each), and their rows merge into one rollup. An uncached `tri.tri_release_qty` request takes about 18 seconds however many submissions it names, so three chunks run serially, plus the forms request, would outlast a client's 60-second timeout. The chunks therefore run side by side, three at a time, which covers the 500-form cap of `epa_tri_get_facility_releases` in one wave (Boeing Field: two chunks, about 19 seconds uncached), inside the call's DMAP deadline (see Request deadlines). A DMAP HTTP 400 comes only from that front end, never from a filter value (those are HTTP 500), so it maps to `InternalError` rather than to an invalid-argument error that would blame the caller for a URL this server built.

**Text filters that DMAP can't carry are rewritten to its wildcard and matched exactly afterward.** DMAP puts filter values in the URL path and parses them after decoding, and in a value it reads only letters, digits, space, `-`, `_`, `?`, and `@` (probed live). Every other punctuation character and every non-ASCII letter is HTTP 500 "The query could not be parsed", which used to be retried four times and reported as an upstream outage, and `%` is an nginx HTTP 403. A comma silently ends the value, so `contains/1,3-Butadiene` matched every chemical containing "1". Real names need these characters: 349 of the 860 TRI chemical names (`Michler's ketone`, `Benzo[g,h,i]perylene`, `γ-ω-perfluoro` names), 57 TRI county names (`PRINCE GEORGE'S`, `BALTIMORE (CITY)`), and Superfund cities (`ST. LOUIS`, `COEUR D'ALENE`). In a `contains` value, `_` matches any one character, so each such character becomes `_` and the rows are then narrowed to those containing the text as given; a `_` the caller wrote gets the same exact pass, so `C_12` no longer also matches `C112`. That keeps the search faithful rather than approximate. Across every TRI chemical and county name, the wildcard form of a name matches no other name. Superfund city names carry spelling variants (`COEUR D ALENE` beside `COEUR D'ALENE`) that the exact pass drops, so a punctuated search reads pages of at least 100 rows, up to three, until it has `limit` exact matches, and says so in a `notice` when the third page ends the walk short (live, TX `chemical_name` `C.I.`: three pages, 3 records kept, while TX holds at least 36 matching filings). Exact-value filters (state, ZIP, TRI facility ID, Superfund site ID) have no wildcard rewrite, so a character DMAP cannot match there fails before any request as a validation error naming it; for a comma, the error says to pass one value per call. A filter with no letter or digit fails the same way. Because DMAP splits its path after decoding it and drops empty segments, a slash at either end of a value never reached the filter (`98108THBNG7500E/` and `/98108THBNG7500E` answered as the bare ID), so end slashes are dropped from every filter value before it is checked; a slash inside a value is still rejected.

**Text filters are bounded at DMAP's request-line limit.** DMAP's front end counts 11 bytes fewer than the client's request line and refuses a count over 4,094 (live: a 4,105-byte line is answered, a 4,106-byte one is "Request Line is too large (4095 > 4094)"), so a request is checked against that count before it is sent. `chemical_name`, `county`, and Superfund `city` are bounded at 4,094 characters: every request line is longer than its filter value, so a longer value could never be sent, and the bound rejects nothing DMAP could answer. A tighter bound near the longest real names (542, 31, and 57 characters) would reject calls DMAP answers with a correct empty result, such as a Superfund `city` of 4,029 letters.

**Dioxin quantities are converted from grams to pounds.** EPA's TRI program has facilities report dioxin and dioxin-like compounds (TRI chemical ID `N150`) in grams and every other chemical in pounds (TRI Basic Data Files documentation, `UNIT_OF_MEASURE`). DMAP's `tri.tri_reporting_form` and `tri.tri_release_qty` carry no unit column, so `tri_chem_id = N150` is the marker on their rows (`tri.tri_chem_info.unit_of_measure` records `Grams` for N150, the only gram-reported chemical). The TRI tools divide those quantities by 453.59237 and set `reportedUnit: "grams"` on the record, rather than passing grams through: every quantity field is named and described in pounds, and an agent summing or ranking releases across chemicals would otherwise mix units. The marker lets a reader reconcile the value with EPA's gram figures. Per-medium sums and conversions are rounded to 12 significant digits, the precision `formatLbs` renders, so both output surfaces carry the same number.

**`has_violation` on `epa_water_search_systems` reads a bounded slice of `sdwis.violation`.** `sdwis.water_system` has no violation flag, so with `state` alone the tool reads the first 1,000 open violation rows for the state and looks up the systems they name, 200 PWSIDs per `pwsid in` request, stopping once `limit` is filled — at most six requests. A state's full violation table is far larger (Washington's exceeds 15,000 rows, at 10–25 seconds per 5,000-row page; its open rows alone number about 4,800), so reading all of it is unbounded; a scan that reaches 1,000 rows says so in an enrichment `notice` instead.

**A water system's ZIP is its address of record.** `sdwis.water_system.zip_code`, like its `state_code`, is the owner's or operator's address, not the service area: ZIP 98104 (Seattle) returns Alaska and Montana systems run from Seattle offices. The `zip_code` input says so rather than promising a geographic search.

**A ZIP's violation check runs by PWSID.** `sdwis.violation` has no ZIP column, so a `zip_code` search (with or without `state`) reads the ZIP's systems first — up to 1,000, one request — and asks `sdwis.violation` for their open rows 200 PWSIDs at a time, stopping once `limit` is filled: at most six requests. Measured ZIPs hold far fewer systems (98104: 8, 98382: 109, 59901: 194), so a typical check is two requests of about 3–4 seconds each. Either read that fills its 1,000-row cap adds a `notice`. This was chosen over rejecting a ZIP-only `has_violation` call because the PWSID check is exact and stays within the state scan's request budget.

**`has_violation` means an open violation.** `sdwis.violation.compliance_status_code` carries four values in live data: K and O have no `rtc_date` (unresolved); R has an `rtc_date` and a resolving enforcement (returned to compliance, back to 2004 in Washington); I has an `rtc_date` equal to the system's `pws_deactivation_date` (closed out when the system was deactivated). Of Washington's first 1,000 violation rows, 819 were R and 73 were I. Both violation reads filter `compliance_status_code in (K, O)`, so a resolved violation never marks a system.

**Superfund and drinking water via DMAP.** ECHO's CERCLA and SDWA data is summary-level. DMAP's `sems.envirofacts_site` and `sdwis.water_system` tables have the full records.

**`epa_superfund_search_sites` accepts lat/lng + radius.** Superfund proximity searches are a primary use case (is there a Superfund site near my house?). ZIP-only search misses this. The tool accepts either state/city/ZIP or coordinates + radius.

**Superfund proximity exhausts spherical latitude/longitude prefix pairs.** DMAP rejects decimal comparison literals and compares coordinates as text, so numeric bounding boxes can omit valid sites. Conservative signed integer-degree prefixes cover the spherical latitude and longitude bounds, including both zero signs and overlapping digit widths. Longitude intervals wrap at the antimeridian; a circle reaching either pole omits longitude filtering. Every pair pages 500 rows at a time in qualified `sems.envirofacts_site.site_id:asc` order until exhausted, sharing one 50-second deadline with retries and backoffs. Exact punctuation matching, site-ID deduplication, and Haversine filtering preserve the supplied administrative/NPL filters. Distance ordering precedes the caller's limit; an omitted-match notice reports the complete matching count. A repeated page fails as ServiceUnavailable, and deadline expiry remains Timeout rather than a partial success. Near Newark (40.7357, -74.1724), a 5-mile query's longitude narrowing retains all 203 nearby sites from a complete 2,476-row latitude-band reference in 1,009 candidate rows; Seattle retains all 15 nearby sites in 138 candidates.

The coordinate predicates and site-ID sort consume request-line space. Combined city/proximity queries can reject a text filter that fits a search without coordinates; shorten the filter as the validation message directs. Searches without coordinates retain their request lengths. For latitude 47.6, longitude -122.3, and radius 25 miles, the longitude predicate and sort add 89 bytes: an ASCII city filter accepts 3,891 characters and rejects 3,892, versus the latitude-only search's 3,980-character boundary.

**No AirNow history tool.** AirNow's rate limits make bulk historical queries impractical. AirNow itself recommends not using the API to build historical databases. Historical air quality data is better sourced via NOAA or EPA's AQS system. Deferred. AirNow's 2026 services add daily reporting-area history by state (from July 2017) and site-level daily data by bounding box, which removes the rate-limit objection but not the rest: the Data Exchange Guidelines bar AirNow data from trend analysis and point to AQS for validated history, so historical tools belong to an AQS integration (`epa_aqs_*`), not to AirNow.

**No GraphQL API.** DMAP offers a GraphQL-like API for more complex queries. Deferred — the REST table service covers all target use cases without the additional query composition complexity.

**`epa_water_search_systems` searches a list.** The verb `get` implies retrieving a single known item by ID. This tool searches across multiple systems, so it uses `search`.

---

## Known Limitations

- **AirNow rate limits**: Rate-limited by key per hour. Caching responses at ~1 hour TTL is strongly recommended. Data is preliminary — not valid for regulatory or trend analysis.
- **DMAP column name fragility**: The DMAP REST API requires exact column names in URL paths. Column names differ by table and aren't documented in a machine-readable schema. Verified column names are recorded in the Domain Mapping section above.
- **ECHO geographic scoping required**: Unscoped ECHO searches return millions of rows and time out. All search tools enforce at least one geographic parameter at the input validation layer.
- **TRI data lag**: TRI reporting year N data becomes available approximately Q1 of year N+2. The most recent available year is typically 2 years behind the current calendar year.
- **Superfund proximity has a shared deadline**: broad or polar searches can time out before every candidate page is read; narrow the radius or add filters. Successful searches disclose matches omitted by the caller's limit; missing upstream coordinates cannot be distance-filtered.
- **Coordinate encoding inconsistency**: `tri.tri_facility` encodes lat/lng as DDMMSS integers (e.g., `482730` = 48°27'30"); `sems.envirofacts_site` uses decimal degrees. Only the SEMS coordinates are exposed today; a tool that returns TRI facility coordinates must convert DDMMSS first.
