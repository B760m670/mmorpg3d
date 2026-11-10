import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PRESETS } from './config.js';
import { resolve } from './world/Weather.js';
import { WEATHER } from './config.js';
import { Engine } from './core/Engine.js';
import { SkyDome } from './world/SkyDome.js';
import { Environment } from './world/Environment.js';
import { shipMaterial, metricUV } from './ship/Materials.js';

// A test bench for the ship's materials and parts, lit exactly as the game
// is: a piece of the side with a gun port and its lid, a wale, the deck, a
// beam overhead, and a gun on its carriage. Development only (bench.html).

const engine = new Engine(document.getElementById('app'), { maxPixelRatio: 2 });
const { scene, camera, renderer } = engine;
const sky = new SkyDome();
scene.add(sky.mesh);
const environment = new Environment(scene, { shadowMapSize: 2048 });
const p = resolve(PRESETS.day, { ...WEATHER.states[1] });
engine.applyPreset(p);
sky.applyPreset(p);
environment.applyPreset(p, sky.sunDirection);
scene.background = new THREE.Color().setRGB(...p.fog.color);
const pmrem = new THREE.PMREMGenerator(renderer);
const envScene = new THREE.Scene();
const envSky = new SkyDome();
envSky.mesh.scale.setScalar(500);
envScene.add(envSky.mesh);
envSky.applyPreset(p);
scene.environment = pmrem.fromScene(envScene, 0.02, 0.1, 2000).texture;
scene.environmentIntensity = p.envIntensity ?? 0.6;
environment.follow(new THREE.Vector3(0, 0, 0));
camera.near = 0.03;
camera.updateProjectionMatrix();

const M = {
  side: shipMaterial('hull_planks', renderer),
  ceiling: shipMaterial('in_planks', renderer),
  deck: shipMaterial('deck_planks', renderer),
  timber: shipMaterial('timber', renderer),
  red: shipMaterial('red_paint', renderer, { tint: [0.62, 0.45, 0.42] }),
  tar: shipMaterial('black_wood', renderer),
  iron: shipMaterial('iron', renderer),
  bronze: shipMaterial('bronze', renderer, { env: 1.0, tint: [1.0, 0.68, 0.42] }),
  rope: shipMaterial('rope', renderer, { tint: [0.5, 0.4, 0.3] }),     // tarred hemp
};

function add(geo, mat, pos, rot = null, parent = scene) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(...pos);
  if (rot) m.rotation.set(...rot);
  m.castShadow = m.receiveShadow = true;
  parent.add(m);
  return m;
}
// a timber with rounded arrises, grain along its longest side, UVs in metres
function timber(size, mat, pos, rot = null, r = 0.012, parent = scene) {
  const g = new RoundedBoxGeometry(size[0], size[1], size[2], 2, Math.min(r, Math.min(...size) / 2.2));
  const axis = ['x', 'y', 'z'][size.indexOf(Math.max(...size))];
  return add(metricUV(g, axis), mat, pos, rot, parent);
}

// ---- the side: outer planking and inner ceiling, 0.3 m of oak, a port
const L = 10, Hh = 3.2, T = 0.3;
const port = { x0: -0.42, x1: 0.42, y0: 0.6, y1: 1.32 };
for (const [mat, z, d] of [[M.side, -T / 2 - 0.03, 0.06], [M.ceiling, T / 2 - 0.03, 0.06]]) {
  const pieces = [
    [-L / 2, port.x0, -0.6, Hh], [port.x1, L / 2, -0.6, Hh],
    [port.x0, port.x1, -0.6, port.y0], [port.x0, port.x1, port.y1, Hh],
  ];
  for (const [x0, x1, y0, y1] of pieces) {
    const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, d);
    add(metricUV(g, 'x'), mat, [(x0 + x1) / 2, (y0 + y1) / 2, z]);
  }
}
// the frames between the two skins show in the port's sides
for (const x of [port.x0 - 0.07, port.x1 + 0.07]) timber([0.14, Hh + 0.6, T - 0.1], M.timber, [x, Hh / 2 - 0.3, 0], null, 0.01);
// port sill and lintel
timber([0.98, 0.12, T + 0.02], M.timber, [0, port.y0 - 0.06, 0]);
timber([0.98, 0.12, T + 0.02], M.timber, [0, port.y1 + 0.06, 0]);
// wales outside: heavy timbers, tarred
timber([L, 0.26, 0.2], M.tar, [0, 0.22, -T / 2 - 0.12], null, 0.04);
timber([L, 0.22, 0.18], M.tar, [0, 1.75, -T / 2 - 0.11], null, 0.04);
// the lid: oak outside, red inside, hung from the top, ajar
const lid = new THREE.Group();
lid.position.set(0, port.y1 + 0.02, -T / 2 - 0.06);
scene.add(lid);
const lo = new THREE.Mesh(metricUV(new RoundedBoxGeometry(0.88, 0.76, 0.07, 2, 0.01), 'y'), M.side);
lo.position.set(0, -0.38, -0.035); lo.castShadow = lo.receiveShadow = true; lid.add(lo);
const li = new THREE.Mesh(metricUV(new THREE.BoxGeometry(0.8, 0.68, 0.01), 'y'), M.red);
li.position.set(0, -0.38, 0.0); li.receiveShadow = true; lid.add(li);
for (const x of [-0.25, 0.25]) {             // hinge straps
  const s = new THREE.Mesh(new RoundedBoxGeometry(0.05, 0.72, 0.012, 1, 0.004), M.iron);
  s.position.set(x, -0.36, -0.075); s.castShadow = true; lid.add(s);
}
lid.rotation.x = 0.95;                        // swung up and out
// the deck and a beam over it, with a hanging knee
const deck = new THREE.BoxGeometry(L, 0.1, 6);
add(metricUV(deck, 'x'), M.deck, [0, -0.05, 3.15]);
timber([0.3, 0.3, 6], M.timber, [0, 2.15, 3.15], null, 0.02);
timber([0.3, 1.0, 0.18], M.timber, [0, 1.6, T / 2 + 0.1], null, 0.02);
timber([0.3, 0.18, 0.9], M.timber, [0, 2.05, T / 2 + 0.45], null, 0.02);

