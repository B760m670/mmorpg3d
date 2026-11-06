import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { PRESETS } from './config.js';
import { Engine } from './core/Engine.js';
import { SkyDome } from './world/SkyDome.js';
import { Ocean } from './world/Ocean.js';
import { Environment } from './world/Environment.js';
import { Boat } from './entities/Boat.js';
import { Input } from './systems/Input.js';
import { FollowCamera } from './systems/FollowCamera.js';

const container = document.getElementById('app');
const loading = document.getElementById('loading');

const engine = new Engine(container);
const { scene, camera, renderer } = engine;

const sky = new SkyDome();
scene.add(sky.mesh);

const ocean = new Ocean();
scene.add(ocean.mesh);

const environment = new Environment(scene);

const boat = new Boat();
scene.add(boat.object);

const input = new Input();
const follow = new FollowCamera(camera);

// Free-look camera (toggled with C). Disabled by default.
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.maxPolarAngle = Math.PI * 0.495; // don't dip under the water
orbit.enabled = false;

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
  }

  input.update();
  boat.update(dt, input, time);

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
window.__scene = { engine, sky, ocean, boat, environment, applyPreset };
