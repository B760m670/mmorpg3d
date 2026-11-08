import { localTime } from './Geo.js';

// The ship's electrical plant, as on a 24 m stern trawler of this kind
// (a typical arrangement, not the drawings of one vessel):
//
//   - two diesel generator sets in the engine room, 80 kVA / 64 kW each,
//     400 V three-phase 50 Hz, isochronous governors with load sharing;
//   - the main switchboard (MSB): a breaker per generator, the bus, and a
//     breaker per consumer: steering-gear pumps, engine-room fans, fuel
//     separator, fish-hold refrigeration, the deck-machinery hydraulic power
//     pack, bilge pump, fresh-water pump, heating, hot water, galley,
//     lighting, deck floodlights, searchlight, the navigation supply (through
//     a UPS) and the 24 V battery chargers;
//   - 24 V DC: a house battery (2 x 225 Ah) for the navigation lights, the
//     emergency lighting, sensors, radios and alarms, and a separate start
//     battery for the engines; charged by the chargers and the main engine's
//     alternator.
//
// It behaves as a real plant does: loads follow thermostats, schedules and
// what you switch on; a big motor starting pulls the frequency and voltage
// down for a moment; above full load the non-essential consumers are shed
// (preferential trip), and if that is not enough the generator breaker trips
// and the ship blacks out: the steering pumps, lights and everything on AC
// stop, the emergency lights and the UPS take over, and a standby generator
// set to AUTO starts and closes onto the dead bus by itself. Paralleling a
// second generator needs synchronising: matching its frequency and closing
// the breaker when the synchroscope reaches twelve o'clock (or the auto-
// synchroniser does it); closing out of phase trips it.

const F0 = 50, V0 = 400;
const KVA_PF = 0.8;

class Genset {
  constructor(id, name, kw) {
    this.id = id;
    this.name = name;
    this.rated = kw;              // kW (prime)
    this.state = 'stopped';       // stopped | cranking | runup | running | stopping
    this.t = 0;
    this.rpm = 0;
    this.breaker = false;
    this.trim = 0;                // governor speed setting, Hz from 50
    this.phase = 0;               // deg ahead of the bus
    this.kw = 0;
    this.coolant = 14;
    this.hours = 6120 + id * 731;
    this.fuel = 0;                // l/h
    this.mode = 'man';            // standby: auto | man
    this.sync = false;            // auto-synchroniser engaged
    this.msg = '';
  }
  get f() { return this.state === 'running' ? F0 + this.trim : (this.rpm / 1500) * F0; }
  get V() {
    if (this.state === 'running') return V0;
    if (this.state === 'runup' || this.state === 'stopping') return V0 * Math.max(0, Math.min(1, (this.rpm - 1100) / 400));
    return 0;
  }
  get ready() { return this.state === 'running'; }
}

// id, name, rated kW, motor (starting current), essential (kept on a
// preferential trip), on (breaker), auto (restarts by itself after a blackout)
const FEEDERS = [
  ['steer1', 'Рулевой насос № 1', 4, true, true, true, true],
  ['steer2', 'Рулевой насос № 2', 4, true, true, false, true],
  ['fans', 'Вентиляция машинного отделения', 6, true, true, true, true],
  ['sep', 'Топливный сепаратор', 3, true, false, true, false],
  ['fridge', 'Рефрижерация трюма', 11, true, false, true, true],
  ['hyd', 'Гидростанция лебёдок', 37, true, false, false, false],
  ['bilge', 'Осушительный насос (по поплавку)', 5.5, true, true, true, true],
  ['fw', 'Насос пресной воды', 1.1, true, false, true, true],
  ['heat', 'Отопление жилых помещений', 9, false, false, true, true],
  ['hotw', 'Бойлер горячей воды', 3, false, false, true, true],
  ['galley', 'Камбуз', 7.5, false, false, true, true],
  ['light', 'Освещение помещений', 1.2, false, true, true, true],
  ['floods', 'Палубные прожекторы', 2.6, false, false, true, true],
  ['search', 'Поисковый прожектор', 1.0, false, false, true, true],
  ['nav', 'Навигация (через ИБП)', 1.6, false, true, true, true],
  ['charge', 'Зарядные устройства 24 В', 2.4, false, true, true, true],
  ['comp', 'Компрессор рабочего воздуха (тифон)', 4, true, false, true, true],
];

