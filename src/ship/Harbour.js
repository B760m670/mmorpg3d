import * as THREE from 'three';

// A quay in Reine: concrete deck on piles along the shore, rubber fenders,
// bollards, a lamp post and a shore-power pillar (400 V, 125 A). Come
// alongside slowly and parallel to it and the crew puts the lines out: the
// ship lies held by bow and stern lines and springs, still riding the swell
// and the tide. Moored, you can:
//   - plug in shore power (cable from the pillar to the ship) and change the
//     switchboard over to it on the main switchboard, then stop the
//     generators — the bus cannot take shore and generators at once
//     (interlock), so the change-over is a short blackout, as aboard most
//     small ships;
//   - land the catch to the fish buyer on the quay;
//   - take on marine gas oil.
// Leave with the cable still connected and it tears out: the shore breaker
// trips and the ship blacks out.
//
// The site was searched for on the height model: the west shore of the
// village, between the registered sea houses (fishery buildings), where a
// wharf built out 13-18 m on piles has 6 m of water under a ship alongside
// and an open approach. The quay itself is a typical one, not a survey of a
// real structure.

const QUAY = {
  name: 'Рейне — рыбоприёмный причал',
  centre: [-2706.0, -362.0],    // on the face, world xz
  along: [0, -1],               // the face runs this way (north)
  out: [-1, 0],                 // toward the water (west)
  length: 50,
  width: 17,
  deck: 2.6,                    // m above mean sea level
};
const GASOIL_NOK = 11;          // NOK per litre, marine gas oil for fishing vessels (rough)

const _v = new THREE.Vector3();

export class Harbour {
  constructor({ scene, elec, heightAt }) {
    this.elec = elec;
    this.q = QUAY;
    this.state = 'free';          // free | mooring | moored
    this.t = 0;
    this.msg = '';
    this.group = new THREE.Group();
    scene.add(this.group);
    this.build(heightAt);
  }

