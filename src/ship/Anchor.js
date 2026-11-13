import * as THREE from 'three';
import { shipMaterial } from './Materials.js';

// The best bower, worked as at sea:
//   * catted: hung from the cathead by its ring, ready;
//   * let go: it drops (through the air, then sinking at a few metres a
//     second) to the bottom; the cable runs out through the hawse after it
//     until she has a scope of four or five times the depth;
//   * riding to it: the cable, hanging in a curve (and lying on the bottom
//     where it is slack), holds her; she swings head to the anchor, to
//     wind and sea;
//   * weighing: the capstan is manned (the bars shipped), the cable comes in
//     at about 15 m a minute and heaves her up to her anchor; when the cable
//     is up and down the anchor breaks out, comes up to the hawse and is
//     catted again.
// Too deep (more than 90 m) and the cable will not reach: it is not let go.

const HEAVE = 0.25;          // m/s of cable in at the capstan
const SINK = 3.0;            // m/s, an anchor sinking
const MAX_DEPTH = 90;

export class Anchor {
  constructor(rig) {
    const a = rig.anchor || {};
    this.ok = !!(a.ring && a.hawse);
    this.ringLocal = new THREE.Vector3(...(a.ring || [0, 0, 0]));
    this.hawseLocal = new THREE.Vector3(...(a.hawse || [0, 0, 0]));
    this.catheadLocal = new THREE.Vector3(...(a.cathead || [0, 0, 0]));
    this.state = 'catted';
    this.paid = 0;            // cable out of the hawse, m
    this.scope = 0;
    this.depth = 0;
    this.vy = 0;
    this.capstanAngle = 0;
    this.taut = false;
    this.yawPull = 0;         // rad/s she is swung by the cable (for her yaw)
    this.message = '';
    this._v = new THREE.Vector3();
  }

