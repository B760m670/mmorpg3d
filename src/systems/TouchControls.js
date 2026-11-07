// Phone controls: a floating stick on the left, drag-to-look on the right,
// and a column of context buttons. Buttons press the same keys as the
// keyboard, so the game has one code path per action.
const BUTTONS = {
  ahead: { label: '▲ ahead', key: 'w' },
  astern: { label: '▼ astern', key: 's' },
  midships: { label: 'midships', key: 'z' },
  helm: { label: 'take helm', key: 'e' },
  leave: { label: 'leave helm', key: 'e' },
  view: { label: '1st / 3rd', key: 'f' },
  time: { label: 'day / night', key: 'n', top: true },
  sea: { label: 'weather', key: 'b', top: true },
  sound: { label: 'sound', key: 'm', top: true },
  horn: { label: 'horn', key: 'h', top: true },
};

// Scenery buttons live in the top-right corner, out of the way of the conn.
const TOP_CSS = `
#touch-top {
  position: fixed; z-index: 6; display: flex; flex-direction: column; align-items: stretch; gap: 8px;
  top: calc(10px + env(safe-area-inset-top, 0px));
  right: calc(12px + env(safe-area-inset-right, 0px));
}
#touch-top .tbtn { padding: 10px 12px; font-size: 11px; }
`;

export class TouchControls {
  constructor(input) {
    this.input = input;
    this.stickId = null;
    this.lookId = null;
    this.origin = { x: 0, y: 0 };
    this.last = { x: 0, y: 0 };
    this.radius = 62;

    const left = document.createElement('div');
    left.id = 'touch-layer';
    this.base = document.createElement('div');
    this.base.id = 'joy-base';
    this.knob = document.createElement('div');
    this.knob.id = 'joy-knob';
    this.base.appendChild(this.knob);
    left.appendChild(this.base);
    document.body.appendChild(left);

    const right = document.createElement('div');
    right.id = 'look-layer';
    document.body.appendChild(right);
    this.lookLayer = right;

    const col = document.createElement('div');
    col.id = 'touch-buttons';
    const top = document.createElement('div');
    top.id = 'touch-top';
    const style = document.createElement('style');
    style.textContent = TOP_CSS;
    document.head.appendChild(style);
    this.buttons = {};
    for (const [id, b] of Object.entries(BUTTONS)) {
      const el = document.createElement('button');
      el.className = 'tbtn';
      el.textContent = b.label;
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); input.press(b.key); });
      (b.top ? top : col).appendChild(el);
      this.buttons[id] = el;
    }
    document.body.appendChild(col);
    document.body.appendChild(top);

    left.addEventListener('pointerdown', (e) => {
      if (this.stickId !== null) return;
      this.stickId = e.pointerId;
      this.origin = { x: e.clientX, y: e.clientY };
      this.base.style.left = `${e.clientX}px`;
      this.base.style.top = `${e.clientY}px`;
      this.base.style.opacity = '1';
      this._stick(e.clientX, e.clientY);
      e.preventDefault();
    }, { passive: false });
    right.addEventListener('pointerdown', (e) => {
      if (this.lookId !== null) return;
      this.lookId = e.pointerId;
      this.last = { x: e.clientX, y: e.clientY };
      e.preventDefault();
    }, { passive: false });
    window.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stickId) this._stick(e.clientX, e.clientY);
      if (e.pointerId === this.lookId) {
        input.lookDX += (e.clientX - this.last.x) * 1.6;
        input.lookDY += (e.clientY - this.last.y) * 1.6;
        this.last = { x: e.clientX, y: e.clientY };
      }
    }, { passive: false });
    const end = (e) => {
      if (e.pointerId === this.stickId) {
        this.stickId = null;
        input.touchX = 0;
        input.touchY = 0;
        input.stickActive = false;
        this.base.style.opacity = '0';
        this.knob.style.transform = 'translate(-50%, -50%)';
      }
      if (e.pointerId === this.lookId) this.lookId = null;
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
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

  // mode: '3p' | 'helm' | 'walk'
  setMode(mode, nearHelm) {
    const show = {
      ahead: mode !== 'walk',
      astern: mode !== 'walk',
      midships: mode !== 'walk',
      helm: mode === 'walk' && nearHelm,
      leave: mode === 'helm',
      view: true,
      time: true,
      sea: true,
      sound: true,
      horn: true,
    };
    for (const [id, el] of Object.entries(this.buttons)) el.hidden = !show[id];
    this.lookLayer.style.display = mode === '3p' ? 'none' : 'block';
  }
}
