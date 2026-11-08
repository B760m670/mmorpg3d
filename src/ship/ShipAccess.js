import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Getting about the ship, and knowing what everything is.
//
// 1. Walkable places the model draws but the collision mesh did not have:
//    the wheelhouse roof (the "monkey island"), the two radar platforms on
//    the mast and the walkway on top of the gantry, each with its guard rails
//    and the things that stand on it. Added to the ship's collider here.
// 2. The ladders up to them, climbed with E (or the action button).
// 3. Places: what each piece of equipment or space is for, shown as you come
//    near and look at it. The same list is what a person aboard will later
//    know of his ship.
//
// Coordinates: the build script's stations s (m from the transom), x to
// starboard, z up; in the model (three.js) z runs aft: z = 11.975 - s.

const Z = (s) => 11.975 - s;
export const P = (x, s, h) => new THREE.Vector3(x, h, Z(s));

// box from x0..x1, s0..s1, y0..y1 (model y is height)
function box(x0, x1, s0, s1, y0, y1) {
  const g = new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(s1 - s0));
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, Z((s0 + s1) / 2));
  return g;
}
// a rail run: a 1 m wall along one edge, with gaps [[a0, a1], ...] along it
function rail(axis, fixed, a0, a1, y, gaps = []) {
  const out = [];
  let from = a0;
  for (const [g0, g1] of [...gaps, [a1, a1]]) {
    if (g0 - from > 0.02) out.push(axis === 'x' ? box(from, g0, fixed - 0.04, fixed + 0.04, y, y + 1.05) : box(fixed - 0.04, fixed + 0.04, from, g0, y, y + 1.05));
    from = g1;
  }
  return out;
}

const ROOF = 7.87, PLAT1 = 9.02, PLAT2 = 10.42, GANTRY = 9.31;

function accessGeometry() {
  const g = [];
  // wheelhouse roof: deck, rails (gap aft at the ladder), what stands on it
  g.push(box(-3.5, 3.5, 12.05, 19.05, ROOF - 0.06, ROOF));
  g.push(...rail('s', -3.5, 12.05, 19.05, ROOF), ...rail('s', 3.5, 12.05, 19.05, ROOF, [[12.1, 12.7]]));
  g.push(...rail('x', 12.05, -3.5, 3.5, ROOF), ...rail('x', 19.05, -3.5, 3.5, ROOF));
  g.push(box(-2.15, -1.05, 12.45, 13.55, ROOF, ROOF + 1.1));          // satellite dome
  g.push(box(2.25, 2.95, 12.45, 13.55, ROOF, ROOF + 0.8), box(-2.95, -2.25, 12.45, 13.55, ROOF, ROOF + 0.8));   // liferafts
  g.push(box(0.98, 1.62, 12.58, 13.22, ROOF, ROOF + 1.4));            // funnel
  for (const [x, s] of [[-0.55, 13.3], [0.55, 13.3], [-0.55, 14.9], [0.55, 14.9]]) g.push(box(x - 0.1, x + 0.1, s - 0.1, s + 0.1, ROOF, ROOF + 1.1));
  g.push(box(1.58, 2.22, 17.08, 17.72, ROOF, ROOF + 0.7));            // TV dome
  g.push(box(0.8, 1.2, 17.75, 18.4, ROOF, ROOF + 0.9));               // searchlight
  // radar platform 1 (its underside too, so you cannot walk under it)
  g.push(box(-0.95, 0.95, 13.4, 16.1, PLAT1 - 0.42, PLAT1));
  g.push(...rail('s', -0.95, 13.4, 16.1, PLAT1), ...rail('s', 0.95, 13.4, 16.1, PLAT1));
  g.push(...rail('x', 13.4, -0.95, 0.95, PLAT1), ...rail('x', 16.1, -0.95, 0.95, PLAT1));
  g.push(box(-0.25, 0.25, 15.45, 15.95, PLAT1, PLAT1 + 0.9));         // scanner pedestal
  // radar platform 2
  g.push(box(-0.8, 0.8, 13.6, 15.7, PLAT2 - 0.52, PLAT2));
  g.push(...rail('s', -0.8, 13.6, 15.7, PLAT2), ...rail('s', 0.8, 13.6, 15.7, PLAT2));
  g.push(...rail('x', 13.6, -0.8, 0.8, PLAT2, [[-0.32, 0.32]]), ...rail('x', 15.7, -0.8, 0.8, PLAT2));
  g.push(box(-0.25, 0.25, 15.05, 15.55, PLAT2, PLAT2 + 0.9));
  // gantry walkway: rails both sides, a gap forward at the ladder
  g.push(box(-3.85, 3.85, 2.2, 3.05, GANTRY - 0.3, GANTRY));
  g.push(...rail('x', 2.2, -3.9, 3.9, GANTRY), ...rail('x', 3.05, -3.9, 3.9, GANTRY, [[2.9, 3.6]]));
  g.push(...rail('s', -3.9, 2.2, 3.05, GANTRY), ...rail('s', 3.9, 2.2, 3.05, GANTRY));
  return g;
}

