import * as THREE from 'three';
import { heightAt } from '../world/Terrain.js';
import { PLAYER } from '../config.js';

// A scuba diver: over the side from the trawler, swimming at the surface and
// diving with a 12 litre, 200 bar cylinder of air, in a drysuit (the water is
// about 7 deg C in November).
//
// What a dive computer would tell you is worked out as in reality:
//   - air: surface consumption about 18 l/min at rest, more when finning,
//     multiplied by the ambient pressure (1 bar more every 10 m), so the
//     same cylinder lasts half as long at 10 m and a third as long at 20 m;
//   - ascent rate: no faster than 10 m/min;
//   - a safety stop: 3 minutes at 3-6 m after any dive deeper than 10 m;
//   - the limits of air as a breathing gas: 40 m for sport diving, oxygen
//     partial pressure 1.4 bar at 57 m.
// Swimming: you go where you look (fins), the vest keeps you neutral under
// water and afloat at the surface. The bottom and the shore stop you; so
// does the ship's hull.

const TANK_L = 12;
const FULL_BAR = 200;
const SAC = 18;              // l/min at the surface, at rest
const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _want = new THREE.Vector3();
const _loc = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');

export class Diver {
  constructor(camera) {
    this.camera = camera;
    this.pos = new THREE.Vector3();        // eye, world
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.air = FULL_BAR;
    this.depth = 0;
    this.maxDepth = 0;
    this.diveTime = 0;
    this.rate = 0;            // m/min, positive going up
    this.stop = 0;            // s spent on the safety stop
    this.breathT = 0;
    this.inhaling = false;
    this.surface = 0;         // water height over the diver
    this.atSurface = true;
    this.onBreath = null;     // (out: bool) => {}
    this.fin = 0;             // finning effort 0..1, for the breathing rate
  }

  enter(pos, yaw) {
    this.pos.copy(pos);
    this.vel.set(0, -0.6, 0);          // the splash: under for a moment
    this.inflated = true;
    this.yaw = yaw;
    this.pitch = -0.1;
    this.air = Math.max(this.air, FULL_BAR - 2);
    this.maxDepth = 0;
    this.diveTime = 0;
    this.stop = 0;
  }

