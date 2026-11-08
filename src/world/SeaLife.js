import * as THREE from 'three';
import { heightAt, exposureAt, seabedHard } from './Terrain.js';
import { addWaterTint } from './Underwater.js';
import { terrainUniforms } from './Terrain.js';

// Life on the sea floor around the diver, as it is off Lofoten:
//   - kelp forest of Laminaria hyperborea on rock from just below the lowest
//     tides to about 20 m: a stiff stipe 1-2 m tall, carrying red algae, and
//     a hand-shaped blade split into fingers; dense in the first 10 m, a
//     thinner "kelp park" deeper. In sheltered water sugar kelp (Saccharina
//     latissima) instead, one long ruffled blade;
//   - green sea urchins (Strongylocentrotus droebachiensis) on the rock at
//     and below the lower edge of the kelp;
//   - common starfish (Asterias rubens) on rock and sand;
//   - a school of saithe in mid water near the kelp, and a few cod by the
//     bottom.
// Placed with the same rock-or-sand rule as the terrain shader
// (seabedHard), refreshed around the camera as it moves. The kelp sways in
// the surge of the swell, more in shallow water and in a rough sea.

function hash(i, j, k = 0) {
  let h = (i * 374761393 + j * 668265263 + k * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---- geometry builders: position, color, aSway (0 at the base .. 1 tip)
class Builder {
  constructor() { this.p = []; this.c = []; this.s = []; this.i = []; }
  v(x, y, z, col, sway) { this.p.push(x, y, z); this.c.push(...col); this.s.push(sway); return this.p.length / 3 - 1; }
  tri(a, b, c) { this.i.push(a, b, c); }
  quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aSway', new THREE.Float32BufferAttribute(this.s, 1));
    g.setIndex(this.i);
    g.computeVertexNormals();
    return g;
  }
}

// a tapered tube along a curve: pts [[x,y,z]], radius per point
function tube(b, pts, rad, sides, col, swayOf) {
  const rings = [];
  for (let k = 0; k < pts.length; k++) {
    const ring = [];
    for (let a = 0; a < sides; a++) {
      const ang = (a / sides) * Math.PI * 2;
      const [x, y, z] = pts[k];
      ring.push(b.v(x + Math.cos(ang) * rad[k], y, z + Math.sin(ang) * rad[k], typeof col === 'function' ? col(k / (pts.length - 1)) : col, swayOf(y)));
    }
    rings.push(ring);
  }
  for (let k = 0; k < rings.length - 1; k++) {
    for (let a = 0; a < sides; a++) b.quad(rings[k][a], rings[k][(a + 1) % sides], rings[k + 1][(a + 1) % sides], rings[k + 1][a]);
  }
}

function hyperboreaClump(seed, plants) {
  const b = new Builder();
  const maxH = 3.2;
  const sw = (y) => Math.min(1, Math.max(0, y / maxH));
  for (let n = 0; n < plants; n++) {
    const r = hash(seed, n, 1) * 0.7, a = hash(seed, n, 2) * 6.283;
    const x0 = Math.cos(a) * r, z0 = Math.sin(a) * r;
    const H = 0.9 + hash(seed, n, 3) * 1.1;                 // stipe
    const lean = (hash(seed, n, 4) - 0.5) * 0.35, leanA = hash(seed, n, 5) * 6.283;
    const pts = [], rad = [];
    for (let k = 0; k <= 3; k++) {
      const t = k / 3;
      pts.push([x0 + Math.cos(leanA) * lean * t * t * H, t * H, z0 + Math.sin(leanA) * lean * t * t * H]);
      rad.push(0.028 - 0.014 * t);
    }
    // stipe: brown, the upper part furred with red epiphytes
    tube(b, pts, rad, 4, (t) => (t > 0.35 ? [0.3, 0.1, 0.09] : [0.2, 0.13, 0.07]), sw);
    // blade: fingers fanning out from the top of the stipe, drooping
    const top = pts[3];
    const dir = hash(seed, n, 6) * 6.283;
    const fingers = 6;
    const L = 0.6 + hash(seed, n, 7) * 0.5;
    const bladeCol = [0.5, 0.33, 0.09];
    for (let f = 0; f < fingers; f++) {
      const fa = dir + (f / (fingers - 1) - 0.5) * 1.6;
      const ca = Math.cos(fa), sa = Math.sin(fa);
      let prevL = null, prevR = null;
      for (let k = 0; k <= 3; k++) {
        const t = k / 3;
        const out = t * L, up = Math.sin(t * 1.4) * L * 0.55 - t * t * L * 0.35;
        const w = (0.05 + 0.03 * Math.sin(t * 3.0)) * (1 - 0.6 * t);
        const cx = top[0] + ca * out, cy = top[1] + up, cz = top[2] + sa * out;
        const l = b.v(cx - sa * w, cy, cz + ca * w, bladeCol, sw(cy));
        const rr = b.v(cx + sa * w, cy, cz - ca * w, bladeCol, sw(cy));
        if (prevL !== null) b.quad(prevL, prevR, rr, l);
        prevL = l; prevR = rr;
      }
    }
  }
  return b.geometry();
}

function saccharinaClump(seed, plants) {
  const b = new Builder();
  const sw = (y) => Math.min(1, Math.max(0, y / 2.4));
  for (let n = 0; n < plants; n++) {
    const r = hash(seed, n, 1) * 0.6, a = hash(seed, n, 2) * 6.283;
    const x0 = Math.cos(a) * r, z0 = Math.sin(a) * r;
    const L = 1.4 + hash(seed, n, 3) * 1.4;
    const dir = hash(seed, n, 4) * 6.283, ca = Math.cos(dir), sa = Math.sin(dir);
    const col = [0.52, 0.36, 0.1];
    let pl = null, pc = null, pr = null;
    const seg = 8;
    for (let k = 0; k <= seg; k++) {
      const t = k / seg;
      // rises from a short stipe, then lies over in the current
      const out = t * L * 0.85, up = 0.15 + Math.sin(Math.min(1, t * 2.2) * 1.4) * 0.7 - t * t * 0.25;
      const w = 0.03 + 0.12 * Math.min(1, t * 4) * (1 - 0.5 * t);
      const ruff = Math.sin(t * 40 + n) * 0.03;           // the ruffled edges
      const cx = x0 + ca * out, cz = z0 + sa * out;
      const c = b.v(cx, up, cz, col, sw(up + t));
      const l = b.v(cx - sa * w, up + ruff, cz + ca * w, col, sw(up + t));
      const rr = b.v(cx + sa * w, up - ruff, cz - ca * w, col, sw(up + t));
      if (pc !== null) { b.quad(pl, pc, c, l); b.quad(pc, pr, rr, c); }
      pl = l; pc = c; pr = rr;
    }
  }
  return b.geometry();
}

function urchinGeometry() {
  const g = new THREE.IcosahedronGeometry(0.035, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, Math.max(p.getY(i) * 0.6, -0.004));
  const col = [], s = [];
  for (let i = 0; i < p.count; i++) { col.push(0.2, 0.25, 0.08); s.push(0); }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aSway', new THREE.Float32BufferAttribute(s, 1));
  g.computeVertexNormals();
  return g;
}

function starfishGeometry() {
  const b = new Builder();
  const col = [1, 1, 1];
  const c = b.v(0, 0.015, 0, col, 0);
  const rim = [];
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    const r = k % 2 === 0 ? 0.1 : 0.025;
    rim.push(b.v(Math.cos(a) * r, k % 2 === 0 ? 0.004 : 0.01, Math.sin(a) * r, col, 0));
  }
  for (let k = 0; k < 10; k++) b.tri(c, rim[(k + 1) % 10], rim[k]);
  return b.geometry();
}

