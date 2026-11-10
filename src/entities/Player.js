import * as THREE from 'three';
import { PLAYER } from '../config.js';

// You aboard the ship, seen in first person.
//
// The player lives in the ship's own (model) coordinates, so her motion —
// heave, pitch, roll, heel, heading, speed — carries you along exactly as it
// would anyone aboard. Collision uses the invisible low-poly mesh exported
// with the model: rays down find the deck (ladders, sills, the steps of a
// break), rays across stop you at the sides, bulkheads, guns and casks.
//
// set({ helm, bounds }) from the model's access data:
//   helm    where the helmsman stands at the whipstaff
//   bounds  { yMin, xMax, zMin, zMax }: outside them you are put back where
//           you last stood

const DOWN = new THREE.Vector3(0, -1, 0);
const _tmp = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _mv = new THREE.Vector3();
const _n = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _qShip = new THREE.Quaternion();
const _qLook = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

export class Player {
  constructor(camera) {
    this.camera = camera;
    this.pos = new THREE.Vector3();    // model space, feet
    this.yaw = 0;      // 0 = looking toward the bow (-Z)
    this.pitch = -0.05;
    this.vy = 0;
    this.lastSafe = this.pos.clone();
    this.bob = 0;
    this.ray = new THREE.Raycaster();
    this.helmPoint = new THREE.Vector3();
    this.bounds = { yMin: -10, xMax: 10, zMin: -40, zMax: 40 };
    this.climb = null;
  }

  set({ helm, bounds }) {
    if (helm) this.helmPoint.set(...helm);
    if (bounds) this.bounds = bounds;
  }

  place(p, yaw = 0) {
    this.pos.set(...p);
    this.lastSafe.copy(this.pos);
    this.vy = 0;
    this.yaw = yaw;
    this.pitch = -0.05;
    this.climb = null;
  }

  get nearHelm() {
    _tmp.copy(this.pos).sub(this.helmPoint);
    return !this.climb && Math.hypot(_tmp.x, _tmp.z) < 1.3 && Math.abs(_tmp.y) < 0.8;
  }

  takeHelm() {
    this.pos.copy(this.helmPoint);
    this.vy = 0;
    this.yaw = 0;
    this.pitch = -0.12;      // the whipstaff and the binnacle in front of you
    this.climb = null;
  }

  // ladders and shrouds: on one you go up and down it (W/S), facing it, and
  // step off at the top or the bottom
  startClimb(l, fromTop) {
    this.climb = { l, t: fromTop ? 1 : 0, len: l.a.distanceTo(l.b) };
    this.vy = 0;
    this.yaw = l.face;
    this.pitch = fromTop ? -0.5 : 0.5;
    this.pos.copy(fromTop ? l.b : l.a);
  }

