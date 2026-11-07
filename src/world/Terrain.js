import * as THREE from 'three';
import { gunzipSync } from 'fflate';
import meta from '../assets/terrain/meta.json';
import innerUrl from '../assets/terrain/inner.dat?url';
import outerUrl from '../assets/terrain/outer.dat?url';
import expoInnerUrl from '../assets/terrain/expo_inner.dat?url';
import expoOuterUrl from '../assets/terrain/expo_outer.dat?url';

// Real terrain: Reine, Moskenesøya, Lofoten. Land from Kartverket's national
// height model (10 m), sea floor from the EMODnet bathymetry model, merged by
// tools/build_terrain.py. Two grids: 10 m over the 10 x 11 km you sail in,
// 64 m over 41 x 41 km for the mountains on the horizon.
//
// World frame: x east, z south (north is -Z), metres from the spawn point in
// open water south-east of Reine.
//
// The same heights answer the CPU (boat grounding, camera, radar, echo
// sounder, chart) and drive the GPU mesh: a quadtree of square patches, finer
// near the camera, all drawn as instances of one grid in a single draw call;
// the vertex shader lifts each vertex to the height from a texture, skirts
// hide the seams between patches of different size.

// ------------------------------------------------------------------ data
// Loaded once at start-up. In the single-file page these are data: URLs,
// decoded here by hand: the page's content security policy refuses fetch()
// of data: URLs (the ship model is loaded the same way). In development they
// are ordinary URLs and are fetched.
async function loadBytes(url) {
  if (url.startsWith('data:')) {
    const bin = atob(url.slice(url.indexOf(',') + 1));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`terrain data ${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}
const [innerGz, outerGz, expoInnerGz, expoOuterGz] = await Promise.all(
  [innerUrl, outerUrl, expoInnerUrl, expoOuterUrl].map(loadBytes),
);

function decodeHeights(gz, nx, nz) {
  const raw = gunzipSync(gz);
  const d = new Uint16Array(raw.buffer, raw.byteOffset, nx * nz);
  const h = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    let v = 0;
    for (let i = 0; i < nx; i++) {
      v = (v + d[j * nx + i]) & 0xffff;          // rows are delta-coded
      h[j * nx + i] = v * meta.heightScale + meta.heightOffset;
    }
  }
  return h;
}

function decodeBytes(gz, nx, nz) {
  const raw = gunzipSync(gz);
  const e = new Float32Array(nx * nz);
  for (let i = 0; i < e.length; i++) e[i] = raw[i] / 255;
  return e;
}

class Grid {
  constructor(g, data) {
    this.nx = g.nx; this.nz = g.nz; this.spacing = g.spacing;
    this.minX = g.minX; this.minZ = g.minZ;
    this.maxX = g.minX + (g.nx - 1) * g.spacing;
    this.maxZ = g.minZ + (g.nz - 1) * g.spacing;
    this.data = data;
  }

  inside(x, z) {
    return x >= this.minX && x <= this.maxX && z >= this.minZ && z <= this.maxZ;
  }

  // bilinear, clamped at the edges
  sample(x, z) {
    let fx = (x - this.minX) / this.spacing, fz = (z - this.minZ) / this.spacing;
    fx = Math.min(Math.max(fx, 0), this.nx - 1.001);
    fz = Math.min(Math.max(fz, 0), this.nz - 1.001);
    const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j;
    const d = this.data, k = j * this.nx + i;
    const a = d[k] + (d[k + 1] - d[k]) * tx;
    const b = d[k + this.nx] + (d[k + this.nx + 1] - d[k + this.nx]) * tx;
    return a + (b - a) * tz;
  }
}

const inner = new Grid(meta.inner, decodeHeights(innerGz, meta.inner.nx, meta.inner.nz));
const outer = new Grid(meta.outer, decodeHeights(outerGz, meta.outer.nx, meta.outer.nz));
const expoInner = new Grid(meta.inner.expo, decodeBytes(expoInnerGz, meta.inner.expo.nx, meta.inner.expo.nz));
const expoOuter = new Grid(meta.outer.expo, decodeBytes(expoOuterGz, meta.outer.expo.nx, meta.outer.expo.nz));
const OPEN_SEA = -250;     // beyond the outer grid: Vestfjorden / the Norwegian Sea
const EDGE = 300;          // inner grid fades into the outer over this distance (m)

export function heightAt(x, z) {
  const ho = outer.inside(x, z) ? outer.sample(x, z) : OPEN_SEA;
  const e = Math.min(x - inner.minX, inner.maxX - x, z - inner.minZ, inner.maxZ - z);
  if (e <= 0) return ho;
  const hi = inner.sample(x, z);
  return e >= EDGE ? hi : ho + (hi - ho) * (e / EDGE);
}

// 0 in a closed bay .. 1 in open sea: how much of the swell gets here.
export function exposureAt(x, z) {
  if (expoInner.inside(x, z)) return expoInner.sample(x, z);
  if (expoOuter.inside(x, z)) return expoOuter.sample(x, z);
  return 1;
}

// True where the boat can float (deep enough water).
export function isNavigable(x, z) {
  return heightAt(x, z) < -4;
}

export const TERRAIN_INFO = {
  name: 'Reine, Lofoten',
  sources: meta.sources,
  reineUTM: meta.reine_utm33,
  originUTM: meta.origin_utm33,
};

// ------------------------------------------------------------------ GPU side
// RG half-float textures: height, exposure. Shared with the ocean shader.
function makeTexture(h, ex, g, eg) {
  const n = g.nx * g.nz;
  const data = new Uint16Array(n * 2);
  const toHalf = THREE.DataUtils.toHalfFloat;
  for (let j = 0; j < g.nz; j++) {
    const z = g.minZ + j * g.spacing;
    for (let i = 0; i < g.nx; i++) {
      const k = j * g.nx + i;
      data[k * 2] = toHalf(h.data[k]);
      data[k * 2 + 1] = toHalf(eg.inside(g.minX + i * g.spacing, z) ? eg.sample(g.minX + i * g.spacing, z) : 1);
    }
  }
  const t = new THREE.DataTexture(data, g.nx, g.nz, THREE.RGFormat, THREE.HalfFloatType);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

let sharedUniforms = null;
// Uniforms for TERRAIN_GLSL (built once, shared by terrain and ocean).
export function terrainUniforms() {
  if (sharedUniforms) return sharedUniforms;
  const box = (g) => new THREE.Vector4(g.minX, g.minZ, g.nx * g.spacing, g.nz * g.spacing);
  sharedUniforms = {
    uTerInner: { value: makeTexture(inner, null, inner, expoInner) },
    uTerOuter: { value: makeTexture(outer, null, outer, expoOuter) },
    uTerInnerBox: { value: box(inner) },
    uTerOuterBox: { value: box(outer) },
    uTerInnerTexel: { value: new THREE.Vector3(1 / inner.nx, 1 / inner.nz, inner.spacing) },
    uTerOuterTexel: { value: new THREE.Vector3(1 / outer.nx, 1 / outer.nz, outer.spacing) },
  };
  return sharedUniforms;
}

// terrainHE(p): (height m, exposure 0..1) at world xz, the same as heightAt /
// exposureAt on the CPU.
export const TERRAIN_GLSL = /* glsl */ `
  uniform sampler2D uTerInner;
  uniform sampler2D uTerOuter;
  uniform vec4 uTerInnerBox;     // min x, min z (cell centres), width, depth (m)
  uniform vec4 uTerOuterBox;
  uniform vec3 uTerInnerTexel;   // 1/nx, 1/nz, spacing
  uniform vec3 uTerOuterTexel;
  vec2 terrainHE(vec2 p) {
    vec2 uo = (p - uTerOuterBox.xy) / uTerOuterBox.zw + 0.5 * uTerOuterTexel.xy;
    vec2 o = textureLod(uTerOuter, uo, 0.0).rg;
    if (uo.x < 0.0 || uo.y < 0.0 || uo.x > 1.0 || uo.y > 1.0) o = vec2(${OPEN_SEA.toFixed(1)}, 1.0);
    vec2 lo = p - uTerInnerBox.xy;
    vec2 hi = uTerInnerBox.xy + uTerInnerBox.zw - uTerInnerTexel.z - p;
    float e = min(min(lo.x, lo.y), min(hi.x, hi.y));
    if (e <= 0.0) return o;
    vec2 i = textureLod(uTerInner, lo / uTerInnerBox.zw + 0.5 * uTerInnerTexel.xy, 0.0).rg;
    return mix(o, i, clamp(e / ${EDGE.toFixed(1)}, 0.0, 1.0));
  }
`;

const ROCK_GLSL = /* glsl */ `
  float h31(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float vnoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y),
      f.z);
  }
  float rockFbm(vec3 p) {
    float a = 0.0, amp = 0.5;
    for (int i = 0; i < 4; i++) { a += amp * vnoise(p); p *= 2.07; amp *= 0.5; }
    return a;
  }
  vec3 perturbRock(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDir) {
    vec3 vSigmaX = normalize(dFdx(surf_pos));
    vec3 vSigmaY = normalize(dFdy(surf_pos));
    vec3 R1 = cross(vSigmaY, surf_norm);
    vec3 R2 = cross(surf_norm, vSigmaX);
    float fDet = dot(vSigmaX, R1) * faceDir;
    vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
    return normalize(abs(fDet) * surf_norm - vGrad);
  }
