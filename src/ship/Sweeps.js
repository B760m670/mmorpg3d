import * as THREE from 'three';

// Sweeps: the long oars a ship of the pirates' day worked through small
// ports on her upper deck in a calm, or to turn her in a narrow place. Each
// is 12.7 m, pivoting in its port, 3.6 m inboard to the loom and the handle,
// the blade 8.6 m out; five men to a sweep.
//
// The stroke, as it is rowed: the catch (the blade dropped into the water
// well forward), the drive (pulled aft through the water), the finish (the
// blade lifted out), the recovery (carried forward clear of the water).
// About eighteen strokes a minute. To turn her, one side backs water (the
// same stroke the other way) while the other side pulls.
//
// The force: five men on the loom, ~150 N each, at 3.6 m from the pivot
// against the blade at 8.6 m: ~310 N on the water while the blade is in it,
// nearly half the stroke; fourteen sweeps give ~2 kN on average, which
// moves 1200 t at a little over 2 knots, as big ships under sweeps went.

const PERIOD = 3.3;                 // s per stroke
const DRIVE = 0.45;                 // part of the stroke the blade is in the water
const YAW_FWD = 24 * Math.PI / 180, YAW_AFT = -18 * Math.PI / 180;
const BLADE_FORCE = 310;            // N on the water per sweep during the drive
const OUT = 8.6, BLADE_AT = 7.85;   // m from the pivot: blade's end and middle

const smooth = (t) => t * t * (3 - 2 * t);

export class Sweeps {
  constructor(rig) {
    this.ports = [];
    for (const p of rig.sweeps || []) {
      for (const side of [1, -1]) {
        const at = new THREE.Vector3(p.at[0] * side, p.at[1], p.at[2]);
        const out = new THREE.Vector3(p.n[0] * side, 0, p.n[2]).normalize();   // outward, level
        this.ports.push({ at, out, side, s: p.s, node: null });
      }
    }
    this.out = 0;             // run out 0..1
    this.rowing = false;
    this.phase = 0;
    this.thrust = 0;          // N ahead, now
    this.moment = 0;          // N m, + turns her head to port
    this.turn = 0;            // -1..1 the order from the helm: + to port
  }

  // The model's oar (a node laid along +x from its pivot): one copy per port.
  attach(model) {
    const proto = model.getObjectByName('sweep');
    if (!proto) return;
    proto.removeFromParent();
    const group = new THREE.Group();
    group.name = 'sweeps';
    model.add(group);
    for (const p of this.ports) {
      const pivot = new THREE.Object3D();
      pivot.position.copy(p.at);
      // (the copy keeps the node's own transform: the packed model's
      // dequantization lives there)
      const slide = new THREE.Object3D();
      const oar = proto.clone();
      oar.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
      slide.add(oar);
      pivot.add(slide);
      group.add(pivot);
      p.node = pivot;
      p.oar = slide;
    }
    this.group = group;
    this._pose(0);
  }

  set(on) { this.rowing = !!on; }

  // dt; turn: the helm order -1..1 (+ to port)
  update(dt, turn) {
    this.turn = turn;
    const want = this.rowing ? 1 : 0;
    this.out += THREE.MathUtils.clamp(want - this.out, -dt / 3.5, dt / 3.5);    // run out or in, 3.5 s
    if (this.out >= 0.999 && this.rowing) this.phase = (this.phase + dt / PERIOD) % 1;
    else if (this.out < 0.999) this.phase = 0.92;                                  // waiting at the catch
    this._pose(dt);
  }

  _pose() {
    let thrust = 0, moment = 0;
    const fwd = new THREE.Vector3(0, 0, -1);
    const q = new THREE.Quaternion();
    const X = new THREE.Vector3(1, 0, 0);
    const d = new THREE.Vector3(), h = new THREE.Vector3();
    for (const p of this.ports) {
      if (!p.node) continue;
      p.node.visible = this.out > 0.01;
      if (!p.node.visible) continue;
      // backing water: the side the helm is put toward backs, the other pulls
      const backs = (this.turn > 0.3 && p.side < 0) || (this.turn < -0.3 && p.side > 0);
      const ph = this.phase;
      let yaw, lift, inWater;
      if (ph < DRIVE) {                      // the drive
        const t = smooth(ph / DRIVE);
        yaw = backs ? YAW_AFT + (YAW_FWD - YAW_AFT) * t : YAW_FWD + (YAW_AFT - YAW_FWD) * t;
        lift = 0; inWater = true;
      } else {                               // finish, recovery, catch
        const t = (ph - DRIVE) / (1 - DRIVE);
        const tt = smooth(t);
        yaw = backs ? YAW_FWD + (YAW_AFT - YAW_FWD) * tt : YAW_AFT + (YAW_FWD - YAW_AFT) * tt;
        lift = Math.min(1, t / 0.12) * Math.min(1, (1 - t) / 0.1);
        inWater = false;
      }
      if (this.out < 0.999) { yaw = YAW_FWD * 0.5; lift = 1; inWater = false; }
      // the blade's height: in the water at the drive, half a metre clear
      // of it at the recovery (the pivot is ~4.7 m over the water)
      const bladeY = -0.15 + 0.75 * lift;
      const pitch = Math.asin(THREE.MathUtils.clamp((p.at.y - bladeY) / BLADE_AT, -1, 1));
      h.copy(p.out).multiplyScalar(Math.cos(yaw)).addScaledVector(fwd, Math.sin(yaw)).normalize();
      d.copy(h).multiplyScalar(Math.cos(pitch)).setY(-Math.sin(pitch));
      q.setFromUnitVectors(X, d);
      p.node.quaternion.copy(q);
      // run out along its own length (the loom inboard when in)
      p.oar.position.set(-(1 - this.out) * (OUT + 0.6), 0, 0);
      if (inWater && this.out >= 0.999) {
        const f = (backs ? -1 : 1) * BLADE_FORCE * Math.cos(yaw) * Math.sin(Math.PI * Math.min(1, ph / DRIVE));
        thrust += f;
        // its lever about her middle: the blade's distance out to the side
        moment += p.side * f * (Math.abs(p.at.x) + BLADE_AT * Math.cos(pitch));     // + to port
      }
    }
    this.thrust = thrust;
    this.moment = moment;
  }
}
