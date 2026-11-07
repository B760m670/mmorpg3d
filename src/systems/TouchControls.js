import { TELEGRAPH } from '../config.js';

// Phone controls, kept out of the way of the view:
//   - bottom-left: a floating stick — the wheel (third person / at the
//     helm) or walking (aboard);
//   - everywhere else: drag to look (aboard) or to fly the camera around the
//     ship (third person); pinch with two fingers to zoom;
//   - bottom-right: the engine-order telegraph lever — slide it up for ahead,
//     down for astern; a small "rudder midships" button below it;
//   - top-right: view switch, helm button when it applies, and a menu (☰)
//     with day/night, weather, sound and the horn.
// Buttons press the same keys as the keyboard, so every action has one code
// path.

export const ORDER_RU = [
  'ПОЛНЫЙ НАЗАД', 'СРЕДНИЙ НАЗАД', 'МАЛЫЙ НАЗАД', 'СТОП',
  'САМЫЙ МАЛЫЙ ВПЕРЁД', 'МАЛЫЙ ВПЕРЁД', 'СРЕДНИЙ ВПЕРЁД', 'ПОЛНЫЙ ВПЕРЁД',
];

const CSS = `
#touch-layer { left: 0 !important; top: auto !important; bottom: 0; width: 44% !important; height: 62% !important; z-index: 5; }
#look-layer { left: 0 !important; right: 0 !important; top: 0; width: 100% !important; height: 100% !important; z-index: 4; display: block !important; }
#touch-buttons { display: none !important; }
.tc { position: fixed; z-index: 6; font: 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: #eaf2f6; }
.tc button {
  font: inherit; color: inherit; background: rgba(14, 20, 26, 0.55); border: 1px solid rgba(255,255,255,0.18);
  border-radius: 10px; padding: 9px 11px; -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);
}
#tc-top { top: calc(8px + env(safe-area-inset-top, 0px)); right: calc(10px + env(safe-area-inset-right, 0px));
  display: flex; gap: 6px; align-items: flex-start; }
#tc-menu { top: calc(52px + env(safe-area-inset-top, 0px)); right: calc(10px + env(safe-area-inset-right, 0px));
  display: none; flex-direction: row; flex-wrap: wrap; justify-content: flex-end; gap: 6px; max-width: 70vw; z-index: 7; }
#tc-menu.open { display: flex; }
#tc-lever { right: calc(14px + env(safe-area-inset-right, 0px)); bottom: calc(14px + env(safe-area-inset-bottom, 0px));
  width: 64px; display: flex; flex-direction: column; align-items: center; gap: 6px; }
#tc-track { position: relative; width: 40px; height: 168px; border-radius: 20px;
  background: linear-gradient(180deg, rgba(60,200,110,.28), rgba(255,255,255,.07) 50%, rgba(255,90,70,.28));
  border: 1px solid rgba(255,255,255,0.2); touch-action: none; }
#tc-track i { position: absolute; left: 50%; width: 14px; height: 1px; margin-left: -7px; background: rgba(255,255,255,.35); }
#tc-knob { position: absolute; left: 50%; width: 46px; height: 22px; margin: -11px 0 0 -23px; border-radius: 8px;
  background: #ffcf7a; box-shadow: 0 1px 6px rgba(0,0,0,.5); pointer-events: none; }
#tc-order { font-size: 10px; text-align: center; color: #ffcf7a; text-shadow: 0 1px 2px #000; width: 110px; }
#tc-wheel { left: calc(14px + env(safe-area-inset-left, 0px)); bottom: calc(10px + env(safe-area-inset-bottom, 0px));
  display: flex; flex-direction: column; align-items: center; gap: 4px; }
#tc-wheel svg { touch-action: none; filter: drop-shadow(0 1px 3px rgba(0,0,0,.6)); }
#tc-wheel-g { transition: transform .08s linear; transform-origin: 0 0; }
#tc-rudder { font-size: 10px; color: #eaf2f6; text-shadow: 0 1px 2px #000; }
#tc-wheel .row { display: flex; gap: 6px; align-items: center; }
body.touch:not(.walking) #touch-layer { display: none; }
body.touch.walking #joy-base { opacity: 0.55; }
#joy-label { position: absolute; left: 50%; top: 100%; transform: translate(-50%, 6px); font: 10px ui-monospace, monospace;
  color: #eaf2f6; text-shadow: 0 1px 2px #000; white-space: nowrap; }
#tc-toast { left: 50%; top: 38%; transform: translateX(-50%); max-width: min(560px, 86vw); padding: 12px 14px;
  border-radius: 12px; background: rgba(10,14,18,.72); font: 13px/1.45 system-ui, sans-serif; text-align: center;
  opacity: 0; transition: opacity .5s ease; pointer-events: none; }
#tc-toast.show { opacity: 1; }
`;

