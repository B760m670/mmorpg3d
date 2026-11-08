import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { PRESETS, BOAT, SEA } from './config.js';
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
import { Boat } from './entities/Boat.js';
import { Player } from './entities/Player.js';
import { Input } from './systems/Input.js';
import { FollowCamera } from './systems/FollowCamera.js';
import { TouchControls } from './systems/TouchControls.js';
import { Bridge } from './ui/Bridge.js';
import { Instruments } from './ui/Instruments.js';
import trawlerUrl from './assets/trawler.glb?url';
import villageUrl from './assets/village.glb?url';
import { Village } from './world/Village.js';
import { Underwater, WATER } from './world/Underwater.js';
import { SeaLife } from './world/SeaLife.js';
import { Diver } from './entities/Diver.js';
import { DiveComputer } from './ui/DiveComputer.js';
import { Alarms } from './ship/Alarms.js';
import { Electrical } from './ship/Electrical.js';
import { Sensors } from './ship/Sensors.js';
import { ShipLights } from './ship/ShipLights.js';
import { ShipPanels } from './ui/ShipPanels.js';
import { Whistle } from './ship/Whistle.js';
import { Anchor } from './ship/Anchor.js';
import { Crew } from './entities/Crew.js';
import crewUrl from './assets/crew.glb?url';

const container = document.getElementById('app');
const loading = document.getElementById('loading');
const hint = document.getElementById('hud');

const IS_TOUCH =
  (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
  'ontouchstart' in window ||
  navigator.maxTouchPoints > 0;

const engine = new Engine(container, { maxPixelRatio: IS_TOUCH ? 1.5 : 2 });
const { scene, camera, renderer } = engine;

const sky = new SkyDome();
scene.add(sky.mesh);
const terrain = new Terrain({ mobile: IS_TOUCH });
scene.add(terrain.mesh);
const ocean = new Ocean({ renderer, terrain, mobile: IS_TOUCH });
// buildings from the register and boulders from the deposit map
const village = new Village({ mobile: IS_TOUCH });
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
// The player's own light below decks (fluorescent tubes are emissive only).
// (always in the scene, switched by its intensity: adding or removing a
// light would recompile every material)
const lamp = new THREE.PointLight(0xfff1dc, 0, 9, 1.2);
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

// The ship's systems: electrical plant, sensors and bridge equipment, lights
const alarms = new Alarms();
const elec = new Electrical(alarms);
const sensors = new Sensors(alarms, elec);
const shipLights = new ShipLights({ scene, elec, mobile: IS_TOUCH });
const whistle = new Whistle(elec);
const anchor = new Anchor({ scene, elec, alarms });
const crew = new Crew();
let thirdPerson = false;
const _prevPP = new THREE.Vector3();
const _windCtx = { heightAt, tide: 0, wind: 0 };
const _hornPos = new THREE.Vector3();
const instruments = new Instruments(terrain, sensors);
const boat = new Boat();
// Lying off Reine in Vestfjorden, bow toward the fjord mouth: course 335°,
// clear water for about 3 km (the skerries east of Reine are to port).
boat.heading = THREE.MathUtils.degToRad(25);
boat.water = (x, z, t) => ocean.sampleWater(x, z, t);
boat.load(trawlerUrl, () => {
  instruments.attach(boat.model);
  const mats = new Set();
  boat.model.traverse((o) => { if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m && mats.add(m)); });
  shipLights.attach(boat.model, { materials: [...mats], torch: underwater.torch });
  crew.load(crewUrl, boat.model);
});
scene.add(boat.object);

const input = new Input();
const player = new Player(camera);
const diver = new Diver(camera);
const diveHud = new DiveComputer();
let torchUser = null;          // null: automatic (deep or dark), else on/off as chosen
let wasUnder = false;
const bridge = new Bridge();
const follow = new FollowCamera(camera);
follow.groundAt = (x, z) => Math.max(0, heightAt(x, z));
follow.waterAt = (x, z, t) => ocean.sampleWater(x, z, t).height;

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.maxPolarAngle = Math.PI * 0.495;
orbit.enabled = false;

