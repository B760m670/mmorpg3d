// Keyboard, mouse-look and touch, folded into one interface.
//
//   held(key)      key is down this frame
//   pressed(key)   key went down since the last frame (edge)
//   moveX / moveY  -1..1 from WASD/arrows or the touch stick (right / forward)
//   stickActive    the touch stick is being dragged
//   lookDX/lookDY  accumulated mouse / touch look deltas (pixels)
//
// Touch buttons call press(key) so every action has exactly one code path.
export class Input {
  constructor(target = window) {
    this.keys = new Set();
    this.edges = new Set();
    this.touchX = 0;
    this.touchY = 0;
    this.stickActive = false;
    this.lookDX = 0;
    this.lookDY = 0;
    this.moveX = 0;
    this.moveY = 0;

    target.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if (!this.keys.has(k)) this.edges.add(k);
      this.keys.add(k);
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
    });
    target.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    target.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement) {
        this.lookDX += e.movementX;
        this.lookDY += e.movementY;
      }
    });
  }

  held(k) {
    return this.keys.has(k);
  }

  pressed(k) {
    return this.edges.has(k);
  }

  press(k) {
    this.edges.add(k);
  }

  update() {
    const k = this.keys;
    const kx = (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0);
    const ky = (k.has('w') || k.has('arrowup') ? 1 : 0) - (k.has('s') || k.has('arrowdown') ? 1 : 0);
    this.moveX = Math.max(-1, Math.min(1, kx + this.touchX));
    this.moveY = Math.max(-1, Math.min(1, ky + this.touchY));
  }

  // Call once at the end of every frame.
  endFrame() {
    this.edges.clear();
    this.lookDX = 0;
    this.lookDY = 0;
  }
}
