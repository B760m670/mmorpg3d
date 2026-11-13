import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { PRESETS, SEA, SHIP } from './config.js';
import { Wetness } from './ship/Wetness.js';
import { Weather, resolve } from './world/Weather.js';
import { CloudLayer } from './world/CloudLayer.js';
import { NightSky } from './world/NightSky.js';
import { Waterfalls } from './world/Waterfalls.js';
import { Rain } from './world/Rain.js';
import { Spray } from './world/Spray.js';
import { SoundScape } from './systems/Sound.js';
import { Engine } from './core/Engine.js';
import { SkyDome } from './world/SkyDome.js';
import { Ocean } from './world/Ocean.js';
import { Environment } from './world/Environment.js';
import { Terrain, heightAt } from './world/Terrain.js';
import { tideLevel } from './world/Tide.js';
import { Player } from './entities/Player.js';
import { Input } from './systems/Input.js';
import { FollowCamera } from './systems/FollowCamera.js';
import { TouchControls } from './systems/TouchControls.js';
import villageUrl from './assets/village.glb?url';
import { Village } from './world/Village.js';
import { Underwater, WATER } from './world/Underwater.js';
import { SeaLife } from './world/SeaLife.js';
import { Diver } from './entities/Diver.js';
import { DiveComputer } from './ui/DiveComputer.js';
import { Galleon, GALLEON } from './entities/Galleon.js';
import { Aboard } from './ship/Aboard.js';
// the model and the materials are files next to the page, not inlined in it
const galleonUrl = `${import.meta.env.BASE_URL}models/galleon.glb.b64.txt`;      // gzipped glb, as base64 text

const container = document.getElementById('app');
const loading = document.getElementById('loading');
const hint = document.getElementById('hud');

const IS_TOUCH =
  (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
  'ontouchstart' in window ||
  navigator.maxTouchPoints > 0;

const engine = new Engine(container, { maxPixelRatio: IS_TOUCH ? 1.5 : 2 });
const { scene, camera, renderer } = engine;

// ---------------------------------------------------------------- the world
const sky = new SkyDome();
scene.add(sky.mesh);
const terrain = new Terrain({ mobile: IS_TOUCH });
scene.add(terrain.mesh);
const ocean = new Ocean({ renderer, terrain, mobile: IS_TOUCH });
// the land as the map has it: no houses, only the stones on it
const village = new Village({ mobile: IS_TOUCH });
village.buildings = false;
village.load(villageUrl);
scene.add(village.group);
scene.add(ocean.mesh);
// under water: light, particles, the dive light; life on the bottom
const underwater = new Underwater({ scene, engine, mobile: IS_TOUCH });
const seaLife = new SeaLife({ mobile: IS_TOUCH, swellDir: SEA.swellDir });
scene.add(seaLife.group);
const weather = new Weather();
ocean.setState(weather.state.sea, true);
const falls = new Waterfalls(terrain);
scene.add(falls.group);
falls.resize(window.innerHeight);
window.addEventListener('resize', () => falls.resize(window.innerHeight));
// The lantern you carry below decks (always in the scene, switched by its
// intensity: adding or removing a light would recompile every material).
const lamp = new THREE.PointLight(0xffc27a, 0, 10, 1.6);
scene.add(lamp);
const nightSky = new NightSky();
scene.add(nightSky.mesh);
const clouds = new CloudLayer();
scene.add(clouds.mesh);
const rain = new Rain({ count: IS_TOUCH ? 3000 : 7000 });
scene.add(rain.mesh);
const spray = new Spray({ count: IS_TOUCH ? 600 : 1000 });
scene.add(spray.mesh);
spray.resize(window.innerHeight);
window.addEventListener('resize', () => spray.resize(window.innerHeight));

// Sound starts with the first tap or key press (browser autoplay rules).
const sound = new SoundScape({ terrain, mobile: IS_TOUCH });
sound.falls = falls.spots;
const startSound = () => sound.start();
for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, startSound, { passive: true });
const environment = new Environment(scene, { shadowMapSize: IS_TOUCH ? 1024 : 2048 });

