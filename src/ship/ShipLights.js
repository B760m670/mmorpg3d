import * as THREE from 'three';

// The ship's lights, powered from the electrical plant.
//
// Navigation lights (COLREG / МППСС, 24 V LED lanterns, each with its own
// switch on the bridge panel): masthead light (white, 225 deg ahead),
// sidelights (red to port, green to starboard, dead ahead to 22.5 deg abaft
// the beam), stern light (white, 135 deg astern), the trawling lights (all-
// round green over white, rule 26), anchor light (all-round white) and
// not-under-command lights (two all-round red). Each is seen only inside its
// sector, as the screens and lantern lenses make it: walk or orbit round the
// ship at night and they change as a lookout on another vessel would see.
// Luminous ranges for a vessel of 12-50 m: masthead 5 miles, the rest 2.
//
// Deck floodlights: metal-halide 400 W lamps, aft working deck (4) and
// foredeck (2): they take a minute or so to warm up from a dim blue-green
// glow to full white, and once switched off hot they cannot strike again
// until they have cooled (a minute and a half). They light the deck and the
// water around the ship.
// Searchlight: 1 kW halogen on the wheelhouse roof, turned from the bridge;
// its beam shows in the night air and on the water.
// Inside: the fluorescent lighting on the 230 V circuit; on a blackout the
// 24 V emergency lights come on. In the wheelhouse a red night light or
// white working light (24 V).

// model space: x starboard, y up, z aft; sector in deg relative to the bow,
// clockwise (starboard +)
const NAV = [
  { id: 'masthead', name: 'Топовый (белый, 225°)', pos: [0, 12.15, -2.4], col: [1, 0.95, 0.85], sec: [-112.5, 112.5], nm: 5 },
  { id: 'side_s', name: 'Бортовой правый (зелёный)', pos: [3.66, 7.3, -5.775], col: [0.15, 1, 0.35], sec: [0, 112.5], nm: 2 },
  { id: 'side_p', name: 'Бортовой левый (красный)', pos: [-3.66, 7.3, -5.775], col: [1, 0.08, 0.05], sec: [-112.5, 0], nm: 2 },
  { id: 'stern', name: 'Кормовой (белый, 135°)', pos: [0, 8.55, 9.85], col: [1, 0.95, 0.85], sec: [112.5, 247.5], nm: 2 },
  { id: 'trawl_g', name: 'Траловый зелёный (круговой)', pos: [0, 12.85, -2.18], col: [0.15, 1, 0.35], sec: null, nm: 2 },
  { id: 'trawl_w', name: 'Траловый белый (круговой)', pos: [0, 10.85, -1.88], col: [1, 0.95, 0.85], sec: null, nm: 2 },
  { id: 'anchor', name: 'Якорный (белый, круговой)', pos: [0, 8.48, -6.35], col: [1, 0.95, 0.85], sec: null, nm: 2 },
  { id: 'nuc_u', name: 'НУС верхний (красный)', pos: [0, 11.85, -1.88], col: [1, 0.08, 0.05], sec: null, nm: 2 },
  { id: 'nuc_l', name: 'НУС нижний (красный)', pos: [0, 9.85, -1.88], col: [1, 0.08, 0.05], sec: null, nm: 2 },
];

export const NAV_PRESETS = {
  underway: { name: 'На ходу', rule: 'Правило 23: механическое судно на ходу — топовый, бортовые, кормовой', on: ['masthead', 'side_s', 'side_p', 'stern'] },
  trawling: { name: 'Трал', rule: 'Правило 26: судно, занятое тралением — зелёный над белым, на ходу бортовые и кормовой', on: ['trawl_g', 'trawl_w', 'side_s', 'side_p', 'stern'] },
  anchor: { name: 'Якорь', rule: 'Правило 30: судно на якоре (до 50 м) — круговой белый', on: ['anchor'] },
  nuc: { name: 'НУС', rule: 'Правило 27: судно, лишённое возможности управляться — два красных круговых, на ходу бортовые и кормовой', on: ['nuc_u', 'nuc_l', 'side_s', 'side_p', 'stern'] },
  off: { name: 'Выкл.', rule: 'Все ходовые огни выключены', on: [] },
};

