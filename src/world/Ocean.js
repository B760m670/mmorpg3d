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

  // Small capillary/wind waves for the normal only (no displacement):
  // six directional waves at golden-angle spacing with analytic gradients.
  // Smooth and animated, so no blocky artifacts.
  vec2 ripple(vec2 p, float t) {
    vec2 g = vec2(0.0);
    float ang = 0.37;
    float freq = 1.3;     // ~4.8 m down to ~0.4 m: wind waves at real scale
    float amp = 0.045;
    for (int i = 0; i < 9; i++) {
      vec2 d = vec2(cos(ang), sin(ang));
      float ph = dot(d, p) * freq + t * sqrt(9.81 * freq) * 0.8;
      g += d * (freq * amp * cos(ph));
      ang += 2.39996;
      freq *= 1.41;
      amp *= 0.78;
    }
    return g;
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
    float fade = exp(-vViewDist * 0.006);
    vec2 rg = ripple(vWorldPos.xz, uTime);
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
    float foam = smoothstep(2.3, 3.0, vHeight) * smoothstep(0.08, 0.2, length(rg));
    col = mix(col, uFoam, foam * 0.6);

    // Whitewater from the vessel, broken up by drifting noise.
    float fa = boatFoam(vWorldPos.xz);
    if (fa > 0.001) {
      vec2 flow = -uBoatFwd * uTime * 0.6;
      float n = vnoise(vWorldPos.xz * 1.3 + flow) * 0.6 + vnoise(vWorldPos.xz * 4.1 - flow * 1.7) * 0.4;
      float pattern = smoothstep(0.62, 0.92, n * 1.1 + fa * 0.4) * fa;
      col = mix(col, uShallow * 1.8 + uFoam * 0.05, fa * 0.25);  // aerated, lighter water
      col = mix(col, uFoam * 1.05, pattern);
    }

    // Distance fog — melt into the haze.
    float fog = 1.0 - exp(-uFogDensity * vViewDist);
    col = mix(col, uFogColor, clamp(fog, 0.0, 1.0));

    gl_FragColor = vec4(col, 1.0);
  }
`;

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
