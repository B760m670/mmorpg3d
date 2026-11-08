import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// The person aboard: the man the ship came to, who runs her himself. The
// model is a ready-made, professionally built avatar - Microsoft Rocketbox
// Male_Adult_07 (MIT licence), with the library's motion-captured animations
// (blender/build_person.py converts it). He rides in the ship's own frame:
//   - walking about the ship with the camera behind you (third person) you
//     see yourself: standing, walking, jogging;
//   - steering from the outside camera you see him at the controls in the
//     wheelhouse, through the windows.

function bufferFromDataUrl(url) {
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

const CONN = { p: [0, 5.4, -4.75], yaw: Math.PI };   // at the controls, facing the bow (model space)

export class Crew {
  constructor() {
    this.ready = false;
    this.current = null;
    this.idleT = 0;
  }

  load(url, model) {
    const loader = new GLTFLoader();
    const done = (gltf) => {
      const root = gltf.scene;
      root.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.receiveShadow = true;
        o.frustumCulled = false;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          m.envMapIntensity = 0.6;
          if (m.name === 'hair') {      // hair and lashes: cut out, not blended, dull
            m.transparent = false;
            m.alphaTest = 0.5;
            m.side = THREE.DoubleSide;
            m.roughness = 0.9;
            m.envMapIntensity = 0.25;
          }
        }
      });
      this.root = root;
      model.add(root);
      root.visible = false;
      this.mixer = new THREE.AnimationMixer(root);
      this.actions = {};
      for (const c of gltf.animations) this.actions[c.name] = this.mixer.clipAction(c);
      this.play('idle', 0);
      this.ready = true;
    };
    const fail = (e) => console.error('person model failed to load', e);
    if (url.startsWith('data:')) loader.parse(bufferFromDataUrl(url), '', done, fail);
    else loader.load(url, done, undefined, fail);
  }

  play(name, fade = 0.35) {
    const a = this.actions[name];
    if (!a || this.current === a) return;
    a.reset().setEffectiveWeight(1).fadeIn(fade).play();
    if (this.current) this.current.fadeOut(fade);
    this.current = a;
  }

  // st: { mode, player (Player), playerMoving, running, thirdPerson, near (camera
  // distance to the ship) }
  update(dt, st) {
    if (!this.ready) return;
    const r = this.root;
    const walking = st.mode === 'walk' && st.thirdPerson;
    const atConn = st.mode === '3p';
    r.visible = walking || atConn;
    if (walking) {
      r.position.copy(st.player.pos);
      r.rotation.y = st.player.yaw + Math.PI;
      if (st.playerMoving) { this.idleT = 0; this.play(st.running ? 'run' : 'walk', 0.25); }
      else this.idle(dt);
    } else if (atConn) {
      r.position.set(...CONN.p);
      r.rotation.y = CONN.yaw;
      this.play('helm');
    }
    if (r.visible && st.near < 220) this.mixer.update(dt);
  }

  // standing: now and then he looks about him
  idle(dt) {
    this.idleT += dt;
    if (this.current === this.actions.look) {
      if (this.idleT > this.actions.look.getClip().duration - 0.4) { this.idleT = 0; this.play('idle', 0.5); }
    } else {
      this.play('idle', 0.3);
      if (this.idleT > 14) { this.idleT = 0; this.play('look', 0.5); }
    }
  }
}