// A fish 1 m long along -Z (head forward), aSway = distance from the head.
function fishGeometry() {
  const b = new Builder();
  const seg = 7, sides = 6;
  const rings = [];
  for (let k = 0; k <= seg; k++) {
    const t = k / seg;
    const z = -0.5 + t * 0.86;
    const rr = Math.sin(Math.min(1, t * 1.15) * Math.PI) * 0.09 + 0.006;
    const ring = [];
    for (let a = 0; a < sides; a++) {
      const ang = (a / sides) * Math.PI * 2;
      const y = Math.cos(ang), x = Math.sin(ang);
      // dark back, silver flanks, white belly, a pale lateral line
      const col = y > 0.55 ? [0.07, 0.1, 0.09] : y > -0.3 ? (Math.abs(y - 0.2) < 0.15 ? [0.6, 0.62, 0.6] : [0.42, 0.46, 0.46]) : [0.8, 0.8, 0.78];
      ring.push(b.v(x * rr * 0.7, y * rr * 1.15, z, col, t));
    }
    rings.push(ring);
  }
  for (let k = 0; k < seg; k++) {
    for (let a = 0; a < sides; a++) b.quad(rings[k][a], rings[k + 1][a], rings[k + 1][(a + 1) % sides], rings[k][(a + 1) % sides]);
  }
  // tail fin and dorsal fin, double-sided by winding both ways
  const fin = [0.1, 0.12, 0.11];
  const t0 = b.v(0, 0, 0.34, fin, 0.95), t1 = b.v(0, 0.13, 0.5, fin, 1), t2 = b.v(0, -0.13, 0.5, fin, 1), t3 = b.v(0, 0, 0.45, fin, 1);
  b.tri(t0, t1, t3); b.tri(t0, t3, t1); b.tri(t0, t3, t2); b.tri(t0, t2, t3);
  const d0 = b.v(0, 0.09, -0.15, fin, 0.4), d1 = b.v(0, 0.17, -0.05, fin, 0.5), d2 = b.v(0, 0.09, 0.12, fin, 0.65);
  b.tri(d0, d1, d2); b.tri(d0, d2, d1);
  return b.geometry();
}