// ---------------------------------------------------------------- the ship
const ship = new Galleon();
ship.water = (x, z, t) => ocean.sampleWater(x, z, t);
ship.position.set(SHIP.spawn.x, 0, SHIP.spawn.z);
ship.heading = THREE.MathUtils.degToRad(SHIP.spawn.heading);
ship.renderer = renderer;            // for the materials (anisotropic filtering)
const wet = new Wetness(renderer, ship.rig);
if (!/[?&]nowet/.test(location.search)) ship.wet = wet;     // her materials get wet (rain, sea, bilge)
ship.load(galleonUrl);
scene.add(ship.object);
scene.add(ship.worldGroup);           // the anchor on the bottom and its cable
ship.seabed = (x, z) => heightAt(x, z);
ocean.uniforms.uBoatHalf.value.set(...GALLEON.halfHull);
if (ship.rig.hull) ocean.setHull(ship.rig.hull);      // the sea is kept out of her by her own form
const access = ship.rig.access;
const aboard = new Aboard(access);

const shipHud = document.createElement('div');
shipHud.style.cssText = 'position:fixed;left:calc(12px + env(safe-area-inset-left,0px));top:calc(10px + env(safe-area-inset-top,0px));padding:8px 12px;border-radius:10px;background:rgba(14,12,10,.55);color:#efe6d6;font:13px/1.45 Georgia,serif;pointer-events:none;z-index:15;display:none';
document.body.appendChild(shipHud);
const placeEl = document.createElement('div');
placeEl.id = 'place-hint';
placeEl.style.cssText = 'position:fixed;left:50%;bottom:64px;transform:translateX(-50%);max-width:min(92vw,640px);padding:7px 12px;border-radius:10px;background:rgba(10,16,22,.62);color:#e8eef2;font:13px/1.35 system-ui,sans-serif;text-align:center;pointer-events:none;display:none;z-index:20';
if (IS_TOUCH) { placeEl.style.bottom = 'auto'; placeEl.style.top = 'calc(54px + env(safe-area-inset-top, 0px))'; }   // clear of the stick
document.body.appendChild(placeEl);
let placeT = 0, placeKey = '', hudT = 0;
let orderText = '', orderT = 0;      // the last order given (sweeps, anchor), shown a moment
const _wind = { x: 0, z: 0 };

const input = new Input();
const player = new Player(camera);
player.set({ helm: access.helm.at, bounds: access.bounds });
player.place(access.spawn, 0);
let beenAboard = false;            // the player keeps their place aboard between visits
const diver = new Diver(camera);
const diveHud = new DiveComputer();
let torchUser = null;          // null: automatic (deep or dark), else on/off as chosen
let wasUnder = false;
const follow = new FollowCamera(camera);
follow.groundAt = (x, z) => Math.max(0, heightAt(x, z));
follow.waterAt = (x, z, t) => ocean.sampleWater(x, z, t).height;

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.maxPolarAngle = Math.PI * 0.495;
orbit.enabled = false;

const touch = IS_TOUCH ? new TouchControls(input) : null;
if (IS_TOUCH) document.body.classList.add('touch');

// ---------------------------------------------------------------- modes
//   3p    the view from outside; you have the conn
//   walk  first person, anywhere aboard: decks, cabins, hold, the tops
//   helm  at the wheel, first person; you have the conn
//   swim  in the water: a diver with a cylinder, over the side
let mode = '3p';
let lastAction = null;
let stickStepT = 0;
let tideCheck = -1;

