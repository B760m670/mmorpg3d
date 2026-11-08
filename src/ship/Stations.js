import * as THREE from 'three';
import { P, PLACES } from './ShipAccess.js';
import { SPECIES, HOLD_CAP } from './Trawl.js';

// The spaces below made to work: what each machine and fitting shows when
// you come to it (read from the ship's systems), what you can do there (E),
// and the gauges and fittings that show it:
//   engine room - main engine local readings and start/stop, each generator,
//     the hydraulic power pack, the air compressor and receiver with its
//     gauge, the bilge pump, the day tank with a real level in its sight
//     glass (it is refilled from the main tanks by the transfer pump);
//   steering flat - rudder angle on the indicator, the standby pump, and the
//     emergency tiller: steer by hand from here when both pumps are gone;
//   fishroom - temperature, the catch by species, boxes that fill the pens
//     as the catch comes down;
//   galley, mess, washroom - cook, make coffee, the television, a shower:
//     each draws its power and hot water from the ship's systems.

const fmt = (n) => Math.round(n).toLocaleString('ru-RU');

// new places (the others are in ShipAccess.PLACES and get live readings here)
const MORE = [
  { id: 'dg1', name: 'Дизель-генератор 1', p: P(2.7, 5.0, -0.8), r: 1.3, text: '64 кВт, 1500 об/мин.' },
  { id: 'dg2', name: 'Дизель-генератор 2', p: P(2.7, 7.0, -0.8), r: 1.3, text: '64 кВт, 1500 об/мин.' },
  { id: 'hydpack', name: 'Гидростанция', p: P(0, 8.15, -0.65), r: 1.2, text: 'электронасос 37 кВт: лебёдки, барабаны, брашпиль, кран.' },
  { id: 'air', name: 'Компрессор и ресивер', p: P(1.45, 9.0, -0.75), r: 1.2, text: 'рабочий воздух 7,5–9 бар: тифон, пневматика.' },
  { id: 'bilge', name: 'Осушительный насос', p: P(0.95, 3.6, -1.15), r: 1.2, text: 'откачивает льяльные воды; включается по поплавку.' },
  { id: 'coffee', name: 'Кофеварка', p: P(3.0, 16.1, 3.25), r: 1.0, text: 'чайник и кофе: около 2 кВт, пока греется.' },
  { id: 'tv', name: 'Телевизор', p: P(-1.0, 16.5, 4.0), r: 1.6, text: 'спутниковое ТВ с антенны на крыше рубки.' },
  { id: 'shower', name: 'Душ', p: P(3.0, 12.38, 2.6), r: 1.0, text: 'горячая вода из бойлера 3 кВт.' },
];

export class Stations {
  constructor(ctx) {
    this.c = ctx;               // { elec, sensors, boat, trawl, sound, input }
    this.places = PLACES;
    for (const m of MORE) if (!PLACES.find((q) => q.id === m.id)) PLACES.push(m);
    const gs = PLACES.findIndex((q) => q.id === 'gensets');
    if (gs >= 0) PLACES.splice(gs, 1);
    this.day = { l: 980, cap: 1200, pump: false };   // day tank, litres
    this.tv = false;
    this.emergency = false;     // steering by the emergency tiller
    this.cooking = 0;
    this.t = 0;
    this.byId = (id) => PLACES.find((q) => q.id === id);
    this.wire();
  }

