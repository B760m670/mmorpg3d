import * as THREE from 'three';
import { BOAT, TELEGRAPH } from '../config.js';

// Working bridge electronics, drawn live into canvas textures laid over the
// console screens of the model:
//   conning display · chart plotter · radar · echo sounder · engine monitor
// plus the VHF radios in the overhead console. They read the real game state:
// the radar paints the actual fjord walls (with radar shadow), the chart
// plotter shows the coastline and your track, the sounder the seabed under
// the keel. Only redrawn while you are on the bridge.

const W = 512, H = 328;           // console screen canvases (0.56 x 0.36 m)
const NM = 1852;
const DEG = Math.PI / 180;
const FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

// Console screen centres in model space (x, y up, z aft): see build_bridge()
// in blender/build_trawler.py (Blender (x, y, z) -> three (x, z, -y)).
const SCREEN_X = [-2.3, -1.15, 0.0, 1.15, 2.3];
const SCREEN_Y = 6.57, SCREEN_Z = -5.975;
const SCREEN_UP = [0, 0.912, -0.41];
const SCREEN_N = [0, 0.41, 0.912];
const RADIO_X = [-2.2, 0.0, 2.2];

// Fictional but plausible chart datum for the game world: a Norwegian fjord.
const LAT0 = 62.215, LON0 = 6.742;
const toLat = (z) => LAT0 - z / 111320;
const toLon = (x) => LON0 + x / (111320 * Math.cos(LAT0 * DEG));
function fmtLat(v) {
  const d = Math.floor(v), m = (v - d) * 60;
  return `${d}°${m.toFixed(3).padStart(6, '0')}'N`;
}
function fmtLon(v) {
  const d = Math.floor(v), m = (v - d) * 60;
  return `${String(d).padStart(3, '0')}°${m.toFixed(3).padStart(6, '0')}'E`;
}

