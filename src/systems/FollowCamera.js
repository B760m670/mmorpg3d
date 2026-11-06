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

  update(dt, boat, time) {
    if (!this.enabled) return;

    const fx = Math.sin(boat.heading);
    const fz = Math.cos(boat.heading);

    // Behind the boat (bow is -Z), lifted up.
    this._desired.set(
      boat.position.x + fx * CAMERA.distance,
      boat.position.y + CAMERA.height + Math.sin(time * 0.6) * 0.4,
      boat.position.z + fz * CAMERA.distance,
    );

    const k = 1 - Math.pow(0.0001, dt * CAMERA.damping);
    this.camera.position.lerp(this._desired, k);

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
    this.camera.position.set(
      boat.position.x + fx * CAMERA.distance,
      boat.position.y + CAMERA.height,
      boat.position.z + fz * CAMERA.distance,
    );
    this._lookCurrent.set(boat.position.x, boat.position.y + CAMERA.lookHeight, boat.position.z);
    this.camera.lookAt(this._lookCurrent);
  }
}
