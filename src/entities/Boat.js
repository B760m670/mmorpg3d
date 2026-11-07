import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { BOAT, TELEGRAPH } from '../config.js';
import { sampleWater } from '../world/waves.js';

// The 23.95 m stern trawler: a Blender-built model (blender/build_trawler.py)
// and the ship-handling model that drives it.
//
// Handling is deliberately physical rather than arcade:
//   * an engine-order telegraph sets propeller power; engine rpm lags the
//     order; thrust falls off with speed (propeller in nozzle);
//   * quadratic hull resistance, ~450 t of mass: it takes the better part of a
//     minute to reach 12 kn and as long to stop;
//   * the helmsman winds a wheel order, the steering gear follows at
//     2.5 deg/s up to 35 deg, and a first-order Nomoto model turns rudder into
//     rate of turn (needs water flow: speed or propeller wash);
//   * the ship heels outward in a turn and loses speed while turning.
//
// 1 unit = 1 m. The glTF origin is amidships on the design waterline, bow -Z.

const DEG = Math.PI / 180;
const STOP_INDEX = TELEGRAPH.findIndex((t) => t.power === 0);

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
    this.placeholder = new THREE.Mesh(
      new THREE.BoxGeometry(BOAT.beam, 4, BOAT.length),
      new THREE.MeshStandardMaterial({ color: 0x7a2018, roughness: 0.6 }),
    );
    this.placeholder.position.y = 1;
    this.group.add(this.placeholder);

    // Kinematic state
    this.position = new THREE.Vector3();
    this.heading = 0;   // rad; forward = (-sin, 0, -cos); + turns to port
    this.speed = 0;     // m/s through the water (negative = astern)
    this.yawRate = 0;   // rad/s
    this.heel = 0;      // rad

    // Controls & machinery
    this.telegraph = STOP_INDEX;
    this.wheel = 0;      // deg, helm order (+ = port)
    this.rudder = 0;     // deg, actual rudder angle
    this.rpm = 0;        // fraction of max, signed (astern < 0)

    this.model = null;
    this.collider = null; // invisible walk/collision mesh, in model space

    this._up = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._qHeel = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._fwdPlane = new THREE.Vector3();
    this._zAxis = new THREE.Vector3(0, 0, 1);
  }

  get object() {
    return this.group;
  }

  get telegraphOrder() {
    return TELEGRAPH[this.telegraph];
  }

  // ---------------------------------------------------------------- model
  load(url, onReady) {
    const loader = new GLTFLoader();
    const onLoad = (gltf) => {
      const model = gltf.scene;
      model.position.y = BOAT.rideHeight;
      model.traverse((o) => {
        if (!o.isMesh) return;
        if (o.name === 'collision' || (o.material && o.material.name === 'collision')) {
          o.visible = false;
          // Detached copy at identity: rays are cast in model space.
          const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
          this.collider = new THREE.Mesh(o.geometry, mat);
          this.collider.updateMatrixWorld(true);
          return;
        }
        o.castShadow = true;
        o.receiveShadow = true;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (!m) continue;
          if (m.name === 'glass') {
            m.transparent = true;
            m.opacity = 0.28;
            m.depthWrite = false;
            m.side = THREE.DoubleSide;
            m.envMapIntensity = 1.6;
            m.roughness = 0.05;
            o.castShadow = false;
          } else if (m.name.startsWith('light_')) {
            m.toneMapped = false;
          } else {
            m.envMapIntensity = 0.55;
          }
        }
      });
      // Glass is a separate primitive; glTF splits multi-material meshes into
      // child meshes, so the flags above landed on the right ones.
      this.group.remove(this.placeholder);
      this.placeholder.geometry.dispose();
      this.group.add(model);
      this.model = model;
      if (onReady) onReady(this);
    };
    const onError = (e) => console.error('trawler model failed to load', e);
    if (url.startsWith('data:')) {
      loader.parse(base64ToArrayBuffer(url), '', onLoad, onError);
    } else {
      loader.load(url, onLoad, undefined, onError);
    }
  }

  // ---------------------------------------------------------------- controls
  telegraphStep(dir) {
    this.telegraph = THREE.MathUtils.clamp(this.telegraph + dir, 0, TELEGRAPH.length - 1);
  }

  midships() {
    this.wheel = 0;
  }

  // helm: { turn: -1..1 wind the wheel (keyboard), target: deg|null (touch) }
  steer(dt, helm) {
    if (helm && helm.target != null) {
      this.wheel = THREE.MathUtils.clamp(helm.target, -BOAT.rudderMax, BOAT.rudderMax);
    } else if (helm && helm.turn) {
      this.wheel = THREE.MathUtils.clamp(this.wheel + helm.turn * BOAT.wheelRate * dt, -BOAT.rudderMax, BOAT.rudderMax);
    }
  }

  // ---------------------------------------------------------------- physics
  update(dt, time, canMove = null) {
    // Engine follows the telegraph with a lag.
    const order = TELEGRAPH[this.telegraph].power;
    this.rpm += (order - this.rpm) * (1 - Math.exp(-dt / BOAT.rpmLag));

    // Steering gear chases the wheel order at a limited rate.
    const dr = THREE.MathUtils.clamp(this.wheel - this.rudder, -BOAT.rudderRate * dt, BOAT.rudderRate * dt);
    this.rudder += dr;

    // Surge: propeller thrust (∝ n²) minus quadratic resistance.
    const u = this.speed;
    const n = this.rpm;
    let thrust = BOAT.bollardPull * n * Math.abs(n);
    if (n >= 0) thrust *= Math.max(0, 1 - 0.5 * Math.max(u, 0) / BOAT.maxSpeed);
    else thrust *= BOAT.asternEfficiency;
    const c = (BOAT.bollardPull * 0.5) / (BOAT.maxSpeed * BOAT.maxSpeed);
    const resistance = c * u * Math.abs(u);
    let accel = (thrust - resistance) / BOAT.mass;
    accel -= 0.35 * Math.abs(this.yawRate) * u;      // speed lost in a turn
    this.speed += accel * dt;

    // Yaw: Nomoto. Rudder needs flow: ship speed plus propeller wash.
    const wash = 2.5 * Math.max(0, n);
    const flow = u >= 0 ? u + wash : -0.4 * Math.abs(u) + wash;
    const k = BOAT.yawGain * (flow / BOAT.refSpeed);
    const target = k * this.rudder * DEG;
    this.yawRate += (target - this.yawRate) * (dt / BOAT.yawTime);
    this.heading += this.yawRate * dt;

    // Heel outward in a turn (port turn -> lean to starboard).
    const targetHeel = THREE.MathUtils.clamp(-BOAT.heelFactor * u * this.yawRate, -0.12, 0.12);
    this.heel += (targetHeel - this.heel) * (1 - Math.exp(-dt * 0.8));

    // Move; stop dead against the shore.
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    const nx = this.position.x - fx * this.speed * dt;
    const nz = this.position.z - fz * this.speed * dt;
    const probe = Math.sign(this.speed || 1) * (BOAT.length / 2 + 2);
    if (!canMove || canMove(nx - fx * probe, nz - fz * probe)) {
      this.position.x = nx;
      this.position.z = nz;
    } else {
      this.speed *= -0.15;
      this.yawRate *= 0.5;
    }

    // Buoyancy: average the wave surface under bow, stern and both sides.
    const lh = BOAT.length * 0.38;
    const bh = BOAT.beam * 0.42;
    const cw = sampleWater(this.position.x, this.position.z, time);
    const up = this._up.set(cw.normal.x, cw.normal.y, cw.normal.z);
    let hSum = cw.height;
    const pts = [[-fx * lh, -fz * lh], [fx * lh, fz * lh], [fz * bh, -fx * bh], [-fz * bh, fx * bh]];
    for (const [ox, oz] of pts) {
      const w = sampleWater(this.position.x + ox, this.position.z + oz, time);
      hSum += w.height;
      up.x += w.normal.x; up.y += w.normal.y; up.z += w.normal.z;
    }
    up.y *= 1.8;  // a 400 t hull averages the waves
    up.normalize();
    this.position.y += (hSum / 5 - this.position.y) * (1 - Math.exp(-dt * 3));

    this._fwd.set(-fx, 0, -fz);
    this._right.crossVectors(this._fwd, up).normalize();
    this._fwdPlane.crossVectors(up, this._right).normalize();
    this._m.makeBasis(this._right, up, this._fwdPlane.multiplyScalar(-1));
    this._q.setFromRotationMatrix(this._m);
    this._qHeel.setFromAxisAngle(this._zAxis, this.heel);
    this._q.multiply(this._qHeel);

    this.group.position.copy(this.position);
    this.group.quaternion.slerp(this._q, 1 - Math.exp(-dt * 2.5));
    this.group.updateMatrixWorld(true);
  }

  // Bridge instrument readings.
  get knots() {
    return this.speed * 1.943844;
  }

  get headingDeg() {
    return ((-this.heading / DEG) % 360 + 360) % 360;
  }
}