function makeCanvas(w = W, h = H) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function makeTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function screenMesh(tex, w, h, center, up, normal, offset) {
  const mat = new THREE.MeshBasicMaterial({
    map: tex, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  const n = new THREE.Vector3(...normal).normalize();
  const u = new THREE.Vector3(...up).normalize();
  const r = new THREE.Vector3().crossVectors(u, n);
  m.matrix.makeBasis(r, u, n).setPosition(new THREE.Vector3(...center).addScaledVector(n, offset));
  m.matrixAutoUpdate = false;
  m.name = 'instrument';
  return m;
}

function text(ctx, s, x, y, size, color, align = 'left', weight = '') {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(s, x, y);
}

const compass = (boat) => boat.headingDeg;
const rotPerMin = (boat) => (-boat.yawRate / DEG) * 60;

// ------------------------------------------------------------------ radar
class Radar {
  constructor(sample) {
    this.sample = sample;
    this.canvas = makeCanvas();
    this.ctx = this.canvas.getContext('2d');
    this.ranges = [0.5, 0.75, 1.5, 3];  // NM, picked automatically
    this.rangeNM = 1.5;
    this.range = this.rangeNM * NM;
    this.nearest = Infinity;        // closest land seen this rotation (m)
    this.N = 128;                   // range cells
    this.A = 360;                   // 1 degree bearings
    this.echo = new Uint8Array(this.A * this.N);
    this.sweep = 0;                 // antenna bearing relative to the bow (deg)
    this.R = 150;
    this.cx = 160;
    this.cy = 164;
    const S = this.R * 2;
    this.img = this.ctx.createImageData(S, S);
    this.lut = new Int32Array(S * S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const dx = x + 0.5 - this.R, dy = y + 0.5 - this.R;
        const r = Math.hypot(dx, dy) / this.R;
        if (r >= 1) { this.lut[y * S + x] = -1; continue; }
        const a = ((Math.atan2(dx, -dy) / DEG) + 360) % 360;
        this.lut[y * S + x] = (Math.floor(a * 10) << 8) | Math.min(this.N - 1, Math.floor(r * this.N));
      }
    }
  }

  // One radial: land returns until the terrain drops into its own radar
  // shadow, sea clutter close in, the odd noise speckle.
  row(trueBrg, px, pz) {
    const dx = Math.sin(trueBrg * DEG), dz = -Math.cos(trueBrg * DEG);
    const cell = this.range / this.N;
    const ant = 9.5;
    let maxE = -1e9;
    let land = false;
    const base = trueBrg * this.N;
    for (let b = 0; b < this.N; b++) {
      const d = (b + 0.5) * cell;
      const h = this.sample(px + dx * d, pz + dz * d);
      let v = 0;
      if (h > 0.5) {
        const e = (h - ant) / d;
        if (!land && d < this.nearest) this.nearest = d;
        if (e > maxE) {
          v = land ? Math.min(255, 120 + (e - maxE) * d * 6) : 255;
          maxE = e;
        }
        land = true;
      } else if (d < 420 && Math.random() < 0.3 * (1 - d / 420)) {
        v = 50 + Math.random() * 80;
      } else if (Math.random() < 0.003) {
        v = 60;
      }
      this.echo[base + b] = v;
    }
  }

  advance(dt, boat) {
    const hdg = compass(boat);
    if (!this.primed) {                 // switched on: paint a full picture at once
      this.primed = true;
      for (let pass = 0; pass < 2; pass++) {
        for (let a = 0; a < 360; a++) this.row(a, boat.position.x, boat.position.z);
        this.rangeNM = this.ranges.find((r) => r * NM >= this.nearest * 4) ?? 3;
        this.range = this.rangeNM * NM;
        this.nearest = Infinity;
      }
    }
    const to = this.sweep + 144 * dt;   // 24 rpm antenna
    for (let a = Math.ceil(this.sweep); a <= to; a++) {
      this.row((((Math.round(a + hdg)) % 360) + 360) % 360, boat.position.x, boat.position.z);
    }
    if (to >= 360) {
      // Auto range, like a watchkeeper would: about four times the distance
      // to the nearest land, from the standard range scale.
      const want = this.ranges.find((r) => r * NM >= this.nearest * 4) ?? 3;
      if (want !== this.rangeNM) {
        this.rangeNM = want;
        this.range = want * NM;
        this.echo.fill(0);
      }
      this.nearest = Infinity;
    }
    this.sweep = to % 360;
  }

  draw(boat) {
    const { ctx, R, cx, cy, N } = this;
    const hdg = compass(boat);
    const d = this.img.data;
    const lut = this.lut, echo = this.echo, sweep = this.sweep;
    for (let i = 0, p = 0; i < lut.length; i++, p += 4) {
      const code = lut[i];
      if (code < 0) { d[p] = 8; d[p + 1] = 13; d[p + 2] = 18; d[p + 3] = 255; continue; }
      const rel = (code >> 8) * 0.1;
      const tb = ((rel + hdg) | 0) % 360;
      const v = echo[tb * N + (code & 255)];
      const behind = (sweep - rel + 360) % 360;
      let r = 2, g = 9, b = 18;
      if (behind < 30) { const t = 1 - behind / 30; g += 34 * t * t; b += 26 * t * t; }
      if (v > 0) {
        const f = (v / 255) * (0.5 + 0.5 * (1 - behind / 360));
        r = 70 + 185 * Math.min(1, f * 1.3);
        g = 25 + 215 * f * f;
        b = 8 + 20 * f;
      }
      d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = 255;
    }
    ctx.fillStyle = '#080d12';
    ctx.fillRect(0, 0, W, H);
    ctx.putImageData(this.img, cx - R, cy - R);

    // rings, bearing scale, heading line, sweep, north marker
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(110,190,210,0.45)';
    for (const k of [1 / 3, 2 / 3]) { ctx.beginPath(); ctx.arc(cx, cy, R * k, 0, Math.PI * 2); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(150,210,225,0.8)';
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    for (let a = 0; a < 360; a += 5) {
      const s = Math.sin(a * DEG), c = -Math.cos(a * DEG);
      const l = a % 30 === 0 ? 10 : a % 10 === 0 ? 6 : 3;
      ctx.beginPath(); ctx.moveTo(cx + s * R, cy + c * R); ctx.lineTo(cx + s * (R - l), cy + c * (R - l)); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(235,245,250,0.85)';
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - R); ctx.stroke();
    const sw = sweep * DEG;
    ctx.strokeStyle = 'rgba(140,255,200,0.65)';
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.sin(sw) * R, cy - Math.cos(sw) * R); ctx.stroke();
    const na = -hdg * DEG;
    const nx = cx + Math.sin(na) * (R + 9), ny = cy - Math.cos(na) * (R + 9);
    text(ctx, 'N', nx, ny + 5, 13, '#9fe3ff', 'center', 'bold');
    ctx.fillStyle = '#e8f6ff';
    ctx.fillRect(cx - 1, cy - 1, 2, 2);

    // data panel
    const x0 = 334;
    text(ctx, 'X-BAND  TX', x0, 30, 16, '#6fb6c8');
    text(ctx, 'H UP  RM', x0, 52, 16, '#6fb6c8');
    text(ctx, 'RANGE', x0, 88, 15, '#6fb6c8');
    text(ctx, `${this.rangeNM} NM`, x0, 112, 24, '#e8f6ff', 'left', 'bold');
    text(ctx, `RINGS ${+(this.rangeNM / 3).toFixed(2)}`, x0, 136, 15, '#6fb6c8');
    text(ctx, 'HDG', x0, 172, 15, '#6fb6c8');
    text(ctx, `${hdg.toFixed(1).padStart(5, '0')}°`, x0, 196, 24, '#e8f6ff', 'left', 'bold');
    text(ctx, 'SOG', x0, 228, 15, '#6fb6c8');
    text(ctx, `${boat.knots.toFixed(1)} kn`, x0, 252, 24, '#e8f6ff', 'left', 'bold');
    text(ctx, 'GAIN AUTO  SEA AUTO', x0, 290, 12, '#6fb6c8');
    text(ctx, 'ANT 24 rpm', x0, 308, 12, '#6fb6c8');
  }
}

// ------------------------------------------------------------------ chart plotter
class Chart {
  constructor(terrain) {
    this.canvas = makeCanvas();
    this.ctx = this.canvas.getContext('2d');
    this.track = [];
    this.trackTimer = 0;
    // Base chart, 10 m per pixel, painted once from the terrain grid.
    const g = terrain.grid;
    const px = 10;
    this.px = px;
    this.minX = g.minX;
    this.minZ = g.minZ;
    const w = Math.ceil((g.nx - 1) * g.spacing / px);
    const h = Math.ceil((g.nz - 1) * g.spacing / px);
    const base = makeCanvas(w, h);
    const bctx = base.getContext('2d');
    const img = bctx.createImageData(w, h);
    const depth = new Float32Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) depth[j * w + i] = terrain.sample(this.minX + i * px, this.minZ + j * px);
    }
    const col = (hh) => (hh > 0 ? [205, 184, 128] : hh > -5 ? [118, 184, 230] : hh > -15 ? [166, 208, 240]
      : hh > -30 ? [204, 228, 247] : [236, 245, 252]);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        const hh = depth[k];
        let c = col(hh);
        if (i > 0 && j > 0 && i < w - 1 && j < h - 1) {
          const nb = [depth[k - 1], depth[k + 1], depth[k - w], depth[k + w]];
          if (hh > 0 && nb.some((v) => v <= 0)) c = [92, 78, 50];               // coastline
          else if (hh <= 0 && nb.some((v) => (v > -10) !== (hh > -10)) && hh < 0) c = [120, 150, 175]; // 10 m contour
          else if (hh > 0) {
            const shade = Math.max(-1, Math.min(1, (depth[k - 1] - depth[k + 1] + depth[k - w] - depth[k + w]) * 0.02));
            c = [c[0] + shade * 16, c[1] + shade * 14, c[2] + shade * 10];  // faint relief
          }
        }
        img.data[k * 4] = c[0]; img.data[k * 4 + 1] = c[1]; img.data[k * 4 + 2] = c[2]; img.data[k * 4 + 3] = 255;
      }
    }
    bctx.putImageData(img, 0, 0);
    this.base = base;
  }

  advance(dt, boat) {
    this.trackTimer -= dt;
    if (this.trackTimer <= 0) {
      this.trackTimer = 3;
      this.track.push([boat.position.x, boat.position.z]);
      if (this.track.length > 600) this.track.shift();
    }
  }

  draw(boat) {
    const { ctx } = this;
    const ch = 284;
    const k = 0.32;                         // px per metre: ~1.6 km across
    const bx = boat.position.x, bz = boat.position.z;
    const X = (x) => W / 2 + (x - bx) * k;
    const Z = (z) => ch / 2 + (z - bz) * k;
    ctx.save();
    ctx.fillStyle = 'rgb(236,245,252)';
    ctx.fillRect(0, 0, W, ch);
    ctx.beginPath(); ctx.rect(0, 0, W, ch); ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.setTransform(k * this.px, 0, 0, k * this.px, X(this.minX), Z(this.minZ));
    ctx.drawImage(this.base, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // graticule: every minute of latitude, every two of longitude
    ctx.strokeStyle = 'rgba(70,90,110,0.35)';
    ctx.lineWidth = 1;
    ctx.font = `11px ${FONT}`;
    ctx.fillStyle = 'rgba(40,55,70,0.8)';
    const latStep = 1 / 60, lonStep = 2 / 60;
    const lat0 = Math.floor(toLat(bz + ch / 2 / k) / latStep) * latStep;
    for (let la = lat0; la < toLat(bz - ch / 2 / k) + latStep; la += latStep) {
      const y = Z((LAT0 - la) * 111320);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      ctx.fillText(fmtLat(la).replace('.000', ''), 4, y - 3);
    }
    const lon0 = Math.floor(toLon(bx - W / 2 / k) / lonStep) * lonStep;
    for (let lo = lon0; lo < toLon(bx + W / 2 / k) + lonStep; lo += lonStep) {
      const x = X((lo - LON0) * 111320 * Math.cos(LAT0 * DEG));
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ch); ctx.stroke();
    }

    // past track
    if (this.track.length > 1) {
      ctx.strokeStyle = '#d4581c';
      ctx.lineWidth = 2;
      ctx.beginPath();
      this.track.forEach(([x, z], i) => (i ? ctx.lineTo(X(x), Z(z)) : ctx.moveTo(X(x), Z(z))));
      ctx.lineTo(X(bx), Z(bz));
      ctx.stroke();
    }
    // own ship: hull outline to scale, heading line, 6-minute speed vector
    const h = compass(boat) * DEG;
    const fx = Math.sin(h), fz = -Math.cos(h);
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(X(bx), Z(bz), 7, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(X(bx), Z(bz), 3, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(X(bx), Z(bz)); ctx.lineTo(X(bx) + fx * 90, Z(bz) + fz * 90); ctx.stroke();
    const v6 = Math.max(0, boat.speed) * 360 * k;
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = '#1b6e2d';
    ctx.beginPath(); ctx.moveTo(X(bx), Z(bz)); ctx.lineTo(X(bx) + fx * v6, Z(bz) + fz * v6); ctx.stroke();
    ctx.setLineDash([]);
    // scale bar: 0.25 NM
    const sb = 0.25 * NM * k;
    ctx.strokeStyle = '#222'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(W - 14 - sb, ch - 14); ctx.lineTo(W - 14, ch - 14); ctx.stroke();
    text(ctx, '0.25 NM', W - 14 - sb / 2, ch - 20, 11, '#222', 'center');
    text(ctx, 'NORTH UP', W - 8, 16, 11, '#222', 'right', 'bold');
    ctx.restore();

    // info bar
    ctx.fillStyle = '#14202a';
    ctx.fillRect(0, ch, W, H - ch);
    text(ctx, `${fmtLat(toLat(bz))}  ${fmtLon(toLon(bx))}`, 10, ch + 18, 15, '#e8f6ff', 'left', 'bold');
    text(ctx, `COG ${String(Math.round(compass(boat)) % 360).padStart(3, '0')}°  SOG ${boat.knots.toFixed(1)} kn   GPS 3D  WGS84`, 10, ch + 38, 13, '#9fc8dc');
  }
}

// ------------------------------------------------------------------ echo sounder
class Sounder {
  constructor(sample) {
    this.sample = sample;
    this.canvas = makeCanvas();
    this.ctx = this.canvas.getContext('2d');
    this.PW = 400;
    this.plot = makeCanvas(this.PW, H);
    this.pctx = this.plot.getContext('2d');
    this.pctx.fillStyle = '#071233';
    this.pctx.fillRect(0, 0, this.PW, H);
    this.range = 50;
    this.timer = 0;
    this.depth = 40;
    this.fish = 0;
    this.fishY = 0.5;
  }

  advance(dt, boat) {
    if (!this.primed) {                 // fill the screen with history
      this.primed = true;
      this.depth = Math.max(1, -this.sample(boat.position.x, boat.position.z));
      for (let i = 0; i < this.PW / 2; i++) { this.timer = 0; this.advance(0, boat); }
      return;
    }
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.2;
    const d = Math.max(1, -this.sample(boat.position.x, boat.position.z));
    this.depth += (d - this.depth) * 0.6;
    const ranges = [10, 20, 30, 50, 80, 120, 200];
    const want = ranges.find((r) => r >= this.depth * 1.3) || 200;
    if (want !== this.range) {
      this.range = want;
      this.pctx.fillStyle = '#071233';
      this.pctx.fillRect(0, 0, this.PW, H);
    }
    // scroll one column (2 px) and paint the new return on the right
    const p = this.pctx, cw = 2, x = this.PW - cw;
    p.drawImage(this.plot, cw, 0, this.PW - cw, H, 0, 0, this.PW - cw, H);
    p.fillStyle = '#071233';
    p.fillRect(x, 0, cw, H);
    // plankton / noise speckles
    for (let i = 0; i < 3; i++) {
      if (Math.random() < 0.5) {
        p.fillStyle = 'rgba(60,110,200,0.7)';
        p.fillRect(x, Math.random() * H * 0.9, cw, 2);
      }
    }
    // occasional fish school in mid-water
    if (this.fish <= 0 && this.depth > 12 && Math.random() < 0.03) {
      this.fish = 6 + Math.random() * 18;
      this.fishY = 0.3 + Math.random() * 0.45;
    }
    const yb = (this.depth / this.range) * H;
    if (this.fish > 0) {
      this.fish -= 1;
      const fy = this.fishY * yb + (Math.random() - 0.5) * 6;
      p.fillStyle = 'rgba(235,60,30,0.95)';
      p.fillRect(x, fy, cw, 3);
      p.fillStyle = 'rgba(255,200,40,0.85)';
      p.fillRect(x, fy - 2, cw, 2);
      p.fillRect(x, fy + 3, cw, 2);
    }
    // seabed: hard red line, then orange, yellow, green, fading into brown
    const bands = [[0, 5, '#e3261b'], [5, 10, '#f07a16'], [10, 15, '#f2d23a'], [15, 22, '#3bb36a'], [22, 34, '#2a5fae']];
    for (const [a, b, c] of bands) { p.fillStyle = c; p.fillRect(x, yb + a, cw, b - a); }
    p.fillStyle = '#3a2618';
    p.fillRect(x, yb + 34, cw, H);
    // second (double) bottom echo
    if (yb * 2 < H) { p.fillStyle = 'rgba(200,60,40,0.45)'; p.fillRect(x, yb * 2, cw, 3); }
  }

  draw() {
    const { ctx } = this;
    ctx.drawImage(this.plot, 0, 0);
    ctx.strokeStyle = 'rgba(220,235,255,0.35)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
      const y = (i / 5) * H;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.PW, y); ctx.stroke();
      text(ctx, String((this.range * i) / 5), 4, y - 3, 12, 'rgba(230,240,255,0.85)');
    }
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(this.PW, 0, W - this.PW, H);
    const x0 = this.PW + 10;
    text(ctx, 'DEPTH', x0, 30, 15, '#8fb8e8');
    text(ctx, this.depth.toFixed(1), W - 10, 84, 42, '#ffffff', 'right', 'bold');
    text(ctx, 'm', W - 10, 106, 16, '#8fb8e8', 'right');
    text(ctx, 'RANGE', x0, 150, 13, '#8fb8e8');
    text(ctx, `0-${this.range} m`, x0, 172, 17, '#ffffff', 'left', 'bold');
    text(ctx, '50/200', x0, 214, 13, '#8fb8e8');
    text(ctx, 'kHz', x0, 232, 13, '#8fb8e8');
    text(ctx, 'TEMP', x0, 270, 13, '#8fb8e8');
    text(ctx, '7.8°C', x0, 292, 17, '#ffffff', 'left', 'bold');
  }
}

