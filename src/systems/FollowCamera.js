import * as THREE from 'three';
import { CAMERA } from '../config.js';

// Boxes the camera must stay out of, in the ship's own frame (metres; design
// waterline y = 0, bow toward -Z): the hull to the rails, the stern castle
// and the beakhead. Zooming in or swinging round the ship would otherwise put
// the camera inside her.
const KEEP_OUT = [
  [-8.4, 8.4, -5, 9, -34, 28],
  [-4.5, 4.5, 9, 16, 18, 28],
  [-3.2, 3.2, 4, 8, -36, -26],
];
const _inv = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Vector3();
function inside(p, boxes) {
  return boxes.some((b) => p.x > b[0] && p.x < b[1] && p.y > b[2] && p.y < b[3] && p.z > b[4] && p.z < b[5]);
}

// Chase camera that trails behind the boat's heading, damped, with a subtle
// bob so the horizon breathes with the swell. Can be toggled off to let an
// OrbitControls free-look take over (wired in main).
export class FollowCamera {
  constructor(camera) {
    this.camera = camera;
    this.enabled = true;
    this._desired = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._lookCurrent = new THREE.Vector3();
    // player-controlled framing: pinch / wheel zoom, drag to orbit the ship
    this.zoom = 1;
    this.yaw = 0.55;     // from her quarter: astern and to one side, so she shows her body
    this.pitch = 0;
    // framing and keep-out boxes for the ship followed
    this.cfg = { distance: CAMERA.distance, height: CAMERA.height, lookHeight: CAMERA.lookHeight, keepOut: KEEP_OUT };
  }

  orbit(dx, dy) {
    this.yaw -= dx * 0.005;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.004, -0.22, 1.1);
  }

  zoomBy(f) {
    this.zoom = THREE.MathUtils.clamp(this.zoom * f, 0.3, 5);
  }

  // Offset from the ship to the camera for the current framing.
  _offset(boat) {
    const { dist, height } = this._fit();
    const a = boat.heading + this.yaw;
    const e = THREE.MathUtils.clamp(Math.atan2(height, dist) + this.pitch, 0.03, 1.35);
    const r = Math.hypot(dist, height) * this.zoom;
    return [Math.sin(a) * r * Math.cos(e), r * Math.sin(e), Math.cos(a) * r * Math.cos(e)];
  }

  // On portrait / narrow screens the vertical FOV frames the boat much larger,
  // so pull the camera back and up proportionally to keep a comfortable view.
  _fit() {
    const aspect = this.camera.aspect || 1;
    const k = aspect < 1 ? 1 + (1 - aspect) * 1.15 : 1;
    return { dist: this.cfg.distance * k, height: this.cfg.height * (aspect < 1 ? 1 + (1 - aspect) * 0.5 : 1) };
  }

  update(dt, boat, time) {
    if (!this.enabled) return;

    // Behind the boat (bow is -Z), lifted up, as framed by the player.
    const [ox, oy, oz] = this._offset(boat);
    this._desired.set(
      boat.position.x + ox,
      boat.position.y + oy + Math.sin(time * 0.6) * 0.4,
      boat.position.z + oz,
    );

    const k = 1 - Math.pow(0.0001, dt * CAMERA.damping);
    this.camera.position.lerp(this._desired, k);
    this._keepOut(boat);

    // ... nor under the sea.
    if (this.waterAt) {
      const p = this.camera.position;
      const w = this.waterAt(p.x, p.z, time) + 1.2;
      if (p.y < w) p.y = w;
    }

    // Never let the camera sink into a cliff.
    if (this.groundAt) {
      const g = this.groundAt(this.camera.position.x, this.camera.position.z) + 6;
      if (this.camera.position.y < g) this.camera.position.y = g;
    }

    this._look.set(
      boat.position.x,
      boat.position.y + this.cfg.lookHeight,
      boat.position.z,
    );
    this._lookCurrent.lerp(this._look, k);
    this.camera.lookAt(this._lookCurrent);
  }

  // If the camera has got into the ship, move it straight out from the point
  // it looks at until it is clear (in effect, the closest it may zoom from
  // that side).
  _keepOut(boat) {
    const m = boat.model;
    if (!m) return;
    m.updateMatrixWorld();
    _inv.copy(m.matrixWorld).invert();
    _p.copy(this.camera.position).applyMatrix4(_inv);
    const boxes = this.cfg.keepOut;
    if (!inside(_p, boxes)) return;
    _c.set(0, this.cfg.lookHeight, 0);
    _d.copy(_p).sub(_c);
    if (_d.lengthSq() < 1e-4) _d.set(0, 0.3, 1);
    let t = 1;
    for (let i = 0; i < 80; i++) {
      _q.copy(_c).addScaledVector(_d, t);
      if (!inside(_q, boxes)) break;
      t *= 1.05;
    }
    this.camera.position.copy(_q.applyMatrix4(m.matrixWorld));
  }

  snap(boat) {
    const [ox, oy, oz] = this._offset(boat);
    this.camera.position.set(boat.position.x + ox, boat.position.y + oy, boat.position.z + oz);
    this._lookCurrent.set(boat.position.x, boat.position.y + this.cfg.lookHeight, boat.position.z);
    this.camera.lookAt(this._lookCurrent);
  }
}
