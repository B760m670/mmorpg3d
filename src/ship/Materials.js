import * as THREE from 'three';
import DATA from './scans.json';

// The ship's materials: real, photo-scanned textures (Poly Haven and
// ambientCG, CC0; tools/pack_scans.py), laid in metres along the grain of
// each part. Each is colour + normal + ORM (occlusion R, roughness G,
// metalness B, as glTF). They are separate files next to the page (public/
// materials), loaded when the ship is built.

const META = DATA.materials;
const BASE = `${import.meta.env.BASE_URL}materials/`;
const loader = new THREE.TextureLoader();
const cache = new Map();

function tex(name, kind, renderer) {
  const key = `${name}_${kind}`;
  if (cache.has(key)) return cache.get(key);
  const t = loader.load(`${BASE}${name}_${kind}.webp`);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = kind === 'col' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 8;
  const m = META[name];
  t.repeat.set(1 / m.size[0], 1 / m.size[1]);      // UVs are in metres
  cache.set(key, t);
  return t;
}

export function shipMaterial(name, renderer, opts = {}) {
  const m = META[name];
  if (!m) throw new Error(`no material ${name}`);
  const map = tex(name, 'col', renderer), normalMap = tex(name, 'nrm', renderer), orm = tex(name, 'orm', renderer);
  return new THREE.MeshStandardMaterial({
    name, map, normalMap, roughnessMap: orm, metalnessMap: orm, aoMap: opts.ao === false ? null : orm,     // the scan's own crevices
    roughness: 1, metalness: 1, envMapIntensity: opts.env ?? 0.7,
    normalScale: new THREE.Vector2(opts.normal ?? 1, opts.normal ?? 1),
    color: opts.tint ? new THREE.Color(...opts.tint) : 0xffffff,
  });
}

// Metric UVs for a mesh, the grain (u) along `axis` ('x' | 'y' | 'z') of
// the geometry; faces across the grain show end grain (u, v across).
export function metricUV(geo, axis = 'x') {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const p = g.attributes.position, n = g.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  const A = { x: 0, y: 1, z: 2 }[axis];
  const others = [0, 1, 2].filter((i) => i !== A);
  for (let i = 0; i < p.count; i++) {
    const c = [p.getX(i), p.getY(i), p.getZ(i)];
    const nn = [Math.abs(n.getX(i)), Math.abs(n.getY(i)), Math.abs(n.getZ(i))];
    const ax = nn.indexOf(Math.max(...nn));
    let u, v;
    if (ax === A) { u = c[others[0]]; v = c[others[1]]; }       // end grain
    else { u = c[A]; v = c[[0, 1, 2].find((k) => k !== A && k !== ax)]; }
    uv[i * 2] = u; uv[i * 2 + 1] = v;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

export const MATERIALS = META;
export const CREDITS = DATA.credits;
