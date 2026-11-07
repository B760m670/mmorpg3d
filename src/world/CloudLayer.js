import * as THREE from 'three';

// A deck of clouds at ~1.5 km, ray-cast onto a plane in the fragment shader:
// broken fair-weather cumulus at low cover, a solid grey ceiling with darker
// rain-bearing patches when overcast. It drifts with the wind, catches the
// sun at its edges, fades into the haze at the horizon and lights up with
// lightning.

const VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;   // on the far plane
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform float uCover;
  uniform float uDark;
  uniform float uFlash;
  uniform vec2  uWind;
  uniform vec3  uSunDir;
  uniform vec3  uSunColor;
  uniform vec3  uLight;
  uniform vec3  uShadow;
  uniform vec3  uFogColor;
  uniform vec2  uCam;
  uniform float uAlt;
  uniform float uHaze;
  varying vec3 vDir;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
    for (int i = 0; i < 5; i++) { s += a * noise(p); p = r * p * 2.03 + 11.7; a *= 0.5; }
    return s;
  }

  void main() {
    vec3 d = normalize(vDir);
    if (d.y <= 0.0) discard;
    float t = uAlt / max(d.y, 0.02);
    vec2 p = uCam + d.xz * t + uWind * uTime;
    float big = fbm(p * 0.00032);
    float fine = fbm(p * 0.0013 + 5.3);
    float n = big * 0.68 + fine * 0.32;
    float th = 1.0 - uCover;
    float dens = smoothstep(th - 0.1, th + 0.16, n);
    dens = max(dens, smoothstep(0.85, 1.0, uCover));            // full overcast
    float thick = clamp((n - th) * 2.2 + uDark * 0.7, 0.0, 1.0);
    vec3 col = mix(uLight, uShadow, thick);
    col *= 0.85 + 0.3 * fine;                                     // texture in the deck
    float sun = pow(max(dot(d, uSunDir), 0.0), 8.0);
    col += uSunColor * sun * (1.0 - thick) * 0.7 * (1.0 - uDark);  // bright edges sunward
    col += vec3(0.75, 0.8, 1.0) * uFlash * (0.6 + 0.4 * fine);
    float haze = 1.0 - exp(-t * uHaze);
    col = mix(col, uFogColor, haze);
    float a = dens * smoothstep(0.0, 0.05, d.y);
    gl_FragColor = vec4(col, a);
  }
`;

export class CloudLayer {
  constructor() {
    this.uniforms = {
      uTime: { value: 0 },
      uCover: { value: 0.3 },
      uDark: { value: 0 },
      uFlash: { value: 0 },
      uWind: { value: new THREE.Vector2(3, -8) },
      uSunDir: { value: new THREE.Vector3(0, 0.3, -1) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uLight: { value: new THREE.Color(1, 1, 1) },
      uShadow: { value: new THREE.Color(0.5, 0.5, 0.5) },
      uFogColor: { value: new THREE.Color(0.7, 0.75, 0.8) },
      uCam: { value: new THREE.Vector2() },
      uAlt: { value: 1100 },
      uHaze: { value: 0.00005 },
    };
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1000, 32, 16),
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: this.uniforms,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        fog: false,
      }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    this.windDir = new THREE.Vector2(0.3, -1).normalize();
  }

  applyPreset(p, sunDir) {
    const u = this.uniforms;
    const c = p.clouds;
    u.uCover.value = c.cover;
    // the cloud base comes down and the air thickens as the weather worsens
    u.uAlt.value = 1100 - 700 * c.dark;
    u.uHaze.value = 0.00004 + p.fog.density * 0.6 * c.dark;
    u.uDark.value = c.dark;
    u.uLight.value.setRGB(...c.light);
    u.uShadow.value.setRGB(...c.shadow);
    u.uFogColor.value.setRGB(...p.fog.color);
    u.uSunColor.value.setRGB(...p.sun.color).multiplyScalar(Math.min(1, p.sun.intensity / 2.4));
    u.uSunDir.value.copy(sunDir);
    // clouds at altitude move a bit faster than the surface wind
    u.uWind.value.copy(this.windDir).multiplyScalar(c.wind * 1.6);
  }

  update(time, camera, flash) {
    const u = this.uniforms;
    u.uTime.value = time;
    u.uFlash.value = flash;
    u.uCam.value.set(camera.position.x, camera.position.z);
    this.mesh.position.copy(camera.position);
  }
}
