import * as THREE from 'three';
import { OCEAN } from '../config.js';
import { gerstnerGLSL } from './waves.js';

// Procedural ocean: a large grid displaced by Gerstner waves in the vertex
// shader. The fragment shader fakes the expensive parts of water cheaply —
// a sky-gradient reflection with Fresnel, a sharp sun/moon specular glitter,
// depth-based color, foam on crests, and distance fog so the water melts into
// the haze on the horizon (the "filmic depth" look of the reference).
//
// The plane is re-centered on the camera every frame and the waves are
// evaluated in world space, so the ocean reads as effectively infinite.

const VERT = /* glsl */ `
  precision highp float;

  uniform float uTime;
  uniform vec3  uCameraPos;

  varying vec3  vWorldPos;
  varying vec3  vNormal;
  varying float vHeight;
  varying float vViewDist;

  ${gerstnerGLSL()}

  void main() {
    // Flat world position of this vertex (plane is moved under the camera).
    vec3 world = (modelMatrix * vec4(position, 1.0)).xyz;

    vec3 disp;
    vec3 nrm;
    gerstner(world.xz, uTime, disp, nrm);

    vec3 finalPos = vec3(world.x + disp.x, disp.y, world.z + disp.z);

    vWorldPos = finalPos;
    vNormal = nrm;
    vHeight = disp.y;
    vViewDist = length(uCameraPos - finalPos);

    gl_Position = projectionMatrix * viewMatrix * vec4(finalPos, 1.0);
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

  // The player's vessel, for hull foam, bow wave and wake.
  uniform vec2  uBoatPos;
  uniform vec2  uBoatFwd;
  uniform float uBoatSpeed;
  uniform vec2  uBoatHalf;   // half length, half beam (m)

  varying vec3  vWorldPos;
  varying vec3  vNormal;
  varying float vHeight;
  varying float vViewDist;

  // Wind ripples for the normal only (no displacement): a tileable slope
  // map with a random, directional spectrum (see makeRippleTexture), sampled
  // at three scales drifting in different directions. Mipmapped, so it
  // filters instead of aliasing into moire at a distance.
  uniform sampler2D uRipple;
  const mat2 ROT1 = mat2(0.8, -0.6, 0.6, 0.8);
  const mat2 ROT2 = mat2(-0.5, 0.866, -0.866, -0.5);
  vec3 ripple(vec2 p, float t, float dist) {
    vec4 a = texture2D(uRipple, p / 23.0 + vec2(0.031, 0.019) * t);
    vec4 b = texture2D(uRipple, ROT1 * p / 7.9 + vec2(-0.052, 0.071) * t);
    vec4 c = texture2D(uRipple, ROT2 * p / 2.6 + vec2(0.16, -0.12) * t);
    float near = exp(-dist * 0.03);
    vec2 g = (a.xy * 2.0 - 1.0) * 0.22 + (b.xy * 2.0 - 1.0) * 0.3 + (c.xy * 2.0 - 1.0) * 0.3 * near;
    float h = a.z * 0.45 + b.z * 0.35 + c.z * 0.2;
    return vec3(g, h);
  }

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
    vec3 N = normalize(vNormal);

    // Ripple detail, faded with distance to avoid shimmering.
    float fade = mix(0.35, 1.0, exp(-vViewDist * 0.004));
    vec3 rp = ripple(vWorldPos.xz, uTime, vViewDist);
    vec2 rg = rp.xy;
    N = normalize(N + vec3(-rg.x, 0.0, -rg.y) * fade);

    vec3 V = normalize(uCameraPos - vWorldPos);

    // Fresnel (Schlick).
    float fres = pow(clamp(1.0 - max(dot(N, V), 0.0), 0.0, 1.0), 5.0);
    fres = mix(0.02, 1.0, fres);

    // Sky reflection.
    vec3 R = reflect(-V, N);
    R.y = abs(R.y);
    vec3 refl = skyColor(R);

    // Base body color by depth / slope.
    float depthMix = clamp(vHeight * 0.14 + 0.5, 0.0, 1.0);
    vec3 body = mix(uDeep, uShallow, depthMix);

    vec3 col = mix(body, refl, fres);

    // Sun / moon specular glitter.
    vec3 H = normalize(V + uSunDir);
    float spec = pow(max(dot(N, H), 0.0), uSpecPower);
    col += uSunColor * spec * uSpecStrength;

    // Light shining through the thin tops of waves facing away from the sun.
    float sss = pow(max(dot(V, -uSunDir), 0.0), 6.0) * clamp(vHeight * 0.4, 0.0, 1.0);
    col += uShallow * uSunColor * sss * 0.25;

    // Foam on the sharpest crests.
    // Foam only on the highest crests, broken up by the ripple pattern.
    float foam = smoothstep(2.3, 3.0, vHeight) * smoothstep(0.55, 0.75, rp.z);
    col = mix(col, uFoam, foam * 0.6);

    // Whitewater from the vessel, broken up by drifting noise.
    float fa = boatFoam(vWorldPos.xz);
    if (fa > 0.001) {
      vec2 flow = -uBoatFwd * uTime * 0.6;
      vec2 q = vWorldPos.xz;
      float n = texture2D(uRipple, (q + flow) / 11.0).z * 0.6
              + texture2D(uRipple, ROT1 * (q - flow * 1.7) / 3.7).z * 0.4
              + vnoise(q * 0.35 + flow * 0.2) * 0.25 - 0.12;
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

// Tileable slope map of wind ripples: ~140 periodic wave trains with integer
// wave vectors (so the tile wraps seamlessly), random phases, a height
// spectrum falling as k^-1.8 and a directional spread around the wind.
// RG = slope (x, z) normalised to rms 1/3 around 0.5, B = height.
function makeRippleTexture(size = 256) {
  let seed = 0x2f6b9d1;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const n = size * size;
  const gx = new Float32Array(n), gz = new Float32Array(n), hh = new Float32Array(n);
  const TAU = Math.PI * 2;
  const wind = 0.55;
  for (let c = 0; c < 140; c++) {
    const m = 3 + Math.pow(rnd(), 1.7) * 44;          // cycles per tile
    const spread = rnd() < 0.25 ? (rnd() - 0.5) * TAU : (rnd() + rnd() + rnd() - 1.5) * 1.4;
    const kx = Math.round(Math.cos(wind + spread) * m);
    const kz = Math.round(Math.sin(wind + spread) * m);
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
        gx[i] -= A * kx * sn;
        gz[i] -= A * kz * sn;
        const s2 = sn * cd + cs * sd;
        cs = cs * cd - sn * sd;
        sn = s2;
      }
    }
  }
  let ss = 0, hmin = Infinity, hmax = -Infinity;
  for (let i = 0; i < n; i++) {
    ss += gx[i] * gx[i] + gz[i] * gz[i];
    if (hh[i] < hmin) hmin = hh[i];
    if (hh[i] > hmax) hmax = hh[i];
  }
  const scale = 1 / (3 * Math.sqrt(ss / (2 * n)));
  const data = new Uint8Array(n * 4);
  const enc = (v) => Math.max(0, Math.min(255, Math.round(127.5 + 127.5 * v)));
  for (let i = 0; i < n; i++) {
    data[i * 4] = enc(gx[i] * scale);
    data[i * 4 + 1] = enc(gz[i] * scale);
    data[i * 4 + 2] = Math.round((255 * (hh[i] - hmin)) / (hmax - hmin));
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

export class Ocean {
  constructor({ segments = OCEAN.segments } = {}) {
    const geo = new THREE.PlaneGeometry(OCEAN.size, OCEAN.size, segments, segments);
    geo.rotateX(-Math.PI / 2); // lay flat: local (x, 0, z)

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

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
  }

  applyPreset(p) {
    const u = this.uniforms;
    u.uSunColor.value.setRGB(...p.sun.color);
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

  // Keep the water centered under the camera and advance time.
  update(time, camera, sunDir) {
    this.uniforms.uTime.value = time;
    this.uniforms.uCameraPos.value.copy(camera.position);
    this.uniforms.uSunDir.value.copy(sunDir);
    this.mesh.position.set(camera.position.x, 0, camera.position.z);
  }
}

// Feed the vessel's state for hull foam and wake.
Ocean.prototype.setBoat = function setBoat(boat) {
  const u = this.uniforms;
  u.uBoatPos.value.set(boat.position.x, boat.position.z);
  u.uBoatFwd.value.set(-Math.sin(boat.heading), -Math.cos(boat.heading));
  u.uBoatSpeed.value = boat.speed;
};
