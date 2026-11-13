// The sails against the rigging: canvas cannot pass through a rope. A sail
// that fills presses against the stays before it and is creased by them; a
// sail aback lies against its mast; a braced yard swings the lee side of its
// sail aft until the canvas meets the foremost shroud and wraps round it.
// The yards themselves brace only as far as the shrouds and backstays let
// them. Pure geometry (no three.js), so it can be tested on its own.
//
// Frames: the model's (x to starboard, y up, bow toward -z). A square sail
// lives in its mast's group, turned by the brace angle about the mast;
// "mast frame" is that group unturned (origin on the mast's axis).

const MARGIN = 0.1;        // m of clear air kept between canvas and rope
const CREASE = 0.12;       // how quickly a crease made by a stay dies out athwartships (1/m2)

// Every rope of the standing rigging, both sides (the rig lists the starboard
// shrouds and backstays only; stays are on the centreline).
export function ropesOf(rig) {
  const out = [];
  for (const r of rig.ropes || []) {
    out.push({ kind: r.kind, mast: r.mast, a: r.a, b: r.b, r: r.r });
    if (r.kind !== 'stay') out.push({ kind: r.kind, mast: r.mast, a: [-r.a[0], r.a[1], r.a[2]], b: [-r.b[0], r.b[1], r.b[2]], r: r.r });
  }
  return out;
}

// where a rope crosses the height y: [x, z] or null
function cross(rp, y) {
  const ay = rp.a[1], by = rp.b[1];
  if ((y - ay) * (y - by) > 0 || ay === by) return null;
  const t = (y - ay) / (by - ay);
  return [rp.a[0] + (rp.b[0] - rp.a[0]) * t, rp.a[2] + (rp.b[2] - rp.a[2]) * t];
}

// The shape of a square sail (or a spritsail) hanging from its yard: grid of
// nx x ny vertices into P (x, y, z), and the canvas's flat position (no
// belly) into F (z only), from which a rope's side is judged.
export function shapeSquare(P, F, nx, ny, c, set, fill, shiver, time, sprit = false) {
  const { head, hw, foot, fw } = c;
  const drop = head.y - foot.y;
  // the foot is cut in a curve (roach) so that its middle clears the top,
  // the stays and the yard below
  const roach = (c.roach ?? 0.03) * fw;
  const depth = (sprit ? 0.13 : 0.16) * Math.abs(drop) * fill;
  for (let j = 0; j < ny; j++) {
    const t = j / (ny - 1);
    const v = t * set;                            // the canvas comes down from the yard as it is set
    // the head is laced to the yard and cannot belly; the deepest part is a
    // third of the way down, the foot between the clews bellies less
    const prof = Math.sin(Math.PI * Math.min(1, 0.85 * t)) * (0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, t * 1.25 + 0.05)));
    for (let i = 0; i < nx; i++) {
      const u = i / (nx - 1);
      const k = j * nx + i;
      const xh = (u - 0.5) * hw, xf = (u - 0.5) * fw;
      let x = xh + (xf - xh) * v;
      let y = head.y + (foot.y + roach * Math.sin(Math.PI * u) ** 1.5 - head.y) * v;
      const zf = head.z + (foot.z - head.z) * v;
      const belly = Math.sin(Math.PI * u) ** 0.8 * prof;
      let z = zf - depth * belly * set;           // forward (-z) when full
      y += Math.abs(depth) * 0.22 * belly * t * set;    // the foot lifts as it fills
      if (shiver > 0.01) z += Math.sin(time * 9 + u * 7 + j * 1.3) * 0.18 * shiver * belly;
      x *= 1 - 0.04 * belly * Math.abs(fill);
      P[3 * k] = x; P[3 * k + 1] = y; P[3 * k + 2] = z;
      F[k] = zf;
    }
  }
}

export class Clearance {
  // rig: the galleon's rig (src/ship/galleon_rig.json)
  constructor(rig) {
    this.ropes = ropesOf(rig);
    this.masts = {};
    for (const [name, m] of Object.entries(rig.masts)) {
      const at = (rp) => ({ ...rp, a: [rp.a[0] - m.x, rp.a[1], rp.a[2] - m.z], b: [rp.b[0] - m.x, rp.b[1], rp.b[2] - m.z] });
      const fan = this.ropes.filter((rp) => rp.mast === name && rp.kind !== 'stay').map(at);
      const stays = this.ropes.filter((rp) => rp.kind === 'stay').map(at);
      // the masts themselves: canvas is always ahead of them (lower mast,
      // and the topmast and topgallant mast standing before its head)
      const sticks = [];
      if (m.head) sticks.push({ a: [0, m.deck, 0], b: [0, m.head, 0], r: m.r0 * 0.86, mast: true });
      for (const t of [m.tm, m.tg]) {
        if (t && t.heel !== undefined) sticks.push({ a: [0, t.heel, 24 - t.s - m.z], b: [0, t.head, 24 - t.s - m.z], r: t.r * 0.8, mast: true });
      }
      this.masts[name] = { fan, stays: stays.concat(sticks), yards: m.yards, limit: 0.66 };
    }
    for (const [name, mm] of Object.entries(this.masts)) mm.limit = this._braceLimit(name);
    this.sprit = { fan: [], stays: this.ropes.filter((rp) => rp.kind === 'stay') };
  }

