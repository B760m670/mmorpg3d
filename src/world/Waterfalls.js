import * as THREE from 'three';

// Waterfalls on the fjord walls, as in the Norwegian fjords: ribbons of
// falling water that hug the cliff face from the lip to the sea, with
// streaks racing down, a drifting cloud of mist where they hit the water,
// more flow in the rain. Places are found from the terrain: high, steep
// faces right at the water inside the fjords.

const FALL_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vW;
  void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const FALL_FRAG = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform float uFlow;
  uniform float uLen;
  uniform vec3  uColor;
  uniform vec3  uFogColor;
  uniform float uFogDensity;
  uniform vec3  uCam;
  varying vec2 vUv;
  varying vec3 vW;
  float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  void main() {
    float y = vUv.y * uLen;                         // metres from the lip
    float speed = 6.0 + sqrt(2.0 * 9.81 * max(y, 1.0)) * 0.6;
    vec2 q = vec2(vUv.x * 9.0, y / 6.0 - uTime * speed / 6.0);
    float n = noise(q) * 0.6 + noise(q * vec2(2.3, 2.1) + 7.0) * 0.4;
    float streak = smoothstep(0.32, 0.78, n);
    float edge = smoothstep(0.0, 0.3, vUv.x) * smoothstep(1.0, 0.7, vUv.x);
    float spread = 0.55 + 0.45 * vUv.y;              // fans out and thickens lower down
    float a = (0.5 + 0.5 * streak) * edge * mix(0.65, 1.0, uFlow) * spread;
    a *= smoothstep(0.0, 0.03, vUv.y);
    vec3 col = uColor * (0.95 + 0.35 * streak);
    float fog = 1.0 - exp(-uFogDensity * length(uCam - vW));
    col = mix(col, uFogColor, fog);
    gl_FragColor = vec4(col, a * (1.0 - fog * 0.6));
  }
