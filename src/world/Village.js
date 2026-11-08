import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import buildingsData from '../assets/terrain/buildings.json';
import { heightAt, coverAt } from './Terrain.js';

// The settlements and the stones on the ground, Reine area.
//
// Buildings: every building in Kartverket's register (Matrikkelen) stands at
// its registered position, as the kind of building its type code says
// (house, rorbu, boathouse, sea house, fish plant...). The register has
// points, not outlines, so each gets the typical size and shape of its kind
// (blender/build_village.py), faces downhill (toward the water: boathouses
// and sea houses put their gable to the sea), and sits on the uphill ground
// with its foundation reaching down the slope. Rorbuer and sea houses stand
// on posts above high water.
//
// Stockfish racks (hjell) are not in the register: a few are put on open,
// gentle ground near the fishery buildings - approximate places. The cod
// hangs on them from February to May only, as in reality.
//
// Boulders: blocks on the scree, erratics on the moraines, cobbles on the
// beaches, from the NGU deposit map, coloured by the bedrock under them;
// placed around the camera and refreshed as it moves.

function bytesFromDataUrl(url) {
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

// Matrikkelen building type code -> model
function kindOf(t) {
  if (t === 171 || t === 524 || t === 529 || t === 522) return 'rorbu';
  if (t === 183 || t === 245) return 'naust';
  if (t === 181 || t === 182) return 'shed';
  if (t >= 161 && t <= 163) return 'cabin';
  if (t === 244 || t === 248) return 'sjohus';
  if (t >= 200 && t < 300) return t === 241 || t === 249 ? 'shed' : 'plant';
  if (t >= 300 && t < 700) return 'shop';
  return 'house';
}

// wall colours seen in Reine and Hamnøy (sRGB)
const PALETTE = {
  house: [[0.93, 0.93, 0.9], [0.92, 0.86, 0.66], [0.86, 0.7, 0.3], [0.78, 0.52, 0.24], [0.55, 0.11, 0.08], [0.68, 0.73, 0.77]],
  cabin: [[0.42, 0.24, 0.14], [0.55, 0.11, 0.08], [0.2, 0.17, 0.15], [0.9, 0.88, 0.82]],
  rorbu: [[0.55, 0.1, 0.07], [0.55, 0.1, 0.07], [0.6, 0.13, 0.08], [0.86, 0.68, 0.28]],
  naust: [[0.48, 0.1, 0.07], [0.2, 0.16, 0.13], [0.55, 0.12, 0.08]],
  shed: [[0.55, 0.11, 0.08], [0.9, 0.9, 0.87], [0.55, 0.56, 0.55]],
  sjohus: [[0.55, 0.1, 0.07], [0.92, 0.92, 0.9], [0.86, 0.7, 0.3]],
  plant: [[0.88, 0.89, 0.88], [0.7, 0.73, 0.75], [0.82, 0.82, 0.78]],
  shop: [[0.93, 0.93, 0.9], [0.92, 0.86, 0.66], [0.86, 0.7, 0.3]],
};
const SIZE = {              // footprint half-extents (m) for placing on the ground
  house: [4, 4.75], cabin: [3, 3.75], rorbu: [3, 4.25], naust: [2.5, 4.5], shed: [2, 3],
  sjohus: [5, 9], plant: [9, 15], shop: [5, 8], hjell: [1.7, 12],
};
const POSTS = { rorbu: true, sjohus: true };

function hash(i, j, k = 0) {
  let h = (i * 374761393 + j * 668265263 + k * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

export class Village {
  constructor({ mobile = false } = {}) {
    this.group = new THREE.Group();
    this.mobile = mobile;
    this.rockRadius = mobile ? 260 : 400;
    this.rockCap = mobile ? 700 : 2000;            // per rock model (4 models)
    this.rockCenter = new THREE.Vector2(1e9, 1e9);
    this.ready = false;
  }

  load(url) {
    const loader = new GLTFLoader();
    const done = (gltf) => this.build(gltf.scene);
    const fail = (e) => console.error('village model failed to load', e);
    if (url.startsWith('data:')) loader.parse(bytesFromDataUrl(url), '', done, fail);
    else loader.load(url, done, undefined, fail);
  }

  build(scene) {
    // pieces by name: <kind>_<part>
    const pieces = {};
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const [kind, part] = o.name.split('_');
      (pieces[kind] = pieces[kind] || []).push({ part, geo: o.geometry, mat: o.material });
    });

    // ---- buildings: one transform per building, shared by its parts
    const per = {};
    for (const [x, z, t] of buildingsData.x_z_type) {
      const kind = kindOf(t);
      (per[kind] = per[kind] || []).push({ x, z, t });
    }
    this.racks = this.placeRacks(buildingsData.x_z_type);
    per.hjell = this.racks;
    this.counts = {};
    for (const [kind, list] of Object.entries(per)) {
      if (!pieces[kind] || !list.length) continue;
      this.counts[kind] = list.length;
      const xf = list.map((b, n) => this.placeBuilding(kind, b, n));
      for (const { part, geo, mat } of pieces[kind]) {
        const im = new THREE.InstancedMesh(geo, mat, list.length);
        im.castShadow = false;
        im.receiveShadow = false;
        xf.forEach((f, n) => {
          im.setMatrixAt(n, part === 'base' ? f.base : part === 'wood' && POSTS[kind] ? f.posts : f.m);
          if (part === 'walls') {
            const pal = PALETTE[kind] || PALETTE.house;
            const c = pal[Math.floor(hash(n, 7, kind.length) * pal.length)];
            im.setColorAt(n, _c.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace));
          }
        });
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        im.computeBoundingSphere();
        if (kind === 'hjell' && part === 'fish') {
          const month = new Date().getMonth();         // 0 = January
          im.visible = month >= 1 && month <= 4;       // cod on the racks February - May
        }
        this.group.add(im);
      }
    }

    // ---- boulders: instanced pools refilled around the camera
    this.rocks = [];
    for (let k = 0; k < 4; k++) {
      const p = pieces[`rock${k}`];
      if (!p) continue;
      const im = new THREE.InstancedMesh(p[0].geo, p[0].mat, this.rockCap);
      im.count = 0;
      im.frustumCulled = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.setColorAt(0, _c.setRGB(0.5, 0.5, 0.5));
      this.rocks.push(im);
      this.group.add(im);
    }
    this.ready = true;
  }

  // Orientation, height, foundation for one building.
  placeBuilding(kind, b, n) {
    const [hx, hz] = SIZE[kind];
    // downhill: where the ground falls (toward the shore)
    const e = 6;
    const gx = heightAt(b.x + e, b.z) - heightAt(b.x - e, b.z);
    const gz = heightAt(b.x, b.z + e) - heightAt(b.x, b.z - e);
    let yaw;
    if (Math.hypot(gx, gz) > 0.05) yaw = Math.atan2(gx, gz);   // model front (-Z) faces downhill
    else yaw = hash(n, 3, 11) * Math.PI * 2;
    yaw += (hash(n, 5, 13) - 0.5) * 0.35;
    if (kind === 'house' || kind === 'cabin' || kind === 'shop') {
      // houses: ridge along the slope or across it, both common
      if (hash(n, 9, 17) < 0.5) yaw += Math.PI / 2;
    }
    if (b.yaw !== undefined) yaw = b.yaw;
    _q.setFromAxisAngle(UP, yaw);
    const c = Math.cos(yaw), s = Math.sin(yaw);
    let hi = -Infinity, lo = Infinity;
    for (const [ax, az] of [[-hx, -hz], [hx, -hz], [-hx, hz], [hx, hz], [0, 0]]) {
      const h = heightAt(b.x + ax * c + az * s, b.z - ax * s + az * c);
      hi = Math.max(hi, h);
      lo = Math.min(lo, h);
    }
    const k = 0.9 + hash(n, 1, 23) * 0.25;
    let y;
    if (POSTS[kind]) y = Math.max(hi + 0.3, 1.9);            // floor above the highest tides
    else if (kind === 'hjell') y = (hi + lo) / 2;
    else y = Math.max(hi + 0.15, 0.6);
    _p.set(b.x, y, b.z);
    _s.set(k, k, k);
    const m = new THREE.Matrix4().compose(_p, _q, _s);
    // foundation reaches down to the lowest corner; posts to the ground or sea bed
    const drop = Math.max(0, y - lo) + 0.6;
    const base = new THREE.Matrix4().compose(_p, _q, new THREE.Vector3(k, Math.max(1, drop / 3), k));
    const posts = new THREE.Matrix4().compose(_p, _q, new THREE.Vector3(k, Math.max(0.6, (y - lo + 2) / 7), k));
    return { m, base, posts };
  }

  // Racks on open, gentle ground 25-90 m from fishery buildings.
  placeRacks(all) {
    const fish = all.filter(([, , t]) => t === 244 || t === 248 || t === 245 || t === 219);
    const out = [];
    const clear = (x, z, r) => all.every(([bx, bz]) => Math.hypot(bx - x, bz - z) > r) &&
      out.every((o) => Math.hypot(o.x - x, o.z - z) > 30);
    for (let n = 0; n < fish.length && out.length < 14; n += 2) {
      const [fx, fz] = fish[n];
      for (let tries = 0; tries < 24; tries++) {
        const a = hash(n, tries, 31) * Math.PI * 2, r = 25 + hash(n, tries, 37) * 65;
        const x = fx + Math.cos(a) * r, z = fz + Math.sin(a) * r;
        const h = heightAt(x, z);
        if (h < 2.5 || h > 40) continue;
        const sl = Math.hypot(heightAt(x + 8, z) - heightAt(x - 8, z), heightAt(x, z + 8) - heightAt(x, z - 8)) / 16;
        if (sl > 0.18 || !clear(x, z, 16)) continue;
        out.push({ x, z, t: 0, yaw: a + Math.PI / 2 });
        break;
      }
    }
    return out;
  }

  // Refill the boulders around (cx, cz) when the camera has moved on.
  updateRocks(cx, cz) {
    if (!this.ready || !this.rocks.length) return;
    if (Math.hypot(cx - this.rockCenter.x, cz - this.rockCenter.y) < this.rockRadius * 0.2) return;
    this.rockCenter.set(cx, cz);
    const R = this.rockRadius, cell = 10;
    const n = [0, 0, 0, 0];
    const i0 = Math.floor((cx - R) / cell), i1 = Math.floor((cx + R) / cell);
    const j0 = Math.floor((cz - R) / cell), j1 = Math.floor((cz + R) / cell);
    const cap = this.rockCap;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x0 = i * cell + 5, z0 = j * cell + 5;
        const d = Math.hypot(x0 - cx, z0 - cz);
        if (d > R) continue;
        const cv = coverAt(x0, z0);
        if (cv < 0) continue;
        const dep = cv & 15, bed = cv >> 4;
        // how many stones in this 10 m cell, how big
        let count = 0, smin = 0, smax = 0;
        if (dep === 1) { count = 3 + Math.floor(hash(i, j, 1) * 4.5); smin = 0.45; smax = 3.2; }
        else if (dep === 2 || dep === 3 || dep === 4) { count = hash(i, j, 2) < (dep === 4 ? 0.6 : 0.3) ? 1 : 0; smin = 0.8; smax = 2.6; }
        else if (dep === 5) { count = hash(i, j, 3) < 0.35 ? 2 : 0; smin = 0.25; smax = 0.7; }
        else if (dep === 0) { count = hash(i, j, 4) < 0.025 ? 1 : 0; smin = 1.0; smax = 3.0; }
        // fewer, bigger ones further away (small stones would not show)
        const keep = 1 - Math.max(0, (d - R * 0.45) / (R * 0.55));
        for (let s = 0; s < count; s++) {
          if (hash(i, j, 50 + s) > keep) continue;
          const x = x0 + (hash(i, j, 10 + s) - 0.5) * cell, z = z0 + (hash(i, j, 20 + s) - 0.5) * cell;
          const h = heightAt(x, z);
          if (h < -12 || dep === 8) continue;                    // too deep to see, or a lake
          const u = hash(i, j, 30 + s);
          const size = smin + (smax - smin) * u * u;            // mostly small, some big blocks
          const k = Math.floor(hash(i, j, 40 + s) * 4) % this.rocks.length;
          if (n[k] >= cap) continue;
          _q.setFromEuler(new THREE.Euler((u - 0.5) * 0.6, hash(i, j, 60 + s) * 6.28, (hash(i, j, 70 + s) - 0.5) * 0.6));
          _p.set(x, h - size * 0.07, z);                         // models are ~0.6 m tall per metre: a little buried
          _s.set(size, size, size);
          this.rocks[k].setMatrixAt(n[k], _m.compose(_p, _q, _s));
          // colour from the bedrock (multiplies the model's grey, linear): pale
          // grey-pink monzonite, grey gneiss, near-black gabbro; fresh scree paler
          const base = bed === 1 ? [0.86, 0.87, 0.9] : bed === 2 ? [0.36, 0.36, 0.38] : bed === 3 ? [0.82, 0.76, 0.68] : [0.95, 0.9, 0.85];
          const v = 0.3 + hash(i, j, 80 + s) * 0.2 + (dep === 1 ? 0.05 : 0);
          this.rocks[k].setColorAt(n[k], _c.setRGB(base[0] * v, base[1] * v, base[2] * v));
          n[k]++;
        }
      }
    }
    this.rocks.forEach((im, k) => {
      im.count = n[k];
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    });
    this.rockCount = n.reduce((a, b) => a + b, 0);
  }
}
