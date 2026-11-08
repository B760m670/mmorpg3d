import { SEA } from '../config.js';
import { worldToLatLon, convergence, deviation, DECLINATION, wrap360, wrap180 } from './Geo.js';

// The ship's sensors and bridge equipment, each with its own power supply,
// start-up time and errors, so the instruments show what the sensors
// measure, not the game's exact state:
//
//   GPS          position with a wandering error of a couple of metres, SOG
//                and COG from Doppler; about 40 s to a fix after power-on
//   sat compass  true heading (GPS antennas), 0.1 deg noise, rate of turn;
//                a minute to align
//   magnetic     the steering compass: magnetic heading with the local
//   compass      declination (+7.5 deg E) and the ship's deviation card, a
//                swinging card, heeling and turning errors (strong this far
//                north, where the field dips 77 deg); needs no power at all
//   speed log    speed through the water (electromagnetic)
//   echo sounder depth from the transducer in the keel: the real bottom under
//                it, the real tide, the ship's heave; drop-outs in aerated water
//   anemometer   apparent wind at the masthead; true wind worked out from it
//   barometer, air and sea temperature
//   main engine  speed, oil pressure, coolant and exhaust temperatures, boost,
//                fuel rate, with the lags of a real engine
//   autopilot    holds a set course on the sat compass through the steering
//                gear; off-course alarm; taking the wheel overrides it
//   BNWAS        bridge watch alarm while on autopilot: reset it every 6 min

// id: name, supply (ups = 230 V through the UPS, dc = 24 V), W, boot s
const DEVICES = {
  radar: ['Радар X-диапазона', 'ups', 180, 90],
  plotter: ['Картплоттер', 'ups', 80, 25],
  conning: ['Дисплей курса (конинг)', 'ups', 50, 12],
  engmon: ['Монитор ГД и электростанции', 'ups', 45, 10],
  sounder: ['Эхолот', 'ups', 60, 6],
  gps: ['GPS-приёмник', 'dc', 8, 40],
  satc: ['Спутниковый компас', 'dc', 12, 60],
  log: ['Лаг', 'dc', 15, 5],
  wind: ['Анемометр', 'dc', 5, 2],
  ap: ['Авторулевой', 'dc', 30, 5],
  vhf: ['УКВ-радиостанции', 'dc', 30, 3],
  ais: ['АИС', 'dc', 8, 30],
  bnwas: ['BNWAS (контроль вахты)', 'dc', 3, 1],
};