// floodlights: lens position, facing (model space), group
const FLOODS = [
  { pos: [-3.0, 8.22, 0.1], dir: [0, -0.35, 1], g: 'aft' },
  { pos: [3.0, 8.22, 0.1], dir: [0, -0.35, 1], g: 'aft' },
  { pos: [-2.2, 8.6, 8.76], dir: [0, -0.35, -1], g: 'aft' },
  { pos: [2.2, 8.6, 8.76], dir: [0, -0.35, -1], g: 'aft' },
  { pos: [-0.7, 8.75, -4.29], dir: [0, -0.3, -1], g: 'fore' },
  { pos: [0.7, 8.75, -4.29], dir: [0, -0.3, -1], g: 'fore' },
];
const SEARCH_POS = [1.0, 8.52, -6.1];

const GLOW_VERT = /* glsl */ `
  uniform vec3 uCamL;       // camera in the ship's frame
  uniform float uPx, uDay;
  attribute vec3 aCol;
  attribute vec4 aSec;      // sector min, max (deg), has sector, range (m)
  attribute vec4 aDir;      // facing (floods), has direction
  attribute float aOn;
  varying vec3 vCol;
  varying float vA;
  void main() {
    vec3 d = uCamL - position;
    float dist = length(d);
    float vis = aOn;
    if (aSec.z > 0.5) {
      float b = degrees(atan(d.x, -d.z));             // relative bearing, clockwise from the bow
      if (aSec.y > 180.0 && b < 0.0) b += 360.0;      // the stern light's sector wraps through 180
      // practical cut-off 1-3 deg outside the sector (COLREG Annex I)
      vis *= smoothstep(aSec.x - 3.5, aSec.x - 0.5, b) * (1.0 - smoothstep(aSec.y + 0.5, aSec.y + 3.5, b));
    }
    if (aDir.w > 0.5) vis *= smoothstep(-0.1, 0.5, dot(normalize(d), normalize(aDir.xyz)));
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float r = aSec.w;
    float size = mix(2.0, 22.0, exp(-dist / max(r, 1.0))) * mix(1.0, 0.45, uDay);
    gl_PointSize = vis > 0.003 ? uPx * size : 0.0;
    vCol = aCol;
    vA = vis * mix(1.0, 0.35, uDay);
    gl_Position = projectionMatrix * mv;
  }`;
const GLOW_FRAG = /* glsl */ `
  varying vec3 vCol;
  varying float vA;
  void main() {
    vec2 q = gl_PointCoord - 0.5;
    float r2 = dot(q, q) * 4.0;
    float a = (exp(-r2 * 18.0) * 2.2 + exp(-r2 * 3.5) * 0.35) * vA;
    gl_FragColor = vec4(vCol * a * 3.0, a);
  }`;

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

export class ShipLights {
  constructor({ scene, elec, mobile = false }) {
    this.scene = scene;
    this.elec = elec;
    this.mobile = mobile;
    this.nav = {};
    for (const n of NAV) this.nav[n.id] = { ...n, on: NAV_PRESETS.underway.on.includes(n.id), lit: false };
    this.preset = 'underway';
    this.flood = { aft: { on: false, warm: 0, cool: 0, out: 0 }, fore: { on: false, warm: 0, cool: 0, out: 0 } };
    this.search = { on: false, az: 0, el: -4, out: 0 };
    this.wheelhouse = 'auto';           // auto | off | red | white
    this.dim = 0.7;
    this.inside = 'normal';             // normal | emergency | dark
    this.dcW = 0;
    this.model = null;
  }

