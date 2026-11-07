// Procedural soundscape (Web Audio, no sound files): the diesel, the sea
// along the hull, wind, rain, thunder and the bow slamming into a sea. Levels
// follow the game: engine rpm and load, ship speed, sea state, wind, rain.
// From inside the wheelhouse the outside world is muffled and the rain
// drums on the roof. Browsers only allow audio after a tap or key press, so
// start() is called from the first user gesture.

export class SoundScape {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.gust = 0;
    this.gustTarget = 0;
    this.gustTimer = 0;
  }

  start() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    if (ctx.state === 'suspended') ctx.resume();

    // 3 s of white noise, looped by several voices at different offsets
    const len = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);
    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, ctx.currentTime, 0.8);

    // outside world -> (muffled indoors) -> master
    this.muffle = this.filter('lowpass', 18000, 0.5);
    this.muffle.connect(this.master);

    const voice = (type, f, q, dest) => {
      const src = this.noise();
      const flt = this.filter(type, f, q);
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(flt).connect(g).connect(dest);
      return { flt, g };
    };
    this.sea = voice('lowpass', 520, 0.4, this.muffle);
    this.wash = voice('bandpass', 950, 0.55, this.muffle);
    this.wind = voice('bandpass', 620, 1.1, this.muffle);
    this.whistle = voice('bandpass', 1900, 9, this.muffle);
    this.rain = voice('highpass', 2600, 0.5, this.muffle);
    this.roof = voice('bandpass', 1100, 0.9, this.master);

    // diesel: firing-frequency sawtooth + sub-harmonic, modulated by the
    // firing pulses, with mechanical noise, through a lowpass
    this.engLP = this.filter('lowpass', 380, 0.9);
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.engGain.connect(this.master);
    this.engA = ctx.createOscillator();
    this.engA.type = 'sawtooth';
    this.engB = ctx.createOscillator();
    this.engB.type = 'square';
    const ga = ctx.createGain(); ga.gain.value = 0.5;
    const gb = ctx.createGain(); gb.gain.value = 0.25;
    this.engA.connect(ga).connect(this.engLP);
    this.engB.connect(gb).connect(this.engLP);
    this.pulse = ctx.createGain();
    this.pulse.gain.value = 0.7;
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    const lfoDepth = ctx.createGain(); lfoDepth.gain.value = 0.3;
    this.lfo.connect(lfoDepth).connect(this.pulse.gain);
    this.engLP.connect(this.pulse).connect(this.engGain);
    this.clatter = voice('bandpass', 1400, 2.5, this.engGain);
    for (const o of [this.engA, this.engB, this.lfo]) o.start();
  }

  noise() {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    s.start(0, Math.random() * 2.9);
    return s;
  }

  filter(type, f, q) {
    const b = this.ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    return b;
  }

  toggle() {
    this.muted = !this.muted;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, this.ctx.currentTime, 0.2);
    return this.muted;
  }

  // s: { rpm (0..1 signed), speed m/s, sea 0..1, wind m/s, rain 0..1,
  //      inside bool, far bool (third-person camera), heave m/s }
  update(dt, s) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const set = (param, v, tc = 0.25) => param.setTargetAtTime(v, t, tc);

    // gusts: a slow random walk
    this.gustTimer -= dt;
    if (this.gustTimer <= 0) { this.gustTimer = 1.5 + Math.random() * 4; this.gustTarget = Math.random(); }
    this.gust += (this.gustTarget - this.gust) * Math.min(1, dt * 0.8);

    set(this.muffle.frequency, s.inside ? 650 : 18000, 0.15);

    const sea = 0.08 + 0.35 * s.sea + Math.min(0.25, Math.abs(s.heave) * 0.12);
    set(this.sea.g.gain, sea * (s.far ? 1.2 : 1));
    set(this.wash.g.gain, Math.min(1, Math.max(0, s.speed) / 6) * (0.18 + 0.2 * s.sea));
    set(this.wash.flt.frequency, 700 + Math.max(0, s.speed) * 70);

    const w = Math.min(1, s.wind / 20);
    const wl = w * w * (0.6 + 0.6 * this.gust);
    set(this.wind.g.gain, wl * 0.55);
    set(this.wind.flt.frequency, 400 + 700 * w + 300 * this.gust, 0.5);
    set(this.whistle.g.gain, Math.max(0, w - 0.45) * 0.12 * this.gust);   // rigging whistles in a gale
    set(this.whistle.flt.frequency, 1500 + 900 * this.gust, 0.5);

    set(this.rain.g.gain, s.rain * 0.22);
    set(this.roof.g.gain, s.inside ? s.rain * 0.35 : 0);

    const n = Math.abs(s.rpm);
    const engRpm = 600 + n * 600;                   // idles at 600, 1200 at full
    const fire = (engRpm / 60) * 3;                 // 6 cylinders, four-stroke
    set(this.engA.frequency, fire, 0.4);
    set(this.engB.frequency, fire * 0.5, 0.4);
    set(this.lfo.frequency, fire * 0.5, 0.4);
    set(this.engLP.frequency, 260 + n * 380, 0.4);
    const eng = (0.12 + 0.28 * n * n) * (s.far ? 0.35 : s.inside ? 0.75 : 1);
    set(this.engGain.gain, eng, 0.3);
    set(this.clatter.g.gain, 0.05 + 0.08 * n, 0.3);
  }

  // A green sea against the bow: a dull boom.
  slam(strength) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = this.noise();
    const flt = this.filter('lowpass', 240, 0.8);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.9 * strength, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    src.connect(flt).connect(g).connect(this.master);
    src.stop(t + 1);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(35, t + 0.6);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.6 * strength, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
    o.connect(og).connect(this.master);
    o.start(t);
    o.stop(t + 0.8);
  }

  // Thunder after a lightning flash: delay ~ distance (343 m/s).
  thunder(delay, strength) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const src = this.noise();
    const flt = this.filter('lowpass', 160 + 200 * strength, 0.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.9 * strength, t + 0.12);
    let tt = t + 0.12;
    for (let i = 0; i < 4; i++) {                   // rolling rumble
      tt += 0.4 + Math.random() * 0.8;
      g.gain.linearRampToValueAtTime((0.3 + Math.random() * 0.6) * strength, tt);
    }
    g.gain.exponentialRampToValueAtTime(0.001, tt + 3);
    src.connect(flt).connect(g).connect(this.muffle);
    src.stop(tt + 3.2);
  }
}
