import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { gunzipSync } from 'fflate';
import RIG from '../ship/galleon_rig.json';
import { Sails, Flags, squareDrive } from '../ship/Sails.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { shipMaterial } from '../ship/Materials.js';
import { POROSITY } from '../ship/Wetness.js';
import { Sweeps } from '../ship/Sweeps.js';
import { Anchor } from '../ship/Anchor.js';

// The ship: a large sailing ship of the 1620s after Vasa, Blender-built
// (blender/build_galleon.py), and her sailing.
//
// Sailing, kept simple but true to a square-rigger:
//   * the wind is felt as the apparent wind (true wind less her own way);
//   * square sails drive from the beam aft, hardly at all closer than about
//     65 deg off the wind, and are taken aback (drive her astern) when the
//     wind comes ahead; the yards brace round by themselves, as far as the
//     shrouds allow (38 deg);
//   * she makes leeway, heels to leeward, carries her way a long time
//     (about 1200 t) and answers a 23 deg rudder slowly, only with way on;
//   * W / S set or take in sail by steps: courses, topsails, topgallants.
//
// 1 unit = 1 m; the glTF origin is amidships on the waterline, bow toward -Z.

const DEG = Math.PI / 180;

// residuary (wave-making) resistance coefficient over the Froude number
const CR = [[0, 0], [0.10, 0.0006], [0.15, 0.0010], [0.20, 0.0030], [0.25, 0.0090], [0.30, 0.0220], [0.35, 0.040], [0.5, 0.08]];
function residuary(fr) {
  for (let i = 1; i < CR.length; i++) {
    if (fr <= CR[i][0]) return CR[i - 1][1] + ((CR[i][1] - CR[i - 1][1]) * (fr - CR[i - 1][0])) / (CR[i][0] - CR[i - 1][0]);
  }
  return 0.08;
}
// the water's resistance to her way (N), signed against it
export function hullResistance(v) {
  const a = Math.abs(v);
  const fr = a / Math.sqrt(9.81 * GALLEON.lwl);
  return Math.sign(v) * 0.5 * 1025 * GALLEON.wetted * a * a * (GALLEON.cf + residuary(fr));
}

// The model comes gzipped (tools/pack_glb.sh). In the single-file page it is
// a data: URL, decoded by hand (the page may not fetch() data: URLs).
async function loadBytes(url) {
  if (url.startsWith('data:')) {
    const bin = atob(url.slice(url.indexOf(',') + 1));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`galleon model ${url}: HTTP ${r.status}`);
  if (url.endsWith('.txt')) {            // base64 text (the page's host serves text, not binary)
    const bin = atob((await r.text()).trim());
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(await r.arrayBuffer());
}

// A plain float copy of a (possibly quantized) mesh's triangles, moved into
// the model's frame: the collider is raycast in model space.
function modelSpaceGeometry(mesh, inv) {
  const src = mesh.geometry;
  const p = src.attributes.position;
  const pos = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) { pos[i * 3] = p.getX(i); pos[i * 3 + 1] = p.getY(i); pos[i * 3 + 2] = p.getZ(i); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (src.index) g.setIndex(Array.from(src.index.array));
  g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld));
  return g;
}

// Turn `node` about an axis through `point` (model space) by wrapping it in
// a hinge there: the node's own origin may not be where it hinges (packing
// moves it to the middle of the mesh).
// (`point` is in `parent`'s frame)
function hingeAt(node, point, parent) {
  const h = new THREE.Object3D();
  h.position.copy(point);
  parent.add(h);
  h.updateMatrixWorld(true);
  h.attach(node);
  return h;
}