// ------------------------------------------------------------------ conning
function drawConning(ctx, boat) {
  ctx.fillStyle = '#0b1219';
  ctx.fillRect(0, 0, W, H);
  const hdg = compass(boat);
  // heading tape
  const tapeY = 18, tapeH = 54, pxPerDeg = 6;
  ctx.fillStyle = '#121d27';
  ctx.fillRect(0, tapeY, W, tapeH);
  ctx.strokeStyle = '#cfe6f2';
  ctx.lineWidth = 1.5;
  for (let a = Math.floor(hdg - 45); a <= hdg + 45; a++) {
    if (a % 5) continue;
    const x = W / 2 + (a - hdg) * pxPerDeg;
    const l = a % 10 === 0 ? 16 : 8;
    ctx.beginPath(); ctx.moveTo(x, tapeY + tapeH); ctx.lineTo(x, tapeY + tapeH - l); ctx.stroke();
    if (a % 10 === 0) {
      const v = ((a % 360) + 360) % 360;
      const lab = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[v] ?? String(v).padStart(3, '0');
      text(ctx, lab, x, tapeY + 24, 15, '#cfe6f2', 'center', 'bold');
    }
  }
  ctx.fillStyle = '#ffb02e';
  ctx.beginPath(); ctx.moveTo(W / 2, tapeY + tapeH - 14); ctx.lineTo(W / 2 - 8, tapeY + tapeH + 4); ctx.lineTo(W / 2 + 8, tapeY + tapeH + 4); ctx.fill();

  text(ctx, 'HEADING', W / 2, 106, 14, '#7fa9bf', 'center');
  text(ctx, `${hdg.toFixed(1).padStart(5, '0')}°`, W / 2, 150, 44, '#ffffff', 'center', 'bold');

  // rate of turn and rudder angle, port red to the left, starboard green
  const bar = (y, label, v, max, unit) => {
    const x0 = 40, x1 = W - 40, mid = (x0 + x1) / 2, half = (x1 - x0) / 2;
    text(ctx, label, x0, y - 10, 13, '#7fa9bf');
    text(ctx, `${Math.abs(v).toFixed(0)}${unit} ${Math.abs(v) < 0.5 ? '' : v > 0 ? 'STBD' : 'PORT'}`, x1, y - 10, 13, '#ffffff', 'right', 'bold');
    ctx.fillStyle = '#18242f';
    ctx.fillRect(x0, y, x1 - x0, 16);
    const w = (Math.max(-max, Math.min(max, v)) / max) * half;
    ctx.fillStyle = v < 0 ? '#d4473b' : '#33b35a';
    ctx.fillRect(Math.min(mid, mid + w), y, Math.abs(w), 16);
    ctx.fillStyle = '#cfe6f2';
    ctx.fillRect(mid - 1, y - 3, 2, 22);
  };
  bar(200, 'RATE OF TURN', rotPerMin(boat), 60, '°/min');
  bar(256, 'RUDDER', -boat.rudder, BOAT.rudderMax, '°');
  text(ctx, `SOG ${boat.knots.toFixed(1)} kn`, 40, 310, 16, '#ffffff', 'left', 'bold');
  text(ctx, 'AUTOPILOT OFF · HAND', W - 40, 310, 13, '#ffb02e', 'right');
}

