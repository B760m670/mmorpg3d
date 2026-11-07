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
import { Terrain, heightAt, isNavigable } from './world/Terrain.js';
import { Boat } from './entities/Boat.js';
import { Player } from './entities/Player.js';
import { Input } from './systems/Input.js';
import { FollowCamera } from './systems/FollowCamera.js';
import { TouchControls } from './systems/TouchControls.js';
import { Bridge } from './ui/Bridge.js';
import { Instruments } from './ui/Instruments.js';
import trawlerUrl from './assets/trawler.glb?url';

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
const terrain = new Terrain({ spacing: IS_TOUCH ? 12 : undefined });
scene.add(terrain.mesh);
const ocean = new Ocean({ renderer, terrain, mobile: IS_TOUCH });
scene.add(ocean.mesh);
const weather = new Weather();
ocean.setState(weather.state.sea, true);
const falls = new Waterfalls(terrain);
scene.add(falls.group);
falls.resize(window.innerHeight);
window.addEventListener('resize', () => falls.resize(window.innerHeight));
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

const instruments = new Instruments(terrain);
const boat = new Boat();
boat.water = (x, z, t) => ocean.sampleWater(x, z, t);
boat.load(trawlerUrl, () => instruments.attach(boat.model));
scene.add(boat.object);

const input = new Input();
const player = new Player(camera);
const bridge = new Bridge();
const follow = new FollowCamera(camera);
follow.groundAt = (x, z) => Math.max(0, heightAt(x, z));

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.maxPolarAngle = Math.PI * 0.495;
orbit.enabled = false;

const touch = IS_TOUCH ? new TouchControls(input) : null;
if (IS_TOUCH) document.body.classList.add('touch');

// ---------------------------------------------------------------- modes
//   3p    third person, you have the conn
//   helm  first person at the wheel on the bridge
//   walk  first person, moving about the ship (she keeps her last orders)
let mode = '3p';
let lastNear = null;

const HINTS = IS_TOUCH ? {
  '3p': 'рычаг справа — ход · джойстик слева — руль · палец — облёт, щипок — ближе/дальше',
  helm: 'рычаг — ход · джойстик — руль · палец — осмотреться · «отойти» — пройтись по судну',
  walk: 'джойстик — идти · палец — осмотреться · у штурвала — «к штурвалу»',
} : {
  '3p': '<b>W/S</b> телеграф · <b>A/D</b> руль · <b>Z</b> руль прямо · мышь — облёт, колесо — ближе/дальше · <b>F</b> на борт · <b>N</b> день/ночь · <b>B</b> погода · <b>H</b> гудок · <b>M</b> звук · <b>I</b> приборы',
  helm: '<b>W/S</b> телеграф · <b>A/D</b> руль · <b>Z</b> руль прямо · <b>E</b> отойти от штурвала · <b>F</b> вид со стороны · клик — осмотреться',
  walk: '<b>WASD</b> идти · <b>Shift</b> бегом · <b>E</b> к штурвалу (стоя у него) · <b>F</b> вид со стороны · клик — осмотреться',
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
  if (m === 'helm') player.takeHelm();
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
function applyPreset(name) {
  if (name && order.includes(name)) presetIndex = order.indexOf(name);
  const p = resolve(PRESETS[order[presetIndex]], weather.v);
  sceneExposure = p.exposure;
  engine.applyPreset(p);
  sky.applyPreset(p);
  ocean.applyPreset(p);
  environment.applyPreset(p, sky.sunDirection);
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
  if (input.pressed('h')) sound.horn(boat.position);
  updateWeather(dt);
  if (input.pressed('f')) setMode(mode === '3p' ? 'helm' : '3p');
  if (input.pressed('e')) {
    if (mode === 'helm') setMode('walk');
    else if (mode === 'walk' && player.nearHelm) setMode('helm');
  }
  if (input.pressed('c') && mode === '3p') {
    follow.enabled = !follow.enabled;
    orbit.enabled = !follow.enabled;
    if (orbit.enabled) orbit.target.copy(boat.position);
  }

  // The conn: telegraph and wheel answer only from the helm.
  if (mode !== 'walk') {
    if (input.pressed('w') || input.pressed('arrowup')) boat.telegraphStep(+1);
    if (input.pressed('s') || input.pressed('arrowdown')) boat.telegraphStep(-1);
    if (input.pressed('z')) boat.midships();
    if (input.telegraphSet !== null) boat.telegraph = input.telegraphSet;
    const turn = (input.held('a') || input.held('arrowleft') ? 1 : 0) - (input.held('d') || input.held('arrowright') ? 1 : 0);
    boat.steer(dt, { turn, target: input.stickActive ? -input.touchX * BOAT.rudderMax : null });
  }

  boat.update(dt, time, isNavigable);
  environment.follow(boat.position);

  if (mode === 'walk') {
    player.update(dt, input.moveX, input.moveY, input.held('shift'), boat.collider);
  }
  if (mode === '3p') {
    follow.orbit(input.lookDX, input.lookDY);
    follow.zoomBy(input.zoom);
    if (follow.enabled) follow.update(dt, boat, time);
    else {
      orbit.target.lerp(boat.position, 0.05);
      orbit.update();
    }
  } else {
    player.look(input.lookDX, input.lookDY);
    player.updateCamera(boat.model);
  }

  const near = mode === 'walk' && player.nearHelm;
  if (touch && near !== lastNear) {
    touch.setMode(mode, near);
    lastNear = near;
  }
  bridge.update(boat);
  if (touch) touch.update(boat.telegraph);
  const pp = player.pos;
  const onBridge = mode === 'helm' ||
    (mode === 'walk' && pp.y > 5.1 && pp.z > -6.3 && pp.z < 0.2 && Math.abs(pp.x) < 3.4);
  instruments.update(dt, boat, onBridge);
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
    sea: ocean.uniforms.uSeaRough.value, exposure: Math.min(1, Math.max(0, (boat.position.z + 1600) / 1400)),
    wind: weather.v.wind, rain: weather.v.rain, dark: weather.v.dark, night: order[presetIndex] === 'night',
    inside: onBridge, aboard: mode !== '3p', fallFlow: falls.flow,
  });
  ocean.uniforms.uRain.value = weather.v.rain;
  engine.render();
  input.endFrame();

  if (!started) {
    started = true;
    loading.classList.add('hidden');
    if (touch) {
      touch.toast('<b>Как управлять</b><br>Рычаг справа — ход: вверх вперёд, вниз назад.<br>Джойстик слева — руль.<br>'
        + 'Проведите пальцем — облететь судно, щипок двумя пальцами — ближе/дальше.<br>«на борт» — встать к штурвалу, ☰ — меню.', 9);
    }
  }
  requestAnimationFrame(tick);
}
tick();

window.__scene = { engine, sky, ocean, boat, player, instruments, weather, clouds, rain, spray, sound, falls, environment, terrain, follow, orbit, heightAt, applyPreset, setMode, input };
