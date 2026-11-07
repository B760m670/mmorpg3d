import * as THREE from 'three';

// Lighting + scene fog. The fog here is the cheap analytic kind applied to
// solid meshes (boat, cliffs) so they blend into the same haze the ocean
// shader fades into.
//
// The sun casts shadows only in a small box that follows the player's vessel:
// that is where self-shadowing (wheelhouse on deck, gantry, drums, rails)
// matters, and it keeps the shadow map sharp and cheap.
export class Environment {
  constructor(scene, { shadowMapSize = 2048 } = {}) {
    this.scene = scene;
    this.sunDirection = new THREE.Vector3(0, 0.3, -1).normalize();

    this.sun = new THREE.DirectionalLight(0xffffff, 2.4);
    this.sun.castShadow = true;
    const sh = this.sun.shadow;
    sh.mapSize.set(shadowMapSize, shadowMapSize);
    sh.camera.left = -22;
    sh.camera.right = 22;
    sh.camera.top = 22;
    sh.camera.bottom = -22;
    sh.camera.near = 1;
    sh.camera.far = 220;
    sh.bias = -0.0004;
    sh.normalBias = 0.04;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.ambient = new THREE.HemisphereLight(0xaec4d6, 0x0a1014, 0.9);
    scene.add(this.ambient);

    scene.fog = new THREE.FogExp2(0x9fb6c2, 0.00085);
  }

  applyPreset(p, sunDirection) {
    this.sunDirection.copy(sunDirection);
    this.sun.color.setRGB(...p.sun.color);
    this.sun.intensity = p.sun.intensity;

    this.ambient.color.setRGB(...p.ambient.color);
    this.ambient.intensity = p.ambient.intensity;

    this.scene.fog.color.setRGB(...p.fog.color);
    this.scene.fog.density = p.fog.density;
  }

  // Keep the shadow box centred on the vessel.
  follow(target) {
    this.sun.target.position.copy(target);
    this.sun.position.copy(target).addScaledVector(this.sunDirection, 120);
  }
}
