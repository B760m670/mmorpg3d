import { NAV_PRESETS } from '../ship/ShipLights.js';
import { wrap180 } from '../ship/Geo.js';
import { SIGNALS, FOG } from '../ship/Whistle.js';

// Control panels of the ship, as overlays:
//   - the bridge console ("пульт"): navigation lights panel, deck lights and
//     searchlight, wheelhouse lighting, power switches of the bridge
//     equipment, the autopilot and BNWAS, the power plant at a glance (with
//     remote start/stop of the generators and the main engine), the alarm list;
//   - the main switchboard ("ГРЩ") in the engine room: generator panels with
//     meters and synchroscope, breakers, speed trim, standby mode, every
//     consumer breaker with its load, the 24 V system and the UPS.
// Plus an alarm strip at the top of the screen while an alarm is
// unacknowledged.

const CSS = `
#ship-panel { position: fixed; inset: 0; display: none; z-index: 20; background: rgba(2, 6, 9, 0.35); }
#ship-panel .box { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(860px, 96vw);
  max-height: 90vh; display: flex; flex-direction: column; background: rgba(12, 18, 24, 0.94); border: 1px solid rgba(255,255,255,.14);
  border-radius: 12px; color: #dfe8ec; font: 13px/1.35 system-ui, sans-serif; box-shadow: 0 10px 40px rgba(0,0,0,.5); }
#ship-panel .hd { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,.1); flex-wrap: wrap; }
#ship-panel .hd b { font-size: 14px; margin-right: 8px; }
#ship-panel .bd { overflow-y: auto; padding: 10px 12px; -webkit-overflow-scrolling: touch; }
#ship-panel button { font: inherit; color: #eaf2f6; background: #1c2731; border: 1px solid rgba(255,255,255,.16); border-radius: 8px;
  padding: 7px 10px; min-height: 34px; cursor: pointer; }
#ship-panel button.on { background: #1f5a3a; border-color: #4cc27c; }
#ship-panel button.warn { background: #5a3a12; border-color: #ffb02e; }
#ship-panel button.bad { background: #5a1f1a; border-color: #ff6a5a; }
#ship-panel button.tab.sel { background: #2b4d66; border-color: #6fc0ea; }
#ship-panel button.x { margin-left: auto; }
#ship-panel table { width: 100%; border-collapse: collapse; }
#ship-panel td { padding: 5px 6px; border-bottom: 1px solid rgba(255,255,255,.06); vertical-align: middle; }
#ship-panel td.n { color: #9fb6c2; }
#ship-panel .lamp { display: inline-block; width: 12px; height: 12px; border-radius: 6px; background: #333; margin-right: 6px; vertical-align: -1px; }
#ship-panel .lamp.g { background: #3ddc6f; box-shadow: 0 0 6px #3ddc6f; }
#ship-panel .lamp.r { background: #ff4a3a; box-shadow: 0 0 6px #ff4a3a; }
#ship-panel .lamp.y { background: #ffb02e; box-shadow: 0 0 6px #ffb02e; }
#ship-panel .lamp.w { background: #f2f2e8; box-shadow: 0 0 6px #fff; }
#ship-panel .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 10px; }
#ship-panel .card { background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); border-radius: 10px; padding: 9px 10px; }
#ship-panel .card h4 { margin: 0 0 6px; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: #8fb3c4; }
#ship-panel .big { font: 22px ui-monospace, Menlo, monospace; color: #fff; }
#ship-panel .mono { font-family: ui-monospace, Menlo, monospace; font-variant-numeric: tabular-nums; }
#ship-panel .row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin: 4px 0; }
#ship-panel .note { color: #8fa3ad; font-size: 12px; }
#ship-panel .bar { height: 7px; border-radius: 4px; background: #26323e; overflow: hidden; margin-top: 3px; }
#ship-panel .bar i { display: block; height: 100%; background: #4fb4d8; }
#ship-panel .meters { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px 10px; font-family: ui-monospace, Menlo, monospace; }
#ship-panel .meters span { color: #8fa3ad; font-size: 11px; display: block; }
#ship-panel .meters b { font-size: 16px; color: #fff; }
#alarm-bar { position: fixed; top: calc(8px + env(safe-area-inset-top, 0px)); left: 50%; transform: translateX(-50%); z-index: 9;
  display: none; align-items: center; gap: 8px; padding: 6px 8px 6px 12px; border-radius: 10px; max-width: min(620px, 70vw);
  background: rgba(90, 20, 14, 0.88); border: 1px solid #ff6a5a; color: #fff; font: 12.5px/1.3 system-ui, sans-serif; }
#alarm-bar.warn { background: rgba(90, 58, 14, 0.88); border-color: #ffb02e; }
#alarm-bar.blink { animation: abl 0.8s steps(2) infinite; }
@keyframes abl { 50% { filter: brightness(1.5); } }
#alarm-bar button { font: inherit; color: #fff; background: rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.3); border-radius: 7px; padding: 5px 9px; }
body.touch #ship-panel .box { font-size: 12px; }
`;

