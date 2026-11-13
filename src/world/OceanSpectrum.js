// Ocean wave spectrum (CPU side).
//
// The sea is a sum of tens of thousands of wave trains whose amplitudes are
// drawn from a measured ocean spectrum, the way film and AAA ocean renderers
// do it (Tessendorf, "Simulating Ocean Water"):
//   - JONSWAP frequency spectrum of a fetch-limited wind sea (Hasselmann et
//     al. 1973) plus a long swell from a distant storm, both from the
//     sea-state presets in config.js (wind speed, fetch, swell height/period);
//   - cos^2s directional spreading with Mitsuyasu's frequency-dependent s:
//     long waves follow the wind, short ones spread out;
//   - Gaussian random amplitudes and phases, so waves form groups and the
//     occasional big one, and no two look alike.
// The spectrum is split over three cascades (patch sizes) so wavelengths
// from a couple of kilometres down to 30 cm are covered without visible
// tiling. The GPU (OceanFFT.js) turns it into the surface every frame; this
// file also evaluates the biggest wave trains directly so the ship floats on
// the same water that is rendered.

const G = 9.81;
const TAU = Math.PI * 2;

// Patch sizes. Each cascade keeps only its own band of wavenumbers.
export function makeCascades(mobile) {
  const L = [mobile ? 1000 : 2000, 120, 19];
  const N = [mobile ? 128 : 256, 128, 128];
  const k1 = (TAU / L[1]) * 4;   // longer than ~30 m: cascade 0
  const k2 = (TAU / L[2]) * 4;   // 4.75 .. 30 m: cascade 1, shorter: cascade 2
  return [
    { L: L[0], N: N[0], kMin: 0, kMax: k1 },
    { L: L[1], N: N[1], kMin: k1, kMax: k2 },
    { L: L[2], N: N[2], kMin: k2, kMax: Infinity },
  ];
}

// Seeded Gaussian noise, one fixed set per cascade, so changing the sea state
// grows or calms the same waves instead of replacing them.
function gaussianNoise(n, seed) {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) + 0.5) / 4294967296;
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt(-2 * Math.log(rnd()));
    const a = TAU * rnd();
    out[i * 2] = r * Math.cos(a);
    out[i * 2 + 1] = r * Math.sin(a);
  }
  return out;
}

