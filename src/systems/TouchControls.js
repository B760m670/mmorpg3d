// Phone controls, kept out of the way of the view:
//   - bottom-left: a joystick, always visible. At the conn (outside view or
//     at the wheel) left/right puts the helm over in proportion and it
//     comes back amidships when you let go; holding it up or down sets or
//     takes in sail, a step at a time. Aboard, the same stick walks, and on
//     the shrouds it climbs;
//   - everywhere else: drag to look (aboard) or to fly the camera around the
//     ship (outside view); pinch with two fingers to zoom;
//   - top-right: the one action that applies where you are (take the helm,
//     climb, come aboard), "dive" (over the side), the view, and a menu (☰)
//     with day/night, weather and sound;
//   - in the water: the stick swims where you look, ▲ / ▼ (held) go up and
//     down, the torch and "aboard" (at the ship's side) are at the top.
// Buttons press the same keys as the keyboard, so every action has one code
// path.

// The published single-file page carries its own <style> in the body, after
// this sheet in document order, so rules that compete with it use !important.
const CSS = `
#touch-layer { left: 0 !important; top: auto !important; bottom: 0; width: calc(210px + env(safe-area-inset-left, 0px)) !important; height: calc(240px + env(safe-area-inset-bottom, 0px)) !important; z-index: 6 !important; }
#look-layer { left: 0 !important; right: 0 !important; top: 0; width: 100% !important; height: 100% !important; z-index: 4 !important; display: block !important; }
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
#joy-base { left: calc(38px + env(safe-area-inset-left, 0px)) !important; top: auto !important;
  bottom: calc(70px + env(safe-area-inset-bottom, 0px)); margin: 0 !important; }
body.touch #joy-base { opacity: 0.6; }
body.touch #joy-base.active { opacity: 1; }
#joy-knob { background: rgba(255, 207, 122, 0.75) !important; box-shadow: 0 1px 6px rgba(0,0,0,.45); }
body.walking #joy-knob { background: rgba(235, 244, 248, 0.55) !important; }
#joy-base i { position: absolute; font: 11px ui-monospace, monospace; font-style: normal; color: rgba(234,242,246,.7);
  text-shadow: 0 1px 2px #000; transform: translate(-50%, -50%); }
#joy-label { position: absolute; left: 50%; top: 100%; transform: translate(-50%, 6px); font: 11px ui-monospace, monospace;
  color: #eaf2f6; text-shadow: 0 1px 2px #000; white-space: nowrap; }
#tc-updown { right: calc(16px + env(safe-area-inset-right, 0px)); bottom: calc(26px + env(safe-area-inset-bottom, 0px));
  display: none; flex-direction: column; gap: 14px; }
#tc-updown button { width: 62px; height: 62px; border-radius: 31px; font-size: 22px; padding: 0; touch-action: none; }
#tc-updown button.on { background: rgba(111, 224, 200, 0.4); }
body.diving #tc-updown { display: flex; }
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
    // arrows around the ring say what each direction does
    this.marks = ['↑', '↓', '←', '→'].map((t, i) => {
      const m = document.createElement('i');
      m.textContent = t;
      m.style.left = `${[50, 50, 9, 91][i]}%`;
      m.style.top = `${[9, 91, 50, 50][i]}%`;
      this.base.appendChild(m);
      return m;
    });
    const jl = document.createElement('div');
    jl.id = 'joy-label';
    this.base.appendChild(jl);
    this.label = jl;
    left.appendChild(this.base);
    document.body.appendChild(left);

    const look = document.createElement('div');
    look.id = 'look-layer';
    document.body.appendChild(look);

    // top-right: the action here, over the side, the view, the menu
    const top = this.el('div', 'tc', 'tc-top');
    this.btnHelm = this.button(top, 'к штурвалу', 'e');
    this.btnHelm.hidden = true;
    this.btnDive = this.button(top, 'за борт', 'j');
    this.btnTorch = this.button(top, 'фонарь', 'l');
    this.btnTorch.hidden = true;
    this.btnView = this.button(top, 'на борт', 'f');
    const menuBtn = this.button(top, '☰', null);
    const menu = this.el('div', 'tc', 'tc-menu');
    menuBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); menu.classList.toggle('open'); });
    this.button(menu, 'день / ночь', 'n');
    this.button(menu, 'погода', 'b');
    this.button(menu, 'вёсла', 'r');
    this.button(menu, 'якорь', 'g');
    this.btnSound = this.button(menu, 'звук: вкл', 'm');
    this.menu = menu;

    this.toastEl = this.el('div', 'tc', 'tc-toast');

    // in the water: up / down while held (they hold the Space and C keys)
    const ud = this.el('div', 'tc', 'tc-updown');
    for (const [label, key] of [['▲', ' '], ['▼', 'c']]) {
      const b = document.createElement('button');
      b.textContent = label;
      const on = (e) => { e.preventDefault(); e.stopPropagation(); this.input.keys.add(key); b.classList.add('on'); };
      const off = () => { this.input.keys.delete(key); b.classList.remove('on'); };
      b.addEventListener('pointerdown', on);
      b.addEventListener('pointerup', off);
      b.addEventListener('pointercancel', off);
      b.addEventListener('pointerleave', off);
      ud.appendChild(b);
    }

    // stick
    left.addEventListener('pointerdown', (e) => {
      if (this.stickId !== null) return;
      this.stickId = e.pointerId;
      this.parkStick();
      this.base.classList.add('active');
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
        this.base.classList.remove('active');
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
        if (parent === this.menu) this.menu.classList.remove('open');
      });
    }
    parent.appendChild(b);
    return b;
  }

  // the stick sits bottom-left, always in the same place (CSS); its centre
  // is the origin
  parkStick() {
    const r = this.base.getBoundingClientRect();
    this.origin = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  spread() {
    const pts = [...this.looks.values()];
    return pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
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

  // mode: '3p' | 'helm' | 'walk' | 'swim'; action: the label of what E
  // would do here (or false)
  setMode(mode, action) {
    const swim = mode === 'swim';
    document.body.classList.toggle('walking', mode === 'walk' || swim);
    this.mode = mode;
    const conn = mode === '3p' || mode === 'helm';
    if (!conn) this.label.textContent = swim ? 'плыть' : 'идти';
    this._lastRud = null;
    this.btnHelm.hidden = !action;
    if (action) this.btnHelm.textContent = action;
    this.btnDive.hidden = !(mode === '3p' || mode === 'walk');
    this.btnTorch.hidden = !swim;
    this.btnView.hidden = swim;
    this.btnView.textContent = mode === '3p' ? 'на борт' : 'со стороны';
  }

  // the helm, shown under the stick while you have the conn
  update(ship) {
    if (!(this.mode === '3p' || this.mode === 'helm')) return;
    const r = Math.round(ship.rudder);
    if (r !== this._lastRud) {
      this._lastRud = r;
      this.label.textContent = r === 0 ? 'руль прямо' : `руль ${Math.abs(r)}° ${r > 0 ? 'лево' : 'право'}`;
    }
  }
}
