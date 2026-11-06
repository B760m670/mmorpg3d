// Gerstner waves — the single source of truth for the ocean surface.
//
// The GLSL used by the water vertex shader is GENERATED from the same WAVES
// array that the JS buoyancy sampler reads, with all constants (direction,
// wavenumber k, angular speed w, WA term) pre-baked as numeric literals.
// That guarantees the boat floats on exactly the surface that is rendered,
// and keeps the shader free of GLSL-ES-version-specific array syntax.

import { WAVES } from '../config.js';

const G = 9.81;
const TAU = Math.PI * 2;

// Pre-compute per-wave constants once.
const BAKED = WAVES.map((w) => {
  const len = Math.hypot(w.dir[0], w.dir[1]) || 1;
  const dx = w.dir[0] / len;
  const dz = w.dir[1] / len;
  const k = TAU / w.wavelength;
  const omega = Math.sqrt(G * k) * w.speed;
  return {
    dx, dz, k, omega,
    A: w.amplitude,
    Q: w.steepness,
    WA: k * w.amplitude,
  };
});

const f = (n) => Number(n).toFixed(6);

// Emits a GLSL function:  void gerstner(vec2 p, float t, out vec3 disp, out vec3 nrm)
// disp = displacement from the flat position; nrm = surface normal.
export function gerstnerGLSL() {
  let body = '';
  for (const w of BAKED) {
    body += `
  {
    float ph = ${f(w.k)} * (${f(w.dx)} * p.x + ${f(w.dz)} * p.y) - ${f(w.omega)} * t;
    float c = cos(ph); float s = sin(ph);
    disp.x += ${f(w.Q * w.A * w.dx)} * c;
    disp.z += ${f(w.Q * w.A * w.dz)} * c;
    disp.y += ${f(w.A)} * s;
    nrm.x -= ${f(w.dx * w.WA)} * c;
    nrm.z -= ${f(w.dz * w.WA)} * c;
    nrm.y -= ${f(w.Q * w.WA)} * s;
  }`;
  }
  return `
void gerstner(vec2 p, float t, out vec3 disp, out vec3 nrm) {
  disp = vec3(0.0);
  nrm = vec3(0.0, 1.0, 0.0);
${body}
  nrm = normalize(nrm);
}`;
}

// JS mirror used for boat buoyancy. Returns the vertical displacement and
// surface normal at world (x, z) and time t.
const _n = { x: 0, y: 0, z: 0 };
export function sampleWater(x, z, t) {
  let dy = 0;
  let nx = 0, ny = 1, nz = 0;
  for (const w of BAKED) {
    const ph = w.k * (w.dx * x + w.dz * z) - w.omega * t;
    const c = Math.cos(ph);
    const s = Math.sin(ph);
    dy += w.A * s;
    nx -= w.dx * w.WA * c;
    nz -= w.dz * w.WA * c;
    ny -= w.Q * w.WA * s;
  }
  const inv = 1 / Math.hypot(nx, ny, nz);
  _n.x = nx * inv; _n.y = ny * inv; _n.z = nz * inv;
  return { height: dy, normal: _n };
}
