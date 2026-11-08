import * as THREE from 'three';

// The anchor gear: the starboard bower anchor in its pocket, a hydraulic
// windlass (driven by the deck-machinery power pack on the switchboard) and
// 7 shackles of chain (7 x 27.5 m). As on a trawler of this size:
//   - let go: the brake is released and the anchor runs out under its own
//     weight, the chain rattling out of the hawse; once it is on the bottom
//     the chain is paid out while the ship drops back; set the brake at the
//     scope you want (3-5 times the depth);
//   - riding to it: the ship drifts with the wind until the chain fetches up
//     and then lies to it, bow to the anchor, swinging round it; too short a
//     scope or too much wind (or engine) and the anchor drags;
//   - anchor watch: the GPS position against a circle round the anchor,
//     with an alarm when the ship leaves it;
//   - heaving up needs the hydraulics running: 9 m/min, the windlass pulling
//     the ship up to her anchor until it breaks out and comes home.

const SHACKLE = 27.5;
const HAWSE = [3.76, 3.75, -9.98];          // starboard hawse, model space

const _h = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Anchor {
  constructor({ scene, elec, alarms }) {
    this.elec = elec;
    this.alarms = alarms;
    this.state = 'housed';       // housed | running | holding | heaving
    this.out = 0;                // chain out of the hawse (m)
    this.max = 7 * SHACKLE;
    this.speed = 0;              // chain speed, + paying out (m/s)
    this.pos = null;             // anchor on the bottom: world {x, y, z}
    this.dragging = false;
    this.taut = false;
    this.depth = 0;
    this.msg = '';

    // the chain: links along its curve
    const linkG = new THREE.TorusGeometry(0.055, 0.018, 4, 8);
    linkG.scale(1, 1.6, 1);
    const linkM = new THREE.MeshStandardMaterial({ color: 0x2b2a28, roughness: 0.7, metalness: 0.5 });
    this.nLinks = 220;
    this.links = new THREE.InstancedMesh(linkG, linkM, this.nLinks);
    this.links.count = 0;
    this.links.frustumCulled = false;
    this.links.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.links);
    // the anchor itself (stockless: shank, crown and flukes)
    const anchor = new THREE.Group();
    const am = new THREE.MeshStandardMaterial({ color: 0x1d1d1c, roughness: 0.6, metalness: 0.4 });
    const shank = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 1.2, 8), am);
    shank.position.y = 0.6;
    anchor.add(shank);
    for (const sd of [-1, 1]) {
      const fl = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.32), am);
      fl.position.set(sd * 0.28, 0.08, 0);
      fl.rotation.z = sd * 0.45;
      anchor.add(fl);
    }
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.025, 6, 12), am);
    ring.position.y = 1.25;
    anchor.add(ring);
    anchor.visible = false;
    scene.add(anchor);
    this.anchorObj = anchor;
  }

  // ---------------------------------------------------------------- orders
  letGo() {
    if (this.state === 'housed' || this.state === 'holding') { this.state = 'running'; this.msg = ''; }
  }
  brake() {
    if (this.state === 'running' || this.state === 'heaving') this.state = this.out > 0.5 ? 'holding' : 'housed';
  }
  // Heave up: the hydraulic pump is started first if it is not running
  // (remote start from the windlass control), then the windlass takes it.
  heave() {
    if (this.state === 'housed') return;
    const E = this.elec;
    if (!E.powered('hyd')) {
      if (!E.live) { this.msg = 'брашпиль: нет электропитания (блэкаут)'; return; }
      const f = E.f.hyd;
      if (!f.on || !f.running || f.shed) { if (f.shed) f.shed = false; if (!f.on) E.toggleFeeder('hyd'); else E.toggleFeeder('hyd'); }
      this.msg = 'пуск гидростанции…';
      this.waitHyd = 6;
    } else this.msg = '';
    this.state = 'heaving';
  }
  get eta() { return this.state === 'heaving' ? this.out / (this.pos ? 0.15 : 0.2) : 0; }

  get shackles() { return this.out / SHACKLE; }
  get scope() { return this.depth > 0 ? this.out / this.depth : 0; }

  hawseWorld(boat) {
    return boat.model ? boat.model.localToWorld(_h.set(...HAWSE)) : _h.set(boat.position.x, 3, boat.position.z);
  }

  // Before the ship moves: chain running out or in.
  // ctx: { heightAt, tide, wind (m/s), windDir [x,z] toward }
  update(dt, boat, ctx) {
    const E = this.elec;
    const hw = this.hawseWorld(boat);
    const bottom = ctx.heightAt(hw.x, hw.z);
    this.depth = Math.max(0, ctx.tide - bottom);
    const drop = hw.y - bottom;                       // hawse to the bottom
    E.windlass = 0;
    if (this.state === 'running') {
      // free fall through the hawse, held back by the brake band; slower
      // once the anchor is on the bottom and the ship has to drop back
      const vmax = this.pos ? 0.6 + 0.4 * Math.min(1, ctx.wind / 10) : 3.2;
      this.speed += (vmax - this.speed) * Math.min(1, dt * 1.5);
      this.out = Math.min(this.max, this.out + this.speed * dt);
      if (this.out >= this.max) { this.state = 'holding'; this.msg = 'вся цепь вытравлена — на жвака-галсе!'; }
    } else if (this.state === 'heaving') {
      if (!E.powered('hyd')) {
        this.speed = 0;
        this.waitHyd = (this.waitHyd || 0) - dt;
        if (this.waitHyd <= 0) { this.state = 'holding'; this.msg = 'брашпиль встал: нет гидравлики (ГРЩ: «Гидростанция лебёдок»)'; }
      } else {
        if (this.msg === 'пуск гидростанции…') this.msg = '';
        // 9 m/min while it pulls the ship up to her anchor, 12 m/min once
        // only the hanging chain and the anchor are coming in
        const v = this.pos ? 0.15 : 0.2;
        E.windlass = this.pos ? 18 : 9;
        this.speed = -v;
        this.out = Math.max(0, this.out - v * dt);
        if (this.out <= 0.01) { this.out = 0; this.state = 'housed'; this.msg = 'якорь на месте, клюз закрыт'; }
      }
    } else this.speed = 0;
    // on the bottom or off it
    if (!this.pos && this.out > drop + 0.5) {
      this.pos = { x: hw.x, y: bottom, z: hw.z };
      this.dropAt = { x: hw.x, z: hw.z };
    } else if (this.pos && this.out < drop - 0.3) {
      this.pos = null;                                 // broken out: "anchor aweigh"
      this.msg = 'якорь встал, оторвался от грунта';
    }
  }

  // After the ship has moved: the chain as a limit on where she can go.
  constrain(dt, boat, ctx) {
    this.taut = false;
    this.dragging = false;
    if (!this.pos || !boat.model) return;
    const hw = this.hawseWorld(boat);
    const H = Math.max(0.5, hw.y - this.pos.y);
    const reach = Math.sqrt(Math.max(0, this.out * this.out - H * H)) * 0.93;   // catenary sag
    const dx = hw.x - this.pos.x, dz = hw.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    // holding: a good bite in sand or mud at 3:1 and more holds a gale; at
    // short scope, or with the engine pulling away, it drags
    const scope = this.out / Math.max(1, this.depth);
    const pullAway = Math.max(0, Math.abs(boat.rpm) - 0.35) * 2;     // engine working against the chain
    const hold = Math.min(1.6, Math.max(0.2, (scope - 1.2) / 2)) * 22;          // wind (m/s) it holds
    if (d > reach) {
      this.taut = true;
      const ux = dx / d, uz = dz / d;
      const over = d - reach;
      // the chain pulls her back (stiff, not rigid)
      boat.position.x -= ux * over * Math.min(1, dt * 6);
      boat.position.z -= uz * over * Math.min(1, dt * 6);
      // and kills her way away from the anchor
      const fx = -Math.sin(boat.heading), fz = -Math.cos(boat.heading);
      const away = (fx * ux + fz * uz) * boat.speed;
      if (away > 0) boat.speed -= (fx * ux + fz * uz) * away * Math.min(1, dt * 4);
      // she swings to lie bow-on to her anchor
      const want = Math.atan2(ux, uz);                 // heading whose forward points to the anchor
      let diff = want - boat.heading;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      boat.yawRate += (diff * 0.04 - boat.yawRate * 0.4) * dt;
      // dragging
      if (ctx.wind > hold || pullAway > 0.6) {
        this.dragging = true;
        const rate = 0.05 + 0.02 * Math.max(0, ctx.wind - hold) + 0.2 * pullAway;
        this.pos.x += ux * rate * dt;
        this.pos.z += uz * rate * dt;
        this.pos.y = ctx.heightAt(this.pos.x, this.pos.z);
      }
    }
    this.reach = reach;
  }

  // Draw the chain and the anchor.
  draw(boat, ctx) {
    const show = this.state !== 'housed' && boat.model;
    this.links.visible = !!show;
    this.anchorObj.visible = !!show;
    if (!show) return;
    const hw = this.hawseWorld(boat).clone();
    // the curve: from the hawse down to the touch-down point, then along
    // the bottom to the anchor (or hanging straight down if it is off it)
    let end, lying = 0;
    if (this.pos) {
      end = _a.set(this.pos.x, this.pos.y + 0.05, this.pos.z);
      const D = Math.hypot(hw.x - end.x, hw.z - end.z);
      const H = hw.y - end.y;
      lying = Math.max(0, Math.min(D * 0.95, this.out - Math.hypot(D, H)));
    } else {
      end = _a.set(hw.x, hw.y - this.out, hw.z);
    }
    const D = Math.hypot(hw.x - end.x, hw.z - end.z);
    const ux = D > 0.01 ? (end.x - hw.x) / D : 0, uz = D > 0.01 ? (end.z - hw.z) / D : 0;
    const td = _b.set(end.x - ux * lying, end.y, end.z - uz * lying);       // touch-down
    const hang = Math.max(0.1, this.out - lying);
    const pts = [];
    const nH = Math.max(4, Math.min(this.nLinks - 20, Math.round(hang / 1.2)));
    const sag = Math.max(0, (hang - hw.distanceTo(td)) * 0.45);
    for (let i = 0; i <= nH; i++) {
      const t = i / nH;
      // a hanging curve between hawse and touch-down, bellying down
      pts.push(new THREE.Vector3(
        hw.x + (td.x - hw.x) * t,
        hw.y + (td.y - hw.y) * (1 - (1 - t) * (1 - t)) - sag * Math.sin(Math.PI * t) * 0.3,
        hw.z + (td.z - hw.z) * t,
      ));
    }
    const nB = Math.min(this.nLinks - pts.length, Math.round(lying / 1.2));
    for (let i = 1; i <= nB; i++) {
      const t = i / nB;
      const x = td.x + (end.x - td.x) * t, z = td.z + (end.z - td.z) * t;
      pts.push(new THREE.Vector3(x + Math.sin(i * 1.7) * 0.3, ctx.heightAt(x, z) + 0.06, z));
    }
    let n = 0;
    for (let i = 0; i < pts.length - 1 && n < this.nLinks; i++) {
      const p0 = pts[i], p1 = pts[i + 1];
      const seg = p1.clone().sub(p0);
      const len = seg.length();
      if (len < 1e-3) continue;
      _q.setFromUnitVectors(UP, seg.normalize());
      _s.set(1, len / 0.18, 1);
      this.links.setMatrixAt(n++, _m.compose(p0.clone().lerp(p1, 0.5), _q, _s));
    }
    this.links.count = n;
    this.links.instanceMatrix.needsUpdate = true;
    // the anchor: lying on the bottom, or hanging at the end of the chain
    this.anchorObj.position.copy(end);
    if (this.pos) this.anchorObj.rotation.set(Math.PI / 2 - 0.25, Math.atan2(ux, uz), 0);
    else this.anchorObj.rotation.set(Math.PI, 0, 0);
  }

  // anchor watch: is the ship (GPS antenna) inside her swinging circle?
  watch(gps) {
    if (!this.pos || this.state === 'heaving' || !gps.fix) { this.alarms.set('anchorwatch', false); return; }
    const r = (this.reach || 0) + 35;
    const d = Math.hypot(gps.x - this.pos.x, gps.z - this.pos.z);
    const moved = this.dropAt ? Math.hypot(this.pos.x - this.dropAt.x, this.pos.z - this.dropAt.z) : 0;
    this.alarms.set('anchorwatch', d > r || moved > 25, `Якорная вахта: ${moved > 25 ? `якорь ползёт (${moved.toFixed(0)} м)` : `судно вне круга ${r.toFixed(0)} м`}`, 'alarm');
    this.watchR = r;
    this.watchD = d;
  }
}

export { SHACKLE };