  // How far (rad) a mast's yards can brace before one of them would touch a
  // shroud or backstay on the lee side.
  _braceLimit(name) {
    const mm = this.masts[name];
    let best = 38 * Math.PI / 180;
    for (const yd of mm.yards) {
      if (yd.lateen) continue;
      for (let th = 0; th <= best; th += 0.5 * Math.PI / 180) {
        // the port yardarm swings aft when braced to + (starboard arm forward)
        let hit = false;
        for (const rp of mm.fan) {
          if (rp.a[0] > 0 && rp.b[0] > 0) continue;
          const p = cross(rp, yd.y);
          if (!p) continue;
          const rho = Math.hypot(p[0], p[1]);
          if (rho < 1.6 || rho > yd.len / 2) continue;         // at the masthead, or past the yardarm
          // the yard's point at the rope's radius: the yard line is offset
          // forward (fwd) of the mast and turned by th
          const along = Math.sqrt(Math.max(0, rho * rho - yd.fwd * yd.fwd));
          const yx = -along * Math.cos(th) - yd.fwd * Math.sin(th);
          const yz = along * Math.sin(th) - yd.fwd * Math.cos(th);
          // ahead of the rope by at least the yard's and rope's radii?
          const phiR = Math.atan2(p[1], Math.abs(p[0])), phiY = Math.atan2(yz, Math.abs(yx));
          if ((phiR - phiY) * rho < yd.r + rp.r + MARGIN) { hit = true; break; }
        }
        if (hit) { best = Math.max(0, th - 0.5 * Math.PI / 180); break; }
      }
    }
    return best;
  }

