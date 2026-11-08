import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { BOAT, TELEGRAPH } from '../config.js';

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
    this.heel = 0;      // rad, from turning
    this.pitch = 0;     // rad, bow up +
    this.roll = 0;      // rad, starboard up +
    this.pitchV = 0;
    this.rollV = 0;
    this.heaveV = 0;
    this.bowImm = 0;      // water above the bow's waterline point (m)
    this.slam = 0;        // 0..1 on the frame the bow slams into a wave
    this.slamCooldown = 0;
    this.bowSpray = 0;    // 0..1 continuous bow spray

    // Controls & machinery
    this.telegraph = STOP_INDEX;
    this.wheel = 0;      // deg, helm order (+ = port)
    this.rudder = 0;     // deg, actual rudder angle
    this.rpm = 0;        // fraction of max, signed (astern < 0)
    this.engineRunning = true;   // main engine (Sensors starts and stops it)
    this.steeringPumps = 1;      // hydraulic steering pumps running (electrical plant)
    this.drift = { x: 0, z: 0 }; // wind drift over the ground (m/s), set each frame
    this.constrain = null;       // (dt) => {}: the anchor chain, after she moves
    this.towDrag = 0;            // N: the trawl gear's drag, set each frame

    this.model = null;
    this.collider = null; // invisible walk/collision mesh, in model space

    this._euler = new THREE.Euler();
    this._q = new THREE.Quaternion();
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
        const below = o.name === 'interior' || (o.parent && o.parent.name === 'interior');
        if (below) this.interior = o.name === 'interior' ? o : o.parent;
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
            // below decks there is no sky to reflect
            m.envMapIntensity = below ? 0.08 : 0.55;
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
    // (a stopped engine turns no propeller whatever the telegraph says)
    const order = this.engineRunning ? TELEGRAPH[this.telegraph].power : 0;
    this.rpm += (order - this.rpm) * (1 - Math.exp(-dt / (this.engineRunning ? BOAT.rpmLag : 4)));

    // Steering gear chases the wheel order at a limited rate, driven by its
    // hydraulic pumps: one pump gives the rated speed, two a little more;
    // none (a blackout) and the rudder stays where it is.
    const rate = BOAT.rudderRate * (this.steeringPumps >= 2 ? 1.6 : this.steeringPumps >= 1 ? 1 : 0);
    const dr = THREE.MathUtils.clamp(this.wheel - this.rudder, -rate * dt, rate * dt);
    this.rudder += dr;
    this.rudderRate = dt > 0 ? dr / dt : 0;

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
    accel -= this.towDrag / BOAT.mass;               // the trawl
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
    const nx = this.position.x - fx * this.speed * dt + this.drift.x * dt;
    const nz = this.position.z - fz * this.speed * dt + this.drift.z * dt;
    const probe = Math.sign(this.speed || 1) * (BOAT.length / 2 + 2);
    if (!canMove || canMove(nx - fx * probe, nz - fz * probe)) {
      this.position.x = nx;
      this.position.z = nz;
    } else {
      this.speed *= -0.15;
      this.yawRate *= 0.5;
    }
    if (this.constrain) this.constrain(dt);

    // Seakeeping. Heave follows the mean water level under the hull; pitch
    // and roll are driven by the slope of the water between bow and stern and
    // between the two sides, through second-order responses with the ship's
    // natural periods (roll ~8 s, lightly damped: she rolls hardest when the
    // waves meet her at her own rhythm, as real ships do).
    const lh = BOAT.length * 0.4;
    const bh = BOAT.beam * 0.45;
    const water = this.water;
    const px = this.position.x, pz = this.position.z;
    const rx = fz, rz = -fx;                       // starboard
    const hC = water(px, pz, time).height;
    const hBow = water(px - fx * lh, pz - fz * lh, time).height;
    const hStern = water(px + fx * lh, pz + fz * lh, time).height;
    const hStbd = water(px + rx * bh, pz + rz * bh, time).height;
    const hPort = water(px - rx * bh, pz - rz * bh, time).height;
    const hMean = (hC * 2 + hBow + hStern + hStbd + hPort) / 6;
    const sm = BOAT.seakeeping;
    this.heaveV += ((sm.heaveW ** 2) * (hMean - this.position.y) - 2 * sm.heaveZeta * sm.heaveW * this.heaveV) * dt;
    this.position.y += this.heaveV * dt;
    const pitchT = Math.atan2(hBow - hStern, 2 * lh);
    const rollT = Math.atan2(hStbd - hPort, 2 * bh);
    this.pitchV += ((sm.pitchW ** 2) * (pitchT - this.pitch) - 2 * sm.pitchZeta * sm.pitchW * this.pitchV) * dt;
    this.pitch += this.pitchV * dt;
    this.rollV += ((sm.rollW ** 2) * (rollT - this.roll) - 2 * sm.rollZeta * sm.rollW * this.rollV) * dt;
    this.roll = THREE.MathUtils.clamp(this.roll + this.rollV * dt, -0.6, 0.6);

    // Bow impact: the water rising fast against a plunging bow. Drives the
    // spray and the slam you hear and feel.
    const bowY = this.position.y + Math.sin(this.pitch) * lh;
    const imm = hBow - bowY;
    const immRate = dt > 0 ? (imm - this.bowImm) / dt : 0;
    this.bowImm = imm;
    this.slamCooldown -= dt;
    this.slam = 0;
    if (imm > -0.5 && immRate > 2.1 && this.slamCooldown <= 0 && this.speed > 0.5) {
      this.slam = Math.min(1, (immRate - 2.1) / 3 + 0.2) * Math.min(1, this.speed / 4);
      this.slamCooldown = 0.9;
    }
    this.bowSpray = Math.min(1, Math.max(0, this.speed) / 6) * Math.min(1, Math.max(0, immRate) / 2.5);

    this._euler.set(this.pitch, this.heading, this.roll + this.heel, 'YXZ');
    this._q.setFromEuler(this._euler);

    this.group.position.copy(this.position);
    this.group.quaternion.copy(this._q);
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
