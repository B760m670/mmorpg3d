import * as THREE from 'three';

// The way about the ship, from the access data blender/build_galleon.py
// writes into galleon_rig.json (model coordinates, metres):
//   ladders  climbs that are not walked: up the shrouds to the tops
//   places   named spaces, for the hint at the bottom of the screen
//   helm     the whipstaff; spawn: where you come aboard; bounds
// Ladders between decks are ordinary stairs in the collision mesh and need
// nothing here.

const v3 = (a) => new THREE.Vector3(...a);
const _d = new THREE.Vector3();

export class Aboard {
  constructor(access) {
    this.data = access;
    // on the shrouds you face the way you climb: in toward the mast
    this.ladders = (access.ladders || []).map((l) => ({
      name: l.name, a: v3(l.a), b: v3(l.b), top: v3(l.top), bottom: v3(l.bottom), speed: l.speed,
      face: Math.atan2(-(l.b[0] - l.a[0]), -(l.b[2] - l.a[2])),
    }));
    this.places = (access.places || []).map((p) => ({ ...p, at: v3(p.at) }));
  }

  // A ladder whose foot or head you stand at: { ladder, fromTop }
  nearLadder(pos) {
    let best = null, bd = 1.3;
    for (const l of this.ladders) {
      for (const [p, fromTop] of [[l.bottom, false], [l.top, true]]) {
        _d.copy(pos).sub(p);
        if (Math.abs(_d.y) > 0.8) continue;
        const d = Math.hypot(_d.x, _d.z);
        if (d < bd) { bd = d; best = { ladder: l, fromTop }; }
      }
    }
    return best;
  }

  // The named space you are in (nearest centre within its radius, on its level).
  placeAt(pos) {
    let best = null, bd = Infinity;
    for (const p of this.places) {
      _d.copy(pos).sub(p.at);
      if (_d.y < -0.6 || _d.y > 1.6) continue;
      const d = Math.hypot(_d.x, _d.z) / p.r;
      if (d < 1 && d < bd) { bd = d; best = p; }
    }
    return best;
  }
}
