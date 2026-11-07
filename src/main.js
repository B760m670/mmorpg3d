import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { PRESETS, BOAT } from './config.js';
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
const ocean = new Ocean({ segments: IS_TOUCH ? 220 : undefined });
scene.add(ocean.mesh);
const terrain = new Terrain({ spacing: IS_TOUCH ? 12 : undefined });
scene.add(terrain.mesh);
const environment = new Environment(scene, { shadowMapSize: IS_TOUCH ? 1024 : 2048 });

const boat = new Boat();
boat.load(trawlerUrl);
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
  '3p': 'stick ◄ ► wheel · ▲ ▼ telegraph · <b>1st / 3rd</b> to go aboard',
  helm: 'stick ◄ ► wheel · ▲ ▼ telegraph · drag right side to look · <b>leave helm</b> to walk',
  walk: 'stick to walk · drag right side to look · <b>take helm</b> at the wheel',
} : {
  '3p': '<b>W/S</b> telegraph · <b>A/D</b> wheel · <b>Z</b> midships · <b>F</b> go aboard · <b>C</b> orbit · <b>N</b> day/night',
  helm: '<b>W/S</b> telegraph · <b>A/D</b> wheel · <b>Z</b> midships · <b>E</b> leave the helm · <b>F</b> 3rd person · click to look',
  walk: '<b>WASD</b> walk · <b>Shift</b> run · <b>E</b> take the helm (at the wheel) · <b>F</b> 3rd person · click to look',
};

function setMode(m) {
  mode = m;
  if (m === 'helm') player.takeHelm();
  if (m === '3p') {
    follow.enabled = true;
    orbit.enabled = false;
    if (document.pointerLockElement) document.exitPointerLock();
  }
  if (hint) hint.innerHTML = HINTS[mode];
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

function applyPreset(name) {
  const p = PRESETS[name];
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
}
applyPreset(order[presetIndex]);
follow.snap(boat);

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
let started = false;

function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;
  input.update();

  if (input.pressed('n')) {
    presetIndex = (presetIndex + 1) % order.length;
    applyPreset(order[presetIndex]);
  }
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
    const turn = (input.held('a') || input.held('arrowleft') ? 1 : 0) - (input.held('d') || input.held('arrowright') ? 1 : 0);
    boat.steer(dt, { turn, target: input.stickActive ? -input.touchX * BOAT.rudderMax : null });
  }

  boat.update(dt, time, isNavigable);
  environment.follow(boat.position);

  if (mode === 'walk') {
    player.update(dt, input.moveX, input.moveY, input.held('shift'), boat.collider);
  }
  if (mode === '3p') {
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
  ocean.setBoat(boat);
  ocean.update(time, camera, sky.sunDirection);
  engine.render();
  input.endFrame();

  if (!started) {
    started = true;
    loading.classList.add('hidden');
  }
  requestAnimationFrame(tick);
}
tick();

window.__scene = { engine, sky, ocean, boat, player, environment, terrain, follow, orbit, heightAt, applyPreset, setMode, input };
