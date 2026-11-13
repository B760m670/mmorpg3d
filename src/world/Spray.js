import * as THREE from 'three';

// Bow spray: when the bow plunges into a sea, a sheet of water bursts up and
// out to both sides, carries forward with the ship, is pushed by the wind
// and falls back. A light continuous spray runs off the bow wave at speed in
// a seaway. Particles live in a fixed pool, simulated on the CPU, drawn as
// soft points.

const VERT = /* glsl */ `
  attribute float aLife;
  attribute float aSize;
  uniform float uScale;
  varying float vLife;
  void main() {
    vLife = aLife;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aLife > 0.0 ? aSize * uScale / max(-mv.z, 0.5) : 0.0;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uColor;
  varying float vLife;
  void main() {
    if (vLife <= 0.0) discard;
    vec2 c = gl_PointCoord - 0.5;
    float r = length(c);
    float a = smoothstep(0.5, 0.15, r) * min(1.0, vLife * 2.5) * 0.55;
    gl_FragColor = vec4(uColor, a);
  }
`;

const _v = new THREE.Vector3();
const _l = new THREE.Vector3();

export class Spray {
  constructor({ count = 900 } = {}) {
    this.n = count;
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.size = new Float32Array(count);
    this.next = 0;
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.lifeAttr = new THREE.BufferAttribute(this.life, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('aLife', this.lifeAttr);
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.uniforms = { uColor: { value: new THREE.Color(0.9, 0.93, 0.95) }, uScale: { value: 600 } };
    this.mesh = new THREE.Points(geo, new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms,
      transparent: true, depthWrite: false, fog: false,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.windDir = new THREE.Vector3(0.3, 0, -1).normalize();
    this.carry = 0;
  }

  applyPreset(p) {
    const f = p.water.foam;
    this.uniforms.uColor.value.setRGB(f[0], f[1], f[2]);
  }

  resize(height) {
    this.uniforms.uScale.value = height * 0.9;
  }

  emit(n, boat, strength) {
    const g = boat.group;
    const fwd = _v.set(-Math.sin(boat.heading), 0, -Math.cos(boat.heading));
    const fx = fwd.x, fz = fwd.z;
    const rx = -fz, rz = fx;   // starboard
    // the bow, from the shoulders to the stem (the vessel's sprayAt)
    const b = boat.sprayAt || { from: 8, len: 3.5, half: 2.6, taper: 0.5, up: 0.8 };
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.n;
      const side = Math.random() < 0.5 ? -1 : 1;
      const along = b.from + Math.random() * b.len;
      const local = _l.set(side * Math.max(0.3, b.half - (along - b.from) * b.taper) * (0.8 + Math.random() * 0.4), b.up + Math.random(), -along);
      local.applyMatrix4(g.matrixWorld);
      this.pos[i * 3] = local.x; this.pos[i * 3 + 1] = local.y; this.pos[i * 3 + 2] = local.z;
      const out = (2 + Math.random() * 5) * strength;
      const up = (3 + Math.random() * 7) * strength;
      const ahead = boat.speed * (0.6 + Math.random() * 0.4);
      this.vel[i * 3] = fx * ahead + rx * side * out;
      this.vel[i * 3 + 1] = up;
      this.vel[i * 3 + 2] = fz * ahead + rz * side * out;
      this.life[i] = 1.2 + Math.random() * 1.4;
      this.size[i] = 0.35 + Math.random() * 0.7 * strength;
    }
  }

  update(dt, boat, wind) {
    if (boat.model) {
      if (boat.slam > 0) this.emit(Math.round(120 + 260 * boat.slam), boat, 0.6 + boat.slam);
      this.carry += boat.bowSpray * 40 * dt;
      const k = Math.floor(this.carry);
      if (k > 0) { this.emit(k, boat, 0.35 + boat.bowSpray * 0.4); this.carry -= k; }
    }
    const wx = this.windDir.x * wind, wz = this.windDir.z * wind;
    const drag = Math.exp(-dt * 0.9);
    let alive = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue;
      alive++;
      this.life[i] -= dt;
      const o = i * 3;
      this.vel[o] = wx + (this.vel[o] - wx) * drag;
      this.vel[o + 2] = wz + (this.vel[o + 2] - wz) * drag;
      this.vel[o + 1] -= 9.81 * dt;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
      if (this.pos[o + 1] < -1) this.life[i] = 0;
      this.size[i] *= 1 + dt * 0.6;                  // the sheet breaks into mist
    }
    this.mesh.visible = alive > 0;
    this.posAttr.needsUpdate = true;
    this.lifeAttr.needsUpdate = true;
    this.mesh.geometry.attributes.aSize.needsUpdate = true;
  }
}
