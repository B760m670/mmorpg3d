import * as THREE from 'three';
import { gunzipSync } from 'fflate';
import meta from '../assets/terrain/meta.json';
import innerUrl from '../assets/terrain/inner.dat?url';
import outerUrl from '../assets/terrain/outer.dat?url';
import expoInnerUrl from '../assets/terrain/expo_inner.dat?url';
import expoOuterUrl from '../assets/terrain/expo_outer.dat?url';
import coverUrl from '../assets/terrain/cover.dat?url';
import { WATER_TINT_GLSL } from './WaterOptics.js';

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
const [innerGz, outerGz, expoInnerGz, expoOuterGz, coverGz] = await Promise.all(
  [innerUrl, outerUrl, expoInnerUrl, expoOuterUrl, coverUrl].map(loadBytes),
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
// What covers the ground in each 10 m cell of the inner grid (NGU maps, see
// tools/build_landcover.py): low 4 bits loose deposit, high 4 bits bedrock.
export const DEPOSIT = { ROCK: 0, SCREE: 1, MORAINE: 2, THIN_MORAINE: 3, END_MORAINE: 4, BEACH: 5, DUNES: 6, WEATHERED: 7 };
export const BEDROCK = { MONZONITE: 0, GNEISS: 1, GABBRO: 2, SEDIMENTARY: 3 };
const cover = gunzipSync(coverGz);
export function coverAt(x, z) {
  const i = Math.round((x - inner.minX) / inner.spacing), j = Math.round((z - inner.minZ) / inner.spacing);
  if (i < 0 || j < 0 || i >= inner.nx || j >= inner.nz) return -1;
  return cover[j * inner.nx + i];
}
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
// The same rule as seabedHard() in the terrain shader: 0 soft bottom
// (sand, mud) .. 1 rock. Slope from heights 10 m either side, as there.
export function seabedHard(x, z) {
  const te = inner.spacing;
  const hL = heightAt(x - te, z), hR = heightAt(x + te, z), hN = heightAt(x, z - te), hS = heightAt(x, z + te);
  const ny = 2 * te / Math.hypot(hL - hR, 2 * te, hN - hS);
  const slope = 1 - ny, h = heightAt(x, z);
  const ss = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
  const patch = Math.sin(x * 0.031 + 2 * Math.sin(z * 0.023)) * Math.sin(z * 0.027 + 2 * Math.sin(x * 0.019));
  const shallow = ss(-9, -3, h) * 0.35;
  return { hard: Math.min(1, Math.max(ss(0.14, 0.3, slope), ss(0.05, 0.3, patch + shallow))), slope, h };
}

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

function coverTexture() {
  const t = new THREE.DataTexture(cover, inner.nx, inner.nz, THREE.RedFormat, THREE.UnsignedByteType);
  t.magFilter = t.minFilter = THREE.NearestFilter;     // class ids: never blend
  t.generateMipmaps = false;
  t.unpackAlignment = 1;
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
    uCover: { value: coverTexture() },
    uTide: { value: 0 },              // water level now, m above mean sea level
    uCamUnder: { value: 0 },          // 1 while the camera is under water
    uCamDepth: { value: 0 },          // its depth (m)
    uWaterTime: { value: 0 },         // s, for the caustics
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
  uniform sampler2D uCover;
  uniform float uTide;
  // land cover byte (deposit + 16 * bedrock), -1 outside the mapped area
  float coverAt(vec2 p) {
    vec2 uv = (p - uTerInnerBox.xy) / uTerInnerBox.zw + 0.5 * uTerInnerTexel.xy;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return -1.0;
    return floor(textureLod(uCover, uv, 0.0).r * 255.0 + 0.5);
  }
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

// The sea floor: hard (rock, boulders) or soft (sand, shell sand, mud).
// Steep bottoms and the shallows near land are mostly rock; elsewhere rock
// comes up in broad patches. SeaLife.js puts kelp, urchins and so on with
// the same rule, so it must match seabedHard() in sealife (JS).
const SEABED_GLSL = /* glsl */ `
  float rockPatch(vec2 p) {
    return sin(p.x * 0.031 + 2.0 * sin(p.y * 0.023)) * sin(p.y * 0.027 + 2.0 * sin(p.x * 0.019));
  }
  float seabedHard(vec2 p, float slope, float h) {
    float shallow = smoothstep(-9.0, -3.0, h) * 0.35;
    return clamp(max(smoothstep(0.14, 0.3, slope), smoothstep(0.05, 0.3, rockPatch(p) + shallow)), 0.0, 1.0);
  }
  // Caustics: sunlight focused by the waves into a moving net of bright
  // lines (two layers of cell edges drifting at different rates).
  vec2 h22(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    q += dot(q, q.yzx + 33.33);
    return fract((q.xx + q.yz) * q.zy);
  }
  float cellEdge(vec2 p, float t) {
    vec2 i = floor(p), f = fract(p);
    float d1 = 8.0, d2 = 8.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 g = vec2(float(x), float(y));
        vec2 o = h22(i + g);
        o = 0.5 + 0.45 * sin(t * (0.6 + 0.5 * o) + 6.2831 * o);
        vec2 r = g + o - f;
        float d = dot(r, r);
        if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
      }
    }
    return sqrt(d2) - sqrt(d1);
  }
  float caustics(vec2 p, float t) {
    float a = cellEdge(p * 0.85, t);
    float b = cellEdge(p * 1.2 + vec2(3.7, 1.3), t * 1.3);
    return pow(1.0 - smoothstep(0.0, 0.22, a), 2.5) * 0.65 + pow(1.0 - smoothstep(0.0, 0.18, b), 2.5) * 0.45;
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
  // double-sided so a seam's skirt shows from either side (the ground itself
  // is only ever seen from above)
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.93, metalness: 0.0, side: THREE.DoubleSide });
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
          transformed.y = terrainHE(tp).x - aSkirt * (cell * 3.0 + 12.0);   // deep enough for steep seams
        }`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        vWPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uBumpScale;
        uniform float uWaterTime;
        varying vec3 vWPos;
        ${TERRAIN_GLSL}
        ${WATER_TINT_GLSL}
        ${SEABED_GLSL}
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
        // What lies here, from the NGU maps (edges broken up a little so the
        // 10 m cells do not show). Outside the mapped area: rules of thumb.
        vec2 jit = (vec2(rockFbm(vWPos * 0.05), rockFbm(vWPos * 0.05 + 3.1)) - 0.5) * 22.0;
        float cv = coverAt(tp + jit);
        float dep = cv < 0.0 ? -1.0 : mod(cv, 16.0);
        float rockType = cv < 0.0 ? 0.0 : floor(cv / 16.0);
        // bedrock: brown monzonitic gneiss; the migmatite strip by Hamnøy is
        // darker and cooler with pale veins; gabbro nearly black
        vec3 col = vec3(0.17, 0.155, 0.135) + vec3(0.06, 0.055, 0.045) * nz;
        if (rockType == 1.0) {
          // irregular pale veins, only seen up close
          float vein = smoothstep(0.62, 0.8, rockFbm(vec3(dot(vWPos.xz, vec2(0.55, 0.83)) * 0.06, vWPos.y * 0.03, nz * 3.0)));
          col = mix(vec3(0.115, 0.12, 0.125) + vec3(0.04) * nz, vec3(0.3, 0.29, 0.27), vein * 0.35 * exp(-tDist / 400.0));
        } else if (rockType == 2.0) {
          col = vec3(0.075, 0.075, 0.08) + vec3(0.03) * nz;
        }
        float gentle = smoothstep(0.45, 0.16, slope);
        float lowland = smoothstep(3.0, 14.0, tH) * (1.0 - smoothstep(320.0, 520.0, tH + nz * 80.0));
        vec3 heath = vec3(0.075, 0.11, 0.05) + vec3(0.035, 0.03, 0.0) * nz;     // grass, crowberry, bilberry
        float veg = 0.0, bumpK = 1.0, roughK = 0.93;
        if (dep < 0.0) {
          veg = gentle * lowland;
        } else if (dep == 0.0) {                       // bare rock: heath only in the hollows
          veg = gentle * lowland * smoothstep(0.45, 0.7, nz + 0.25 * gentle);
        } else if (dep == 1.0) {                       // scree: pale blocky rubble, some moss low down
          // blocks up close, an even pale grey from afar (no sparkle)
          float blocks = mix(0.5, rockFbm(vWPos * 0.35), exp(-tDist / 90.0));
          vec3 rub = vec3(0.25, 0.24, 0.225) * (0.78 + 0.44 * blocks);
          col = mix(col, rub, 0.85);
          veg = lowland * 0.25 * smoothstep(0.55, 0.75, nz);
          bumpK = 1.6; roughK = 1.0;
        } else if (dep <= 4.0) {                       // moraine: green, stony; patchier when thin
          float stones = dep == 2.0 ? 0.15 : dep == 3.0 ? 0.35 : 0.55;
          veg = lowland * (1.0 - stones * smoothstep(0.4, 0.7, rockFbm(vWPos * 0.3)));
          col = mix(col, vec3(0.2, 0.19, 0.17), 0.4);
          bumpK = 0.8;
        } else if (dep == 5.0) {                       // beach: shingle and sand
          col = mix(vec3(0.42, 0.39, 0.33), vec3(0.3, 0.29, 0.27), smoothstep(0.4, 0.7, rockFbm(vWPos * 0.6)));
          bumpK = 0.35; roughK = 0.85;
        } else if (dep == 6.0) {                       // dunes: pale sand, marram grass on top
          col = vec3(0.6, 0.56, 0.46) * (0.92 + 0.16 * nz);
          veg = 0.45 * smoothstep(0.45, 0.65, rockFbm(vWPos * 0.15)) * smoothstep(4.0, 9.0, tH);
          heath = vec3(0.2, 0.22, 0.09);
          bumpK = 0.2; roughK = 0.9;
        } else {                                       // weathered material: brown grit
          col = mix(col, vec3(0.22, 0.17, 0.12), 0.7);
          veg = gentle * lowland * 0.35;
        }
        col = mix(col, heath, veg);
        float snow = smoothstep(560.0, 720.0, tH + nz * 120.0) * smoothstep(0.55, 0.28, slope);
        col = mix(col, vec3(0.82, 0.85, 0.9), snow);
        // Shore zones, with the real tide (spring range about 2.4 m): black
        // lichen just above high water, wracks (Fucus) between the tides,
        // and everything below the falling water still wet and dark.
        float lichen = smoothstep(0.9, 1.4, tH) * (1.0 - smoothstep(2.3, 3.0, tH)) * (1.0 - veg);
        col = mix(col, vec3(0.035, 0.035, 0.03), 0.8 * lichen * step(-0.5, dep));
        float wrack = smoothstep(-1.5, -1.0, tH) * (1.0 - smoothstep(0.6, 1.1, tH)) * smoothstep(0.3, 0.55, rockFbm(vWPos * 0.4)) * step(dep, 4.5);
        col = mix(col, vec3(0.1, 0.085, 0.035), wrack);
        float tide = smoothstep(uTide + 1.0, uTide + 0.05, tH) * smoothstep(-2.0, -1.0, tH);
        col *= 1.0 - 0.45 * tide;
        // the sea floor: sand and shell on the gentle bottom, gravel, dark
        // rock on the steep sides, mud in the deep basins
        // (below the lowest tides; scree runs on under water as a boulder field)
        float under = smoothstep(-1.2, -2.2, tH);
        float hard = max(seabedHard(tp, slope, tH), dep == 1.0 ? 0.85 : 0.0);
        float grain = rockFbm(vWPos * 0.9);
        // shell sand, pale and speckled in the shallows; finer and greyer
        // deeper; mud in the basins
        vec3 sand = mix(vec3(0.46, 0.43, 0.36), vec3(0.32, 0.31, 0.27), nz);
        float shell = smoothstep(0.6, 0.72, rockFbm(vWPos * 14.0));
        sand *= 1.0 + 0.3 * shell * exp(-tDist / 6.0);
        sand = mix(sand, vec3(0.24, 0.22, 0.18), smoothstep(-30.0, -70.0, tH));
        // rock: dark in the kelp zone, below it crusted pink with coralline algae
        vec3 rk = vec3(0.12, 0.12, 0.11) * (0.75 + 0.5 * grain);
        float coral = smoothstep(-8.0, -16.0, tH) * (1.0 - smoothstep(-35.0, -50.0, tH)) * smoothstep(0.35, 0.6, rockFbm(vWPos * 0.25 + 7.0));
        rk = mix(rk, vec3(0.36, 0.2, 0.24), coral * 0.75);
        vec3 bed = mix(sand, rk, hard);
        col = mix(col, bed, under);
        // lakes: found in the height model (flat, connected) by the build tool
        float cv0 = coverAt(tp);
        float lake = cv0 < 0.0 ? 0.0 : step(7.5, mod(cv0, 16.0)) * step(mod(cv0, 16.0), 8.5);
        col = mix(col, vec3(0.02, 0.028, 0.034), lake);
        float strata = 1.0 - 0.06 * smoothstep(0.3, 0.9, sin(vWPos.y * 0.31 + big * 9.0 + nz * 5.0)) * smoothstep(0.35, 0.7, slope);
        diffuseColor.rgb = col * mix((0.72 + 0.56 * big) * strata, 1.0, max(lake, snow * 0.5));
        diffuseColor.rgb *= waterTint(vWPos.y);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor * roughK, 0.12, lake);
        roughnessFactor = mix(roughnessFactor, 0.45, tide);`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        // dry rock and turf are nearly matt; only lakes and the wet shore shine
        {
          float shine = max(lake, tide);
          reflectedLight.directSpecular *= mix(0.15, 1.0, shine);
          reflectedLight.indirectSpecular *= mix(0.5, 1.0, shine);
        }
        {
          // caustics on the bottom in the first metres, near the eye
          float wd = uTide - vWPos.y;
          if (wd > 0.15 && tDist < 70.0) {
            float k = exp(-wd / 7.0) * smoothstep(70.0, 30.0, tDist) * smoothstep(0.15, 1.2, wd);
            reflectedLight.directDiffuse *= 1.0 + k * (caustics(vWPos.xz, uWaterTime) * 2.4 - 0.6);
          }
        }`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        normal = normalize((viewMatrix * vec4(terN, 0.0)).xyz);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          // the finer octave only close by, where a pixel is smaller than its grain
          float bh = rockFbm(vWPos * 0.11) + 0.45 * rockFbm(vWPos * 0.47) * exp(-tDist / 35.0);
          // fine relief only near by, and not on turf: far off, or against the
          // light, it would sparkle (specular aliasing)
          float bumpFade = exp(-tDist / 160.0) * (1.0 - lake) * (1.0 - 0.6 * snow) * (1.0 - 0.75 * veg);
          if (bumpK > 1.5) bh += 0.5 * rockFbm(vWPos * 0.6) * exp(-tDist / 50.0);   // scree: blocks
          // ripples in the sand on the bottom, from the swell
          float sandK = under * (1.0 - hard) * exp(-tDist / 18.0) * smoothstep(-25.0, -3.0, tH);
          bh += sandK * 0.09 * sin(dot(vWPos.xz, vec2(0.8, 0.6)) * 9.0 + 2.5 * rockFbm(vWPos * 0.2));
          bh += under * hard * 0.25 * rockFbm(vWPos * 1.3) * exp(-tDist / 20.0);
          vec2 dH = clamp(vec2(dFdx(bh), dFdy(bh)) * uBumpScale * bumpK * bumpFade, -0.45, 0.45);
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