const gauss = () => {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

export const DRAFT = 4.2;           // transducer depth below the waterline (m)

export class Sensors {
  constructor(alarms, elec) {
    this.alarms = alarms;
    this.elec = elec;
    this.dev = {};
    for (const [id, [name, bus, w, boot]] of Object.entries(DEVICES)) {
      this.dev[id] = { id, name, bus, w, boot, on: id !== 'ais' || true, state: 'ready', t: 0 };
    }
    this.radarTx = true;
    // values
    this.gps = { fix: true, sats: 11, hdop: 0.9, ex: 0, ez: 0, x: 0, z: 0, lat: 0, lon: 0, sog: 0, cog: 0, t: 0 };
    this.hdg = 0; this.rot = 0; this.hdgOk = true;
    this.mag = { card: 0, v: 0 };
    this.stw = 0;
    this.depth = { dbs: 40, dbt: 36, ok: true, t: 0 };
    this.windS = { aws: 0, awa: 0, tws: 0, twd: 0, gust: 0, gT: 0 };
    this.baro = 1012; this.baroHist = [];
    this.airT = 3.5; this.seaT = 7.8;
    this.me = { state: 'running', t: 0, rpm: 600, oil: 2.4, cool: 82, exh: 200, boost: 0.2, fuel: 10, load: 0, hours: 18432 };
    this.ap = { mode: 'hand', set: 0, wheel: 0, offT: 0, msg: '' };
    this.bnwas = { t: 360, stage: 0 };
    this.time = 0;
  }

  ready(id) { return this.dev[id].state === 'ready'; }

  toggle(id) {
    const d = this.dev[id];
    d.on = !d.on;
    if (!d.on) d.state = 'off';
    if (id === 'ap' && !d.on) this.ap.mode = 'hand';
  }

  // ---------------------------------------------------------------- main engine
  startME() {
    const me = this.me;
    if (me.state !== 'stopped') return;
    if (this.elec.start.soc < 0.2) { me.msg = 'не проворачивается: стартерная АКБ'; return; }
    me.state = 'cranking'; me.t = 0; me.msg = '';
  }
  stopME() {
    if (this.me.state === 'running' || this.me.state === 'cranking') { this.me.state = 'stopped'; this.me.t = 0; }
  }

  // ---------------------------------------------------------------- autopilot
  apEngage() {
    if (!this.ready('ap')) { this.ap.msg = 'авторулевой выключен'; return; }
    if (!this.hdgOk) { this.ap.msg = 'нет курса от компаса'; return; }
    this.ap.mode = 'auto';
    this.ap.set = Math.round(this.hdg);
    this.ap.msg = '';
    this.bnwasReset();
  }
  apHand(msg = '') { this.ap.mode = 'hand'; this.ap.msg = msg; }
  apAdjust(d) { this.ap.set = wrap360(this.ap.set + d); this.bnwasReset(); }
  bnwasReset() { this.bnwas.t = 360; this.bnwas.stage = 0; }

  // ---------------------------------------------------------------- update
  // world: { boat, tide, heightAt(x,z), weather, seaRough }
  update(dt, world) {
    if (dt <= 0) return;
    this.time += dt;
    const { boat } = world;
    const E = this.elec, A = this.alarms;

    // --- power and start-up of each device
    let upsW = 0, dcW = 0;
    for (const d of Object.values(this.dev)) {
      const supply = d.bus === 'ups' ? E.upsOk : E.dcOk;
      if (!d.on || !supply) { d.state = d.on ? 'nopower' : 'off'; d.t = 0; continue; }
      if (d.state !== 'ready' && d.state !== 'booting') { d.state = 'booting'; d.t = d.boot; }
      if (d.state === 'booting') { d.t -= dt; if (d.t <= 0) d.state = 'ready'; }
      const w = d.id === 'radar' && this.radarTx && d.state === 'ready' ? 450 : d.w;
      if (d.bus === 'ups') upsW += w; else dcW += w;
    }
    E.ext.nav = upsW / 1000;
    this.dcW = dcW;

    // --- truth
    const px = boat.position.x, pz = boat.position.z;
    const conv = convergence(px, pz);
    const trueHdg = wrap360(boat.headingDeg + conv);
    const trueRot = (-boat.yawRate * 180) / Math.PI;            // deg/s, + to starboard
    const sp = boat.speed;                                      // m/s through the water (no current here)

    // --- GPS
    const g = this.gps;
    // the error wanders slowly (atmosphere, satellite geometry)
    g.ex += (-g.ex / 90) * dt + gauss() * 1.6 * Math.sqrt((2 * dt) / 90);
    g.ez += (-g.ez / 90) * dt + gauss() * 1.6 * Math.sqrt((2 * dt) / 90);
    const gpsOn = this.ready('gps');
    g.fix = gpsOn;
    if (this.dev.gps.state === 'booting') g.sats = Math.max(0, Math.round((1 - this.dev.gps.t / 40) * 9));
    g.t -= dt;
    if (gpsOn && g.t <= 0) {
      g.t = 1;
      g.sats = 9 + Math.round(Math.random() * 3);
      g.hdop = 0.8 + Math.random() * 0.4;
      g.x = px + g.ex + gauss() * 0.4;
      g.z = pz + g.ez + gauss() * 0.4;
      [g.lat, g.lon] = worldToLatLon(g.x, g.z);
      const sog = Math.abs(sp) * 1.943844 + gauss() * 0.05;
      g.sog = Math.max(0, sog);
      const dir = sp >= 0 ? trueHdg : trueHdg + 180;
      g.cog = wrap360(dir + (g.sog > 0.3 ? gauss() * (2.5 / Math.max(0.5, g.sog)) : gauss() * 60));
    }

    // --- sat compass
    this.hdgOk = this.ready('satc');
    if (this.hdgOk) {
      this.hdg = wrap360(trueHdg + gauss() * 0.1);
      this.rot += (trueRot * 60 - this.rot) * Math.min(1, dt * 3);   // deg/min
    }

    // --- magnetic compass: works without power
    const magHdg = wrap360(trueHdg - DECLINATION);
    const compassHdg = wrap360(magHdg - deviation(magHdg));
    const heeling = (boat.roll * 180) / Math.PI * 0.6 * Math.cos((magHdg * Math.PI) / 180);
    const turning = trueRot * 1.1 * Math.cos((magHdg * Math.PI) / 180);
    const target = wrap360(compassHdg + heeling + turning);
    const m = this.mag;
    if (!m.init) { m.card = target; m.init = true; }
    const err = wrap180(target - m.card);
    m.v += (err * 0.1 - m.v * 0.45) * dt * 4;        // card: ~16 s period, well damped
    m.card = wrap360(m.card + m.v * dt);

    // --- log
    if (this.ready('log')) this.stw += (Math.abs(sp) * 1.943844 * Math.sign(sp || 1) + gauss() * 0.04 - this.stw) * Math.min(1, dt / 3);

    // --- echo sounder: transducer in the keel, about 4 m forward of amidships
    const d = this.depth;
    d.t -= dt;
    if (this.ready('sounder') && d.t <= 0) {
      d.t = 0.5;
      const fx = Math.sin(boat.heading), fz = Math.cos(boat.heading);
      const tx = px - fx * 4, tz = pz - fz * 4;
      const surface = boat.position.y;                 // water at the hull, with tide and heave
      const dbs = surface - world.heightAt(tx, tz);
      // bubbles under the hull in a seaway at speed blank the bottom now and then
      const aerated = Math.random() < world.seaRough * 0.25 * Math.min(1, Math.abs(sp) / 4);
      d.ok = dbs < 600 && !aerated;
      if (d.ok) {
        d.dbs = dbs + gauss() * 0.08;
        d.dbt = d.dbs - DRAFT;
      }
    }

    // --- wind: true wind from the weather; apparent at the masthead
    const w = this.windS;
    w.gT -= dt;
    if (w.gT <= 0) { w.gT = 2 + Math.random() * 5; w.gTarget = (Math.random() - 0.3) * 0.35; }
    w.gust += ((w.gTarget || 0) - w.gust) * Math.min(1, dt * 0.7);
    const tws = Math.max(0, world.weather.v.wind * (1 + w.gust));
    const wd = SEA.windDir;
    const towardGrid = Math.atan2(wd[0], -wd[1]) * 180 / Math.PI;
    const twd = wrap360(towardGrid + 180 + conv);         // true direction the wind comes FROM
    // true wind velocity (blowing toward), minus the ship's velocity
    const tvx = Math.sin(((twd + 180) * Math.PI) / 180) * tws, tvz = Math.cos(((twd + 180) * Math.PI) / 180) * tws;
    const svx = Math.sin((trueHdg * Math.PI) / 180) * sp, svz = Math.cos((trueHdg * Math.PI) / 180) * sp;
    const avx = tvx - svx, avz = tvz - svz;
    if (this.ready('wind')) {
      const aws = Math.hypot(avx, avz);
      const fromA = wrap360((Math.atan2(-avx, -avz) * 180) / Math.PI);
      w.aws += (aws - w.aws) * Math.min(1, dt * 1.5);
      w.awa = wrap180(fromA - trueHdg);
      w.tws += (tws - w.tws) * Math.min(1, dt);
      w.twd = twd;
    }

    // --- barometer and temperatures
    const wv = world.weather.v;
    const pTarget = 1024 - 34 * wv.dark - 0.5 * wv.wind - 6 * wv.rain;
    this.baro += (pTarget - this.baro) * Math.min(1, dt / 600);
    if (!this.baroHist.length || this.time - this.baroHist[this.baroHist.length - 1][0] > 60) {
      this.baroHist.push([this.time, this.baro]);
      if (this.baroHist.length > 200) this.baroHist.shift();
    }

    // --- main engine
    const me = this.me;
    me.t += dt;
    if (me.state === 'cranking') {
      E.start.soc -= (600 * dt) / 3600 / E.start.ah;
      me.rpm = 120;
      if (me.t > 2.5) { me.state = 'running'; me.t = 0; }
    }
    const running = me.state === 'running';
    boat.engineRunning = running;
    const n = Math.abs(boat.rpm);
    const rpmT = running ? 600 + 600 * n : 0;
    me.rpm += (rpmT - me.rpm) * Math.min(1, dt * (running ? 1.5 : 0.6));
    me.load = running ? Math.min(1, 0.05 + Math.pow(n, 2.6)) : 0;
    me.oil += ((running ? 2.0 + 2.6 * Math.max(0, me.rpm - 600) / 600 : 0) - me.oil) * Math.min(1, dt * 2);
    me.cool += ((running ? 81 + 5 * me.load : 18) - me.cool) * Math.min(1, dt / (running ? 300 : 1500));
    me.exh += ((running ? 170 + 320 * me.load : 30) - me.exh) * Math.min(1, dt / 25);
    me.boost += ((running ? 0.1 + 2.3 * me.load : 0) - me.boost) * Math.min(1, dt / 3);
    me.fuel = running ? 9 + 285 * Math.pow(n, 2.6) : 0;
    if (running) me.hours += dt / 3600;

    // --- autopilot
    const ap = this.ap;
    if (ap.mode === 'auto') {
      if (!this.ready('ap')) this.apHand('авторулевой обесточен');
      else if (!this.hdgOk) this.apHand('потерян курс от компаса');
    }
    if (ap.mode === 'auto') {
      const e = wrap180(ap.set - this.hdg);                   // + : turn to starboard
      const r = this.rot / 60;                                // deg/s
      const order = Math.max(-20, Math.min(20, 1.4 * e - 14 * r));
      ap.wheel = -order;                                      // starboard rudder is negative here
      if (Math.abs(e) > 10) ap.offT += dt; else ap.offT = 0;
    } else ap.offT = 0;

    // --- BNWAS: armed while on autopilot
    const bn = this.bnwas;
    if (ap.mode === 'auto' && this.ready('bnwas')) {
      bn.t -= dt;
      bn.stage = bn.t > 0 ? 0 : bn.t > -15 ? 1 : bn.t > -105 ? 2 : 3;
    } else { bn.t = 360; bn.stage = 0; }

    // --- alarms
    A.set('gps', this.dev.gps.on && !g.fix, 'GPS: нет местоположения', 'warn');
    A.set('hdg', this.dev.satc.on && !this.hdgOk, 'Спутниковый компас: нет курса', 'warn');
    A.set('shallow', this.ready('sounder') && d.ok && d.dbt < 5, `Мелководье: ${Math.max(0, d.dbt).toFixed(1)} м под килем`, 'alarm');
    A.set('offcourse', ap.offT > 20, `Авторулевой: уход с курса ${wrap180(ap.set - this.hdg).toFixed(0)}°`, 'alarm');
    A.set('apfail', ap.mode === 'hand' && ap.msg && ap.msg !== 'ручное управление', `Авторулевой: ${ap.msg}`, 'alarm');
    A.set('bnwas', bn.stage >= 2, bn.stage >= 3 ? 'BNWAS: вызов капитана — вахта не отвечает' : 'BNWAS: подтвердите бодрствование', 'alarm');
    A.set('meoil', running && me.t > 10 && me.oil < 1.0, 'ГД: низкое давление масла', 'alarm');
    A.set('mestop', me.state === 'stopped', 'Главный двигатель остановлен', 'warn');
    A.set('mestart', !!me.msg, `ГД: ${me.msg}`, 'alarm');
  }

  // helpers for the displays
  get radarOn() { return this.ready('radar') && this.radarTx; }
}

export { DEVICES };