const HINTS = IS_TOUCH ? {
  '3p': 'джойстик: ←→ руль, ↑↓ поставить / убрать паруса · палец по экрану — облёт, щипок — ближе/дальше · «на борт» — пройтись по кораблю · ☰ — вёсла, якорь',
  helm: 'джойстик: ←→ штурвал (руль; на вёслах — табанить бортом), ↑↓ паруса · палец — осмотреться · ☰ — вёсла, якорь',
  walk: 'джойстик — идти, по трапам между палубами — тоже · палец — осмотреться · у штурвала и у вант — кнопка вверху',
  swim: 'джойстик — плыть туда, куда смотрите · ▲ ▼ — вверх / вниз · палец — осмотреться · «фонарь» · у борта — «на борт»',
} : {
  '3p': '<b>A/D</b> руль · <b>W/S</b> поставить / убрать паруса · <b>R</b> вёсла · <b>G</b> якорь · мышь — облёт, колесо — ближе/дальше · <b>F</b> на борт · <b>N</b> день/ночь · <b>B</b> погода · <b>M</b> звук · <b>J</b> за борт · <b>C</b> свободная камера',
  helm: '<b>A/D</b> штурвал (руль; на вёслах — табанить бортом) · <b>W/S</b> паруса · <b>R</b> вёсла · <b>G</b> отдать / выбрать якорь · <b>E</b> отойти · <b>F</b> вид со стороны · клик — осмотреться',
  walk: '<b>WASD</b> идти (по трапам между палубами — тоже) · <b>Shift</b> бегом · <b>E</b> у штурвала — взять руль, у вант — лезть на марс · <b>J</b> за борт · <b>F</b> вид со стороны · клик — осмотреться',
  swim: '<b>WASD</b> плыть туда, куда смотрите · <b>Space</b> вверх · <b>C</b> вниз · <b>Shift</b> быстрее · <b>L</b> фонарь · <b>E</b> на борт (у борта) · клик — осмотреться',
};
const WEATHER_RU = { clear: 'ясно', fair: 'переменная облачность', 'overcast, showers': 'пасмурно, ливни', storm: 'шторм' };
const weatherRu = () => `${WEATHER_RU[weather.state.name] || weather.state.name}${weather.auto ? ' · меняется сама' : ''}`;

// The hint shows for a few seconds after each change of mode, then fades.
let hintTimer = null;
function showHint(html) {
  if (!hint) return;
  hint.innerHTML = html;
  hint.style.transition = 'opacity 0.8s ease';
  hint.style.opacity = '1';
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { hint.style.opacity = '0'; }, IS_TOUCH ? 7000 : 12000);
}

function setMode(m) {
  if ((m === 'walk' || m === 'helm') && !ship.collider) m = '3p';   // the model is still loading
  if (m === 'walk' && mode === '3p' && !beenAboard) player.place(access.spawn, 0);
  if (m === 'walk' || m === 'helm') beenAboard = true;
  mode = m;
  document.body.classList.toggle('diving', m === 'swim');
  if (m === 'helm') player.takeHelm();
  if (m === 'swim') { follow.enabled = false; orbit.enabled = false; }
  if (m === '3p') {
    follow.enabled = true;
    orbit.enabled = false;
    if (document.pointerLockElement) document.exitPointerLock();
  }
  input.dragging = m === '3p';
  showHint(HINTS[mode]);
  lastAction = null;
}
setMode('3p');

renderer.domElement.addEventListener('click', () => {
  if (mode !== '3p' && !IS_TOUCH && !document.pointerLockElement) renderer.domElement.requestPointerLock?.();
});

// ---------------------------------------------------------------- presets + lighting
const order = ['day', 'night'];
let presetIndex = 0;
const pmrem = new THREE.PMREMGenerator(renderer);
const envScene = new THREE.Scene();
const envSky = new SkyDome();
envSky.mesh.scale.setScalar(500);
envScene.add(envSky.mesh);
let envTarget = null;

