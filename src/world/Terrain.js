import * as THREE from 'three';
import { TERRAIN as T } from '../config.js';
import { fbm, ridged, smoothstep, mix } from './noise.js';

// Procedural fjord: open sea near the start, two headlands at the mouth, then
// a meandering channel between steep, craggy cliff walls with a high plateau
// and mountains behind. Heights come from one CPU function (heightAt) that is
// used both to build the mesh and for boat/camera collisions.

function channelCenter(z) {
  const u = z - T.mouthZ;
  return (
    T.meanderA * Math.sin(u * T.meanderF) +
    T.meanderB * (Math.sin(u * T.meanderG + 1.3) - Math.sin(1.3))
  );
}

function halfWidth(z) {
  return T.channelHalfWidth + T.channelWidthVar * fbm(z * 0.0015, 7.7, 2);
}

export function heightAt(x, z) {
  // 0 in the open sea, 1 inside the fjord
  const m = smoothstep(T.mouthZ, T.mouthZ - T.mouthRamp, z);
  if (m <= 0) return T.seabed;

  const d = Math.abs(x - channelCenter(z));
  const hw = halfWidth(z);
  const flare = (1 - m) * 260; // the mouth opens wider toward the sea
  const edge = fbm(x * 0.012, z * 0.012, 3) * 22;
  const w = smoothstep(hw + flare, hw + flare + T.wallWidth, d + edge);
  if (w <= 0) return T.seabed;

  const plateau = T.cliffHeight + fbm(x * 0.0025, z * 0.0025, 4) * T.plateauVar;
  const mountains =
    smoothstep(hw + 150, hw + 900, d) *
    T.mountainHeight *
    (0.6 + 0.4 * fbm(x * 0.0015 + 3, z * 0.0015, 3));
  const wallBand = w * (1 - w) * 4; // strongest mid-cliff
  const crag = ridged(x * 0.016, z * 0.016, 4) * T.cragHeight * (0.35 * w + wallBand);

  const land = T.seabed + (plateau + mountains - T.seabed) * w + crag;
  return mix(T.seabed, land, m);
}

// True where the boat can float (deep enough water).
export function isNavigable(x, z) {
  return heightAt(x, z) < -4;
}

const ROCK_GLSL = /* glsl */ `
  varying vec3 vWPos;
  uniform float uBumpScale;

  float h31(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float vnoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y),
      f.z);
  }
  float rockFbm(vec3 p) {
    float a = 0.0, amp = 0.5;
    for (int i = 0; i < 4; i++) { a += amp * vnoise(p); p *= 2.07; amp *= 0.5; }
    return a;
  }
  vec3 perturbRock(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDir) {
    vec3 vSigmaX = normalize(dFdx(surf_pos));
    vec3 vSigmaY = normalize(dFdy(surf_pos));
    vec3 R1 = cross(vSigmaY, surf_norm);
    vec3 R2 = cross(surf_norm, vSigmaX);
    float fDet = dot(vSigmaX, R1) * faceDir;
    vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
    return normalize(abs(fDet) * surf_norm - vGrad);
  }
`;

function buildMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.93,
    metalness: 0.0,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uBumpScale = { value: 5.0 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + ROCK_GLSL)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          float big = rockFbm(vWPos * 0.045);
          // horizontal strata bands + large-scale tone variation
          float strata = 0.88 + 0.12 * sin(vWPos.y * 0.42 + big * 6.0);
          diffuseColor.rgb *= (0.72 + 0.56 * big) * strata;
        }`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          float bh = rockFbm(vWPos * 0.11) + 0.45 * rockFbm(vWPos * 0.47);
          float bumpFade = exp(-length(vViewPosition) / 350.0);
          vec2 dH = clamp(vec2(dFdx(bh), dFdy(bh)) * uBumpScale * bumpFade, -0.6, 0.6);
          normal = perturbRock(-vViewPosition, normal, dH, faceDirection);
        }`,
      );
  };
  return mat;
}

export class Terrain {
  constructor({ spacing = T.spacing } = {}) {
    const nx = Math.floor((T.maxX - T.minX) / spacing) + 1;
    const nz = Math.floor((T.maxZ - T.minZ) / spacing) + 1;

    const positions = new Float32Array(nx * nz * 3);
    for (let iz = 0; iz < nz; iz++) {
      const z = T.minZ + iz * spacing;
      for (let ix = 0; ix < nx; ix++) {
        const x = T.minX + ix * spacing;
        const k = (iz * nx + ix) * 3;
        positions[k] = x;
        positions[k + 1] = heightAt(x, z);
        positions[k + 2] = z;
      }
    }

    const indices = new Uint32Array((nx - 1) * (nz - 1) * 6);
    let p = 0;
    for (let iz = 0; iz < nz - 1; iz++) {
      for (let ix = 0; ix < nx - 1; ix++) {
        const a = iz * nx + ix;
        const b = a + 1;
        const c = a + nx;
        const d = c + 1;
        indices[p++] = a; indices[p++] = c; indices[p++] = b;
        indices[p++] = b; indices[p++] = c; indices[p++] = d;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals();

    // Vertex colors from height + slope: wet dark rock at the waterline,
    // grey cliff stone, moss on flat ledges, snow on the highest flats.
    const normals = geo.attributes.normal.array;
    const colors = new Float32Array(nx * nz * 3);
    for (let i = 0; i < nx * nz; i++) {
      const x = positions[i * 3];
      const h = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      const slope = 1 - normals[i * 3 + 1];
      const n = fbm(x * 0.02, z * 0.02, 2) * 0.5 + 0.5;

      let r = 0.15 + 0.06 * n, g = 0.15 + 0.06 * n, b = 0.145 + 0.05 * n;

      const moss = smoothstep(0.32, 0.1, slope) * smoothstep(12, 45, h);
      r = mix(r, 0.085, moss); g = mix(g, 0.115, moss); b = mix(b, 0.06, moss);

      const snow = smoothstep(390, 470, h) * smoothstep(0.55, 0.25, slope);
      r = mix(r, 0.82, snow); g = mix(g, 0.85, snow); b = mix(b, 0.9, snow);

      const wet = smoothstep(6, -1, h);
      r = mix(r, 0.035, wet); g = mix(g, 0.04, wet); b = mix(b, 0.04, wet);

      colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    this.mesh = new THREE.Mesh(geo, buildMaterial());
    this.mesh.frustumCulled = false;
  }
}
