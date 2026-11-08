import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { terrainUniforms } from './Terrain.js';
import { WATER, WATER_TINT_GLSL } from './WaterOptics.js';

export { WATER };

// Light under water, for Norwegian coastal water in winter (clear: little
// plankton, about 20-25 m visibility).
//
// Water takes the colours out of daylight at different rates: red is gone
// in a few metres, green goes deepest, blue a little faster than green
// because of the dissolved organic matter of coastal water. Everything under
// the surface is lit by light that has come down through the water, and seen
// through water on its way to the eye:
//   - from above, the sea is see-through where it is shallow (Ocean.js), and
//     what is under it is tinted by its depth (waterTint below);
//   - below the surface, the view fades into the colour of the water around
//     you, which darkens with depth; the screen is graded by the light left
//     at your depth; the surface overhead shows the sky only inside Snell's
//     window (Ocean.js), outside it mirrors the water below.
// Also here: drifting particles (marine snow), the diver's exhaled bubbles,
// and the dive light.

// Add the water tint to a built-in material (instanced or not).
// With vertex: false the material's own shader writes vWaterY (world height).
export function addWaterTint(material, { vertex = true } = {}) {
  const U = terrainUniforms();
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, r) => {
    if (prev) prev(shader, r);
    shader.uniforms.uTide = U.uTide;
    shader.uniforms.uCamUnder = U.uCamUnder;
    shader.uniforms.uCamDepth = U.uCamDepth;
    if (vertex) shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vWaterY;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        {
          vec4 wp = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            wp = instanceMatrix * wp;
          #endif
          vWaterY = (modelMatrix * wp).y;
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTide;
        varying float vWaterY;
        ${WATER_TINT_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= waterTint(vWaterY);`);
  };
  // onBeforeCompile closures with different settings share their source
  // text: give each variant its own program
  const key = `${material.userData.key || ''}|${prev ? prev.toString().length : 0}|water${vertex ? 1 : 0}`;
  material.customProgramCacheKey = () => key;
  material.needsUpdate = true;
  return material;
}

// Screen grade under water: the light left at the camera's depth, a faint
// shimmer from the surface overhead, a dark rim; black-out when out of air.
const GRADE = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uTint: { value: new THREE.Vector3(1, 1, 1) },
    uShimmer: { value: 1 },
    uDark: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uShimmer, uDark;
    uniform vec3 uTint;
    varying vec2 vUv;
    void main() {
      vec2 w = vec2(sin(vUv.y * 38.0 + uTime * 1.9) + sin(vUv.y * 17.0 - uTime * 1.3),
                    cos(vUv.x * 31.0 + uTime * 1.6)) * 0.0011 * uShimmer;
      vec3 c = texture2D(tDiffuse, vUv + w).rgb * uTint;
      vec2 q = vUv - 0.5;
      c *= 1.0 - 0.35 * smoothstep(0.3, 0.8, dot(q, q) * 2.2);
      c *= 1.0 - uDark;
      gl_FragColor = vec4(c, 1.0);
    }`,
};

// Particles kept in a box around the camera (wrapped in the shader).
function particleBox(count, size, seed) {
  let s = seed;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const pos = new Float32Array(count * 3);
  const rand = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = rnd() * size; pos[i * 3 + 1] = rnd() * size; pos[i * 3 + 2] = rnd() * size;
    rand[i] = rnd();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aRand', new THREE.BufferAttribute(rand, 1));
  return g;
}

export class Underwater {
  constructor({ scene, engine, mobile = false }) {
    this.scene = scene;
    this.engine = engine;
    this.under = false;
    this.depth = 0;
    this.colour = new THREE.Color();
    this.tint = new THREE.Vector3(1, 1, 1);
    const U = terrainUniforms();
    this.U = U;

    // screen grade, after the scene render and before bloom / tone mapping
    this.grade = new ShaderPass(GRADE);
    this.grade.enabled = false;
    engine.composer.insertPass(this.grade, 1);

    // marine snow: flecks of organic matter, drifting, lit faintly
    const BOX = 26;
    this.snow = new THREE.Points(particleBox(mobile ? 900 : 1800, BOX, 0x51a7), new THREE.ShaderMaterial({
      uniforms: { uCam: { value: new THREE.Vector3() }, uTime: { value: 0 }, uCol: { value: new THREE.Color() }, uPx: { value: 1 } },
      vertexShader: /* glsl */ `
        uniform vec3 uCam; uniform float uTime, uPx;
        attribute float aRand;
        varying float vA;
        void main() {
          vec3 drift = vec3(sin(uTime * 0.07 + aRand * 40.0) * 0.6, -uTime * (0.015 + 0.02 * aRand), cos(uTime * 0.05 + aRand * 31.0) * 0.6);
          vec3 p = mod(position + drift - uCam + ${(BOX / 2).toFixed(1)}, ${BOX.toFixed(1)}) - ${(BOX / 2).toFixed(1)} + uCam;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float d = -mv.z;
          vA = smoothstep(${(BOX / 2).toFixed(1)}, 3.0, d) * smoothstep(0.2, 0.8, d);
          gl_PointSize = uPx * (1.2 + 2.2 * aRand) * 6.0 / max(d, 0.3);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uCol; varying float vA;
        void main() {
          vec2 q = gl_PointCoord - 0.5;
          float a = smoothstep(0.25, 0.0, dot(q, q)) * vA * 0.55;
          gl_FragColor = vec4(uCol, a);
        }`,
      transparent: true, depthWrite: false,
    }));
    this.snow.frustumCulled = false;
    this.snow.visible = false;
    this.snow.renderOrder = 2;
    scene.add(this.snow);

    // exhaled bubbles: each breath out sends a burst up past the face
    this.nBub = 160;
    const bg = new THREE.BufferGeometry();
    this.bubPos = new Float32Array(this.nBub * 3);
    this.bubLife = new Float32Array(this.nBub);
    this.bubSize = new Float32Array(this.nBub);
    bg.setAttribute('position', new THREE.BufferAttribute(this.bubPos, 3).setUsage(THREE.DynamicDrawUsage));
    bg.setAttribute('aLife', new THREE.BufferAttribute(this.bubLife, 1).setUsage(THREE.DynamicDrawUsage));
    bg.setAttribute('aSize', new THREE.BufferAttribute(this.bubSize, 1));
    this.bubbles = new THREE.Points(bg, new THREE.ShaderMaterial({
      uniforms: { uPx: { value: 1 }, uCol: { value: new THREE.Color() } },
      vertexShader: /* glsl */ `
        uniform float uPx;
        attribute float aLife, aSize;
        varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vA = aLife > 0.0 ? min(1.0, aLife * 3.0) : 0.0;
          gl_PointSize = aLife > 0.0 ? uPx * aSize * 900.0 / max(-mv.z, 0.05) : 0.0;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uCol; varying float vA;
        void main() {
          vec2 q = gl_PointCoord - 0.5;
          float r = length(q);
          if (r > 0.5) discard;
          // a bubble: bright rim, highlight, clear middle
          float rim = smoothstep(0.32, 0.47, r) * (1.0 - smoothstep(0.47, 0.5, r));
          float hl = smoothstep(0.12, 0.0, length(q - vec2(-0.15, 0.17)));
          gl_FragColor = vec4(uCol * (0.6 + 1.6 * hl), (rim * 0.8 + hl) * vA);
        }`,
      transparent: true, depthWrite: false,
    }));
    this.bubbles.frustumCulled = false;
    this.bubbles.renderOrder = 3;
    scene.add(this.bubbles);
    this.bubNext = 0;
    this._v = new THREE.Vector3();

    // the dive light: a hand torch, always in the scene (adding a light later
    // would recompile every material), switched by its intensity
    this.torch = new THREE.SpotLight(0xf4f8ff, 0, 32, 0.38, 0.45, 1.6);
    this.torch.castShadow = false;
    scene.add(this.torch);
    scene.add(this.torch.target);
    this.torchOn = false;

    this.resize(window.innerHeight);
    window.addEventListener('resize', () => this.resize(window.innerHeight));
  }

  resize(h) {
    const px = h / 800 * Math.min(window.devicePixelRatio, 2);
    this.snow.material.uniforms.uPx.value = px;
    this.bubbles.material.uniforms.uPx.value = px;
  }

  // A breath out at the regulator: a burst of bubbles below the face.
  exhale(camera) {
    const dir = camera.getWorldDirection(this._v);
    for (let k = 0; k < 26; k++) {
      const i = this.bubNext;
      this.bubNext = (this.bubNext + 1) % this.nBub;
      // the exhaust valve is below and in front of the mouth; bubbles go out
      // to the sides of the mask
      const side = (Math.random() < 0.5 ? -1 : 1) * (0.12 + Math.random() * 0.2);
      this.bubPos[i * 3] = camera.position.x + dir.x * 0.15 + dir.z * side;
      this.bubPos[i * 3 + 1] = camera.position.y - 0.18 - Math.random() * 0.1;
      this.bubPos[i * 3 + 2] = camera.position.z + dir.z * 0.15 - dir.x * side;
      this.bubLife[i] = 2.5 + Math.random() * 1.5;
      this.bubSize[i] = 0.004 + Math.random() * Math.random() * 0.02;
    }
  }

  // light: 0..1 daylight at the surface (sun and sky together)
  update(dt, time, camera, { under, depth, light, sunDir, torch }) {
    this.under = under;
    this.depth = depth;
    const U = this.U;
    U.uCamUnder.value = under ? 1 : 0;
    U.uCamDepth.value = depth;
    U.uWaterTime.value = time;

    const K = WATER.K;
    const d = under ? depth : 0;
    // the water around: daylight scattered by it (the depth grade below then
    // darkens it and takes the colours out, as for everything else)
    const L = 0.08 + 0.92 * light;
    this.colour.setRGB(WATER.colour[0] * L, WATER.colour[1] * L, WATER.colour[2] * L);
    // grade: the light that came down to the camera's depth (and a little
    // way on to what it sees); the eye adapts, so part of the cast is
    // balanced out, as divers see it rather than an unfiltered camera
    this.tint.set(Math.exp(-K[0] * (d + 1.5)), Math.exp(-K[1] * (d + 1.5)), Math.exp(-K[2] * (d + 1.5))).multiplyScalar(1 / Math.exp(-K[1] * 1.5));
    const lum = (this.tint.x + this.tint.y + this.tint.z) / 3;
    this.tint.lerp(this._v.set(lum, lum, lum), 0.3);
    this.grade.enabled = under;
    const g = this.grade.uniforms;
    g.uTime.value = time;
    g.uTint.value.copy(this.tint);
    g.uShimmer.value = Math.exp(-d / 10);

    this.snow.visible = under;
    if (under) {
      const su = this.snow.material.uniforms;
      su.uCam.value.copy(camera.position);
      su.uTime.value = time;
      su.uCol.value.copy(this.colour).multiplyScalar(1.6).addScalar(this.torchOn ? 0.25 : 0.02);
    }

    // bubbles rise (faster as they grow), wobble, burst at the surface
    let alive = false;
    for (let i = 0; i < this.nBub; i++) {
      if (this.bubLife[i] <= 0) continue;
      alive = true;
      this.bubLife[i] -= dt;
      const r = this.bubSize[i];
      this.bubPos[i * 3 + 1] += (0.35 + r * 40) * dt;
      this.bubPos[i * 3] += Math.sin(time * 9 + i) * 0.15 * dt;
      this.bubPos[i * 3 + 2] += Math.cos(time * 8 + i * 1.7) * 0.15 * dt;
      if (this.bubPos[i * 3 + 1] > U.uTide.value + 0.3) this.bubLife[i] = 0;
    }
    this.bubbles.visible = alive && under;
    if (alive) {
      this.bubbles.geometry.attributes.position.needsUpdate = true;
      this.bubbles.geometry.attributes.aLife.needsUpdate = true;
      this.bubbles.material.uniforms.uCol.value.copy(this.colour).multiplyScalar(2.5).addScalar(0.05);
    }

    // torch
    this.torchOn = !!torch;
    this.torch.intensity = torch ? 40 : 0;
    if (torch) {
      // (the same light is the ship's searchlight when nobody is diving)
      this.torch.angle = 0.38; this.torch.penumbra = 0.45; this.torch.distance = 32; this.torch.decay = 1.6;
      const dir = camera.getWorldDirection(this._v);
      this.torch.position.copy(camera.position).addScaledVector(dir, 0.3);
      this.torch.position.y -= 0.25;
      this.torch.target.position.copy(camera.position).addScaledVector(dir, 10);
    }
  }
}
