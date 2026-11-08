import * as THREE from 'three';
import { seabedHard } from '../world/Terrain.js';

// Bottom trawling, as a 24 m stern trawler does it:
//   1. shoot: steaming slowly ahead, the net runs off the net drum over the
//      stern; the trawl doors (otter boards, ~1 t each) are hung from the
//      gantry blocks and lowered, and the warps run off the two trawl
//      winches to about three times the depth;
//   2. tow: winches braked, 3-3.5 knots; the doors spread the net (60-90 m
//      between doors, 20-25 m wing spread, 4-5 m headline) and the ground
//      gear runs over the bottom. Too little warp, or too fast, and the gear
//      lifts off; over rock it can come fast (a fastener: everything stops,
//      the warps bar-taut);
//   3. haul: the winches heave the warps in (60 m/min) until the doors are
//      at the blocks, the net is wound onto the drum and the cod-end swung
//      aboard; the catch goes down the hopper to the fish room.
// The winches and the net drum run on the hydraulic power pack, the heavy
// consumer on the switchboard (hauling is about 34 kW: with the galley,
// heating and refrigeration on, one 64 kW generator is not enough).
// The gear's drag (6-8 tonnes at 3.5 knots on the bottom) loads the engine
// and slows the ship. The catch is worked out from where the trawl is:
// depth, hard or soft bottom and patches of fish, by species: cod, haddock,
// saithe, redfish, plaice.

const NET_LEN = 95;               // net and bridles, m
const WING = 22;                  // wing spread, m (swept width)
const BLOCKS = [[-2.5, 6.6, 9.4], [2.5, 6.6, 9.4]];   // gantry blocks, model space
const HOLD_CAP = 18000;           // kg, the fish room

export const SPECIES = {
  cod: { name: 'Треска', nok: 34 },
  haddock: { name: 'Пикша', nok: 24 },
  saithe: { name: 'Сайда', nok: 12 },
  redfish: { name: 'Морской окунь', nok: 18 },
  plaice: { name: 'Камбала', nok: 15 },
};

const bell = (d, lo, peak, hi) => (d <= lo || d >= hi ? 0 : d < peak ? Math.sin(((d - lo) / (peak - lo)) * Math.PI / 2) : Math.cos(((d - peak) / (hi - peak)) * Math.PI / 2));
// patches of fish: smooth, fixed in space (the same grounds fish the same)
const patch = (x, z, k) => 0.25 + 1.5 * Math.max(0, Math.sin(x * 0.0021 + k) * Math.sin(z * 0.0017 + k * 1.7) + 0.35 * Math.sin((x + z) * 0.0045 + k * 2.3));

