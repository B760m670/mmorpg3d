// The whistle control on the bridge: the air horn on the wheelhouse roof is
// opened by a 24 V solenoid valve and blown by working air from the
// compressor's receiver (Electrical.js keeps the pressure). Hold it for as
// long as you like, give a manoeuvring signal, or let the fog-signal timer
// sound the signal for your situation every two minutes.
//
// COLREG / МППСС: a short blast is about 1 s, a prolonged blast 4-6 s.
//   Rule 34 (in sight of one another): one short — altering course to
//   starboard; two short — to port; three short — operating astern
//   propulsion; five short — doubt about the other's intentions; one
//   prolonged — approaching a bend where others may be hidden.
//   Rule 35 (restricted visibility), at intervals of not more than 2 min:
//   power-driven vessel making way — one prolonged; underway but stopped —
//   two prolonged; fishing, not under command, restricted in her ability to
//   manoeuvre — one prolonged followed by two short.

const SHORT = 1.0, LONG = 5.0, GAP = 1.1;

export const SIGNALS = {
  s1: { name: '1 короткий', meaning: 'Изменяю курс вправо (правило 34)', seq: [SHORT] },
  s2: { name: '2 коротких', meaning: 'Изменяю курс влево', seq: [SHORT, SHORT] },
  s3: { name: '3 коротких', meaning: 'Мои движители работают на задний ход', seq: [SHORT, SHORT, SHORT] },
  s5: { name: '5 коротких', meaning: 'Не понимаю ваших намерений / сомневаюсь в ваших действиях', seq: [SHORT, SHORT, SHORT, SHORT, SHORT] },
  p1: { name: 'Продолжительный', meaning: 'Подхожу к изгибу фарватера, где не видно других судов', seq: [LONG] },
};

export const FOG = {
  off: { name: 'Выкл.', meaning: 'Туманные сигналы не подаются' },
  way: { name: 'На ходу, имея ход', meaning: 'Правило 35(a): один продолжительный не реже чем через 2 мин', seq: [LONG] },
  noway: { name: 'На ходу без хода', meaning: 'Правило 35(b): два продолжительных с промежутком около 2 с, через 2 мин', seq: [LONG, LONG] },
  fishing: { name: 'Лов, НУС, ограничено', meaning: 'Правило 35(c): один продолжительный и два коротких, через 2 мин', seq: [LONG, SHORT, SHORT] },
};

export class Whistle {
  constructor(elec) {
    this.elec = elec;
    this.queue = [];          // [{ on: bool, t: s }]
    this.fog = 'off';
    this.fogT = 0;
    this.panelHeld = false;
    this.open = false;
    this.last = '';
  }

  play(id) {
    const s = SIGNALS[id] || FOG[id];
    if (!s || !s.seq) return;
    this.queue = [];
    s.seq.forEach((d, i) => {
      if (i) this.queue.push({ on: false, t: id === 'noway' ? 2.0 : GAP });
      this.queue.push({ on: true, t: d });
    });
    this.last = s.name;
  }

  setFog(id) {
    this.fog = id;
    this.fogT = 0.5;              // first signal at once
  }

  // held: someone has the whistle button down
  update(dt, held) {
    let want = held || this.panelHeld;
    if (this.queue.length) {
      const q = this.queue[0];
      q.t -= dt;
      if (q.on) want = true;
      if (q.t <= 0) this.queue.shift();
    }
    if (this.fog !== 'off') {
      this.fogT -= dt;
      if (this.fogT <= 0 && !this.queue.length) {
        this.play(this.fog);
        this.fogT = 110;          // within the 2 minutes
      }
    }
    const E = this.elec;
    this.wanted = want;
    this.open = want && E.dcOk && E.air > 1.5;
    E.airUse = this.open ? 0.11 : 0;      // bar/s out of the receiver
  }

  get pressure() { return this.elec.air; }
}