// The model's materials (by their Blender names) and the real, scanned
// material each part is made of (src/ship/Materials.js), with a tint where
// the scan's colour needs it. The model brings its own baked ambient
// occlusion (its second UV), kept as the material's aoMap.
const SCANS = {
  // a ship that has seen hard use: black paint gone dull and flaking,
  // weathered dark oak, tarnished metal, no gilt left shining
  hull_livery: ['hull_planks', { tint: [0.62, 0.56, 0.5] }],
  hull_upper: ['black_wood'],
  hull_bottom: ['hull_planks', { tint: [0.32, 0.33, 0.27] }],
  stern_carved: ['timber', { tint: [0.3, 0.26, 0.23] }],
  paint_red: ['black_wood'],
  paint_red_vertical: ['black_wood'],
  oak: ['timber', { tint: [0.4, 0.34, 0.29] }], oak_across: ['timber', { tint: [0.4, 0.34, 0.29] }],
  oak_vertical: ['timber', { tint: [0.4, 0.34, 0.29] }], grating: ['timber', { tint: [0.42, 0.37, 0.32] }],
  dark_wood: ['black_wood'], dark_wood_vertical: ['black_wood'],
  gilt: ['bronze', { tint: [0.42, 0.36, 0.26] }],
  carved_dark: ['timber', { tint: [0.3, 0.26, 0.23] }], carved_figure: ['timber', { tint: [0.36, 0.31, 0.27] }],
  deadeye: ['joinery', { tint: [0.6, 0.55, 0.5] }],
  iron: ['iron'],
  lead_sheathing: ['lead', { tint: [0.6, 0.6, 0.6] }],
  in_planking: ['in_planks'], in_timber: ['timber'],
  in_red_paint: ['red_paint', { tint: [0.22, 0.1, 0.08] }],      // gun decks were red below: blood shows less
  in_ballast_floor: ['in_planks', { tint: [0.55, 0.55, 0.55] }],
  in_cask: ['joinery', { tint: [1.0, 0.9, 0.8] }], in_crate: ['timber'],
  in_brick: ['brick'],
  in_bronze: ['bronze', { tint: [0.75, 0.55, 0.38] }],
  in_canvas: ['canvas', { tint: [0.3, 0.28, 0.25] }],
  deck_planks: ['deck_planks', { tint: [0.72, 0.7, 0.66] }],
  spar: ['timber', { tint: [0.24, 0.19, 0.15] }],                  // tarred pine
  rope: ['rope', { tint: [0.36, 0.3, 0.24] }],
};

export const GALLEON = {
  length: 47.5, beam: 15.0, draught: 4.8,     // a galleon's proportion: length/beam 3.2
  halfHull: [24.5, 7.45],           // waterline half length and half beam (hull foam, wake)
  mass: 6.5e5,                      // kg: displacement with added mass, eased for play
  // resistance of her hull: skin friction of a weed-grown oak bottom
  // (wetted area 634 m2, Cf with form and fouling 0.0045) and the wave
  // making that rises steeply toward her hull speed (Froude number, after
  // the residuary resistance of full-bodied ships)
  wetted: 634, cf: 0.0045, lwl: 47.5,
  rudderMax: 23,                    // deg, as on Vasa
  rudderRate: 6,                    // deg/s: a turn and a half of the wheel to put her hard over
  yawGain: 0.09,                    // rad/s of turn per rad of rudder at 4 m/s: a turning circle of ~4.5 lengths
  yawTime: 12,                      // s
  // roll ~12 s, pitch ~7 s, heave ~7 s for a ship of 1200 t
  seakeeping: { rollW: 0.52, rollZeta: 0.1, pitchW: 0.9, pitchZeta: 0.5, heaveW: 0.9, heaveZeta: 0.55 },
};