export class Electrical {
  constructor(alarms) {
    this.alarms = alarms;
    this.gens = [new Genset(0, 'ДГ 1', 64), new Genset(1, 'ДГ 2', 64)];
    // at sea: DG1 on the board, DG2 on standby
    const g = this.gens[0];
    g.state = 'running'; g.rpm = 1500; g.breaker = true; g.coolant = 81;
    this.gens[1].mode = 'auto';
    this.feeders = FEEDERS.map(([id, name, kw, motor, ess, on, auto]) => ({
      id, name, kw, motor, ess, on, auto, running: on, shed: false, demand: 0, inrush: 0, restartAt: 0,
    }));
    this.f = {};
    for (const fd of this.feeders) this.f[fd.id] = fd;
    this.ext = { floods: 0, search: 0, nav: 0 };   // kW asked by lights / instruments
    this.live = true;
    this.busF = F0;
    this.busV = V0;
    this.fDip = 0;
    this.vDip = 0;
    this.load = 0;
    this.kw = 0;
    this.prefT = 0;
    this.overT = 0;
    this.lowFT = 0;
    this.deadT = 0;
    this.highT = 0;
    this.blackouts = 0;
    this.lastKw = 0;
    // thermostats and other state behind the loads
    this.holdT = -1.2;        // fish hold, deg C
    this.cabinT = 20.6;       // accommodation, deg C
    this.outT = 3.5;          // air outside
    this.bilge = 0.25;        // bilge level 0..1
    this.hotw = 0; this.fwT = 0; this.galleyT = 0; this.galleyKw = 0; this.kettle = 0;
    this.heatOn = false; this.fridgeOn = true; this.bilgeOn = false;
    this.hydWork = false;     // winches working (hauling the trawl)
    // working air: a 250 l receiver for the whistle, 7.5-9 bar (pressure switch)
    this.air = 8.4; this.airUse = 0; this.compOn = false;
    // 24 V
    this.house = { ah: 450, soc: 0.88, V: 26.8, I: 0 };
    this.start = { ah: 180, soc: 0.95, V: 26.4 };
    this.dcW = 0;             // DC load (W), reported by lights/instruments
    this.dcOk = true;
    // UPS for the bridge electronics
    this.ups = { kwh: 1.0, soc: 1, onBattery: false };
    this.upsOk = true;
    this.fuel = 8650;         // litres in the tanks (14 000 l capacity)
    this.time = 0;
  }

  get busy() { return this.gens.filter((g) => g.breaker && g.ready); }

  // ---------------------------------------------------------------- controls
  startGen(i) {
    const g = this.gens[i];
    if (g.state !== 'stopped') return;
    if (this.start.soc < 0.18) { g.msg = 'не проворачивается: стартерная АКБ разряжена'; return; }
    g.state = 'cranking'; g.t = 0; g.msg = '';
  }

  stopGen(i) {
    const g = this.gens[i];
    if (g.state === 'stopped' || g.state === 'stopping') return;
    if (g.breaker) this.openBreaker(i);
    g.state = 'stopping'; g.sync = false;
  }

  openBreaker(i) {
    const g = this.gens[i];
    g.breaker = false;
    g.sync = false;
  }

  closeBreaker(i) {
    const g = this.gens[i];
    if (g.breaker) return;
    if (!g.ready) { g.msg = 'генератор не готов'; return; }
    const busOn = this.busy.length > 0;
    if (!busOn) {                           // dead bus: close straight on
      g.breaker = true; g.phase = 0; g.msg = '';
      return;
    }
    const df = g.f - this.busF;
    if (Math.abs(df) < 0.3 && Math.abs(g.phase) < 15) {
      g.breaker = true; g.phase = 0; g.trim = this.busy[0].trim; g.msg = '';
      this.fDip -= 0.15;
    } else {
      // out of phase: a heavy current surge; the breaker trips at once
      this.fDip -= 2.5; this.vDip += 60;
      g.msg = `включение вне синхронизма (Δf ${df.toFixed(2)} Гц, ${g.phase.toFixed(0)}°) — АВ отключился`;
      this.alarms.set(`sync${i}`, true, `${g.name}: включение вне синхронизма`, 'alarm');
      setTimeout(() => this.alarms.set(`sync${i}`, false), 1000);
    }
  }

