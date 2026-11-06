import * as THREE from 'three';

// Lighting + scene fog. The fog here is the cheap analytic kind applied to
// solid meshes (boat, future cliffs) so they blend into the same haze the
// ocean shader fades into. A true volumetric pass comes later as post-FX.
export class Environment {
  constructor(scene) {
    this.scene = scene;

    this.sun = new THREE.DirectionalLight(0xffffff, 2.4);
    this.sun.position.set(0, 100, -200);
    scene.add(this.sun);

    this.ambient = new THREE.HemisphereLight(0xaec4d6, 0x0a1014, 0.9);
    scene.add(this.ambient);

    scene.fog = new THREE.FogExp2(0x9fb6c2, 0.00085);
  }

  applyPreset(p, sunDirection) {
    this.sun.color.setRGB(...p.sun.color);
    this.sun.intensity = p.sun.intensity;
    this.sun.position.copy(sunDirection).multiplyScalar(500);

    this.ambient.color.setRGB(...p.ambient.color);
    this.ambient.intensity = p.ambient.intensity;

    this.scene.fog.color.setRGB(...p.fog.color);
    this.scene.fog.density = p.fog.density;
  }
}