export class TouchControls {
  constructor(input) {
    this.input = input;
    this.stickId = null;
    this.radius = 58;
    this.looks = new Map();           // pointerId -> {x, y}
    this.pinchDist = 0;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const left = document.createElement('div');
    left.id = 'touch-layer';
    this.base = document.createElement('div');
    this.base.id = 'joy-base';
    this.knob = document.createElement('div');
    this.knob.id = 'joy-knob';
    this.base.appendChild(this.knob);
    const jl = document.createElement('div');
    jl.id = 'joy-label';
    jl.textContent = 'идти';
    this.base.appendChild(jl);
    this.parkStick();
    window.addEventListener('resize', () => this.parkStick());
    left.appendChild(this.base);
    document.body.appendChild(left);

    const look = document.createElement('div');
    look.id = 'look-layer';
    document.body.appendChild(look);

    // top-right: view, helm, menu
    const top = this.el('div', 'tc', 'tc-top');
    this.btnHelm = this.button(top, 'к штурвалу', 'e');
    this.btnView = this.button(top, 'вид', 'f');
    const menuBtn = this.button(top, '☰', null);
    const menu = this.el('div', 'tc', 'tc-menu');
    menuBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); menu.classList.toggle('open'); });
    this.button(menu, 'день / ночь', 'n');
    this.button(menu, 'погода', 'b');
    this.btnSound = this.button(menu, 'звук: вкл', 'm');
    this.button(menu, 'гудок', 'h');
    this.btnHud = this.button(menu, 'приборы', 'i');
    this.menu = menu;

    // bottom-right: telegraph lever
    const lever = this.el('div', 'tc', 'tc-lever');
    this.order = this.el('div', '', 'tc-order', lever);
    const track = this.el('div', '', 'tc-track', lever);
    for (let i = 0; i < TELEGRAPH.length; i++) {
      const tick = document.createElement('i');
      tick.style.top = `${this.levelY(i) * 100}%`;
      track.appendChild(tick);
    }
    this.leverKnob = this.el('div', '', 'tc-knob', track);
    this.lever = lever;

    // bottom-left: the ship's wheel. Drag sideways to put the wheel over;
    // it stays where you leave it, like a real helm. "прямо" = midships.
    const wheel = this.el('div', 'tc', 'tc-wheel');
    let spokes = '';
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2, c = Math.cos(a), si = Math.sin(a);
      spokes += `<line x1="${(c * 9).toFixed(1)}" y1="${(si * 9).toFixed(1)}" x2="${(c * 54).toFixed(1)}" y2="${(si * 54).toFixed(1)}" />`
        + `<circle cx="${(c * 54).toFixed(1)}" cy="${(si * 54).toFixed(1)}" r="4.5" />`;
    }
    wheel.innerHTML = `<svg viewBox="-60 -60 120 120" width="112" height="112">
      <g id="tc-wheel-g" stroke="rgba(214,170,110,0.92)" fill="rgba(214,170,110,0.92)" stroke-width="5" stroke-linecap="round">
        <circle r="42" fill="none" stroke-width="7" />${spokes}<circle r="10" fill="rgba(120,90,50,0.95)" stroke-width="3" />
        <line x1="0" y1="-42" x2="0" y2="-54" stroke="#ffcf7a" stroke-width="6" />
      </g></svg>
      <div class="row"><span id="tc-rudder">руль прямо</span></div>`;
    this.wheelG = wheel.querySelector('#tc-wheel-g');
    this.rudderTxt = wheel.querySelector('#tc-rudder');
    this.button(wheel.querySelector('.row'), 'прямо', 'z');
    this.wheelEl = wheel;
    this.wheelOrder = 0;
    const svg = wheel.querySelector('svg');
    let wheelId = null, startX = 0, startOrder = 0;
    svg.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      wheelId = e.pointerId; startX = e.clientX; startOrder = this.wheelOrder;
    });
    window.addEventListener('pointermove', (e) => {
      if (e.pointerId !== wheelId) return;
      // drag right = starboard (negative wheel order), left = port
      const order = Math.max(-35, Math.min(35, startOrder - (e.clientX - startX) * 0.25));
      this.input.wheelSet = order;
      this.wheelOrder = order;
      this.drawWheel(order);
    });
    window.addEventListener('pointerup', (e) => { if (e.pointerId === wheelId) wheelId = null; });
    this.track = track;
    const setFromY = (clientY) => {
      const r = track.getBoundingClientRect();
      const t = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
      const idx = Math.round((1 - t) * (TELEGRAPH.length - 1));
      this.input.telegraphSet = idx;
      this.showOrder(idx);
    };
    let leverId = null;
    track.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); leverId = e.pointerId; setFromY(e.clientY); });
    window.addEventListener('pointermove', (e) => { if (e.pointerId === leverId) setFromY(e.clientY); });
    window.addEventListener('pointerup', (e) => { if (e.pointerId === leverId) leverId = null; });

    this.toastEl = this.el('div', 'tc', 'tc-toast');

    // stick
    left.addEventListener('pointerdown', (e) => {
      if (this.stickId !== null) return;
      this.stickId = e.pointerId;
      this.origin = { x: e.clientX, y: e.clientY };
      this.base.style.left = `${e.clientX}px`;
      this.base.style.top = `${e.clientY}px`;
      this.base.style.opacity = '1';
      this._stick(e.clientX, e.clientY);
      menu.classList.remove('open');
      e.preventDefault();
    }, { passive: false });

    // look / orbit / pinch
    look.addEventListener('pointerdown', (e) => {
      this.looks.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.looks.size === 2) this.pinchDist = this.spread();
      menu.classList.remove('open');
      e.preventDefault();
    }, { passive: false });
    window.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stickId) this._stick(e.clientX, e.clientY);
      const p = this.looks.get(e.pointerId);
      if (!p) return;
      if (this.looks.size >= 2) {
        p.x = e.clientX; p.y = e.clientY;
        const d = this.spread();
        if (this.pinchDist > 0 && d > 0) input.zoom *= this.pinchDist / d;
        this.pinchDist = d;
      } else {
        input.lookDX += (e.clientX - p.x) * 1.6;
        input.lookDY += (e.clientY - p.y) * 1.6;
        p.x = e.clientX; p.y = e.clientY;
      }
    }, { passive: false });
    const end = (e) => {
      if (e.pointerId === this.stickId) {
        this.stickId = null;
        input.touchX = 0;
        input.touchY = 0;
        input.stickActive = false;
        this.knob.style.transform = 'translate(-50%, -50%)';
        this.parkStick();
      }
      if (this.looks.delete(e.pointerId)) this.pinchDist = this.looks.size >= 2 ? this.spread() : 0;
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  el(tag, cls, id, parent = document.body) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (id) e.id = id;
    parent.appendChild(e);
    return e;
  }

  button(parent, label, key) {
    const b = document.createElement('button');
    b.textContent = label;
    if (key) {
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        this.input.press(key);
        if (parent === this.menu && key !== 'h') this.menu.classList.remove('open');
      });
    }
    parent.appendChild(b);
    return b;
  }

  // the walking stick rests bottom-left, visible, while walking
  parkStick() {
    this.base.style.opacity = '';
    this.base.style.left = '96px';
    this.base.style.top = `${window.innerHeight - 120}px`;
  }

  drawWheel(order) {
    this.wheelG.style.transform = `rotate(${(-order * 7).toFixed(1)}deg)`;
  }

  spread() {
    const pts = [...this.looks.values()];
    return pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
  }

  levelY(i) {
    return 0.06 + 0.88 * (1 - i / (TELEGRAPH.length - 1));
  }

  showOrder(i) {
    this.leverKnob.style.top = `${this.levelY(i) * 100}%`;
    this.order.textContent = ORDER_RU[i];
  }

  _stick(x, y) {
    let dx = x - this.origin.x;
    let dy = y - this.origin.y;
    const len = Math.hypot(dx, dy) || 1;
    const k = Math.min(len, this.radius) / len;
    dx *= k;
    dy *= k;
    this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    this.input.touchX = dx / this.radius;
    this.input.touchY = -dy / this.radius;
    this.input.stickActive = true;
  }

  toast(html, seconds = 6) {
    this.toastEl.innerHTML = html;
    this.toastEl.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => this.toastEl.classList.remove('show'), seconds * 1000);
  }

  setSound(muted) {
    this.btnSound.textContent = muted ? 'звук: выкл' : 'звук: вкл';
  }

  // mode: '3p' | 'helm' | 'walk'; telegraph: current order index
  setMode(mode, nearHelm) {
    this.lever.style.display = mode === 'walk' ? 'none' : 'flex';
    this.wheelEl.style.display = mode === 'walk' ? 'none' : 'flex';
    document.body.classList.toggle('walking', mode === 'walk');
    this.btnHelm.hidden = !(mode === 'helm' || (mode === 'walk' && nearHelm));
    this.btnHelm.textContent = mode === 'helm' ? 'отойти' : 'к штурвалу';
    this.btnView.textContent = mode === '3p' ? 'на борт' : 'со стороны';
  }

  update(boat) {
    if (boat.telegraph !== this._lastOrder) {
      this._lastOrder = boat.telegraph;
      this.showOrder(boat.telegraph);
    }
    if (Math.abs(boat.wheel - this.wheelOrder) > 0.01) {      // keyboard / midships
      this.wheelOrder = boat.wheel;
      this.drawWheel(boat.wheel);
    }
    const r = Math.round(boat.rudder);
    if (r !== this._lastRud) {
      this._lastRud = r;
      this.rudderTxt.textContent = r === 0 ? 'руль прямо' : `руль ${Math.abs(r)}° ${r > 0 ? 'влево' : 'вправо'}`;
    }
  }
}