  // Keep a square sail clear of the rigging. P: its vertices in its mast's
  // turned group; F: their flat z; th: the group's turn about the mast.
  square(P, F, nx, ny, mast, th) {
    const mm = mast ? this.masts[mast] : this.sprit;
    const c = Math.cos(th), s = Math.sin(th);
    const n = nx * ny;
    const X = this._x || (this._x = new Float32Array(4096)), Z = this._z || (this._z = new Float32Array(4096));
    for (let k = 0; k < n; k++) {
      const px = P[3 * k], pz = P[3 * k + 2];
      X[k] = px * c + pz * s;
      Z[k] = -px * s + pz * c;
    }
    const mid = (nx - 1) / 2;
    const ang = (k) => Math.atan2(Z[k], Math.abs(X[k]));
    for (let j = 0; j < ny; j++) {
      // the shrouds and backstays: the lee side of a braced sail must pass
      // ahead of each rope it would otherwise cross. Far out (the lower
      // shrouds, the backstays) the canvas outboard of the rope is swung
      // forward round it, as a sail wraps the foremost shroud; close to the
      // mast (topmast and topgallant shrouds) it is pushed forward over it.
      for (const side of [1, -1]) {
        const idx = [];
        if (side > 0) for (let i = Math.ceil(mid); i < nx; i++) idx.push(j * nx + i);
        else for (let i = Math.floor(mid); i >= 0; i--) idx.push(j * nx + i);
        const ropes = mm.fan.filter((rp) => Math.sign(rp.a[0] + rp.b[0]) === side);
        for (let pass = 0; pass < 3; pass++) {
          for (const rp of ropes) {
            // where along the row the canvas passes the rope's radius (the
            // row is not quite level: find it at the canvas's own height)
            let y = P[3 * idx[0] + 1], hit = null;
            for (let it = 0; it < 2; it++) {
              const p = cross(rp, y);
              if (!p) { hit = null; break; }
              const rR = Math.hypot(p[0], p[1]);
              hit = null;
              for (let q = 1; q < idx.length; q++) {
                const a = idx[q - 1], b = idx[q];
                const ra = Math.hypot(X[a], Z[a]), rb = Math.hypot(X[b], Z[b]);
                if ((ra - rR) * (rb - rR) <= 0 && ra !== rb) {
                  const t = (rR - ra) / (rb - ra);
                  hit = { rR, pR: Math.atan2(p[1], Math.abs(p[0])), phiS: ang(a) + (ang(b) - ang(a)) * t };
                  y = P[3 * a + 1] + (P[3 * b + 1] - P[3 * a + 1]) * t;
                  break;
                }
              }
              if (!hit) break;
            }
            if (!hit) continue;
            const { rR, pR, phiS } = hit;
            const need = pR - (rp.r + 2 * MARGIN) / Math.max(rR, 0.5);
            if (phiS <= need) continue;
            const d = phiS - need;
            const near = rR < 2.2;
            for (const k of idx) {
              const r = Math.hypot(X[k], Z[k]);
              let w;
              if (near) { const e = Math.max(0, 1 - Math.abs(r - rR) / 1.6); w = e * e * (3 - 2 * e); }
              else w = r >= rR ? 1 : Math.max(0, (r - 0.3 * rR) / (0.7 * rR)) ** 1.5;
              if (w <= 0) continue;
              const f = ang(k) - d * w;
              X[k] = side * r * Math.cos(f);
              Z[k] = r * Math.sin(f);
            }
          }
        }
      }
      // the stays (and the mast): the canvas keeps to the side of each that
      // its flat position is on, creased where it presses on it
      for (const rp of mm.stays) {
        for (let i = 0; i < nx; i++) {
          const k = j * nx + i;
          const p = cross(rp, P[3 * k + 1]);
          if (!p) continue;
          const dx = X[k] - p[0];
          const reach = rp.r + MARGIN - CREASE * dx * dx;
          if (reach <= 0) continue;
          // which side of the rope the flat canvas is on (in the mast frame):
          // ahead of a mast always
          const zFlat = -P[3 * k] * s + F[k] * c;
          if (rp.mast || zFlat < p[1]) { if (Z[k] > p[1] - reach) Z[k] = p[1] - reach; }   // ahead of it
          else if (Z[k] < p[1] + reach) Z[k] = p[1] + reach;                                // abaft it
        }
      }
    }
    for (let k = 0; k < n; k++) {
      P[3 * k] = X[k] * c - Z[k] * s;
      P[3 * k + 2] = X[k] * s + Z[k] * c;
    }
  }

  // Keep the lateen inboard of the mizzen's shrouds and backstays.
  lateen(P, n, mast, th) {
    const mm = this.masts[mast];
    const c = Math.cos(th), s = Math.sin(th);
    for (let k = 0; k < n; k++) {
      const px = P[3 * k], y = P[3 * k + 1], pz = P[3 * k + 2];
      let x = px * c + pz * s;
      const z = -px * s + pz * c;
      for (const rp of mm.fan) {
        if (Math.sign(rp.a[0] + rp.b[0]) !== Math.sign(x || 1)) continue;
        const p = cross(rp, y);
        if (!p || Math.abs(z - p[1]) > 0.8) continue;
        const lim = Math.abs(p[0]) - rp.r - MARGIN;
        if (Math.abs(x) > lim) x = Math.sign(x) * Math.max(0, lim);
      }
      P[3 * k] = x * c - z * s;
      P[3 * k + 2] = x * s + z * c;
    }
  }
}

// The canvas's intersections with the ropes, for tests: segments of rope
// that pass through a triangle of the sail. P in the model frame.
export function piercings(P, nx, ny, ropes) {
  const hits = [];
  const v = (k) => [P[3 * k], P[3 * k + 1], P[3 * k + 2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  for (const rp of ropes) {
    const d = sub(rp.b, rp.a);
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const k = j * nx + i;
        for (const tri of [[k, k + 1, k + nx], [k + 1, k + nx + 1, k + nx]]) {
          const [p0, p1, p2] = tri.map(v);
          const e1 = sub(p1, p0), e2 = sub(p2, p0);
          const h = crs(d, e2), a = dot(e1, h);
          if (Math.abs(a) < 1e-9) continue;
          const f = 1 / a, sv = sub(rp.a, p0), u = f * dot(sv, h);
          if (u < 0 || u > 1) continue;
          const q = crs(sv, e1), w = f * dot(d, q);
          if (w < 0 || u + w > 1) continue;
          const t = f * dot(e2, q);
          if (t > 0 && t < 1) hits.push({ kind: rp.kind, mast: rp.mast, at: [rp.a[0] + d[0] * t, rp.a[1] + d[1] * t, rp.a[2] + d[2] * t] });
        }
      }
    }
  }
  return hits;
}