`;

function buildMaterial(cells) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.93, metalness: 0.0 });
  const U = terrainUniforms();
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U);
    shader.uniforms.uBumpScale = { value: 5.0 };
    shader.uniforms.uCellFrac = { value: 1 / cells };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aSkirt;
        uniform float uCellFrac;
        varying vec3 vWPos;
        ${TERRAIN_GLSL}`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          vec2 tp = (instanceMatrix * vec4(position, 1.0)).xz;
          float cell = instanceMatrix[0][0] * uCellFrac;
          transformed.y = terrainHE(tp).x - aSkirt * (cell * 1.5 + 4.0);
        }`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        vWPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uBumpScale;
        varying vec3 vWPos;
        ${TERRAIN_GLSL}
        ${ROCK_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        // the surface normal from the height texture, sampled wider far away
        float tDist = length(vViewPosition);
        float te = max(uTerInnerTexel.z, tDist * 0.004);
        vec2 tp = vWPos.xz;
        float tH = terrainHE(tp).x;
        float hL = terrainHE(tp - vec2(te, 0.0)).x, hR = terrainHE(tp + vec2(te, 0.0)).x;
        float hN = terrainHE(tp - vec2(0.0, te)).x, hS = terrainHE(tp + vec2(0.0, te)).x;
        vec3 terN = normalize(vec3(hL - hR, 2.0 * te, hN - hS));
        float slope = 1.0 - terN.y;
        float big = rockFbm(vWPos * 0.045);
        float nz = rockFbm(vec3(vWPos.xz * 0.02, 1.7));
        // bare grey gabbro and gneiss, green on the gentler slopes, snow
        // lying on the high ledges, a dark wet band with weed at the tide line
        vec3 col = vec3(0.15, 0.15, 0.145) + vec3(0.06, 0.06, 0.05) * nz;
        float grass = smoothstep(0.42, 0.16, slope) * smoothstep(3.0, 14.0, tH) * (1.0 - smoothstep(320.0, 520.0, tH + nz * 80.0));
        col = mix(col, vec3(0.075, 0.11, 0.05) + vec3(0.03, 0.03, 0.0) * nz, grass);
        float snow = smoothstep(560.0, 720.0, tH + nz * 120.0) * smoothstep(0.55, 0.28, slope);
        col = mix(col, vec3(0.82, 0.85, 0.9), snow);
        float tide = smoothstep(2.2, 0.3, tH) * smoothstep(-1.5, 0.0, tH);
        col = mix(col, vec3(0.05, 0.045, 0.03), tide);
        // the sea floor: sand and shell on the gentle bottom, gravel, dark
        // rock on the steep sides, mud in the deep basins
        float under = smoothstep(-0.3, -1.5, tH);
        vec3 sand = mix(vec3(0.42, 0.4, 0.33), vec3(0.3, 0.29, 0.25), nz);
        vec3 bed = mix(sand, vec3(0.13, 0.13, 0.12), smoothstep(0.18, 0.45, slope));
        bed = mix(bed, vec3(0.2, 0.19, 0.16), smoothstep(-40.0, -110.0, tH));
        col = mix(col, bed, under);
        // mountain lakes: the height model has them dead flat
        float lake = (1.0 - smoothstep(0.0006, 0.0018, slope)) * step(2.0, tH);
        col = mix(col, vec3(0.02, 0.028, 0.034), lake);
        float strata = 1.0 - 0.06 * smoothstep(0.3, 0.9, sin(vWPos.y * 0.31 + big * 9.0 + nz * 5.0)) * smoothstep(0.35, 0.7, slope);
        diffuseColor.rgb = col * mix((0.72 + 0.56 * big) * strata, 1.0, max(lake, snow * 0.5));`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.12, lake);
        roughnessFactor = mix(roughnessFactor, 0.55, tide);`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        normal = normalize((viewMatrix * vec4(terN, 0.0)).xyz);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          float bh = rockFbm(vWPos * 0.11) + 0.45 * rockFbm(vWPos * 0.47);
          float bumpFade = exp(-tDist / 350.0) * (1.0 - lake) * (1.0 - 0.6 * snow);
          vec2 dH = clamp(vec2(dFdx(bh), dFdy(bh)) * uBumpScale * bumpFade, -0.6, 0.6);
          normal = perturbRock(-vViewPosition, normal, dH, faceDirection);
        }`);
  };
  return mat;
}

