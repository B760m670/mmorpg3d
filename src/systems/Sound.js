// Procedural, spatial soundscape (Web Audio, no sound files).
//
// The listener is the camera. Point sources are placed in the world and
// attenuate with distance, carry direction (HRTF on desktop, stereo panning
// on phones) and lose their highs with distance (air absorption):
//   - the ship: water working along her sides, the bow wave, wind in the
//     rigging, canvas flogging when the wind gets on the wrong side of it;
//   - the land: surf breaking on the nearest cliffs (found by scanning the
//     terrain around you), waterfalls, gulls near the shore and over the
//     ship in fair weather;
//   - the sky: thunder from where the lightning struck, arriving after
//     distance / 343 m/s.
// Ambient beds that come from everywhere: open-sea waves, wind, rain. Aboard
// a wooden ship you hear her timbers work in a seaway; below decks the
// outside is muffled, the sea is close through the planking and rain drums
// on the deck overhead. Between the fjord walls sound rings (reverb grows
// with how enclosed you are).
// Browsers allow audio only after a tap or key press: start() is called from
// the first user gesture.

const C_SOUND = 343;
const _v = { x: 0, y: 0, z: 0 };

export class SoundScape {
  constructor({ terrain, mobile = false } = {}) {
    this.terrain = terrain;
    this.mobile = mobile;
    this.ctx = null;
    this.muted = false;
    this.gust = 0;
    this.gustTarget = 0;
    this.gustTimer = 0;
    this.scanTimer = 0;
    this.shores = [];          // nearest shore points [{x, z, d}]
    this.enclosure = 0;        // 0 open sea .. 1 between walls
    this.gullTimer = 3;
    this.creakTimer = 0;
    this.flapTimer = 0;
  }

  // ------------------------------------------------------------ graph
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