export class Galleon {
  constructor() {
    this.group = new THREE.Group();
    this.position = new THREE.Vector3();
    this.heading = 0;   // rad; forward = (-sin, 0, -cos); + turns to port
    this.speed = 0;     // m/s ahead through the water
    this.leeway = 0;    // m/s to starboard
    this.yawRate = 0;
    this.heel = 0; this.pitch = 0; this.roll = 0;
    this.pitchV = 0; this.rollV = 0; this.heaveV = 0;
    this.helm = 0;      // rudder order, deg (+ = port)
    this.rudder = 0;    // actual rudder, deg
    this.awa = 0; this.aws = 0;     // apparent wind: angle off the bow (+ from starboard), speed
    this.drive = 0;
    this.model = null;
    this.sails = new Sails(RIG);
    this.flags = new Flags(RIG);
    this.sweeps = new Sweeps(RIG);          // oars for a calm
    this.anchor = new Anchor(RIG);          // the best bower and the capstan
    this.worldGroup = new THREE.Group();    // what stays put in the world (the anchor on the bottom, its cable)
    this.seabed = () => -100;
    this.group.add(this.sails.group, this.flags.group);
    this.lantern = new THREE.PointLight(0xffb060, 0, 46, 1.6);
    this.lantern.position.set(...RIG.lanterns[1]);
    this.group.add(this.lantern);
    this.night = 0;
    this._euler = new THREE.Euler();
    this.rig = RIG;
    // the hull for a swimmer to keep out of (model space, m)
    this.hullShape = { halfLen: 24.5, halfBeam: 7.5, keel: -4.8, top: 14 };
    this.collider = null;
    this.interior = null;
    this.wheel = null;
    this.bowSpray = 0;
    this.slam = 0;
    // where spray is thrown from: the bow's shoulders to the stem
    this.sprayAt = { from: 19.5, len: 4.5, half: 4.6, taper: 0.9, up: 1.6 };
    this.lampSpots = (RIG.lamps || []).map((p) => new THREE.Vector3(...p));
    this.lamps = [0, 1].map(() => {
      const l = new THREE.PointLight(0xffb565, 0, 9, 1.6);
      l.castShadow = false;
      this.group.add(l);      // the group's frame is the model's
      return l;
    });
  }

  // Light the two lanterns nearest `p` (model space); k 0..1 how lit.
  lightLamps(p, k) {
    const near = this.lampSpots.map((q) => [q, q.distanceToSquared(p)]).sort((a, b) => a[1] - b[1]);
    this.lamps.forEach((l, i) => {
      const n = near[i];
      if (!n || k <= 0) { l.intensity = 0; return; }
      l.position.copy(n[0]);
      l.intensity = 3.4 * k * (0.93 + 0.07 * Math.sin(performance.now() * 0.011 + i * 2));
    });
  }

  get object() { return this.group; }
  get knots() { return this.speed * 1.943844; }

