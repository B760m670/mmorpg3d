import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

// Physically-based sky (Preetham) from three's addons. We drive the sun
// position from elevation/azimuth and expose the resulting sun direction so
// the ocean shader and the directional light stay in sync with the sky.
export class SkyDome {
  constructor() {
    this.sky = new Sky();
    this.sky.scale.setScalar(20000);
    this.sunDirection = new THREE.Vector3(0, 0.1, -1);
  }

  get mesh() {
    return this.sky;
  }

  applyPreset(p) {
    const u = this.sky.material.uniforms;
    u.turbidity.value = p.sky.turbidity;
    u.rayleigh.value = p.sky.rayleigh;
    u.mieCoefficient.value = p.sky.mieCoefficient;
    u.mieDirectionalG.value = p.sky.mieDirectionalG;

    const phi = THREE.MathUtils.degToRad(90 - p.sky.elevation);
    const theta = THREE.MathUtils.degToRad(p.sky.azimuth);
    this.sunDirection.setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(this.sunDirection);
  }
}