const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const DEV_ORDER = ['radar', 'plotter', 'conning', 'sounder', 'engmon', 'gps', 'satc', 'log', 'wind', 'ap', 'vhf', 'ais', 'bnwas'];

export class ShipPanels {
  constructor({ elec, sensors, lights, alarms, whistle, actions }) {
    this.E = elec; this.S = sensors; this.L = lights; this.A = alarms; this.W = whistle;
    this.actions = actions || {};
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    this.el = document.createElement('div');
    this.el.id = 'ship-panel';
    this.el.innerHTML = '<div class="box"><div class="hd"></div><div class="bd"></div></div>';
    document.body.appendChild(this.el);
    this.hd = this.el.querySelector('.hd');
    this.bd = this.el.querySelector('.bd');
    this.open = null;
    this.tab = 'nav';
    this.t = 0;
    const act = (e) => {
      // the whistle button: blows while held
      const h = e.target.closest('[data-hold]');
      if (h && this.W) {
        e.preventDefault(); e.stopPropagation();
        this.W.panelHeld = true;
        h.classList.add('warn');
        const up = () => { this.W.panelHeld = false; h.classList.remove('warn'); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
        return;
      }
      const b = e.target.closest('[data-a]');
      if (!b) { if (e.target === this.el) this.hide(); return; }
      e.preventDefault();
      e.stopPropagation();
      this.act(b.dataset.a);
      this.render();
    };
    this.el.addEventListener('pointerdown', act);
    for (const ev of ['pointermove', 'pointerup', 'wheel', 'touchstart', 'touchmove']) this.el.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });

    this.bar = document.createElement('div');
    this.bar.id = 'alarm-bar';
    document.body.appendChild(this.bar);
    this.bar.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const b = e.target.closest('[data-a]');
      if (b) this.act(b.dataset.a);
      else this.show('bridge', 'alarms');
    });
    this.barKey = '';
  }

  get isOpen() { return !!this.open; }

  show(which, tab) {
    this.open = which;
    if (tab) this.tab = tab;
    else if (which === 'bridge' && this.tab === 'msb') this.tab = 'nav';
    this.el.style.display = 'block';
    if (document.pointerLockElement) document.exitPointerLock();
    this.render();
  }

  hide() {
    this.open = null;
    this.el.style.display = 'none';
  }

  act(a) {
    const [k, x, y, z] = a.split(':');
    const E = this.E, S = this.S, L = this.L;
    switch (k) {
      case 'close': this.hide(); break;
      case 'tab': this.tab = x; break;
      case 'nav': L.toggleNav(x); break;
      case 'preset': L.setPreset(x); break;
      case 'flood': L.toggleFlood(x); break;
      case 'search': if (x === 'on') L.search.on = !L.search.on; else if (x === 'aim') L.aimSearch(+y, +z); else if (x === 'cam' && this.actions.aimSearch) this.actions.aimSearch(); break;
      case 'wh': L.wheelhouse = x; break;
      case 'dim': L.dim = Math.max(0.15, Math.min(1, L.dim + +x)); break;
      case 'dev': S.toggle(x); break;
      case 'radartx': S.radarTx = !S.radarTx; break;
      case 'ap': if (x === 'auto') S.apEngage(); else if (x === 'hand') S.apHand('ручное управление'); else S.apAdjust(+x); break;
      case 'bnwas': S.bnwasReset(); break;
      case 'me': if (x === 'start') S.startME(); else S.stopME(); break;
      case 'gen': {
        const i = +y;
        if (x === 'start') E.startGen(i);
        else if (x === 'stop') E.stopGen(i);
        else if (x === 'close') E.closeBreaker(i);
        else if (x === 'open') E.openBreaker(i);
        else if (x === 'sync') E.autoSync(i);
        else if (x === 'up') E.trimSpeed(i, 0.1);
        else if (x === 'down') E.trimSpeed(i, -0.1);
        else if (x === 'mode') E.setMode(i, E.gens[i].mode === 'auto' ? 'man' : 'auto');
        break;
      }
      case 'feeder': E.toggleFeeder(x); break;
      case 'hydwork': E.hydWork = !E.hydWork; break;
      case 'sig': this.W.play(x); this.S.bnwasReset(); break;
      case 'fog': this.W.setFog(x); break;
      case 'ack': this.A.ack(x); if (x.startsWith('bnwas')) S.bnwasReset(); break;
      case 'ackall': this.A.ackAll(); S.bnwasReset(); break;
      default:
    }
  }

  update(dt) {
    // alarm strip
    const top = this.A.sorted()[0];
    const un = this.A.unacked;
    const bn = this.S.bnwas.stage;
    const key = top && un ? `${top.id}|${top.text}|${un}|${bn}` : bn ? `bn${bn}` : '';
    if (key !== this.barKey) {
      this.barKey = key;
      if (!key) this.bar.style.display = 'none';
      else {
        this.bar.style.display = 'flex';
        const warn = top && top.sev !== 'alarm' && !bn;
        this.bar.className = `${warn ? 'warn' : ''} blink`;
        const txt = bn && (!top || top.id !== 'bnwas') ? 'BNWAS: подтвердите бодрствование вахты' : top.text;
        this.bar.innerHTML = `<span>⚠ ${txt}${un > 1 ? ` <small>(+${un - 1})</small>` : ''}</span><button data-a="ackall">квитировать</button>`;
      }
    }
    if (!this.open) return;
    this.t -= dt;
    if (this.t > 0) return;
    this.t = 0.3;
    this.render();
  }

  render() {
    if (!this.open) return;
    const tabs = this.open === 'msb'
      ? [['msb', 'ГРЩ — главный распределительный щит']]
      : [['nav', 'Огни'], ['light', 'Свет'], ['horn', 'Тифон'], ['dev', 'Приборы'], ['power', 'Энергия'], ['alarms', `Тревоги${this.A.unacked ? ` (${this.A.unacked})` : ''}`]];
    if (this.open === 'msb') this.tab = 'msb';
    this.hd.innerHTML = `<b>${this.open === 'msb' ? 'Машинное отделение' : 'Пульт мостика'}</b>${tabs.map(([id, n]) => `<button class="tab ${this.tab === id ? 'sel' : ''}" data-a="tab:${id}">${n}</button>`).join('')}<button class="x" data-a="close">✕</button>`;
    const sc = this.bd.scrollTop;
    this.bd.innerHTML = this[`r_${this.tab}`]();
    this.bd.scrollTop = sc;
  }

  // ---------------------------------------------------------------- tabs
  r_nav() {
    const L = this.L;
    const p = NAV_PRESETS[L.preset];
    const rows = Object.values(L.nav).map((n) => {
      const lamp = n.lit ? (n.col[1] > 0.9 && n.col[0] < 0.5 ? 'g' : n.col[0] > 0.9 && n.col[1] < 0.5 ? 'r' : 'w') : n.on ? 'r' : '';
      return `<tr><td><span class="lamp ${lamp}"></span>${n.name}</td><td class="n">${n.on ? (n.lit ? 'горит' : 'ОТКАЗ: нет 24 В') : 'выкл.'}</td>
        <td style="text-align:right"><button class="${n.on ? 'on' : ''}" data-a="nav:${n.id}">${n.on ? 'ВКЛ' : 'ВЫКЛ'}</button></td></tr>`;
    }).join('');
    return `<div class="row">${Object.entries(NAV_PRESETS).map(([id, q]) => `<button class="${L.preset === id ? 'on' : ''}" data-a="preset:${id}">${q.name}</button>`).join('')}</div>
      <p class="note">${p ? p.rule : 'Свой набор огней'}. Каждый огонь виден только в своём секторе — обойдите судно ночью.</p>
      <table>${rows}</table>
      <p class="note">Светодиодные фонари 24 В, питание от аккумуляторов: горят и при обесточивании главных шин.</p>`;
  }

  r_light() {
    const L = this.L, E = this.E;
    const fl = (g, name, n) => {
      const f = L.flood[g];
      const st = !E.powered('floods') ? 'нет питания (автомат на ГРЩ)' : f.cool > 0 ? `остывает: повторный поджиг через ${fmtT(f.cool)}` : f.on ? (f.warm < 0.99 ? `разгорается ${Math.round(f.warm * 100)} %` : 'горит') : 'выкл.';
      return `<tr><td><span class="lamp ${f.out > 0.5 ? 'w' : f.out > 0 ? 'y' : f.cool > 0 ? 'r' : ''}"></span>${name} (${n} × 400 Вт МГЛ)</td><td class="n">${st}</td>
        <td style="text-align:right"><button class="${f.on ? 'on' : ''}" data-a="flood:${g}">${f.on ? 'ВКЛ' : 'ВЫКЛ'}</button></td></tr>`;
    };
    const s = L.search;
    const wh = (m, n) => `<button class="${L.wheelhouse === m ? 'on' : ''}" data-a="wh:${m}">${n}</button>`;
    return `<div class="grid">
      <div class="card"><h4>Палубное освещение</h4><table>${fl('aft', 'Корма, рабочая палуба', 4)}${fl('fore', 'Бак', 2)}</table>
        <p class="note">Металлогалогенные лампы: разгораются около минуты, горячие не зажигаются, пока не остынут.</p></div>
      <div class="card"><h4>Поисковый прожектор 1 кВт</h4>
        <div class="row"><button class="${s.on ? 'on' : ''}" data-a="search:on">${s.on ? 'ВКЛ' : 'ВЫКЛ'}</button>
          <span class="mono">${s.az >= 0 ? 'Пр' : 'Л'}б ${Math.abs(s.az).toFixed(0)}° · ${s.el.toFixed(0)}°</span>${!E.powered('search') ? '<span class="note">нет питания</span>' : ''}</div>
        <div class="row"><button data-a="search:aim:-10:0">◀◀</button><button data-a="search:aim:-2:0">◀</button><button data-a="search:aim:2:0">▶</button><button data-a="search:aim:10:0">▶▶</button>
          <button data-a="search:aim:0:1">▲</button><button data-a="search:aim:0:-1">▼</button><button data-a="search:cam">туда, куда смотрю</button></div></div>
      <div class="card"><h4>Освещение рубки (24 В)</h4>
        <div class="row">${wh('auto', 'авто')}${wh('off', 'выкл')}${wh('red', 'красный ночной')}${wh('white', 'белый')}</div>
        <div class="row">яркость <button data-a="dim:-0.15">−</button><span class="mono">${Math.round(L.dim * 100)} %</span><button data-a="dim:0.15">+</button></div>
        <p class="note">Ночью — красный: глаза вахтенного не теряют ночного зрения.</p></div>
      <div class="card"><h4>Помещения</h4><p>${L.inside === 'normal' ? '<span class="lamp w"></span>Основное освещение 230 В' : L.inside === 'emergency' ? '<span class="lamp y"></span>Аварийное освещение 24 В' : '<span class="lamp r"></span>Темно: нет питания'}</p>
        <p class="note">Основное освещение — автомат «Освещение помещений» на ГРЩ.</p></div>
    </div>`;
  }

  r_horn() {
    const W = this.W, E = this.E;
    const p = E.air;
    const ready = E.dcOk && p > 1.5;
    const sig = Object.entries(SIGNALS).map(([id, q]) => `<tr><td><button data-a="sig:${id}">${q.name}</button></td><td class="n">${q.meaning}</td></tr>`).join('');
    const fog = Object.entries(FOG).map(([id, q]) => `<button class="${W.fog === id ? 'on' : ''}" data-a="fog:${id}">${q.name}</button>`).join('');
    return `<div class="grid">
      <div class="card"><h4>Тифон (воздушный, ~290 Гц)</h4>
        <div class="row"><button data-hold="1" style="min-width:150px;min-height:54px;font-size:15px">ДЕРЖАТЬ — ГУДОК</button>
          <span class="lamp ${W.open ? 'y' : ready ? 'g' : 'r'}"></span>${W.open ? 'звучит' : ready ? 'готов' : !E.dcOk ? 'нет 24 В на клапане' : 'нет воздуха'}</div>
        <div class="mono">Ресивер 250 л: ${p.toFixed(1)} бар</div>
        <div class="bar"><i style="width:${Math.min(100, (p / 9.2) * 100)}%;background:${p < 5 ? '#e0533f' : '#4fb4d8'}"></i></div>
        <div class="mono">Компрессор: ${!E.powered('comp') ? 'нет питания (ГРЩ)' : E.compOn ? 'качает' : 'стоп (7,5–9 бар)'}</div>
        <p class="note">МППСС, Приложение III: судно 20–75 м — основная частота 250–700 Гц, 130 дБ на 1 м, слышен примерно за милю.</p></div>
      <div class="card"><h4>Туманный сигнал — автомат</h4><div class="row">${fog}</div>
        <p class="note">${FOG[W.fog].meaning}${W.fog !== 'off' ? ` · следующий через ${Math.max(0, Math.round(W.fogT))} с` : ''}</p></div>
    </div>
    <h4 style="margin:12px 0 4px;color:#8fb3c4">Сигналы маневроуказания (правило 34)</h4>
    <table>${sig}</table>
    <p class="note">Короткий — около 1 с, продолжительный — 4–6 с. Подаются, когда суда видят друг друга.</p>`;
  }

  r_dev() {
    const S = this.S, ap = S.ap;
    const rows = DEV_ORDER.map((id) => {
      const d = S.dev[id];
      const st = d.state === 'ready' ? 'работает' : d.state === 'booting' ? `${d.boot >= 60 ? 'прогрев' : 'загрузка'} ${fmtT(d.t)}` : d.state === 'nopower' ? 'НЕТ ПИТАНИЯ' : 'выкл.';
      const lamp = d.state === 'ready' ? 'g' : d.state === 'booting' ? 'y' : d.state === 'nopower' ? 'r' : '';
      const extra = id === 'radar' && d.state === 'ready' ? `<button class="${S.radarTx ? 'on' : 'warn'}" data-a="radartx">${S.radarTx ? 'TX' : 'STBY'}</button>` : '';
      return `<tr><td><span class="lamp ${lamp}"></span>${d.name}</td><td class="n">${st} · ${d.bus === 'ups' ? '230 В ИБП' : '24 В'}</td>
        <td style="text-align:right">${extra} <button class="${d.on ? 'on' : ''}" data-a="dev:${id}">${d.on ? 'ВКЛ' : 'ВЫКЛ'}</button></td></tr>`;
    }).join('');
    const err = wrap180(ap.set - S.hdg);
    return `<div class="grid">
      <div class="card"><h4>Авторулевой</h4>
        <div class="row"><span class="big">${ap.mode === 'auto' ? `АВТО ${String(Math.round(ap.set)).padStart(3, '0')}°` : 'РУЧНОЕ'}</span></div>
        <div class="mono">курс ${S.hdgOk ? S.hdg.toFixed(1) : '---'}° · ${ap.mode === 'auto' ? `отклонение ${err.toFixed(1)}°` : ''} ${ap.msg ? `· ${ap.msg}` : ''}</div>
        <div class="row"><button class="${ap.mode === 'auto' ? 'on' : ''}" data-a="ap:auto">АВТО</button><button class="${ap.mode === 'hand' ? 'on' : ''}" data-a="ap:hand">РУЧН.</button>
          <button data-a="ap:-10">−10</button><button data-a="ap:-1">−1</button><button data-a="ap:1">+1</button><button data-a="ap:10">+10</button></div>
        <p class="note">Держит курс по спутниковому компасу через рулевую машину. Взяли штурвал — авторулевой отключается.</p></div>
      <div class="card"><h4>BNWAS — контроль бодрствования</h4>
        <p class="mono">${ap.mode !== 'auto' ? 'не активен (только на авторулевом)' : S.bnwas.stage ? `<b style="color:#ffb02e">ТРЕВОГА, ступень ${S.bnwas.stage}</b>` : `сброс через ${fmtT(Math.max(0, S.bnwas.t))}`}</p>
        <div class="row"><button data-a="bnwas:reset">Я на вахте (сброс)</button></div>
        <p class="note">Каждые 6 минут на авторулевом вахтенный подтверждает, что не спит; иначе — сигнал на мостике, потом вызов капитана.</p></div>
    </div><table style="margin-top:10px">${rows}</table>`;
  }

  r_power() {
    const E = this.E, S = this.S, me = S.me;
    const gen = (g) => `<div class="card"><h4>${g.name} · ${g.rated} кВт</h4>
      <div class="mono">${this.genState(g)} · ${g.state === 'running' ? `${g.f.toFixed(1)} Гц` : ''}</div>
      <div class="bar"><i style="width:${Math.min(100, (g.kw / g.rated) * 100)}%;background:${g.kw / g.rated > 0.95 ? '#e0533f' : '#4fb4d8'}"></i></div>
      <div class="mono">${g.kw.toFixed(1)} кВт · ${Math.round((g.kw / g.rated) * 100)} % · ${g.mode === 'auto' ? 'резерв АВТО' : 'ручной'}</div>
      <div class="row"><button data-a="gen:start:${g.id}">Пуск</button><button data-a="gen:stop:${g.id}">Стоп</button></div>
      ${g.msg ? `<p class="note">${g.msg}</p>` : ''}</div>`;
    return `<div class="grid">
      <div class="card"><h4>Главный двигатель</h4><div class="big">${me.state === 'running' ? `${Math.round(me.rpm)} об/мин` : me.state === 'cranking' ? 'ПУСК…' : 'СТОП'}</div>
        <div class="mono">масло ${me.oil.toFixed(1)} бар · вода ${me.cool.toFixed(0)} °C · ${Math.round(me.fuel)} л/ч</div>
        <div class="row"><button data-a="me:start">Пуск ГД</button><button class="bad" data-a="me:stop">Стоп ГД</button></div>
        ${me.msg ? `<p class="note">${me.msg}</p>` : ''}</div>
      ${E.gens.map(gen).join('')}
      <div class="card"><h4>Шины 400 В</h4><div class="big">${E.live ? `${E.kw.toFixed(1)} кВт` : 'БЛЭКАУТ'}</div>
        <div class="mono">${E.live ? `${E.busV.toFixed(0)} В · ${E.busF.toFixed(2)} Гц · нагрузка ${Math.round(E.load * 100)} %` : 'аварийное освещение и ИБП'}</div>
        <p class="note">Автоматы, синхронизация и режимы генераторов — на ГРЩ в машинном отделении.</p></div>
      <div class="card"><h4>24 В и ИБП</h4>
        <div class="mono">АКБ: ${E.house.V.toFixed(1)} В · ${E.house.I >= 0 ? 'заряд' : 'разряд'} ${Math.abs(E.house.I).toFixed(0)} А · ${Math.round(E.house.soc * 100)} %</div>
        <div class="mono">Стартерная: ${E.start.V.toFixed(1)} В · ${Math.round(E.start.soc * 100)} %</div>
        <div class="mono">ИБП навигации: ${E.ups.onBattery ? 'ОТ БАТАРЕИ' : 'сеть'} · ${Math.round(E.ups.soc * 100)} %</div>
        <div class="mono">Топливо: ${Math.round(E.fuel)} л · ${(me.fuel + E.fuelRate).toFixed(0)} л/ч</div></div>
    </div>`;
  }

  r_alarms() {
    const list = this.A.sorted();
    if (!list.length) return '<p>Тревог нет.</p>';
    return `<div class="row"><button data-a="ackall">Квитировать все</button></div><table>${list.map((a) => `<tr>
      <td><span class="lamp ${a.active ? (a.sev === 'alarm' ? 'r' : 'y') : ''}"></span>${a.text}</td>
      <td class="n">${a.active ? 'активна' : 'устранена'} · ${a.acked ? 'квитирована' : 'НЕ КВИТИРОВАНА'}</td>
      <td style="text-align:right">${a.acked ? '' : `<button data-a="ack:${a.id}">Квит.</button>`}</td></tr>`).join('')}</table>`;
  }

  genState(g) {
    if (g.state === 'cranking') return 'ПРОКРУТКА';
    if (g.state === 'runup') return `РАЗГОН ${Math.round(g.rpm)} об/мин`;
    if (g.state === 'stopping') return 'ОСТАНОВКА';
    if (g.state === 'stopped') return g.mode === 'auto' ? 'стоп, резерв' : 'стоп';
    return g.breaker ? 'НА ШИНАХ' : 'работает, АВ отключён';
  }

  r_msb() {
    const E = this.E;
    const gen = (g) => {
      const sync = g.ready && !g.breaker && E.live;
      const ang = g.phase;
      const okSync = sync && Math.abs(g.f - E.busF) < 0.3 && Math.abs(ang) < 15;
      return `<div class="card"><h4>${g.name} · 80 кВА / ${g.rated} кВт · 400 В 50 Гц</h4>
        <div class="row"><span class="lamp ${g.breaker ? 'r' : g.ready ? 'g' : ''}"></span><b>${this.genState(g)}</b></div>
        <div class="meters"><div><span>U, В</span><b>${g.V.toFixed(0)}</b></div><div><span>f, Гц</span><b>${g.f.toFixed(2)}</b></div><div><span>P, кВт</span><b>${g.kw.toFixed(1)}</b></div>
          <div><span>I, А</span><b>${(g.kw * 1000 / (1.732 * 400 * 0.8)).toFixed(0)}</b></div><div><span>об/мин</span><b>${Math.round(g.rpm)}</b></div><div><span>вода, °C</span><b>${g.coolant.toFixed(0)}</b></div></div>
        <div class="bar"><i style="width:${Math.min(100, (g.kw / g.rated) * 100)}%;background:${g.kw / g.rated > 0.95 ? '#e0533f' : '#4fb4d8'}"></i></div>
        ${sync ? `<div class="row"><svg width="74" height="74" viewBox="-37 -37 74 74"><circle r="34" fill="#0b1117" stroke="#55707e"/>
          <line x1="0" y1="-34" x2="0" y2="-26" stroke="#4cc27c" stroke-width="3"/>
          <line x1="0" y1="0" x2="${(Math.sin((ang * Math.PI) / 180) * 28).toFixed(1)}" y2="${(-Math.cos((ang * Math.PI) / 180) * 28).toFixed(1)}" stroke="${okSync ? '#4cc27c' : '#ffb02e'}" stroke-width="3"/></svg>
          <span class="mono">Синхроскоп<br>Δf ${(g.f - E.busF).toFixed(2)} Гц<br>${ang.toFixed(0)}° ${okSync ? '<b style="color:#4cc27c">МОЖНО</b>' : ''}</span></div>` : ''}
        <div class="row"><button data-a="gen:start:${g.id}">Пуск</button><button data-a="gen:stop:${g.id}">Стоп</button>
          <button class="${g.breaker ? 'bad' : ''}" data-a="gen:${g.breaker ? 'open' : 'close'}:${g.id}">${g.breaker ? 'Откл. АВ' : 'Вкл. АВ'}</button>
          ${sync ? `<button class="${g.sync ? 'warn' : ''}" data-a="gen:sync:${g.id}">Автосинхр.</button>` : ''}</div>
        <div class="row">обороты <button data-a="gen:down:${g.id}">−</button><button data-a="gen:up:${g.id}">+</button>
          <button class="${g.mode === 'auto' ? 'on' : ''}" data-a="gen:mode:${g.id}">${g.mode === 'auto' ? 'резерв: АВТО' : 'резерв: РУЧН'}</button></div>
        ${g.msg ? `<p class="note">${g.msg}</p>` : ''}
        <p class="note">Моточасы ${Math.floor(g.hours)} · топливо ${g.fuel.toFixed(1)} л/ч</p></div>`;
    };
    const feeders = E.feeders.map((f) => {
      const p = E.powered(f.id);
      const st = !f.on ? 'отключён' : f.shed ? 'ОТКЛ. ПРЕДВ. ЗАЩИТОЙ' : !E.live ? 'нет напряжения' : f.motor && !f.running ? 'стоп (нужен пуск)' : `${f.demand.toFixed(1)} кВт`;
      const extra = f.id === 'hyd' && p ? ` <button class="${E.hydWork ? 'warn' : ''}" data-a="hydwork">${E.hydWork ? 'лебёдки: выборка' : 'холостой ход'}</button>` : '';
      return `<tr><td><span class="lamp ${p ? 'g' : f.on ? 'r' : ''}"></span>${f.name}</td><td class="n mono">${st} · ${f.kw} кВт${f.ess ? ' · ответств.' : ''}</td>
        <td style="text-align:right">${extra} <button class="${f.on ? 'on' : ''}" data-a="feeder:${f.id}">${f.on ? (f.motor && !f.running && E.live && !f.shed ? 'ПУСК' : 'ВКЛ') : 'ВЫКЛ'}</button></td></tr>`;
    }).join('');
    return `<div class="card" style="margin-bottom:10px"><div class="row"><span class="big">${E.live ? `ШИНЫ ${E.busV.toFixed(0)} В · ${E.busF.toFixed(2)} Гц · ${E.kw.toFixed(1)} кВт (${Math.round(E.load * 100)} %)` : 'ШИНЫ ОБЕСТОЧЕНЫ'}</span></div>
        <p class="note">Перегрузка выше 100 % на 5 с — отключаются неответственные потребители; выше 115 % — генератор отключается защитой. Береговое питание: нет (судно в море).</p></div>
      <div class="grid">${E.gens.map(gen).join('')}</div>
      <h4 style="margin:12px 0 4px;color:#8fb3c4">Потребители 400/230 В</h4><table>${feeders}</table>
      <div class="grid" style="margin-top:10px">
        <div class="card"><h4>24 В</h4><div class="mono">Судовая АКБ 2 × 225 А·ч: ${this.E.house.V.toFixed(1)} В · ${Math.round(E.house.soc * 100)} % · ${E.house.I >= 0 ? '+' : ''}${E.house.I.toFixed(0)} А</div>
          <div class="mono">Стартерная 180 А·ч: ${E.start.V.toFixed(1)} В · ${Math.round(E.start.soc * 100)} %</div>
          <div class="mono">Нагрузка 24 В: ${Math.round(E.dcW)} Вт · генератор ГД: ${this.S.me.state === 'running' ? '28 В, до 80 А' : 'не работает'}</div></div>
        <div class="card"><h4>ИБП навигации</h4><div class="mono">${E.ups.onBattery ? 'ОТ БАТАРЕИ' : 'от сети'} · ${Math.round(E.ups.soc * 100)} % · нагрузка ${(E.ext.nav * 1000).toFixed(0)} Вт</div></div>
        <div class="card"><h4>Состояние</h4><div class="mono">Трюм ${E.holdT.toFixed(1)} °C · жилые ${E.cabinT.toFixed(1)} °C · льяла ${Math.round(E.bilge * 100)} %</div></div>
      </div>`;
  }
}