  look(dx, dy) {
    this.yaw -= dx * PLAYER.lookSensitivity;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * PLAYER.lookSensitivity, -1.45, 1.45);
  }

  // input: moveX/moveY -1..1, up/down booleans, fast boolean
  // world: { water(x, z) -> surface height, boat (Boat) }
  update(dt, input, world) {
    const p = this.pos;
    const ws = world.water(p.x, p.z);
    this.surface = ws;
    // The vest: inflated at the surface (head out, eyes half a metre above
    // the water, so the waves around do not wash over the view); let out to
    // go down when you kick down or swim on looking down; filled again when
    // you come back up to the surface.
    if (this.inflated && (input.down || (input.moveY > 0.3 && this.pitch < -0.35))) this.inflated = false;
    else if (!this.inflated && p.y > ws - 0.5 && this.vel.y >= 0 && !input.down) this.inflated = true;
    const floating = this.inflated;

    // where the fins push: along the view, sideways, and up/down kicks
    _f.set(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    _r.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const speed = input.fast ? 1.4 : 0.85;
    _want.copy(_f).multiplyScalar(input.moveY * speed).addScaledVector(_r, input.moveX * speed * 0.7);
    _want.y += ((input.up ? 1 : 0) - (input.down ? 1 : 0)) * 0.7;
    // at the surface, swimming level stays at the surface; looking down
    // (or kicking down) takes you under
    if (floating && _want.y > -0.25 && !input.down) _want.y = Math.max(0, _want.y);
    if (this.air <= 0 && depth > 0.4) _want.set(0, 1.0, 0);    // out of air: straight up
    this.fin = Math.min(1, _want.length() / speed);
    // water is heavy: speed builds up and dies away over a second or so
    this.vel.lerp(_want, 1 - Math.exp(-dt * 1.3));

    const nx = p.x + this.vel.x * dt, nz = p.z + this.vel.z * dt;
    let ny = p.y + this.vel.y * dt;
    // the shore: no walking out of the water
    const ground = heightAt(nx, nz);
    if (ground > world.water(nx, nz) - 0.4) {
      this.vel.x = 0; this.vel.z = 0;
    } else {
      p.x = nx; p.z = nz;
    }
    // afloat: the inflated vest holds the head out, rising and falling with
    // the waves; never out of the water
    const wsNow = world.water(p.x, p.z);
    if (floating) {
      ny += (wsNow + 0.45 - ny) * Math.min(1, dt * 2.5);
      this.vel.y *= 0.9;
    }
    ny = Math.min(ny, wsNow + 0.5);
    // the bottom
    const floor = heightAt(p.x, p.z) + 0.45;
    if (ny < floor) { ny = floor; if (this.vel.y < 0) this.vel.y = 0; }
    p.y = ny;

    if (world.boat && world.boat.model) this._keepOutOfHull(world.boat.model);

    // dive computer
    const d = Math.max(0, wsNow - p.y);
    const r = (this.depth - d) / Math.max(dt, 1e-3) * 60;     // m/min, + up
    this.rate += (r - this.rate) * Math.min(1, dt * 0.8);
    this.depth = d;
    this.atSurface = p.y > wsNow - 0.35;
    if (d > 1.2) this.diveTime += dt;
    this.maxDepth = Math.max(this.maxDepth, d);
    if (this.maxDepth > 10 && d > 3 && d < 6.5) this.stop += dt;

    // breathing from the regulator (under water) or the air (head out)
    const breathing = !this.atSurface || d > 0.2;
    if (breathing && this.air > 0) {
      const lpm = SAC * (1 + 0.8 * this.fin) * (1 + d / 10);
      this.air = Math.max(0, this.air - lpm / TANK_L / 60 * dt);
    }
    const period = 4.6 - 1.6 * this.fin;
    this.breathT += dt / period;
    if (this.breathT >= 1) this.breathT -= 1;
    const inh = this.breathT < 0.4;
    if (inh !== this.inhaling) {
      this.inhaling = inh;
      if (this.onBreath && breathing && this.air > 0) this.onBreath(!inh);
    }
  }

  // The hull, in the ship's own frame: a box with a fine bow.
  _keepOutOfHull(model) {
    _loc.copy(this.pos);
    model.worldToLocal(_loc);
    const z = _loc.z;
    if (z < -12.4 || z > 12.4 || _loc.y < -4.6 || _loc.y > 9) return;
    const t = Math.min(1, Math.max(0, (-z - 3) / 9.4));
    const hb = 4.75 * Math.sqrt(1 - 0.94 * t * t) + 0.35;
    if (Math.abs(_loc.x) >= hb) return;
    // out the nearer way: sideways, or down under the keel
    if (_loc.y + 4.6 < hb - Math.abs(_loc.x)) _loc.y = -4.6;
    else _loc.x = Math.sign(_loc.x || 1) * hb;
    model.localToWorld(_loc);
    this.pos.copy(_loc);
  }

  // Close enough to the ship to climb the ladder aboard?
  nearShip(model) {
    if (!model || !this.atSurface) return false;
    _loc.copy(this.pos);
    model.worldToLocal(_loc);
    return Math.abs(_loc.z) < 12 && Math.abs(_loc.x) < 7.2;
  }

  updateCamera() {
    this.camera.position.copy(this.pos);
    _e.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.quaternion.copy(_q.setFromEuler(_e));
  }

  get airBar() { return this.air; }
  get ppO2() { return 0.21 * (1 + this.depth / 10); }
}

export const DIVE = { TANK_L, FULL_BAR, SAC };