// ------------------------------------------------------------------ engine
function drawEngine(ctx, boat) {
  ctx.fillStyle = '#0d1116';
  ctx.fillRect(0, 0, W, H);
  const n = Math.abs(boat.rpm);
  const shownRpm = n * BOAT.rpmMax;
  const load = Math.min(1, Math.pow(n, 2.6) + 0.04);
  // tachometer
  const cx = 150, cy = 170, R = 120, a0 = 135 * DEG, span = 270 * DEG, max = 1400;
  ctx.lineWidth = 10;
  ctx.strokeStyle = '#1e2a35';
  ctx.beginPath(); ctx.arc(cx, cy, R, a0, a0 + span); ctx.stroke();
  ctx.strokeStyle = '#c0392b';
  ctx.beginPath(); ctx.arc(cx, cy, R, a0 + span * (1250 / max), a0 + span); ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#d8e6ee';
  for (let v = 0; v <= max; v += 100) {
    const a = a0 + span * (v / max);
    const l = v % 200 === 0 ? 16 : 8;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (R - 6), cy + Math.sin(a) * (R - 6));
    ctx.lineTo(cx + Math.cos(a) * (R - 6 - l), cy + Math.sin(a) * (R - 6 - l));
    ctx.stroke();
    if (v % 200 === 0) text(ctx, String(v / 100), cx + Math.cos(a) * (R - 36), cy + Math.sin(a) * (R - 36) + 6, 15, '#d8e6ee', 'center');
  }
  const a = a0 + span * (shownRpm / max);
  ctx.strokeStyle = '#ffb02e';
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * (R - 20), cy + Math.sin(a) * (R - 20)); ctx.stroke();
  ctx.fillStyle = '#2b3946';
  ctx.beginPath(); ctx.arc(cx, cy, 12, 0, Math.PI * 2); ctx.fill();
  text(ctx, 'x100 rpm', cx, cy + 46, 13, '#7f97a8', 'center');
  text(ctx, String(Math.round(shownRpm)), cx, cy + 82, 30, '#ffffff', 'center', 'bold');

  const x0 = 300;
  const gear = boat.rpm > 0.02 ? 'AHEAD' : boat.rpm < -0.02 ? 'ASTERN' : 'NEUTRAL';
  const rows = [
    ['MAIN ENGINE', '1500 hp'],
    ['GEAR', gear],
    ['LOAD', `${Math.round(load * 100)} %`],
    ['FUEL', `${Math.round(10 + 270 * load)} L/h`],
    ['COOLANT', `${(76 + 9 * load).toFixed(0)} °C`],
    ['OIL PRESS', `${(1.6 + 2.8 * (shownRpm / BOAT.rpmMax)).toFixed(1)} bar`],
    ['EXHAUST', `${Math.round(170 + 290 * load)} °C`],
  ];
  rows.forEach(([k, v], i) => {
    const y = 34 + i * 40;
    text(ctx, k, x0, y, 13, '#7f97a8');
    text(ctx, v, x0, y + 20, 19, '#ffffff', 'left', 'bold');
  });
  text(ctx, TELEGRAPH[boat.telegraph].name, cx, 26, 15, '#ffb02e', 'center', 'bold');
}

