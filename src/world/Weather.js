import { WEATHER } from '../config.js';

// Weather: one state machine that drives the sky, light, fog, sea state,
// clouds and rain together, so a front coming through changes all of them at
// once. Values blend over WEATHER.transition seconds. In "changing" mode the
// weather wanders on its own every few minutes.

const KEYS = ['clouds', 'dark', 'rain', 'fog', 'sun', 'wind', 'lightning'];
const mix = (a, b, t) => a + (b - a) * t;

export class Weather {
  constructor() {
    this.index = WEATHER.initial;
    this.auto = false;
    this.v = {};
    for (const k of KEYS) this.v[k] = WEATHER.states[this.index][k];
    this.from = { ...this.v };
    this.to = { ...this.v };
    this.t = 1;
    this.autoTimer = 0;
  }

  get state() {
    return WEATHER.states[this.index];
  }

  get changing() {
    return this.t < 1;
  }

  get label() {
    return `${this.state.name}${this.auto ? ' · changing' : ''}`;
  }

  set(index) {
    const n = WEATHER.states.length;
    this.index = ((index % n) + n) % n;
    this.from = { ...this.v };
    this.to = {};
    for (const k of KEYS) this.to[k] = WEATHER.states[this.index][k];
    this.t = 0;
  }

  // Button / key: clear -> fair -> overcast -> storm -> changing -> clear ...
  cycle() {
    const n = WEATHER.states.length;
    if (this.auto) {
      this.auto = false;
      this.set(0);
    } else if (this.index === n - 1) {
      this.auto = true;
      this.autoTimer = 60 + Math.random() * 60;
      this.set(Math.floor(n / 2));
    } else {
      this.set(this.index + 1);
    }
  }

  // Returns true when the blended values changed this frame.
  update(dt) {
    if (this.auto) {
      this.autoTimer -= dt;
      if (this.autoTimer <= 0) {
        this.autoTimer = 120 + Math.random() * 150;
        const n = WEATHER.states.length;
        const step = this.index === 0 ? 1 : this.index === n - 1 ? -1 : Math.random() < 0.5 ? -1 : 1;
        this.set(this.index + step);
      }
    }
    if (this.t >= 1) return false;
    this.t = Math.min(1, this.t + dt / WEATHER.transition);
    const e = this.t * this.t * (3 - 2 * this.t);
    for (const k of KEYS) this.v[k] = mix(this.from[k], this.to[k], e);
    return true;
  }
}

// The time-of-day preset as seen through this weather.
export function resolve(base, w) {
  const d = w.dark, c = w.clouds;
  const lum = (col) => col[0] * 0.3 + col[1] * 0.59 + col[2] * 0.11;
  const grey = (col, k) => { const l = lum(col); return col.map((v) => mix(v, l, k)); };
  const scale = (col, k) => col.map((v) => v * k);
  const mix3 = (a, b, t) => a.map((v, i) => mix(v, b[i], t));

  const fog = scale(grey(base.fog.color, d * 0.8), mix(1, 0.5, d));
  const cloudLight = scale(grey(base.fog.color, 0.3 + d * 0.5), mix(1.35, 0.58, d));
  const cloudDark = scale(cloudLight, mix(0.6, 0.4, d));
  const bw = base.water;
  return {
    ...base,
    exposure: base.exposure * mix(1, 1.05, d),
    envIntensity: base.envIntensity * mix(1, 0.6, d),
    sky: { ...base.sky, turbidity: mix(base.sky.turbidity, 18, d) },
    sun: { color: grey(base.sun.color, d * 0.6), intensity: base.sun.intensity * w.sun },
    ambient: { color: grey(base.ambient.color, d * 0.5), intensity: base.ambient.intensity * mix(1, 0.75, d) },
    fog: { color: fog, density: base.fog.density * w.fog },
    water: {
      ...bw,
      deep: scale(grey(bw.deep, d * 0.35), mix(1, 0.9, d)),
      shallow: scale(grey(bw.shallow, d * 0.45), mix(1, 0.8, d)),
      horizon: mix3(bw.horizon, scale(fog, 1.05), Math.min(1, d * 1.1)),
      zenith: mix3(bw.zenith, cloudLight, c * 0.85),
      foam: scale(grey(bw.foam, d * 0.3), mix(1, 0.68, d)),
      specStrength: bw.specStrength * Math.pow(w.sun, 1.5),
      sunScale: w.sun,
    },
    clouds: { cover: c, dark: d, light: cloudLight, shadow: cloudDark, wind: w.wind },
  };
}
