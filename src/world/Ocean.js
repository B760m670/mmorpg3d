import * as THREE from 'three';
import { SEA } from '../config.js';
import { makeCascades, OceanSpectrum, WaveSampler } from './OceanSpectrum.js';
import { OceanFFT } from './OceanFFT.js';
import { TERRAIN_GLSL, terrainUniforms } from './Terrain.js';

// The ocean surface.
//
// Waves: a spectral (FFT) sea, see OceanSpectrum.js / OceanFFT.js: three
// cascades of wave trains from kilometre-long swell to 30 cm wavelets,
// statistically like a real sea of the chosen Beaufort force. On top of that
// the sea is deliberately NOT uniform, as a real one is not:
//   - shelter: inside the fjord the long waves die down and only a short
//     local chop remains; near the cliffs the swell is damped;
//   - cat's paws: drifting patches of gusty wind roughen the small waves in
//     some places and leave others glassy;
//   - whitecaps where crests fold over, foam that drifts and fades, surf at
//     the foot of the cliffs, the ship's bow wave and wake.
// Geometry: a polar grid centred under the camera, dense close in (about
// 1 m) and coarse towards the horizon, re-centred every frame.

const VERT = /* glsl */ `
  precision highp float;

  uniform vec3  uCameraPos;
  uniform sampler2D uDisp0;
  uniform sampler2D uDisp1;
  uniform sampler2D uDisp2;
  uniform vec3  uL;
  uniform vec3  uN;
  ${TERRAIN_GLSL}

  varying vec3  vWorldPos;
  varying vec2  vFlat;
  varying float vHeight;
  varying float vViewDist;
  varying vec3  vAmp;
  varying float vShore;


  void main() {
    vec3 world = (modelMatrix * vec4(position, 1.0)).xyz;
    vec2 p = world.xz;
    float dist = length(uCameraPos.xz - p);

    // Shelter: long waves die out behind the islands and up the fjords (how
    // open each point is to the sea, worked out from the real coastline); the
    // swell is damped in the last ten metres of depth before the rock.
    vec2 te = terrainHE(p);
    float th = te.x;
    float expo = te.y;
    float deep = smoothstep(-0.5, -12.0, th);
    vec3 amp = vec3(mix(0.1, 1.0, expo) * mix(0.25, 1.0, deep), mix(0.45, 1.0, expo) * mix(0.5, 1.0, deep), 1.0);

    vec3 d = textureLod(uDisp0, p / uL.x + 0.5 / uN.x, 0.0).xyz * amp.x;
    d += textureLod(uDisp1, p / uL.y + 0.5 / uN.y, 0.0).xyz * amp.y * (1.0 - smoothstep(250.0, 700.0, dist));
    d += textureLod(uDisp2, p / uL.z + 0.5 / uN.z, 0.0).xyz * (1.0 - smoothstep(25.0, 70.0, dist));

    vec3 pos = vec3(p.x + d.x, d.y, p.y + d.z);
    vWorldPos = pos;
    vFlat = p;
    vHeight = d.y;
    vViewDist = length(uCameraPos - pos);
    vAmp = amp;
    vShore = th;
    gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision highp float;

  uniform float uTime;
  uniform vec3  uCameraPos;
  uniform vec3  uSunDir;
  uniform vec3  uSunColor;

  uniform vec3  uDeep;
  uniform vec3  uShallow;
  uniform vec3  uHorizon;
  uniform vec3  uZenith;
  uniform vec3  uFoam;
  uniform float uSpecPower;
  uniform float uSpecStrength;

  uniform vec3  uFogColor;
  uniform float uFogDensity;

  uniform sampler2D uDisp0;
  uniform sampler2D uDisp1;
  uniform sampler2D uDisp2;
  uniform sampler2D uDeriv0;
  uniform sampler2D uDeriv1;
  uniform sampler2D uDeriv2;
  uniform vec3  uL;
  uniform vec3  uN;
  uniform float uLambda;
  uniform vec2  uWindDir;
  uniform float uGustiness;
  uniform float uSeaRough;      // 0 calm .. 1 storm
  uniform float uFoamBias;      // Jacobian below which crests break
  uniform float uRain;          // 0..1, rings from raindrops
  uniform float uHullMask;      // 1 while the camera is below decks

  // The player's vessel, for hull foam, bow wave and wake.
  uniform vec2  uBoatPos;
  uniform vec2  uBoatFwd;
  uniform float uBoatSpeed;
  uniform vec2  uBoatHalf;   // half length, half beam (m)

  uniform sampler2D uRipple;  // small tileable detail for foam texture

  varying vec3  vWorldPos;
  varying vec2  vFlat;
  varying float vHeight;
  varying float vViewDist;
  varying vec3  vAmp;
  varying float vShore;

  const mat2 ROT1 = mat2(0.8, -0.6, 0.6, 0.8);

  float hash21(vec2 p) {
    p = fract(p * vec2(234.34, 435.345));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
               mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  vec2 slope(vec4 d, float a) {
    return d.xy * a / max(vec2(0.25), 1.0 + uLambda * a * d.zw);
  }

  // Whitewater around the hull: contact foam, bow wave, turbulent centre
  // wake and the two Kelvin arms (19.5 deg) trailing astern.
  float boatFoam(vec2 w) {
    vec2 rel = w - uBoatPos;
    vec2 fwd = uBoatFwd;
    vec2 rgt = vec2(-fwd.y, fwd.x);
    float a = dot(rel, fwd);
    float c = dot(rel, rgt);
    float hl = uBoatHalf.x;
    float hb = uBoatHalf.y;
    float spd = clamp(abs(uBoatSpeed) / 6.0, 0.0, 1.0);
    float e = length(vec2(a / hl, c / hb));
    float contact = smoothstep(1.32, 1.0, e) * (0.18 + 0.82 * spd);
    float bow = smoothstep(0.35, 1.0, a / hl) * smoothstep(1.7, 1.0, e) * spd * 1.2;
    float wake = 0.0;
    float behind = -a - hl * 0.92;
    if (behind > 0.0) {
      float w2 = abs(c);
      float centre = smoothstep(hb * 0.75 + behind * 0.04, hb * 0.1, w2) * exp(-behind / 120.0) * 0.75;
      float arm = hb * 0.7 + behind * 0.354;
      float kelvin = exp(-pow((w2 - arm) / (0.9 + behind * 0.025), 2.0)) * exp(-behind / 110.0) * 0.8;
      wake = (centre + kelvin) * spd;
    }
    return clamp(contact + bow + wake, 0.0, 1.0);
  }

  vec3 skyColor(vec3 dir) {
    float t = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 col = mix(uHorizon, uZenith, pow(t, 0.7));
    float sun = pow(max(dot(dir, uSunDir), 0.0), 48.0);
    col += uSunColor * sun * 1.4;
    return col;
  }

  void main() {
    // Below decks the sea must not show inside the hull.
    if (uHullMask > 0.5) {
      vec2 rel = vWorldPos.xz - uBoatPos;
      float a = dot(rel, uBoatFwd);
      float c = dot(rel, vec2(-uBoatFwd.y, uBoatFwd.x));
      float t = clamp((a - 0.15 * uBoatHalf.x) / (0.85 * uBoatHalf.x), 0.0, 1.0);
      float w = uBoatHalf.y * 1.02 * sqrt(max(0.0, 1.0 - t * t));
      if (a > -uBoatHalf.x * 1.03 && a < uBoatHalf.x * 1.02 && abs(c) < w) discard;
    }
    vec2 p = vFlat;
    vec2 uv0 = p / uL.x + 0.5 / uN.x;
    vec2 uv1 = p / uL.y + 0.5 / uN.y;
    vec2 uv2 = p / uL.z + 0.5 / uN.z;

    // Cat's paws: gusts drift downwind and roughen the small waves.
    vec2 drift = uWindDir * uTime * 3.5;
    float g = vnoise((p - drift) / 260.0) * 0.6 + vnoise(ROT1 * (p - drift * 1.3) / 85.0) * 0.4;
    float gust = smoothstep(0.32, 0.72, g);
    float small = mix(1.0 - uGustiness, 1.0 + uGustiness * 0.45, gust);

    vec3 amp = vAmp;
    amp.y *= mix(0.85, 1.12, gust);
    amp.z = small;
    vec4 D0 = texture(uDeriv0, uv0);
    vec4 D1 = texture(uDeriv1, uv1);
    vec4 D2 = texture(uDeriv2, uv2);
    vec2 s = slope(D0, amp.x) + slope(D1, amp.y) + slope(D2, amp.z);

    // Raindrops: expanding rings in two staggered grids, close to the eye.
    if (uRain > 0.01 && vViewDist < 70.0) {
      float near = uRain * smoothstep(70.0, 15.0, vViewDist);
      for (int k = 0; k < 2; k++) {
        vec2 rp = p * 1.7 + float(k) * vec2(0.5, 0.37);
        vec2 cell = floor(rp);
        vec2 f = fract(rp) - 0.5;
        float h = hash21(cell + float(k) * 17.0);
        float ph = fract(uTime * (1.1 + h * 0.6) + h * 7.0);
        vec2 c = (vec2(hash21(cell + 3.1), hash21(cell + 7.7)) - 0.5) * 0.5;
        vec2 dv = f - c;
        float dd = length(dv);
        float ring = sin((dd - ph * 0.42) * 70.0) * exp(-pow((dd - ph * 0.42) * 14.0, 2.0)) * (1.0 - ph);
        s += dv / max(dd, 1e-3) * ring * 0.5 * near;
      }
    }
    vec3 N = normalize(vec3(-s.x, 1.0, -s.y));
    vec3 V = normalize(uCameraPos - vWorldPos);

    // Fresnel (Schlick).
    float NdV = max(dot(N, V), 0.0);
    float fres = mix(0.02, 1.0, pow(1.0 - NdV, 5.0));

    // Sky reflection.
    vec3 R = reflect(-V, N);
    R.y = abs(R.y);
    vec3 refl = skyColor(R);

    // Water body: deep colour, light scattered through the crests that face
    // away from the sun, a little more in the troughs looking down.
    float crest = clamp(vHeight * 0.35 + 0.35, 0.0, 1.0);
    vec3 body = mix(uDeep, uShallow, crest * 0.45);
    float back = pow(max(dot(V, -uSunDir) * 0.5 + 0.5, 0.0), 4.0);
    float thin = clamp(vHeight * 0.25, 0.0, 1.0) * pow(0.5 - 0.5 * dot(uSunDir, N), 2.0);
    body += uShallow * uSunColor * (back * thin * 0.9 + pow(NdV, 2.0) * 0.06);

    vec3 col = mix(body, refl, fres);

    // Sun / moon glitter; the far sea is rougher than the pixels can show,
    // so the highlight widens with distance instead of flickering.
    float far = smoothstep(60.0, 1800.0, vViewDist);
    float power = uSpecPower * mix(1.0, 0.12, far);
    vec3 H = normalize(V + uSunDir);
    float spec = pow(max(dot(N, H), 0.0), power) * mix(1.0, 0.35, far);
    col += uSunColor * spec * uSpecStrength;

    // Whitecaps where the whole surface folds over (Jacobian of the summed
    // horizontal displacement), plus the foam they left behind, textured.
    vec2 q = p + uWindDir * uTime * 0.4;
    float detail = texture(uRipple, q / 9.0).z * 0.55 + texture(uRipple, ROT1 * q / 3.1).z * 0.45;
    float jxx = uLambda * (D0.z * amp.x + D1.z * amp.y + D2.z * amp.z);
    float jzz = uLambda * (D0.w * amp.x + D1.w * amp.y + D2.w * amp.z);
    float jac = (1.0 + jxx) * (1.0 + jzz);
    float breaking = smoothstep(uFoamBias, uFoamBias - 0.4, jac);
    float trail = texture(uDisp0, uv0).w * amp.x + texture(uDisp1, uv1).w * amp.y + texture(uDisp2, uv2).w * 0.5;
    float whitecap = smoothstep(0.3, 0.9, (breaking * 1.2 + trail * 0.8) * (0.35 + detail * 1.0)) * (0.6 + 0.4 * gust);
    // Gale: foam blown in streaks along the wind.
    vec2 wf = vec2(dot(p, uWindDir), dot(p, vec2(-uWindDir.y, uWindDir.x)));
    float streak = texture(uRipple, (wf - vec2(uTime * 2.0, 0.0)) / vec2(70.0, 7.0)).z;
    streak = smoothstep(0.66, 0.9, streak * (0.7 + 0.5 * detail)) * smoothstep(0.55, 1.0, uSeaRough) * 0.4;
    whitecap = max(whitecap, streak * (1.0 - far));

    // Surf at the foot of the cliffs.
    float surge = 0.6 + 0.4 * sin(uTime * 0.9 + p.x * 0.05 + p.y * 0.07);
    float shore = smoothstep(-6.0 - 4.0 * uSeaRough, -0.3, vShore) * surge;
    shore *= smoothstep(0.25, 0.65, detail + shore * 0.3);

    float foam = max(whitecap, shore * (0.55 + 0.45 * uSeaRough));
    col = mix(col, uFoam * (0.85 + 0.15 * max(dot(N, uSunDir), 0.0)), clamp(foam, 0.0, 1.0) * 0.92);

    // Whitewater from the vessel, broken up by drifting texture.
    float fa = boatFoam(p);
    if (fa > 0.001) {
      vec2 flow = -uBoatFwd * uTime * 0.6;
      float n = texture(uRipple, (p + flow) / 11.0).z * 0.6
              + texture(uRipple, ROT1 * (p - flow * 1.7) / 3.7).z * 0.4
              + vnoise(p * 0.35 + flow * 0.2) * 0.25 - 0.12;
      float pattern = smoothstep(0.56, 0.86, n + fa * 0.3) * fa;
      col = mix(col, uShallow * 1.8 + uFoam * 0.05, fa * 0.25);  // aerated, lighter water
      col = mix(col, uFoam * 1.05, pattern);
    }

    // Distance fog — melt into the haze.
    float fog = 1.0 - exp(-uFogDensity * vViewDist);
    col = mix(col, uFogColor, clamp(fog, 0.0, 1.0));

    gl_FragColor = vec4(col, 1.0);
  }
`;

