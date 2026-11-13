import * as THREE from 'three';

// Rain: thin streaks in a box that travels with the camera, falling at
// ~9 m/s and slanting with the wind. Each drop wraps around the box, so the
// rain is endless at a fixed cost. Drops inside the wheelhouse are culled, so
// it does not rain on the bridge.

const VERT = /* glsl */ `
  precision highp float;
  attribute vec4 seed;
  uniform vec3  uCam;
  uniform vec3  uOffset;
  uniform vec3  uVel;
  uniform vec3  uBox;
  uniform float uLen;
  uniform float uWidth;
  uniform float uAmount;
  uniform mat4  uShipInv;
  varying vec2  vUv;
  varying float vFade;

  void main() {
    vUv = uv;
    vFade = 0.0;
    if (seed.w > uAmount) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    vec3 p = seed.xyz * uBox + uOffset;
    p = mod(p - uCam, uBox) - uBox * 0.5 + uCam;
    vec3 ls = (uShipInv * vec4(p, 1.0)).xyz;     // wheelhouse, model space
    bool wheelhouse = abs(ls.x) < 3.5 && ls.y > 5.0 && ls.y < 8.3 && ls.z > -6.5 && ls.z < 0.2;
    bool belowDecks = abs(ls.x) < 4.7 && abs(ls.z) < 12.2 && ls.y < (ls.z < 0.0 ? 5.2 : 4.25);
    if (wheelhouse || belowDecks) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return;
    }
    vec3 dir = normalize(uVel);
    vec3 toCam = normalize(uCam - p);
    vec3 side = normalize(cross(dir, toCam));
    float dist = length(p - uCam);
    vec3 pos = p + side * position.x * uWidth * (1.0 + dist * 0.04) + dir * position.y * uLen;
    vFade = smoothstep(uBox.x * 0.5, uBox.x * 0.25, dist) * smoothstep(0.4, 1.5, dist);
    gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  uniform vec3  uColor;
  uniform float uAlpha;
  varying vec2  vUv;
  varying float vFade;
  void main() {
    float across = 1.0 - abs(vUv.x - 0.5) * 2.0;
    float along = smoothstep(0.0, 0.35, vUv.y) * smoothstep(1.0, 0.8, vUv.y);
    float a = uAlpha * vFade * across * along;
    if (a < 0.003) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

export class Rain {
  constructor({ count = 7000 } = {}) {
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('uv', base.getAttribute('uv'));
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    geo.setAttribute('seed', new THREE.InstancedBufferAttribute(seeds, 4));
    geo.instanceCount = count;

    this.uniforms = {
      uCam: { value: new THREE.Vector3() },
      uOffset: { value: new THREE.Vector3() },
      uVel: { value: new THREE.Vector3(0, -9, 0) },
      uBox: { value: new THREE.Vector3(36, 26, 36) },
      uLen: { value: 0.75 },
      uWidth: { value: 0.012 },
      uAmount: { value: 0 },
      uShipInv: { value: new THREE.Matrix4() },
      uColor: { value: new THREE.Color(0.75, 0.8, 0.85) },
      uAlpha: { value: 0.35 },
    };
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      fog: false,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.windDir = new THREE.Vector3(0.3, 0, -1).normalize();
  }

  applyPreset(p) {
    // drops are lit by the sky: light grey by day, faint at night
    const f = p.fog.color;
    this.uniforms.uColor.value.setRGB(f[0] * 1.25 + 0.08, f[1] * 1.25 + 0.08, f[2] * 1.25 + 0.1);
  }

  // amount 0..1, wind m/s
  update(dt, camera, amount, wind, ship) {
    const u = this.uniforms;
    u.uCam.value.copy(camera.position);
    u.uAmount.value = amount;
    u.uAlpha.value = 0.22 + 0.2 * amount;
    u.uVel.value.set(this.windDir.x * wind * 0.55, -9 - amount * 2, this.windDir.z * wind * 0.55);
    // integrate the fall so a change of wind bends the rain instead of
    // teleporting it; keep the offset small for precision
    const o = u.uOffset.value, b = u.uBox.value;
    o.addScaledVector(u.uVel.value, dt);
    o.set(((o.x % b.x) + b.x) % b.x, ((o.y % b.y) + b.y) % b.y, ((o.z % b.z) + b.z) % b.z);
    if (ship) u.uShipInv.value.copy(ship.matrixWorld).invert();
    this.mesh.visible = amount > 0.01;
  }
}
