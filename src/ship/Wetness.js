import * as THREE from 'three';

// Wet wood, rope and iron, as water really sits on a ship.
//
//  * Rain wets whatever is open to the sky, and only that: a height map of
//    the ship seen from above (made once, when she is built) tells what is
//    under a deck. Upturned faces wet first and most; standing water
//    gathers in the seams between the planks and, as it goes on raining,
//    in pools in the low places of the decks, the lee side first; drops
//    ring the pools. When the rain stops it all dries, slowly.
//  * The sea along her sides: the band the waves run up and down is wet,
//    and stays wet a long while after a sea has climbed it (the side
//    remembers: a map of her sides kept from the water's height along
//    them); the bow wave climbs higher with way on.
//  * Green water: when she buries her bow, the forecastle and the beak
//    run with it.
//  * Below the waterline, inside, it is damp; bilge water stands on the
//    floor of the hold.
//
// How a wet surface looks (as measured, after Lagarde, "Water drop", 2013):
// water fills the pores of wood, canvas and rope, and they darken (the
// more porous, the more: light is trapped in the water-filled pores);
// a film of water makes any surface glossy; where water stands deep
// enough to drown the grain, the surface is a flat mirror (roughness of
// water, ~0.03) over a darker floor. Metal does not darken.

// how porous each scanned material is (0 metal .. 1 rope and canvas)
export const POROSITY = {
  hull_planks: 0.8, deck_planks: 0.9, in_planks: 0.8, timber: 0.85, joinery: 0.55,
  black_wood: 0.4, red_paint: 0.35, iron: 0.05, lead: 0.0, brick: 0.9, bronze: 0.0,
  rope: 1.0, canvas: 1.0,
};

const OCC = { x0: -9.5, z0: -45, w: 19, d: 76, nx: 384, nz: 1536 };    // the top-down map, model frame
const HMIN = -8, HMAX = 62;                                              // its height range (m)
const SIDE = { s0: -4, ds: 0.5, ns: 124, z0: -1.5, dz: 0.125, nz: 64 };  // the map of her sides

export class Wetness {
  constructor(renderer, rig) {
    this.renderer = renderer;
    this.rig = rig;
    this.rainWet = 0;      // film of rain on what is open to the sky (0..1)
    this.rainPool = 0;     // standing water on the decks (0..1)
    this.bowWet = 0;       // green water over the bow
    this.side = new Float32Array(SIDE.ns * SIDE.nz * 2);
    this.sideBytes = new Uint8Array(SIDE.ns * SIDE.nz * 2);
    this.sideTex = new THREE.DataTexture(this.sideBytes, SIDE.ns, SIDE.nz * 2, THREE.RedFormat, THREE.UnsignedByteType);
    this.sideTex.magFilter = this.sideTex.minFilter = THREE.LinearFilter;
    this.sideTex.needsUpdate = true;
    this.sideT = 0;
    this.occ = null;
    this.hull = decodeHull(rig.hull);
    const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    blank.needsUpdate = true;
    this.uniforms = {
      uShipInv: { value: new THREE.Matrix4() },
      uShipMat: { value: new THREE.Matrix4() },
      uRainOcc: { value: blank },
      uOcc: { value: new THREE.Vector4(OCC.x0, OCC.z0, OCC.w, OCC.d) },
      uOccH: { value: new THREE.Vector2(HMIN, HMAX) },
      uSideWet: { value: this.sideTex },
      uSide: { value: new THREE.Vector4(SIDE.s0, SIDE.ds * SIDE.ns, SIDE.z0, SIDE.dz * SIDE.nz) },
      uHullTex: { value: this.hull.tex },
      uHullS: { value: new THREE.Vector4(rig.hull.s0, rig.hull.ds, rig.hull.ns, rig.hull.sMid) },
      uHullZ: { value: new THREE.Vector4(rig.hull.z0, rig.hull.dz, rig.hull.nz, rig.hull.unit) },
      uRainWet: { value: 0 },
      uRainPool: { value: 0 },
      uRainNow: { value: 0 },
      uBowWet: { value: 0 },
      uHeel: { value: 0 },
      uWetTime: { value: 0 },
    };
  }

