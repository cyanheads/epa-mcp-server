# epa-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `epa_echo_search_facilities` | Search EPA-regulated facilities by location, county, facility name, NAICS code, program, or compliance status across CAA, CWA, RCRA, TRI, and SDWA. Returns facility name, EPA Registry ID, coordinates, county FIPS, per-program registration flags, TRI facility IDs, five-year inspection and penalty totals, and TRI release totals. Registry IDs returned here feed `epa_echo_get_facility`; TRI facility IDs feed `epa_tri_get_facility_releases`. | `zip_code`, `state`, `city` (prefix match), `county` (prefix match; needs `state`), `county_fips`, `facility_name` (whole words, any order), `naics` (2–6 digits, prefix match), `latitude`+`longitude`+`radius_miles`, `active_only` (boolean), `programs` (enum array of at most one: CAA/CWA/RCRA/TRI/SDWA), `has_violation` (boolean: a program in significant noncompliance), `limit`, `offset` | `readOnlyHint: true` |
| `epa_echo_get_facility` | Retrieve a full compliance profile for a single EPA-regulated facility: the facility-level compliance status, NAICS codes, a per-statute compliance summary, five years of compliance monitoring records and of drinking-water violations (both paged), five years of formal enforcement actions with penalties, the latest TRI release total, and the facility's TRI facility IDs. Built from one ECHO `get_dfr` response plus a best-effort facility search row. | `registry_id` (a Registry ID, or a PWSID, TRI facility ID, NPDES permit, or RCRA handler ID that resolves to one), `inspections_limit` (default and cap 100), `inspections_offset`, `drinking_water_violations_limit` (default 50, cap 200), `drinking_water_violations_offset` | `readOnlyHint: true` |
| `epa_echo_search_violations` | Search EPA civil and criminal enforcement cases by state, ZIP code, regulatory program, case type, or filing-date range. Returns case identifier, case type and status, lead agency, primary law and section, enforcement outcome, federal and state/local penalties, cost recovery, compliance action and SEP costs, and filing, settlement, and closing dates. Case rows name no facility: a civil `caseId` feeds `epa_echo_get_case`. Designed for area-level violation discovery; for a single facility's enforcement history use `epa_echo_get_facility`. | `state`, `zip_code`, `program` (enum: CAA/CWA/RCRA/SDWA/CERCLA/EPCRA/FIFRA/TSCA; matches any cited law), `case_type` (civil/criminal/all), `date_filed_start`, `date_filed_end` (YYYY-MM-DD, inclusive, civil cases only; `criminal` with a date is rejected), `limit`, `offset` | `readOnlyHint: true` |
| `epa_echo_get_case` | Retrieve one civil enforcement case: category, enforcement type, status, lead agency, outcome, docket numbers, summary, penalty and cost totals, laws and sections cited, the facilities the case names (one per Registry ID, with NAICS and SIC codes and linked program IDs), defendants, pollutants, milestones, and every enforcement conclusion with its facilities, dates, penalties, complying actions, pollutant reductions, and SEPs. Built from one ECHO `get_case_report` response. | `case_id` (a civil `caseId` from `epa_echo_search_violations` or `epa_echo_get_facility` `formalActions`; a criminal `CR_` number is rejected) | `readOnlyHint: true` |
| `epa_airnow_get_conditions` | Get current AQI observations or the issued AQI forecast for a location. Current mode returns each pollutant's hourly NowCast AQI from the closest monitor within 50 miles, with site and reporting agency; forecast mode returns every issued forecast day with category, action-day flag, and the agency discussion. Output credits the agencies and the U.S. EPA AirNow program. Data is preliminary — suitable for awareness and informational use, not regulatory decisions. | `zip_code` (5 digits, or a ZIP+4 sent as its first five; other forms are rejected) OR `latitude`+`longitude`, `mode` (enum: `current`/`forecast`), `forecast_date` (optional real calendar date, YYYY-MM-DD, forecast mode only; filters the forecast to one valid date) | `readOnlyHint: true` |
| `epa_tri_get_facility_releases` | Query Toxic Release Inventory annual chemical release data for a specific facility. Returns per-chemical on-site release quantities by medium (air, water, land, underground injection), their on-site total, and the Form R Section 8.8 one-time quantity, by reporting year. TRI data lags ~18 months — the most recent available year is typically 2 years prior to the current calendar year. | `facility_id` (15-character TRI facility ID — the `facilityId` from `epa_tri_search_releases` or an entry of `epa_echo_get_facility` `triFacilityIds`; a 12-digit FRS Registry ID matches nothing), `year` (optional; defaults to all available years), `chemical_name` (optional filter), `limit` (default and cap 500), `offset` | `readOnlyHint: true` |
| `epa_tri_search_releases` | Search Toxic Release Inventory data across facilities in a state or county, for one reporting year or, without `year`, every available year newest first. Returns facility name and county, TRI facility ID, EPA Registry ID, parent company, chemical name, and the Form R Section 8.8 one-time quantity; `include_release_breakdown` adds on-site releases by medium (air, water, land, underground injection) and their total from one extra `tri.tri_release_qty` request. Records come in reporting-year order, not ranked by quantity. Use to build an environmental exposure profile for an area. | `state`, `county` (optional; bare name, trailing County/Parish/Borough/City and Borough/Census Area/Municipality dropped; partial match, so `LAKE` also matches `LAKE OF THE WOODS` — each record's `countyName` says which), `year` (optional; omitted, records come newest reporting year first), `chemical_name` (optional), `limit` (default 50, cap 200), `offset`, `include_release_breakdown` (boolean, default false) | `readOnlyHint: true` |
| `epa_superfund_search_sites` | Search SEMS sites by location or NPL status. Returns source NPL code/label, sparse non-NPL assessment and archive metadata, site identifiers, coordinates, and county FIPS. Administrative results come in site ID order; proximity results nearest first. | `state`, `city`, `zip_code` OR `latitude`+`longitude`+`radius_miles`, `npl_status` (listed/not-listed/proposed/deleted/removed/withdrawn/all), `exclude_archived` (default false), `limit` (default 50, cap 200), `offset` | `readOnlyHint: true` |
| `epa_superfund_get_site` | Exact SEMS site metadata and every contaminant association, preserving sparse values, repeated chemicals, and source rows. | `site_id` from `epa_superfund_search_sites`, preserving leading zeros | `readOnlyHint: true` |
| `epa_water_search_systems` | Search drinking water systems (SDWIS) by state, ZIP code, or county served, in PWSID order. Returns system name, PWSID, population served, primary water source, and activity status. With `has_violation`, returns only systems with a current SDWA violation in ECHO, by state, ZIP, or county. A returned PWSID is a valid `epa_echo_get_facility` `registry_id` for the system's drinking-water violations. | `state` (or an EPA region code 01–10), `zip_code`, `county` (needs `state`; whole-entry match on the counties a system serves), `has_violation` (boolean), `pws_type` (enum: community/non-transient/transient), `active_only` (boolean), `limit` (default 50, cap 200), `offset` | `readOnlyHint: true` |
| `epa_ejscreen_get_scores` | Get EJScreen environmental-justice indicators for a point and buffer: 13 environmental and 6 demographic indicators with national and state percentiles and EJ Index values, plus the Demographic and Supplemental Demographic Indices. EJAM's ACS 2018–2022 release of EJScreen (EJScreen 2.3 method) from the community-maintained EJAM API, not a live EPA endpoint; a point outside EJAM's bounds, a buffer with no Census block, or one with no residents returns a coverage note. | `latitude`, `longitude`, `distance` (default 1; miles-equivalent ≤ 15), `unit` (miles/kilometers) | `readOnlyHint: true` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `epa://facility/{registry_id}` | Full compliance profile for a facility by EPA Registry ID (same data as `epa_echo_get_facility`) | No |
| `epa://superfund/{site_id}` | Same data as `epa_superfund_get_site`, retaining top-level site fields with additive `contaminants` | No |

### Prompts

None. This server is data-oriented.

---

## Overview

`epa-mcp-server` exposes EPA environmental data across four complementary systems — ECHO (facility compliance), Envirofacts/DMAP (TRI chemical releases, Superfund, drinking water), AirNow (real-time air quality), and EJScreen (EJAM's ACS 2018–2022 release) through the community-maintained EJAM API (environmental-justice screening) — as a unified "environmental data" tool surface. Tools are designed around agent workflows, not API boundaries.

Target agent workflows:
- **Facility compliance audit**: `epa_echo_search_facilities` → `epa_echo_get_facility` → `epa_echo_search_violations`
- **Enforcement case to facilities**: `epa_echo_search_violations` → `epa_echo_get_case` (a civil `caseId`) → `epa_echo_get_facility` (a facility's `registryId` from the case)
- **Environmental justice analysis**: `epa_echo_search_facilities` (by ZIP) → `epa_tri_search_releases` (by state/county) → chain `fipsCode` to Census API for demographics
- **Air quality check**: `epa_airnow_get_conditions` (current) → `epa_airnow_get_conditions` (forecast)
- **Superfund proximity**: `epa_superfund_search_sites` (lat/lng + radius) → `epa_echo_get_facility` if responsible party is still regulated
- **Drinking water safety**: `epa_water_search_systems` (by state, county served, or the ZIP of a system's address of record) with `has_violation` → identify systems with a current violation → `epa_echo_get_facility` (the `pwsid` as `registry_id`) for the violations' contaminant, measured level, MCL, status, and enforcement actions

ECHO and Envirofacts/DMAP are US federal government data (public domain, 17 USC §105) and require no authentication. AirNow requires a free API key, and redistribution follows the [AirNow Data Exchange Guidelines](https://docs.airnowapi.org/docs/DataUseGuidelines.pdf): credit the reporting agency and EPA AirNow, mark observations preliminary, pass values, forecasts, and advisories unaltered, and register the product with AirNow (signed form to dmc@airnowtech.org).

---

## Requirements

- Read-only access to three EPA APIs — ECHO (`echodata.epa.gov`), Envirofacts DMAP (`data.epa.gov`), AirNow (`www.airnowapi.org`) — plus the EJAM API (`api.ejanalysis.com`), which rehosts EJScreen
- AirNow requires `AIRNOW_API_KEY` (free registration at docs.airnowapi.org); ECHO, DMAP, and EJAM are unauthenticated
- AirNow rate limits by key per hour — responses should be cached for ~1 hour TTL
- No write operations; all tools are read-only
- Cannot imply EPA endorsement in output
- AirNow data is preliminary — not for regulatory, trend, or enforcement purposes (stated in descriptions)
- ECHO facility searches must always include at least one geographic filter (state, ZIP, city, county FIPS, or a complete latitude, longitude, and radius triple) and case searches a state or ZIP — unscoped searches return millions of rows and time out

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `EchoService` | ECHO REST API (`echodata.epa.gov/echo/`), including `sdw_rest_services` for the current-violation lookup behind `has_violation` | `epa_echo_search_facilities`, `epa_echo_get_facility`, `epa_echo_search_violations`, `epa_echo_get_case`, `epa_water_search_systems` (`has_violation` only) |
| `DmapService` | Envirofacts DMAP REST API (`data.epa.gov/dmapservice/`) | `epa_tri_get_facility_releases`, `epa_tri_search_releases`, `epa_superfund_search_sites`, `epa_superfund_get_site`, `epa_water_search_systems` |
| `AirNowService` | AirNow API (`www.airnowapi.org/aq/`) | `epa_airnow_get_conditions` |
| `EjscreenService` | EJAM API (`api.ejanalysis.com`), a community rehost of EJScreen (EJAM's ACS 2018–2022 release) | `epa_ejscreen_get_scores` |

### Request deadlines

Every tool call runs under one wall-clock budget shared by every request it makes and every retry and backoff of each, so it ends with this server's own error before the 60-second default request timeout of MCP SDK clients. Each `withRetry` gets what is left of the budget as `deadlineMs` and passes its attempt signal to `fetch`, so the budget also stops a request in flight. An expired budget fails the call as `Timeout` with `data.reason: 'retry_deadline_exceeded'`. Caller cancellation still surfaces as cancellation, never as a timeout or a partial result. This table is the one record of every budget:

| Call | Budget | Requests it covers | Successful latency, measured live 2026-10-16 |
|:--|:--|:--|:--|
| `epa_echo_search_facilities` | 58 s | `get_facility_info`, then the `get_qid` page that holds `offset` with what remains (two pages, side by side, when `offset` is not a multiple of `limit`) | ZIP 98108: 0.5–1.4 s; `p_st=CA` (986,998 rows): 39–42 s; 100 mi around Houston: 42 s; `p_ct=Los Angeles` (40,471 rows): 53.8–56.7 s (45.6 s + 11.1 s at the top) |
| `epa_echo_search_violations` | 58 s | `get_case_info`, then the `get_qid` page that holds `offset` with what remains (a small match comes back inline from `get_case_info`) | ZIP 98108: 1.1 s; `p_state=CA`: 3.6 s; `p_state=CA` filed since 2000: 4.3 s; `p_state=WA` filed in 2024: 2.5 s |
| `epa_echo_get_facility`, `epa://facility/{registry_id}` | 50 s | `get_dfr`, then the best-effort `p_frs` row with what remains, capped at 10 s and two attempts | registry `110017848105`: 0.9–1.1 s |
| `epa_echo_get_case` | 50 s | one `get_case_report` request | 2.1 s for case `04-2006-9900` (37 conclusions); 8.0 s for `TX000A300485682003235` (115 facilities, 117 settlements, a 1.38 MB upstream report), measured 2026-11-01 |
| `epa_tri_get_facility_releases`, `epa_tri_search_releases`, `epa_superfund_search_sites`, `epa://superfund/{site_id}` | 50 s per `DmapService` call | the TRI forms request or join and its breakdown chunks; up to three pages for a non-proximity wildcarded text filter; every Superfund proximity prefix page | WA 2022 TRI search: 2.7 s, 19.2 s with an uncached breakdown; Boeing Field TRI history (375 forms, two chunks): 8.5 s; facility `77506RPRDC1423H`, 2024, `chemical_name` `Chromium compounds (except for chromite`, uncached: 48.6 s (forms 31.8 s, breakdown 16.8 s), 1.7 s repeated; Superfund WA listed: 3.1 s |
| `epa_water_search_systems` | 50 s, shared by DMAP and ECHO | a page of `sdwis.water_system` rows (joined to `sdwis.geographic_area` for `county`); with `has_violation`, ECHO `sdw_rest_services.get_systems` and its `get_qid` pages for a state's violators then `pwsid in` lookups of 200, or for a ZIP or county one read of up to 1,000 systems and a `get_systems` lookup per 200 PWSIDs | WA `has_violation`: 3.5 s; ZIP 98104 `has_violation`: 5.3 s; King County, WA `has_violation`: 8.3 s; King County, WA: 3.4 s, measured 2026-11-01 |
| `epa_airnow_get_conditions` | 55 s | one AirNow request (a cached answer makes none) | 0.3 s |
| `epa_ejscreen_get_scores` | 55 s | one EJAM `POST /data` | 2.8–6.3 s up to a 15-mile buffer; 17.6 s for the session's first request |
| `epa_superfund_get_site` | 50 s | exact site lookup and every contaminant page, including retries and backoff | — |

The two ECHO searches, the water-system search, and every `DmapService` call share one budget mechanism (`src/services/call-budget.ts`) that restates an expired budget as one Timeout naming the call and how to narrow it, since the framework's message would report only the expiring request's remaining milliseconds: `ECHO did not finish the facility search within 58 seconds. Narrow it with zip_code or county_fips instead of city or state, …`, `DMAP did not finish the TRI release lookup within 50 seconds. Narrow it with year or chemical_name, or call again later.` The TRI search names `year`, `county`, `chemical_name`, and leaving `include_release_breakdown` off; the Superfund search `radius_miles`, `zip_code`, `city`, or `npl_status`; the water-system search `zip_code`, `county`, `pws_type`, or `active_only` (it reads `DMAP and ECHO` when `has_violation` draws on both); a Superfund site and contaminant lookup only says to call again later. AirNow, EJAM, `epa_echo_get_facility`, and `epa_echo_get_case` keep the framework's message, which names the expiring request's operation and deadline (`AirNow request exceeded its 55000ms retry deadline after 1 attempt.`): each makes one request with no filter left to narrow. `EchoService.fetchJson` requires `deadlineMs`, so an ECHO request cannot be added without a budget.

**Decision: 58 seconds for the ECHO searches.** A legitimate `p_ct=Los Angeles` facility search takes 53.8–56.7 s; a 55-second budget would turn the slower runs into Timeouts, and 58 s keeps them while still answering before the client's 60-second cutoff. The cost is transport margin: a hung ECHO search fails 2 s before the client gives up, not 5.

**Decision: 55 seconds for AirNow and EJAM, 50 for `epa_echo_get_facility`, `epa_echo_get_case`, and DMAP.** AirNow, EJAM, `epa_echo_get_facility`, and `epa_echo_get_case` finish far inside their budgets (slowest measured: 17.6 s; the largest case report, 1.38 MB, 8.0 s), so a longer budget would rescue no answer and would only spend transport margin while an upstream hangs. DMAP can reach its budget: an uncached `epa_tri_get_facility_releases` with a punctuated `chemical_name` took 48.6 s, a 31.8 s forms request followed by a 16.8 s breakdown. DMAP caches both, so the same call repeated took 1.7 s, and an expiry names `year` and `chemical_name` as the levers that shrink the forms request.

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
2. `EchoService` — facility search, facility detail, enforcement case search and report, current-violation water system lookup
3. `DmapService` — DMAP REST table queries (TRI, SEMS, SDWIS)
4. `AirNowService` — current/forecast observations by ZIP and lat/lng
5. `epa_echo_search_facilities` (ECHO `get_facility_info`)
6. `epa_echo_get_facility` (ECHO `dfr_rest_services.get_dfr` plus a `get_facility_info?p_frs` status row)
7. `epa_echo_search_violations` (ECHO `case_rest_services.get_case_info`)
8. `epa_echo_get_case` (ECHO `case_rest_services.get_case_report`)
9. `epa_airnow_get_conditions` (AirNow current + forecast)
10. `epa_tri_get_facility_releases` (DMAP `tri.tri_reporting_form` by `tri_facility_id`)
11. `epa_tri_search_releases` (DMAP `tri.tri_facility` + `tri.tri_reporting_form` join by state)
12. `epa_superfund_search_sites` (DMAP `sems.envirofacts_site`)
13. `epa_water_search_systems` (DMAP `sdwis.water_system` + `sdwis.geographic_area`, ECHO `sdw_rest_services` for `has_violation`)
14. `EjscreenService` and `epa_ejscreen_get_scores` (EJAM `POST /data`)
15. Resources (facility and superfund URI handlers)

Each step is independently testable.

---

## Domain Mapping

### ECHO (Enforcement and Compliance History Online)

| Noun | Operations | Endpoint |
|:-----|:-----------|:---------|
| Facility | search (by geo/program/compliance) | `echo_rest_services.get_facility_info` |
| Facility | get detail (all programs) | `dfr_rest_services.get_dfr`, plus `echo_rest_services.get_facility_info?p_frs=` for the facility-level status |
| Enforcement Case | search (civil + criminal) | `case_rest_services.get_case_info` |
| Enforcement Case | get detail (civil) | `case_rest_services.get_case_report` |
| Drinking Water System | current-violation lookup (behind `has_violation`) | `sdw_rest_services.get_systems`, `sdw_rest_services.get_qid` |

Both searches are two requests: `get_facility_info` / `get_case_info` returns the match count (`QueryRows`) and a `QueryID`, and `get_qid?qid=…&pageno=N` returns page N of `responseset` rows. A call sets `responseset` to its `limit` and reads page `offset / limit + 1`, plus the page after it when `offset` is not a multiple of `limit`. A small match comes back inline from discovery (a one-row facility match, for one), and those rows stand in for page 1. An offset at or past `QueryRows` makes no `get_qid` request. Neither has a row ceiling: a state-wide facility search (`p_st=WA`, 101,808 rows) takes about 2.7 s plus 1.5 s for the page, and a nationwide case search returns 312,945 rows (the queryset limit belongs to `get_facilities`; see the error table below). ECHO serves pages well past 1,000 rows: ZIP 98108's 1,320 facilities came back from one discovery request at `responseset=5000`.

ECHO runs a search without any parameter it does not recognize, and leaves that parameter out of `Results.QueryParameters`; a value it ignores is still echoed (`p_med=A,W`, `p_qiv=Y`). Both searches compare the sent `p_*` names against `QueryParameters` and fail with a non-retryable InternalError naming any that are missing (`data.droppedParameters`), so a renamed or retired parameter can never silently widen a search. Names only: ECHO also lists defaults it was not sent (`p_name_type=ANY`, `mapset`) and reformats values (`p_radius=0.5` as `.5`).

`get_facility_info` parameters `epa_echo_search_facilities` sends (ECHO OpenAPI: `swaggerx.swagger_json?p_prefix=ECHO`):
- `p_zip` — ZIP code
- `p_st` — state abbreviation (`p_state` is not a facility-search parameter: it is dropped and the search runs nationwide)
- `p_ct` — city, case-insensitive prefix match (`SEAT` matches SEATTLE and SEATAC)
- `p_co` — county name, a prefix match on the recorded name after the county-equivalent suffix is dropped (`KING` in VA also matches KING GEORGE); needs `p_st`. It covers every registration ECHO places in the county
- `p_fips` — 5-digit county FIPS code, an exact match that scopes a search on its own. It leaves out registrations with no program record, which `p_co` includes (`p_fips=53033`: 17,218 facilities)
- `p_fn` — facility name words: every word must appear as a whole word, in any order, in a name ECHO records for the facility, so `p_fn=NUCOR` also returns facilities such as ALABAMA METAL INDUSTRIES CORP. A comma is a list separator in ECHO, so the tool rejects one
- `p_ncs` — NAICS code, 2–6 digits, a prefix match
- `p_lat` / `p_long` / `p_radius` — proximity, radius up to 100 miles
- `p_act=Y` — facilities with an active permit
- `p_cs=3` — facilities with one or more programs in significant noncompliance (`2` is any noncompliance, `4` more than one program in SNC)
- `p_med` — one media code: `A` air, `W` water, `R` RCRA, `T` TRI, `S` SDWA (also `E`, `M`, `C`, `G`, `TSCA`, `ALL` = air and water and RCRA). A comma list is echoed but not applied
- `responseset` — rows per page, set to the call's `limit`
- `qcolumns` — the column IDs each row carries (`echo_rest_services.metadata`), sent to both `get_facility_info` and `get_qid`; the default row has no coordinates, program flags, or inspection and penalty counts

Output fields per facility row, by `qcolumns` name:
- `RegistryID` — EPA FRS Registry ID (the join key to `dfr_rest_services.get_dfr` and `get_facility_info?p_frs`)
- `FacComplianceStatus` — overall compliance text
- `FacCounty`, `FacFIPSCode` (falling back to `FacDerivedStctyFIPS`, the FIPS ECHO derives from the coordinates) — county and 5-digit county FIPS
- `FacLat` / `FacLong` — decimal degrees
- `AIRFlag` / `NPDESFlag` / `RCRAFlag` / `SDWISFlag` — `Y` exactly on the rows `p_med` `A` / `W` / `R` / `S` selects; TRI registration is a non-null `TRIIDs`, the rows `p_med=T` selects (`TRIFlag` marks current reporters only: 12 of 45 TRI facilities in ZIP 98108)
- `FacInspectionCount`, `FacTotalPenalties` — five-year totals across programs (registry 110017848105: 11 inspections and $1,750, the sums of its `get_dfr` five-year summaries)
- `TRIIDs` — the facility's TRI facility IDs, space-separated, in ECHO's order (not reporting-year order); `triFacilityIds` carries them, so a search row feeds `epa_tri_get_facility_releases` directly
- `TRIReleasesTransfers` — TRI on/off-site releases and transfers in lbs for the latest TRI year (summary; for per-chemical detail, call `epa_tri_get_facility_releases` with a TRI facility ID from `triFacilityIds`)

`get_case_info` parameters `epa_echo_search_violations` sends (`swaggerx.swagger_json?p_prefix=CASE`):
- `p_state` — case location state
- `p_fac_zip` — facility ZIP (`p_zip` is dropped)
- `p_law` — one statute code (CAA, CWA, RCRA, SDWA, CERCLA, EPCRA, FIFRA, TSCA); matches any law a case cites, so `programsViolated` (the case's primary law) can differ
- `p_civil_criminal_indicator` — `CI` civil, `CR` criminal; not sent for `all`
- `p_from_date` / `p_to_date` (MM/DD/YYYY) with `p_milestone=CMF,CPOA` — bounds `DateFiled`, both ends inclusive. ECHO requires both dates (one alone is an HTTP 200 error), so an open end reads `01/01/1900` or today (UTC); each end is clamped to that span, and a range that clamps empty (a start after today, an end before 1900) returns no cases without a request, since ECHO answers an inverted range with the in-band error `From_date must be earlier than or equal to to_date.` rather than an empty result. The dates alone match any case milestone (WA 2024: 303 cases, versus 87 filed in 2024); the two filing milestones are civil-only, so a date-bounded search returns no criminal case

`get_case_report` takes `p_id`, a civil case number (`03-2014-7010`, `WA-100446`, or the `CaseID` of a facility's formal action) and answers with the whole report: `CaseInformation`, `LawsAndSections`, `Facilities`, `Defendants`, `Pollutants`, `CaseMilestones`, and `EnforcementConclusions` with their complying actions, pollutant reductions, and supplemental projects. `Facilities` holds one row per facility and program link, so rows sharing an `FRSNumber` merge into one facility with its NAICS codes, SIC codes, and program IDs gathered. A criminal case number (`CR_1270`) is answered like an unknown one, so the tool rejects it as `criminal_case` before any request.

`sdw_rest_services.get_systems` parameters the `has_violation` lookup sends: `p_st` (the system's location, not its primacy agency: WA returns 166 systems, 40 of them under EPA Region 10 primacy, which the search then drops), `p_systyp` (`CWS`, `NTNCWS`, `TNCWS`), `p_pid` (up to 200 comma-separated PWSIDs), `p_cs=H,M,O,P,S` (every current-violation category but `N`), and `responseset=1000`; `get_qid` with `qcolumns=2,57` returns each PWSID and its `CurrVioFlag`. `get_systems` echoes no parameters, so the lookup checks each row's flag instead: a row without `CurrVioFlag` `1` means ECHO dropped `p_cs`, and the call fails with a non-retryable InternalError.

ECHO reports a failed query as HTTP 200 with `{"Results":{"Error":{"ErrorMessage":"…"}}}`; `get_case_report` puts the same object at the top level, outside `Results`. `EchoService.fetchJson` classifies the message; HTTP 5xx keeps the framework's status classification and is retried. A 200 body that is not JSON fails once as a SerializationError, since the same body would come back.

| `ErrorMessage` | Endpoints | Classification |
|:--|:--|:--|
| `ID <id> is invalid.` | `get_dfr` | NotFound, not retried; `getFacility` rethrows it as `facility_not_found` with `registryId` |
| `Case Number or Activity Id <id> is invalid.` | `get_case_report` (top-level `Error`) | NotFound, not retried; `getCase` rethrows it as `case_not_found` with `caseId` |
| `QueryID <n> not found in ECHO.` | facility and case `get_qid` | ServiceUnavailable with `data.retryable: false`, not retried |
| anything else | any | retryable ServiceUnavailable |

A PWSID, TRI facility ID, NPDES permit, or RCRA handler ID is a valid `get_dfr` `p_id` that resolves to its Registry ID, so it is not a not-found case and takes one request, with no `sdw_rest_services` hop: PWSID `WA5389080` resolves to registry `110049537202` and its 899 drinking-water violations.

**Decision: no classification for the queryset-limit message.** `Rows Returned would be <n>. Queryset Limit would be exceeded…` comes only from `get_facilities` (`p_st=CA`: 986,998 rows), which no tool calls; the same state through `get_facility_info` answers in 39–42 s. A reason for it would be a contract entry no tool can reach; should ECHO ever send it to a search, it surfaces as a retryable ServiceUnavailable carrying ECHO's text.

### Envirofacts DMAP REST

| Noun | Operations | Table(s) |
|:-----|:-----------|:---------|
| TRI Facility | filter by state/county, joined to its reporting forms in one request per page | `tri.tri_facility` |
| TRI Release | get by `tri_facility_id` and/or year; per-medium quantities by `doc_ctrl_num` | `tri.tri_reporting_form`, `tri.tri_release_qty` |
| Superfund Site | search by state, city, ZIP, or NPL status | `sems.envirofacts_site` |
| Drinking Water System | search by state, ZIP, or county served (joined to the counties it serves); current violators come from ECHO and are matched by `pwsid in` | `sdwis.water_system`, `sdwis.geographic_area` |

URL format: `https://data.epa.gov/dmapservice/{schema}.{table}/{column}/{operator}/{value}[/sort/{schema}.{table}.{column}:{asc|desc},…]/[{first}:{last}]/json`
Operators: `equals`, `notEquals`, `lessThan`, `greaterThan`, `beginsWith`, `contains`, `in`
Combine filters: `/and/` or `/or/`
Join: `…/{filters}/join/{schema}.{table}/{leftColumn}/equals/{rightColumn}/and/{filters}/{first}:{last}` is an inner join. Filters before `join` bind to the first table only (DMAP rejects a column that table lacks: `The column, tri.tri_facility.reporting_year does not exist`); filters after the join comparison bind to the joined table; the range counts joined rows, returned in first-table order with both tables' columns.
Default format: JSON. Append `/csv` etc. for other formats.
Sort: `/sort/{schema}.{table}.{column}:{asc|desc},…` between the filters (or join) and the row range. Keys are table-qualified, because DMAP resolves a bare column against the first table of a join.
Max timeout: 15 minutes. Paginate with positional `first:last`: rows are 1-based and inclusive (`1:50` is 50 rows), and a `first` of 0 reads as row 1, so `0:49` returns 49. A list tool reads `offset + 1 : offset + limit + 1`, one row more than it returns, so `nextOffset` is exact.
A 200 body that is not JSON fails once as a SerializationError and is not retried; transport and HTTP failures keep their retries.

**Verified column names** (probing revealed several obvious guesses are wrong):

| Table | Correct column | Notes |
|:------|:--------------|:------|
| `tri.tri_facility` | `state_abbr` | State filter |
| `tri.tri_facility` | `county_name` | County filter (`contains`, case-insensitive). Bare names (`KING`, never `KING COUNTY`); some states also store a suffixed form (`CALCASIEU PARISH`, `FAIRBANKS NORTH STAR BORO`). There is no `county` column |
| `tri.tri_facility` | `tri_facility_id` | Primary key, join to `tri.tri_reporting_form` |
| `tri.tri_facility` | `epa_registry_id` | 12-digit FRS Registry ID, the `registry_id` `epa_echo_get_facility` takes (`registryId`) |
| `tri.tri_facility` | `standardized_parent_company` | Parent company as TRI standardizes it; `NA` when the facility reported none, which the tool leaves out |
| `tri.tri_reporting_form` | `tri_facility_id` | Join from `tri_facility` |
| `tri.tri_reporting_form` | `reporting_year` | Year filter (string: `"2022"`) |
| `tri.tri_reporting_form` | `tri_chem_id` | Chemical or category ID; `N150` (dioxin and dioxin-like compounds) is reported in grams |
| `sems.envirofacts_site` | `fk_ref_state_code` | State filter |
| `sems.envirofacts_site` | `npl_status_code` | `"N"` = not listed, `"NPL"` = listed |
| `sems.envirofacts_site` | `site_id` | Primary key, and the sort key of every administrative and proximity-candidate read |
| `sems.envirofacts_site` | `zip_code` | Some sites store a ZIP+4 (`07631-2720`), so a ZIP filter is `beginsWith` |
| `sdwis.water_system` | `primacy_agency_code` | 2-letter state code, or the EPA region code `01`–`10` for tribal systems |
| `sdwis.water_system` | `pws_type_code` | `CWS`/`NTNCWS`/`TNCWS` |
| `sdwis.water_system` | `pws_activity_code` | `A` active; `active_only` filters on it |
| `sdwis.water_system` | `zip_code` | The address of record, stored as a 5-digit ZIP, a ZIP+4 (`98104-3122`), or nine digits (`985093400`), so a ZIP search is `beginsWith` |
| `sdwis.water_system` | `pwsid` | Primary key, and the sort key of every water-system page |
| `sdwis.geographic_area` | `county_served` | One comma-joined value of the counties a system serves (`Dallas,Johnson`), bare in most states and suffixed in others (`Calcasieu Parish`); `pwsid` joins it to the system |

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

`get_dfr` takes a Registry ID or a program ID (a PWSID, TRI facility ID, NPDES permit, or RCRA handler ID resolves to its Registry ID). `get_facility_info` ignores `p_id`, so step 2 passes the confirmed Registry ID as `p_frs`, which returns the one facility row directly with no `get_qid` follow-up. No DFR section carries the facility-level status that `epa_echo_search_facilities` reports, which is why step 2 exists.

| Output | `get_dfr` source |
|:--|:--|
| name, address, coordinates | the `Permits[]` record with `EPASystem` `FRS` (coordinates fall back to `SpatialMetadata`) |
| `county`, `fipsCode` | the first `Permits[]` entry with a non-null `FacilityCountyName` / `FacilityFipsCode` ("King County", "53033"; the FRS entry carries null), else the step 2 row's `FacCounty` / `FacFIPSCode` / `FacDerivedStctyFIPS`. `Permits[]` comes first so the value does not depend on whether step 2 succeeded |
| `programs.*` | `Permits[].EPASystem`: `ICIS-Air`, `ICIS-NPDES`, `RCRAInfo`, `TRI`, `SDWIS` |
| `triFacilityIds` | `SourceID` of the `TRI` permits, ordered by the year in `FacilityStatus` ("Last Reported for 2024"), newest first |
| `triReleasesTransfersInLbs`, `triReleasesTransfersYear` | `TRIHistory.Sources[].ReleaseYear[]`: the latest `Year`, its comma-formatted `TotalReleasesTransfers` summed |
| `naics[]` | `NAICS.Sources[].NAICSCodes[]`: each code once, ascending by code, with the first description recorded for it (programs can record different codes for one site) |
| `programCompliance[]` | `EnforcementComplianceSummaries.Summaries[]` with `ProgramDates[]`; rows with no values (a statute the facility has no record in) are dropped |
| `inspections[]`, `inspectionsTotal`, `inspectionsNextOffset` | `ComplianceHistory.Inspection[]`, newest first, ties ordered by statute, source ID, activity type, inspection type, lead agency, and finding because records carry no ID (`ActivityType` → `category`, `InspectionType` → `activityType`); one page of `inspections_limit` from `inspections_offset`, `inspectionsTotal` counting every record |
| `drinkingWaterViolations[]`, `drinkingWaterViolationsTotal`, `drinkingWaterViolationsNextOffset` | `ViolationsEnforcementActions.Sources[].Violations[]`, newest compliance period first with the descending `ViolationID` as tiebreak; one page of `drinking_water_violations_limit` from `drinking_water_violations_offset`, the total counting every violation |
| `formalActions[]` | `FormalActions.Action[]`, newest first; `caseId` and `settlementDate` from the `CaseFormalActions.Action[]` entry with the same statute, source ID, and issue (or, when the issue date is absent or the `01/01/0001` placeholder, settlement) date; among same-day cases, the one whose settled federal + state/local penalty equals the action's penalty |
| `airCompliance`, `waterCompliance` | the CAA / CWA `programCompliance` row; `programId` / `permitId` only when the facility has exactly one ICIS-Air / ICIS-NPDES record |

Program flags key on `EPASystem` rather than `Statute`: `EIS`, `CEDRI`, `RMP`, and `GHGRP` entries carry `Statute` `CAA` without an ICIS-Air compliance record, and a TRI entry's statute is `EP313`.

Step 2 gets two attempts and at most 10 seconds of the call's budget (see Request deadlines). When it fails, the profile returns without those two fields and an enrichment `notice` says so (the `epa://facility/{registry_id}` resource carries it as a `notice` field); caller cancellation still aborts the call.

**Decision: one `get_dfr` response, not five DFR endpoints.** The earlier design called `get_compliance_summary`, `get_inspection_enforcement`, `get_air`, and `get_water`. The last three are not in ECHO's DFR OpenAPI spec (`swaggerx.swagger_json?p_prefix=DFR`) and answer HTTP 500, so each was retried four times and dropped, and `get_compliance_summary` returns a shape the normalizer never read. For registry `110017848105` that took 10.2 seconds and 14 requests and returned empty compliance, inspections, and actions; `get_dfr` already carries all of it, and the two-request flow takes 1.1 seconds.

**Decision: page `inspections[]` and `drinkingWaterViolations[]` locally, 100 and 50 by default.** Both lists come from the one `get_dfr` response, and either can run to hundreds: a Texas refinery carries 581 state compliance investigations in five years (`110041990913`, 129 KB unbounded), and the 27-person system `WA5389080` lists 899 drinking-water violations. A page of 50 violations measures 17.6 KB of `structuredContent` and 9.2 KB of `content[]`, 500 measures 264 KB, so the cap is 200 (about 100 KB on both surfaces) and the inspection cap is 100. Each list sorts on a total order (a content tiebreak for inspections, `ViolationID` for violations), so every page of a re-sliced list holds the same entries, and `*Total`, `*NextOffset`, and an enrichment `truncated` disclose what a page leaves out.

### `epa_echo_get_case` (1 upstream call)

`case_rest_services.get_case_report?p_id={caseId}` returns the whole case, so the tool makes one request and does not page: the largest report measured (`TX000A300485682003235`, 115 facilities and 117 settlements) is 1.38 MB upstream and about 120 KB of tool output across `structuredContent` and `content[]`. A criminal `CR_` number fails as `criminal_case` before the request, since ECHO's civil report rejects it like an unknown ID; any other unknown number fails as `case_not_found`.

| Output | `get_case_report` source |
|:--|:--|
| `caseId`, `caseName`, status, outcome, dockets, summary, penalty and cost totals | `CaseInformation` (`caseId` is its `CaseNumber`) |
| `lawsAndSections[]`, `defendants[]`, `pollutants[]`, `milestones[]` | `LawsAndSections`, `Defendants`, `Pollutants`, `CaseMilestones` |
| `facilities[]` | `Facilities`: rows merged by `FRSNumber` in first-appearance order, the first row's name and address kept, NAICS and SIC codes gathered once each, every `ProgramId` with its `ProgramAcronym`; a row without an `FRSNumber` stands alone with no `registryId` |
| `enforcementConclusions[]` | `EnforcementConclusions`: `FacilitiesInSettlement` → `registryIds`, with `ComplyingActions`, `PollutantReductions` (`SEPorComp` `C` → complying action, `S` → supplemental project), and `SupplementalEnvironmentalProjects` |

### `epa_echo_search_facilities` + environmental justice chain

Typical agent chain:
1. `epa_echo_search_facilities(zip_code='98101', has_violation=true)` → list with `registryId`, `fipsCode`, `programs.tri`
2. `epa_tri_search_releases(state='WA', year=2022)` → TRI filings in the region (in reporting-year order, not ranked by quantity)
3. `epa_echo_get_facility(registry_id)` for a facility of interest, using the `registryId` the TRI search returns
4. [External] `census_query_data` using `fipsCode` → demographics of surrounding county
5. [External] `openstreetmap_query_nearby` using `latitude`/`longitude` → proximity of schools, hospitals

---

## Design Decisions

**Program-first names under `epa_`.** Tools use `epa_<group>_<verb>_<object>` so alphabetic lists cluster each program's tools. Group tokens are the names practitioners use: `echo`, `tri`, `superfund`, `water`, `airnow`, and `ejscreen`. Facility-scoped TRI retrieval uses `get_facility_releases` to distinguish it from regional `search_releases`. Resource URIs remain stable.

**Split TRI into two tools.** The original design had a single `epa_tri_get_facility_releases` that accepted either a facility ID or a state search — two very different query shapes with different outputs. The two are separate tools: `epa_tri_get_facility_releases` (facility-scoped, detailed release breakdown) and `epa_tri_search_releases` (area search, lists filings in reporting-year order). Cleaner inputs, clearer use cases.

**`epa_echo_search_violations` vs `epa_echo_get_facility` separation.** `epa_echo_search_violations` is for area-level enforcement discovery (what cases have been filed in WA under RCRA?). `epa_echo_get_facility` includes the enforcement history for a single known facility. The descriptions explicitly cross-reference each other.

**`epa_echo_search_facilities` uses ECHO, not DMAP.** ECHO's `get_facility_info` returns cross-program compliance status in a single call. DMAP's individual program tables require separate queries per program. ECHO is the right API for facility discovery.

**State codes: the DMAP searches check membership, the ECHO searches check only the form.** Every search takes one trimmed, uppercased 2-character `state`. The TRI, Superfund, and water searches also reject a code outside the shared set (the states, DC, the territories and freely associated states, UM, NN, and the region codes `01`–`10`) as `invalid_state` before any request: a `notIn` over that set returns no rows in `tri.tri_facility`, `sems.envirofacts_site`, or `sdwis.water_system`, so such a code could only answer empty. ECHO files real records under other codes (3,791 offshore Gulf of Mexico platforms under `DM`, plus Canadian provinces, `MX`, and placeholders such as `XX`), so the two ECHO searches send any 2-character code as written, and one ECHO holds nothing under is an empty result. A comma- or space-separated list of states or ZIP codes, which ECHO reads as a multi-value filter, is rejected by the schema on both ECHO searches.

**`programs` takes one program.** ECHO's `p_med` filters on a single media code; a comma list is echoed but not applied, and a repeated parameter keeps only the first. Running one search per program and merging would make `totalCount` and the result page ambiguous, so the schema caps `programs` at one entry. It stays an array so existing single-program calls keep their shape.

**`has_violation` is significant noncompliance (`p_cs=3`).** The input promised "significant violations", and `p_cs=3` returns exactly the rows whose `complianceStatus` is "Significant Violation" (ZIP 98108: 18 of 1,322; `p_cs=2`, any noncompliance, adds 47 "Violation Identified" rows). ECHO's quarter filter `p_qiv` and the old `p_sv_flag` did not change the count.

**A filing-date range returns civil cases only.** `p_from_date`/`p_to_date` alone match any milestone date, so they need `p_milestone=CMF,CPOA` to bound the filing date, and those milestones exist only on civil cases. Rather than run a second criminal search with a different date meaning, a date-bounded `case_type: "all"` returns civil cases with an enrichment `notice` saying criminal cases were excluded, and `case_type: "criminal"` with a date is rejected before any request.

**`epa_echo_get_case` is its own tool.** A case search row names no facility, and a case can name over a hundred facilities and as many settlements (`TX000A300485682003235`: 115 facilities, 117 settlements). A report that size does not belong on a list row, so `get_case_report` backs a separate tool that returns each facility with the Registry ID `epa_echo_get_facility` takes, which makes `epa_echo_search_violations` → `epa_echo_get_case` → `epa_echo_get_facility` the path from an enforcement case to the facilities it concerns.

**Every list pages with `offset` and `nextOffset`, and `limit` clamps at a 5,000 hard ceiling.** Each tool has a cap sized to its response (100 facilities measure about 60 KB, 100 cases about 36 KB). A `limit` above the cap and within 5,000, the largest page the upstreams serve, returns the cap with a `limitNotice`; above 5,000 it fails the schema. `nextOffset` is present exactly when more records follow, and it is an upstream or candidate position, so after a punctuated text filter, a county test, or a violation check it can advance past rows the page dropped. Cap guidance names `nextOffset`, never a larger `limit`.

**ECHO searches re-run discovery on every call.** A call sends `responseset` = `limit` and reads `get_qid` page `offset / limit + 1`, plus the next page when `offset` is not a multiple of `limit`. No `QueryID` is carried between calls: the server runs stateless, ECHO can answer a `QueryID` it no longer holds with an error (`QueryID <n> not found in ECHO.`), and it serves the same row order across discovery runs and page sizes (ZIP 98108, rows 200–299: identical at `responseset` 100 and 50). Discovery costs one request per call, and the inline rows ECHO sends for a small match stand in for page 1.

**`effectiveQuery` is built from what the server sent.** Each search tool echoes its filters in its own input names, with the normalized values, how each text filter matched (`=`, `contains`, `begins with`, `has words`), and the defaults that change what comes back. The echo never comes from ECHO's `QueryParameters`, which lists values ECHO ignored (`p_med=A,W`) and defaults the server never sent (`p_name_type=ANY`), so it would state a search the server did not run. `include_release_breakdown` is not echoed: it changes the fields, not the matches.

**EJScreen coverage is decided from coordinates against EJAM's bounds.** EJAM answers a single-site lookup outside its bounds with an R error returned as HTTP 400, which is indistinguishable from other failures. `EjscreenService` applies EJAM's own validity test (`latlon_is.valid()`: latitude 17.5–71.5 with longitude at or west of −64 or at or east of 172, which encloses the 50 states, DC, and Puerto Rico, plus the Guam, Northern Mariana Islands, U.S. Virgin Islands, and American Samoa boxes) and answers an outside point with `coverage.valid: false` and a note, without a request. For an in-bounds point, a buffer with no Census block and one whose blocks hold no residents are also `coverage.valid: false`, each with its own note and a larger-distance hint only below 15 miles; the second keeps state, population, and block-group count. An HTTP 400 for an in-bounds point is the server's own `upstream_rejected` message, with EJAM's R text only in `error.data.upstreamMessage`; a 200 body that is not JSON fails once as a SerializationError.

**`epa_tri_get_facility_releases` uses DMAP, not ECHO.** ECHO shows TRI totals in facility search results but not per-chemical-per-medium breakdowns. DMAP's `tri.tri_reporting_form` has the chemical name and reporting year of each annual filing, and `tri.tri_release_qty` its per-medium quantities, joined on `doc_ctrl_num`.

**Every TRI read sorts newest reporting year first, then by submission number.** Both TRI tools send `NEWEST_FIRST` (`reporting_year:desc`, `doc_ctrl_num:asc`), a single-year read included, so a row range pages on the unique `doc_ctrl_num` rather than on DMAP's unsorted order. `epa_tri_get_facility_releases` returns 500 filings by default and at most; `truncated`, `shown`, `cap` (the limit applied), and `guidance` disclose a page with more on both response surfaces, and `nextOffset` continues it. Cap guidance has its own field so a punctuation-scan `notice` survives. Empty TRI results remain successful messages, with hints tailored to the supplied filters and earlier accepted years rather than an unchanged retry.

The sort consumes 88 request-line bytes on every TRI read. Near-limit filters that fit an unsorted request can therefore exceed DMAP's 4,094-byte bound; shorten them when the validation message (`filter_too_long`) reports that limit.

**`epa_tri_search_releases` is one request per page.** `tri.tri_reporting_form` carries no state or county column, so the search joins it to `tri.tri_facility` in one DMAP URL: state and county filters on the facilities, year and chemical filters on the forms, and `offset + 1 : offset + limit + 1` over the joined rows, which also carries each facility's Registry ID and parent company. The earlier design walked the state's facilities 50 at a time, two requests per batch, until `limit` records turned up — a sparse filter in a large state never stopped (`TX`, 2022, limit 200 ran past 400 seconds; `WA`, 2022, limit 200 took 20 requests and 30 seconds). Joined, those take one request: about 5 seconds for Texas and 4 for Washington, and the plain `WA` search drops from two requests to one. A bounded walk with a partial-scan notice was the alternative; the join returns every match in the state without one.

**The search sorts newest first, with or without `year`.** DMAP returns joined rows in table order, which puts a state's oldest filings first: `AK` limit 50 came back as one facility's 1988–1994 forms. The URL carries `/sort/tri.tri_reporting_form.reporting_year:desc,tri.tri_reporting_form.doc_ctrl_num:asc` between the join filters and the row range, so `limit` keeps the most recent filings. Sorting keeps the documented "all available years" meaning of an omitted `year`; defaulting to the latest year would have changed it. The keys are table-qualified because DMAP resolves a bare column against the first table of the join (`reporting_year` there is HTTP 500), and the `doc_ctrl_num` tiebreak makes ranges page deterministically (on year alone, `AK` rows `1:50` and `51:100` shared 36 records). A single-year read sends the sort as well, so no TRI page depends on table order.

**The per-medium breakdown is opt-in on `epa_tri_search_releases`.** It costs one batched `tri.tri_release_qty` request after the search request. That request takes about 20 seconds when DMAP has not cached it (about 1 second when it has), against a 2–5 second search, so `include_release_breakdown` defaults to false and its description states the cost. The option adds fields to each record and never changes which records match, so `effectiveQuery` does not echo it.

**TRI quantities follow Form R: per-medium on-site releases, their total, and a separate one-time quantity.** `oneTimeReleaseInLbs` is Form R Section 8.8, releases from remedial actions, catastrophic events, and other one-time events not associated with production. Section 8.8 reports it separately, but it is already counted in the Section 5 per-medium releases and the off-site transfers, so the tools never add it to them. `totalOnSiteReleasesInLbs` sums the per-medium fields present (Form R Sections 5.1–5.5.4); a medium TRI recorded only as a range code stays out of the fields and the sum, where TRI's published on-site total counts the range's midpoint. The land rollup takes every `tri.tri_release_qty` land code, including `SI 5.5.3A` (RCRA Subtitle C surface impoundment) and `SI 5.5.3B` (other), which Form R used in place of the single `SURF IMP` line from reporting year 2003; no submission carries a quantity on both lines. A TRI search returns filings in reporting-year order, so neither tool ranks facilities by quantity.

**The breakdown's `doc_ctrl_num` list is split to fit DMAP's request line.** DMAP's front end refuses a request line over 4,094 bytes with HTTP 400 ("Request Line is too large"). Each 13-digit submission number adds 16 bytes to the `in` list, so a facility with a few hundred filings overflowed it: Boeing Field (`98108THBNG7500E`, 375 forms) failed without `year`. The list is packed into requests whose request line stays within 3,800 bytes (about 230 submissions each), and their rows merge into one rollup. An uncached `tri.tri_release_qty` request takes about 18 seconds however many submissions it names, so three chunks run serially, plus the forms request, would outlast a client's 60-second timeout. The chunks therefore run side by side, three at a time, which covers the 500-form cap of `epa_tri_get_facility_releases` in one wave (Boeing Field: two chunks, about 19 seconds uncached), inside the call's DMAP deadline (see Request deadlines). A DMAP HTTP 400 comes only from that front end, never from a filter value (those are HTTP 500), so it maps to `InternalError` rather than to an invalid-argument error that would blame the caller for a URL this server built.

**Text filters that DMAP can't carry are rewritten to its wildcard and matched exactly afterward.** DMAP puts filter values in the URL path and parses them after decoding, and in a value it reads only letters, digits, space, `-`, `_`, `?`, and `@` (probed live). Every other punctuation character and every non-ASCII letter is HTTP 500 "The query could not be parsed", which would be retried four times and reported as an upstream outage, and `%` is an nginx HTTP 403. A comma silently ends the value, so `contains/1,3-Butadiene` matched every chemical containing "1". Real names need these characters: 349 of the 860 TRI chemical names (`Michler's ketone`, `Benzo[g,h,i]perylene`, `γ-ω-perfluoro` names), 57 TRI county names (`PRINCE GEORGE'S`, `BALTIMORE (CITY)`), and Superfund cities (`ST. LOUIS`, `COEUR D'ALENE`). In a `contains` value, `_` matches any one character, so each such character becomes `_` and the rows are then narrowed to those containing the text as given; a `_` the caller wrote gets the same exact pass, so `C_12` does not also match `C112`. That keeps the search faithful rather than approximate. Across every TRI chemical and county name, the wildcard form of a name matches no other name. Superfund city names carry spelling variants (`COEUR D ALENE` beside `COEUR D'ALENE`) that the exact pass drops, so a punctuated search reads pages of at least 100 rows, up to three, until it has `limit + 1` exact matches (the extra one makes `nextOffset` exact: it is that match's upstream position, which can skip rows the exact pass dropped), and says so in a `notice` when the third page ends the walk short, with `nextOffset` where the walk stopped (live, TX `chemical_name` `C.I.`: three pages, 3 records kept, while TX holds at least 36 matching filings). Exact-value filters (state, ZIP, TRI facility ID, Superfund site ID) have no wildcard rewrite, so a character DMAP cannot match there fails before any request as a validation error (`unmatchable_filter`) naming it; for a comma, the error says to pass one value per call. A filter with no letter or digit fails the same way, and every DMAP input rejection carries a `reason` and a recovery that the tool declares in its `errors[]`. Because DMAP splits its path after decoding it and drops empty segments, a slash at either end of a value never reached the filter (`98108THBNG7500E/` and `/98108THBNG7500E` answered as the bare ID), so end slashes are dropped from every filter value before it is checked; a slash inside a value is still rejected.

**Text filters are bounded at DMAP's request-line limit.** DMAP's front end counts 11 bytes fewer than the client's request line and refuses a count over 4,094 (live: a 4,105-byte line is answered, a 4,106-byte one is "Request Line is too large (4095 > 4094)"), so a request is checked against that count before it is sent, and one over it fails as `filter_too_long`. `chemical_name`, `county`, and Superfund `city` are bounded at 4,094 characters: every request line is longer than its filter value, so a longer value could never be sent, and the bound rejects nothing DMAP could answer. A tighter bound near the longest real names (542, 31, and 57 characters) would reject calls DMAP answers with a correct empty result, such as a Superfund `city` of 3,990 letters, the longest a sorted request line carries at `limit` 1.

**Dioxin quantities are converted from grams to pounds.** EPA's TRI program has facilities report dioxin and dioxin-like compounds (TRI chemical ID `N150`) in grams and every other chemical in pounds (TRI Basic Data Files documentation, `UNIT_OF_MEASURE`). DMAP's `tri.tri_reporting_form` and `tri.tri_release_qty` carry no unit column, so `tri_chem_id = N150` is the marker on their rows (`tri.tri_chem_info.unit_of_measure` records `Grams` for N150, the only gram-reported chemical). The TRI tools divide those quantities by 453.59237 and set `reportedUnit: "grams"` on the record, rather than passing grams through: every quantity field is named and described in pounds, and an agent summing or ranking releases across chemicals would otherwise mix units. The marker lets a reader reconcile the value with EPA's gram figures. Per-medium sums and conversions are rounded to 12 significant digits, the precision `formatLbs` renders, so both output surfaces carry the same number.

**`has_violation` on `epa_water_search_systems` uses ECHO's current SDWA violation flag, not SDWIS's unresolved-violation rows.** ECHO's flag is the compliance status EPA reports for a system: it applies the Enforcement Response Policy, so it clears systems that SDWIS still lists with unresolved violations, some of which ECHO reports as "No Violation Identified". `sdwis.water_system` has no violation flag, and a scan of the unresolved rows in `sdwis.violation` would flag those systems and could read only a capped slice of a table far larger than the cap. `sdw_rest_services.get_systems` with `p_cs=H,M,O,P,S` returns a state's whole current-violator list in one lookup (WA: 166 systems, 40 under EPA Region 10 primacy). With `state` alone the tool takes that list first, in PWSID order, and reads each 200-PWSID slice from `offset` through `sdwis.water_system` with the search's own filters, so `state` stays a primacy-agency filter (WA's Region 10 systems drop out) and `active_only` applies. It stops once `limit + 1` systems are kept; `nextOffset` is the list position of the first one left over, and `totalCount` is exact when the walk read the whole list from position 0.

**A water system's ZIP is its address of record.** `sdwis.water_system.zip_code`, like its `state_code`, is the owner's or operator's address, not the service area: ZIP 98104 (Seattle) returns Alaska and Montana systems run from Seattle offices. SDWIS also stores ZIP+4 and nine-digit forms beside 5-digit ZIPs, so the filter is `beginsWith`. The `zip_code` input says so rather than promising a geographic search; `county` is the input for the systems serving an area.

**A ZIP's or county's violation check runs by PWSID.** ECHO's violator list cannot be filtered by ZIP or county served, so those searches read the match first: up to 1,000 rows of the PWSID-ordered `sdwis.water_system` match from `offset`, one request, keeping the rows that pass the county test. They then ask ECHO about those PWSIDs 200 at a time (`p_pid`) until `limit + 1` violators are found, and `nextOffset` is the row position of the first one left over. A full 1,000-row read that leaves the page short has rows past it unchecked, so a `notice` says so and `nextOffset` is the next row. `totalCount` is exact when every row from position 0 was checked. Measured ZIPs hold far fewer systems (98104: 10, 59901: 194) and King County, WA 519, so one read covers most checks. The PWSID check is exact, and it replaced rejecting a ZIP-only `has_violation` call.

**The water `county` filter is a whole-entry match.** `sdwis.geographic_area.county_served` is one comma-joined value per system (`Dallas,Johnson`), bare in most states and suffixed in others (`Calcasieu Parish`), and DMAP's `equals` cannot carry a period (`St. Tammany`). The search therefore joins the table on `pwsid`, filters by `contains` (wildcarded for punctuation), and keeps a row only when one of its entries, county suffix dropped, equals the county itself. A plain `contains` would match `HARRIS` inside `Harrison`, and `BALTIMORE` inside `Baltimore city`; the whole-entry test keeps neither. The county suffixes dropped are County, Parish, Borough, City and Borough, Census Area, and Municipality (`src/services/county-name.ts`), so `Anchorage` matches Anchorage Municipality and `Juneau` keeps no `CITY AND`.

**Superfund and drinking water systems via DMAP.** ECHO's CERCLA data is summary-level, and its SDWA data is a compliance status. DMAP's `sems.envirofacts_site`, `sdwis.water_system`, and `sdwis.geographic_area` tables have the full records; ECHO supplies only the current-violation flag.

**Superfund status follows source codes and labels.** `listed` maps to `F,A` (final or part of an NPL site); `not-listed`, `proposed`, `deleted`, `removed`, and `withdrawn` map to `N`, `P`, `D`, `R`, and `W`. Search and detail preserve `npl_status_name`, `non_npl_status_name`, `archived_ind`, `epa_id`, and `federal_facility_ind` when present. Non-NPL assessment is not cleanup progress. Archive exclusion is opt-in and requires `archived_ind=N` upstream before pagination and proximity selection, retaining existing broad results by default.

**Superfund detail keeps search inexpensive and the resource compatible.** `epa_superfund_get_site` and `epa://superfund/{site_id}` share an exact site-ID lookup followed by `sems.envirofacts_contaminants/fk_site_id/equals/{id}`. Missing site is NotFound; an existing site without associations succeeds with an empty array. The tool returns `{ site, contaminants }`; the JSON resource retains top-level site fields and adds `contaminants`. Contaminants are read in 100-row pages to exhaustion under the same 50-second budget as the site lookup, ordered by the qualified preferred name, medium, operable unit, action, type code, and seq columns. `seq` is not unique; equal full tuples and repeated chemicals are retained without deduplication. Sparse association fields stay absent, and operable-unit strings retain leading zeros. These action/media associations establish neither current exposure nor concentrations. Search does not fetch contaminants for each result.

**`epa_superfund_search_sites` accepts lat/lng + radius.** The tool accepts either state/city/ZIP or coordinates + radius. Supplying any proximity field requires all three; latitude+longitude without radius retains `radius_required`, and other partial triples return `incomplete_proximity` before administrative fallback. Superfund and AirNow bound every supplied latitude to [-90, 90] and longitude to [-180, 180], including coordinates alongside an AirNow ZIP. Valid AirNow ZIPs retain precedence over valid coordinates; a blank ZIP falls through to coordinates. A call combining a valid ZIP with impossible coordinates is rejected by schema validation.

**Administrative Superfund searches read in SEMS site ID order.** A row range pages deterministically on SEMS's unique site key, where DMAP's unsorted order gives no such guarantee: NJ's 2,217 rows carry 2,217 distinct site IDs, and the sort costs nothing measurable on a 201-row page (3.09 s sorted, 3.11 s not). DMAP reports no match count, so `totalCount` is absent on these searches and `nextOffset` is an upstream position.

**Superfund proximity exhausts a spherical prefix cover before ranking.** DMAP rejects decimal comparison literals and compares coordinates as text, so numeric bounding boxes can omit valid sites. Conservative signed integer-degree prefixes cover the spherical latitude and longitude bounds, including both zero signs and overlapping digit widths. Longitude intervals wrap at the antimeridian; a circle reaching either pole omits longitude filtering. Up to four longitude prefixes use serial latitude/longitude partitions with 500-row pages. More longitude prefixes use latitude-only partitions with 2,000-row pages and at most eight concurrent partitions: this avoids hundreds of mostly empty Cartesian queries at broad radii while preserving selective reads for narrow circles. Pages within each partition remain sequential in qualified `sems.envirofacts_site.site_id:asc` order. All requests, retries, and backoffs share one 50-second deadline. A fatal failure aborts and awaits sibling work; caller cancellation propagates. Exact punctuation matching, site-ID deduplication, and Haversine filtering preserve the supplied administrative/NPL filters; only exact-radius matches retain full records between pages. Every call rescans the whole match and ranks it nearest first with a site ID tiebreak, so `offset` and `nextOffset` page one order, `totalCount` is the match, and the `notice` places the page in it ("Showing sites a–b of N matching Superfund sites within the radius, nearest first."). Every proximity success, empty or nonempty, discloses that only sites with usable coordinates can match and administrative searches can find sites without coordinates. A repeated page fails as ServiceUnavailable, and deadline expiry remains Timeout rather than a partial success. Near Newark (40.7357, -74.1724), a 5-mile query retains all 203 nearby sites from a complete 2,476-row latitude-band reference in 1,009 candidate rows; Seattle retains all 15 nearby sites in 138 candidates.

The coordinate predicates and site-ID sort consume request-line space. Combined city/proximity queries can reject a text filter that fits a search without coordinates; shorten the filter as the validation message directs. A search without coordinates carries the site-ID sort alone, which leaves its longest city 3,990 letters at `limit` 1. For latitude 47.6, longitude -122.3, and radius 25 miles, the longitude predicate and sort add 89 bytes: an ASCII city filter accepts 3,891 characters and rejects 3,892, versus the latitude-only search's 3,980-character boundary.

**No AirNow history tool.** AirNow's rate limits make bulk historical queries impractical. AirNow itself recommends not using the API to build historical databases. Historical air quality data is better sourced via NOAA or EPA's AQS system. Deferred. AirNow's 2026 services add daily reporting-area history by state (from July 2017) and site-level daily data by bounding box, which removes the rate-limit objection but not the rest: the Data Exchange Guidelines bar AirNow data from trend analysis and point to AQS for validated history, so historical tools belong to an AQS integration (`epa_aqs_*`), not to AirNow.

**No GraphQL API.** DMAP offers a GraphQL-like API for more complex queries. Deferred — the REST table service covers all target use cases without the additional query composition complexity.

**`epa_water_search_systems` searches a list.** The verb `get` implies retrieving a single known item by ID. This tool searches across multiple systems, so it uses `search`.

---

## Known Limitations

- **AirNow rate limits**: Rate-limited by key per hour. Caching responses at ~1 hour TTL is strongly recommended. Data is preliminary — not valid for regulatory or trend analysis.
- **DMAP column name fragility**: The DMAP REST API requires exact column names in URL paths. Column names differ by table and aren't documented in a machine-readable schema. Verified column names are recorded in the Domain Mapping section above.
- **ECHO geographic scoping required**: Unscoped ECHO searches return millions of rows and time out. All search tools enforce at least one geographic parameter at the input validation layer.
- **TRI data lag**: TRI reporting year N data becomes available approximately Q1 of year N+2. The most recent available year is typically 2 years behind the current calendar year.
- **Superfund proximity has a shared deadline**: broad or polar searches can time out before every candidate page is read; narrow the radius or add filters. Successful searches report the matching count and continue with `nextOffset`; missing upstream coordinates cannot be distance-filtered.
- **Coordinate encoding inconsistency**: `tri.tri_facility` encodes lat/lng as DDMMSS integers (e.g., `482730` = 48°27'30"); `sems.envirofacts_site` uses decimal degrees. Only the SEMS coordinates are exposed today; a tool that returns TRI facility coordinates must convert DDMMSS first.
