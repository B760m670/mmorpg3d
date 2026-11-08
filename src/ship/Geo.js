// Where the game world is on the Earth, for the GPS and the compasses.
//
// The world is laid out on the UTM grid, zone 33N (EUREF89 = WGS84 to within
// centimetres here): x east, z south, origin at UTM (422489, 7536188), south
// of Reine. Grid north differs from true north by the meridian convergence
// (here about 1.8 deg), and the compass needle from true north by the
// magnetic declination: +7.5 deg (east) at Reine in November 2026 (World
// Magnetic Model 2025, from the BGS calculator).

export const ORIGIN_UTM33 = [422489, 7536188];
export const DECLINATION = 7.51;          // deg east, WMM2025 for 2026-11-08 at Reine

const A = 6378137, F = 1 / 298.257223563, K0 = 0.9996;
const E2 = F * (2 - F), EP2 = E2 / (1 - E2);
const DEG = Math.PI / 180;

// UTM (zone 33 north) easting/northing -> latitude, longitude (deg).
export function utmToLatLon(E, N, zone = 33) {
  const x = E - 500000;
  const M = N / K0;
  const mu = M / (A * (1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const s = Math.sin(p1), c = Math.cos(p1), t = Math.tan(p1);
  const C1 = EP2 * c * c, T1 = t * t;
  const N1 = A / Math.sqrt(1 - E2 * s * s);
  const R1 = A * (1 - E2) / Math.pow(1 - E2 * s * s, 1.5);
  const D = x / (N1 * K0);
  const lat = p1 - (N1 * t / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6 / 720);
  const lon0 = (zone * 6 - 183) * DEG;
  const lon = lon0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5 / 120) / c;
  return [lat / DEG, lon / DEG];
}

// world (x, z) -> [lat, lon]
export function worldToLatLon(x, z) {
  return utmToLatLon(ORIGIN_UTM33[0] + x, ORIGIN_UTM33[1] - z);
}

// Meridian convergence (deg): true azimuth = grid azimuth + convergence.
export function convergence(x, z) {
  const [lat, lon] = worldToLatLon(x, z);
  return (lon - 15) * Math.sin(lat * DEG);
}

export function fmtLat(v) {
  const h = v >= 0 ? 'N' : 'S';
  v = Math.abs(v);
  const d = Math.floor(v), m = (v - d) * 60;
  return `${String(d).padStart(2, '0')}°${m.toFixed(3).padStart(6, '0')}'${h}`;
}
export function fmtLon(v) {
  const h = v >= 0 ? 'E' : 'W';
  v = Math.abs(v);
  const d = Math.floor(v), m = (v - d) * 60;
  return `${String(d).padStart(3, '0')}°${m.toFixed(3).padStart(6, '0')}'${h}`;
}

// The ship's deviation card: the error of the steering compass on each
// heading from the steel of the hull (fitted to a typical card, a few deg).
export function deviation(magHdg) {
  const t = magHdg * DEG;
  return 0.4 + 2.2 * Math.sin(t) - 1.3 * Math.cos(t) + 0.6 * Math.sin(2 * t) - 0.3 * Math.cos(2 * t);
}

export const wrap360 = (a) => ((a % 360) + 360) % 360;
export const wrap180 = (a) => ((a + 540) % 360) - 180;

// Local time in Lofoten (CET / CEST).
export function localTime(ms = Date.now()) {
  try {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms));
    const h = +p.find((q) => q.type === 'hour').value, m = +p.find((q) => q.type === 'minute').value;
    return { h: h % 24, m, hours: (h % 24) + m / 60 };
  } catch (e) {
    const d = new Date(ms + 3600e3);
    return { h: d.getUTCHours(), m: d.getUTCMinutes(), hours: d.getUTCHours() + d.getUTCMinutes() / 60 };
  }
}