// Tileable detail map used to texture foam: a sum of periodic wave trains,
// B channel = height in 0..1.
function makeRippleTexture(size = 256) {
  let seed = 0x2f6b9d1;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const n = size * size;
  const hh = new Float32Array(n);
  const TAU = Math.PI * 2;
  for (let c = 0; c < 140; c++) {
    const m = 3 + Math.pow(rnd(), 1.7) * 44;
    const ang = rnd() * TAU;
    const kx = Math.round(Math.cos(ang) * m);
    const kz = Math.round(Math.sin(ang) * m);
    const k = Math.hypot(kx, kz);
    if (k < 1) continue;
    const A = Math.pow(k, -1.8);
    const ph = rnd() * TAU;
    const dphi = (TAU * kx) / size, cd = Math.cos(dphi), sd = Math.sin(dphi);
    for (let y = 0; y < size; y++) {
      const p0 = (TAU * kz * y) / size + ph;
      let sn = Math.sin(p0), cs = Math.cos(p0);
      let i = y * size;
      for (let x = 0; x < size; x++, i++) {
        hh[i] += A * cs;
        const s2 = sn * cd + cs * sd;
        cs = cs * cd - sn * sd;
        sn = s2;
      }
    }
  }
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { lo = Math.min(lo, hh[i]); hi = Math.max(hi, hh[i]); }
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.round((255 * (hh[i] - lo)) / (hi - lo));
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

// Rings of vertices around the camera, spacing growing geometrically.
function polarGrid(segments, rings, rMin, rMax) {
  const q = Math.pow(rMax / rMin, 1 / (rings - 1));
  const pos = new Float32Array((1 + segments * rings) * 3);
  let v = 3;
  for (let r = 0; r < rings; r++) {
    const rad = rMin * Math.pow(q, r);
    for (let a = 0; a < segments; a++) {
      const ang = (a / segments) * Math.PI * 2;
      pos[v++] = Math.cos(ang) * rad;
      pos[v++] = 0;
      pos[v++] = Math.sin(ang) * rad;
    }
  }
  const idx = [];
  const at = (r, a) => 1 + r * segments + (a % segments);
  for (let a = 0; a < segments; a++) idx.push(0, at(0, a + 1), at(0, a));
  for (let r = 0; r < rings - 1; r++) {
    for (let a = 0; a < segments; a++) {
      idx.push(at(r, a), at(r, a + 1), at(r + 1, a));
      idx.push(at(r, a + 1), at(r + 1, a + 1), at(r + 1, a));
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  return geo;
}


export class Ocean {
  constructor({ renderer, terrain, mobile = false }) {
    this.terrain = terrain;
    this.cascades = makeCascades(mobile);
    const nd = (v) => { const l = Math.hypot(v[0], v[1]); return [v[0] / l, v[1] / l]; };
    this.windDir = nd(SEA.windDir);
    const swellDir = nd(SEA.swellDir);
    this.spectrum = new OceanSpectrum(this.cascades, {
      wind: Math.atan2(this.windDir[1], this.windDir[0]),
      swell: Math.atan2(swellDir[1], swellDir[0]),
    });
    this.fft = new OceanFFT(renderer, this.cascades);
    this.sampler = new WaveSampler(this.cascades, mobile ? 1000 : 1800);

    const C = this.cascades;
    this.uniforms = {
      uTime: { value: 0 },
      uCameraPos: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3(0, 0.1, -1) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uDeep: { value: new THREE.Color() },
      uShallow: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uZenith: { value: new THREE.Color() },
      uFoam: { value: new THREE.Color() },
      uSpecPower: { value: 220 },
      uSpecStrength: { value: 2.6 },
      uFogColor: { value: new THREE.Color() },
      uFogDensity: { value: 0.00085 },
      uDisp0: { value: null }, uDisp1: { value: null }, uDisp2: { value: null },
      uDeriv0: { value: null }, uDeriv1: { value: null }, uDeriv2: { value: null },
      uL: { value: new THREE.Vector3(C[0].L, C[1].L, C[2].L) },
      uN: { value: new THREE.Vector3(C[0].N, C[1].N, C[2].N) },
      uLambda: { value: 1 },
      uWindDir: { value: new THREE.Vector2(...this.windDir) },
      uGustiness: { value: 0.6 },
      uSeaRough: { value: 0.3 },
      uFoamBias: { value: 0.5 },
      uRain: { value: 0 },
      uHullMask: { value: 0 },
      ...terrainUniforms(),
      uBoatPos: { value: new THREE.Vector2(0, 0) },
      uBoatFwd: { value: new THREE.Vector2(0, -1) },
      uBoatSpeed: { value: 0 },
      uBoatHalf: { value: new THREE.Vector2(11.9, 4.6) },
      uRipple: { value: makeRippleTexture() },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      fog: false,
    });

    const geo = mobile ? polarGrid(180, 170, 0.5, 9000) : polarGrid(288, 240, 0.4, 9000);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;

    this.state = -1;
    this.cur = null;     // h0 arrays per cascade, shown
    this.target = null;  // h0 arrays being blended towards
    this.mix = 1;
    this.setState(SEA.initial, true);
  }

  // Sea state from config SEA.states; the sea builds up or calms over a few
  // seconds unless instant.
  setState(index, instant = false) {
    const n = SEA.states.length;
    index = ((index % n) + n) % n;
    const st = SEA.states[index];
    const built = this.cascades.map((c, i) => this.spectrum.build(i, st));
    const next = built.map((b) => b.data);
    this.hs = OceanSpectrum.hs(built);
    if (instant || !this.cur) {
      this.cur = next;
      this.target = next;
      this.mix = 1;
    } else {
      // freeze the blend in progress as the new starting point
      const m = this.mix;
      this.cur = this.cur.map((a, i) => {
        if (a === this.target[i]) return a;
        const out = new Float32Array(a.length);
        for (let k = 0; k < a.length; k++) out[k] = a[k] + (this.target[i][k] - a[k]) * m;
        return out;
      });
      this.target = next;
      this.mix = 0;
    }
    this.fromChop = this.state >= 0 ? this.toChop : st.chop;
    this.toChop = st.chop;
    this.fromFoam = this.state >= 0 ? this.toFoam : st.foamBias;
    this.toFoam = st.foamBias;
    this.fromRough = this.state >= 0 ? this.toRough : index / (n - 1);
    this.toRough = index / (n - 1);
    this.state = index;
    this.info = st;
    this.fft.setSpectra(this.cur, this.target);
    this.sampler.setSpectra(this.cur, this.target);
    this.applyMix();
  }

  nextState(dir = 1) {
    this.setState(this.state + dir);
  }

  applyMix() {
    const m = this.mix;
    const e = m * m * (3 - 2 * m);
    this.fft.mix = m;
    this.lambda = this.fromChop + (this.toChop - this.fromChop) * e;
    this.fft.lambda = this.lambda;
    const bias = this.fromFoam + (this.toFoam - this.fromFoam) * e;
    this.uniforms.uFoamBias.value = bias;
    // per-cascade memory of breaking: leaves foam behind the crests
    this.fft.foam.bias = bias - 0.08;
    this.fft.foam.gain = 3.0;
    this.fft.foam.decayPerSec = 0.35;
    const rough = this.fromRough + (this.toRough - this.fromRough) * e;
    this.uniforms.uSeaRough.value = rough;
    this.uniforms.uGustiness.value = 0.65 - 0.35 * rough;
    this.uniforms.uLambda.value = this.lambda;
  }

  applyPreset(p) {
    const u = this.uniforms;
    u.uSunColor.value.setRGB(...p.sun.color).multiplyScalar(p.water.sunScale ?? 1);
    u.uDeep.value.setRGB(...p.water.deep);
    u.uShallow.value.setRGB(...p.water.shallow);
    u.uHorizon.value.setRGB(...p.water.horizon);
    u.uZenith.value.setRGB(...p.water.zenith);
    u.uFoam.value.setRGB(...p.water.foam);
    u.uSpecPower.value = p.water.specPower;
    u.uSpecStrength.value = p.water.specStrength;
    u.uFogColor.value.setRGB(...p.fog.color);
    u.uFogDensity.value = p.fog.density;
  }

  // Advance the simulation and keep the water centred under the camera.
  update(time, dt, camera, sunDir) {
    if (this.mix < 1) {
      this.mix = Math.min(1, this.mix + dt / SEA.transition);
      this.applyMix();
    }
    this.fft.update(time, dt);
    const u = this.uniforms;
    u.uTime.value = time;
    u.uCameraPos.value.copy(camera.position);
    u.uSunDir.value.copy(sunDir);
    for (let i = 0; i < 3; i++) {
      u[`uDisp${i}`].value = this.fft.disp(i);
      u[`uDeriv${i}`].value = this.fft.deriv(i);
    }
    this.mesh.position.set(camera.position.x, 0, camera.position.z);
  }

  // Same shelter factors as the vertex shader.
  amps(x, z) {
    const sm = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
    const expo = this.terrain.exposure(x, z);
    const deep = sm(-0.5, -12, this.terrain.sample(x, z));
    return [(0.1 + 0.9 * expo) * (0.25 + 0.75 * deep), (0.45 + 0.55 * expo) * (0.5 + 0.5 * deep)];
  }

  // Water height and normal at world (x, z) at time t, for buoyancy.
  sampleWater(x, z, t) {
    const s = this.sampler;
    s.setTime(t, this.mix);
    const [a0, a1] = this.amps(x, z);
    const o = this._o || (this._o = new Float64Array(5));
    let px = x, pz = z;
    for (let i = 0; i < 2; i++) {
      s.eval(px, pz, a0, a1, o);
      px = x - o[0] * this.lambda;
      pz = z - o[2] * this.lambda;
    }
    s.eval(px, pz, a0, a1, o);
    const n = this._n || (this._n = { x: 0, y: 1, z: 0 });
    const inv = 1 / Math.hypot(o[3], 1, o[4]);
    n.x = -o[3] * inv; n.y = inv; n.z = -o[4] * inv;
    const r = this._r || (this._r = { height: 0, normal: n });
    r.height = o[1];
    return r;
  }
}

// Feed the vessel's state for hull foam and wake.
Ocean.prototype.setBoat = function setBoat(boat) {
  const u = this.uniforms;
  u.uBoatPos.value.set(boat.position.x, boat.position.z);
  u.uBoatFwd.value.set(-Math.sin(boat.heading), -Math.cos(boat.heading));
  u.uBoatSpeed.value = boat.speed;
};
