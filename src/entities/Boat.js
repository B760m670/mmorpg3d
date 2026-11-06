import * as THREE from 'three';
import { BOAT } from '../config.js';
import { sampleWater } from '../world/waves.js';

// Placeholder trawler built from primitives — a stand-in silhouette so the
// systems around it (buoyancy, steering, camera) are real now. This mesh is
// the one thing we will swap for a Blender-authored glTF later; everything
// else (physics, controls) stays.
export class Boat {
  constructor() {
    this.group = new THREE.Group();

    const hullMat = new THREE.MeshStandardMaterial({ color: 0x3b4650, roughness: 0.7, metalness: 0.2 });
    const cabinMat = new THREE.MeshStandardMaterial({ color: 0x8a9298, roughness: 0.6, metalness: 0.1 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x20262b, roughness: 0.8, metalness: 0.3 });
    const rustMat = new THREE.MeshStandardMaterial({ color: 0x6e4a3a, roughness: 0.85, metalness: 0.2 });

    // Hull — a tapered box (sharper at the bow, -Z forward).
    const hullGeo = new THREE.BoxGeometry(5, 2.4, 14);
    const pos = hullGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const z = pos.getZ(i);
      if (z < 0) {
        // taper the bow
        const t = Math.min(1, -z / 7);
        pos.setX(i, pos.getX(i) * (1 - 0.7 * t));
      }
      if (pos.getY(i) < 0) pos.setX(i, pos.getX(i) * 0.75); // narrower keel
    }
    hullGeo.computeVertexNormals();
    const hull = new THREE.Mesh(hullGeo, rustMat);
    hull.position.y = 0.4;
    this.group.add(hull);

    // Deck
    const deck = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.3, 13.2), hullMat);
    deck.position.y = 1.6;
    this.group.add(deck);

    // Cabin / wheelhouse (toward the stern, +Z)
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2.4, 4), cabinMat);
    cabin.position.set(0, 3, 3);
    this.group.add(cabin);

    const cabinTop = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.4, 2.6), cabinMat);
    cabinTop.position.set(0, 4.6, 3.2);
    this.group.add(cabinTop);

    // Mast + crane boom near the bow
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 6, 8), darkMat);
    mast.position.set(0, 5, -1.5);
    this.group.add(mast);

    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 6, 8), darkMat);
    boom.rotation.x = Math.PI / 2.6;
    boom.position.set(0, 3.5, -3.5);
    this.group.add(boom);

    // Running lights (emissive dots)
    const lightGeo = new THREE.SphereGeometry(0.18, 10, 10);
    const red = new THREE.Mesh(lightGeo, new THREE.MeshBasicMaterial({ color: 0xff3322 }));
    red.position.set(-1.8, 2.2, 1);
    const green = new THREE.Mesh(lightGeo, new THREE.MeshBasicMaterial({ color: 0x22ff44 }));
    green.position.set(1.8, 2.2, 1);
    this.group.add(red, green);

    // State
    this.position = new THREE.Vector3(0, 0, 0);
    this.heading = 0;        // yaw, radians
    this.speed = 0;          // forward speed
    this._up = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
  }

  get object() {
    return this.group;
  }

  // canMove(x, z) -> boolean: optional world query for deep-enough water.
  update(dt, input, time, canMove = null) {
    // Throttle & steering
    this.speed += input.throttle * BOAT.acceleration * dt;
    this.speed *= Math.pow(BOAT.drag, dt * 60); // frame-rate-independent drag
    this.speed = THREE.MathUtils.clamp(this.speed, -BOAT.maxSpeed * 0.5, BOAT.maxSpeed);
    if (Math.abs(this.speed) < 0.02) this.speed = 0;

    // Rudder only bites when moving
    const steerAuthority = THREE.MathUtils.clamp(Math.abs(this.speed) / 6, 0, 1);
    this.heading += input.steer * BOAT.turnRate * dt * steerAuthority * Math.sign(this.speed || 1);

    // Forward vector (-Z is the bow)
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    const nx = this.position.x - fx * this.speed * dt;
    const nz = this.position.z - fz * this.speed * dt;
    // Probe a bit ahead of the bow (or stern when reversing) so the hull
    // stops before it visibly enters the rock.
    const probe = Math.sign(this.speed) * 8;
    if (!canMove || canMove(nx - fx * probe, nz - fz * probe)) {
      this.position.x = nx;
      this.position.z = nz;
    } else {
      this.speed *= -0.25; // bump off the shore
    }

    // Buoyancy: sample the surface at the hull center plus fore/aft/side
    // points to derive the up vector (pitch + roll).
    const s = BOAT.buoyancySamples;
    const c = sampleWater(this.position.x, this.position.z, time);
    const fore = sampleWater(this.position.x - fx * s, this.position.z - fz * s, time);
    const aft = sampleWater(this.position.x + fx * s, this.position.z + fz * s, time);
    const side = sampleWater(this.position.x + fz * s, this.position.z - fx * s, time);

    this.position.y = c.height;

    // Build an up vector from the local slope (average of sampled normals,
    // weighted toward the center).
    this._up.set(
      c.normal.x + 0.5 * (fore.normal.x + aft.normal.x + side.normal.x),
      c.normal.y + 0.5 * (fore.normal.y + aft.normal.y + side.normal.y),
      c.normal.z + 0.5 * (fore.normal.z + aft.normal.z + side.normal.z),
    ).normalize();

    // Orient: yaw to heading, then tilt the up axis toward the wave normal.
    const forward = new THREE.Vector3(-fx, 0, -fz);
    const right = new THREE.Vector3().crossVectors(forward, this._up).normalize();
    const fwdOnPlane = new THREE.Vector3().crossVectors(this._up, right).normalize();
    this._m.makeBasis(right, this._up, fwdOnPlane.multiplyScalar(-1));
    this._q.setFromRotationMatrix(this._m);

    this.group.position.copy(this.position);
    this.group.quaternion.slerp(this._q, 1 - Math.pow(0.001, dt));
  }
}