    const len = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);
    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, ctx.currentTime, 0.8);

    // outside world -> muffled from below decks -> master
    this.muffle = this.filter('lowpass', 18000, 0.5);
    this.muffle.connect(this.master);
    this.outside = ctx.createGain();
    this.outside.connect(this.muffle);

    // room / fjord reverb
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(2.8);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.05;
    this.reverbSend.connect(this.reverb).connect(this.muffle);

    const bed = (type, f, q, dest) => {
      const flt = this.filter(type, f, q);
      const g = ctx.createGain();
      g.gain.value = 0;
      this.noise().connect(flt).connect(g).connect(dest);
      return { flt, g };
    };
    this.bed = bed;
    // ambient beds
    this.seaBed = bed('lowpass', 650, 0.4, this.outside);
    this.wind = bed('bandpass', 620, 1.1, this.outside);
    this.rain = bed('highpass', 2600, 0.5, this.outside);
    this.deckRain = bed('bandpass', 3800, 1.2, this.outside);
    // below decks: rain on the planking overhead, the sea just outboard
    this.overhead = bed('bandpass', 900, 0.8, this.master);
    this.hullSea = bed('lowpass', 240, 0.7, this.master);

    // ship-borne point sources
    this.slosh = this.spatial({ ref: 6 });
    this.wash = this.spatial({ ref: 8 });
    this.rigging = this.spatial({ ref: 10 });
    this.canvas = this.spatial({ ref: 12, reverb: 0.3 });
    this.sloshBed = bed('lowpass', 420, 0.6, this.slosh.input);
    this.washBed = bed('bandpass', 850, 0.5, this.wash.input);
    // wind in the rigging: a moan of the shrouds and the whistle of the
    // running rigging, both rising with the wind
    this.moan = bed('bandpass', 210, 7, this.rigging.input);
    this.whistle = bed('bandpass', 1500, 9, this.rigging.input);
    // canvas: the flutter of a sail shaking, and its cracks (events)
    this.flutter = bed('bandpass', 380, 1.4, this.canvas.input);
    this.flutterAM = ctx.createGain();
    this.flutter.g.disconnect();
    this.flutter.g.connect(this.flutterAM).connect(this.canvas.input);
    this.flutterLfo = ctx.createOscillator();
    this.flutterLfo.frequency.value = 7;
    const lfoDepth = ctx.createGain(); lfoDepth.gain.value = 0.5;
    this.flutterLfo.connect(lfoDepth).connect(this.flutterAM.gain);
    this.flutterAM.gain.value = 0.5;
    this.flutterLfo.start();

    // surf on the nearest cliffs
    const nSurf = this.mobile ? 3 : 4;
    this.surf = [];
    for (let i = 0; i < nSurf; i++) {
      const sp = this.spatial({ ref: 30, rolloff: 1.1, reverb: 0.35 });
      const b = bed('bandpass', 520 + i * 90, 0.45, sp.input);
      this.surf.push({ sp, b, phase: Math.random() * 6.28, period: 6 + Math.random() * 5 });
    }

    // waterfalls: the two nearest roar from where they hit the water
    this.fallVoices = [];
    for (let i = 0; i < 2; i++) {
      const sp = this.spatial({ ref: 45, rolloff: 1, reverb: 0.5 });
      const roar = bed('lowpass', 2400, 0.5, sp.input);
      const rumble = bed('bandpass', 260, 0.8, sp.input);
      this.fallVoices.push({ sp, roar, rumble });
    }

    // under water: the low roar of the sea all around (surf, swell on rock)
    this.uwBed = bed('lowpass', 260, 0.7, this.master);
    this.uwHiss = bed('bandpass', 1800, 0.6, this.master);

    // gulls: a few voices that move around
    this.gulls = [];
    for (let i = 0; i < 3; i++) this.gulls.push({ sp: this.spatial({ ref: 12, reverb: 0.3 }), busy: 0 });
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

  impulse(seconds) {
    const ctx = this.ctx;
    const n = Math.floor(ctx.sampleRate * seconds);
    const ir = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < n; i++) {
        const t = i / ctx.sampleRate;
        // sparse early reflections, then a smooth tail
        const early = t < 0.25 && Math.random() < 0.004 ? (Math.random() * 2 - 1) * 2 : 0;
        d[i] = ((Math.random() * 2 - 1) * Math.exp(-t * 2.4) + early * Math.exp(-t * 6)) * 0.5;
      }
    }
    return ir;
  }

  // A point source: input -> air absorption -> panner -> (outside) + reverb
  spatial({ ref = 10, rolloff = 1, dest = null, reverb = 0.2 } = {}) {
    const ctx = this.ctx;
    const p = ctx.createPanner();
    p.panningModel = this.mobile ? 'equalpower' : 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.rolloffFactor = rolloff;
    p.maxDistance = 20000;
    const air = this.filter('lowpass', 20000, 0.5);
    const input = ctx.createGain();
    input.connect(air).connect(p).connect(dest || this.outside);
    if (reverb > 0) {
      const send = ctx.createGain();
      send.gain.value = reverb;
      p.connect(send).connect(this.reverbSend);
    }
    return { input, air, p, x: 0, y: 0, z: 0 };
  }

  // Free a one-shot source once it has finished sounding.
  dispose(sp, afterSec) {
    setTimeout(() => { try { sp.input.disconnect(); sp.p.disconnect(); } catch (e) { /* already gone */ } }, afterSec * 1000 + 200);
  }

  place(sp, x, y, z, listener) {
    sp.x = x; sp.y = y; sp.z = z;
    const p = sp.p;
    if (p.positionX) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; } else p.setPosition(x, y, z);
    if (listener) {
      const d = Math.hypot(x - listener.x, y - listener.y, z - listener.z);
      sp.air.frequency.value = Math.max(450, Math.min(20000, 20000 * Math.exp(-d / 700)));
    }
  }

  toggle() {
    this.muted = !this.muted;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, this.ctx.currentTime, 0.2);
    return this.muted;
  }

  // ------------------------------------------------------------ world
  // Shore points around the listener: 24 bearings, first land within 900 m.
  scanShores(lx, lz) {
    const hits = [];
    let closed = 0;
    const g = this.terrain.grid;
    const maxX = g.minX + (g.nx - 1) * g.spacing, maxZ = g.minZ + (g.nz - 1) * g.spacing;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const dx = Math.sin(a), dz = -Math.cos(a);
      for (let r = 10; r <= 900; r += 12) {
        const x = lx + dx * r, z = lz + dz * r;
        if (x < g.minX || x > maxX || z < g.minZ || z > maxZ) break;   // open sea beyond the map
        if (this.terrain.sample(x, z) > 0.5) {
          hits.push({ x: lx + dx * r, z: lz + dz * r, d: r, a });
          closed += 1 - r / 900;
          break;
        }
      }
    }
    this.enclosure = Math.min(1, closed / 10);
    hits.sort((p, q) => p.d - q.d);
    const pick = [];
    for (const h of hits) {
      if (pick.every((p) => Math.abs(Math.atan2(Math.sin(p.a - h.a), Math.cos(p.a - h.a))) > 0.7)) pick.push(h);
      if (pick.length >= this.surf.length) break;
    }
    this.shores = pick;
  }

  setListener(camera) {
    const L = this.ctx.listener;
    const p = camera.position;
    const f = camera.getWorldDirection(this._f || (this._f = camera.position.clone()));
    const u = (this._u || (this._u = camera.up.clone())).set(0, 1, 0).applyQuaternion(camera.quaternion);
    if (L.positionX) {
      L.positionX.value = p.x; L.positionY.value = p.y; L.positionZ.value = p.z;
      L.forwardX.value = f.x; L.forwardY.value = f.y; L.forwardZ.value = f.z;
      L.upX.value = u.x; L.upY.value = u.y; L.upZ.value = u.z;
    } else {
      L.setPosition(p.x, p.y, p.z);
      L.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
    }
    _v.x = p.x; _v.y = p.y; _v.z = p.z;
    this._lastL = _v;
    return _v;
  }

  shipPoint(ship, x, y, z) {
    const v = (this._sp || (this._sp = ship.position.clone())).set(x, y, z);
    return ship.localToWorld(v);
  }

  // s: { camera, ship (the model), speed, heave, rollRate, sea 0..1,
  //      exposure 0..1, wind, rain, dark, night, below (below decks),
  //      aboard, canvas 0..1 (sail set), flog 0..1 (canvas shaking),
  //      underwater, shipDist, fallFlow }
  update(dt, s) {
    if (!this.ctx || !s.ship) return;
    const t = this.ctx.currentTime;
    const set = (param, v, tc = 0.25) => param.setTargetAtTime(v, t, tc);
    const L = this.setListener(s.camera);

    this.gustTimer -= dt;
    if (this.gustTimer <= 0) { this.gustTimer = 1.5 + Math.random() * 4; this.gustTarget = Math.random(); }
    this.gust += (this.gustTarget - this.gust) * Math.min(1, dt * 0.8);

    this.scanTimer -= dt;
    if (this.scanTimer <= 0) { this.scanTimer = 0.7; this.scanShores(L.x, L.z); }

    // under water the air-borne world is a dull rumble from above; below
    // decks it comes through oak a foot thick
    const uw = !!s.underwater;
    set(this.muffle.frequency, uw ? 320 : s.below ? 520 : 18000, 0.15);
    set(this.outside.gain, uw ? 0.4 : s.below ? 0.7 : 1, 0.2);
    set(this.uwBed.g.gain, uw ? 0.22 + 0.25 * s.sea : 0, 0.3);
    set(this.uwHiss.g.gain, uw ? 0.015 : 0, 0.3);
    set(this.reverbSend.gain, 0.03 + 0.45 * this.enclosure, 1.0);

    // --- the ship
    const ship = s.ship;
    const work = Math.min(0.4, Math.abs(s.heave) * 0.15 + Math.abs(s.rollRate) * 1.2);
    let p = this.shipPoint(ship, 0, 0.3, 0);
    this.place(this.slosh, p.x, p.y, p.z, L);
    set(this.sloshBed.g.gain, 0.12 + 0.35 * s.sea + work);
    set(this.hullSea.g.gain, s.below ? 0.25 + 0.5 * s.sea + work + Math.min(0.3, Math.max(0, s.speed) * 0.05) : 0, 0.4);
    p = this.shipPoint(ship, 0, 1, -22);
    this.place(this.wash, p.x, p.y, p.z, L);
    set(this.washBed.g.gain, Math.min(1, Math.max(0, s.speed) / 4) * (0.3 + 0.3 * s.sea));
    set(this.washBed.flt.frequency, 650 + Math.max(0, s.speed) * 80);
    p = this.shipPoint(ship, 0, 20, 0);
    this.place(this.rigging, p.x, p.y, p.z, L);
    const w = Math.min(1, s.wind / 20);
    set(this.moan.g.gain, Math.max(0, w - 0.2) * 0.5 * (0.5 + this.gust), 0.6);
    set(this.moan.flt.frequency, 170 + 90 * w + 40 * this.gust, 0.8);
    set(this.whistle.g.gain, Math.max(0, w - 0.4) * 0.3 * (0.4 + this.gust));
    set(this.whistle.flt.frequency, 1300 + 900 * this.gust, 0.5);
    // canvas shaking: a flutter while it lifts, and loud cracks as it fills
    // and empties
    p = this.shipPoint(ship, 0, 16, -2);
    this.place(this.canvas, p.x, p.y, p.z, L);
    const flog = (s.canvas || 0) * (s.flog || 0) * Math.min(1, s.wind / 6);
    set(this.flutter.g.gain, flog * 0.5, 0.3);
    set(this.flutterLfo.frequency, 5 + 6 * w + 2 * this.gust, 0.5);
    this.flapTimer -= dt;
    if (flog > 0.05 && this.flapTimer <= 0) {
      this.flapTimer = 0.35 + Math.random() * 1.6 * (1.2 - flog);
      this.flap(0.3 + 0.7 * flog);
    }

    // --- ambient beds
    set(this.seaBed.g.gain, (0.05 + 0.3 * s.sea) * (0.4 + 0.6 * s.exposure));
    const wl = w * w * (0.6 + 0.6 * this.gust);
    set(this.wind.g.gain, wl * 0.5);
    set(this.wind.flt.frequency, 400 + 700 * w + 300 * this.gust, 0.5);
    set(this.rain.g.gain, s.rain * 0.2);
    set(this.overhead.g.gain, s.below ? s.rain * 0.3 : 0);
    set(this.deckRain.g.gain, s.aboard && !s.below ? s.rain * 0.12 : 0);

    // --- surf on the cliffs: each voice surges with its own swell period
    this.surf.forEach((v, i) => {
      const sh = this.shores[i];
      v.phase += (dt * Math.PI * 2) / v.period;
      if (!sh) { set(v.b.g.gain, 0, 0.5); return; }
      this.place(v.sp, sh.x, 1.5, sh.z, L);
      const surge = 0.3 + 0.7 * Math.pow(Math.max(0, Math.sin(v.phase)), 3);
      set(v.b.g.gain, (0.25 + 0.9 * s.sea) * surge, 0.3);
    });

    // --- waterfalls
    if (this.falls && this.falls.length) {
      const near2 = this.falls.map((f) => ({ f, d: Math.hypot(f.base.x - L.x, f.base.z - L.z) }))
        .sort((a, b) => a.d - b.d);
      this.fallVoices.forEach((v, i) => {
        const n2 = near2[i];
        if (!n2) { set(v.roar.g.gain, 0); set(v.rumble.g.gain, 0); return; }
        this.place(v.sp, n2.f.base.x, 3, n2.f.base.z, L);
        set(v.roar.g.gain, 0.5 * (s.fallFlow ?? 0.5), 0.5);
        set(v.rumble.g.gain, 0.6 * (s.fallFlow ?? 0.5), 0.5);
      });
    }

    // --- gulls: fair weather, daylight, more near the shore
    this.gullTimer -= dt;
    const near = this.shores.length ? Math.max(0, 1 - this.shores[0].d / 600) : 0;
    const gullChance = (1 - s.dark) * (s.night ? 0 : 1) * (1 - s.rain) * (0.25 + 0.75 * near);
    if (this.gullTimer <= 0) {
      this.gullTimer = 2 + Math.random() * 7;
      if (Math.random() < gullChance) this.gullCall(L);
    }

    // --- her timbers working: always a little, more in a seaway, most
    // below decks
    this.creakTimer -= dt;
    if (s.aboard && this.creakTimer <= 0) {
      const motion = Math.min(1, Math.abs(s.rollRate) * 6 + Math.abs(s.heave) * 0.3 + s.sea * 0.4);
      this.creakTimer = (s.below ? 0.8 : 1.6) + Math.random() * (5 - 3.5 * motion);
      if (Math.random() < 0.4 + 0.5 * motion) this.creak((0.2 + 0.8 * motion) * (s.below ? 1 : 0.6));
    }
  }

  // ------------------------------------------------------------ events
  gullCall(L) {
    const g = this.gulls.find((v) => v.busy < this.ctx.currentTime);
    if (!g) return;
    const ctx = this.ctx;
    let x, y, z;
    if (this.shores.length && Math.random() < 0.6) {
      const sh = this.shores[Math.floor(Math.random() * this.shores.length)];
      x = sh.x + (Math.random() - 0.5) * 80; z = sh.z + (Math.random() - 0.5) * 80; y = 20 + Math.random() * 60;
    } else {
      const a = Math.random() * Math.PI * 2, r = 20 + Math.random() * 120;
      x = L.x + Math.sin(a) * r; z = L.z + Math.cos(a) * r; y = 10 + Math.random() * 30;
    }
    this.place(g.sp, x, y, z, L);
    let t = ctx.currentTime + 0.05;
    const syll = 1 + Math.floor(Math.random() * 4);
    const base = 1300 + Math.random() * 500;
    for (let k = 0; k < syll; k++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const bp = this.filter('bandpass', base * 1.6, 3);
      const env = ctx.createGain();
      const dur = 0.22 + Math.random() * 0.2;
      // "kee-ow": up, then falling
      o.frequency.setValueAtTime(base * 0.8, t);
      o.frequency.linearRampToValueAtTime(base * 1.25, t + dur * 0.25);
      o.frequency.exponentialRampToValueAtTime(base * 0.62, t + dur);
      bp.frequency.setValueAtTime(base * 1.5, t);
      bp.frequency.linearRampToValueAtTime(base * 2, t + dur * 0.3);
      bp.frequency.exponentialRampToValueAtTime(base * 1.1, t + dur);
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.35, t + 0.03);
      env.gain.setValueAtTime(0.3, t + dur * 0.6);
      env.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(bp).connect(env).connect(g.sp.input);
      o.start(t);
      o.stop(t + dur + 0.05);
      t += dur + 0.06 + Math.random() * 0.12;
    }
    g.busy = t + 0.3;
  }

  // A breath on the regulator: in, the demand valve hisses; out, a burst of
  // bubbles past the ears (lower and louder deeper, as the gas is denser).
  breath(out, depth = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = this.noise();
    const env = ctx.createGain();
    if (!out) {
      const bp = this.filter('bandpass', 2600, 1.4);
      const hp = this.filter('highpass', 900, 0.7);
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.16, t + 0.25);
      env.gain.linearRampToValueAtTime(0.12, t + 1.0);
      env.gain.linearRampToValueAtTime(0, t + 1.5);
      src.connect(hp).connect(bp).connect(env).connect(this.master);
      src.stop(t + 1.6);
    } else {
      const lp = this.filter('lowpass', 700 - Math.min(300, depth * 8), 1.2);
      const bp = this.filter('bandpass', 380, 2.5);
      env.gain.setValueAtTime(0, t);
      // irregular bursts: bubbles breaking off the exhaust valve
      let tt = t;
      while (tt < t + 1.7) {
        const a = 0.25 + Math.random() * 0.45;
        env.gain.setValueAtTime(a, tt);
        env.gain.exponentialRampToValueAtTime(0.02, tt + 0.05 + Math.random() * 0.05);
        bp.frequency.setValueAtTime(250 + Math.random() * 500, tt);
        tt += 0.05 + Math.random() * 0.07;
      }
      env.gain.linearRampToValueAtTime(0, tt + 0.05);
      src.connect(lp).connect(bp).connect(env).connect(this.master);
      src.stop(tt + 0.1);
    }
  }

  // Into the water.
  splash() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = this.noise();
    const lp = this.filter('lowpass', 2400, 0.6);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.9, t + 0.02);
    env.gain.exponentialRampToValueAtTime(0.001, t + 1.1);
    lp.frequency.exponentialRampToValueAtTime(300, t + 1.0);
    src.connect(lp).connect(env).connect(this.master);
    src.stop(t + 1.2);
  }

  // Oak and pine working against each other: a slow, rising groan with a
  // dry tick or two at its end.
  creak(strength) {
    const ctx = this.ctx, t = ctx.currentTime;
    const src = this.noise();
    const f0 = 140 + Math.random() * 160;
    const bp = this.filter('bandpass', f0, 22);
    const bp2 = this.filter('bandpass', f0 * 2.1, 16);
    const env = ctx.createGain();
    const dur = 0.5 + Math.random() * 0.9;
    bp.frequency.linearRampToValueAtTime(f0 * (1.25 + Math.random() * 0.5), t + dur);
    bp2.frequency.linearRampToValueAtTime(f0 * 2.1 * (1.2 + Math.random() * 0.4), t + dur);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.3 + 0.6 * strength, t + dur * 0.5);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(bp).connect(env);
    src.connect(bp2).connect(env);
    env.connect(this.master);
    src.stop(t + dur + 0.05);
    if (Math.random() < 0.5) {
      const tick = this.noise();
      const hp = this.filter('bandpass', 2200 + Math.random() * 1500, 4);
      const tg = ctx.createGain();
      const tt = t + dur * (0.6 + Math.random() * 0.4);
      tg.gain.setValueAtTime(0, tt);
      tg.gain.linearRampToValueAtTime(0.25 * strength, tt + 0.004);
      tg.gain.exponentialRampToValueAtTime(0.001, tt + 0.05);
      tick.connect(hp).connect(tg).connect(this.master);
      tick.stop(tt + 0.08);
    }
  }

  // A sail cracking full and empty: a short, heavy slap of canvas.
  flap(strength) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = this.noise();
    const lp = this.filter('lowpass', 1600, 0.7);
    const bp = this.filter('bandpass', 260, 1.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.9 * strength, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18 + 0.1 * strength);
    src.connect(lp).connect(g);
    src.connect(bp).connect(g);
    g.connect(this.canvas.input);
    src.stop(t + 0.35);
  }

  // A green sea against the bow: a dull boom from the bow.
  slam(strength) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = this.noise();
    const flt = this.filter('lowpass', 240, 0.8);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1.2 * strength, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    src.connect(flt).connect(g).connect(this.wash.input);
    src.stop(t + 1);
  }

  // Thunder from a strike at distance d (m) in a random direction.
  thunder(strength = 1, listener = null) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const d = 700 + Math.random() * 5500;
    const a = Math.random() * Math.PI * 2;
    const lx = listener ? listener.x : 0, lz = listener ? listener.z : 0;
    const sp = this.spatial({ ref: 900, rolloff: 1, reverb: 0.7 });
    this.place(sp, lx + Math.sin(a) * d, 1200, lz + Math.cos(a) * d, { x: lx, y: 0, z: lz });
    sp.air.frequency.value = Math.max(150, 1800 * Math.exp(-d / 1500));
    const t = ctx.currentTime + d / C_SOUND;
    const src = this.noise();
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    if (d < 1500) {                                            // close: a crack first
      const crack = this.noise();
      const hp = this.filter('highpass', 900, 0.7);
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0, t);
      cg.gain.linearRampToValueAtTime(1.2 * strength, t + 0.01);
      cg.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      crack.connect(hp).connect(cg).connect(sp.input);
      crack.stop(t + 0.4);
    }
    g.gain.linearRampToValueAtTime(1.6 * strength, t + 0.15);
    let tt = t + 0.15;
    for (let i = 0; i < 5; i++) {
      tt += 0.35 + Math.random() * 0.9;
      g.gain.linearRampToValueAtTime((0.4 + Math.random() * 0.9) * strength, tt);
    }
    g.gain.exponentialRampToValueAtTime(0.001, tt + 3.5);
    src.connect(g).connect(sp.input);
    src.stop(tt + 3.6);
    this.dispose(sp, tt + 3.6 - ctx.currentTime);
  }
}