// ---- the gun: a bronze 24-pounder on a truck carriage, run out. Its own
// frame: x across, y up, muzzle toward -z (the port).
const gun = new THREE.Group();
gun.position.set(0, 0, 1.35);
scene.add(gun);
const prof = [ // [distance from the base ring along the bore (m), radius]
  [-0.28, 0.0], [-0.28, 0.035], [-0.24, 0.07], [-0.2, 0.06], [-0.17, 0.045], [-0.12, 0.09], [-0.06, 0.2], [0.0, 0.27],
  [0.06, 0.275], [0.06, 0.262], [0.9, 0.245], [0.9, 0.258], [0.97, 0.258], [0.97, 0.24], [1.6, 0.222], [1.6, 0.232],
  [1.66, 0.232], [1.66, 0.215], [2.42, 0.18], [2.42, 0.19], [2.47, 0.19], [2.5, 0.178], [2.66, 0.19], [2.76, 0.212],
  [2.8, 0.212], [2.8, 0.075], [2.6, 0.073],
];
const lathe = new THREE.LatheGeometry(prof.map(([x, r]) => new THREE.Vector2(r, x)), 48);
{ // u round the barrel (its circumference in metres), v along it
  const uv = lathe.attributes.uv, pos = lathe.attributes.position;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 1.6, pos.getY(i));
}
const barrel = new THREE.Mesh(lathe, M.bronze);
barrel.rotation.x = -Math.PI / 2;           // lathe axis +y -> -z
const TR = 1.2;                              // trunnions 1.2 m before the base ring
const trunnion = new THREE.Vector3(0, 0.86, -0.25);
barrel.position.set(0, trunnion.y, trunnion.z + TR);
barrel.castShadow = barrel.receiveShadow = true;
gun.add(barrel);
const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.74, 24), M.bronze);
tr.rotation.z = Math.PI / 2; tr.position.copy(trunnion); tr.castShadow = true; gun.add(tr);
// the cheeks: stepped at the rear for the handspikes, highest at the trunnions
const cheekShape = new THREE.Shape();
cheekShape.moveTo(0, 0); cheekShape.lineTo(1.55, 0); cheekShape.lineTo(1.55, 0.6); cheekShape.lineTo(1.2, 0.6);
cheekShape.absarc(1.05, 0.7, 0.075, 0, Math.PI, false);   // the trunnion's bed
cheekShape.lineTo(0.9, 0.62); cheekShape.lineTo(0.62, 0.6);
cheekShape.lineTo(0.62, 0.48); cheekShape.lineTo(0.36, 0.48); cheekShape.lineTo(0.36, 0.36);
cheekShape.lineTo(0.08, 0.36); cheekShape.lineTo(0.0, 0.25); cheekShape.lineTo(0, 0);
const zRear = trunnion.z + 1.05;
for (const sx of [-0.3, 0.3]) {
  const g = new THREE.ExtrudeGeometry(cheekShape, { depth: 0.12, bevelEnabled: true, bevelSize: 0.008, bevelThickness: 0.008, bevelSegments: 2, curveSegments: 10 });
  g.translate(0, 0, -0.06);
  const mesh = new THREE.Mesh(metricUV(g, 'x'), M.timber);
  mesh.rotation.y = Math.PI / 2;           // shape x -> -z
  mesh.position.set(sx, 0.16, zRear);
  mesh.castShadow = mesh.receiveShadow = true;
  gun.add(mesh);
  // the cap square over the trunnion, and bolts through the cheek
  const cap = new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.018, 8, 20, Math.PI), M.iron);
  cap.rotation.y = Math.PI / 2; cap.position.set(sx, trunnion.y, trunnion.z); cap.castShadow = true; gun.add(cap);
  for (const [dz, y] of [[0.1, 0.3], [0.55, 0.3], [1.0, 0.3], [1.35, 0.3], [1.3, 0.62]]) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.16, 12), M.iron);
    b.rotation.z = Math.PI / 2; b.position.set(sx, 0.16 + y, zRear - dz); gun.add(b);
  }
}
timber([0.48, 0.26, 0.12], M.timber, [0, 0.42, zRear - 1.5], null, 0.01, gun);     // transom
timber([0.48, 0.1, 0.9], M.timber, [0, 0.43, zRear - 0.55], null, 0.01, gun);      // the bed under the breech
timber([0.28, 0.09, 0.38], M.timber, [0, 0.52, zRear - 0.15], [0.1, 0, 0], 0.008, gun);   // quoin
for (const [z, r] of [[zRear - 1.35, 0.26], [zRear - 0.18, 0.22]]) {
  timber([1.02, 0.13, 0.15], M.timber, [0, r, z], null, 0.01, gun);                 // axletree
  for (const sx of [-0.45, 0.45]) {
    const g = new THREE.CylinderGeometry(r, r, 0.11, 40);
    const w = new THREE.Mesh(metricUV(g, 'y'), M.timber);
    w.rotation.z = Math.PI / 2; w.position.set(sx, r, z); w.castShadow = w.receiveShadow = true;
    gun.add(w);
    const lin = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.15, 14), M.iron);
    lin.rotation.z = Math.PI / 2; lin.position.set(sx, r, z); gun.add(lin);
  }
}
// the breeching: from a ring bolt either side of the port, round the
// cascabel, holding her when she recoils
const casc = new THREE.Vector3(0, trunnion.y, gun.position.z + trunnion.z + TR + 0.24);
const ropeCurve = new THREE.CatmullRomCurve3([
  new THREE.Vector3(-0.9, 0.78, T / 2 + 0.03), new THREE.Vector3(-0.5, 0.74, 1.4), new THREE.Vector3(-0.12, 0.84, casc.z - 0.02),
  new THREE.Vector3(0, 0.88, casc.z + 0.05), new THREE.Vector3(0.12, 0.84, casc.z - 0.02),
  new THREE.Vector3(0.5, 0.74, 1.4), new THREE.Vector3(0.9, 0.78, T / 2 + 0.03),
]);
const rope = new THREE.TubeGeometry(ropeCurve, 160, 0.032, 12, false);
{
  const uv = rope.attributes.uv;
  const len = ropeCurve.getLength();
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * len, uv.getY(i) * 0.25);
}
add(rope, M.rope, [0, 0, 0]);
for (const x of [-0.9, 0.9]) {
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.013, 10, 24), M.iron);
  ring.position.set(x, 0.78, T / 2 + 0.03); ring.castShadow = true; scene.add(ring);
}

// ---- views
const VIEWS = {
  outside: [[2.6, 1.3, -3.6], [0, 0.9, -0.2]],
  inside: [[2.3, 1.7, 3.6], [0, 0.7, 1.0]],
  gun: [[1.3, 1.35, 2.9], [0, 0.75, 1.3]],
  planks: [[0.9, 1.3, 0.95], [0.9, 1.2, 0.15]],
  deck: [[1.6, 1.5, 5.4], [0.6, 0.0, 3.6]],
  muzzle: [[1.3, 1.1, -1.6], [0, 0.86, -0.4]],
  lid: [[1.1, 1.2, -1.4], [0, 1.0, -0.3]],
};
const controls = new OrbitControls(camera, renderer.domElement);
function setView(name) {
  const v = VIEWS[name] || VIEWS.inside;
  camera.position.set(...v[0]);
  controls.target.set(...v[1]);
  controls.update();
}
setView(new URLSearchParams(location.search).get('view') || 'inside');
document.getElementById('loading')?.classList.add('hidden');
function tick() {
  controls.update();
  engine.render();
  requestAnimationFrame(tick);
}
tick();
window.__bench = { setView, scene, camera, engine, M, THREE, sky };