`;

const MIST_VERT = /* glsl */ `
  attribute vec4 seed;
  uniform float uTime;
  uniform float uScale;
  varying float vA;
  void main() {
    float t = fract(uTime * (0.04 + 0.05 * seed.w) + seed.w);
    vec3 p = position + vec3((seed.x - 0.5) * 30.0 * (0.4 + t), t * 35.0, (seed.z - 0.5) * 30.0 * (0.4 + t));
    vA = sin(t * 3.14159) * 0.5;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = (14.0 + 26.0 * t) * uScale / max(-mv.z, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const MIST_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uFlow;
  varying float vA;
  void main() {
    float r = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, r) * smoothstep(0.5, 0.2, r) * vA * 0.16 * mix(0.6, 1.0, uFlow);
    gl_FragColor = vec4(uColor, a);
  }
`;

export class Waterfalls {
  constructor(terrain, { count = 6 } = {}) {
    this.terrain = terrain;
    this.group = new THREE.Group();
    this.spots = this.findSpots(count);
    this.uniforms = [];
    this.mistUniforms = {
      uTime: { value: 0 }, uScale: { value: 600 }, uColor: { value: new THREE.Color(0.9, 0.92, 0.95) }, uFlow: { value: 0.5 },
    };
    for (const s of this.spots) this.build(s);
  }

  // Shore points just off a high, steep face inside the fjords (sheltered
  // water), at least 900 m apart: where the streams off the plateau come
  // down to the sea.
  findSpots(count) {
    const T = this.terrain, g = T.grid;
    const maxX = g.minX + (g.nx - 1) * g.spacing, maxZ = g.minZ + (g.nz - 1) * g.spacing;
    const cands = [];
    for (let z = g.minZ + 300; z < maxZ - 300; z += 30) {
      for (let x = g.minX + 300; x < maxX - 300; x += 30) {
        const h = T.sample(x, z);
        if (h > -2 || h < -30 || T.exposure(x, z) > 0.25) continue;
        const gx = T.sample(x + 15, z) - T.sample(x - 15, z);
        const gz = T.sample(x, z + 15) - T.sample(x, z - 15);
        const l = Math.hypot(gx, gz);
        if (l < 1e-3) continue;
        const dx = gx / l, dz = gz / l;           // up the slope, toward the land
        let r = 0;
        while (r < 300 && T.sample(x + dx * r, z + dz * r) < 0.5) r += 4;
        if (r >= 300) continue;
        const h60 = T.sample(x + dx * (r + 60), z + dz * (r + 60));
        const h150 = T.sample(x + dx * (r + 150), z + dz * (r + 150));
        if (h60 > 70 && h150 > 170) cands.push({ x, z, dx, dz, score: h60 + h150, top: Math.min(h150, 280) });
      }
    }
    cands.sort((p, q) => q.score - p.score);
    const out = [];
    for (const c of cands) {
      if (out.length >= count) break;
      if (out.every((o) => Math.hypot(o.x - c.x, o.z - c.z) > 900)) out.push(c);
    }
    return out;
  }

  build(s) {
    const T = this.terrain;
    const N = 48;
    const pos = [], uv = [], idx = [], pts = [];
    const px = -s.dz, pz = s.dx;                 // across the fall
    let len = 0, prev = null;
    for (let k = 0; k <= N; k++) {
      const y = s.top - (s.top + 1.5) * (k / N);
      // where the face reaches this height, a little off the rock
      let t = 0;
      for (let i = 0; i < 600; i++) {
        if (T.sample(s.x + s.dx * t, s.z + s.dz * t) >= y) break;
        t += 0.75;
      }
      t -= 1.2 + 2.5 * (k / N);
      const w = 6 + 15 * Math.pow(k / N, 0.8);
      if (prev) len += Math.hypot(t - prev[0], y - prev[1]);
      prev = [t, y];
      pts.push([t, y, w, len]);
    }
    // two crossed curtains: one along the rock, one standing out from it,
    // so the fall has body from every side
    const at = (t) => [s.x + s.dx * t, s.z + s.dz * t];
    for (const [t, y, w, l] of pts) {
      const [x, z] = at(t);
      pos.push(x - px * w / 2, y, z - pz * w / 2, x + px * w / 2, y, z + pz * w / 2);
      uv.push(0, l / len, 1, l / len);
    }
    for (const [t, y, w, l] of pts) {
      const d = w * 0.45;
      const [xa, za] = at(t + d * 0.3), [xb, zb] = at(t - d);
      pos.push(xa, y, za, xb, y, zb);
      uv.push(0, l / len, 1, l / len);
    }
    for (let c = 0; c < 2; c++) {
      const o = c * (N + 1) * 2;
      for (let k = 0; k < N; k++) {
        const a = o + k * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    const u = {
      uTime: { value: 0 }, uFlow: { value: 0.5 }, uLen: { value: len },
      uColor: { value: new THREE.Color(0.9, 0.93, 0.95) }, uFogColor: { value: new THREE.Color() },
      uFogDensity: { value: 0.0008 }, uCam: { value: new THREE.Vector3() },
    };
    this.uniforms.push(u);
    const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      vertexShader: FALL_VERT, fragmentShader: FALL_FRAG, uniforms: u,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
    }));
    mesh.frustumCulled = false;
    this.group.add(mesh);
    const [bx, bz] = at(prev[0]);
    s.base = { x: bx, y: 1, z: bz };

    // mist where it lands
    const n = 70;
    const mpos = new Float32Array(n * 3), seed = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      mpos[i * 3] = bx - s.dx * 4; mpos[i * 3 + 1] = 0; mpos[i * 3 + 2] = bz - s.dz * 4;
      for (let j = 0; j < 4; j++) seed[i * 4 + j] = Math.random();
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(mpos, 3));
    mg.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
    const mist = new THREE.Points(mg, new THREE.ShaderMaterial({
      vertexShader: MIST_VERT, fragmentShader: MIST_FRAG, uniforms: this.mistUniforms,
      transparent: true, depthWrite: false, fog: false,
    }));
    mist.frustumCulled = false;
    this.group.add(mist);
  }

  applyPreset(p) {
    const f = p.water.foam, fog = p.fog;
    for (const u of this.uniforms) {
      u.uColor.value.setRGB(f[0], f[1], f[2]);
      u.uFogColor.value.setRGB(...fog.color);
      u.uFogDensity.value = fog.density;
    }
    this.mistUniforms.uColor.value.setRGB(f[0], f[1], f[2]);
  }

  resize(height) {
    this.mistUniforms.uScale.value = height * 0.9;
  }

  // rain swells the falls
  update(time, camera, rain) {
    const flow = Math.min(1, 0.45 + rain * 0.7);
    this.flow = flow;
    for (const u of this.uniforms) {
      u.uTime.value = time;
      u.uFlow.value = flow;
      u.uCam.value.copy(camera.position);
    }
    this.mistUniforms.uTime.value = time;
    this.mistUniforms.uFlow.value = flow;
  }
}