const touch = IS_TOUCH ? new TouchControls(input) : null;
const panels = new ShipPanels({
  elec, sensors, lights: shipLights, alarms, whistle, anchor,
  actions: {
    // the searchlight to where the camera looks
    aimSearch: () => {
      if (!boat.model) return;
      const d = camera.getWorldDirection(new THREE.Vector3());
      const q = boat.model.getWorldQuaternion(new THREE.Quaternion()).invert();
      d.applyQuaternion(q);
      shipLights.search.az = (Math.atan2(d.x, -d.z) * 180) / Math.PI;
      shipLights.search.el = Math.max(-25, Math.min(15, (Math.asin(Math.max(-1, Math.min(1, d.y))) * 180) / Math.PI));
      shipLights.search.on = true;
    },
  },
});
if (IS_TOUCH) document.body.classList.add('touch');

// ---------------------------------------------------------------- modes
//   3p    third person, you have the conn
//   helm  first person at the wheel on the bridge
//   walk  first person, moving about the ship (she keeps her last orders)
//   swim  in the water: a diver with a cylinder, over the side
let mode = '3p';
let lastNear = null;
let stickWas = false, stickStepT = 0;
let tideCheck = -1;

const HINTS = IS_TOUCH ? {
  '3p': 'джойстик: ←→ руль, ↑↓ ход · рычаг справа — ход · палец по экрану — облёт, щипок — ближе/дальше',
  helm: 'джойстик: ←→ руль, ↑↓ ход · рычаг — ход · палец по экрану — осмотреться · «отойти» — пройтись по судну',
  walk: 'джойстик — идти · палец — осмотреться · у штурвала — «к штурвалу» · «нырнуть» — за борт',
  swim: 'джойстик — плыть туда, куда смотрите · ▲ ▼ — вверх / вниз · палец — осмотреться · «фонарь» · у борта — «на борт»',
} : {
  '3p': '<b>W/S</b> телеграф · <b>A/D</b> руль · <b>Z</b> руль прямо · мышь — облёт, колесо — ближе/дальше · <b>F</b> на борт · <b>N</b> день/ночь · <b>B</b> погода · <b>H</b> гудок (держать) · <b>M</b> звук · <b>I</b> приборы · <b>J</b> нырнуть · <b>P</b> пульт (огни, свет, приборы, энергия) · <b>U</b> авторулевой',
  helm: '<b>W/S</b> телеграф · <b>A/D</b> руль · <b>Z</b> руль прямо · <b>U</b> авторулевой · <b>P</b> пульт · <b>E</b> отойти от штурвала · <b>F</b> вид со стороны · клик — осмотреться',
  walk: '<b>WASD</b> идти · <b>Shift</b> бегом · <b>V</b> вид от 1-го / 3-го лица · <b>E</b> к штурвалу (стоя у него) · <b>P</b> пульт на мостике / щит в машинном · <b>J</b> за борт · <b>F</b> вид со стороны · клик — осмотреться',
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
  lastNear = null;
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
let sunBase = 2.4, ambientBase = 1;
let insideK = 0;
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
  insideK = -1;      // re-apply the below-decks dimming
  sky.mesh.visible = p.showSkyDome !== false;
  scene.background = new THREE.Color().setRGB(...p.fog.color);
  envSky.applyPreset(p);
  if (envTarget) envTarget.dispose();
  envTarget = pmrem.fromScene(envScene, 0.02, 0.1, 2000);
  scene.environment = envTarget.texture;
  scene.environmentIntensity = p.envIntensity ?? 0.6;
  clouds.applyPreset(p, sky.sunDirection);
  nightSky.applyPreset(p, sky.sunDirection, weather.v.clouds);
  rain.applyPreset(p);
  spray.applyPreset(p);
  falls.applyPreset(p);
  instruments.setNight(order[presetIndex] === 'night');
}
applyPreset(order[presetIndex]);
follow.snap(boat);

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
  engine.renderer.toneMappingExposure = sceneExposure * (1 + flash * 1.4);
}

