# epa-mcp-server

EPA environmental data — Envirofacts, ECHO (facility compliance), and AirNow (real-time air quality).

## APIs

### Envirofacts
- **Base**: `https://enviro.epa.gov/enviro/efservice/`
- **Auth**: None
- **Docs**: https://www.epa.gov/enviro/web-services

### ECHO (Enforcement and Compliance History Online)
- **Base**: `https://echo.epa.gov/tools/web-services`
- **Auth**: None
- **Docs**: https://echo.epa.gov/tools/web-services

### AirNow
- **Base**: `https://www.airnowapi.org/aq/`
- **Auth**: API key (free registration)
- **Docs**: https://docs.airnowapi.org/

## Key data domains

- **Envirofacts**: Toxic Release Inventory (TRI), hazardous waste (RCRA), water discharge permits (NPDES), Superfund sites (CERCLIS), drinking water (SDWIS)
- **ECHO**: Facility compliance status, inspections, enforcement actions, penalties, permit violations
- **AirNow**: Real-time AQI by location, forecasts, pollutant breakdowns (PM2.5, ozone, NO2, CO, SO2)

## Cross-domain value

| Chain to | Query |
|---|---|
| Census | Toxic facilities → demographics of surrounding neighborhoods (environmental justice) |
| CDC | Pollution exposure → health outcome correlations |
| SEC EDGAR | Polluting companies → ESG disclosures, enforcement risk in filings |
| OpenStates | Environmental bills at state level |
| Congress | Federal environmental legislation |
| OpenStreetMap | Facility locations → nearby schools, hospitals, residential areas |
| NOAA | Climate data + pollution patterns |

## Tool ideas

- `epa_search_facilities` — find facilities by location, industry, pollutant
- `epa_get_facility` — detailed compliance profile
- `epa_search_violations` — enforcement actions, penalties
- `epa_get_tri_releases` — Toxic Release Inventory data by facility/chemical/year
- `epa_get_air_quality` — real-time AQI by location (AirNow)
- `epa_search_superfund` — Superfund site status and cleanup progress
- `epa_get_water_quality` — drinking water violations by system

## Licensing (audited 2026-05-25)

- **Status: Clear to host**
- US federal government data — public domain under 17 USC §105
- Envirofacts/ECHO: no auth required
- AirNow: free API key, no redistribution restriction
- Cannot imply EPA endorsement

## Notes

- Environmental justice is a headline cross-domain scenario in CROSS-DOMAIN.md — EPA is the missing piece
- Three distinct APIs but unified "environmental data" concept for tool search discovery
- TRI data alone is enormous: every facility releasing toxic chemicals must report annually