// One square patch: (cells+1)^2 vertices over [0,1]^2, plus a skirt round
// the edge that hangs down to cover seams.
function patchGeometry(cells) {
  const n = cells + 1;
  const pos = [], skirt = [], idx = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) { pos.push(i / cells, 0, j / cells); skirt.push(0); }
  }
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const ring = [];
  for (let i = 0; i < cells; i++) ring.push(i);                      // north edge, west to east
  for (let j = 0; j < cells; j++) ring.push(j * n + cells);          // east edge
  for (let i = cells; i > 0; i--) ring.push(cells * n + i);          // south edge
  for (let j = cells; j > 0; j--) ring.push(j * n);                  // west edge
  const base = pos.length / 3;
  for (const v of ring) { pos.push(pos[v * 3], 0, pos[v * 3 + 2]); skirt.push(1); }
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k], b = ring[(k + 1) % ring.length];
    const a2 = base + k, b2 = base + (k + 1) % ring.length;
    idx.push(a, b, a2, b, b2, a2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aSkirt', new THREE.Float32BufferAttribute(skirt, 1));
  geo.setIndex(idx);
  return geo;
}

const _frustum = new THREE.Frustum();
const _m = new THREE.Matrix4();
const _box = new THREE.Box3();
const _cam = new THREE.Vector3();