export class Trawl {
  constructor({ scene, elec, alarms }) {
    this.elec = elec;
    this.alarms = alarms;
    this.state = 'stowed';      // stowed | net | warps | towing | hauling | netin
    this.net = 0;               // net paid out (m)
    this.warp = 0;              // warp out (m)
    this.target = 300;          // warp length to shoot
    this.rate = 0;              // warp speed (m/s, + out)
    this.onBottom = false;
    this.fast = null;           // fastener point (world)
    this.codend = {};           // kg by species in the net
    this.hold = {};             // kg by species in the fish room
    this.cash = 0;              // NOK earned
    this.towTime = 0;
    this.spread = 0;
    this.headline = 0;
    this.depth = 0;
    this.drag = 0;
    this.msg = '';
    this.track = [];            // the ship's path, for where the trawl follows
    this.pos = new THREE.Vector3();
    // doors, warps, net
    const dm = new THREE.MeshStandardMaterial({ color: 0x2a2c2e, roughness: 0.6, metalness: 0.4 });
    const doorG = new THREE.BoxGeometry(0.12, 1.25, 2.3);
    this.doors = [0, 1].map(() => { const d = new THREE.Mesh(doorG, dm); d.castShadow = true; scene.add(d); return d; });
    const wm = new THREE.LineBasicMaterial({ color: 0x1a1a1a });
    this.warps = [0, 1].map(() => {
      const g = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const l = new THREE.Line(g, wm);
      l.frustumCulled = false;
      scene.add(l);
      return l;
    });
    // the net: a cone of lines from the doors' bridles to the cod-end
    const segs = [];
    for (let k = 0; k < 10; k++) segs.push(k, 10 + k);
    const ng = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(21 * 3), 3));
    ng.setIndex([...segs, ...Array.from({ length: 10 }, (_, k) => [10 + k, 20]).flat(), ...Array.from({ length: 10 }, (_, k) => [k, (k + 1) % 10]).flat()]);
    this.netMesh = new THREE.LineSegments(ng, new THREE.LineBasicMaterial({ color: 0x9a5a20 }));
    this.netMesh.frustumCulled = false;
    scene.add(this.netMesh);
    // floats of the net on the surface while it goes over the stern
    this.floats = new THREE.InstancedMesh(new THREE.SphereGeometry(0.14, 8, 6), new THREE.MeshStandardMaterial({ color: 0xff6a10, roughness: 0.5 }), 24);
    this.floats.count = 0;
    this.floats.frustumCulled = false;
    scene.add(this.floats);
  }

  get catchKg() { return Object.values(this.codend).reduce((a, b) => a + b, 0); }
  get holdKg() { return Object.values(this.hold).reduce((a, b) => a + b, 0); }

  // ---------------------------------------------------------------- orders
  shoot() {
    if (this.state !== 'stowed') return;
    if (!this.hydOk()) return;
    this.state = 'net';
    this.msg = 'трал пошёл с барабана за корму';
  }
  brake() {
    if (this.state === 'warps' || this.state === 'hauling') { this.state = this.warp > 1 ? 'towing' : this.state; this.msg = 'лебёдки на тормозах'; }
  }
  more(d) { this.target = Math.max(100, Math.min(1200, this.target + d)); if (this.state === 'towing' && this.target > this.warp) this.state = 'warps'; }
  haul() {
    if (this.state === 'stowed' || this.state === 'netin') return;
    if (!this.hydOk()) return;
    this.state = this.warp > 0.5 ? 'hauling' : 'netin';
    this.msg = 'выбираем ваера';
  }
  hydOk() {
    const E = this.elec;
    if (E.powered('hyd')) return true;
    if (!E.live) { this.msg = 'нет электропитания для гидростанции'; return false; }
    const f = E.f.hyd;
    if (f.shed) f.shed = false;
    E.toggleFeeder('hyd');
    this.msg = 'пуск гидростанции…';
    return E.powered('hyd') || true;
  }

  // ---------------------------------------------------------------- simulation
  // ctx: { heightAt, tide }
  update(dt, boat, ctx) {
    const E = this.elec;
    const hyd = E.powered('hyd');
    const u = boat.speed;
    // the ship's track, every 2 m
    const bp = boat.position;
    const last = this.track[this.track.length - 1];
    if (!last || Math.hypot(bp.x - last[0], bp.z - last[1]) > 2) {
      this.track.push([bp.x, bp.z]);
      if (this.track.length > 800) this.track.shift();
    }
    E.hydWork = false;
    this.rate = 0;
    switch (this.state) {
      case 'net':
        if (!hyd) break;
        if (u < 0.6) { this.msg = 'дайте ход 2–3 узла: на стопе сеть ляжет на винт'; break; }
        this.net = Math.min(NET_LEN, this.net + 1.6 * dt);
        if (this.net >= NET_LEN) { this.state = 'warps'; this.msg = 'доски за бортом, травим ваера'; }
        break;
      case 'warps':
        if (!hyd) break;
        this.rate = 1.6;
        this.warp = Math.min(this.target, this.warp + 1.6 * dt);
        if (this.warp >= this.target) { this.state = 'towing'; this.msg = 'на тормозах, трал работает'; }
        break;
      case 'hauling':
        if (!hyd) { this.msg = 'лебёдки встали: нет гидравлики'; break; }
        E.hydWork = true;
        this.rate = -1.0;
        this.warp = Math.max(0, this.warp - 1.0 * dt);
        if (this.warp <= 0) { this.state = 'netin'; this.msg = 'доски в блоках, выбираем трал на барабан'; }
        break;
      case 'netin':
        if (!hyd) break;
        E.hydWork = true;
        this.net = Math.max(0, this.net - 1.4 * dt);
        if (this.net <= 0) this._landCatch();
        break;
      default:
    }
    // where the trawl is and whether it is fishing
    const bottomHere = ctx.tide - ctx.heightAt(bp.x, bp.z);
    const kn = Math.abs(u) * 1.943844;
    const ratio = 2.6 + 0.9 * Math.max(0, kn - 3);
    const reachDepth = this.warp / ratio;
    const horiz = Math.sqrt(Math.max(0, this.warp * this.warp - reachDepth * reachDepth)) + (this.warp > 0 ? this.net * 0.6 : this.net * 0.3);
    this._along(horiz, boat);
    const dHere = ctx.tide - ctx.heightAt(this.pos.x, this.pos.z);
    this.depth = Math.max(0, dHere);
    const out = this.warp > 5 && (this.state === 'towing' || this.state === 'warps' || this.state === 'hauling');
    this.onBottom = out && !this.fast && reachDepth >= this.depth - 2 && this.depth > 3;
    this.spread = out ? Math.min(85, 25 + 0.12 * this.warp) * Math.min(1, kn / 2.5) : 0;
    this.headline = out ? 4.5 + 0.6 * Math.max(0, 3.5 - kn) : 0;
    // drag of the gear: net and doors through the water, the ground gear on
    // the bottom; a fastener holds the ship like an anchor
    const k = this.onBottom ? 21000 : this.warp > 5 ? 15000 : this.net > 0 ? 2500 : 0;
    this.drag = k * u * Math.abs(u) + (this.onBottom ? 15000 * Math.sign(u || 0) : 0);
    if (this.fast) this.drag = Math.max(this.drag, 250000 * Math.sign(u || 1));
    boat.towDrag = this.drag;
    if (this.warp > 5 || this.fast) boat.yawRate *= 1 - Math.min(1, dt * 0.35);      // the gear damps her turning
    // fasteners on hard ground
    if (this.onBottom) {
      this.towTime += dt;
      this.hardT = (this.hardT || 0) - dt;
      if (this.hardT <= 0) {
        this.hardT = 2;
        const h = seabedHard(this.pos.x, this.pos.z).hard;
        this.hardHere = h;
        // fasteners are not every haul: on rough ground perhaps one an hour
        if (h > 0.55 && Math.random() < 0.0009 * h * h * (0.5 + kn / 3)) {
          this.fast = { x: this.pos.x, z: this.pos.z, warp: this.warp };
          this.msg = 'ЗАЦЕП! Стоп машина, выбирайте осторожно';
        }
      }
      // the catch
      const sweep = WING * Math.abs(u) * dt;           // m^2 this step
      const d = this.depth, hard = this.hardHere ?? 0.3;
      const x = this.pos.x, z = this.pos.z;
      const dens = {
        cod: 0.009 * bell(d, 25, 90, 180) * (0.6 + 0.8 * hard) * patch(x, z, 1),
        haddock: 0.0065 * bell(d, 50, 130, 230) * (1.2 - 0.8 * hard) * patch(x, z, 2),
        saithe: 0.008 * bell(d, 35, 100, 220) * (0.7 + 0.6 * hard) * patch(x, z, 3),
        redfish: 0.005 * bell(d, 140, 250, 420) * patch(x, z, 4),
        plaice: 0.004 * bell(d, 8, 35, 75) * (1.3 - hard) * patch(x, z, 5),
      };
      for (const [s, rho] of Object.entries(dens)) this.codend[s] = (this.codend[s] || 0) + rho * sweep;
    }
    // freeing a fastener: hauled back over it the gear usually comes free,
    // sometimes with a torn net
    if (this.fast) {
      if (this.state === 'hauling' && this.warp < this.depth * 1.3 + 10) {
        if (Math.random() < 0.7) this.msg = 'трал освободился от зацепа';
        else { this.codend = {}; this.msg = 'трал освободился, но порван: улов потерян'; }
        this.fast = null;
      }
    }
    this.alarms.set('trawlfast', !!this.fast, 'Зацеп трала: ваера натянуты', 'alarm');
    this.alarms.set('codend', this.catchKg > 4000, `Тралмешок полон: ~${Math.round(this.catchKg / 100) * 100} кг`, 'warn');
  }

  // the trawl's position: behind the ship along her track
  _along(dist, boat) {
    let left = dist;
    let px = boat.position.x, pz = boat.position.z;
    for (let i = this.track.length - 1; i >= 0 && left > 0; i--) {
      const [x, z] = this.track[i];
      const s = Math.hypot(x - px, z - pz);
      if (s >= left) { px += ((x - px) / s) * left; pz += ((z - pz) / s) * left; left = 0; break; }
      left -= s; px = x; pz = z;
    }
    if (left > 0) {                                   // short track: straight astern
      px += Math.sin(boat.heading) * left;
      pz += Math.cos(boat.heading) * left;
    }
    this.pos.set(px, 0, pz);
  }

  _landCatch() {
    const add = this.catchKg;
    const room = Math.max(0, HOLD_CAP - this.holdKg);
    const k = add > 0 ? Math.min(1, room / add) : 0;
    for (const [s, kg] of Object.entries(this.codend)) this.hold[s] = (this.hold[s] || 0) + kg * k;
    this.lastHaul = { kg: add * k, by: { ...this.codend }, time: this.towTime };
    this.codend = {};
    this.towTime = 0;
    this.state = 'stowed';
    this.msg = add > 1 ? `улов на борту: ${Math.round(add * k)} кг${k < 1 ? ' (трюм полон, часть за борт)' : ''}` : 'трал на борту, пустой';
  }

  // sell the fish room's contents (at a quay)
  land() {
    let nok = 0;
    for (const [s, kg] of Object.entries(this.hold)) nok += kg * SPECIES[s].nok;
    const kg = this.holdKg;
    this.hold = {};
    this.cash += nok;
    return { kg, nok };
  }

  // the chain of the ship's track, for constraints with a fastener
  constrain(dt, boat) {
    if (!this.fast || !boat.model) return;
    const reach = Math.sqrt(Math.max(1, this.warp * this.warp - this.depth * this.depth));
    const dx = boat.position.x - this.fast.x, dz = boat.position.z - this.fast.z;
    const d = Math.hypot(dx, dz);
    if (d > reach) {
      boat.position.x -= (dx / d) * (d - reach) * Math.min(1, dt * 5);
      boat.position.z -= (dz / d) * (d - reach) * Math.min(1, dt * 5);
      if (boat.speed > 0) boat.speed *= 1 - Math.min(1, dt * 3);
    }
  }

  // ---------------------------------------------------------------- drawing
  draw(boat, ctx) {
    const show = this.state !== 'stowed' && boat.model;
    const m = boat.model;
    const blocks = BLOCKS.map((b) => m.localToWorld(new THREE.Vector3(...b)));
    const fwd = new THREE.Vector3(-Math.sin(boat.heading), 0, -Math.cos(boat.heading));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    // doors: at the blocks, or out on the warps at the trawl's depth
    const doorY = ctx.tide - Math.min(this.depth, this.warp / 2.6) + 0.6;
    const t = Math.min(1, this.warp / 40);
    const back = this.pos.clone();
    back.addScaledVector(fwd, this.net * 0.6 * (this.warp > 0 ? 1 : 0));    // doors are ahead of the net
    this.doors.forEach((d, i) => {
      const side = i ? 1 : -1;
      const at = blocks[i].clone();
      at.y -= 0.9;
      const deep = new THREE.Vector3(back.x + right.x * side * this.spread / 2, doorY, back.z + right.z * side * this.spread / 2);
      d.position.lerpVectors(at, deep, this.warp > 0 ? t * t : 0);
      d.rotation.set(0, boat.heading, 0);
      d.visible = true;
      // the warp from the block to the door
      const a = this.warps[i].geometry.attributes.position;
      a.setXYZ(0, blocks[i].x, blocks[i].y, blocks[i].z);
      a.setXYZ(1, d.position.x, d.position.y + 0.5, d.position.z);
      a.needsUpdate = true;
      this.warps[i].visible = this.warp > 0.5;
    });
    // the net between the doors and back to the cod-end
    this.netMesh.visible = show && this.warp > 5;
    if (this.netMesh.visible) {
      const p = this.netMesh.geometry.attributes.position;
      const mouth = this.doors[0].position.clone().lerp(this.doors[1].position, 0.5).addScaledVector(fwd, -20);
      const bottomY = doorY - 0.6;
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2;
        p.setXYZ(k, mouth.x + right.x * Math.cos(a) * WING / 2, bottomY + (Math.sin(a) * 0.5 + 0.5) * this.headline, mouth.z + right.z * Math.cos(a) * WING / 2);
        const mid = mouth.clone().addScaledVector(fwd, -35);
        p.setXYZ(10 + k, mid.x + right.x * Math.cos(a) * 3, bottomY + 1 + Math.sin(a) * 1.2, mid.z + right.z * Math.cos(a) * 3);
      }
      const ce = mouth.clone().addScaledVector(fwd, -55);
      p.setXYZ(20, ce.x, bottomY + 0.8, ce.z);
      p.needsUpdate = true;
    }
    // floats on the surface while the net is going over or coming in
    const surf = (this.state === 'net' || this.state === 'netin') ? Math.min(24, Math.floor(this.net / 4)) : 0;
    const stern = m.localToWorld(new THREE.Vector3(0, 0, 12));
    const mm = new THREE.Matrix4();
    for (let k = 0; k < surf; k++) {
      const s = stern.clone().addScaledVector(fwd, -(k * 3.5 + 3)).addScaledVector(right, Math.sin(k * 1.3) * 2.5);
      s.y = ctx.tide + 0.05;
      this.floats.setMatrixAt(k, mm.makeTranslation(s.x, s.y, s.z));
    }
    this.floats.count = surf;
    this.floats.instanceMatrix.needsUpdate = true;
  }
}

export { HOLD_CAP };