// ladders: the climbing line (feet), where you step off at the top and the
// bottom, and which way you face on it
export const LADDERS = [
  // up the starboard side of the wheelhouse from the side deck, outside the roof fascia
  { id: 'wh_roof', name: 'трап на крышу рубки', a: P(3.95, 12.45, 5.25), b: P(3.95, 12.45, ROOF + 0.08), top: P(3.12, 12.35, ROOF), bottom: P(4.0, 12.45, 5.25), face: Math.PI / 2, mesh: true },
  // up the mast, past the lower radar platform (it lies under the upper one) to the upper
  { id: 'mast', name: 'трап на площадку радара', a: P(0, 12.9, ROOF), b: P(0, 12.9, PLAT2 + 0.08), top: P(0, 13.85, PLAT2), bottom: P(0, 12.6, ROOF), face: 0, mesh: true },
  // up the starboard gantry leg, facing aft
  { id: 'gantry', name: 'трап на портал', a: P(3.15, 5.3, 4.3), b: P(3.15, 3.05, GANTRY + 0.05), top: P(3.0, 2.62, GANTRY), bottom: P(3.0, 5.55, 4.3), face: Math.PI },
];

// what everything is (station, x, height of its middle; r: how near)
export const PLACES = [
  // working deck and gear
  { id: 'gantry', name: 'Портал (А-рама)', p: P(0, 2.62, 8.4), r: 4.2, text: 'через блоки на нём идут ваера трала; на нём прожекторы рабочей палубы. Наверх — трап на правой ноге.' },
  { id: 'doors', name: 'Траловые доски', p: P(4.7, 2.4, 5.35), r: 1.8, text: 'по тонне каждая: на ходу расходятся в стороны и раскрывают трал.' },
  { id: 'drums', name: 'Сетевые барабаны', p: P(0, 6.22, 5.45), r: 3.6, text: 'на них наматывается трал с поплавками; работают от гидравлики (пульт → «Трал»).' },
  { id: 'winches', name: 'Траловые лебёдки', p: P(0, 9.1, 4.9), r: 3.2, text: 'травят и выбирают ваера; во время лова стоят на тормозах.' },
  { id: 'crane', name: 'Кран-манипулятор', p: P(-2.9, 7.85, 6.0), r: 2.2, text: 'гидравлический: поднимает тралмешок, ящики, грузы на причале.' },
  { id: 'hatch', name: 'Люк приёмного бункера', p: P(0.6, 8.15, 4.35), r: 1.6, text: 'сюда вываливают улов из тралмешка; под ним бункер и конвейер рыбцеха.' },
  { id: 'comp', name: 'Сходной тамбур', p: P(3.1, 2.4, 4.9), r: 1.8, text: 'трап вниз: кормовая кладовая, рулевое отделение, машинное, рыбцех.' },
  { id: 'stair', name: 'Трап на верхнюю палубу', p: P(3.85, 11.3, 4.9), r: 1.6, text: 'наверх к рубке и на бак.' },
  { id: 'fishboxes', name: 'Рыбные ящики', p: P(2.4, 10.25, 4.9), r: 1.4, text: 'пустая тара: в рыбцехе в них укладывают рыбу со льдом.' },
  // foredeck
  { id: 'windlass', name: 'Брашпиль', p: P(0, 21.0, 6.0), r: 2.0, text: 'якорная лебёдка на гидравлике (пульт → «Якорь»).' },
  { id: 'scuttle', name: 'Лаз в форпик', p: P(0, 19.0, 5.75), r: 1.3, text: 'вниз, в носовую кладовую и якорный ящик.' },
  // wheelhouse roof and mast
  { id: 'liferaft', name: 'Спасательные плоты', p: P(2.6, 13.0, 8.3), r: 1.5, text: 'надувные, в контейнерах; если судно тонет, гидростат сам отдаёт их на глубине 2–4 м.' },
  { id: 'liferaft_p', name: 'Спасательные плоты', p: P(-2.6, 13.0, 8.3), r: 1.5, text: 'надувные, в контейнерах; если судно тонет, гидростат сам отдаёт их на глубине 2–4 м.' },
  { id: 'vsat', name: 'Купол спутниковой связи', p: P(-1.6, 13.0, 8.45), r: 1.6, text: 'антенна спутникового интернета и телефона под колпаком.' },
  { id: 'tvdome', name: 'Антенна спутникового ТВ', p: P(1.9, 17.4, 8.2), r: 1.2, text: 'следит за спутником при любой качке.' },
  { id: 'funnel', name: 'Выхлопная труба', p: P(1.3, 12.9, 8.6), r: 1.4, text: 'выхлоп главного двигателя и генераторов.' },
  { id: 'searchlight', name: 'Поисковый прожектор', p: P(1.0, 18.05, 8.5), r: 1.4, text: '1 кВт, поворачивается с пульта (пульт → «Свет»).' },
  { id: 'horn', name: 'Тифон', p: P(-0.8, 15.85, 8.15), r: 1.3, text: 'воздушный, ~290 Гц, от ресивера машинного отделения (H — гудок).' },
  { id: 'radar', name: 'Радары', p: P(0, 15.3, 9.7), r: 2.2, text: 'два, 3-сантиметровых: берег, суда и буи до 24 миль (пульт → «Приборы»). Нижняя площадка — только для обслуживания, к верхней ведёт трап по мачте.' },
  { id: 'mast', name: 'Мачта', p: P(0, 14.1, 11.6), r: 3.0, text: 'топовый огонь, огни лова и якорные, антенны УКВ и GPS.' },
  // below: steering flat, engine room
  { id: 'steering', name: 'Рулевая машина', p: P(0, 1.4, 0.65), r: 2.0, text: 'баллер руля, румпель и два гидроцилиндра; насосы включаются на ГРЩ.' },
  { id: 'emtiller', name: 'Аварийный румпель', p: P(-3.2, 1.8, 1.3), r: 1.2, text: 'если отказали оба насоса, руль перекладывают вручную.' },
  { id: 'ppack', name: 'Насосная станция руля', p: P(2.35, 2.35, 0.4), r: 1.2, text: 'два насоса: один основной, второй в резерве.' },
  { id: 'engine', name: 'Главный двигатель', p: P(0, 6.0, -0.3), r: 3.0, text: 'шестицилиндровый дизель, ~1100 кВт; пуск и стоп с пульта (пульт → «Энергия»).' },
  { id: 'gensets', name: 'Дизель-генераторы', p: P(2.7, 6.0, -0.8), r: 2.2, text: 'два по 64 кВт; ими управляют на ГРЩ.' },
  { id: 'msb', name: 'Главный распределительный щит', p: P(-1.9, 9.15, -0.4), r: 1.6, text: 'генераторы, береговое питание, автоматы всех потребителей (P).' },
  { id: 'daytank', name: 'Расходная топливная цистерна', p: P(3.0, 8.85, -0.4), r: 1.2, text: 'суточный запас для двигателей; уровень — в смотровом стекле.' },
  { id: 'bench', name: 'Верстак', p: P(-3.1, 7.7, -0.5), r: 1.2, text: 'тиски и инструмент механика.' },
  // 'tween deck
  { id: 'aftstore', name: 'Кормовая кладовая', p: P(1.5, 3.0, 3.0), r: 2.2, text: 'запасной трал, поплавки, швартовы; люки вниз — в рулевое и в машинное.' },
  { id: 'factory', name: 'Рыбцех', p: P(1.6, 6.5, 3.0), r: 2.6, text: 'улов идёт из бункера по конвейеру; здесь потрошат и моют рыбу.' },
  { id: 'washer', name: 'Моечная машина', p: P(2.05, 9.0, 3.3), r: 1.4, text: 'отмывает рыбу забортной водой; из неё — лоток в трюм.' },
  { id: 'icemaker', name: 'Льдогенератор', p: P(-3.4, 10.4, 2.95), r: 1.4, text: 'делает чешуйчатый лёд; он сыплется в ледник трюма.' },
  { id: 'lockers', name: 'Раздевалка', p: P(-2.9, 12.0, 3.1), r: 1.7, text: 'шкафчики, роба и сапоги — с палубы заходят сюда.' },
  { id: 'washroom', name: 'Санузел', p: P(2.6, 12.1, 3.1), r: 1.5, text: 'душ, туалет, умывальник.' },
  { id: 'galley', name: 'Камбуз', p: P(2.6, 14.6, 3.1), r: 1.8, text: 'плита с бортиками от качки, духовка, холодильник.' },
  { id: 'mess', name: 'Столовая', p: P(-1.2, 15.1, 3.0), r: 1.8, text: 'стол, диван, телевизор.' },
  { id: 'cabin1', name: 'Каюта', p: P(1.6, 17.5, 3.0), r: 1.3, text: 'двухъярусные койки, шкафчик.' },
  { id: 'cabin2', name: 'Каюта', p: P(-1.6, 17.5, 3.0), r: 1.3, text: 'двухъярусные койки, шкафчик.' },
  { id: 'cabin3', name: 'Каюта', p: P(1.6, 19.4, 3.0), r: 1.3, text: 'двухъярусные койки, шкафчик.' },
  { id: 'cabin4', name: 'Каюта', p: P(-1.6, 19.4, 3.0), r: 1.3, text: 'двухъярусные койки, шкафчик.' },
  { id: 'whstair', name: 'Трап в рубку', p: P(-2.7, 15.0, 3.2), r: 1.2, text: 'наверх, на мостик.' },
  // fishroom
  { id: 'hold', name: 'Рыбный трюм', p: P(0, 13.0, -0.5), r: 4.0, text: '~160 м³, −1…−2 °C; рыба в ящиках со льдом, в загонах.' },
  { id: 'icelocker', name: 'Ледник', p: P(-2.8, 10.8, -0.5), r: 1.5, text: 'запас льда из льдогенератора.' },
];