  autoSync(i) {
    const g = this.gens[i];
    if (g.ready && !g.breaker) { g.sync = true; g.msg = 'автосинхронизация…'; }
  }

  trimSpeed(i, d) {
    const g = this.gens[i];
    g.trim = Math.max(-2, Math.min(2, g.trim + d));
    if (g.breaker) for (const o of this.busy) o.trim = g.trim;   // isochronous set point of the bus
  }

  setMode(i, mode) { this.gens[i].mode = mode; }

  toggleFeeder(id) {
    const fd = this.f[id];
    if (!fd) return;
    if (fd.on && fd.motor && !fd.running && this.live) { this._startMotor(fd); return; }   // after a trip: start again
    fd.on = !fd.on;
    fd.shed = false;
    if (fd.on && fd.motor && this.live) this._startMotor(fd);
    if (!fd.on) fd.running = false;
  }

  _startMotor(fd) {
    if (fd.running) return;
    fd.running = true;
    fd.inrush = 1.2;                         // s of direct-on-line starting current
  }

  powered(id) {
    const fd = this.f[id];
    return !!fd && fd.on && !fd.shed && this.live && (!fd.motor || fd.running);
  }

  // ---------------------------------------------------------------- simulation
  // ctx: { rudderRate (deg/s), meRunning, meLoad 0..1, meFuel l/h }
  update(dt, ctx) {
    if (dt <= 0) return;
    this.time += dt;
    const A = this.alarms;

    // --- generator sets: start, run up, stop
    for (const g of this.gens) {
      g.t += dt;
      if (g.state === 'cranking') {
        g.rpm = 180 + Math.random() * 40;
        this.start.soc -= (380 * dt) / 3600 / this.start.ah;
        if (g.t > 2.2) { g.state = 'runup'; g.t = 0; }
      } else if (g.state === 'runup') {
        g.rpm = Math.min(1500 + g.trim * 30, g.rpm + 260 * dt);
        if (g.rpm >= 1495 + g.trim * 30) { g.state = 'running'; g.t = 0; g.phase = Math.random() * 360 - 180; }
      } else if (g.state === 'stopping') {
        g.rpm = Math.max(0, g.rpm - 300 * dt);
        if (g.rpm <= 0) { g.state = 'stopped'; g.trim = 0; }
      } else if (g.state === 'running') {
        g.rpm = 1500 * (1 + g.trim / F0);
      }
      const warm = g.state === 'running' || g.state === 'runup' ? 81 + 6 * (g.kw / g.rated) : 14;
      g.coolant += (warm - g.coolant) * (1 - Math.exp(-dt / (warm > 20 ? 240 : 1800)));
      if (g.state !== 'stopped') g.hours += dt / 3600;
    }

    // --- loads: what each consumer wants now
    const lt = localTime();
    const fd = this.f;
    // steering: idling pump, on load while the rudder moves
    const steerKw = 0.8 + 3.0 * Math.min(1, Math.abs(ctx.rudderRate || 0) / 2.5);
    fd.steer1.demand = steerKw;
    fd.steer2.demand = fd.steer1.running && this.powered('steer1') ? 0.8 + 1.2 * Math.min(1, Math.abs(ctx.rudderRate || 0) / 2.5) : steerKw;
    fd.fans.demand = 5.6;
    fd.sep.demand = 2.4;
    // fish hold: heat leaks in, the compressor cuts in at -0.5 and out at -2.2
    const fridgeP = this.powered('fridge');
    this.holdT += dt * (0.0011 - (this.fridgeOn && fridgeP ? 0.0042 : 0));
    if (this.holdT > -0.5) this.fridgeOn = true;
    if (this.holdT < -2.2) this.fridgeOn = false;
    fd.fridge.demand = this.fridgeOn ? 10.2 : 0.3;
    fd.hyd.demand = (this.hydWork ? 34 : 8.5) + (this.windlass || 0);   // winches hauling or idling, the windlass heaving
    // bilge: a little water always finds its way in; float switch
    this.bilge += dt * (0.00025 - (this.bilgeOn && this.powered('bilge') ? 0.0035 : 0));
    this.bilge = Math.max(0, Math.min(1, this.bilge));
    if (this.bilge > 0.7) this.bilgeOn = true;
    if (this.bilge < 0.12) this.bilgeOn = false;
    fd.bilge.demand = this.bilgeOn ? 4.8 : 0;
    // fresh water: short runs when someone opens a tap
    this.fwT -= dt;
    if (this.fwT < -200 - Math.random() * 300) this.fwT = 30 + Math.random() * 40;
    fd.fw.demand = this.fwT > 0 ? 1.0 : 0;
    // working air: the whistle draws it down, the compressor cuts in at 7.5
    // bar and out at 9; a little always leaks away
    const compP = this.powered('comp');
    this.air = Math.max(0, Math.min(9.2, this.air + dt * ((this.compOn && compP ? 0.045 : 0) - this.airUse - 0.0004)));
    if (this.air < 7.5) this.compOn = true;
    if (this.air > 9.0) this.compOn = false;
    fd.comp.demand = this.compOn ? 3.6 : 0.05;
    // heating: the cabins lose heat to the 3 deg C outside; thermostat 21 deg
    const heatP = this.powered('heat');
    this.cabinT += dt * ((this.heatOn && heatP ? 9 * 0.00042 : 0) - (this.cabinT - this.outT) / 7200);
    if (this.cabinT < 20.4) this.heatOn = true;
    if (this.cabinT > 21.6) this.heatOn = false;
    fd.heat.demand = this.heatOn ? 9 : 0;
    // hot water: heats in spells
    this.hotw -= dt;
    if (this.hotw < -600 - Math.random() * 600) this.hotw = 240 + Math.random() * 300;
    fd.hotw.demand = this.hotw > 0 ? 3 : 0;
    // galley: the cook works before breakfast, lunch and supper (local time);
    // a kettle or the coffee machine in between
    const h = lt.hours;
    const cooking = (h > 5.6 && h < 7.2) || (h > 10.9 && h < 12.4) || (h > 16.6 && h < 18.2);
    this.galleyT -= dt;
    if (this.galleyT <= 0) {
      this.galleyT = 20 + Math.random() * 90;
      this.galleyKw = cooking ? 2 + Math.random() * 5.5 : 0;
      if (!cooking && Math.random() < 0.08) this.kettle = 180;
    }
    this.kettle -= dt;
    fd.galley.demand = this.galleyKw + (this.kettle > 0 ? 2 : 0);
    fd.light.demand = 1.1;
    fd.floods.demand = this.ext.floods;
    fd.search.demand = this.ext.search;
    // the UPS: electronics, plus recharging its battery
    fd.nav.demand = this.ext.nav + (this.ups.soc < 0.999 ? 0.35 : 0);
    // chargers: what the batteries take
    const chA = this._chargerAmps();
    fd.charge.demand = 0.05 + (chA * 28) / 1000 / 0.85;

    // --- motors: starting currents; restart after a blackout in sequence
    for (const f of this.feeders) {
      if (f.motor && f.on && !f.running && !f.shed && f.auto && this.live && f.restartAt > 0 && this.time >= f.restartAt) {
        f.restartAt = 0;
        this._startMotor(f);
      }
      if (f.inrush > 0) f.inrush -= dt;
    }

    // --- the bus
    const conn = this.busy;
    const wasLive = this.live;
    this.live = conn.length > 0;
    let P = 0, inrush = 0;
    if (this.live) {
      for (const f of this.feeders) {
        if (!f.on || f.shed || (f.motor && !f.running)) continue;
        P += f.demand;
        // starting current: direct on line about 5 x, the big hydraulic
        // pump motor through a soft starter about 2 x
        if (f.inrush > 0) inrush += f.kw * (f.id === 'hyd' ? 1.0 : 4.0) * (f.inrush / 1.2);
      }
    }
    const rated = conn.reduce((s, g) => s + g.rated, 0) || 1;
    // governor and AVR: a step in load pulls the frequency down, recovering
    // in a couple of seconds; beyond full load the engines cannot hold speed
    const dP = P - this.lastKw;
    this.lastKw = P;
    if (this.live) this.fDip -= (dP / rated) * 2.2;
    this.fDip *= Math.exp(-dt / 1.4);
    this.vDip *= Math.exp(-dt / 0.5);
    const kva = rated / KVA_PF;
    const inF = this.live ? (inrush / kva) * 1.6 : 0;      // while a motor runs up
    const inV = this.live ? (inrush / kva) * 28 : 0;
    this.load = P / rated;
    const sag = Math.max(0, this.load - 1) * 22;
    const trim = conn.length ? conn.reduce((s, g) => s + g.trim, 0) / conn.length : 0;
    this.busF = this.live ? F0 + trim + this.fDip - sag - inF : 0;
    this.busV = this.live ? Math.max(0, V0 - this.vDip - sag * 4 - inV) : 0;
    this.kw = this.live ? P : 0;
    for (const g of this.gens) {
      g.kw = g.breaker && g.ready ? P / conn.length : 0;
      g.fuel = g.state === 'running' || g.state === 'runup' ? 2.2 + 0.24 * g.kw : 0;
    }

    // --- protection: preferential trip, overload trip, under-frequency
    if (this.live && this.load > 1.0) this.prefT += dt; else this.prefT = Math.max(0, this.prefT - dt);
    if (this.prefT > 5) {
      let shed = false;
      for (const f of this.feeders) if (!f.ess && f.on && !f.shed && (f.running || !f.motor)) { f.shed = true; f.running = false; shed = true; }
      if (shed) A.set('pref', true, 'Перегрузка генератора: отключены неответственные потребители', 'alarm');
      this.prefT = 0;
    }
    if (this.live && this.load > 1.15) this.overT += dt; else this.overT = 0;
    if (this.live && this.busF < 46) this.lowFT += dt; else this.lowFT = 0;
    if (this.overT > 8 || this.lowFT > 1.5) {
      for (const g of conn) { g.breaker = false; g.msg = this.overT > 8 ? 'отключён защитой: перегрузка' : 'отключён защитой: низкая частота'; }
      A.set('gtrip', true, 'Генератор отключён защитой', 'alarm');
      this.overT = 0; this.lowFT = 0;
    }

    // --- blackout and recovery
    if (wasLive && !this.live) {
      this.blackouts++;
      for (const f of this.feeders) if (f.motor) f.running = false;
    }
    if (!wasLive && this.live) {
      // staggered restart of the auto-restart motors
      let k = 1;
      for (const f of this.feeders) if (f.motor && f.on && f.auto && !f.shed) f.restartAt = this.time + 1 + 2.5 * k++;
    }
    if (!this.live) this.deadT += dt; else this.deadT = 0;
    if (this.live && this.load > 0.85 && conn.length === 1) this.highT += dt; else this.highT = 0;
    // standby generator on AUTO
    for (const g of this.gens) {
      if (g.mode !== 'auto') continue;
      const need = (!this.live && this.deadT > 1.5) || this.highT > 20;
      if (need && g.state === 'stopped') { this.startGen(g.id); g.msg = this.live ? 'автопуск: высокая нагрузка' : 'автопуск: обесточивание'; }
      if (g.ready && !g.breaker && (need || g.msg.startsWith('автопуск'))) {
        if (!this.busy.length) this.closeBreaker(g.id);
        else g.sync = true;
      }
    }
    // synchroscope and the auto-synchroniser
    for (const g of this.gens) {
      if (g.ready && !g.breaker && this.live) {
        if (g.sync) {
          const want = trim + 0.08;
          g.trim += Math.max(-0.4 * dt, Math.min(0.4 * dt, want - g.trim));
          if (Math.abs(g.phase) < 5 && Math.abs(g.f - this.busF) < 0.2) { this.closeBreaker(g.id); g.sync = false; if (g.breaker) g.msg = 'синхронизирован, на шинах'; }
        }
        g.phase = ((g.phase + (g.f - this.busF) * 360 * dt + 540) % 360) - 180;
      } else if (g.breaker) {
        g.phase = 0;
      }
    }

    // --- 24 V batteries
    const V = this.house.V;
    const loadA = this.dcW / Math.max(18, V);
    const altA = ctx.meRunning ? 80 : 0;
    const chHouse = this.powered('charge') ? Math.min(60, this._taper(this.house.soc) * 60) : 0;
    const chStart = this.powered('charge') ? Math.min(20, this._taper(this.start.soc) * 20) : 0;
    const altHouse = Math.min(altA, this._taper(this.house.soc) * 80);
    const altStart = Math.min(Math.max(0, altA - altHouse), this._taper(this.start.soc) * 30);
    const netH = chHouse + altHouse - loadA;
    this.house.soc = Math.max(0, Math.min(1, this.house.soc + (netH * dt) / 3600 / this.house.ah));
    this.house.I = netH;
    this.house.V = this._volts(this.house.soc, netH);
    this.start.soc = Math.max(0, Math.min(1, this.start.soc + ((chStart + altStart) * dt) / 3600 / this.start.ah));
    const cranking = this.gens.some((g) => g.state === 'cranking');
    this.start.V = cranking ? this._volts(this.start.soc, -380) : this._volts(this.start.soc, chStart + altStart);
    this.dcOk = this.house.V > 20.5;
    this._chA = chHouse + chStart;

    // --- UPS
    const navIn = this.powered('nav');
    this.ups.onBattery = !navIn;
    if (navIn) this.ups.soc = Math.min(1, this.ups.soc + (0.35 * dt) / 3600 / this.ups.kwh);
    else this.ups.soc = Math.max(0, this.ups.soc - (this.ext.nav * dt) / 3600 / this.ups.kwh / 0.9);
    this.upsOk = navIn || this.ups.soc > 0.01;

    // --- fuel
    const dgFuel = this.gens.reduce((s, g) => s + g.fuel, 0);
    this.fuel = Math.max(0, this.fuel - ((dgFuel + (ctx.meFuel || 0)) * dt) / 3600);
    this.fuelRate = dgFuel;

    // --- alarms
    A.set('blackout', !this.live, 'Обесточивание главных шин (блэкаут)', 'alarm');
    if (this.live) A.set('gtrip', false);
    A.set('overload', this.live && this.load > 0.95, `Нагрузка генераторов ${Math.round(this.load * 100)} %`, 'warn');
    if (!this.feeders.some((f) => f.shed)) A.set('pref', false);
    A.set('ups', this.ups.onBattery, `ИБП навигации от батареи: ${Math.round(this.ups.soc * 100)} %`, 'warn');
    A.set('dclow', this.house.V < 23.0, `Низкое напряжение 24 В: ${this.house.V.toFixed(1)} В`, 'alarm');
    A.set('steer', !this.powered('steer1') && !this.powered('steer2'), 'Рулевая машина: насосы не работают', 'alarm');
    A.set('bilge', this.bilge > 0.85, 'Высокий уровень льяльных вод', 'alarm');
    A.set('hold', this.holdT > 3, `Температура трюма ${this.holdT.toFixed(1)} °C`, 'warn');
    A.set('air', this.air < 5, `Низкое давление рабочего воздуха: ${this.air.toFixed(1)} бар`, 'warn');
    for (const g of this.gens) A.set(`gstart${g.id}`, g.msg.startsWith('не проворачивается'), `${g.name}: ${g.msg}`, 'alarm');
  }

  _taper(soc) { return Math.max(0, Math.min(1, (1 - soc) * 7)); }
  _volts(soc, netA) {
    const voc = 23.2 + 2.3 * soc;
    if (netA > 0) return Math.min(28.4, voc + 0.4 + netA * 0.024);
    return Math.max(0, voc + netA * 0.012);
  }
  _chargerAmps() { return this._chA || 0; }

  get steeringPumps() { return (this.powered('steer1') ? 1 : 0) + (this.powered('steer2') ? 1 : 0); }
}