  // After the model is in: the anchor node, the capstan and its bars; the
  // cable is drawn in `world` (a group in the scene, not moving with her).
  attach(model, world, hingeAt) {
    this.model = model;
    this.world = world;
    const node = model.getObjectByName('anchor');
    if (node) {
      this.hinge = hingeAt(node, this.ringLocal.clone(), model);
      this.stowPos = this.hinge.position.clone();
      this.stowQuat = this.hinge.quaternion.clone();
    }
    const cap = model.getObjectByName('capstan');
    if (cap) {
      const bb = new THREE.Box3();
      const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
      cap.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry.computeBoundingBox();
        bb.union(o.geometry.boundingBox.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld)));
      });
      const c = bb.getCenter(new THREE.Vector3());
      this.capstan = hingeAt(cap, new THREE.Vector3(c.x, bb.min.y, c.z), model);
      const bars = model.getObjectByName('capstan_bars');
      if (bars) { this.capstan.attach(bars); this.bars = bars; bars.visible = false; }
    }
    // the cable: segments of rope, placed each frame
    const N = 28;
    this.N = N;
    const geo = new THREE.CylinderGeometry(0.075, 0.075, 1, 7, 1, true);
    geo.translate(0, 0.5, 0);
    let mat;
    try { mat = shipMaterial('rope', null, { tint: [0.3, 0.25, 0.2], ao: false }); } catch { mat = new THREE.MeshStandardMaterial({ color: 0x3a3026, roughness: 0.9 }); }
    this.cable = new THREE.InstancedMesh(geo, mat, N);
    this.cable.frustumCulled = false;
    this.cable.castShadow = true;
    world.add(this.cable);
    this.pts = Array.from({ length: N + 1 }, () => new THREE.Vector3());
  }

  get down() { return this.state === 'down' || this.state === 'weighing'; }

  // Let go, or weigh: one order, as the state allows. waterY: the sea's
  // level; seabed(x, z): the bottom's height.
  order(waterY, seabed) {
    if (!this.hinge) return 'якоря нет';
    if (this.state === 'catted') {
      const hw = this.model.localToWorld(this.hawseLocal.clone());
      const depth = waterY - seabed(hw.x, hw.z);
      if (depth > MAX_DEPTH) return `здесь ${depth.toFixed(0)} м — канат не достанет до дна`;
      if (depth < 3) return 'слишком мелко — сядем на якорь';
      this.world.attach(this.hinge);
      this.state = 'falling';
      this.vy = 0;
      this.paid = 0;
      return 'отдать якорь!';
    }
    if (this.state === 'down') { this.state = 'weighing'; return 'выбирать якорь! — на шпиль'; }
    if (this.state === 'weighing') { this.state = 'down'; return 'стоп шпиль: стоим на якоре'; }
    return '';
  }

  // dt; ship (Galleon); waterY; seabed(x, z)
  update(dt, ship, waterY, seabed) {
    if (!this.hinge || !this.model) return;
    const hw = this.model.localToWorld((this._hw || (this._hw = new THREE.Vector3())).copy(this.hawseLocal));
    const ring = this.hinge.position;
    this.taut = false;
    this.yawPull = 0;
    if (this.state === 'falling') {
      if (ring.y < waterY) this.vy += (-SINK - this.vy) * Math.min(1, dt * 3);   // sinking, held back by the water
      else this.vy -= 9.81 * dt;                                               // falling from the cathead
      ring.y += this.vy * dt;
      const bottom = seabed(ring.x, ring.z) + 1.1;          // (the ring stands off the bottom; the crown is on it)
      this.paid = Math.max(this.paid, hw.distanceTo(ring) * 1.02);
      if (ring.y <= bottom) {
        ring.y = bottom;
        this.state = 'down';
        this.depth = waterY - bottom;
        this.scope = THREE.MathUtils.clamp(this.depth * 4.5, 25, 180);
        // lying on the bottom: crown down, shank toward her, one fluke biting
        const toShip = Math.atan2(hw.x - ring.x, hw.z - ring.z);
        this.hinge.quaternion.setFromEuler(new THREE.Euler(0, toShip, 0, 'YXZ'))
          .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.25));
      }
    } else if (this.down) {
      const dx = ring.x - hw.x, dz = ring.z - hw.z;
      const dist = Math.hypot(dx, dz) || 1e-3;
      const span = Math.max(0, hw.y - ring.y);
      if (this.state === 'weighing') {
        this.paid = Math.max(span + 1.5, this.paid - HEAVE * dt);
        this.capstanAngle += (HEAVE / 0.33) * dt;
        if (this.paid <= span + 2.0 && dist < 6) {          // up and down: she breaks it out
          this.state = 'rising';
        }
      } else if (this.paid < this.scope) {
        // the cable runs out after the anchor as she drops back
        const need = Math.hypot(dist, span) * 1.06 - this.paid;
        if (need > 0) this.paid = Math.min(this.scope, this.paid + Math.min(need, 2.5 * dt));
      }
      // the cable's reach along the bottom (its curve takes some of it)
      const R = Math.sqrt(Math.max(0, this.paid * this.paid - span * span)) * 0.95;
      if (dist > R) this._hold(dt, ship, dx / dist, dz / dist, dist - R, this.state === 'weighing');
    } else if (this.state === 'rising') {
      // comes up to the hawse, hanging from its cable
      const target = this._v.copy(hw).add(new THREE.Vector3(0, -1.4, 0));
      const d = target.sub(ring);
      const step = Math.min(d.length(), HEAVE * 1.6 * dt);
      ring.addScaledVector(d.normalize(), step);
      this.capstanAngle += (HEAVE * 1.6 / 0.33) * dt;
      this.hinge.quaternion.slerp(new THREE.Quaternion(), Math.min(1, dt * 0.8));
      this.paid = Math.max(1.4, hw.distanceTo(ring));
      if (ring.y > waterY - 0.5 && step < 0.05) {
        // catted again: up to the cathead
        this.model.attach(this.hinge);
        this.hinge.position.copy(this.stowPos);
        this.hinge.quaternion.copy(this.stowQuat);
        this.state = 'catted';
        this.paid = 0;
      }
    }
    if (this.capstan) this.capstan.rotation.y = -this.capstanAngle;
    if (this.bars) this.bars.visible = this.state === 'weighing' || this.state === 'rising';
    this._drawCable(hw, seabed);
  }

  // The cable taut: it holds her (or, weighing, heaves her up to the anchor
  // no faster than the capstan brings it in) and swings her head to it.
  _hold(dt, ship, ux, uz, excess, weighing) {
    this.taut = true;
    const h = ship.heading;
    const fx = -Math.sin(h), fz = -Math.cos(h);         // ahead
    const sx = Math.cos(h), sz = -Math.sin(h);          // to starboard
    const vx = fx * ship.speed + sx * ship.leeway, vz = fz * ship.speed + sz * ship.leeway;
    const approach = vx * ux + vz * uz;                  // m/s toward the anchor
    const want = weighing ? Math.min(HEAVE, 0.15 * excess) : Math.min(0.25, 0.04 * excess);
    const dv = want - approach;
    if (dv > 0) {
      const a = Math.min(2.5, dv * 1.5);                // m/s2 toward the anchor
      ship.speed += (ux * fx + uz * fz) * a * dt;
      ship.leeway += (ux * sx + uz * sz) * a * dt;
    }
    if (excess > 2.5) {                                   // the cable does not stretch
      const c = Math.min(excess - 2.5, 3 * dt);
      ship.position.x += ux * c;
      ship.position.z += uz * c;
    }
    // she swings head to it (+ heading turns her to port): the pull at her
    // bow is a turning moment about her middle
    const px = -Math.cos(h), pz = Math.sin(h);
    const ang = Math.atan2(ux * px + uz * pz, ux * fx + uz * fz);
    this.yawPull = 0.035 * Math.max(-1, Math.min(1, ang * 1.5)) * (0.5 + 0.5 * Math.min(1, excess / 1.5));
  }

  _drawCable(hw, seabed) {
    const N = this.N;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1);
    let from, to, slack;
    if (this.state === 'catted') {
      from = this.model.localToWorld(a.copy(this.catheadLocal));
      to = this.model.localToWorld(b.copy(this.ringLocal));
      slack = 0;
    } else {
      from = a.copy(hw);
      to = b.copy(this.hinge.getWorldPosition(this._v)).add(new THREE.Vector3(0, 0.15, 0));
      slack = Math.max(0, this.paid - from.distanceTo(to));
    }
    const L = from.distanceTo(to);
    const sag = Math.min(L * 0.6, Math.sqrt(0.375 * L * slack));
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const p = this.pts[i].copy(from).lerp(to, t);
      p.y -= sag * 4 * t * (1 - t);
      if (this.state !== 'catted') p.y = Math.max(p.y, seabed(p.x, p.z) + 0.08);      // lying on the bottom
    }
    for (let i = 0; i < N; i++) {
      const p0 = this.pts[i], p1 = this.pts[i + 1];
      d.subVectors(p1, p0);
      const len = d.length();
      q.setFromUnitVectors(up, d.normalize());
      s.set(1, len, 1);
      m.compose(p0, q, s);
      this.cable.setMatrixAt(i, m);
    }
    this.cable.instanceMatrix.needsUpdate = true;
  }

  describe() {
    if (this.state === 'catted') return '';
    if (this.state === 'falling') return 'якорь отдан, канат травится';
    if (this.state === 'rising') return 'якорь встал — поднимают к клюзу';
    const t = `на якоре: глубина ${this.depth.toFixed(0)} м, вытравлено ${this.paid.toFixed(0)} м`;
    return this.state === 'weighing' ? `выбирают якорь: ${this.paid.toFixed(0)} м каната` : t;
  }
}