  // Make a material get wet. porosity: 0 (metal) .. 1 (rope).
  patch(mat, porosity) {
    const U = this.uniforms;
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.uniforms.uPorosity = { value: porosity };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWetPos;\nvarying vec3 vWetN;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvWetPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWetN = normalize(mat3(modelMatrix) * objectNormal);');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${FRAG_SURFACE}`)
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nvec3 wetGeoN = normal;')
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FRAG_NORMAL}`);
    };
    mat.customProgramCacheKey = () => 'wet';
    mat.needsUpdate = true;
  }

  // The ship seen from straight above, once: the height of the highest
  // thing over every spot, so that rain falls only where nothing covers it.
  bake(model) {
    const r = this.renderer;
    const scene = new THREE.Scene();
    const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
    const mat = new THREE.ShaderMaterial({
      vertexShader: 'varying float vH; void main() { vec4 p = modelMatrix * vec4(position, 1.0); vH = p.y; gl_Position = projectionMatrix * viewMatrix * p; }',
      fragmentShader: `varying float vH; void main() { float t = clamp((vH - (${HMIN.toFixed(1)})) / ${(HMAX - HMIN).toFixed(1)}, 0.0, 1.0) * 65535.0; float hi = floor(t / 256.0); gl_FragColor = vec4(hi / 255.0, (t - hi * 256.0) / 255.0, 0.0, 1.0); }`,
      side: THREE.DoubleSide,
    });
    model.updateMatrixWorld(true);
    model.traverse((o) => {
      if (!o.isMesh || !o.visible && o !== model) return;
      const m = new THREE.Mesh(o.geometry, mat);
      m.matrixAutoUpdate = false;
      m.matrix.multiplyMatrices(inv, o.matrixWorld);
      scene.add(m);
    });
    const cam = new THREE.OrthographicCamera(OCC.x0, OCC.x0 + OCC.w, -OCC.z0, -(OCC.z0 + OCC.d), 0.1, 200);
    cam.position.set(0, 100, 0);
    cam.up.set(0, 0, -1);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    // looking down with "up" toward -z: the image's x is the ship's x, its
    // y is -z; the top/bottom planes are set for that
    cam.top = -OCC.z0; cam.bottom = -(OCC.z0 + OCC.d);
    cam.updateProjectionMatrix();
    const rt = new THREE.WebGLRenderTarget(OCC.nx, OCC.nz, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
    const prev = r.getRenderTarget(), clear = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    r.setRenderTarget(rt);
    r.setClearColor(0x000000, 1);
    r.clear();
    r.render(scene, cam);
    r.setRenderTarget(prev);
    r.setClearColor(clear, ca);
    rt.texture.minFilter = rt.texture.magFilter = THREE.NearestFilter;
    this.occ = rt;
    this.uniforms.uRainOcc.value = rt.texture;
    mat.dispose();
  }

  // dt; rain 0..1 now; wind m/s; ship (Galleon); water(x, z) -> height
  update(dt, time, rain, wind, ship, water) {
    const U = this.uniforms;
    // rain wets in about half a minute; dries in the wind over several
    const dry = 1 / (420 / (1 + wind / 6));
    this.rainWet += (rain > 0.02 ? (Math.min(1, rain * 2.5) - this.rainWet) / 30 : -this.rainWet * dry) * dt;
    this.rainWet = THREE.MathUtils.clamp(this.rainWet, 0, 1);
    // pools gather over minutes of rain, and drain and dry slower still
    this.rainPool += (rain > 0.05 ? rain * (1 - this.rainPool) / 150 : -this.rainPool * dry * 0.6) * dt;
    this.rainPool = THREE.MathUtils.clamp(this.rainPool, 0, 1);
    // green water: a burst when she buries her bow, then running off
    if (ship.slam > 0) this.bowWet = Math.max(this.bowWet, 0.6 + 0.4 * ship.slam);
    this.bowWet = Math.max(this.bowWet - dt / 90, Math.min(1, ship.bowSpray * 0.8));
    U.uRainWet.value = this.rainWet;
    U.uRainPool.value = this.rainPool;
    U.uRainNow.value = rain;
    U.uBowWet.value = this.bowWet;
    U.uHeel.value = ship.heel + ship.roll;
    U.uWetTime.value = time;
    const mw = (ship.model || ship.group).matrixWorld;
    U.uShipMat.value.copy(mw);
    U.uShipInv.value.copy(mw).invert();
    // her sides: where the sea reaches now, wet; elsewhere drying
    this.sideT -= dt;
    if (this.sideT <= 0 && water) {
      const step = 0.25;
      this.sideT = step;
      this._sides(step, ship, water, time, mw);
    }
  }

  _sides(dt, ship, water, time, mw) {
    const keep = Math.exp(-dt / 150);           // oak stays dark for minutes after a sea
    const p = this._p || (this._p = new THREE.Vector3());
    const runBow = 0.4 + 1.2 * Math.min(1, Math.max(0, ship.speed) / 4.5);
    for (let side = 0; side < 2; side++) {
      const sx = side ? -1 : 1;
      for (let i = 0; i < SIDE.ns; i += 2) {
        const s = SIDE.s0 + SIDE.ds * (i + 0.5);
        const hb = this.hull.at(s, 0.3);
        let reach = -99;
        if (hb > 0.2) {
          p.set(sx * (hb + 0.3), 0, this.rig.hull.sMid - s).applyMatrix4(mw);
          const h = water(p.x, p.z, time);
          // the water's height against her side, in her frame
          reach = h - p.y + 0.3 + runBow * Math.max(0, (s - 34) / 16) + 0.25 * Math.random();
        }
        for (let j = 0; j < SIDE.nz; j++) {
          const z = SIDE.z0 + SIDE.dz * (j + 0.5);
          for (const ii of [i, i + 1]) {
            if (ii >= SIDE.ns) continue;
            const k = side * SIDE.ns * SIDE.nz + j * SIDE.ns + ii;
            const now = z < reach ? 1 : z < reach + 0.6 ? 0.55 * (1 - (z - reach) / 0.6) : 0;
            this.side[k] = Math.max(now, this.side[k] * keep);
            this.sideBytes[k] = this.side[k] * 255;
          }
        }
      }
    }
    this.sideTex.needsUpdate = true;
  }
}

// The hull table of the rig (half-breadths, bytes), as a texture and a lookup.
function decodeHull(t) {
  const bin = atob(t.data);
  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  const tex = new THREE.DataTexture(data, t.ns, t.nz, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  const at = (s, z) => {
    const fi = (s - t.s0) / t.ds, fj = (z - t.z0) / t.dz;
    const i = Math.max(0, Math.min(t.ns - 2, Math.floor(fi))), j = Math.max(0, Math.min(t.nz - 2, Math.floor(fj)));
    const a = fi - i, b = fj - j;
    const v = (ii, jj) => data[jj * t.ns + ii] * t.unit;
    return (v(i, j) * (1 - a) + v(i + 1, j) * a) * (1 - b) + (v(i, j + 1) * (1 - a) + v(i + 1, j + 1) * a) * b;
  };
  return { tex, at };
}

const FRAG_PARS = /* glsl */`
varying vec3 vWetPos;
varying vec3 vWetN;
uniform mat4 uShipInv;
uniform mat4 uShipMat;
uniform sampler2D uRainOcc;
uniform vec4 uOcc;
uniform vec2 uOccH;
uniform sampler2D uSideWet;
uniform vec4 uSide;
uniform sampler2D uHullTex;
uniform vec4 uHullS;
uniform vec4 uHullZ;
uniform float uRainWet;
uniform float uRainPool;
uniform float uRainNow;
uniform float uBowWet;
uniform float uHeel;
uniform float uWetTime;
uniform float uPorosity;
float wetPool = 0.0;
float wetLevel = 0.0;
vec3 wetLocal = vec3(0.0);
float wetHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wetNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(wetHash(i), wetHash(i + vec2(1.0, 0.0)), u.x), mix(wetHash(i + vec2(0.0, 1.0)), wetHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float wetTop(vec2 xz) {
  vec2 uv = vec2((xz.x - uOcc.x) / uOcc.z, 1.0 - (xz.y - uOcc.y) / uOcc.w);
  if (uv.x <= 0.0 || uv.x >= 1.0 || uv.y <= 0.0 || uv.y >= 1.0) return -100.0;
  vec4 t = texture2D(uRainOcc, uv);
  float v = (t.r * 255.0 * 256.0 + t.g * 255.0) / 65535.0;
  return v <= 0.0 ? -100.0 : uOccH.x + v * (uOccH.y - uOccH.x);
}
// rings from raindrops on standing water: the slope of the surface (x, z)
vec2 wetRipples(vec2 p, float t) {
  vec2 g = vec2(0.0);
  for (int k = 0; k < 2; k++) {
    vec2 q = p * (k == 0 ? 1.0 : 1.7) + float(k) * 3.7;
    vec2 c = floor(q);
    for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
      vec2 cell = c + vec2(float(dx), float(dy));
      vec2 o = cell + vec2(wetHash(cell), wetHash(cell + 7.1));
      float ph = fract(t * 1.3 + wetHash(cell + 3.3));
      vec2 d = q - o;
      float r = length(d);
      float ring = sin((r - ph * 1.2) * 28.0) * smoothstep(0.0, 0.1, ph) * (1.0 - ph) * smoothstep(1.2 * ph + 0.1, 1.2 * ph - 0.05, r) * smoothstep(1.2 * ph - 0.3, 1.2 * ph, r);
      g += ring * d / max(r, 1e-3);
    }
  }
  return g * 0.35;
}
`;

const FRAG_SURFACE = /* glsl */`
{
  vec3 wl = (uShipInv * vec4(vWetPos, 1.0)).xyz;           // in her own frame
  vec3 wn = normalize(mat3(uShipInv) * normalize(vWetN));
  wetLocal = wl;
  float st = uHullS.w - wl.z;
  float up = wn.y;
  // open to the sky? (steep faces look a little out from themselves)
  vec2 off = abs(up) < 0.5 ? normalize(wn.xz + 1e-4) * 0.35 : vec2(0.0);
  float top = wetTop(wl.xz + off);
  float exposed = smoothstep(-0.35, -0.08, wl.y - top);
  float face = up > 0.0 ? 0.6 + 0.4 * up : 0.6 + 0.4 * up;      // rain strikes what faces up; runs down the rest
  float wet = uRainWet * exposed * clamp(face, 0.15, 1.0);
  // her outer side, wales, channels and lids: where the sea has been
  vec2 htc = vec2(((st - uHullS.x) / uHullS.y + 0.5) / uHullS.z, ((clamp(wl.y, uHullZ.x, 6.9) - uHullZ.x) / uHullZ.y + 0.5) / uHullZ.z);
  float hb = texture2D(uHullTex, htc).r * 255.0 * uHullZ.w;
  float outer = smoothstep(hb - 0.45, hb - 0.2, abs(wl.x)) * step(0.15, hb);
  float sx = wl.x >= 0.0 ? 0.0 : 0.5;
  vec2 stc = vec2((st - uSide.x) / uSide.y, sx + 0.5 * clamp((wl.y - uSide.z) / uSide.w, 0.0, 1.0));
  float sea = texture2D(uSideWet, stc).r * outer;
  wet = max(wet, sea);
  // green water and spray over the bow
  wet = max(wet, uBowWet * smoothstep(37.0, 44.0, st) * max(exposed, outer) * clamp(face + 0.3, 0.0, 1.0));
  // inside, under the waterline: damp; the floor of the hold: bilge water
  float inside = (1.0 - outer) * (1.0 - exposed);
  wet = max(wet, inside * 0.35 * smoothstep(0.4, -1.4, wl.y));
  float bilge = inside * step(wl.y, -2.95) * smoothstep(0.85, 0.97, up) * smoothstep(1.7, 0.5, abs(wl.x)) * (0.75 + 0.25 * wetNoise(wl.xz * 0.5));
  wet = max(wet, bilge);
  // standing water: in the seams first (the scan's crevices), then in pools
  // in the low places, the lee side (she heels) first
  #ifdef USE_ROUGHNESSMAP
  float crev = 1.0 - texture2D(roughnessMap, vRoughnessMapUv).r;
  #else
  float crev = 0.3;
  #endif
  float flat_ = smoothstep(0.88, 0.97, up);
  float lee = clamp(0.5 - sign(uHeel) * wl.x * 0.12 * min(1.0, abs(uHeel) * 8.0), 0.0, 1.0);
  float lowSpots = wetNoise(wl.xz * 0.45) * 0.6 + wetNoise(wl.xz * 1.7) * 0.4;
  // (a deck is cambered and drains by her scuppers: water stands only in
  // the seams and in the few hollows, never as a sheet)
  float level = max(uRainPool * exposed, bilge * 0.9) * flat_;
  float pool = smoothstep(0.04, 0.16, level * 0.85 - (1.0 - crev) * 0.6 - lowSpots * 0.62 + lee * 0.2 * level);
  pool *= flat_;
  wet = clamp(wet, 0.0, 1.0);
  wetPool = pool;
  wetLevel = wet;
  // porous things darken (light lost in the water-filled pores); metal does not
  float por = uPorosity * (1.0 - metalnessFactor);
  diffuseColor.rgb *= mix(1.0, mix(1.0, 0.32, por), wet);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * diffuseColor.rgb * 2.2, 0.25 * wet * por);   // and grow richer in colour
  diffuseColor.rgb *= mix(1.0, 0.7, pool);
  // a film of water is glossy; standing water a mirror
  roughnessFactor = mix(roughnessFactor, min(roughnessFactor, 0.26 + 0.14 * (1.0 - por)), wet * 0.85);
  roughnessFactor = mix(roughnessFactor, 0.035, pool);
}
`;

const FRAG_NORMAL = /* glsl */`
{
  // standing water drowns the grain: flat, but for the rings of the drops
  normal = normalize(mix(normal, wetGeoN, wetPool));
  if (uRainNow > 0.02 && wetPool > 0.02) {
    vec2 g = wetRipples(wetLocal.xz * 7.0, uWetTime) * min(1.0, uRainNow * 1.5) * 0.6;    // rings a hand across
    vec3 nl = normalize(vec3(-g.x, 1.0, -g.y));                       // in her frame
    vec3 nv = normalize((viewMatrix * uShipMat * vec4(nl, 0.0)).xyz);  // to the eye's
    normal = normalize(mix(normal, nv, wetPool));
  }
  // rain running down steep faces in streaks
  if (uRainWet > 0.05 && wetLevel > 0.05) {
    float streak = wetNoise(vec2(wetLocal.x * 9.0 + wetLocal.z * 9.0, wetLocal.y * 0.8 + uWetTime * 1.6));
    float steep = 1.0 - abs(normalize(vWetN).y);
    normal = normalize(normal + (streak - 0.5) * 0.08 * steep * uRainWet * vec3(0.0, 1.0, 0.0));
  }
}
`;