// ------------------------------------------------------------------ VHF
function drawRadio(ch, sub) {
  const c = makeCanvas(256, 64);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#4e6a3a';
  ctx.fillRect(0, 0, 256, 64);
  const g = ctx.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, 'rgba(255,255,220,0.12)');
  g.addColorStop(1, 'rgba(0,0,0,0.15)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 64);
  text(ctx, ch, 150, 52, 50, '#12180e', 'right', 'bold');
  text(ctx, 'CH', 18, 26, 16, '#12180e', 'left', 'bold');
  text(ctx, sub, 18, 50, 14, '#12180e');
  text(ctx, '25W', 238, 26, 14, '#12180e', 'right', 'bold');
  text(ctx, 'DSC', 238, 50, 14, '#12180e', 'right');
  return makeTexture(c);
}

// ------------------------------------------------------------------ all of it
export class Instruments {
  constructor(terrain) {
    const sample = (x, z) => terrain.sample(x, z);
    this.radar = new Radar(sample);
    this.chart = new Chart(terrain);
    this.sounder = new Sounder(sample);
    this.conning = { canvas: makeCanvas() };
    this.conning.ctx = this.conning.canvas.getContext('2d');
    this.engine = { canvas: makeCanvas() };
    this.engine.ctx = this.engine.canvas.getContext('2d');
    this.order = [this.conning, this.chart, this.radar, this.sounder, this.engine];
    for (const s of this.order) s.texture = makeTexture(s.canvas);
    this.meshes = [];
    this.slow = 0;
    this.fast = 0;
    this.night = false;
  }