// ---------------------------------------------------------------- panels
// standing at the main switchboard (engine room, forward bulkhead, port)
function nearSwitchboard() {
  const pp = player.pos;
  return mode === 'walk' && pp.y < -0.3 && Math.hypot(pp.x + 1.9, pp.z - 3.2) < 1.9;
}
function onBridgeNow() {
  const pp = player.pos;
  return pp.y > 5.1 && pp.z > -6.3 && pp.z < 0.2 && Math.abs(pp.x) < 3.4;
}

// ---------------------------------------------------------------- diving
// Over the side: from the deck (the side you stand nearest) or, from the
// outside view, off the starboard quarter.
const _dv = new THREE.Vector3();
const _dir = new THREE.Vector3();
diver.onBreath = (out) => {
  sound.breath(out, diver.depth);
  if (out && wasUnder) underwater.exhale(camera);
};
function overTheSide() {
  const side = mode === 'walk' ? (Math.sign(player.pos.x) || 1) : 1;
  const z = mode === 'walk' ? THREE.MathUtils.clamp(player.pos.z, -8, 10) : 5;
  _dv.set(side * 6.0, 0, z);
  boat.model.localToWorld(_dv);
  _dv.y = ocean.sampleWater(_dv.x, _dv.z, clock.elapsedTime).height + 0.1;
  camera.getWorldDirection(_dir);
  const yaw = mode === 'walk' ? Math.atan2(-_dir.x, -_dir.z) : boat.heading + (side > 0 ? -Math.PI / 2 : Math.PI / 2);
  diver.enter(_dv, yaw);
  torchUser = null;
  sound.splash();
  setMode('swim');
  if (touch) touch.toast(Math.abs(boat.speed) > 0.8 ? 'За бортом. Судно на ходу — оно уйдёт без вас!' : 'За бортом. Вода 7 °C, сухой гидрокостюм, баллон 12 л на 200 бар.', 4);
}
function climbAboard() {
  if (!diver.nearShip(boat.model)) {
    if (touch) touch.toast('Подплывите к борту судна', 2);
    return;
  }
  _dv.copy(diver.pos);
  boat.model.worldToLocal(_dv);
  const side = Math.sign(_dv.x) || 1;
  const origin = new THREE.Vector3(side * 3.3, 12, THREE.MathUtils.clamp(_dv.z, -7, 9));
  const hit = boat.collider && player._cast(origin, new THREE.Vector3(0, -1, 0), 20, boat.collider);
  player.pos.set(origin.x, hit ? hit.point.y : 2.4, origin.z);
  player.lastSafe.copy(player.pos);
  player.vy = 0;
  player.yaw = side > 0 ? Math.PI / 2 : -Math.PI / 2;     // facing inboard
  player.pitch = 0;
  diver.air = 200;                                       // a fresh cylinder
  setMode('walk');
}

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
let started = false;

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
  if (input.pressed('i')) {
    const v = bridge.cycle();
    if (touch) touch.toast(v === 'off' ? 'Приборы скрыты (☰ → приборы — вернуть)' : v === 'full' ? 'Приборы: подробно' : 'Приборы: кратко', 2.5);
  }
  if (input.pressed('m')) {
    const muted = sound.toggle();
    if (touch) touch.setSound(muted);
  }
  // the whistle: held down it blows for as long as you hold it; a tap on the
  // menu button gives one short blast
  const atConn = mode === '3p' || mode === 'helm' || (mode === 'walk' && onBridgeNow());
  const hornHeld = atConn && input.held('h');
  if (atConn && input.pressed('h') && !input.held('h')) whistle.play('s1');
  if (hornHeld) sensors.bnwasReset();
  updateWeather(dt);
  if (input.pressed('f') && mode !== 'swim') setMode(mode === '3p' ? 'helm' : '3p');
  if (input.pressed('e')) {
    if (mode === 'helm') setMode('walk');
    else if (mode === 'walk' && player.nearHelm) setMode('helm');
    else if (mode === 'swim') climbAboard();
  }
  if (input.pressed('j') && (mode === '3p' || mode === 'walk') && boat.model) overTheSide();
  if (input.pressed('v') && mode === 'walk') {
    thirdPerson = !thirdPerson;
    if (touch) touch.toast(thirdPerson ? 'Вид от третьего лица' : 'Вид от первого лица', 1.5);
  }
  if (input.pressed('escape') && panels.isOpen) panels.hide();
  else if (input.pressed('p')) {
    if (panels.isOpen) panels.hide();
    else if (nearSwitchboard()) panels.show('msb');
    else if (mode === '3p' || mode === 'helm' || (mode === 'walk' && onBridgeNow())) panels.show('bridge');
    else if (touch) touch.toast('Пульт — на мостике, главный щит — в машинном отделении', 2.5);
    else showHint('Пульт управления — на мостике (P), главный распределительный щит — в машинном отделении у переборки (P)');
  }
  if (input.pressed('l') && mode === 'swim') {
    torchUser = !underwater.torchOn;
    if (touch) touch.toast(torchUser ? 'Фонарь включён' : 'Фонарь выключен', 1.5);
  }
  if (input.pressed('c') && mode === '3p') {
    follow.enabled = !follow.enabled;
    orbit.enabled = !follow.enabled;
    if (orbit.enabled) orbit.target.copy(boat.position);
  }

  // The conn: telegraph and wheel answer only from the helm.
  if (mode === '3p' || mode === 'helm') {
    const tg0 = boat.telegraph;
    if (input.pressed('w') || input.pressed('arrowup')) boat.telegraphStep(+1);
    if (input.pressed('s') || input.pressed('arrowdown')) boat.telegraphStep(-1);
    if (input.pressed('z')) boat.midships();
    if (input.telegraphSet !== null) boat.telegraph = input.telegraphSet;
    if (input.wheelSet !== null) boat.wheel = input.wheelSet;
    if (boat.telegraph !== tg0) sensors.bnwasReset();
    if (input.pressed('u')) {
      if (sensors.ap.mode === 'auto') sensors.apHand('ручное управление'); else sensors.apEngage();
      if (touch) touch.toast(sensors.ap.mode === 'auto' ? `Авторулевой: курс ${Math.round(sensors.ap.set)}°` : `Ручное управление${sensors.ap.msg ? ': ' + sensors.ap.msg : ''}`, 2);
    }
    const turn = (input.held('a') || input.held('arrowleft') ? 1 : 0) - (input.held('d') || input.held('arrowright') ? 1 : 0);
    // Helm joystick (phone): sideways = rudder in proportion, back to
    // midships when released (follow-up steering); held up/down = step the
    // engine order once, then again every 0.6 s while held.
    let target = null;
    if (input.stickActive) {
      const x = input.touchX, ax = Math.abs(x);
      target = ax < 0.12 ? 0 : -Math.sign(x) * ((ax - 0.12) / 0.88) * BOAT.rudderMax;
      const y = input.touchY;
      if (Math.abs(y) > 0.6 && Math.abs(y) > ax) {
        stickStepT -= dt;
        if (stickStepT <= 0) { boat.telegraphStep(y > 0 ? +1 : -1); stickStepT = 0.6; }
      } else stickStepT = 0;
    } else if (stickWas) boat.midships();
    stickWas = input.stickActive;
    // taking the wheel overrides the autopilot
    const handOnWheel = turn !== 0 || (input.stickActive && Math.abs(input.touchX) > 0.12) || input.wheelSet !== null;
    if (handOnWheel) {
      sensors.bnwasReset();
      if (sensors.ap.mode === 'auto') sensors.apHand('ручное управление');
    }
    boat.steer(dt, { turn, target });
  }
  if (sensors.ap.mode === 'auto') boat.wheel = sensors.ap.wheel;

  // The tide, as predicted for Reine right now (real clock). Deep enough to
  // float means 4 m of water over the bottom at the present level.
  if (time - tideCheck > 5 || tideCheck < 0) {
    if (tideCheck < 0) boat.position.y = tideLevel();   // start afloat at today's level
    tideCheck = time;
    ocean.setTide(tideLevel());
    ocean.tideRising = tideLevel(Date.now() + 600000) > ocean.tide;
  }
  // ship's systems: sensors and equipment, then the power they all draw
  sensors.update(dt, { boat, heightAt, weather, seaRough: ocean.uniforms.uSeaRough.value });
  elec.dcW = sensors.dcW + shipLights.dcW;
  elec.update(dt, { rudderRate: boat.rudderRate || 0, meRunning: boat.engineRunning, meFuel: sensors.me.fuel });
  boat.steeringPumps = elec.steeringPumps;
  whistle.update(dt, hornHeld);
  if (boat.model) sound.tyfon(whistle.open, elec.air, boat.model.localToWorld(_hornPos.set(-0.8, 8.2, -3.9)));
  // wind drift: a stopped trawler makes leeway of about 3 % of the wind
  // speed; under way she carries her way through it
  {
    const wd = SEA.windDir, l = Math.hypot(wd[0], wd[1]);
    const lee = 0.03 * weather.v.wind * (1 - Math.min(1, Math.abs(boat.speed) / 3));
    boat.drift.x = (wd[0] / l) * lee;
    boat.drift.z = (wd[1] / l) * lee;
  }
  _windCtx.tide = ocean.tide;
  _windCtx.wind = weather.v.wind;
  anchor.update(dt, boat, _windCtx);
  boat.constrain = (cdt) => anchor.constrain(cdt, boat, _windCtx);
  boat.update(dt, time, (x, z) => heightAt(x, z) < ocean.tide - 4);
  anchor.draw(boat, _windCtx);
  anchor.watch(sensors.gps);
  environment.follow(boat.position);

  if (mode === 'walk') {
    player.update(dt, input.moveX, input.moveY, input.held('shift'), boat.collider);
  }
  if (mode === 'swim') {
    diver.look(input.lookDX, input.lookDY);
    diver.update(dt, {
      moveX: input.moveX, moveY: input.moveY, fast: input.held('shift'),
      up: input.held(' '), down: input.held('c') || input.held('control'),
    }, { water: (x, z) => ocean.sampleWater(x, z, time).height, boat });
    diver.updateCamera();
  } else if (mode === '3p') {
    follow.orbit(input.lookDX, input.lookDY);
    follow.zoomBy(input.zoom);
    if (follow.enabled) follow.update(dt, boat, time);
    else {
      orbit.target.lerp(boat.position, 0.05);
      orbit.update();
    }
  } else {
    player.look(input.lookDX, input.lookDY);
    if (mode === 'walk' && thirdPerson) player.updateCameraThird(boat.model, boat.collider);
    else player.updateCamera(boat.model);
  }
  // the people aboard
  const moved = Math.hypot(player.pos.x - _prevPP.x, player.pos.z - _prevPP.z) / Math.max(dt, 1e-3);
  _prevPP.copy(player.pos);
  crew.update(dt, { mode, player, playerMoving: moved > 0.3, running: moved > 2.0, thirdPerson, near: camera.position.distanceTo(boat.position) });

  const near = mode === 'swim' ? diver.nearShip(boat.model) : mode === 'walk' && player.nearHelm;
  if (touch) touch.setPanel(nearSwitchboard() ? 'щит' : mode === '3p' || mode === 'helm' || (mode === 'walk' && onBridgeNow()) ? 'пульт' : null);
  if (touch && near !== lastNear) {
    touch.setMode(mode, near);
    lastNear = near;
  }
  bridge.update(boat, sensors);
  if (touch) touch.update(boat);
  const pp = player.pos;
  const onBridge = mode === 'helm' ||
    (mode === 'walk' && pp.y > 5.1 && pp.z > -6.3 && pp.z < 0.2 && Math.abs(pp.x) < 3.4);
  // Below decks: 'tween deck (2.15), steering flat (0.0), engine room
  // (-1.4, stations 3.0-9.4) and fishroom (-1.5). Model z is aft-positive:
  // station s = 11.975 - z.
  const belowDecks = mode === 'walk' && pp.y < 3.9;
  const engineRoom = belowDecks && pp.y < -0.3 && pp.z > 2.55 && pp.z < 9.0;
  ocean.uniforms.uHullMask.value = belowDecks ? 1 : 0;
  // The spaces below are drawn aboard, and from outside when the camera is
  // close enough to look in through a hatch or the wheelhouse windows.
  if (boat.interior) boat.interior.visible = mode === 'walk' || mode === 'helm' || camera.position.distanceTo(boat.position) < 32;
  // the lights: navigation lights, floods, searchlight, the room you are in
  const dark = order[presetIndex] === 'night' ? 1 : Math.min(1, weather.v.dark * 0.6);
  shipLights.update(dt, { camera, dark, onBridge, belowDecks, lamp, swimming: mode === 'swim' });
  ocean.setPools(shipLights.pools(boat.model, ocean.tide));
  panels.update(dt);
  // Below decks only the deckhead lights and your lamp light the spaces: the
  // sun and the open sky are shut out (they would leak through the plating).
  const inK = belowDecks ? 1 : 0;
  if (inK !== insideK) {
    insideK = inK;
    environment.sun.intensity = sunBase * (inK ? 0.03 : 1);
    environment.ambient.intensity = ambientBase * (inK ? 0.28 : 1);
  }
  instruments.update(dt, boat, onBridge);

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
  if (mode === 'swim') diveHud.update(diver, { torch, nearShip: near, touch: IS_TOUCH });
  terrain.leaf = mode === 'swim' ? 80 : 320;      // finer ground when you are down there
  ocean.setBoat(boat);
  ocean.update(time, dt, camera, sky.sunDirection);
  bridge.setSea(ocean, weatherRu());
  clouds.update(time, camera, flash);
  nightSky.update(time, camera);
  falls.update(time, camera, weather.v.rain);
  rain.update(dt, camera, weather.v.rain, weather.v.wind, boat.model);
  spray.update(dt, boat, weather.v.wind);
  if (boat.slam > 0) sound.slam(boat.slam);
  sound.update(dt, {
    camera, ship: boat.model, rpm: boat.rpm, speed: boat.speed, heave: boat.heaveV, rollRate: boat.rollV,
    sea: ocean.uniforms.uSeaRough.value, exposure: terrain.exposure(boat.position.x, boat.position.z),
    wind: weather.v.wind, rain: weather.v.rain, dark: weather.v.dark, night: order[presetIndex] === 'night',
    inside: onBridge || belowDecks, engineRoom, aboard: mode === 'walk' || mode === 'helm', fallFlow: falls.flow,
    underwater: under, shipDist: camera.position.distanceTo(boat.position),
    engineRunning: boat.engineRunning, gens: elec.gens.filter((g) => g.state === 'running' || g.state === 'runup').length, genHz: elec.busF || 50,
    alarm: alarms.unacked > 0 || sensors.bnwas.stage >= 2,
    chain: anchor.speed, chainPos: boat.model ? anchor.hawseWorld(boat) : null,
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
      touch.toast('<b>Как управлять</b><br>Джойстик слева: влево/вправо — руль (отпустите — руль прямо), вверх/вниз — прибавить/убавить ход.<br>Рычаг справа — ход сразу на нужное деление.<br>'
        + 'Проведите пальцем — облететь судно, щипок двумя пальцами — ближе/дальше.<br>«на борт» — встать к штурвалу, ☰ — меню.', 9);
    }
  }
  requestAnimationFrame(tick);
}
tick();

window.__scene = { engine, sky, ocean, boat, player, instruments, weather, clouds, rain, spray, sound, falls, environment, terrain, village, follow, orbit, heightAt, applyPreset, setMode, input, diver, underwater, seaLife, elec, sensors, shipLights, panels, alarms, nearSwitchboard, whistle, anchor, crew, setThird: (v) => { thirdPerson = v; }, overTheSide: () => overTheSide(), get mode() { return mode; } };
