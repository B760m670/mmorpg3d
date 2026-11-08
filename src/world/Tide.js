import data from '../assets/terrain/tide.json';

// The tide at Reine: Kartverket's predicted high and low waters (from Bodø,
// +10 min, x1.01; see tools/build_landcover.py), interpolated with a cosine
// between them, as tide tables are read. Semi-diurnal; the spring range is
// about 2.4 m, the neap range about 1.2 m. Outside the table (before November
// 2026 or after 2027) a two-constituent tide (M2 + S2) of the same size
// stands in.
//
// level(ms) is metres above mean sea level at that moment (real time).

const T0 = data.t0_unix_min;
const EX = data.extremes_min_cm;
const MSL = data.msl;

function synthetic(min) {
  const h = min / 60;
  const m2 = 0.88 * Math.cos((2 * Math.PI * h) / 12.4206);
  const s2 = 0.31 * Math.cos((2 * Math.PI * h) / 12.0 + 1.1);
  return m2 + s2;
}

export function tideLevel(ms = Date.now()) {
  const t = ms / 60000 - T0;
  if (t < 0 || t > EX[EX.length - 1][0]) return synthetic(ms / 60000);
  let lo = 0, hi = EX.length - 1;
  while (hi - lo > 1) {                 // the two extremes either side of now
    const mid = (lo + hi) >> 1;
    if (EX[mid][0] <= t) lo = mid; else hi = mid;
  }
  const [ta, ha] = EX[lo], [tb, hb] = EX[hi];
  const f = (t - ta) / Math.max(1, tb - ta);
  const cm = ha + (hb - ha) * (1 - Math.cos(Math.PI * f)) / 2;
  return (cm - MSL) / 100;
}

// rising or falling, and the next turn of the tide
export function tideInfo(ms = Date.now()) {
  const now = tideLevel(ms);
  const soon = tideLevel(ms + 10 * 60000);
  return { level: now, rising: soon > now };
}