// Kelp-type material: vertex colours, swaying in the surge; fish bend their
// tails instead (uFish = 1).
function swayMaterial({ fish = false, roughness = 0.75 } = {}) {
  const U = terrainUniforms();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness, metalness: 0, side: THREE.DoubleSide });
  mat.userData.surge = { value: 0.3 };
  mat.userData.surgeDir = { value: new THREE.Vector2(1, 0) };
  mat.userData.key = fish ? 'sealife-fish' : 'sealife-sway';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = U.uWaterTime;
    shader.uniforms.uSurge = mat.userData.surge;
    shader.uniforms.uSurgeDir = mat.userData.surgeDir;
    shader.uniforms.uTide2 = U.uTide;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aSway;
        uniform float uTime, uSurge, uTide2;
        uniform vec2 uSurgeDir;
        varying float vWaterY;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        ${fish ? `
        {
          // swimming: a wave runs down the body, bigger toward the tail
          float ph = instanceMatrix[3][0] * 1.7 + instanceMatrix[3][2] * 2.3;
          transformed.x += sin(uTime * 9.0 + ph - aSway * 5.0) * 0.06 * aSway * aSway;
        }` : ''}`)
      .replace('#include <project_vertex>', `
        vec4 mvPosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
        #endif
        ${fish ? '' : `
        {
          // back and forth in the surge of the swell, felt less with depth,
          // plus a slower flutter of the blades
          vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          float ph = dot(ip.xz, vec2(0.11, 0.07)) + ip.y * 0.3;
          float depth = max(0.0, uTide2 - ip.y);
          float w = aSway * aSway;
          float surge = sin(uTime * 0.8 + ph) * uSurge * exp(-depth / 10.0);
          mvPosition.xz += uSurgeDir * surge * w * 1.4
            + vec2(sin(uTime * 1.3 + ph * 3.0 + aSway * 4.0), cos(uTime * 1.1 + ph * 2.0 + aSway * 3.0)) * 0.06 * w;
          mvPosition.y -= abs(surge) * w * 0.25;
        }`}
        vWaterY = mvPosition.y;
        mvPosition = viewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`);
  };
  return addWaterTint(mat, { vertex: false });
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _e = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0);

export class SeaLife {
  constructor({ mobile = false, swellDir = [1, 0] } = {}) {
    this.group = new THREE.Group();
    this.mobile = mobile;
    this.kelpR = mobile ? 30 : 44;
    this.center = new THREE.Vector2(1e9, 1e9);
    this.smallCenter = new THREE.Vector2(1e9, 1e9);

    this.kelpMat = swayMaterial();
    this.kelpMat.userData.surgeDir.value.set(swellDir[0], swellDir[1]).normalize();
    const cap = mobile ? 260 : 650;
    this.kelp = [0, 1, 2].map((k) => this.pool(hyperboreaClump(11 + k * 7, 4), this.kelpMat, cap));
    this.sugar = [0, 1].map((k) => this.pool(saccharinaClump(51 + k * 5, 4), this.kelpMat, Math.round(cap / 2)));
    const solid = swayMaterial({ roughness: 0.9 });
    this.urchins = this.pool(urchinGeometry(), solid, mobile ? 700 : 1600);
    this.stars = this.pool(starfishGeometry(), solid, mobile ? 120 : 260);

    // fish
    const fishMat = swayMaterial({ fish: true, roughness: 0.45 });
    const nSchool = mobile ? 24 : 40;
    this.fish = this.pool(fishGeometry(), fishMat, nSchool + 4);
    this.fish.frustumCulled = false;
    this.school = {
      c: new THREE.Vector3(), v: new THREE.Vector3(1, 0, 0), t: 0, init: false,
      members: Array.from({ length: nSchool }, (_, i) => ({
        off: new THREE.Vector3((hash(i, 1) - 0.5) * 5, (hash(i, 2) - 0.5) * 1.8, (hash(i, 3) - 0.5) * 5),
        p: new THREE.Vector3(), dir: new THREE.Vector3(1, 0, 0), size: 0.42 + hash(i, 4) * 0.2,
      })),
    };
    this.cod = Array.from({ length: 4 }, (_, i) => ({ p: new THREE.Vector3(), home: null, yaw: hash(i, 9) * 6.28, size: 0.65 + hash(i, 10) * 0.35 }));
  }

  pool(geo, mat, cap) {
    const im = new THREE.InstancedMesh(geo, mat, cap);
    im.count = 0;
    im.frustumCulled = false;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.setColorAt(0, _c.setRGB(1, 1, 1));
    this.group.add(im);
    return im;
  }

  put(im, n, x, y, z, yaw, scale, tilt = 0) {
    _e.set(tilt * 0.5, yaw, tilt * 0.5);
    _q.setFromEuler(_e);
    _p.set(x, y, z);
    _s.set(scale, scale, scale);
    im.setMatrixAt(n, _m.compose(_p, _q, _s));
  }

  // kelp around the camera, every few metres it moves
  placeKelp(cx, cz) {
    const R = this.kelpR, cell = this.mobile ? 2.2 : 1.8;
    const nk = [0, 0, 0], ns = [0, 0];
    const capK = this.kelp[0].instanceMatrix.count, capS = this.sugar[0].instanceMatrix.count;
    const i0 = Math.floor((cx - R) / cell), i1 = Math.floor((cx + R) / cell);
    const j0 = Math.floor((cz - R) / cell), j1 = Math.floor((cz + R) / cell);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = (i + 0.2 + 0.6 * hash(i, j, 1)) * cell, z = (j + 0.2 + 0.6 * hash(i, j, 2)) * cell;
        if (Math.hypot(x - cx, z - cz) > R) continue;
        const h = heightAt(x, z);
        if (h > -2.4 || h < -24) continue;
        // densest in the first 10 m, a thin "park" below
        const dens = h > -10 ? 0.85 : h > -16 ? 0.55 : 0.2 * (1 + (h + 24) / 8);
        if (hash(i, j, 3) > dens) continue;
        const sb = seabedHard(x, z);
        if (sb.hard < 0.5) continue;
        const yaw = hash(i, j, 4) * 6.283;
        const sheltered = exposureAt(x, z) < 0.22;
        const tilt = Math.min(0.5, sb.slope * 1.5) * (hash(i, j, 6) - 0.5);
        const sc = (0.75 + hash(i, j, 5) * 0.5) * (h > -12 ? 1 : 0.8);
        if (sheltered && h > -15) {
          const k = Math.floor(hash(i, j, 7) * 2);
          if (ns[k] < capS) this.put(this.sugar[k], ns[k]++, x, h - 0.05, z, yaw, sc, tilt);
        } else {
          const k = Math.floor(hash(i, j, 7) * 3);
          if (nk[k] < capK) this.put(this.kelp[k], nk[k]++, x, h - 0.05, z, yaw, sc, tilt);
        }
      }
    }
    this.kelp.forEach((im, k) => { im.count = nk[k]; im.instanceMatrix.needsUpdate = true; });
    this.sugar.forEach((im, k) => { im.count = ns[k]; im.instanceMatrix.needsUpdate = true; });
    this.kelpCount = nk[0] + nk[1] + nk[2] + ns[0] + ns[1];
  }

  // urchins and starfish close by
  placeSmall(cx, cz) {
    const R = 16, cell = 1.0;
    let nu = 0, ns = 0;
    const capU = this.urchins.instanceMatrix.count, capS = this.stars.instanceMatrix.count;
    const i0 = Math.floor((cx - R) / cell), i1 = Math.floor((cx + R) / cell);
    const j0 = Math.floor((cz - R) / cell), j1 = Math.floor((cz + R) / cell);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x0 = i * cell, z0 = j * cell;
        if (Math.hypot(x0 - cx, z0 - cz) > R) continue;
        const h0 = heightAt(x0, z0);
        if (h0 > -3 || h0 < -40) continue;
        const r = hash(i, j, 11);
        // urchins: on rock, most at and below the lower edge of the kelp
        const uDens = h0 < -8 ? (h0 < -14 ? 0.9 : 0.4) : 0.08;
        if (r < uDens) {
          const sb = seabedHard(x0 + 0.5, z0 + 0.5);
          if (sb.hard > 0.5) {
            const n = 1 + Math.floor(hash(i, j, 12) * 3);
            for (let k = 0; k < n && nu < capU; k++) {
              const x = x0 + hash(i, j, 20 + k) * cell, z = z0 + hash(i, j, 30 + k) * cell;
              this.put(this.urchins, nu++, x, heightAt(x, z) - 0.005, z, hash(i, j, 40 + k) * 6.28, 0.8 + hash(i, j, 50 + k) * 0.6);
            }
          }
        }
        if (hash(i, j, 13) < 0.06 && ns < capS) {
          const x = x0 + hash(i, j, 14) * cell, z = z0 + hash(i, j, 15) * cell;
          this.put(this.stars, ns, x, heightAt(x, z) + 0.005, z, hash(i, j, 16) * 6.28, 0.7 + hash(i, j, 17) * 0.9);
          // orange to violet
          const v = hash(i, j, 18);
          this.stars.setColorAt(ns, _c.setRGB(0.75 - 0.25 * v, 0.3 - 0.1 * v, 0.12 + 0.3 * v * v));
          ns++;
        }
      }
    }
    this.urchins.count = nu;
    this.urchins.instanceMatrix.needsUpdate = true;
    this.stars.count = ns;
    this.stars.instanceMatrix.needsUpdate = true;
    if (this.stars.instanceColor) this.stars.instanceColor.needsUpdate = true;
  }

  // school of saithe and a few cod; diver: eye position, surface height
  updateFish(dt, time, eye, surfaceY) {
    const S = this.school;
    const bottom = heightAt(eye.x, eye.z);
    if (!S.init || S.c.distanceTo(eye) > 60) {
      S.c.set(eye.x + 14, (eye.y + bottom) / 2, eye.z + 6);
      S.init = true;
      for (const m of S.members) m.p.copy(S.c).add(m.off);
    }
    S.t += dt;
    // wander round the diver at 8-20 m, keep in the water column, shy away
    // when the diver comes close
    const ang = S.t * 0.05;
    const goal = _p.set(eye.x + Math.cos(ang) * 13, 0, eye.z + Math.sin(ang * 1.3) * 13);
    const gb = heightAt(goal.x, goal.z);
    goal.y = THREE.MathUtils.clamp(eye.y + Math.sin(S.t * 0.13) * 2, gb + 1.5, surfaceY - 1.5);
    const away = _s.copy(S.c).sub(eye);
    const dd = away.length();
    const want = goal.sub(S.c).clampLength(0, 1).multiplyScalar(0.8);
    if (dd < 6) want.addScaledVector(away.normalize(), (6 - dd) * 0.6);
    S.v.lerp(want, 1 - Math.exp(-dt * 0.7));
    S.c.addScaledVector(S.v, dt);
    const cb = heightAt(S.c.x, S.c.z);
    if (cb > surfaceY - 3) S.v.multiplyScalar(-1);
    S.c.y = THREE.MathUtils.clamp(S.c.y, cb + 1.2, surfaceY - 1.2);

    let n = 0;
    S.members.forEach((m, i) => {
      const prev = _s.copy(m.p);
      const wob = _e.set(Math.sin(time * 0.3 + i) * 0.6, Math.sin(time * 0.23 + i * 2.1) * 0.3, Math.cos(time * 0.27 + i * 1.3) * 0.6);
      const target = new THREE.Vector3(S.c.x + m.off.x + wob.x, S.c.y + m.off.y + wob.y, S.c.z + m.off.z + wob.z);
      m.p.lerp(target, 1 - Math.exp(-dt * 1.2));
      const mv = prev.sub(m.p).multiplyScalar(-1);
      if (mv.lengthSq() > 1e-7) m.dir.lerp(mv.normalize(), 1 - Math.exp(-dt * 4)).normalize();
      _q.setFromUnitVectors(new THREE.Vector3(0, 0, -1), m.dir);
      _m.compose(m.p, _q, new THREE.Vector3(m.size, m.size, m.size));
      this.fish.setMatrixAt(n, _m);
      this.fish.setColorAt(n, _c.setRGB(0.85, 0.95, 0.9));
      n++;
    });
    // cod: hang near the bottom on rock close to the diver, turning slowly
    this.cod.forEach((c, i) => {
      if (!c.home || c.home.distanceTo(eye) > 45) {
        const a = hash(i, Math.floor(time / 60), 3) * 6.28, r = 8 + hash(i, 4) * 14;
        const x = eye.x + Math.cos(a) * r, z = eye.z + Math.sin(a) * r;
        c.home = new THREE.Vector3(x, heightAt(x, z) + 0.6 + hash(i, 5) * 0.8, z);
        c.p.copy(c.home);
      }
      c.yaw += Math.sin(time * 0.1 + i * 3) * 0.12 * dt;
      const fwd = new THREE.Vector3(-Math.sin(c.yaw), 0, -Math.cos(c.yaw));
      c.p.addScaledVector(fwd, 0.08 * dt * Math.max(0, Math.sin(time * 0.2 + i)));
      if (c.p.distanceTo(eye) < 2.5) { c.yaw += dt * 2; c.p.addScaledVector(fwd, 0.6 * dt); }
      c.p.y = Math.max(c.p.y, heightAt(c.p.x, c.p.z) + 0.4);
      _q.setFromAxisAngle(UP, c.yaw);
      _m.compose(c.p, _q, new THREE.Vector3(c.size, c.size, c.size));
      this.fish.setMatrixAt(n, _m);
      // mottled brown-green with a pale belly (the vertex colours give the belly)
      this.fish.setColorAt(n, _c.setRGB(1.5, 1.25, 0.75));
      n++;
    });
    this.fish.count = n;
    this.fish.instanceMatrix.needsUpdate = true;
    if (this.fish.instanceColor) this.fish.instanceColor.needsUpdate = true;
  }

  update(dt, time, camera, { under, surfaceY, seaRough }) {
    const cx = camera.position.x, cz = camera.position.z;
    // only near the water: from high up the kelp would not show anyway
    const low = camera.position.y < (surfaceY ?? 0) + 25;
    this.group.visible = low;
    if (!low) return;
    if (Math.hypot(cx - this.center.x, cz - this.center.y) > (this.mobile ? 5 : 6)) {
      this.center.set(cx, cz);
      this.placeKelp(cx, cz);
    }
    const nearBottom = under;
    this.urchins.visible = this.stars.visible = this.fish.visible = nearBottom;
    if (nearBottom) {
      if (Math.hypot(cx - this.smallCenter.x, cz - this.smallCenter.y) > 3) {
        this.smallCenter.set(cx, cz);
        this.placeSmall(cx, cz);
      }
      this.updateFish(dt, time, camera.position, surfaceY);
    }
    this.kelpMat.userData.surge.value = 0.15 + 0.6 * (seaRough ?? 0.3);
  }
}
