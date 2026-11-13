import * as THREE from 'three';
import { scanTexture } from './Materials.js';
import { shapeSquare, Clearance } from './SailShape.js';

// The galleon's canvas, built here rather than in Blender so that it can be
// set and furled, fill with the wind, shiver when the wind comes too far
// forward and be taken aback. Ten sails, as on Vasa: spritsail and sprit
// topsail under and over the bowsprit; course, topsail and topgallant on the
// fore and main masts; a lateen mizzen and a mizzen topsail. Their corners
// come from src/ship/galleon_rig.json, written by blender/build_galleon.py.
//
// Square sails hang from yards that turn about their mast (bracing), so they
// live in one group per mast, turned with the yards. Coordinates are the
// model's own: bow toward -Z, x to starboard.

const NX = 24, NY = 18;          // square sails: fine enough to wrap round a rope
const SPRIT = [16, 12], LATEEN = 16;

// Old canvas that has seen hard weather: dark, stained and sun-rotted,
// sewn in vertical cloths, patched, holed and torn, the foot gone ragged;
// our star on the courses and topsails, faded and half worn away. The holes
// and tears are cut out of the alpha (the sail is drawn with alphaTest).
function rng(seed) {
  let x = seed >>> 0;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
}
function jagged(g, cx, cy, r, n, rand, spikes = 0.45) {
  g.beginPath();
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const rr = r * (1 - spikes + spikes * 2 * rand());
    g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * (0.7 + 0.6 * rand()));
  }
  g.closePath();
}
function canvasTexture(emblem, seed = 1) {
  const S = 1024;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d');
  const rand = rng(seed * 7919 + (emblem ? 13 : 0));
  g.fillStyle = '#2b261f';
  g.fillRect(0, 0, S, S);
  // stains, rot and salt
  for (let i = 0; i < 160; i++) {
    const x = rand() * S, y = rand() * S, r = 30 + rand() * 200;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    const kind = rand();
    gr.addColorStop(0, kind < 0.35 ? 'rgba(92,84,70,0.16)' : kind < 0.8 ? 'rgba(6,5,4,0.25)' : 'rgba(60,52,30,0.14)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  // water marks running down
  for (let i = 0; i < 40; i++) {
    const x = rand() * S, y = rand() * S * 0.6, w = 6 + rand() * 30, h = 120 + rand() * 400;
    const gr = g.createLinearGradient(0, y, 0, y + h);
    gr.addColorStop(0, 'rgba(0,0,0,0.0)'); gr.addColorStop(0.3, 'rgba(0,0,0,0.18)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(x, y, w, h);
  }
  // cloths: seams every 1/14 of the width
  for (let k = 1; k < 14; k++) {
    const x = (k * S) / 14 + (rand() - 0.5) * 4;
    g.fillStyle = 'rgba(0,0,0,0.4)'; g.fillRect(x - 1.5, 0, 3, S);
    g.fillStyle = 'rgba(110,98,80,0.1)'; g.fillRect(x + 2, 0, 5, S);
  }
  // reef bands and the boltrope
  g.fillStyle = 'rgba(0,0,0,0.35)';
  for (const y of [140, 280]) g.fillRect(0, y, S, 7);
  g.strokeStyle = 'rgba(16,13,10,0.95)'; g.lineWidth = 14; g.strokeRect(7, 7, S - 14, S - 14);
  // patches of other canvas, sewn on crooked
  for (let i = 0; i < 9; i++) {
    const x = rand() * (S - 160), y = 200 + rand() * (S - 400), w = 60 + rand() * 120, h = 60 + rand() * 150;
    g.save(); g.translate(x + w / 2, y + h / 2); g.rotate((rand() - 0.5) * 0.25);
    const t = 30 + rand() * 40;
    g.fillStyle = `rgba(${t + 8},${t},${t - 8},0.85)`; g.fillRect(-w / 2, -h / 2, w, h);
    g.setLineDash([5, 6]); g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 2; g.strokeRect(-w / 2 + 4, -h / 2 + 4, w - 8, h - 8);
    g.restore();
  }
  g.setLineDash([]);
  let mask = null;
  if (emblem) {
    const draw = (ctx, col, sc = 1) => {
      ctx.save();
      ctx.translate(512 * sc, 540 * sc);
      ctx.fillStyle = col;
      ctx.beginPath();
      for (let k = 0; k < 16; k++) {
        const a = -Math.PI / 2 + (Math.PI * 2 * k) / 16;
        const r = (k % 4 === 0 ? 300 : k % 2 === 0 ? 190 : 76) * sc;
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath(); ctx.fill();
      ctx.restore();
    };
    draw(g, 'rgba(150,132,104,0.55)');                     // dull bone, faded
    // worn away in patches
    g.globalCompositeOperation = 'source-atop';
    for (let i = 0; i < 70; i++) {
      const x = 512 + (rand() - 0.5) * 620, y = 540 + (rand() - 0.5) * 620, r = 10 + rand() * 50;
      g.fillStyle = `rgba(43,38,31,${0.4 + rand() * 0.5})`;
      jagged(g, x, y, r, 9, rand); g.fill();
    }
    g.globalCompositeOperation = 'source-over';
    const m = document.createElement('canvas');
    m.width = 256; m.height = 256;
    const mg = m.getContext('2d');
    mg.fillStyle = '#000'; mg.fillRect(0, 0, 256, 256);
    draw(mg, '#555', 0.25);
    mask = new THREE.CanvasTexture(m);
    mask.colorSpace = THREE.SRGBColorSpace;
  }
  // now the damage, cut out of the canvas
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = '#000';
  // the foot frayed and torn away in tongues
  g.beginPath();
  g.moveTo(0, S);
  for (let x = 0; x <= S; x += 8) g.lineTo(x, S - 10 - rand() * 46 - (rand() < 0.08 ? 60 + rand() * 120 : 0));
  g.lineTo(S, S); g.closePath(); g.fill();
  // holes: shot and rot, with frayed edges
  const holes = [];
  const nh = 4 + Math.floor(rand() * 5);
  for (let i = 0; i < nh; i++) {
    const x = 60 + rand() * (S - 120), y = 120 + rand() * (S - 260), r = 10 + rand() * (rand() < 0.3 ? 70 : 28);
    jagged(g, x, y, r, 14, rand, 0.5); g.fill();
    holes.push([x, y, r]);
  }
  // tears up from the foot and along the seams
  const nt = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < nt; i++) {
    let x = 80 + rand() * (S - 160), y = S;
    const len = 150 + rand() * 380;
    g.beginPath(); g.moveTo(x - 4, y);
    const pts = [];
    // a rent that gapes at the foot and closes toward its end
    for (let t = 0; t < len; t += 16) { x += (rand() - 0.5) * 26; y -= 16; pts.push([x, y, 1 - t / len]); }
    for (const [px, py, w] of pts) g.lineTo(px - (4 + rand() * 6) - 22 * w, py);
    for (const [px, py, w] of pts.reverse()) g.lineTo(px + (4 + rand() * 6) + 22 * w, py);
    g.closePath(); g.fill();
  }
  // a darker, rotten rim round every hole
  g.globalCompositeOperation = 'source-atop';
  for (const [x, y, r] of holes) {
    const gr = g.createRadialGradient(x, y, r * 0.8, x, y, r * 1.8);
    gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(x - 2 * r, y - 2 * r, 4 * r, 4 * r);
  }
  g.globalCompositeOperation = 'source-over';
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { tex, mask };
}

// Drive of a square sail by the angle of the apparent wind off the bow
// (deg, 0 = dead ahead): aback below ~55 deg, full from the beam aft.
export function squareDrive(awaDeg) {
  const a = Math.abs(awaDeg);
  const T = [[0, -0.35], [45, -0.18], [58, 0.0], [68, 0.42], [90, 0.8], [115, 1.0], [160, 1.0], [180, 0.88]];
  for (let i = 1; i < T.length; i++) {
    if (a <= T[i][0]) {
      const [a0, c0] = T[i - 1], [a1, c1] = T[i];
      return c0 + ((c1 - c0) * (a - a0)) / (a1 - a0);
    }
  }
  return 0.88;
}

class Sail {
  constructor({ name, mesh, corners, area, kind, level, bundle, bundleLen }) {
    Object.assign(this, { name, mesh, corners, area, kind, level, bundle, bundleLen });
    this.set = 0;          // 0 furled .. 1 set
    this.target = 0;
    this.pos = mesh.geometry.attributes.position;
    this.flat = new Float32Array(this.pos.count);     // the canvas's flat z (no belly)
  }
}

export class Sails {
  constructor(rig) {
    this.rig = rig;
    this.group = new THREE.Group();
    this.pivots = {};
    this.sails = [];
    this.level = 0;           // 0 all furled, 1 courses, 2 + topsails, 3 + topgallants
    this.brace = 0;           // yard angle (rad), + turns the starboard yardarm forward
    const weave = scanTexture('canvas', 'nrm', 26, 26, null);
    const mat = (t) => new THREE.MeshStandardMaterial({
      map: t.tex, side: THREE.DoubleSide, roughness: 0.95, metalness: 0, alphaTest: 0.5,
      normalMap: weave, normalScale: new THREE.Vector2(0.6, 0.6),
      emissiveMap: t.mask || null, emissive: new THREE.Color(t.mask ? 0xff9a3c : 0x000000), emissiveIntensity: 0,
    });
    const plain = canvasTexture(false, 1), emb = canvasTexture(true, 2);
    this.matPlain = mat(plain);
    this.matEmblem = mat(emb);
    this.bundleMat = new THREE.MeshStandardMaterial({ color: 0x2a241e, roughness: 0.95 });

    for (const [name, m] of Object.entries(rig.masts)) {
      const p = new THREE.Group();
      p.position.set(m.x, 0, m.z);
      p.name = `pivot_${name}`;
      this.group.add(p);
      this.pivots[name] = p;
    }
    const levelOf = (n) => (/topgallant/.test(n) ? 3 : /topsail/.test(n) ? 2 : 1);
    for (const s of rig.sails) {
      if (s.type === 'square') this._square(s, levelOf(s.name));
      else if (s.type === 'lateen') this._lateen(s);
      else if (s.type === 'sprit') this._sprit(s, s.name === 'sprit_topsail' ? 2 : 1);
    }
    this.totalArea = this.sails.reduce((a, s) => a + s.area, 0);
    this.clear = new Clearance(rig);          // the canvas kept clear of the rigging
  }

  _grid(n, emblem) {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(n.nx * n.ny * 3);
    const uv = new Float32Array(n.nx * n.ny * 2);
    const idx = [];
    for (let j = 0; j < n.ny; j++) {
      for (let i = 0; i < n.nx; i++) {
        const k = j * n.nx + i;
        uv[2 * k] = i / (n.nx - 1);
        uv[2 * k + 1] = 1 - j / (n.ny - 1);
        if (i < n.nx - 1 && j < n.ny - 1) idx.push(k, k + 1, k + n.nx, k + 1, k + n.nx + 1, k + n.nx);
      }
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    const mesh = new THREE.Mesh(g, emblem ? this.matEmblem : this.matPlain);
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    return mesh;
  }

  _bundle(len, parent, at) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, len, 8, 1), this.bundleMat);
    b.rotation.z = Math.PI / 2;
    b.position.copy(at);
    b.castShadow = true;
    parent.add(b);
    return b;
  }

  _square(s, level) {
    const pivot = this.pivots[s.mast];
    const mesh = this._grid({ nx: NX, ny: NY }, s.emblem);
    pivot.add(mesh);
    const h = s.head, f = s.foot;
    const corners = {
      head: new THREE.Vector3(0, h.y, -h.fwd), hw: h.w,
      foot: new THREE.Vector3(0, f.y, -f.fwd), fw: f.w,
      roach: /topsail|topgallant/.test(s.name) ? 0.085 : 0.03,     // a topsail's foot curves up over the top
    };
    const area = ((h.w + f.w) / 2) * (h.y - f.y);
    const bundle = this._bundle(h.w * 0.92, pivot, new THREE.Vector3(0, h.y - 0.2, -h.fwd - 0.12));
    this.sails.push(new Sail({ name: s.name, mesh, corners, area, kind: 'square', level, bundle, bundleLen: h.w }));
  }

  _lateen(s) {
    const pivot = this.pivots[s.mast];
    const mesh = this._grid({ nx: LATEEN, ny: LATEEN }, false);
    pivot.add(mesh);
    const off = new THREE.Vector3(0, 0, -pivot.position.z);
    const v = (a) => new THREE.Vector3(a[0], a[1], a[2]).add(off);
    const corners = { tack: v(s.tack), peak: v(s.peak), clew: v(s.clew) };
    const e1 = corners.peak.clone().sub(corners.tack), e2 = corners.clew.clone().sub(corners.tack);
    const area = e1.clone().cross(e2).length() / 2;
    const mid = corners.tack.clone().lerp(corners.peak, 0.5);
    const bundle = this._bundle(e1.length() * 0.9, pivot, mid);
    bundle.rotation.set(0, 0, 0);
    bundle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), e1.clone().normalize());
    this.sails.push(new Sail({ name: s.name, mesh, corners, area, kind: 'lateen', level: 1, bundle, bundleLen: e1.length() }));
  }

  _sprit(s, level) {
    const mesh = this._grid({ nx: SPRIT[0], ny: SPRIT[1] }, false);
    this.group.add(mesh);
    const corners = {
      head: new THREE.Vector3(...s.head), hw: s.w,
      foot: new THREE.Vector3(...s.foot), fw: s.fw,
    };
    const area = ((s.w + s.fw) / 2) * corners.head.distanceTo(corners.foot);
    const bundle = this._bundle(s.w * 0.9, this.group, corners.head.clone().add(new THREE.Vector3(0, 0.2, 0)));
    this.sails.push(new Sail({ name: s.name, mesh, corners, area, kind: 'sprit', level, bundle, bundleLen: s.w }));
  }

  setLevel(l) {
    this.level = THREE.MathUtils.clamp(l, 0, 3);
    for (const s of this.sails) s.target = s.level <= this.level ? 1 : 0;
  }

  // Area of canvas spread (m2), and the fraction of all of it.
  get spread() {
    let a = 0;
    for (const s of this.sails) a += s.area * s.set;
    return a;
  }

  // dt; awa: apparent wind angle off the bow (rad, + from starboard);
  // aws: apparent wind speed (m/s); time for the shiver.
  update(dt, awa, aws, time) {
    // yards braced round for the wind: the windward yardarms forward, as far
    // as the shrouds allow (38 deg); square to a wind from astern
    const a = Math.abs(awa);
    const want = Math.sign(awa) * Math.min(THREE.MathUtils.degToRad(38), Math.max(0, Math.PI - a) * 0.5);
    this.brace += (want - this.brace) * Math.min(1, dt * 0.35);
    // each mast's yards only as far as its shrouds and backstays let them
    for (const [name, p] of Object.entries(this.pivots)) {
      const lim = this.clear.masts[name] ? this.clear.masts[name].limit : 0.66;
      p.rotation.y = Math.sign(this.brace) * Math.min(Math.abs(this.brace), lim) * (name === 'mizzen' ? 0.6 : 1);
    }

    // the wind on the sails themselves: 180 deg is square behind them (full),
    // 90 deg along them (shivering), less is on their fore side (aback)
    const rel = Math.abs(THREE.MathUtils.radToDeg(awa + this.brace));
    const press = Math.min(1.2, (aws / 8) ** 1.1);
    const fill = THREE.MathUtils.clamp((rel - 92) / 16, -0.6, 1.0) * press;
    const shiver = Math.max(0, 1 - Math.abs(rel - 92) / 10) * Math.min(1, aws / 5);
    // for the sound: how much canvas is set, and how much of it flogs
    let total = 0, set = 0;
    for (const s of this.sails) { total += s.area; set += s.area * s.set; }
    this.setFrac = total ? set / total : 0;
    this.flog = Math.min(1, shiver + (fill < 0 ? 0.6 * Math.min(1, -fill * 3) : 0));

    for (const s of this.sails) {
      s.set += THREE.MathUtils.clamp(s.target - s.set, -dt * 0.22, dt * 0.22);
      const vis = s.set > 0.02;
      s.mesh.visible = vis;
      const furled = 1 - s.set;
      s.bundle.visible = furled > 0.05;
      const r = 0.12 + 0.3 * furled;
      if (s.kind === 'lateen') s.bundle.scale.set(r, 1, r);
      else s.bundle.scale.set(r, 1, r);
      if (!vis) continue;
      if (s.kind === 'lateen') this._shapeLateen(s, fill, shiver, time, awa);
      else this._shapeSquare(s, s.kind === 'sprit' ? Math.max(0.15, fill) : fill, shiver, time);
    }
  }

  _shapeSquare(s, fill, shiver, time) {
    const sprit = s.kind === 'sprit';
    const [nx, ny] = sprit ? SPRIT : [NX, NY];
    shapeSquare(s.pos.array, s.flat, nx, ny, s.corners, s.set, fill, shiver, time, sprit);
    const mast = sprit ? null : s.mesh.parent.name.replace('pivot_', '');
    this.clear.square(s.pos.array, s.flat, nx, ny, mast, sprit ? 0 : s.mesh.parent.rotation.y);
    s.pos.needsUpdate = true;
    s.mesh.geometry.computeVertexNormals();
  }

  _shapeLateen(s, fill, shiver, time, awa) {
    const { tack, peak, clew } = s.corners;
    const P = s.pos.array;
    const n = LATEEN;
    const e1 = peak.clone().sub(tack), e2 = clew.clone().sub(tack);
    const nrm = e1.clone().cross(e2).normalize();          // to starboard
    const side = -Math.sign(awa || 1);                     // bellies to leeward
    const depth = 0.08 * e1.length() * Math.min(1, Math.abs(fill) + 0.3) * side;
    const p = new THREE.Vector3();
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = i / (n - 1), b = (j / (n - 1)) * (1 - a) * s.set;   // collapse onto the yard when furled
        p.copy(tack).addScaledVector(e1, a).addScaledVector(e2, b);
        // laced to the yard along its head: no belly there
        const belly = Math.sin(Math.PI * a) * Math.sin(Math.PI * Math.min(1, 0.9 * b / Math.max(0.05, 1 - a)));
        p.addScaledVector(nrm, depth * belly);
        if (shiver > 0.01) p.addScaledVector(nrm, Math.sin(time * 8 + a * 6 + j) * 0.15 * shiver * belly);
        const k = 3 * (j * n + i);
        P[k] = p.x; P[k + 1] = p.y; P[k + 2] = p.z;
      }
    }
    this.clear.lateen(P, n * n, 'mizzen', s.mesh.parent.rotation.y);
    s.pos.needsUpdate = true;
    s.mesh.geometry.computeVertexNormals();
  }

  // Canvas soaked by rain is darker and heavier (k 0..1).
  setWet(k) {
    const c = 1 - 0.45 * k;
    this.matPlain.color.setScalar(c);
    this.matEmblem.color.setScalar(c);
    this.bundleMat.color.setRGB(0.165 * c, 0.141 * c, 0.118 * c);
  }

  // The emblems glow faintly at night, lit from the lanterns and the deck.
  setNight(k) {
    this.matEmblem.emissiveIntensity = 0.35 * k;
  }
}

