// Keyboard input mapped to normalized throttle (-1..1) and steer (-1..1).
// Also exposes one-shot "actions" (toggle day/night, free camera) consumed
// by main each frame.
export class Input {
  constructor(target = window) {
    this.keys = new Set();
    this.throttle = 0;
    this.steer = 0;
    // Written by TouchControls; folded into throttle/steer each update.
    this.touchThrottle = 0;
    this.touchSteer = 0;
    this.actions = { toggleTime: false, toggleCamera: false };

    this._down = (e) => {
      const k = e.key.toLowerCase();
      if (!this.keys.has(k)) {
        if (k === 'n') this.actions.toggleTime = true;
        if (k === 'c') this.actions.toggleCamera = true;
      }
      this.keys.add(k);
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
    };
    this._up = (e) => this.keys.delete(e.key.toLowerCase());

    target.addEventListener('keydown', this._down);
    target.addEventListener('keyup', this._up);
  }

  update() {
    const k = this.keys;
    let t = 0;
    let s = 0;
    if (k.has('w') || k.has('arrowup')) t += 1;
    if (k.has('s') || k.has('arrowdown')) t -= 1;
    if (k.has('a') || k.has('arrowleft')) s += 1;
    if (k.has('d') || k.has('arrowright')) s -= 1;
    this.throttle = Math.max(-1, Math.min(1, t + this.touchThrottle));
    this.steer = Math.max(-1, Math.min(1, s + this.touchSteer));
  }

  consume(name) {
    if (this.actions[name]) {
      this.actions[name] = false;
      return true;
    }
    return false;
  }
}