  load(url, onReady) {
    const loader = new GLTFLoader();
    const onLoad = (gltf) => {
      const model = gltf.scene;
      const glow = [];
      model.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.receiveShadow = true;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (!m) continue;
          if (m.name.startsWith('light_')) { glow.push(m); m.toneMapped = false; } else m.envMapIntensity = 0.5;
        }
        if (o.name.startsWith('rig')) o.castShadow = true;
      });
      this.glow = glow;
      // real materials in place of the model's own
      const made = new Map();
      model.traverse((o) => {
        if (!o.isMesh) return;
        const swap = (m) => {
          if (!m || !SCANS[m.name]) return m;
          const vc = !!o.geometry.attributes.color;          // the hull's weathering
          const key = `${m.name}${vc ? '+vc' : ''}`;
          let n = made.get(key);
          if (!n) {
            const [scan, opts = {}] = SCANS[m.name];
            n = shipMaterial(scan, this.renderer, { ...opts, ao: false });
            if (m.aoMap) { n.aoMap = m.aoMap; n.aoMapIntensity = 1; }
            n.side = m.side;
            n.vertexColors = vc;
            if (this.wet) this.wet.patch(n, POROSITY[scan] ?? 0.5);   // rain, sea and bilge on it
            made.set(key, n);
          }
          return n;
        };
        o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
      });
      // into her group first, so that everything below is worked out in one
      // frame (she may already be under way when the model arrives)
      this.group.add(model);
      this.group.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
      const toModel = (o) => new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
      // the rudder turns about the hinge line: the local up of its post
      const rudder = model.getObjectByName('rudder');
      if (rudder && rudder.parent && rudder.parent !== model) {
        this.rudderNode = hingeAt(rudder, new THREE.Vector3(), rudder.parent);
      }
      // the wheel turns about its spindle (fore and aft through its nave):
      // the middle of its rim
      const wheel = model.getObjectByName('wheel');       // a mesh, or a group of one per material
      if (wheel) {
        const bb = new THREE.Box3();
        wheel.traverse((o) => {
          if (!o.isMesh) return;
          o.geometry.computeBoundingBox();
          bb.union(o.geometry.boundingBox.clone().applyMatrix4(toModel(o)));
        });
        const c = bb.getCenter(new THREE.Vector3());
        this.wheel = hingeAt(wheel, new THREE.Vector3(c.x, c.y, bb.max.z - 0.17), model);
      }
      // the collision mesh: never drawn, raycast in model space
      const col = model.getObjectByName('collision');
      if (col) {
        const geos = [];
        col.traverse((o) => { if (o.isMesh) geos.push(modelSpaceGeometry(o, inv)); });
        col.removeFromParent();
        const geo = geos.length > 1 ? mergeGeometries(geos) : geos[0];
        if (geo) {
          geo.computeBoundingSphere();
          geo.computeBoundingBox();
          this.collider = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
        }
      }
      // the spaces below: drawn only when you could see them
      this.interior = model.getObjectByName('interior');
      // the yards turn with their mast: hand them to the sails' mast groups
      for (const [name, m] of Object.entries(RIG.masts)) {
        for (const y of m.yards) {
          const n = model.getObjectByName(y.node);
          if (n) this.sails.pivots[name].attach(n);
        }
      }
      this.model = model;
      this.sweeps.attach(model);
      this.anchor.attach(model, this.worldGroup, hingeAt);
      if (this.wet) this.wet.bake(model);       // what the rain can reach
      this.setNight(this.night);
      if (onReady) onReady(this);
    };
    const onError = (e) => console.error('galleon model failed to load', e);
    loadBytes(url).then((b) => {
      const glb = b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b;   // a server may have unzipped it already
      loader.parse(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), '', onLoad, onError);
    }).catch(onError);
  }

  // ---------------------------------------------------------------- controls
  // turn: -1..1 held (keys: back to midships when let go); target: deg (touch)
  steer(turn, target = null) {
    if (target != null) this.helm = THREE.MathUtils.clamp(target, -GALLEON.rudderMax, GALLEON.rudderMax);
    else this.helm = turn * GALLEON.rudderMax;
  }

  sail(dir) { this.sails.setLevel(this.sails.level + dir); }

  // Out sweeps, or in.
  toggleSweeps() { this.sweeps.set(!this.sweeps.rowing); return this.sweeps.rowing ? 'на вёсла! — вёсла на воду' : 'суши вёсла — убрать'; }

  // Let go the anchor, or weigh it (or stop the capstan).
  anchorOrder(waterY) { return this.anchor.order(waterY, this.seabed); }

  setNight(k) {
    this.night = k;
    this.lantern.intensity = 26 * k;
    if (this.glow) {
      for (const m of this.glow) {
        m.emissiveIntensity = m.name.includes('lantern') ? 1 + 22 * k : 0.3 + 9 * k;
      }
    }
    this.sails.setNight(k);
  }

  // ---------------------------------------------------------------- sailing
  // wind: { x, z } true wind velocity (m/s, the way it blows)
  update(dt, time, wind, canMove = null) {
    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    const fwd = [-fx, -fz], stb = [fz, -fx];
    // her velocity over the water, and the apparent wind
    const vx = fwd[0] * this.speed + stb[0] * this.leeway, vz = fwd[1] * this.speed + stb[1] * this.leeway;
    const ax = wind.x - vx, az = wind.z - vz;          // the air going past her
    this.aws = Math.hypot(ax, az);
    // where the wind comes from, off the bow (+ from starboard)
    const wf = -(ax * fwd[0] + az * fwd[1]), ws = -(ax * stb[0] + az * stb[1]);
    this.awa = Math.atan2(ws, wf);

    // canvas spread drives her along according to the angle of the wind
    const spread = this.sails.spread;
    const c = squareDrive(this.awa / DEG);
    const q = 0.5 * 1.225 * this.aws * this.aws;
    const force = q * spread * c * 0.85;
    this.drive = c;
    const turnLoss = 0.25 * Math.abs(this.yawRate) * this.speed * GALLEON.mass;
    // the wind on her hull, castles and bare rigging (about 380 m2 of drag
    // area): with no sail set she still drifts before it, astern if it is
    // ahead, until (at anchor) the cable takes her
    const windage = q * 380 * (-(Math.cos(this.awa)));     // + ahead when the wind is from astern
    // the sweeps, pulling (or backing water on the side she is to turn to)
    this.sweeps.update(dt, this.helm / GALLEON.rudderMax);
    this.speed += ((force + windage + this.sweeps.thrust - hullResistance(this.speed) - turnLoss) / GALLEON.mass) * dt;
    // leeway: pushed sideways by the wind on her sails and her high sides
    const side = q * (spread * 0.35 + 260) * Math.sin(this.awa) * Math.abs(Math.cos(this.awa * 0.5));
    const wantLee = -Math.sign(side) * Math.min(0.9, Math.sqrt(Math.abs(side) / 60000) * (0.4 + 0.6 / (1 + Math.abs(this.speed))));
    this.leeway += (wantLee - this.leeway) * Math.min(1, dt * 0.15);

    // the rudder follows the wheel; the ship answers it with way on
    const dr = THREE.MathUtils.clamp(this.helm - this.rudder, -GALLEON.rudderRate * dt, GALLEON.rudderRate * dt);
    this.rudder += dr;
    const flow = this.speed;
    let target = GALLEON.yawGain * (flow / 4) * this.rudder * DEG;
    // the sails help her round, as a crew would work them: to come up into
    // the wind they sheet home the mizzen (aft) and let the spritsail (far
    // forward) shake; to bear away the other way about. Her long ends make
    // these small sails strong levers, and they turn her even with little
    // way on, which the rudder cannot. Wind ahead: the headsails are backed.
    const order = this.helm / GALLEON.rudderMax;          // -1..1, + to port
    if (Math.abs(order) > 0.05) {
      const press = Math.min(1, (this.aws / 8) ** 2);
      const side = 0.35 + 0.65 * Math.abs(Math.sin(this.awa));
      target += 0.016 * order * press * side * (0.4 + 0.6 * (this.sails.setFrac || 0));
    }
    // and the sweeps' turning moment (one side pulling, the other backing),
    // and the anchor cable swinging her head to it
    target += this.sweeps.moment * 7.6e-7 + this.anchor.yawPull;
    this.yawRate += (target - this.yawRate) * (dt / GALLEON.yawTime);
    this.heading += this.yawRate * dt;
    if (this.rudderNode) this.rudderNode.rotation.y = -this.rudder * DEG;
    // the wheel: a turn and a half each way, its top going the way her head
    // is to go
    if (this.wheel) this.wheel.rotation.z = (this.rudder / GALLEON.rudderMax) * 1.5 * 2 * Math.PI;

    // heel to leeward with the press of sail
    const heelT = THREE.MathUtils.clamp(Math.sin(this.awa) * Math.min(1, q * spread / 9.0e4) * 0.14, -0.16, 0.16);
    this.heel += (heelT - this.heel) * (1 - Math.exp(-dt * 0.4));

    // move; touching the ground ahead or to leeward she is thrown back off it
    // (and with sternway the rudder turns her the other way, to get clear)
    const nx = this.position.x + vx * dt, nz = this.position.z + vz * dt;
    const ahead = Math.sign(this.speed || 1) * (GALLEON.length / 2 + 4);
    const lee = Math.sign(this.leeway || 1) * (GALLEON.beam / 2 + 3);
    const okAhead = !canMove || canMove(nx - fx * ahead, nz - fz * ahead);
    const okSide = !canMove || canMove(nx + stb[0] * lee, nz + stb[1] * lee);
    if (okAhead && okSide) {
      this.position.x = nx;
      this.position.z = nz;
    } else {
      if (!okAhead) { this.speed = -0.3 * Math.sign(this.speed || 1); this.yawRate *= 0.5; this.grounded = 1; }
      if (!okSide) this.leeway = -0.2 * Math.sign(this.leeway || 1);
    }
    this.grounded = Math.max(0, (this.grounded || 0) - dt * 0.5);

    // seakeeping: heave on the mean level, pitch and roll
    // from the water's slope along and across her, second-order responses
    const lh = GALLEON.length * 0.4, bh = GALLEON.beam * 0.45;
    const water = this.water;
    const px = this.position.x, pz = this.position.z;
    const hC = water(px, pz, time).height;
    const hBow = water(px - fx * lh, pz - fz * lh, time).height;
    const hStern = water(px + fx * lh, pz + fz * lh, time).height;
    const hStbd = water(px + stb[0] * bh, pz + stb[1] * bh, time).height;
    const hPort = water(px - stb[0] * bh, pz - stb[1] * bh, time).height;
    const hMean = (hC * 2 + hBow + hStern + hStbd + hPort) / 6;
    const sm = GALLEON.seakeeping;
    this.heaveV += ((sm.heaveW ** 2) * (hMean - this.position.y) - 2 * sm.heaveZeta * sm.heaveW * this.heaveV) * dt;
    this.position.y += this.heaveV * dt;
    const pitchT = Math.atan2(hBow - hStern, 2 * lh);
    const rollT = Math.atan2(hStbd - hPort, 2 * bh);
    this.pitchV += ((sm.pitchW ** 2) * (pitchT - this.pitch) - 2 * sm.pitchZeta * sm.pitchW * this.pitchV) * dt;
    this.pitch += this.pitchV * dt;
    this.rollV += ((sm.rollW ** 2) * (rollT - this.roll) - 2 * sm.rollZeta * sm.rollW * this.rollV) * dt;
    this.roll = THREE.MathUtils.clamp(this.roll + this.rollV * dt, -0.5, 0.5);
    // spray: the bow driving into the sea with way on, a burst when she
    // buries it
    const bowDip = hBow - (this.position.y - Math.sin(this.pitch) * lh);
    const way = THREE.MathUtils.clamp((this.speed - 1.0) / 3.5, 0, 1);
    this.bowSpray = way * THREE.MathUtils.clamp(0.15 + bowDip * 0.5 - this.pitchV * 0.8, 0, 1);
    this.slam = 0;
    if (bowDip > 1.1 && this.pitchV < -0.12 && way > 0.3 && !this._buried) { this.slam = Math.min(1, (bowDip - 1.1) * 0.8 + 0.3) * way; this._buried = true; }
    if (bowDip < 0.6) this._buried = false;

    // riding to her anchor: the cable holds her and swings her head to it
    this.anchor.update(dt, this, hC, this.seabed);

    this._euler.set(this.pitch, this.heading, this.roll + this.heel, 'YXZ');
    this.group.position.copy(this.position);
    this.group.quaternion.setFromEuler(this._euler);
    this.group.updateMatrixWorld(true);

    // canvas and colours
    this.sails.update(dt, this.awa, this.aws, time);
    // flags stream to leeward: the apparent wind's direction in her frame
    this.flags.update(time, Math.atan2(-Math.cos(this.awa), -Math.sin(this.awa)), Math.min(1, this.aws / 12));
  }

  // A few words for the HUD.
  describe() {
    const a = Math.abs(this.awa / DEG);
    const side = this.awa >= 0 ? 'справа' : 'слева';
    const course = a < 50 ? 'в лоб — паруса на мачту!' : a < 70 ? `круто к ветру ${side}` : a < 110 ? `в галфвинд ${side}` : a < 160 ? `бакштаг ${side}` : 'фордевинд';
    const lvl = ['паруса убраны', 'нижние паруса', 'нижние и марсели', 'все паруса'][this.sails.level];
    const extra = [this.sweeps.rowing ? (this.sweeps.out < 1 ? 'вёсла выдвигают' : 'на вёслах') : this.sweeps.out > 0 ? 'вёсла убирают' : '',
      this.anchor.describe()].filter(Boolean).join(' · ');
    return { course, lvl, extra };
  }
}
