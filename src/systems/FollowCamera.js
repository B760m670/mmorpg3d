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

    const fx = Math.sin(boat.heading);
    const fz = Math.cos(boat.heading);
    const { dist, height } = this._fit();

    // Behind the boat (bow is -Z), lifted up.
    this._desired.set(
      boat.position.x + fx * dist,
      boat.position.y + height + Math.sin(time * 0.6) * 0.4,
      boat.position.z + fz * dist,
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
    const fx = Math.sin(boat.heading);
    const fz = Math.cos(boat.heading);
    const { dist, height } = this._fit();
    this.camera.position.set(
      boat.position.x + fx * dist,
      boat.position.y + height,
      boat.position.z + fz * dist,
    );
    this._lookCurrent.set(boat.position.x, boat.position.y + CAMERA.lookHeight, boat.position.z);
    this.camera.lookAt(this._lookCurrent);
  }
}