  // live readings and actions for each place
  wire() {
    const { elec: E, sensors: S, boat: B, trawl: T } = this.c;
    const set = (id, live, act) => { const p = this.byId(id); if (p) { p.live = live; p.act = act; } };
    const gen = (i) => () => {
      const g = E.gens[i];
      const st = { running: g.breaker ? 'на шинах' : 'работает', cranking: 'проворачивается', runup: 'разгоняется', stopping: 'останавливается', stopped: g.mode === 'auto' ? 'стоит, резерв АВТО' : 'стоит' }[g.state];
      return `${st}${g.state === 'running' ? ` · ${g.kw.toFixed(1)} кВт · ${g.f.toFixed(1)} Гц` : ''} · вода ${g.coolant.toFixed(0)} °C`;
    };
    const genAct = (i) => ({ label: () => (E.gens[i].state === 'stopped' ? 'пуск с местного поста' : 'стоп'), run: () => (E.gens[i].state === 'stopped' ? E.startGen(i) : E.stopGen(i)) });
    set('dg1', gen(0), genAct(0));
    set('dg2', gen(1), genAct(1));
    set('engine', () => {
      const m = S.me;
      return m.state === 'running' ? `работает · ${Math.round(m.rpm)} об/мин · масло ${m.oil.toFixed(1)} бар · вода ${m.cool.toFixed(0)} °C · ${m.fuel.toFixed(0)} л/ч` : m.state === 'cranking' ? 'пуск…' : `стоит · вода ${m.cool.toFixed(0)} °C`;
    }, { label: () => (S.me.state === 'stopped' ? 'пуск ГД с местного поста' : S.me.state === 'running' ? 'стоп ГД' : null), run: () => (S.me.state === 'stopped' ? S.startME() : S.stopME()) });
    set('msb', () => (E.live ? `шины ${E.busV.toFixed(0)} В · ${E.busF.toFixed(2)} Гц · ${E.kw.toFixed(1)} кВт (${Math.round(E.load * 100)} %)` : 'ШИНЫ ОБЕСТОЧЕНЫ'), null);
    set('hydpack', () => (E.powered('hyd') ? (E.hydWork ? 'работает под нагрузкой' : 'работает вхолостую') : E.f.hyd.on ? 'стоп (нужен пуск)' : 'выключена'),
      { label: () => (E.powered('hyd') ? 'стоп' : 'пуск'), run: () => E.toggleFeeder('hyd') });
    set('air', () => `ресивер ${E.air.toFixed(1)} бар · компрессор ${!E.powered('comp') ? 'без питания' : E.compOn ? 'качает' : 'стоит'}`, null);
    set('bilge', () => `льяла ${Math.round(E.bilge * 100)} % · насос ${E.bilgeOn && E.powered('bilge') ? 'качает' : 'стоит'}`,
      { label: () => (E.bilgeOn ? null : 'откачать вручную'), run: () => { E.bilgeOn = true; } });
    set('daytank', () => `${Math.round((this.day.l / this.day.cap) * 100)} % (${fmt(this.day.l)} из ${fmt(this.day.cap)} л) · в танках ${fmt(E.fuel)} л · перекачка ${this.day.pump ? 'идёт' : 'стоит'}`, null);
    set('steering', () => `руль ${Math.abs(B.rudder).toFixed(1)}° ${B.rudder > 0.3 ? 'лево' : B.rudder < -0.3 ? 'право' : ''} · насос 1 ${E.powered('steer1') ? 'работает' : 'стоит'} · насос 2 ${E.powered('steer2') ? 'работает' : 'стоит'}`, null);
    set('ppack', () => `насос 1 ${E.powered('steer1') ? 'работает' : 'стоит'} · насос 2 ${E.powered('steer2') ? 'работает' : 'резерв'}`,
      { label: () => (E.f.steer2.on ? 'насос 2: стоп' : 'насос 2: пуск'), run: () => E.toggleFeeder('steer2') });
    set('emtiller', () => (this.emergency ? `РУЛЬ ВРУЧНУЮ: ${Math.abs(B.rudder).toFixed(0)}° · влево/вправо — перекладка, E — оставить` : B.steeringPumps ? 'пока работает гидравлика, он не нужен' : 'насосы руля стоят — правьте отсюда'),
      { label: () => (this.emergency ? 'оставить румпель' : 'взять аварийный румпель'), run: () => { this.emergency = !this.emergency; } });
    set('hold', () => {
      const by = Object.entries(T.hold).filter(([, kg]) => kg > 0.5).map(([s, kg]) => `${SPECIES[s].name.toLowerCase()} ${fmt(kg)}`).join(', ');
      return `${E.holdT.toFixed(1)} °C · ${fmt(T.holdKg)} из ${fmt(HOLD_CAP)} кг${by ? ': ' + by : ''}`;
    }, null);
    set('icemaker', () => (E.powered('fridge') ? 'работает' : 'без питания (автомат «Холодильник трюма»)'), null);
    set('factory', () => (T.processT > 0 ? `идёт обработка улова: ${fmt(T.processKg)} кг, ещё ~${Math.ceil(T.processT / 60)} мин — бункер, потрошение, мойка, лоток в трюм` : 'конвейеры стоят: улова нет'), null);
    set('washer', () => (T.processT > 0 ? 'работает' : 'стоит'), null);
    for (const id of ['cabin1', 'cabin2', 'cabin3', 'cabin4']) set(id, null, { label: () => (this.resting ? null : 'лечь отдохнуть'), run: () => this.rest() });
    set('galley', () => (this.cooking > 0 ? `плита включена, ещё ${Math.ceil(this.cooking / 60)} мин` : 'плита выключена'),
      { label: () => (this.cooking > 0 ? 'выключить плиту' : 'приготовить еду (≈20 мин)'), run: () => { this.cooking = this.cooking > 0 ? 0 : 1200; } });
    set('coffee', () => (E.kettle > 0 ? 'греется' : ''), { label: () => (E.kettle > 0 ? null : 'сварить кофе'), run: () => { E.kettle = 180; } });
    set('tv', () => (this.tv ? (E.powered('light') ? 'включён' : 'нет питания') : 'выключен'), { label: () => (this.tv ? 'выключить' : 'включить'), run: () => { this.tv = !this.tv; } });
    set('shower', () => (E.hotw > 0 ? 'бойлер греет' : ''), { label: () => 'принять душ', run: () => { E.hotw = Math.max(E.hotw, 420); } });
  }

