import * as THREE from 'three';
import META from '../assets/materials/materials.json';

// The ship's own materials (tools/make_materials.py): seamless PBR textures
// at about 2 mm a pixel, laid in metres along the grain of each part. Each
// is colour + normal + ORM (roughness in G, metalness in B, as glTF).

const urls = import.meta.glob('../assets/materials/*.webp', { eager: true, query: '?url', import: 'default' });
const url = (name, kind) => urls[`../assets/materials/${name}_${kind}.webp`];

const loader = new THREE.TextureLoader();
const cache = new Map();

function tex(name, kind, renderer) {
  const key = `${name}_${kind}`;
  if (cache.has(key)) return cache.get(key);
  const t = loader.load(url(name, kind));
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = kind === 'col' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 8;
  cache.set(key, t);
  return t;
}

// name: one of the materials; the UVs are in metres and the texture covers
// META[name].size metres, so its repeat is 1 / size.
export function shipMaterial(name, renderer, opts = {}) {
  const m = META[name];
  if (!m) throw new Error(`no material ${name}`);
  const map = tex(name, 'col', renderer), normalMap = tex(name, 'nrm', renderer), orm = tex(name, 'orm', renderer);
  for (const t of [map, normalMap, orm]) t.repeat.set(1 / m.size[0], 1 / m.size[1]);
  return new THREE.MeshStandardMaterial({
    name, map, normalMap, roughnessMap: orm, metalnessMap: orm,
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