  updateClimb(dt, moveY) {
    const c = this.climb;
    c.t += (moveY * (c.l.speed || 0.55) * dt) / c.len;
    if (Math.abs(moveY) > 0.05) this.bob += Math.abs(moveY) * dt * 5;
    if (c.t >= 1 && moveY > 0) { this.pos.copy(c.l.top); this.climb = null; this.lastSafe.copy(this.pos); return 'top'; }
    if (c.t <= 0 && moveY < 0) { this.pos.copy(c.l.bottom); this.climb = null; this.lastSafe.copy(this.pos); return 'bottom'; }
    c.t = THREE.MathUtils.clamp(c.t, 0, 1);
    this.pos.lerpVectors(c.l.a, c.l.b, c.t);
    return null;
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

  // First thing in the way that is a wall, not a stair or ramp: a steep
  // ladder (up to ~57 deg) meets the knee ray before the feet get there, but
  // the floor test below decides whether it can be climbed.
  _castWall(origin, dir, far, collider) {
    this.ray.set(origin, dir);
    this.ray.far = far;
    for (const h of this.ray.intersectObject(collider, false)) {
      if (!h.face || Math.abs(h.face.normal.y) < 0.5) return h;
    }
    return null;
  }

  // Is there a deck (or anything) over your head within `far` metres?
  covered(collider, far = 6) {
    if (!collider) return false;
    _origin.copy(this.pos).y += 1.7;
    this.ray.set(_origin, _dir.set(0, 1, 0));
    this.ray.far = far;
    return this.ray.intersectObject(collider, false).length > 0;
  }

  // moveX/moveY in -1..1 (right / forward), run: boolean
  update(dt, moveX, moveY, run, collider) {
    if (!collider) return;
    if (this.climb) { this.updateClimb(dt, moveY); return; }
    const speed = run ? PLAYER.runSpeed : PLAYER.walkSpeed;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    // forward (-Z rotated by yaw) and right
    const mv = _mv.set(
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
        const r = this._castWall(_tmp, _dir, mv.length() + PLAYER.radius, collider);
        if (r && (!hit || r.distance < hit.distance)) hit = r;
      }
      if (!hit || !hit.face) break;
      const n = _n.copy(hit.face.normal);
      n.y = 0;
      if (n.lengthSq() < 1e-6) break;
      n.normalize();
      if (n.dot(_dir) > 0) n.negate();
      const into = mv.dot(n);
      if (into < 0) mv.addScaledVector(n, -into);
      const allowed = Math.max(0, hit.distance - PLAYER.radius);
      if (mv.length() > allowed + 1e-3 && _tmp.copy(mv).normalize().dot(_dir) > 0.99) mv.setLength(allowed);
    }

    // Ground under the new position.
    const nx = this.pos.x + mv.x, nz = this.pos.z + mv.z;
    _origin.set(nx, this.pos.y + PLAYER.stepHeight + 0.5, nz);
    const floor = this._cast(_origin, DOWN, 8, collider);
    let blocked = false;
    if (floor) {
      const rise = floor.point.y - this.pos.y;
      const steep = floor.face && Math.abs(floor.face.normal.y) < 0.52;   // ship's ladders are 42-57 deg
      if (rise > PLAYER.stepHeight || (steep && rise > 0.05)) blocked = true;
    }
    if (!blocked) {
      this.pos.x = nx;
      this.pos.z = nz;
    }

    // Gravity and stepping.
    const under = this._cast(_eye.copy(this.pos).setY(this.pos.y + PLAYER.stepHeight + 0.5), DOWN, 40, collider);
    const floorY = under ? under.point.y : -Infinity;
    if (this.pos.y - floorY > 0.06) {
      this.vy -= 9.81 * dt;
      this.pos.y += this.vy * dt;
      if (this.pos.y < floorY) { this.pos.y = floorY; this.vy = 0; }
    } else {
      // walk up steps and sills smoothly
      this.pos.y += (floorY - this.pos.y) * Math.min(1, dt * 18);
      this.vy = 0;
      this.lastSafe.copy(this.pos);
    }
    // Over the side, or through a gap below the hold: back where we last stood.
    const b = this.bounds;
    if (this.pos.y < b.yMin || Math.abs(this.pos.x) > b.xMax || this.pos.z < b.zMin || this.pos.z > b.zMax) {
      this.pos.copy(this.lastSafe);
      this.vy = 0;
    }
  }

  // Put the camera at eye height, in the ship's frame (you feel her roll).
  updateCamera(model) {
    if (!model) return;
    const bob = this.climb ? 0 : Math.sin(this.bob) * 0.025;
    _eye.set(this.pos.x, this.pos.y + PLAYER.eyeHeight + bob, this.pos.z);
    model.localToWorld(_eye);
    this.camera.position.copy(_eye);
    model.getWorldQuaternion(_qShip);
    _euler.set(this.pitch, this.yaw, 0, 'YXZ');
    _qLook.setFromEuler(_euler);
    this.camera.quaternion.copy(_qShip).multiply(_qLook);
  }
}
