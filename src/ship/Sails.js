import * as THREE from 'three';

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

const NX = 10, NY = 9;

// Dark weathered canvas, sewn in vertical cloths, with our emblem on the
// courses and topsails: an eight-pointed star in a ring over a wave.
function canvasTexture(emblem) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#2e2822';
  g.fillRect(0, 0, 512, 512);
  // stains and sun-bleaching
  for (let i = 0; i < 70; i++) {
    const x = Math.random() * 512, y = Math.random() * 512, r = 20 + Math.random() * 90;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    const light = Math.random() < 0.5;
    gr.addColorStop(0, light ? 'rgba(90,80,64,0.18)' : 'rgba(10,8,6,0.22)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  // cloths: seams every 1/14 of the width, a little lighter tape beside
  for (let k = 1; k < 14; k++) {
    const x = (k * 512) / 14;
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(x - 1, 0, 2, 512);
    g.fillStyle = 'rgba(120,105,85,0.12)';
    g.fillRect(x + 1, 0, 3, 512);
  }
  // reef bands and the boltrope round the edge
  g.fillStyle = 'rgba(0,0,0,0.3)';
  for (const y of [70, 140]) g.fillRect(0, y, 512, 4);
  g.strokeStyle = 'rgba(20,16,12,0.9)';
  g.lineWidth = 8;
  g.strokeRect(4, 4, 504, 504);
  // a few patches
  for (let i = 0; i < 5; i++) {
    const x = Math.random() * 440, y = 180 + Math.random() * 280, w = 30 + Math.random() * 40, h = 30 + Math.random() * 50;
    g.fillStyle = `rgba(${60 + Math.random() * 30},${52 + Math.random() * 20},${40},0.5)`;
    g.fillRect(x, y, w, h);
    g.strokeStyle = 'rgba(0,0,0,0.4)'; g.lineWidth = 1.5; g.strokeRect(x, y, w, h);
  }
  let mask = null;
  if (emblem) {
    const draw = (ctx, col) => {
      ctx.save();
      ctx.translate(256, 270);
      ctx.strokeStyle = col; ctx.fillStyle = col;
      ctx.lineWidth = 12;
      ctx.beginPath(); ctx.arc(0, 0, 118, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      for (let k = 0; k < 16; k++) {
        const a = -Math.PI / 2 + (Math.PI * 2 * k) / 16;
        const r = k % 4 === 0 ? 102 : k % 2 === 0 ? 64 : 26;
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath(); ctx.fill();
      ctx.lineWidth = 9;
      ctx.beginPath();
      for (let k = 0; k <= 24; k++) {
        const x = -110 + (220 * k) / 24;
        ctx.lineTo(x, 150 + Math.sin((k / 24) * Math.PI * 4) * 9);
      }
      ctx.stroke();
      ctx.restore();
    };
    draw(g, 'rgba(178,140,72,0.78)');
    const m = document.createElement('canvas');
    m.width = 256; m.height = 256;
    const mg = m.getContext('2d');
    mg.fillStyle = '#000'; mg.fillRect(0, 0, 256, 256);
    mg.scale(0.5, 0.5);
    draw(mg, '#fff');
    mask = new THREE.CanvasTexture(m);
    mask.colorSpace = THREE.SRGBColorSpace;
  }
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
    const plain = canvasTexture(false), emb = canvasTexture(true);
    const mat = (t) => new THREE.MeshStandardMaterial({
      map: t.tex, side: THREE.DoubleSide, roughness: 0.92, metalness: 0,
      emissiveMap: t.mask || null, emissive: new THREE.Color(t.mask ? 0xff9a3c : 0x000000), emissiveIntensity: 0,
    });
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
    };
    const area = ((h.w + f.w) / 2) * (h.y - f.y);
    const bundle = this._bundle(h.w * 0.92, pivot, new THREE.Vector3(0, h.y - 0.2, -h.fwd - 0.12));
    this.sails.push(new Sail({ name: s.name, mesh, corners, area, kind: 'square', level, bundle, bundleLen: h.w }));
  }

  _lateen(s) {
    const pivot = this.pivots[s.mast];
    const mesh = this._grid({ nx: 8, ny: 8 }, false);
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
    const mesh = this._grid({ nx: 8, ny: 7 }, false);
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
    for (const [name, p] of Object.entries(this.pivots)) p.rotation.y = this.brace * (name === 'mizzen' ? 0.6 : 1);

    // the wind on the sails themselves: 180 deg is square behind them (full),
    // 90 deg along them (shivering), less is on their fore side (aback)
    const rel = Math.abs(THREE.MathUtils.radToDeg(awa + this.brace));
    const press = Math.min(1.2, (aws / 8) ** 1.1);
    const fill = THREE.MathUtils.clamp((rel - 92) / 16, -0.6, 1.0) * press;
    const shiver = Math.max(0, 1 - Math.abs(rel - 92) / 10) * Math.min(1, aws / 5);

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
    const { head, hw, foot, fw } = s.corners;
    const P = s.pos.array;
    const nx = s.kind === 'sprit' ? 8 : NX, ny = s.kind === 'sprit' ? 7 : NY;
    const drop = head.y - foot.y;
    const depth = (s.kind === 'sprit' ? 0.13 : 0.16) * Math.abs(drop) * fill;
    const set = s.set;
    for (let j = 0; j < ny; j++) {
      const v = (j / (ny - 1)) * set;            // the canvas comes down from the yard as it is set
      for (let i = 0; i < nx; i++) {
        const u = i / (nx - 1);
        const k = 3 * (j * nx + i);
        const xh = (u - 0.5) * hw, xf = (u - 0.5) * fw;
        let x = xh + (xf - xh) * v;
        let y = head.y + (foot.y - head.y) * v;
        let z = head.z + (foot.z - head.z) * v;
        const belly = Math.sin(Math.PI * u) * Math.sin(Math.PI * (0.12 + 0.8 * (j / (ny - 1))));
        z -= depth * belly * set;                // forward (-z) when full
        y += Math.abs(depth) * 0.25 * belly * (j / (ny - 1)) * set;   // the foot lifts as it fills
        if (shiver > 0.01) z += Math.sin(time * 9 + u * 7 + j * 1.3) * 0.18 * shiver * belly;
        x *= 1 - 0.04 * belly * Math.abs(fill);
        P[k] = x; P[k + 1] = y; P[k + 2] = z;
      }
    }
    s.pos.needsUpdate = true;
    s.mesh.geometry.computeVertexNormals();
  }

  _shapeLateen(s, fill, shiver, time, awa) {
    const { tack, peak, clew } = s.corners;
    const P = s.pos.array;
    const n = 8;
    const e1 = peak.clone().sub(tack), e2 = clew.clone().sub(tack);
    const nrm = e1.clone().cross(e2).normalize();          // to starboard
    const side = -Math.sign(awa || 1);                     // bellies to leeward
    const depth = 0.08 * e1.length() * Math.min(1, Math.abs(fill) + 0.3) * side;
    const p = new THREE.Vector3();
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = i / (n - 1), b = (j / (n - 1)) * (1 - a) * s.set;   // collapse onto the yard when furled
        p.copy(tack).addScaledVector(e1, a).addScaledVector(e2, b);
        const belly = Math.sin(Math.PI * a) * Math.sin(Math.PI * Math.min(1, b / Math.max(0.05, 1 - a)));
        p.addScaledVector(nrm, depth * belly);
        if (shiver > 0.01) p.addScaledVector(nrm, Math.sin(time * 8 + a * 6 + j) * 0.15 * shiver * belly);
        const k = 3 * (j * n + i);
        P[k] = p.x; P[k + 1] = p.y; P[k + 2] = p.z;
      }
    }
    s.pos.needsUpdate = true;
    s.mesh.geometry.computeVertexNormals();
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
    const c = document.createElement('canvas');
    c.width = 256; c.height = 160;
    const g = c.getContext('2d');
    g.fillStyle = '#1c1a2a'; g.fillRect(0, 0, 256, 160);
    g.fillStyle = '#7a1a14'; g.fillRect(0, 0, 256, 22); g.fillRect(0, 138, 256, 22);
    g.translate(128, 80); g.fillStyle = '#c8a050'; g.strokeStyle = '#c8a050'; g.lineWidth = 6;
    g.beginPath(); g.arc(0, 0, 44, 0, Math.PI * 2); g.stroke();
    g.beginPath();
    for (let k = 0; k < 16; k++) {
      const a = -Math.PI / 2 + (Math.PI * 2 * k) / 16;
      const r = k % 4 === 0 ? 38 : k % 2 === 0 ? 24 : 10;
      g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    g.closePath(); g.fill();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.9 });
    const pmat = new THREE.MeshStandardMaterial({ color: 0x6e1812, side: THREE.DoubleSide, roughness: 0.9 });
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