let sceneExposure = 0.55;
let sunBase = 2.4, ambientBase = 1, envBase = 0.6;
let insideK = 0;               // 0 in the open .. 1 deep below decks (eased)
let lightK = -1;               // the inside level the lights were last set for
function applyPreset(name) {
  if (name && order.includes(name)) presetIndex = order.indexOf(name);
  const p = resolve(PRESETS[order[presetIndex]], weather.v);
  sceneExposure = p.exposure;
  engine.applyPreset(p);
  sky.applyPreset(p);
  ocean.applyPreset(p);
  environment.applyPreset(p, sky.sunDirection);
  sunBase = environment.sun.intensity;
  ambientBase = environment.ambient.intensity;
  lightK = -1;       // re-apply the below-decks dimming
  sky.mesh.visible = p.showSkyDome !== false;
  scene.background = new THREE.Color().setRGB(...p.fog.color);
  envSky.applyPreset(p);
  if (envTarget) envTarget.dispose();
  envTarget = pmrem.fromScene(envScene, 0.02, 0.1, 2000);
  scene.environment = envTarget.texture;
  envBase = p.envIntensity ?? 0.6;
  scene.environmentIntensity = envBase;
  clouds.applyPreset(p, sky.sunDirection);
  nightSky.applyPreset(p, sky.sunDirection, weather.v.clouds);
  rain.applyPreset(p);
  spray.applyPreset(p);
  falls.applyPreset(p);
}
applyPreset(order[presetIndex]);
follow.snap(ship);

// ---------------------------------------------------------------- weather
// A front changes the light a few times a second while it passes (the
// environment map is re-rendered each time); lightning flashes in a storm.
let lastWeatherApply = 0;
let flash = 0;
let flashTimer = 8;
let flashSeq = [];
function updateWeather(dt) {
  if (weather.state.sea !== ocean.state) ocean.setState(weather.state.sea);
  const changed = weather.update(dt);
  lastWeatherApply += dt;
  if (changed && (lastWeatherApply > 0.33 || !weather.changing)) {
    lastWeatherApply = 0;
    applyPreset();
  }
  // lightning: a stroke is two or three quick flashes
  flash *= Math.exp(-dt * 9);
  if (weather.v.lightning > 0.5) {
    flashTimer -= dt;
    if (flashTimer <= 0) {
      flashTimer = 6 + Math.random() * 20;
      sound.thunder(0.6 + Math.random() * 0.4, camera.position);
      flashSeq = [0, 0.12, 0.3].slice(0, 2 + (Math.random() < 0.5 ? 1 : 0)).map((t) => t + Math.random() * 0.05);
    }
  }
  flashSeq = flashSeq.filter((t) => {
    if (t <= 0) { flash = Math.max(flash, 0.7 + Math.random() * 0.5); return false; }
    return true;
  }).map((t) => t - dt);
  // below decks the eye opens up to the lantern light
  engine.renderer.toneMappingExposure = sceneExposure * (1 + flash * 1.4) * (1 + 0.9 * insideK);
}