  // a short rest in a bunk: the screen goes dark and comes back
  rest() {
    if (this.resting) return;
    this.resting = true;
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;inset:0;background:#000;opacity:0;transition:opacity 1.2s ease;z-index:30;display:flex;align-items:center;justify-content:center;color:#cfd8de;font:15px system-ui,sans-serif';
    el.textContent = 'отдыхаете… качка, гул машины за переборкой';
    document.body.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; });
    setTimeout(() => { el.style.opacity = '0'; }, 3600);
    setTimeout(() => { el.remove(); this.resting = false; }, 5000);
  }

  // gauges, the receiver, the sight glass, the fish boxes, the TV picture
  attach(model) {
    this.model = model;
    const steel = new THREE.MeshStandardMaterial({ color: 0x6f7a80, roughness: 0.5, metalness: 0.4 });
    const green = new THREE.MeshStandardMaterial({ color: 0x3f6b4a, roughness: 0.55 });
    const red = new THREE.MeshStandardMaterial({ color: 0xa8281e, roughness: 0.5 });
    // air receiver (vertical, 250 l) and the compressor beside it
    const rec = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 1.25, 16), green);
    rec.position.copy(P(1.6, 9.0, -1.4 + 0.7));
    model.add(rec);
    const cmp = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.4, 0.5), steel);
    cmp.position.copy(P(1.05, 9.0, -1.4 + 0.2));
    model.add(cmp);
    this.airGauge = this.dial(model, P(1.6, 8.71, -0.35), 0, 0.16, 'бар');
    // bilge pump
    const bp = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.45), red);
    bp.position.copy(P(0.95, 3.6, -1.25));
    model.add(bp);
    // rudder angle indicator on the steering flat's aft bulkhead (faces forward)
    this.rudderDial = this.dial(model, P(0, 0.53, 1.5), Math.PI, 0.27, 'руль');
    // day tank sight glass: the fuel column
    const col = new THREE.MeshBasicMaterial({ color: 0xb58a2a });
    this.fuelCol = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 1), col);
    this.fuelCol.rotation.y = -Math.PI / 2;
    model.add(this.fuelCol);
    // the escape scuttle from the cabin corridor: hatch in the deckhead
    const hatch = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.62), new THREE.MeshBasicMaterial({ color: 0x111417 }));
    hatch.rotation.x = Math.PI / 2;
    hatch.position.copy(P(0, 19.0, 4.97));
    model.add(hatch);
    // TV picture
    this.tvCanvas = document.createElement('canvas');
    this.tvCanvas.width = 128; this.tvCanvas.height = 72;
    this.tvTex = new THREE.CanvasTexture(this.tvCanvas);
    this.tvTex.colorSpace = THREE.SRGBColorSpace;
    this.tvMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.66, 0.37), new THREE.MeshBasicMaterial({ map: this.tvTex, toneMapped: false }));
    this.tvMesh.position.copy(P(-1.0, 16.497, 4.0));
    this.tvMesh.visible = false;
    model.add(this.tvMesh);
    // fish boxes in the fishroom pens, filling with the catch
    const slots = [];
    const fixed = [[-1.6, 12.4], [-2.4, 12.4], [-1.6, 12.95], [1.6, 13.9], [2.4, 13.9], [1.6, 14.45], [-1.5, 15.5], [1.5, 15.6]];
    for (const s of [12.2, 12.75, 13.7, 14.25, 15.2, 15.75]) {
      for (const x of [-1.85, -1.05, 1.05, 1.85]) {
        if (fixed.some(([fx, fs]) => Math.abs(fx - x) < 0.6 && Math.abs(fs - s) < 0.5)) continue;
        for (let k = 0; k < 6; k++) slots.push([x, s, k]);
      }
    }
    slots.sort((a, b) => a[2] - b[2]);       // fill the bottom layer first
    this.slots = slots;
    const boxMat = new THREE.MeshStandardMaterial({ color: 0x2f62a8, roughness: 0.6 });
    this.boxes = new THREE.InstancedMesh(new THREE.BoxGeometry(0.74, 0.25, 0.5), boxMat, slots.length);
    const m4 = new THREE.Matrix4();
    slots.forEach(([x, s, k], i) => { m4.makeTranslation(x, -1.5 + 0.13 + k * 0.26, 11.975 - s); this.boxes.setMatrixAt(i, m4); });
    this.boxes.count = 0;
    model.add(this.boxes);
    // fish on the conveyors while a catch is worked: hopper -> sorting
    // conveyor aft -> gutting conveyor forward -> lift -> washer
    const path = [P(0.6, 8.15, 3.15), P(1.2, 8.4, 3.02), P(1.2, 4.7, 3.02), P(2.05, 4.65, 3.02), P(2.05, 8.0, 3.02), P(2.05, 8.6, 3.55), P(2.05, 9.3, 3.35)];
    this.fpath = path;
    this.flen = [0];
    for (let i = 1; i < path.length; i++) this.flen.push(this.flen[i - 1] + path[i].distanceTo(path[i - 1]));
    const fishG = new THREE.SphereGeometry(1, 10, 6);
    fishG.scale(0.05, 0.045, 0.22);
    this.fish = new THREE.InstancedMesh(fishG, new THREE.MeshStandardMaterial({ color: 0x8d8a76, roughness: 0.35, metalness: 0.1 }), 40);
    this.fish.count = 0;
    this.fish.frustumCulled = false;
    model.add(this.fish);
    this.fishT = 0;
    // doors: they swing open as someone comes to them and close behind
    this.doors = [];
    const wood = new THREE.MeshStandardMaterial({ color: 0xa47f55, roughness: 0.6 });
    const white = new THREE.MeshStandardMaterial({ color: 0xe6e4de, roughness: 0.5 });
    const knob = new THREE.MeshStandardMaterial({ color: 0xc9c9c9, metalness: 0.7, roughness: 0.3 });
    const door = (kind, at, a0, a1, h, swing, mat) => {
      const w = Math.abs(a1 - a0);
      const hinge = new THREE.Group();
      const leaf = new THREE.Mesh(new THREE.BoxGeometry(kind === 'bh' ? w - 0.02 : 0.04, h - 0.02, kind === 'bh' ? 0.04 : w - 0.02), mat);
      const handle = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.03, 0.03), knob);
      if (kind === 'bh') {          // in a transverse bulkhead at station at, from x a0 to a1
        hinge.position.copy(P(a0, at, 2.15));
        leaf.position.set(w / 2, h / 2, 0);
        handle.position.set(w - 0.1, 1.0, 0);
        handle.scale.set(1, 1, 3.5);
      } else {                      // in a fore-and-aft wall at x at, from station a0 to a1
        hinge.position.copy(P(at, a0, 2.15));
        leaf.position.set(0, h / 2, -w / 2);
        handle.position.set(0, 1.0, -w + 0.1);
        handle.scale.set(3.5, 1, 1);
      }
      hinge.add(leaf, handle);
      model.add(hinge);
      const c = kind === 'bh' ? P((a0 + a1) / 2, at, 2.15) : P(at, (a0 + a1) / 2, 2.15);
      this.doors.push({ hinge, kind, swing, c, ang: 0 });
    };
    door('bh', 11.4, -1.4, -0.55, 1.9, -1, white);       // fish handling <-> changing room
    door('bh', 12.8, -0.45, 0.45, 1.95, 1, wood);        // changing room <-> galley and mess
    door('bh', 16.6, -0.5, 0.5, 1.95, 1, wood);          // mess <-> cabin corridor
    for (const sd of [1, -1]) {
      door('wall', sd * 0.5, 17.4, 18.1, 1.95, sd, wood);  // cabins
      door('wall', sd * 0.5, 18.75, 19.45, 1.95, sd, wood);
    }
    door('wall', 1.8, 11.95, 12.65, 1.95, 1, white);     // washroom
  }

  dial(model, pos, yaw, r, label) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.CircleGeometry(r, 32), new THREE.MeshBasicMaterial({ map: tex }));
    m.position.copy(pos);
    m.rotation.y = yaw;
    model.add(m);
    return { cv, tex, label, last: null };
  }

  drawDial(d, frac, text, sym = false) {
    const key = `${frac.toFixed(3)}|${text}`;
    if (key === d.last) return;
    d.last = key;
    const g = d.cv.getContext('2d');
    g.fillStyle = '#f2f0ea'; g.beginPath(); g.arc(64, 64, 62, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#222'; g.lineWidth = 3; g.stroke();
    const a0 = sym ? -Math.PI * 0.85 : Math.PI * 0.75, span = sym ? Math.PI * 0.7 : Math.PI * 1.5;
    g.lineWidth = 2;
    for (let i = 0; i <= 10; i++) {
      const a = a0 + (span * i) / 10;
      g.beginPath(); g.moveTo(64 + Math.cos(a) * 50, 64 + Math.sin(a) * 50); g.lineTo(64 + Math.cos(a) * 58, 64 + Math.sin(a) * 58); g.stroke();
    }
    const a = a0 + span * frac;
    g.strokeStyle = '#b8261b'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(64, 64); g.lineTo(64 + Math.cos(a) * 52, 64 + Math.sin(a) * 52); g.stroke();
    g.fillStyle = '#222'; g.font = 'bold 16px sans-serif'; g.textAlign = 'center';
    g.fillText(text, 64, 100); g.font = '12px sans-serif'; g.fillText(d.label, 64, 40);
    d.tex.needsUpdate = true;
  }

  update(dt, st) {
    const { elec: E, sensors: S, boat: B, trawl: T } = this.c;
    // day tank: the engines draw from it; the transfer pump tops it up from
    // the main tanks between 60 and 95 %
    const use = (E.fuelRate + (S.me.fuel || 0)) / 3600 * dt;
    const d = this.day;
    d.l = Math.max(0, d.l - use);
    if (d.l < d.cap * 0.6 && E.fuel > 50) d.pump = true;
    if (d.l > d.cap * 0.95 || E.fuel <= 50) d.pump = false;
    if (d.pump && E.live) d.l = Math.min(d.cap, d.l + (900 / 3600) * dt);
    // cooking: the galley range on the switchboard
    if (this.cooking > 0) { this.cooking -= dt; E.galleyKw = Math.max(E.galleyKw, 6.5); E.galleyT = Math.max(E.galleyT, 2); }
    // emergency tiller: left/right moves the rudder by hand, slowly
    if (this.emergency) {
      if (st.mode !== 'walk' || !this.near(st.pos, 'emtiller', 1.6)) this.emergency = false;
      else {
        B.rudder = THREE.MathUtils.clamp(B.rudder - st.moveX * 2.2 * dt, -35, 35);
        B.wheel = B.rudder;
      }
    }
    // the catch being worked
    if (T.processT > 0) T.processT = Math.max(0, T.processT - dt);
    if (this.fish) {
      const on = T.processT > 0;
      this.fish.count = on ? this.fish.instanceMatrix.count : 0;
      if (on) {
        this.fishT += dt * 0.45;
        const L = this.flen[this.flen.length - 1], n = this.fish.count, m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1);
        const pos = new THREE.Vector3(), dir = new THREE.Vector3();
        for (let i = 0; i < n; i++) {
          const d = (this.fishT + (i * L) / n + Math.sin(i * 12.9) * 0.08) % L;
          let k = 1;
          while (k < this.flen.length - 1 && this.flen[k] < d) k++;
          const f = (d - this.flen[k - 1]) / (this.flen[k] - this.flen[k - 1]);
          pos.lerpVectors(this.fpath[k - 1], this.fpath[k], f);
          dir.subVectors(this.fpath[k], this.fpath[k - 1]).normalize();
          q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
          q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), i * 1.7));
          pos.x += Math.sin(i * 7.3) * 0.12;
          m4.compose(pos, q, sc);
          this.fish.setMatrixAt(i, m4);
        }
        this.fish.instanceMatrix.needsUpdate = true;
      }
    }
    // doors open for whoever comes to them (you, and later the people aboard)
    if (this.doors) {
      const who = [st.pos, ...(st.others || [])];
      for (const d of this.doors) {
        const near = who.some((p) => p && Math.hypot(p.x - d.c.x, p.z - d.c.z) < 1.35 && Math.abs(p.y - d.c.y) < 1.5);
        const want = near ? 1 : 0;
        d.ang += (want - d.ang) * Math.min(1, dt * 3.5);
        const a = d.ang * Math.PI * 0.5;
        d.hinge.rotation.y = d.kind === 'bh' ? a * d.swing : -a * d.swing;
      }
    }
    this.t -= dt;
    if (this.t > 0 || !this.model) return;
    this.t = 0.25;
    if (this.airGauge) this.drawDial(this.airGauge, Math.min(1, E.air / 12), `${E.air.toFixed(1)}`);
    if (this.rudderDial) this.drawDial(this.rudderDial, 0.5 - B.rudder / 70, `${Math.abs(B.rudder).toFixed(0)}° ${B.rudder > 0.5 ? 'Л' : B.rudder < -0.5 ? 'П' : ''}`, true);
    if (this.fuelCol) {
      const h = 1.3 * (d.l / d.cap);
      this.fuelCol.scale.y = Math.max(0.01, h);
      this.fuelCol.position.copy(P(2.505, 8.85, -1.1 + h / 2));
    }
    if (this.boxes) this.boxes.count = Math.min(this.slots.length, Math.ceil((T.holdKg / HOLD_CAP) * this.slots.length));
    this.tvMesh.visible = this.tv && E.powered('light');
    if (this.tvMesh.visible) this.drawTv();
  }

  near(pos, id, r) {
    const p = this.byId(id);
    return p && Math.hypot(pos.x - p.p.x, pos.z - p.p.z) < r && Math.abs(pos.y + 1 - p.p.y) < 2;
  }

  drawTv() {
    const g = this.tvCanvas.getContext('2d');
    const t = performance.now() / 1000;
    const sky = g.createLinearGradient(0, 0, 0, 72);
    sky.addColorStop(0, '#4a76a8'); sky.addColorStop(1, '#a7c7de');
    g.fillStyle = sky; g.fillRect(0, 0, 128, 72);
    g.fillStyle = '#e9eef2'; g.beginPath(); g.ellipse(40 + Math.sin(t * 0.2) * 20, 46, 30, 8, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#1c3550'; g.fillRect(0, 54, 128, 18);
    g.fillStyle = '#fff'; g.font = 'bold 9px sans-serif'; g.fillText('VÆRET  ·  Lofoten', 6, 66);
    g.fillStyle = '#c8102e'; g.fillRect(110, 4, 14, 10); g.fillStyle = '#fff'; g.font = 'bold 7px sans-serif'; g.fillText('TV', 112, 12);
    this.tvTex.needsUpdate = true;
  }
}
