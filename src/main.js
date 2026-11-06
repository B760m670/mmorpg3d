import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { PRESETS } from './config.js';
import { Engine } from './core/Engine.js';
import { SkyDome } from './world/SkyDome.js';
import { Ocean } from './world/Ocean.js';
import { Environment } from './world/Environment.js';
import { Terrain, heightAt, isNavigable } from './world/Terrain.js';
import { Boat } from './entities/Boat.js';
import { Input } from './systems/Input.js';
import { FollowCamera } from './systems/FollowCamera.js';
import { TouchControls } from './systems/TouchControls.js';

const container = document.getElementById('app');
const loading = document.getElementById('loading');

// Detect touch / coarse-pointer devices and dial quality down a notch for them.
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

const environment = new Environment(scene);

const boat = new Boat();
scene.add(boat.object);

const input = new Input();
const follow = new FollowCamera(camera);
follow.groundAt = (x, z) => Math.max(0, heightAt(x, z));

// Free-look camera (toggled with C). Disabled by default.
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.maxPolarAngle = Math.PI * 0.495; // don't dip under the water
orbit.enabled = false;

// Touch controls (phones/tablets). Buttons fire the same one-shot actions as
// the N / C keys. The joystick is hidden while free-look camera owns touch.
let touch = null;
if (IS_TOUCH) {
  document.body.classList.add('touch');
  touch = new TouchControls(input, {
    onToggleTime: () => { input.actions.toggleTime = true; },
    onToggleCamera: () => { input.actions.toggleCamera = true; },
  });
  const hud = document.getElementById('hud');
  if (hud) {
    hud.innerHTML =
      '<div>Drag the stick: <b>up</b> sail &nbsp; <b>left / right</b> steer</div>' +
      '<div>Buttons: <b>day / night</b> &nbsp; <b>camera</b></div>';
  }
}

// --- Presets -------------------------------------------------------------
const order = ['day', 'night'];
let presetIndex = 0;

function applyPreset(name) {
  const p = PRESETS[name];
  engine.applyPreset(p);
  sky.applyPreset(p);
  ocean.applyPreset(p);
  environment.applyPreset(p, sky.sunDirection);
  sky.mesh.visible = p.showSkyDome !== false;
  scene.background = new THREE.Color().setRGB(...p.fog.color);
}

applyPreset(order[presetIndex]);
follow.snap(boat);

// --- Loop ----------------------------------------------------------------
const clock = new THREE.Clock();
let started = false;

function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;

  if (input.consume('toggleTime')) {
    presetIndex = (presetIndex + 1) % order.length;
    applyPreset(order[presetIndex]);
  }
  if (input.consume('toggleCamera')) {
    follow.enabled = !follow.enabled;
    orbit.enabled = !follow.enabled;
    if (orbit.enabled) orbit.target.copy(boat.position);
    if (touch) touch.setVisible(follow.enabled);
  }

  input.update();
  boat.update(dt, input, time, isNavigable);

  if (follow.enabled) {
    follow.update(dt, boat, time);
  } else {
    orbit.target.lerp(boat.position, 0.05);
    orbit.update();
  }

  ocean.update(time, camera, sky.sunDirection);
  engine.render();

  if (!started) {
    started = true;
    loading.classList.add('hidden');
  }
  requestAnimationFrame(tick);
}

tick();

// Expose for quick console tweaking / debugging.
window.__scene = { engine, sky, ocean, boat, environment, terrain, follow, heightAt, applyPreset };