export class Terrain {
  constructor({ mobile = false } = {}) {
    this.cells = mobile ? 24 : 32;
    this.leaf = 320;                         // smallest patch (m): 10-13 m cells
    this.split = mobile ? 2.0 : 2.4;         // split a patch nearer than this many sizes
    this.max = 400;
    this.root = { x: outer.minX - outer.spacing / 2, z: outer.minZ - outer.spacing / 2, size: outer.nx * outer.spacing };
    this.ranges = new Map();
    this.mesh = new THREE.InstancedMesh(patchGeometry(this.cells), buildMaterial(this.cells), this.max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // the inner grid, for the chart, sound and anything else that walks it
    this.grid = { nx: inner.nx, nz: inner.nz, spacing: inner.spacing, minX: inner.minX, minZ: inner.minZ, heights: inner.data };
    this.patches = 0;
  }

  sample(x, z) { return heightAt(x, z); }
  exposure(x, z) { return exposureAt(x, z); }

  // height range of a patch: every 64 m cell it covers, padded for the
  // finer peaks of the 10 m grid (cached; each patch is scanned once)
  range(x0, z0, size) {
    const key = `${x0},${z0},${size}`;
    let r = this.ranges.get(key);
    if (r) return r;
    const g = outer, d = g.data;
    const i0 = Math.max(0, Math.floor((x0 - g.minX) / g.spacing) - 1);
    const i1 = Math.min(g.nx - 1, Math.ceil((x0 + size - g.minX) / g.spacing) + 1);
    const j0 = Math.max(0, Math.floor((z0 - g.minZ) / g.spacing) - 1);
    const j1 = Math.min(g.nz - 1, Math.ceil((z0 + size - g.minZ) / g.spacing) + 1);
    let lo = Infinity, hi = -Infinity;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const h = d[j * g.nx + i];
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
    if (x0 < g.minX || z0 < g.minZ || x0 + size > g.maxX || z0 + size > g.maxZ || lo > hi) {
      lo = Math.min(lo, OPEN_SEA);
      hi = Math.max(hi, 0);
    }
    r = [lo - 60, hi + 60];
    this.ranges.set(key, r);
    return r;
  }

  // choose patches for this camera
  update(camera) {
    camera.updateMatrixWorld();
    _frustum.setFromProjectionMatrix(_m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    _cam.copy(camera.position);
    let n = 0;
    const visit = (x0, z0, size) => {
      const [lo, hi] = this.range(x0, z0, size);
      _box.min.set(x0, lo, z0);
      _box.max.set(x0 + size, hi, z0 + size);
      if (!_frustum.intersectsBox(_box)) return;
      if (size > this.leaf && _box.distanceToPoint(_cam) < this.split * size && n < this.max - 4) {
        const h = size / 2;
        visit(x0, z0, h); visit(x0 + h, z0, h); visit(x0, z0 + h, h); visit(x0 + h, z0 + h, h);
        return;
      }
      if (n >= this.max) return;
      _m.makeScale(size, 1, size).setPosition(x0, 0, z0);
      this.mesh.setMatrixAt(n++, _m);
    };
    visit(this.root.x, this.root.z, this.root.size);
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.patches = n;
  }
}