// Ensign over the stern and long pennants at the mastheads, waving.
export class Flags {
  constructor(rig) {
    this.group = new THREE.Group();
    // a black flag: a skull over crossed bones, in bone white, the fly
    // end frayed
    const c = document.createElement('canvas');
    c.width = 512; c.height = 320;
    const g = c.getContext('2d');
    const rand = rng(77);
    g.fillStyle = '#0d0c0b'; g.fillRect(0, 0, 512, 320);
    for (let i = 0; i < 40; i++) {
      const x = rand() * 512, y = rand() * 320, r = 20 + rand() * 80;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, rand() < 0.5 ? 'rgba(60,55,48,0.18)' : 'rgba(0,0,0,0.3)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    g.save(); g.translate(230, 160);
    g.fillStyle = '#cfc6b0'; g.strokeStyle = '#cfc6b0';
    for (const a of [0.6, -0.6]) {                 // the crossed bones
      g.save(); g.rotate(a);
      g.fillRect(-120, -11, 240, 22);
      for (const x of [-120, 120]) for (const y of [-14, 14]) { g.beginPath(); g.arc(x, y, 16, 0, Math.PI * 2); g.fill(); }
      g.restore();
    }
    g.beginPath(); g.ellipse(0, -18, 62, 66, 0, 0, Math.PI * 2); g.fill();          // the skull
    g.fillRect(-34, 30, 68, 34);
    g.fillStyle = '#0d0c0b';
    for (const x of [-24, 24]) { g.beginPath(); g.ellipse(x, -18, 17, 20, 0, 0, Math.PI * 2); g.fill(); }
    g.beginPath(); g.moveTo(0, 2); g.lineTo(-8, 18); g.lineTo(8, 18); g.closePath(); g.fill();
    for (let x = -26; x <= 26; x += 13) g.fillRect(x - 2, 40, 4, 22);
    g.restore();
    g.globalCompositeOperation = 'destination-out';
    g.beginPath(); g.moveTo(512, 0);
    for (let y = 0; y <= 320; y += 10) g.lineTo(512 - 6 - rand() * 40 - (rand() < 0.15 ? 40 : 0), y);
    g.lineTo(512, 320); g.closePath(); g.fill();
    for (let i = 0; i < 3; i++) { jagged(g, 300 + rand() * 180, 30 + rand() * 260, 6 + rand() * 14, 10, rand); g.fill(); }
    g.globalCompositeOperation = 'source-over';
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.95, alphaTest: 0.5 });
    const pmat = new THREE.MeshStandardMaterial({ color: 0x2a0b09, side: THREE.DoubleSide, roughness: 0.95 });
    this.flags = [];
    const add = (at, w, h, m, nx) => {
      const geo = new THREE.PlaneGeometry(w, h, nx, 2);
      geo.translate(w / 2, -h / 2, 0);
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(...at);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.flags.push({ mesh, base: geo.attributes.position.array.slice(), w });
    };
    add(rig.ensign.tip, 5.2, 3.3, mat, 12);
    for (const p of rig.pennants) add(p, 9, 0.5, pmat, 16);
  }

  // windAngle: direction the apparent wind blows toward, in the ship's frame
  // (rad about Y); strength 0..1.
  update(time, windAngle, strength) {
    for (const [n, f] of this.flags.entries()) {
      f.mesh.rotation.y = windAngle;
      const P = f.mesh.geometry.attributes.position.array, B = f.base;
      for (let i = 0; i < P.length; i += 3) {
        const x = B[i];
        const t = x / f.w;
        P[i + 2] = Math.sin(time * (5 + 3 * strength) - x * 0.9 + n) * t * (0.35 + 0.4 * strength);
        P[i + 1] = B[i + 1] - t * t * (1 - strength) * f.w * 0.35;
      }
      f.mesh.geometry.attributes.position.needsUpdate = true;
      f.mesh.geometry.computeVertexNormals();
    }
  }
}