  build(heightAt) {
    const q = this.q;
    const ang = Math.atan2(q.along[0], q.along[1]);           // rotation about Y so local +Z runs along the face
    const g = this.group;
    g.position.set(q.centre[0], 0, q.centre[1]);
    g.rotation.y = ang;
    // local frame: +Z along the face, +X out toward the water? work it out
    // from the vectors so the deck lies landward of the face
    const outLocal = new THREE.Vector3(q.out[0], 0, q.out[1]).applyAxisAngle(new THREE.Vector3(0, 1, 0), -ang);
    const sx = Math.sign(outLocal.x) || 1;                     // +x or -x is toward the water
    this.sx = sx;
    const concrete = new THREE.MeshStandardMaterial({ color: 0x8c8a84, roughness: 0.9 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.6 });
    const iron = new THREE.MeshStandardMaterial({ color: 0x2c2f33, roughness: 0.5, metalness: 0.5 });
    const yellow = new THREE.MeshStandardMaterial({ color: 0xd9a514, roughness: 0.6 });
    // deck slab, landward of the face
    const deck = new THREE.Mesh(new THREE.BoxGeometry(q.width, 0.7, q.length), concrete);
    deck.position.set(-sx * q.width / 2, q.deck - 0.35, 0);
    deck.castShadow = deck.receiveShadow = true;
    g.add(deck);
    // edge kerb painted yellow
    const kerb = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.25, q.length), yellow);
    kerb.position.set(-sx * 0.15, q.deck + 0.12, 0);
    g.add(kerb);
    // piles down to the bottom, two rows
    const pileG = new THREE.CylinderGeometry(0.28, 0.28, 1, 10);
    const piles = [];
    for (let zz = -q.length / 2 + 2; zz <= q.length / 2 - 2; zz += 5) {
      for (const xx of [-sx * 0.6, -sx * (q.width - 1)]) piles.push([xx, zz]);
    }
    const pm = new THREE.InstancedMesh(pileG, concrete, piles.length);
    const m4 = new THREE.Matrix4();
    piles.forEach(([xx, zz], i) => {
      _v.set(xx, 0, zz).applyAxisAngle(new THREE.Vector3(0, 1, 0), ang).add(g.position);
      const bottom = Math.min(q.deck - 1, heightAt(_v.x, _v.z));
      const h = q.deck - 0.7 - bottom;
      m4.compose(new THREE.Vector3(xx, bottom + h / 2, zz), new THREE.Quaternion(), new THREE.Vector3(1, Math.max(0.5, h), 1));
      pm.setMatrixAt(i, m4);
    });
    g.add(pm);
    // fenders on the face
    const fenderG = new THREE.CylinderGeometry(0.22, 0.22, 2.2, 10);
    for (let zz = -q.length / 2 + 4; zz <= q.length / 2 - 4; zz += 6) {
      const f = new THREE.Mesh(fenderG, dark);
      f.position.set(sx * 0.25, q.deck - 1.4, zz);
      g.add(f);
    }
    // bollards
    this.bollards = [];
    const bollG = new THREE.CylinderGeometry(0.16, 0.2, 0.55, 12);
    for (let zz = -q.length / 2 + 3; zz <= q.length / 2 - 3; zz += 11.5) {
      const b = new THREE.Mesh(bollG, iron);
      b.position.set(-sx * 0.8, q.deck + 0.28, zz);
      g.add(b);
      this.bollards.push(b);
    }
    // shore-power pillar and a lamp post
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.3, 0.4), new THREE.MeshStandardMaterial({ color: 0x1f5fa8, roughness: 0.5 }));
    pillar.position.set(-sx * 2.0, q.deck + 0.65, 6);
    g.add(pillar);
    this.pillar = pillar;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 7, 8), iron);
    post.position.set(-sx * 3.5, q.deck + 3.5, -10);
    g.add(post);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.3), new THREE.MeshBasicMaterial({ color: 0xffe2b0 }));
    lamp.position.set(-sx * 3.2, q.deck + 7, -10);
    g.add(lamp);
    this.lamp = lamp;
    // fish tubs (insulated 460 l tubs, blue and grey) stacked at the back of
    // the quay, and white plastic fish boxes on pallets
    const tubG = new THREE.BoxGeometry(1.2, 0.78, 1.0);
    const tubs = [];
    for (let k = 0; k < 3; k++) for (let i = 0; i < 3; i++) for (let j = 0; j < 3 - (k === 2 ? 1 : 0); j++) tubs.push([-sx * (q.width - 3.2 - i * 1.25), q.deck + 0.39 + j * 0.8, 10 + k * 1.1, (i + j + k) % 4 === 0]);
    const tubM = new THREE.InstancedMesh(tubG, new THREE.MeshStandardMaterial({ roughness: 0.55 }), tubs.length);
    const blue = new THREE.Color(0x1d5fa8), grey = new THREE.Color(0x8a9096);
    tubs.forEach(([x, y, z, gr], i) => { m4.makeTranslation(x, y, z); tubM.setMatrixAt(i, m4); tubM.setColorAt(i, gr ? grey : blue); });
    tubM.castShadow = true;
    g.add(tubM);
    const boxG = new THREE.BoxGeometry(0.8, 0.22, 0.6);
    const boxM = new THREE.InstancedMesh(boxG, new THREE.MeshStandardMaterial({ color: 0xe8e8e2, roughness: 0.6 }), 24);
    for (let i = 0; i < 24; i++) { m4.makeTranslation(-sx * (q.width - 6 - (i % 2) * 0.85), q.deck + 0.25 + Math.floor(i / 4) * 0.22, -16 + (Math.floor(i / 2) % 2) * 0.65); boxM.setMatrixAt(i, m4); }
    g.add(boxM);
    // a steel ladder down the face, and a hydraulic quay crane for the tubs
    const ladder = new THREE.Group();
    for (const dz of [-0.22, 0.22]) {
      const r = new THREE.Mesh(new THREE.BoxGeometry(0.06, 4.6, 0.06), iron);
      r.position.set(0, -2.0, dz);
      ladder.add(r);
    }
    for (let y = 0; y < 13; y++) {
      const r = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.44), iron);
      r.position.set(0, 0.1 - y * 0.35, 0);
      ladder.add(r);
    }
    ladder.position.set(sx * 0.08, q.deck, -4);
    g.add(ladder);
    const craneM = new THREE.MeshStandardMaterial({ color: 0xc8a018, roughness: 0.5, metalness: 0.2 });
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 3.2, 10), craneM);
    col.position.set(-sx * 1.6, q.deck + 1.6, 0);
    g.add(col);
    // the jib stowed along the quay, clear of a ship alongside
    const jib = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 5.5), craneM);
    jib.position.set(-sx * 1.6, q.deck + 3.6, 2.5);
    jib.rotation.x = -0.18;
    g.add(jib);
    const hook = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 2.2, 4), iron);
    hook.position.set(-sx * 1.6, q.deck + 2.95, 5.0);
    g.add(hook);
    // mooring lines and the shore cable (drawn when used)
    const lm = new THREE.LineBasicMaterial({ color: 0xd8c9a0 });
    this.lines = [0, 1, 2, 3].map(() => {
      const l = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3)), lm);
      l.frustumCulled = false;
      l.visible = false;
      g.parent.add(l);
      return l;
    });
    this.cableLine = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3)), new THREE.LineBasicMaterial({ color: 0x111111 }));
    this.cableLine.frustumCulled = false;
    this.cableLine.visible = false;
    g.parent.add(this.cableLine);
    g.updateMatrixWorld(true);
  }

  // distance off the face (m), along it, and heading difference
  where(boat) {
    const q = this.q;
    const dx = boat.position.x - q.centre[0], dz = boat.position.z - q.centre[1];
    const off = dx * q.out[0] + dz * q.out[1];
    const along = dx * q.along[0] + dz * q.along[1];
    const fwd = [-Math.sin(boat.heading), -Math.cos(boat.heading)];
    const dot = fwd[0] * q.along[0] + fwd[1] * q.along[1];
    return { off, along, parallel: Math.abs(dot), dir: Math.sign(dot) || 1, dist: Math.hypot(dx, dz) };
  }

  canMoor(boat) {
    const w = this.where(boat);
    return this.state === 'free' && w.off > 3.5 && w.off < 16 && Math.abs(w.along) < this.q.length / 2 && w.parallel > 0.88 && Math.abs(boat.speed) < 0.6;
  }

  moor(boat) {
    if (!this.canMoor(boat)) {
      const w = this.where(boat);
      this.msg = w.dist > 200 ? `до причала ${Math.round(w.dist)} м` : Math.abs(boat.speed) >= 0.6 ? 'сбавьте ход до 1 узла' : w.parallel <= 0.88 ? 'подойдите параллельно причалу' : 'подойдите к причалу на 5–15 м';
      return;
    }
    const w = this.where(boat);
    this.state = 'mooring';
    this.t = 0;
    this.from = { x: boat.position.x, z: boat.position.z, h: boat.heading };
    const q = this.q;
    const off = 4.6 + 0.45;                                   // half beam and the fenders
    const along = Math.max(-q.length / 2 + 13, Math.min(q.length / 2 - 13, w.along));
    this.berth = { x: q.centre[0] + q.out[0] * off + q.along[0] * along, z: q.centre[1] + q.out[1] * off + q.along[1] * along, h: Math.atan2(-q.along[0] * w.dir, -q.along[1] * w.dir) };
    this.msg = 'подаём швартовы…';
  }

  unmoor() {
    if (this.state === 'free') return;
    if (this.elec.shore.cable) {
      this.elec.shore.cable = false;
      this.elec.shore.breaker = false;
      this.msg = 'береговой кабель вырван! АВ берега отключился';
      this.elec.alarms.set('shorecable', true, 'Береговой кабель оборван при отходе', 'alarm');
      setTimeout(() => this.elec.alarms.set('shorecable', false), 2000);
    } else this.msg = 'швартовы отданы';
    this.state = 'free';
    this.elec.shore.avail = false;
  }

  plug() {
    if (this.state !== 'moored') { this.msg = 'кабель подключают только ошвартовавшись'; return; }
    this.elec.shore.cable = !this.elec.shore.cable;
    if (!this.elec.shore.cable) this.elec.shore.breaker = false;
    this.msg = this.elec.shore.cable ? 'береговой кабель подключён: включите АВ берега на ГРЩ' : 'кабель отключён';
  }

  refuel() {
    if (this.state !== 'moored') return null;
    const need = Math.max(0, 14000 - this.elec.fuel);
    this.elec.fuel = 14000;
    return { l: need, nok: need * GASOIL_NOK };
  }

  // hold the ship at her berth (after she has moved this frame)
  constrain(dt, boat) {
    if (this.state === 'free') return;
    this.t += dt;
    const b = this.berth;
    if (this.state === 'mooring') {
      const k = Math.min(1, this.t / 12);
      const e = k * k * (3 - 2 * k);
      boat.position.x = this.from.x + (b.x - this.from.x) * e;
      boat.position.z = this.from.z + (b.z - this.from.z) * e;
      let dh = b.h - this.from.h;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      boat.heading = this.from.h + dh * e;
      if (k >= 1) { this.state = 'moored'; this.msg = 'ошвартованы'; this.elec.shore.avail = true; }
    } else {
      // lines and fenders: a little surge and sway, no more
      boat.position.x += (b.x - boat.position.x) * Math.min(1, dt * 2);
      boat.position.z += (b.z - boat.position.z) * Math.min(1, dt * 2);
      let dh = b.h - boat.heading;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      boat.heading += dh * Math.min(1, dt * 2);
    }
    boat.speed *= 1 - Math.min(1, dt * 3);
    boat.yawRate *= 1 - Math.min(1, dt * 3);
  }

  draw(boat) {
    const moored = this.state !== 'free' && boat.model;
    const m = boat.model;
    let side = 1;
    if (moored) {
      // which side lies to the quay: the ship's starboard points toward it?
      const o = m.getWorldPosition(new THREE.Vector3());
      const p = m.localToWorld(new THREE.Vector3(1, 0, 0)).sub(o);
      side = -(p.x * this.q.out[0] + p.z * this.q.out[1]) > 0 ? 1 : -1;
      // bow line, forward spring, after spring, stern line: ship's fairleads
      // to the quay bollards, bow and stern lines leading fore and aft
      const pts = [[3.9, 6.0, -10.5], [4.3, 5.3, -4], [4.3, 5.3, 4], [4.0, 5.2, 10.5]];
      const bolls = this.bollards.map((q) => q.getWorldPosition(new THREE.Vector3()));
      const fwd = m.localToWorld(new THREE.Vector3(0, 0, -1)).sub(o);
      const ranked = bolls.slice().sort((A, B) => (A.x - B.x) * fwd.x + (A.z - B.z) * fwd.z);   // aft to forward
      const pick = [ranked[ranked.length - 1], ranked[1], ranked[ranked.length - 2], ranked[0]];
      pts.forEach((pp, i) => {
        const s0 = m.localToWorld(new THREE.Vector3(pp[0] * side, pp[1], pp[2]));
        const e = pick[i];
        const a = this.lines[i].geometry.attributes.position;
        const mid = s0.clone().lerp(e, 0.5);
        mid.y = Math.min(s0.y, e.y) - 0.5;
        a.setXYZ(0, s0.x, s0.y, s0.z); a.setXYZ(1, mid.x, mid.y, mid.z); a.setXYZ(2, e.x, e.y + 0.2, e.z);
        a.needsUpdate = true;
        this.lines[i].visible = true;
      });
    } else this.lines.forEach((l) => { l.visible = false; });
    // the shore cable from the pillar to the ship's shore-connection box
    this.cableLine.visible = !!(moored && this.elec.shore.cable);
    if (this.cableLine.visible) {
      const p0 = this.pillar.getWorldPosition(new THREE.Vector3());
      const p1 = m.localToWorld(new THREE.Vector3(4.2 * side, 5.3, 1.5));
      const mid = p0.clone().lerp(p1, 0.5);
      mid.y = Math.min(p0.y, p1.y) - 1.0;
      const a = this.cableLine.geometry.attributes.position;
      a.setXYZ(0, p0.x, p0.y + 0.4, p0.z); a.setXYZ(1, mid.x, mid.y, mid.z); a.setXYZ(2, p1.x, p1.y, p1.z);
      a.needsUpdate = true;
    }
  }
}

export { QUAY, GASOIL_NOK };
