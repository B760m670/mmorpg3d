import * as THREE from 'three';
import { BOAT, PLAYER } from '../config.js';

// A person aboard the trawler, seen in first person.
//
// The player lives in the vessel's own (model) coordinates, so the ship's
// motion — heave, pitch, roll, heading, speed — carries them along exactly as
// it would a real crew member. Collision uses the invisible low-poly mesh
// exported with the model: rays down find the deck (stairs, door sills),
// horizontal rays stop you at bulwarks, rails, walls and machinery.

const DOWN = new THREE.Vector3(0, -1, 0);
const _tmp = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _qShip = new THREE.Quaternion();
const _qLook = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

export class Player {
  constructor(camera) {
    this.camera = camera;
    this.pos = new THREE.Vector3(...BOAT.bridgeSpawn); // model space, feet
    this.yaw = 0;      // 0 = looking toward the bow (-Z)
    this.pitch = -0.05;
    this.vy = 0;
    this.lastSafe = this.pos.clone();
    this.bob = 0;
    this.ray = new THREE.Raycaster();
    this.helmPoint = new THREE.Vector3(...BOAT.helm);
  }

  get nearHelm() {
    _tmp.copy(this.pos).sub(this.helmPoint);
    return Math.hypot(_tmp.x, _tmp.z) < 1.4 && Math.abs(_tmp.y) < 0.8;
  }

  takeHelm() {
    this.pos.copy(this.helmPoint);
    this.vy = 0;
    this.yaw = 0;
    this.pitch = -0.08;
  }

  look(dx, dy) {
    this.yaw -= dx * PLAYER.lookSensitivity;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * PLAYER.lookSensitivity, -1.35, 1.35);
  }

  _cast(origin, dir, far, collider) {
    this.ray.set(origin, dir);
    this.ray.far = far;
    const hits = this.ray.intersectObject(collider, false);
    return hits.length ? hits[0] : null;
  }

  // moveX/moveY in -1..1 (right / forward), run: boolean
  update(dt, moveX, moveY, run, collider) {
    if (!collider) return;
    const speed = run ? PLAYER.runSpeed : PLAYER.walkSpeed;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    // forward (-Z rotated by yaw) and right
    const mv = new THREE.Vector3(
      (-sin * moveY + cos * moveX) * speed * dt,
      0,
      (-cos * moveY - sin * moveX) * speed * dt,
    );
    const len = mv.length();
    if (len > 1e-5) this.bob += len * 6;

    // Slide along walls: rays at knee, waist and head height.
    for (let pass = 0; pass < 2 && mv.lengthSq() > 1e-10; pass++) {
      _dir.copy(mv).normalize();
      let hit = null;
      for (const h of [0.35, 1.0, 1.6]) {
        _tmp.copy(this.pos).y += h;
        const r = this._cast(_tmp, _dir, mv.length() + PLAYER.radius, collider);
        if (r && (!hit || r.distance < hit.distance)) hit = r;
      }
      if (!hit || !hit.face) break;
      const n = hit.face.normal.clone();
      n.y = 0;
      if (n.lengthSq() < 1e-6) break;
      n.normalize();
      if (n.dot(_dir) > 0) n.negate();
      const into = mv.dot(n);
      if (into < 0) mv.addScaledVector(n, -into);
      const allowed = Math.max(0, hit.distance - PLAYER.radius);
      if (mv.length() > allowed + 1e-3 && mv.clone().normalize().dot(_dir) > 0.99) mv.setLength(allowed);
    }

    // Ground under the new position.
    const next = _tmp.copy(this.pos).add(mv);
    const origin = next.clone();
    origin.y += PLAYER.stepHeight + 0.5;
    const floor = this._cast(origin, DOWN, 8, collider);
    let blocked = false;
    if (floor) {
      const rise = floor.point.y - this.pos.y;
      const steep = floor.face && floor.face.normal.y < 0.72;
      if (rise > PLAYER.stepHeight || (steep && rise > 0.05)) blocked = true;
    }
    if (!blocked) {
      this.pos.x = next.x;
      this.pos.z = next.z;
    }

    // Gravity and stepping.
    const under = this._cast(_eye.copy(this.pos).setY(this.pos.y + PLAYER.stepHeight + 0.5), DOWN, 30, collider);
    const floorY = under ? under.point.y : -Infinity;
    if (this.pos.y - floorY > 0.06) {
      this.vy -= 9.81 * dt;
      this.pos.y += this.vy * dt;
      if (this.pos.y < floorY) { this.pos.y = floorY; this.vy = 0; }
    } else {
      // walk up steps / sills smoothly
      this.pos.y += (floorY - this.pos.y) * Math.min(1, dt * 18);
      this.vy = 0;
      if (floorY > 4.0) this.lastSafe.copy(this.pos);
    }
    // Over the side, or down a gap into the hull below the working deck
    // (4.3 m): back aboard where we last stood.
    if (this.pos.y < 3.6 || Math.abs(this.pos.x) > 5.2 || Math.abs(this.pos.z) > 12.6) {
      this.pos.copy(this.lastSafe);
      this.vy = 0;
    }
  }

  // Put the camera at eye height, in the ship's frame (you feel her roll).
  updateCamera(model) {
    if (!model) return;
    const bob = Math.sin(this.bob) * 0.025;
    _eye.set(this.pos.x, this.pos.y + PLAYER.eyeHeight + bob, this.pos.z);
    model.localToWorld(_eye);
    this.camera.position.copy(_eye);
    model.getWorldQuaternion(_qShip);
    _euler.set(this.pitch, this.yaw, 0, 'YXZ');
    _qLook.setFromEuler(_euler);
    this.camera.quaternion.copy(_qShip).multiply(_qLook);
  }
}
