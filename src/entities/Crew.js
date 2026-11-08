import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

// The people aboard (model: blender/build_crew.py), in the ship's own frame
// so they ride her motion:
//   - the skipper at the controls in the wheelhouse, seen through the
//     windows when you are not at the helm yourself;
//   - a deckhand on the aft working deck, going between jobs: hauling on
//     gear at the gantry and the hatch, standing by aft;
//   - you: your own body when you walk about the ship with the camera
//     behind you (third person).
// Each is dressed differently (the model's materials are recoloured): the
// skipper in a navy sweater and work trousers, the deckhand in orange
// oilskins and rubber gloves, you in yellow oilskins.

function bufferFromDataUrl(url) {
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

const OUTFITS = {
  skipper: { oilskin: [0.05, 0.06, 0.1], knit: [0.09, 0.1, 0.12], cap: [0.12, 0.12, 0.13], beard: [0.2, 0.17, 0.14] },
  deckhand: { oilskin: [0.85, 0.24, 0.03], knit: [0.06, 0.08, 0.14], cap: [0.06, 0.09, 0.2], gloves: [0.85, 0.3, 0.04], beard: [0.3, 0.14, 0.05] },
  player: { oilskin: [0.85, 0.6, 0.04], knit: [0.2, 0.05, 0.05], cap: [0.45, 0.06, 0.05], gloves: [0.85, 0.6, 0.04] },
};

// the deckhand's round of the working deck (model space, feet)
const DECK = [
  { p: [-1.0, 4.3, 9.0], act: 'haul', t: 9 },
  { p: [-3.35, 4.3, 6.0], act: null },
  { p: [-3.35, 4.3, 3.0], act: null },
  { p: [-0.5, 4.3, 2.0], act: 'haul', t: 8 },
  { p: [-3.35, 4.3, 3.0], act: null },
  { p: [-3.35, 4.3, 6.0], act: null },
  { p: [-1.0, 4.3, 9.0], act: null },
  { p: [2.0, 4.3, 9.4], act: 'idle', t: 7 },
];

class Person {
  constructor(src, clips, outfit) {
    this.root = cloneSkinned(src);
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false;
      const m = o.material.clone();
      const c = OUTFITS[outfit][m.name];
      if (c) m.color.setRGB(...c);
      m.envMapIntensity = 0.5;
      o.material = m;
    });
    this.mixer = new THREE.AnimationMixer(this.root);
    this.actions = {};
    for (const c of clips) this.actions[c.name] = this.mixer.clipAction(c);
    this.current = null;
    this.play('idle', 0);
  }

  play(name, fade = 0.35) {
    const a = this.actions[name];
    if (!a || this.current === a) return;
    a.reset().setEffectiveWeight(1).fadeIn(fade).play();
    if (this.current) this.current.fadeOut(fade);
    this.current = a;
  }
}

export class Crew {
  constructor() {
    this.people = {};
    this.ready = false;
    this.deck = { i: 0, wait: 3 };
  }

  load(url, model) {
    const loader = new GLTFLoader();
    const done = (gltf) => {
      const src = gltf.scene;
      for (const id of ['skipper', 'deckhand', 'player']) {
        const p = new Person(src, gltf.animations, id);
        this.people[id] = p;
        model.add(p.root);
      }
      const sk = this.people.skipper;
      sk.root.position.set(0, 5.4, -4.75);
      sk.root.rotation.y = Math.PI;              // facing the bow
      sk.play('helm', 0);
      sk.mixer.update(Math.random() * 3);
      const dh = this.people.deckhand;
      dh.root.position.set(...DECK[0].p);
      this.people.player.root.visible = false;
      this.ready = true;
    };
    const fail = (e) => console.error('crew model failed to load', e);
    if (url.startsWith('data:')) loader.parse(bufferFromDataUrl(url), '', done, fail);
    else loader.load(url, done, undefined, fail);
  }

  // st: { mode, player (Player), playerMoving, running, thirdPerson, near (camera
  // distance to the ship) }
  update(dt, st) {
    if (!this.ready) return;
    const { skipper, deckhand, player } = this.people;
    // the skipper: at the controls unless you have taken the helm
    skipper.root.visible = st.mode !== 'helm';
    // the deckhand: at the stern while the gear or the anchor is worked,
    // otherwise his round of the deck
    const d = this.deck;
    if (st.deckWork) {
      deckhand.root.position.set(-1.2, 4.3, 9.4);
      deckhand.root.rotation.y = 0;                 // facing aft, over the stern
      deckhand.play('haul');
      d.i = 0; d.wait = 2;
    } else {
    const wp = DECK[d.i];
    const pos = deckhand.root.position;
    if (d.wait > 0) {
      d.wait -= dt;
      deckhand.play(wp.act || 'idle');
      if (wp.act === 'haul') deckhand.root.rotation.y = wp.p[2] > 5 ? 0 : Math.PI;   // facing the gantry / the hatch
      if (d.wait <= 0) d.i = (d.i + 1) % DECK.length;
    } else {
      const tgt = DECK[d.i].p;
      const dx = tgt[0] - pos.x, dz = tgt[2] - pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.08) {
        if (DECK[d.i].t) d.wait = DECK[d.i].t;
        else d.i = (d.i + 1) % DECK.length;
      } else {
        const step = Math.min(dist, 1.25 * dt);
        pos.x += (dx / dist) * step;
        pos.z += (dz / dist) * step;
        const want = Math.atan2(dx, dz);         // the model faces +Z
        let dr = want - deckhand.root.rotation.y;
        dr = Math.atan2(Math.sin(dr), Math.cos(dr));
        deckhand.root.rotation.y += dr * Math.min(1, dt * 6);
        deckhand.play('walk');
      }
    }
    }
    // you
    const me = player;
    const show = st.mode === 'walk' && st.thirdPerson;
    me.root.visible = show;
    if (show) {
      me.root.position.copy(st.player.pos);
      me.root.rotation.y = st.player.yaw + Math.PI;
      me.play(st.playerMoving ? (st.running ? 'run' : 'walk') : 'idle', 0.25);
    }
    // animate only who can be seen from here
    const far = st.near > 220;
    for (const p of [skipper, deckhand, me]) if (p.root.visible && !far) p.mixer.update(dt);
  }
}