  attach(model) {
    this.order.forEach((s, i) => {
      const m = screenMesh(s.texture, 0.56, 0.36, [SCREEN_X[i], SCREEN_Y, SCREEN_Z], SCREEN_UP, SCREEN_N, 0.012);
      model.add(m);
      this.meshes.push(m);
    });
    const radios = [drawRadio('16', 'INT'), drawRadio('06', 'SHIP'), drawRadio('12', 'PORT')];
    RADIO_X.forEach((x, i) => {
      const m = screenMesh(radios[i], 0.5, 0.12, [x, 7.35, -6.115], [0, 1, 0], [0, 0, 1], 0.012);
      model.add(m);
      this.meshes.push(m);
    });
    this.setNight(this.night);
  }

  setNight(night) {
    this.night = night;
    this.meshes.forEach((m, i) => {
      const radio = i >= this.order.length;
      m.material.color.setScalar((night ? 0.42 : 0.9) * (radio ? 0.6 : 1));
    });
  }

  // active: someone is on the bridge to look at the screens.
  update(dt, boat, active) {
    this.chart.advance(dt, boat);          // keep the track even off the bridge
    if (!active || !this.meshes.length) return;
    this.radar.advance(dt, boat);
    this.sounder.advance(dt, boat);
    this.fast -= dt;
    this.slow -= dt;
    if (this.fast <= 0) {
      this.fast = 1 / 20;
      this.radar.draw(boat);
      this.radar.texture.needsUpdate = true;
    }
    if (this.slow <= 0) {
      this.slow = 1 / 5;
      this.chart.draw(boat);
      this.chart.texture.needsUpdate = true;
      this.sounder.draw();
      this.sounder.texture.needsUpdate = true;
      drawConning(this.conning.ctx, boat);
      this.conning.texture.needsUpdate = true;
      drawEngine(this.engine.ctx, boat);
      this.engine.texture.needsUpdate = true;
    }
  }
}
