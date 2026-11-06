// On-screen touch controls for phones: a floating virtual joystick (drag up to
// sail, left/right to steer) plus two buttons (day/night, camera). Values are
// written into the shared Input instance so the rest of the game is unaware of
// the input source.
export class TouchControls {
  constructor(input, { onToggleTime, onToggleCamera } = {}) {
    this.input = input;
    this.activePointer = null;
    this.origin = { x: 0, y: 0 };
    this.radius = 62;

    const layer = document.createElement('div');
    layer.id = 'touch-layer';
    this.base = document.createElement('div');
    this.base.id = 'joy-base';
    this.knob = document.createElement('div');
    this.knob.id = 'joy-knob';
    this.base.appendChild(this.knob);
    layer.appendChild(this.base);
    document.body.appendChild(layer);
    this.layer = layer;

    const btns = document.createElement('div');
    btns.id = 'touch-buttons';
    const mk = (label, fn) => {
      const b = document.createElement('button');
      b.className = 'tbtn';
      b.textContent = label;
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); fn && fn(); });
      return b;
    };
    btns.appendChild(mk('day / night', onToggleTime));
    btns.appendChild(mk('camera', onToggleCamera));
    document.body.appendChild(btns);
    this.btns = btns;

    layer.addEventListener('pointerdown', this._down, { passive: false });
    window.addEventListener('pointermove', this._move, { passive: false });
    window.addEventListener('pointerup', this._up);
    window.addEventListener('pointercancel', this._up);
  }

  _down = (e) => {
    if (this.activePointer !== null) return;
    this.activePointer = e.pointerId;
    this.origin.x = e.clientX;
    this.origin.y = e.clientY;
    this.base.style.left = `${e.clientX}px`;
    this.base.style.top = `${e.clientY}px`;
    this.base.style.opacity = '1';
    this._set(e.clientX, e.clientY);
    e.preventDefault();
  };

  _move = (e) => {
    if (e.pointerId !== this.activePointer) return;
    this._set(e.clientX, e.clientY);
    e.preventDefault();
  };

  _up = (e) => {
    if (e.pointerId !== this.activePointer) return;
    this.activePointer = null;
    this.input.touchThrottle = 0;
    this.input.touchSteer = 0;
    this.base.style.opacity = '0';
    this.knob.style.transform = 'translate(-50%, -50%)';
  };

  _set(x, y) {
    let dx = x - this.origin.x;
    let dy = y - this.origin.y;
    const len = Math.hypot(dx, dy) || 1;
    const clamped = Math.min(len, this.radius);
    dx = (dx / len) * clamped;
    dy = (dy / len) * clamped;
    this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    this.input.touchThrottle = -dy / this.radius; // up = forward
    this.input.touchSteer = -dx / this.radius;    // left = positive steer
  }

  // Hide the driving joystick (e.g. while free-look camera owns the touch).
  setVisible(v) {
    this.layer.style.display = v ? 'block' : 'none';
    if (!v) {
      this.activePointer = null;
      this.input.touchThrottle = 0;
      this.input.touchSteer = 0;
      this.base.style.opacity = '0';
    }
  }
}
