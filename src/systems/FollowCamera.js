import * as THREE from 'three';
import { CAMERA } from '../config.js';

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
    this.yaw = 0;
    this.pitch = 0;
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
    return { dist: CAMERA.distance * k, height: CAMERA.height * (aspect < 1 ? 1 + (1 - aspect) * 0.5 : 1) };
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

    // Never let the camera sink into a cliff.
    if (this.groundAt) {
      const g = this.groundAt(this.camera.position.x, this.camera.position.z) + 6;
      if (this.camera.position.y < g) this.camera.position.y = g;
    }

    this._look.set(
      boat.position.x,
      boat.position.y + CAMERA.lookHeight,
      boat.position.z,
    );
    this._lookCurrent.lerp(this._look, k);
    this.camera.lookAt(this._lookCurrent);
  }

  snap(boat) {
    const [ox, oy, oz] = this._offset(boat);
    this.camera.position.set(boat.position.x + ox, boat.position.y + oy, boat.position.z + oz);
    this._lookCurrent.set(boat.position.x, boat.position.y + CAMERA.lookHeight, boat.position.z);
    this.camera.lookAt(this._lookCurrent);
  }
}