// ---------------------------------------------------------------- over the side and back
const _dv = new THREE.Vector3();
const _dir = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);
diver.onBreath = (out) => {
  sound.breath(out, diver.depth);
  if (out && wasUnder) underwater.exhale(camera);
};
// From the deck: off the side you stand nearest, facing the way you look;
// from outside: off the starboard quarter.
function overTheSide() {
  if (!ship.model) return;
  const walking = mode === 'walk';
  const side = walking ? (Math.sign(player.pos.x) || 1) : 1;
  const z = walking ? THREE.MathUtils.clamp(player.pos.z, -18, 20) : 12;
  _dv.set(side * 10.5, 0, z);
  ship.model.localToWorld(_dv);
  _dv.y = ocean.sampleWater(_dv.x, _dv.z, clock.elapsedTime).height + 0.1;
  camera.getWorldDirection(_dir);
  const yaw = walking ? Math.atan2(-_dir.x, -_dir.z) : ship.heading - side * Math.PI / 2;
  diver.enter(_dv, yaw);
  torchUser = null;
  sound.splash();
  setMode('swim');
  if (touch) touch.toast(Math.abs(ship.speed) > 0.8 ? 'За бортом. Корабль на ходу — он уйдёт без вас!' : 'За бортом. Вода 7 °C, сухой гидрокостюм, баллон 12 л на 200 бар.', 4);
}
// Up her side by the battens amidships, onto the upper deck in the waist.
function climbAboard() {
  if (!diver.nearShip(ship.model, 27, 10.5) || !ship.collider) {
    if (touch) touch.toast('Подплывите к борту корабля', 2);
    return;
  }
  _dv.copy(diver.pos);
  ship.model.worldToLocal(_dv);
  const side = Math.sign(_dv.x) || 1;
  const origin = new THREE.Vector3(side * 3.2, 9, THREE.MathUtils.clamp(_dv.z, -13, -1));
  const hit = player._cast(origin, DOWN, 12, ship.collider);
  player.place([origin.x, hit ? hit.point.y : 3.5, origin.z], side > 0 ? Math.PI / 2 : -Math.PI / 2);   // facing inboard
  diver.air = 200;                                       // a fresh cylinder
  beenAboard = true;
  setMode('walk');
}

// What E would do where you stand, in words (for the touch button).
function actionHere() {
  if (mode === 'swim') return diver.nearShip(ship.model, 27, 10.5) ? 'на борт' : false;
  if (mode === 'helm') return 'отойти';
  if (mode !== 'walk' || player.climb) return false;
  if (player.nearHelm) return 'к штурвалу';
  const l = aboard.nearLadder(player.pos);
  if (l) return l.fromTop ? 'вниз по вантам' : 'на марс';
  return false;
}

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
let started = false;
let below = false, covered = false, coverT = 0;
const _lampPos = new THREE.Vector3();
const _stern = new THREE.Vector3();