  attach(model, { materials, torch }) {
    this.model = model;
    this.torch = torch;
    // the model's own lanterns are dark lenses now: these lights replace them
    for (const m of materials) {
      if (['light_red', 'light_green', 'light_white'].includes(m.name)) {
        m.emissive.setScalar(0.0);
        m.color.setRGB(0.18, 0.18, 0.17);
        m.toneMapped = true;
      }
      if (m.name === 'light_int_tube') { this.tube = m; this.tubeI = m.emissiveIntensity; }
      if (m.name.startsWith('light_int_led')) (this.leds = this.leds || []).push([m, m.emissiveIntensity]);
      if (m.name === 'light_int_tv') this.tv = [m, m.emissiveIntensity];
    }

    // lanterns: a small black housing and the lens
    const housingG = new THREE.CylinderGeometry(0.09, 0.09, 0.26, 10);
    const lensG = new THREE.SphereGeometry(0.075, 12, 8);
    const housingM = new THREE.MeshStandardMaterial({ color: 0x111316, roughness: 0.5 });
    for (const n of Object.values(this.nav)) {
      const h = new THREE.Mesh(housingG, housingM);
      h.position.set(n.pos[0], n.pos[1] - 0.04, n.pos[2]);
      model.add(h);
      n.lens = new THREE.Mesh(lensG, new THREE.MeshBasicMaterial({ color: 0x222222 }));
      n.lens.position.set(...n.pos);
      model.add(n.lens);
    }

    // glow sprites: all navigation lights, floods and the searchlight in one
    // draw, each masked to its own sector
    const items = [...Object.values(this.nav).map((n) => ({ pos: n.pos, col: n.col, sec: n.sec, range: n.nm * 900, dir: null })),
      ...FLOODS.map((f) => ({ pos: f.pos, col: [1, 0.96, 0.88], sec: null, range: 1500, dir: f.dir })),
      { pos: SEARCH_POS, col: [1, 0.93, 0.8], sec: null, range: 4000, dir: [0, 0, -1] }];
    this.nItems = items.length;
    const pos = new Float32Array(items.length * 3), col = new Float32Array(items.length * 3);
    const sec = new Float32Array(items.length * 4), dir = new Float32Array(items.length * 4), on = new Float32Array(items.length);
    items.forEach((it, i) => {
      pos.set(it.pos, i * 3);
      col.set(it.col, i * 3);
      sec.set([it.sec ? it.sec[0] : 0, it.sec ? it.sec[1] : 0, it.sec ? 1 : 0, it.range], i * 4);
      dir.set(it.dir ? [...it.dir, 1] : [0, 0, 0, 0], i * 4);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aCol', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSec', new THREE.BufferAttribute(sec, 4));
    g.setAttribute('aDir', new THREE.BufferAttribute(dir, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aOn', new THREE.BufferAttribute(on, 1).setUsage(THREE.DynamicDrawUsage));
    this.glowGeo = g;
    this.glow = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: { uCamL: { value: new THREE.Vector3() }, uPx: { value: 1 }, uDay: { value: 1 } },
      vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    }));
    this.glow.frustumCulled = false;
    this.glow.renderOrder = 5;
    model.add(this.glow);

    // floodlights that light the deck: one spot for each group
    const spot = (p, t) => {
      const s = new THREE.SpotLight(0xfff4e2, 0, 34, 0.95, 0.6, 1.4);
      s.position.set(...p);
      s.target.position.set(...t);
      model.add(s);
      model.add(s.target);
      return s;
    };
    this.spotAft = spot([0, 8.4, 0.3], [0, 3.6, 7.5]);
    // (on a phone one light less to shade every pixel with: the foredeck
    // floods then show as lamps and on the water only)
    // (from the front edge of the wheelhouse roof, so the cone stays clear
    // of the wheelhouse: these lights cast no shadows and would shine
    // through the roof)
    this.spotFore = this.mobile ? { intensity: 0, color: new THREE.Color() } : spot([0, 8.55, -6.75], [0, 4.0, -12.5]);
    if (!this.mobile) this.spotFore.angle = 0.8;

    // the searchlight's beam in the air
    const beamG = new THREE.CylinderGeometry(0.2, 12, 300, 20, 1, true);
    beamG.translate(0, -150, 0);
    beamG.rotateX(Math.PI / 2);               // along -Z (forward) from the lamp
    this.beamMat = new THREE.ShaderMaterial({
      uniforms: { uA: { value: 0 } },
      vertexShader: /* glsl */ `
        varying float vT; varying vec3 vN; varying vec3 vV;
        void main() {
          vT = -position.z / 300.0;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uA; varying float vT; varying vec3 vN; varying vec3 vV;
        void main() {
          float edge = pow(abs(dot(vN, vV)), 1.5);
          float a = uA * edge * pow(1.0 - vT, 1.4) * smoothstep(0.0, 0.01, vT);
          gl_FragColor = vec4(vec3(1.0, 0.94, 0.82), a);   // additive: colour x alpha
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    });
    this.beam = new THREE.Mesh(beamG, this.beamMat);
    this.beamPivot = new THREE.Object3D();
    this.beamPivot.position.set(...SEARCH_POS);
    this.beamPivot.add(this.beam);
    model.add(this.beamPivot);
    this.beam.frustumCulled = false;

    this.resize(window.innerHeight);
    window.addEventListener('resize', () => this.resize(window.innerHeight));
  }

  resize(h) {
    if (this.glow) this.glow.material.uniforms.uPx.value = (h / 800) * Math.min(window.devicePixelRatio, 2);
  }

  setPreset(id) {
    const p = NAV_PRESETS[id];
    if (!p) return;
    this.preset = id;
    for (const n of Object.values(this.nav)) n.on = p.on.includes(n.id);
  }

  toggleNav(id) {
    const n = this.nav[id];
    if (!n) return;
    n.on = !n.on;
    const match = Object.entries(NAV_PRESETS).find(([, p]) => Object.values(this.nav).every((q) => q.on === p.on.includes(q.id)));
    this.preset = match ? match[0] : 'custom';
  }

  toggleFlood(g) {
    const f = this.flood[g];
    f.on = !f.on;
  }

  aimSearch(daz, del) {
    this.search.az = ((this.search.az + daz + 540) % 360) - 180;
    this.search.el = Math.max(-25, Math.min(15, this.search.el + del));
  }

  // state: { dt, camera, night 0..1 darkness, onBridge, belowDecks }
  update(dt, { camera, dark, onBridge, belowDecks, lamp, swimming }) {
    if (!this.model) return;
    const E = this.elec;
    const dc = E.dcOk;
    let dcW = 0;

    // navigation lights
    const navs = Object.values(this.nav);
    const on = this.glowGeo.attributes.aOn.array;
    const failed = [];
    navs.forEach((n, i) => {
      n.lit = n.on && dc;
      if (n.on && !dc) failed.push(n.name);
      if (n.lit) dcW += 12;
      on[i] = n.lit ? 1 : 0;
      n.lens.material.color.setRGB(...(n.lit ? n.col.map((c) => c * 1.6) : [0.13, 0.13, 0.13]));
    });
    E.alarms.set('navlights', failed.length > 0, `Отказ ходовых огней: ${failed.length} шт. (нет питания 24 В)`, 'alarm');

    // floodlights: metal halide, warm-up and hot restrike
    const fedFloods = E.powered('floods');
    let floodKw = 0;
    for (const [g, f] of Object.entries(this.flood)) {
      const lamps = g === 'aft' ? 4 : 2;
      if (f.on && fedFloods && f.cool <= 0) {
        f.warm = Math.min(1, f.warm + dt / 70);
        floodKw += lamps * 0.43 * (1.2 - 0.2 * f.warm);
      } else {
        if (f.warm > 0.3) f.cool = 90;
        f.warm = Math.max(0, f.warm - dt / 20);
        f.cool = Math.max(0, f.cool - dt);
      }
      f.out = f.on && fedFloods && f.cool <= 0 ? 0.08 + 0.92 * Math.pow(f.warm, 1.6) : 0;
    }
    // warming metal halide is blue-green, then white
    const tint = (w) => [0.75 + 0.25 * w, 0.92 + 0.04 * w, 1.0 - 0.12 * w];
    const ta = tint(this.flood.aft.warm), tf = tint(this.flood.fore.warm);
    // (not below decks: no shadows, so they would shine through the deck)
    const outside = !belowDecks;
    this.spotAft.intensity = outside ? this.flood.aft.out * 260 : 0;
    this.spotAft.color.setRGB(...ta);
    this.spotFore.intensity = outside ? this.flood.fore.out * 200 : 0;
    this.spotFore.color.setRGB(...tf);
    const nNav = navs.length;
    const colA = this.glowGeo.attributes.aCol.array;
    FLOODS.forEach((fl, k) => {
      const st = this.flood[fl.g];
      on[nNav + k] = st.out;
      colA.set(fl.g === 'aft' ? ta : tf, (nNav + k) * 3);
    });
    E.ext.floods = floodKw;

    // searchlight
    const s = this.search;
    s.out = s.on && E.powered('search') ? 1 : 0;
    E.ext.search = s.out ? 1.0 : 0;
    const az = (s.az * Math.PI) / 180, el = (s.el * Math.PI) / 180;
    this.beamPivot.rotation.set(el, -az, 0, 'YXZ');
    const dir = _v.set(-Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    const dirA = this.glowGeo.attributes.aDir.array;
    dirA.set([dir.x, dir.y, dir.z, 1], (this.nItems - 1) * 4);
    on[this.nItems - 1] = s.out;
    this.beamMat.uniforms.uA.value = s.out * 0.22 * Math.max(0.05, dark);
    this.beam.visible = s.out > 0 && dark > 0.15;
    if (this.torch && !swimming) {
      const t = this.torch;
      t.intensity = s.out * 9000;
      t.angle = 0.07; t.penumbra = 0.4; t.distance = 900; t.decay = 1.6;
      this.model.localToWorld(t.position.set(...SEARCH_POS));
      this.model.localToWorld(t.target.position.set(SEARCH_POS[0] + dir.x * 50, SEARCH_POS[1] + dir.y * 50, SEARCH_POS[2] + dir.z * 50));
    }

    this.glowGeo.attributes.aOn.needsUpdate = true;
    this.glowGeo.attributes.aCol.needsUpdate = true;
    this.glowGeo.attributes.aDir.needsUpdate = true;
    this.glow.material.uniforms.uCamL.value.copy(this.model.worldToLocal(_w.copy(camera.position)));
    this.glow.material.uniforms.uDay.value = 1 - dark;

    // inside: 230 V lighting, or the 24 V emergency lights
    this.inside = E.powered('light') ? 'normal' : dc ? 'emergency' : 'dark';
    if (this.tube) {
      this.tube.emissiveIntensity = this.tubeI * (this.inside === 'normal' ? 1 : this.inside === 'emergency' ? 0.1 : 0);
    }
    if (this.inside === 'emergency') dcW += 90;
    if (this.leds) for (const [m, i0] of this.leds) m.emissiveIntensity = dc ? i0 : 0;
    if (this.tv) this.tv[0].emissiveIntensity = E.powered('light') ? this.tv[1] : 0;

    // the one moving point light: the room you are in
    let wh = this.wheelhouse === 'auto' ? (dark > 0.5 ? 'red' : 'off') : this.wheelhouse;
    if (!dc) wh = 'off';
    this.whMode = wh;
    if (wh !== 'off') dcW += 30;
    if (lamp) {
      if (belowDecks) {
        lamp.color.setRGB(...(this.inside === 'normal' ? [1, 0.95, 0.86] : [0.8, 0.9, 1]));
        lamp.intensity = this.inside === 'normal' ? 1.3 : this.inside === 'emergency' ? 0.22 : 0;
        lamp.distance = 9;
        lamp.position.copy(camera.position);
      } else if (onBridge && wh !== 'off') {
        this.model.localToWorld(lamp.position.set(0, 6.7, -3.2));
        lamp.color.setRGB(...(wh === 'red' ? [1, 0.1, 0.04] : [1, 0.95, 0.88]));
        lamp.intensity = (wh === "red" ? 0.3 : 0.7) * this.dim;
        lamp.distance = 7;
      } else lamp.intensity = 0;
    }
    this.dcW = dcW;
  }

  // light pools on the water for the ocean shader: [x, z, radius, strength]
  pools(boatModel, tide) {
    const out = [];
    if (!this.model) return out;
    const add = (lx, lz, r, k, col) => {
      this.model.localToWorld(_w.set(lx, 0, lz));
      out.push([_w.x, _w.z, r, k, col]);
    };
    if (this.flood.aft.out > 0) add(0, 9, 15, this.flood.aft.out, [1, 0.95, 0.85]);
    if (this.flood.fore.out > 0) add(0, -14, 11, this.flood.fore.out * 0.8, [1, 0.95, 0.85]);
    if (this.search.out > 0 && this.search.el < -0.5) {
      const el = (-this.search.el * Math.PI) / 180, az = (this.search.az * Math.PI) / 180;
      const h = SEARCH_POS[1] + 0.35 - tide;
      const d = Math.min(800, h / Math.tan(el));
      add(SEARCH_POS[0] - Math.sin(az) * d, SEARCH_POS[2] - Math.cos(az) * d, Math.max(3, d * 0.07), Math.min(2.5, 60 / Math.max(10, d)), [1, 0.93, 0.8]);
    }
    return out;
  }
}

export { NAV, FLOODS };
