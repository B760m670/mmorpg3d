import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { BOAT } from '../config.js';
import { sampleWater } from '../world/waves.js';

// The player's vessel: a 23.95 m stern trawler modelled in Blender
// (blender/build_trawler.py) and loaded as glTF. 1 unit = 1 m, the model's
// origin is amidships on the waterline and its bow points to -Z.
// A simple box stand-in is shown until the model has loaded.

function base64ToArrayBuffer(dataUrl) {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export class Boat {
  constructor() {
    this.group = new THREE.Group();

    // Stand-in until the glTF arrives.
    this.placeholder = new THREE.Mesh(
      new THREE.BoxGeometry(BOAT.beam, 4, BOAT.length),
      new THREE.MeshStandardMaterial({ color: 0x7a2018, roughness: 0.6 }),
    );
    this.placeholder.position.y = 1;
    this.group.add(this.placeholder);

    // State
    this.position = new THREE.Vector3(0, 0, 0);
    this.heading = 0; // yaw, radians
    this.speed = 0;   // forward speed, m/s
    this.heel = 0;    // roll from turning, radians
    this._up = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._qHeel = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._fwdPlane = new THREE.Vector3();
  }

  get object() {
    return this.group;
  }

  // url may be a normal URL or a base64 data: URL (single-file builds).
  load(url) {
    const loader = new GLTFLoader();
    const onLoad = (gltf) => {
      const model = gltf.scene;
      model.traverse((o) => {
        if (o.isMesh && o.material) {
          const m = o.material;
          // Glass and paint should pick up the sky reflection.
          if (m.name === 'glass') { m.envMapIntensity = 1.6; }
          if (m.name && m.name.startsWith('light_')) { m.toneMapped = false; }
        }
      });
      this.group.remove(this.placeholder);
      this.placeholder.geometry.dispose();
      this.group.add(model);
      this.model = model;
    };
    const onError = (e) => console.error('trawler model failed to load', e);
    if (url.startsWith('data:')) {
      loader.parse(base64ToArrayBuffer(url), '', onLoad, onError);
    } else {
      loader.load(url, onLoad, undefined, onError);
    }
  }

  // canMove(x, z) -> boolean: optional world query for deep-enough water.
  update(dt, input, time, canMove = null) {
    // Longitudinal: thrust minus linear drag, so full throttle settles at
    // maxSpeed and the vessel coasts to a stop when the throttle is released.
    const drag = BOAT.acceleration / BOAT.maxSpeed;
    const thrust = input.throttle * BOAT.acceleration * (input.throttle < 0 ? 0.5 : 1);
    this.speed += (thrust - drag * this.speed) * dt;
    if (Math.abs(this.speed) < 0.01 && input.throttle === 0) this.speed = 0;

    // Rudder needs water flow over it.
    const authority = THREE.MathUtils.clamp(Math.abs(this.speed) / 3, 0, 1);
    const yawRate = input.steer * BOAT.turnRate * authority * Math.sign(this.speed || 1);
    this.heading += yawRate * dt;

    // Heel outward in a turn, proportional to speed x turn rate. Positive
    // yawRate turns to port, so the vessel leans to starboard (negative roll
    // about the aft-pointing local Z axis).
    const targetHeel = THREE.MathUtils.clamp(-yawRate * this.speed * BOAT.heelFactor, -0.12, 0.12);
    this.heel += (targetHeel - this.heel) * (1 - Math.exp(-dt * 1.5));

    // Forward vector (-Z is the bow)
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    const nx = this.position.x - fx * this.speed * dt;
    const nz = this.position.z - fz * this.speed * dt;
    // Probe ahead of the bow (or astern when reversing) so the hull stops
    // before it visibly enters the rock.
    const probe = Math.sign(this.speed) * (BOAT.length / 2 + 3);
    if (!canMove || canMove(nx - fx * probe, nz - fz * probe)) {
      this.position.x = nx;
      this.position.z = nz;
    } else {
      this.speed *= -0.2; // bump off the shore
    }

    // Buoyancy: average the wave surface under bow, stern and both sides.
    const lh = BOAT.length * 0.38;
    const bh = BOAT.beam * 0.42;
    const c = sampleWater(this.position.x, this.position.z, time);
    // sampleWater reuses its normal object, so copy it before sampling again.
    const up = this._up.set(c.normal.x, c.normal.y, c.normal.z);
    let hSum = c.height;
    const pts = [
      [-fx * lh, -fz * lh], [fx * lh, fz * lh],
      [fz * bh, -fx * bh], [-fz * bh, fx * bh],
    ];
    for (const [ox, oz] of pts) {
      const w = sampleWater(this.position.x + ox, this.position.z + oz, time);
      hSum += w.height;
      up.x += w.normal.x; up.y += w.normal.y; up.z += w.normal.z;
    }
    // A long, heavy hull averages the waves: damp the slope a little.
    up.y *= 1.6;
    up.normalize();
    const targetY = hSum / 5;
    this.position.y += (targetY - this.position.y) * (1 - Math.exp(-dt * 4));

    // Orient: yaw to heading, tilt to the averaged wave normal, then heel.
    this._fwd.set(-fx, 0, -fz);
    this._right.crossVectors(this._fwd, up).normalize();
    this._fwdPlane.crossVectors(up, this._right).normalize();
    this._m.makeBasis(this._right, up, this._fwdPlane.multiplyScalar(-1));
    this._q.setFromRotationMatrix(this._m);
    this._qHeel.setFromAxisAngle(new THREE.Vector3(0, 0, 1), this.heel);
    this._q.multiply(this._qHeel);

    this.group.position.copy(this.position);
    this.group.quaternion.slerp(this._q, 1 - Math.exp(-dt * 3));
  }
}
