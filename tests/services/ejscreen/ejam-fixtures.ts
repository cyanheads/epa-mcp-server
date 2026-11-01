/**
 * @fileoverview EJAM `POST https://api.ejanalysis.com/data` answers recorded on 2026-11-01 for
 * single-site requests. Bodies that are not rows are verbatim text; rows are trimmed to the
 * columns the service reads, every kept value as recorded.
 * @module tests/services/ejscreen/ejam-fixtures
 */

import type { RawEjamRow } from '@/services/ejscreen/types.js';

/**
 * HTTP 200 `{}`: EJAM found no Census block in the buffer. Recorded at Yellowstone, WY
 * (44.5, -110.5) with a 1-mile buffer, Toronto (43.6532, -79.3832) at 15 miles, and Hagåtña,
 * Guam (13.4443, 144.7937) at 1 mile.
 */
export const EJAM_NO_BLOCKS = '{}';

/**
 * HTTP 400 for a point outside EJAM's US bounds: the R error left after EJAM drops the invalid
 * site. Recorded for Paris (48.85, 2.35), (0, 0), and (30, -40).
 */
export const EJAM_OUT_OF_BOUNDS_400 =
  '{"error":["latlon_as.numeric(x) expects x to be a vector like 1:10 or df$mycol, not a data.frame, list, length zero, or anything else."]}';

/**
 * Central Nevada (38.0, -116.0), 15 miles: blocks found but no residents. EJAM marks the row
 * invalid, keeps the identity columns, and nulls every indicator; the national averages remain.
 */
export const nevadaZeroResidentRow: RawEjamRow = {
  ST: 'NV',
  statename: 'Nevada',
  pop: 0,
  valid: false,
  invalid_msg: 'blocks found but zero residents',
  bgcount_near_site: 3,
  'radius.miles': 15,
  'EJAM Report':
    '<a href="https://api.ejanalysis.com/report?lat=38&lon=-116&buffer=15&sitetype=latlon&validate_regids=FALSE&fileextension=pdf" target="_blank">EJAM Site Report</a>',
  pm: null,
  'pctile.pm': null,
  o3: null,
  pctmin: null,
  pctlowinc: null,
  'Demog.Index': null,
  'pctile.Demog.Index': null,
  'state.pctile.Demog.Index': null,
  'avg.Demog.Index': 1.3407,
  'state.avg.Demog.Index': 1.8067,
  'Demog.Index.Supp': null,
  'avg.Demog.Index.Supp': 1.6423,
  'state.avg.Demog.Index.Supp': 1.4369,
};

/**
 * San Juan, PR (18.4655, -66.1057), 1 mile: a covered row with sparse environmental columns
 * (PM2.5, ozone, and drinking water are null in Puerto Rico).
 */
export const sanJuanRow: RawEjamRow = {
  ST: 'PR',
  statename: 'Puerto Rico',
  pop: 7311.3,
  valid: true,
  invalid_msg: '',
  bgcount_near_site: 12,
  'radius.miles': 1,
  'EJAM Report':
    '<a href="https://api.ejanalysis.com/report?lat=18.4655&lon=-66.1057&buffer=1&sitetype=latlon&validate_regids=FALSE&fileextension=pdf" target="_blank">EJAM Site Report</a>',
  pm: null,
  'pctile.pm': null,
  'state.pctile.pm': null,
  o3: null,
  dpm: 0.5093,
  no2: 10.382,
  pctpre1960: 0.6498,
  'traffic.score': 1835914.9138,
  'proximity.npl': 0,
  'proximity.rmp': 1.9253,
  'proximity.tsdf': 3.6355,
  'proximity.npdes': 2289.5465,
  ust: 0,
  drinking: null,
  rsei: 759.6941,
  pctmin: 0.9449,
  'pctile.pctmin': 92,
  'state.pctile.pctmin': 6,
  pctlowinc: 0.5223,
  pctlingiso: 0.405,
  pctlths: 0.1303,
  pctunder5: 0.031,
  pctover64: 0.2685,
  'Demog.Index': 2.7057,
  'pctile.Demog.Index': 91,
  'state.pctile.Demog.Index': 12,
  'avg.Demog.Index': 1.3407,
  'state.avg.Demog.Index': 4.6275,
  'Demog.Index.Supp': 2.9689,
  'pctile.Demog.Index.Supp': 95,
  'state.pctile.Demog.Index.Supp': 13,
  'avg.Demog.Index.Supp': 1.6423,
  'state.avg.Demog.Index.Supp': 2.719,
};