function lgamma(x) {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(TAU) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

// Normalisation of cos^2s(theta/2) over [-pi, pi].
const spreadNorm = (s) => Math.exp(lgamma(s + 1) - lgamma(s + 0.5)) / (2 * Math.sqrt(Math.PI));

function jonswapShape(w, wp, gamma) {
  if (w <= 0) return 0;
  const sigma = w <= wp ? 0.07 : 0.09;
  const r = Math.exp(-((w - wp) ** 2) / (2 * sigma * sigma * wp * wp));
  return Math.pow(w, -5) * Math.exp(-1.25 * Math.pow(wp / w, 4)) * Math.pow(gamma, r);
}

function shapeM0(wp, gamma) {
  let m = 0;
  const dw = 0.002;
  for (let w = dw; w < 40; w += dw) m += jonswapShape(w, wp, gamma) * dw;
  return m;
}

// The spectral components of a sea state: local wind sea + swell.
function components(state, dirs) {
  const U = state.wind, F = state.fetch;
  const alpha = 0.076 * Math.pow((G * F) / (U * U), -0.22);
  const wp = 22 * Math.pow((U * F) / (G * G), -0.33);
  const comps = [{ scale: alpha * G * G, wp, gamma: 3.3, dir: dirs.wind, extraSpread: 0 }];
  if (state.swell && state.swell.hs > 0) {
    const swp = TAU / state.swell.tp;
    const gamma = 6;
    comps.push({
      scale: (state.swell.hs / 4) ** 2 / shapeM0(swp, gamma),
      wp: swp, gamma, dir: dirs.swell, extraSpread: 24,
    });
  }
  return comps;
}

function directional(theta, w, c) {
  const x = w / c.wp;
  let s = x > 1 ? 9.77 * Math.pow(x, -2.5) : 6.97 * Math.pow(x, 5);
  s += c.extraSpread;
  s = Math.max(s, 0.5);
  let d = theta - c.dir;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return spreadNorm(s) * Math.pow(Math.abs(Math.cos(d * 0.5)), 2 * s);
}

// Spectral density in the wavenumber plane, Psi(k) = S(w) D(theta) dw/dk / k,
// so that the sum of Psi * dk^2 over the plane is the elevation variance m0.
function psi(kx, kz, comps) {
  const k = Math.hypot(kx, kz);
  if (k < 1e-6) return 0;
  const w = Math.sqrt(G * k);
  const dwdk = G / (2 * w);
  const theta = Math.atan2(kz, kx);
  let S = 0;
  for (const c of comps) S += c.scale * jonswapShape(w, c.wp, c.gamma) * directional(theta, w, c);
  const fade = Math.exp(-k * k * 0.0009);            // fade capillaries below ~30 cm
  return (S * dwdk * fade) / k;
}

export class OceanSpectrum {
  constructor(cascades, dirs) {
    this.cascades = cascades;
    this.dirs = dirs;
    this.noise = cascades.map((c, i) => gaussianNoise(c.N * c.N, 0x9e3779b1 + i * 7919));
  }

  // h0 for one cascade: RGBA = h0(k), conj(h0(-k)), texel (i, j) <-> wave
  // vector 2pi/L * (i, j) in wrap-around FFT order. Returns { data, m0 }.
  build(ci, state) {
    const c = this.cascades[ci];
    const { N, L } = c;
    const comps = components(state, this.dirs);
    const dk = TAU / L;
    const amp = new Float32Array(N * N);
    let m0 = 0;
    for (let j = 0; j < N; j++) {
      const nz = j < N / 2 ? j : j - N;
      for (let i = 0; i < N; i++) {
        const nx = i < N / 2 ? i : i - N;
        const kx = nx * dk, kz = nz * dk;
        const k = Math.hypot(kx, kz);
        if (k < c.kMin || k >= c.kMax || k === 0) continue;
        const p = psi(kx, kz, comps) * dk * dk;
        m0 += p;
        amp[j * N + i] = Math.sqrt(p / 4);          // E|xi|^2 = 2, Var = 4 sum amp^2
      }
    }
    const noise = this.noise[ci];
    const data = new Float32Array(N * N * 4);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = j * N + i;
        const b = ((N - j) % N) * N + ((N - i) % N);   // -k
        data[a * 4] = noise[a * 2] * amp[a];
        data[a * 4 + 1] = noise[a * 2 + 1] * amp[a];
        data[a * 4 + 2] = noise[b * 2] * amp[b];
        data[a * 4 + 3] = -noise[b * 2 + 1] * amp[b];
      }
    }
    return { data, m0 };
  }

  // Significant wave height of a state in the open sea, all cascades.
  static hs(results) {
    return 4 * Math.sqrt(results.reduce((s, r) => s + r.m0, 0));
  }
}

// Direct evaluation of the long waves (cascades 0 and 1) at a few points, for
// buoyancy. Uses the same h0 values as the GPU, so the ship rides the
// rendered sea. Only the most energetic wave trains are kept.
export class WaveSampler {
  constructor(cascades, maxModes = 1800) {
    this.cascades = cascades;
    this.maxModes = maxModes;
    this.count = 0;
    this.t = -1;
    this.mix = 0;
  }