function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;
  input.update();

  if (input.pressed('n')) {
    presetIndex = (presetIndex + 1) % order.length;
    applyPreset();
  }
  if (input.pressed('b')) {
    weather.cycle();
    if (touch) touch.toast(`Погода: <b>${weatherRu()}</b><br>волнение ${SEA.states[weather.state.sea].bft} балла`, 3);
  }
  if (input.pressed('m')) {
    const muted = sound.toggle();
    if (touch) touch.setSound(muted);
  }
  updateWeather(dt);
  if (input.pressed('f') && mode !== 'swim') setMode(mode === '3p' ? 'walk' : '3p');
  if (input.pressed('e')) {
    if (mode === 'helm') setMode('walk');
    else if (mode === 'walk' && !player.climb) {
      const l = aboard.nearLadder(player.pos);
      if (player.nearHelm) setMode('helm');
      else if (l) player.startClimb(l.ladder, l.fromTop);
    } else if (mode === 'swim') climbAboard();
  }
  if (input.pressed('j') && (mode === '3p' || mode === 'walk') && ship.model) overTheSide();
  // the sweeps and the anchor: orders from anywhere aboard or from outside
  if (mode !== 'swim' && ship.model) {
    let said = '';
    if (input.pressed('r')) said = ship.toggleSweeps();
    if (input.pressed('g')) said = ship.anchorOrder(ocean.tide);
    if (said) { orderText = said; orderT = 4; if (touch) touch.toast(said, 3); }
  }
  if (input.pressed('l') && mode === 'swim') {
    torchUser = !underwater.torchOn;
    if (touch) touch.toast(torchUser ? 'Фонарь включён' : 'Фонарь выключен', 1.5);
  }
  if (input.pressed('c') && mode === '3p') {
    follow.enabled = !follow.enabled;
    orbit.enabled = !follow.enabled;
    if (orbit.enabled) orbit.target.copy(ship.position);
  }

  // The conn: from outside or at the wheel. A/D (held) put the helm
  // over, it comes back amidships when let go; the stick puts it over in
  // proportion; W/S or the stick held up/down set or take in sail.
  if (mode === '3p' || mode === 'helm') {
    const turn = (input.held('a') || input.held('arrowleft') ? 1 : 0) - (input.held('d') || input.held('arrowright') ? 1 : 0);
    let target = null;
    if (input.stickActive) {
      const x = input.touchX, ax = Math.abs(x);
      target = ax < 0.12 ? 0 : -Math.sign(x) * ((ax - 0.12) / 0.88) * GALLEON.rudderMax;
      const y = input.touchY;
      if (Math.abs(y) > 0.6 && Math.abs(y) > ax) {
        stickStepT -= dt;
        if (stickStepT <= 0) { ship.sail(y > 0 ? +1 : -1); stickStepT = 0.9; }
      } else stickStepT = 0;
    }
    ship.steer(turn, target);
    if (input.pressed('w') || input.pressed('arrowup')) ship.sail(+1);
    if (input.pressed('s') || input.pressed('arrowdown')) ship.sail(-1);
  }

  // The tide, as predicted for Reine right now (real clock).
  if (time - tideCheck > 5 || tideCheck < 0) {
    if (tideCheck < 0) ship.position.y = tideLevel();   // start afloat at today's level
    tideCheck = time;
    ocean.setTide(tideLevel());
    ocean.tideRising = tideLevel(Date.now() + 600000) > ocean.tide;
  }
  // the true wind, eased in the lee of the mountains
  {
    const wd = SEA.windDir, wl = Math.hypot(wd[0], wd[1]);
    const ws = weather.v.wind * (0.55 + 0.45 * terrain.exposure(ship.position.x, ship.position.z));
    _wind.x = (wd[0] / wl) * ws; _wind.z = (wd[1] / wl) * ws;
    ship.update(dt, time, _wind, (x, z) => heightAt(x, z) < ocean.tide - 5.5);
  }
  environment.follow(ship.position);

  const onBoard = mode === 'walk' || mode === 'helm';
  if (mode === 'walk') player.update(dt, input.moveX, input.moveY, input.held('shift'), ship.collider);
  if (mode === 'swim') {
    diver.look(input.lookDX, input.lookDY);
    diver.update(dt, {
      moveX: input.moveX, moveY: input.moveY, fast: input.held('shift'),
      up: input.held(' '), down: input.held('c') || input.held('control'),
    }, { water: (x, z) => ocean.sampleWater(x, z, time).height, ship });
    diver.updateCamera();
  } else if (mode === '3p') {
    follow.orbit(input.lookDX, input.lookDY);
    follow.zoomBy(input.zoom);
    if (follow.enabled) follow.update(dt, ship, time);
    else {
      orbit.target.lerp(ship.position, 0.05);
      orbit.update();
    }
  } else {
    player.look(input.lookDX, input.lookDY);
    player.updateCamera(ship.model);
  }

  // Below decks? A deck over your head; deep: under the upper deck (the
  // lower gundeck, the orlop, the hold: every level under 2.9 m).
  coverT -= dt;
  if (coverT <= 0) {
    coverT = 0.15;
    covered = onBoard && player.covered(ship.collider, 5);
    below = covered && player.pos.y < 2.9;
  }
  const wantK = covered ? (below ? 1 : 0.55) : 0;
  insideK += (wantK - insideK) * Math.min(1, dt * 2.5);
  if (Math.abs(insideK - lightK) > 0.01) {
    lightK = insideK;
    environment.sun.intensity = sunBase * (1 - 0.94 * insideK);
    environment.ambient.intensity = ambientBase * (1 - 0.75 * insideK);
    scene.environmentIntensity = envBase * (1 - 0.85 * insideK);
  }
  // your lantern, and the two hanging lanterns nearest you
  if (onBoard && insideK > 0.05) {
    _lampPos.set(player.pos.x, player.pos.y + 1.3, player.pos.z);
    ship.model.localToWorld(_lampPos);
    lamp.position.copy(_lampPos);
    lamp.intensity = 2.1 * insideK;
  } else lamp.intensity = 0;
  ship.lightLamps(player.pos, onBoard ? Math.max(insideK, 0.25) : 0);
  ocean.uniforms.uHullMask.value = onBoard ? 1 : 0;
  // the spaces below are drawn aboard, and from outside when close enough
  // to see in at the open ports
  if (ship.interior) ship.interior.visible = onBoard || camera.position.distanceTo(ship.position) < 110;

  // what is here, and the ladder you could take
  placeT -= dt;
  if (placeT <= 0) {
    placeT = 0.2;
    let html = '';
    if (mode === 'walk') {
      if (player.climb) html = `<b>${player.climb.l.name}</b> — ${IS_TOUCH ? 'джойстик вперёд/назад' : 'W / S'}: вверх и вниз`;
      else {
        const pl = aboard.placeAt(player.pos);
        if (pl) html = `<b>${pl.name}</b> — ${pl.text}`;
        if (player.nearHelm) html += `${html ? '<br>' : ''}<b>${IS_TOUCH ? '' : 'E — '}взять руль</b>`;
        const l = aboard.nearLadder(player.pos);
        if (l) html += `${html ? '<br>' : ''}<b>${IS_TOUCH ? '' : 'E — '}${l.fromTop ? 'спуститься' : 'подняться'}</b>: ${l.ladder.name}`;
      }
    }
    if (html !== placeKey) {
      placeKey = html;
      placeEl.innerHTML = html;
      placeEl.style.display = html ? 'block' : 'none';
    }
  }
  const action = actionHere();
  if (touch && action !== lastAction) {
    touch.setMode(mode, action);
    lastAction = action;
  }
  if (touch) touch.update(ship);
  hudT -= dt;
  orderT = Math.max(0, orderT - dt);
  const conn = mode === '3p' || mode === 'helm';
  if (hudT <= 0 && conn) {
    hudT = 0.25;
    const d = ship.describe();
    const r = Math.round(ship.rudder);
    shipHud.innerHTML = `<b>${ship.knots.toFixed(1)} уз</b> · ${d.lvl}<br>ветер ${d.course}, ${ship.aws.toFixed(0)} м/с<br>руль ${r === 0 ? 'прямо' : `${Math.abs(r)}° ${r > 0 ? 'лево' : 'право'}`}`
      + (d.extra ? `<br>${d.extra}` : '') + (orderT > 0 ? `<br><i>${orderText}</i>` : '');
  }
  shipHud.style.display = conn ? 'block' : 'none';

  // the night: lanterns on the poop and in the windows, their light on the
  // water astern
  const dark = order[presetIndex] === 'night' ? 1 : Math.min(1, weather.v.dark * 0.6);
  ship.setNight(dark);
  if (dark > 0.05) {
    ship.group.localToWorld(_stern.set(0, 0, GALLEON.length / 2 + 6));
    ocean.setPools([[_stern.x, _stern.z, 14, 0.3 * dark, [1, 0.62, 0.3]]]);
  } else ocean.setPools([]);

  // Under water: the view, the light, the life around
  // (with a margin: the waves drawn and the waves computed for the diver
  // differ by a few tens of cm; in between, the surface itself decides
  // per pixel which side of it you see)
  const under = mode === 'swim' && diver.pos.y < diver.surface - (wasUnder ? 0.15 : 0.35);
  const night = order[presetIndex] === 'night';
  const daylight = (night ? 0.06 : 1) * (1 - 0.65 * weather.v.dark);
  const torch = mode === 'swim' && (torchUser ?? (diver.depth > 12 || daylight < 0.3));
  underwater.update(dt, time, camera, { under, depth: under ? diver.depth : 0, light: daylight, sunDir: sky.sunDirection, torch });
  if (under) {
    scene.fog.color.copy(underwater.colour);
    scene.fog.density = WATER.fog;
    scene.background.copy(underwater.colour);
    ocean.uniforms.uWaterCol.value.copy(underwater.colour);
    ocean.uniforms.uWaterFog.value = WATER.fog * 0.9;
  } else if (wasUnder) applyPreset();
  if (under !== wasUnder) {
    wasUnder = under;
    ocean.uniforms.uUnder.value = under ? 1 : 0;
    sky.mesh.visible = !under && order[presetIndex] !== 'night';
    clouds.mesh.visible = nightSky.mesh.visible = !under;
    rain.mesh.visible = spray.mesh.visible = !under;
  }
  seaLife.update(dt, time, camera, { under, surfaceY: ocean.tide, seaRough: ocean.uniforms.uSeaRough.value });
  if (mode === 'swim') diveHud.update(diver, { torch, nearShip: action === 'на борт', touch: IS_TOUCH });
  terrain.leaf = mode === 'swim' ? 80 : 320;      // finer ground when you are down there
  ocean.setBoat(ship);
  ocean.setHullFrame((ship.model || ship.group).matrixWorld);
  wet.update(dt, time, weather.v.rain, weather.v.wind, ship, (x, z, t) => ocean.sampleWater(x, z, t).height);
  ship.sails.setWet(wet.rainWet);
  ocean.update(time, dt, camera, sky.sunDirection);
  clouds.update(time, camera, flash);
  nightSky.update(time, camera);
  falls.update(time, camera, weather.v.rain);
  rain.update(dt, camera, below ? 0 : weather.v.rain, weather.v.wind, ship.model);
  spray.update(dt, ship, weather.v.wind);
  if (ship.slam > 0) sound.slam(ship.slam);
  sound.update(dt, {
    camera, ship: ship.model, speed: ship.speed, heave: ship.heaveV, rollRate: ship.rollV,
    sea: ocean.uniforms.uSeaRough.value, exposure: terrain.exposure(ship.position.x, ship.position.z),
    wind: weather.v.wind, rain: weather.v.rain, dark: weather.v.dark, night,
    below: below || (covered && insideK > 0.5), aboard: onBoard, fallFlow: falls.flow,
    canvas: ship.sails.setFrac || 0, flog: ship.sails.flog || 0,
    underwater: under, shipDist: camera.position.distanceTo(ship.position),
  });
  ocean.uniforms.uRain.value = weather.v.rain;
  // Near plane: close for walking about inside the ship, further out in
  // third person so the distant mountains keep their depth precision.
  const nearPlane = mode === '3p' ? 1.0 : mode === 'swim' ? 0.05 : 0.08;
  if (camera.near !== nearPlane) { camera.near = nearPlane; camera.updateProjectionMatrix(); }
  terrain.update(camera);
  village.updateRocks(camera.position.x, camera.position.z);
  engine.render();
  input.endFrame();

  if (!started) {
    started = true;
    loading.classList.add('hidden');
    if (touch) {
      touch.toast('<b>Как управлять</b><br>Джойстик слева: влево/вправо — руль (отпустите — руль прямо), вверх/вниз — поставить или убрать паруса.<br>'
        + 'Проведите пальцем — облететь корабль, щипок двумя пальцами — ближе/дальше.<br>«на борт» — пройтись по кораблю, ☰ — меню.', 9);
    }
  }
  requestAnimationFrame(tick);
}
tick();

if (import.meta.env.DEV || /[?&]test/.test(location.search)) window.__THREE = THREE;      // for the test scripts
window.__scene = {
  engine, sky, ocean, ship, player, weather, clouds, rain, spray, sound, falls, environment, terrain, village, follow, orbit,
  heightAt, applyPreset, setMode, input, diver, underwater, seaLife, aboard, access,
  overTheSide: () => overTheSide(), get mode() { return mode; }, get below() { return below; }, get covered() { return covered; },
};