export class ShipAccess {
  constructor() {
    this.ladders = LADDERS;
    this.places = PLACES;
    this.meshes = [];
  }

  // add the walkable places to the ship's collision mesh
  extendCollider(boat) {
    const c = boat.collider;
    if (!c || c.userData.access) return;
    const base = c.geometry.index ? c.geometry.toNonIndexed() : c.geometry.clone();
    for (const k of Object.keys(base.attributes)) if (k !== 'position') base.deleteAttribute(k);
    const parts = accessGeometry().map((g) => {
      const n = g.toNonIndexed();
      for (const k of Object.keys(n.attributes)) if (k !== 'position') n.deleteAttribute(k);
      return n;
    });
    const merged = mergeGeometries([base, ...parts], false);
    c.geometry = merged;
    c.geometry.computeBoundingSphere();
    c.geometry.computeBoundingBox();
    c.userData.access = true;
    // visible ladders where the model has none (up the mast to the radars)
    const mat = new THREE.MeshStandardMaterial({ color: 0xe8e8e2, roughness: 0.5, metalness: 0.3 });
    for (const l of this.ladders.filter((q) => q.mesh)) boat.model.add(this.ladderMesh(l, mat));
  }

  ladderMesh(l, mat) {
    const g = new THREE.Group();
    const fwd = new THREE.Vector3(-Math.sin(l.face), 0, -Math.cos(l.face));   // toward the ladder from the climber
    const base = l.a.clone().addScaledVector(fwd, 0.28);
    const top = l.b.clone().addScaledVector(fwd, 0.28);
    top.y += 1.0;
    const len = top.distanceTo(base);
    const side = new THREE.Vector3(Math.cos(l.face), 0, -Math.sin(l.face));
    const railG = new THREE.CylinderGeometry(0.02, 0.02, len, 6);
    for (const s of [-0.2, 0.2]) {
      const m = new THREE.Mesh(railG, mat);
      m.position.copy(base).lerp(top, 0.5).addScaledVector(side, s);
      g.add(m);
    }
    const rungG = new THREE.CylinderGeometry(0.014, 0.014, 0.4, 5);
    rungG.rotateZ(Math.PI / 2);
    for (let y = 0.3; y < len - 0.6; y += 0.3) {
      const m = new THREE.Mesh(rungG, mat);
      m.position.copy(base).lerp(top, y / len);
      m.rotation.y = l.face;
      g.add(m);
    }
    return g;
  }

  // the ladder you could get on from where you stand: { ladder, fromTop }
  nearLadder(pos) {
    for (const l of this.ladders) {
      for (const [pt, fromTop] of [[l.bottom, false], [l.top, true]]) {
        if (Math.hypot(pos.x - pt.x, pos.z - pt.z) < 0.75 && Math.abs(pos.y - pt.y) < 0.6) return { ladder: l, fromTop };
      }
    }
    return null;
  }

  // what you are near and looking at
  placeAt(pos, yaw) {
    let best = null, bd = Infinity;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    for (const pl of this.places) {
      const dx = pl.p.x - pos.x, dy = pl.p.y - (pos.y + 1.2), dz = pl.p.z - pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > pl.r + 0.6) continue;
      const h = Math.hypot(dx, dz);
      const facing = h < 0.8 ? 1 : (dx * fx + dz * fz) / h;
      if (facing < 0.35) continue;
      const score = d / pl.r - facing * 0.3;
      if (score < bd) { bd = score; best = pl; }
    }
    return best;
  }
}