  // a, b: arrays (per cascade) of h0 data for the two states being blended.
  setSpectra(a, b) {
    const cand = [];
    for (let ci = 0; ci < 2; ci++) {
      const { N, L } = this.cascades[ci];
      const dk = TAU / L;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const o = (j * N + i) * 4;
          const e = Math.max(
            Math.hypot(a[ci][o], a[ci][o + 1]) + Math.hypot(a[ci][o + 2], a[ci][o + 3]),
            Math.hypot(b[ci][o], b[ci][o + 1]) + Math.hypot(b[ci][o + 2], b[ci][o + 3]),
          );
          if (e < 1e-5) continue;
          const nx = i < N / 2 ? i : i - N;
          const nz = j < N / 2 ? j : j - N;
          cand.push({ e, ci, kx: nx * dk, kz: nz * dk, o });
        }
      }
    }
    cand.sort((p, q) => q.e - p.e);
    const m = Math.min(this.maxModes, cand.length);
    this.count = m;
    this.kx = new Float32Array(m); this.kz = new Float32Array(m);
    this.ux = new Float32Array(m); this.uz = new Float32Array(m);
    this.w = new Float32Array(m); this.ci = new Uint8Array(m);
    this.h0a = new Float32Array(m * 4); this.h0b = new Float32Array(m * 4);
    this.hr = new Float32Array(m); this.hi = new Float32Array(m);
    for (let n = 0; n < m; n++) {
      const c = cand[n];
      const k = Math.hypot(c.kx, c.kz);
      this.kx[n] = c.kx; this.kz[n] = c.kz;
      this.ux[n] = c.kx / k; this.uz[n] = c.kz / k;
      this.w[n] = Math.sqrt(G * k);
      this.ci[n] = c.ci;
      for (let q = 0; q < 4; q++) {
        this.h0a[n * 4 + q] = a[c.ci][c.o + q];
        this.h0b[n * 4 + q] = b[c.ci][c.o + q];
      }
    }
    this.t = -1;
  }

  setTime(t, mix) {
    if (t === this.t && mix === this.mix) return;
    this.t = t;
    this.mix = mix;
    const { h0a, h0b } = this;
    for (let n = 0; n < this.count; n++) {
      const c = Math.cos(this.w[n] * t), s = Math.sin(this.w[n] * t);
      const o = n * 4;
      const ar = h0a[o] + (h0b[o] - h0a[o]) * mix, ai = h0a[o + 1] + (h0b[o + 1] - h0a[o + 1]) * mix;
      const br = h0a[o + 2] + (h0b[o + 2] - h0a[o + 2]) * mix, bi = h0a[o + 3] + (h0b[o + 3] - h0a[o + 3]) * mix;
      // h = h0 e^{iwt} + conj(h0(-k)) e^{-iwt}
      this.hr[n] = ar * c - ai * s + br * c + bi * s;
      this.hi[n] = ar * s + ai * c - br * s + bi * c;
    }
  }

  // Sum the waves at (x, z) with per-cascade amplitude a0, a1.
  // out: [dx, dy, dz, slopeX, slopeZ]
  eval(x, z, a0, a1, out) {
    let dx = 0, dy = 0, dz = 0, sx = 0, sz = 0;
    let dx1 = 0, dy1 = 0, dz1 = 0, sx1 = 0, sz1 = 0;
    const { kx, kz, ux, uz, hr, hi, ci } = this;
    for (let n = 0; n < this.count; n++) {
      const th = kx[n] * x + kz[n] * z;
      const c = Math.cos(th), s = Math.sin(th);
      const A = hr[n] * c - hi[n] * s;   // Re(h e^{i theta})
      const B = hr[n] * s + hi[n] * c;   // Im(h e^{i theta})
      if (ci[n] === 0) {
        dy += A; dx += ux[n] * B; dz += uz[n] * B; sx -= kx[n] * B; sz -= kz[n] * B;
      } else {
        dy1 += A; dx1 += ux[n] * B; dz1 += uz[n] * B; sx1 -= kx[n] * B; sz1 -= kz[n] * B;
      }
    }
    out[0] = dx * a0 + dx1 * a1;
    out[1] = dy * a0 + dy1 * a1;
    out[2] = dz * a0 + dz1 * a1;
    out[3] = sx * a0 + sx1 * a1;
    out[4] = sz * a0 + sz1 * a1;
    return out;
  }
}
