import * as THREE from 'three';

// Night sky: a dark gradient with faint airglow at the horizon, a twinkling
// star field (two layers of procedurally placed stars), the Milky Way as a
// soft band with its own denser stars, and the moon with maria and a halo.
// The moon sits where the night preset puts the "sun" (the light that makes
// the moon path on the sea). Clouds, drawn after it, cover all of it.

const VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform vec3  uMoonDir;
  uniform vec3  uZenith;
  uniform vec3  uHorizon;
  uniform float uClear;      // 1 clear sky .. 0 overcast
  varying vec3 vDir;

  vec3 hash3(vec3 p) {
    p = fract(p * vec3(443.897, 441.423, 437.195));
    p += dot(p, p.yxz + 19.19);
    return fract((p.xxy + p.yxx) * p.zyx);
  }
  float hash1(vec3 p) { return hash3(p).x; }
  float noise3(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n = mix(mix(mix(hash1(i), hash1(i + vec3(1,0,0)), f.x), mix(hash1(i + vec3(0,1,0)), hash1(i + vec3(1,1,0)), f.x), f.y),
                  mix(mix(hash1(i + vec3(0,0,1)), hash1(i + vec3(1,0,1)), f.x), mix(hash1(i + vec3(0,1,1)), hash1(i + vec3(1,1,1)), f.x), f.y), f.z);
    return n;
  }

  // Stars: points scattered in a 3D grid; the sky sphere cuts through it.
  float stars(vec3 d, float scale, float density, float size) {
    vec3 p = d * scale;
    vec3 c = floor(p);
    vec3 h = hash3(c);
    if (h.x > density) return 0.0;
    vec3 s = c + 0.2 + 0.6 * hash3(c + 7.0);
    float dist = length(p - s);
    float mag = pow(hash1(c + 3.0), 3.0) * 0.9 + 0.1;
    float tw = 0.7 + 0.3 * sin(uTime * (2.0 + 6.0 * h.y) + h.z * 40.0);
    return smoothstep(size, 0.0, dist) * mag * tw;
  }

  void main() {
    vec3 d = normalize(vDir);
    float up = max(d.y, 0.0);
    vec3 col = mix(uHorizon, uZenith, pow(up, 0.45));
    if (d.y < 0.0) { gl_FragColor = vec4(uHorizon, 1.0); return; }

    float ext = smoothstep(0.0, 0.25, d.y);             // thick air near the horizon
    // Milky Way: a soft band around a tilted great circle
    vec3 mwN = normalize(vec3(0.35, 0.55, 0.76));
    float band = exp(-pow(dot(d, mwN) / 0.16, 2.0));
    float dust = noise3(d * 9.0) * 0.6 + noise3(d * 23.0) * 0.4;
    vec3 milky = vec3(0.55, 0.6, 0.75) * band * (0.3 + 0.7 * dust) * 0.16;
    float st = stars(d, 260.0, 0.09 + band * 0.18, 0.11) * 1.6
             + stars(d, 110.0, 0.04, 0.08) * 5.0
             + stars(d, 520.0, 0.12 * band, 0.14) * 1.0;
    vec3 starCol = mix(vec3(0.8, 0.86, 1.0), vec3(1.0, 0.9, 0.75), hash1(floor(d * 110.0)));
    col += (milky + starCol * st * 3.0) * ext * uClear;

    // the moon: disc with maria and limb darkening, plus a halo
    float cm = dot(d, normalize(uMoonDir));
    float r = 0.0115;
    float ang = acos(clamp(cm, -1.0, 1.0));
    if (ang < r) {
      vec3 m = normalize(uMoonDir);
      vec3 t1 = normalize(cross(m, vec3(0.0, 1.0, 0.0)));
      vec3 t2 = cross(t1, m);
      vec2 q = vec2(dot(d - m, t1), dot(d - m, t2)) / r;
      float limb = sqrt(max(0.0, 1.0 - dot(q, q)));
      float maria = smoothstep(0.45, 0.7, noise3(vec3(q * 2.6, 1.0)) * 0.7 + noise3(vec3(q * 7.0, 4.0)) * 0.3);
      vec3 moon = vec3(1.0, 0.97, 0.9) * (0.75 + 0.25 * limb) * (1.0 - 0.35 * maria) * 6.0;
      col = mix(col, moon, smoothstep(r, r * 0.92, ang) * mix(0.25, 1.0, uClear));
    }
    col += vec3(0.6, 0.65, 0.8) * (pow(max(cm, 0.0), 900.0) * 0.8 + pow(max(cm, 0.0), 30.0) * 0.06) * mix(0.4, 1.0, uClear);
    gl_FragColor = vec4(col, 1.0);
  }
`;

export class NightSky {
  constructor() {
    this.uniforms = {
      uTime: { value: 0 },
      uMoonDir: { value: new THREE.Vector3(0, 0.2, -1) },
      uZenith: { value: new THREE.Color(0.004, 0.007, 0.018) },
      uHorizon: { value: new THREE.Color(0.03, 0.045, 0.07) },
      uClear: { value: 1 },
    };
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1000, 48, 24),
      new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms,
        side: THREE.BackSide, depthWrite: false, fog: false,
      }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -2;
    this.mesh.visible = false;
  }

  applyPreset(p, moonDir, cloudCover) {
    this.mesh.visible = p.showSkyDome === false;
    const u = this.uniforms;
    u.uMoonDir.value.copy(moonDir);
    u.uHorizon.value.setRGB(...p.fog.color);
    const f = p.fog.color;
    u.uZenith.value.setRGB(f[0] * 0.12, f[1] * 0.14, f[2] * 0.22);
    u.uClear.value = Math.max(0, 1 - cloudCover * 1.1);
  }

  update(time, camera) {
    this.uniforms.uTime.value = time;
    this.mesh.position.copy(camera.position);
  }
}
