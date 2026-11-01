---
name: epa-guide
description: Combine epa_* tools for neighborhood environmental screening, facility compliance and toxic-release investigations, or regional release comparisons. Use when findings from ECHO, TRI, Superfund, drinking water, and EJScreen must be connected without confusing identities, geographic coverage, or reporting periods.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.1"
---

## Scope

Use this guide when an investigation crosses EPA programs or compares facilities. A facility compliance record, a chemical release filing, a cleanup site, and a drinking-water system describe different entities; sharing a place name does not establish a relationship.

## Gates

- Before joining findings, establish the facility or site identity and the geographic area each result actually covers. An enforcement case search row names no facility; take a facility's Registry ID from `facilities[].registryId` of `epa_echo_get_case` on a civil case, never from a case name or docket number. A criminal case has no case report.
- Before comparing TRI quantities, choose a reporting year and quantity category. ECHO's releases-and-transfers summary, the Form R Section 8.8 one-time quantity (already counted in the per-medium releases), and on-site releases by medium with their total are different measures. Do not substitute one for another, add the one-time quantity to the media, or count the same summary and detail twice.
- Before naming an area's largest emitter, check result caps and notices. Regional TRI searches return filings in reporting-year order, not an emissions ranking. A page that carries `nextOffset` leaves records unexamined: page on with it, or describe the comparison as limited to the returned records rather than an area-wide ranking.
- Before attributing a water system's violation to a household or neighborhood, establish which system serves it outside this search. A matching operator address is not evidence of service-area coverage, and neither is a county match.
- Before drawing a cross-program conclusion, retain each source's reporting period and coverage qualifications. A missing field, capped search, or unavailable coverage cannot establish that a facility is compliant or that an area has no environmental concerns.

## Workflows

### Facility compliance and chemical releases

Discover the facility with `epa_echo_search_facilities`, by place, by name words, by county, or by NAICS code with a geographic filter; page a large match with `offset`. Then use `epa_echo_get_facility` to confirm its location and retrieve its compliance history. Search rows and the profile both carry TRI IDs for `epa_tri_get_facility_releases`; a facility can have IDs from successive operators. Choose the IDs relevant to the operator and reporting period being investigated rather than assuming the newest ID represents its entire history.

If the ECHO profile is unavailable, record the compliance gap and discover TRI IDs with `epa_tri_search_releases`; confirm the facility name and location before retrieving release detail. A TRI search row's `registryId` is accepted by `epa_echo_get_facility` for the compliance profile.

For a regional comparison, use `epa_tri_search_releases` with a common reporting year. Request the release breakdown when comparing on-site releases, check the returned county names, and narrow or page searches whose caps or notices leave coverage incomplete. Preserve the facility, chemical, year, and release category in the comparison so different filings do not become an unexplained facility total.

Use `epa_echo_search_violations` for area-level enforcement discovery, and `epa_echo_get_case` on a civil `caseId` to see the facilities, defendants, and settlements behind a case. For an already identified facility, use its profile's enforcement history; a formal action's `caseId` there opens the same case report. A regional case list is not an automatic join to the facilities returned by another search.

### Neighborhood environmental screening

Establish the actual point and radius, then use geographic ECHO and Superfund searches for nearby facilities and cleanup sites. Apply `epa_ejscreen_get_scores` to that same point and an explicitly chosen buffer. Keep the screening context separate from the individual facility records rather than treating the buffer's indicators as measurements at each facility.

Treat `epa_water_search_systems` as supplier discovery, followed by independent confirmation of the relevant service area. Its ZIP results are addresses of record, and its `county` filter lists the systems that serve a county, not the households they reach, so neither extends the nearby-facility map into a map of drinking-water exposure. A returned `pwsid` is accepted as `registry_id` by `epa_echo_get_facility`, which lists that system's drinking-water violations; they belong to the system, not to a facility with a similar name or address.

Report program findings separately with their dates and geographic scope. Add AirNow only when current air-quality awareness is part of the task and its tool is available; a current AQI observation cannot establish that a particular nearby facility caused it.
