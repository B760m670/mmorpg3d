# Open World — Ocean

Atmospheric open-world ocean prototype in the browser, built with **three.js**.
Inspired by the filmic "boat sailing through a fjord" look: a spectral (FFT)
ocean, hazy distance fog, a chase camera and a drivable trawler, all graded
with ACES tone mapping and bloom. The land and the sea floor are real: the
Reine area of Lofoten, Norway, from open elevation and bathymetry data.

This is **Phase 1**: a correct, extensible skeleton. The visuals are deliberately
achieved with cheap shader tricks so the architecture (systems, physics, camera,
presets) is real and won't be thrown away as we raise fidelity.

![day](docs/day.png)

![sea states](docs/sea_states.jpg)

![weather](docs/weather_states.jpg)
![night](docs/night.png)

## Run it (Windows / macOS / Linux)

Requires [Node.js](https://nodejs.org/) 18+.

```bash
npm install
npm run dev
```

Then open the printed URL (default http://localhost:5173). For a production
build: `npm run build` then `npm run preview`.

### Controls

You can command the ship from outside, stand at the wheel, or walk about her.

| Key | Third person / at the helm | Walking aboard |
| --- | --- | --- |
| `W` / `S` | engine telegraph one step ahead / astern | walk |
| `A` / `D` | wind the wheel to port / starboard | strafe |
| `Z` | wheel midships | |
| `E` | leave the helm | take the helm (standing at the wheel) |
| `F` | switch third person ↔ first person at the helm | back to third person |
| `Shift` | | run |
| mouse | (click to capture) look around | look around |
| `N` / `C` | day ↔ night / orbit camera (third person) | |
| `B` | weather: clear → fair → overcast with showers → storm → changing on its own | weather |
| `M` / `H` | sound on / off / ship's horn | sound on / off / horn |
| `J` | dive in (off the starboard quarter) | over the side you stand nearest |

In the water (a scuba diver):

| Key | |
| --- | --- |
| `W` `A` `S` `D` | swim where you look (look down and swim on to dive) |
| `Space` / `C` | up / down |
| `Shift` | fin harder |
| `L` | dive light on / off (it comes on by itself when deep or dark) |
| `E` | climb the ladder aboard (at the ship's side, at the surface) |

On a phone the interface is in Russian and kept out of the way:
- **Bottom left**: a joystick, always in the same place. At the conn it works
  like the helm joystick of a modern wheelhouse: push it left or right and
  the rudder goes over in proportion, let go and it comes back to midships;
  hold it up or down to step the engine order. Aboard, it walks you about.
- **Bottom right**: the engine-order telegraph lever, to go straight to an
  order: slide it up for ahead, down for astern.
- **Anywhere else**: drag to look around (aboard) or to fly the camera around
  the ship (third person). Pinch with two fingers to zoom.
- **Top right**: *на борт / со стороны* switches view, *к штурвалу / отойти*
  takes or leaves the helm, *нырнуть* goes over the side, and ☰ opens
  day/night, weather, sound and horn.
- **In the water**: the joystick swims where you look, ▲ / ▼ on the right
  (held) go up and down, *фонарь* is the dive light, *на борт* appears at
  the ship's side.
- Hints fade after a few seconds, and a short how-to shows on start.

On desktop, drag the mouse to orbit the ship and use the wheel to zoom.
If you fall over the side or down a gap into the hull, you are put back where
you last stood on deck.
Sound starts with your first tap (browser rule). On an iPhone the ring/silent
switch must be on ring to hear it.

### Ship handling

The trawler is driven like a real vessel, not an arcade boat:

- **Engine-order telegraph**: full / half / slow astern, stop, dead slow /
  slow / half / full ahead. Engine rpm follows the order with a lag; thrust
  scales with rpm² and falls off with speed (propeller in nozzle, 20 t bollard
  pull per the data sheet).
- **Mass and resistance**: ~450 t with added mass and quadratic hull
  resistance: about 9 kn after 20 s at full ahead, 12 kn flat out; after
  STOP she still carries ~4 kn half a minute later.
- **Steering**: you wind a wheel order; the steering gear follows at
  2.5 °/s up to 35°. A first-order Nomoto model turns rudder into rate of turn
  and needs water flow (way on, or propeller wash). Full rudder at full
  ahead gives a ~65 m turning radius, ~4° outward heel and some speed loss.
- Instruments on screen: speed log (kn), gyro heading, telegraph and rpm,
  rudder angle indicator with the wheel order.

### Bridge electronics

The five console screens in the wheelhouse are live (`src/ui/Instruments.js`),
drawn into canvas textures from the game state while you are on the bridge:

- **Radar**: X-band, head-up, 24 rpm sweep. It paints the actual terrain from
  a 9.5 m antenna height, so cliff faces show strong echoes and the land behind
  them falls into radar shadow. There is sea clutter close in. Range is picked
  automatically from the 0.5 / 0.75 / 1.5 / 3 NM scales.
- **Chart plotter**: north-up chart rendered from the terrain grid (land,
  depth bands, 10 m contour, coastline) with position, COG/SOG, your past track
  and a 6-minute speed vector. Coordinates are a fictional Norwegian datum.
- **Echo sounder**: the scrolling seabed under the keel with the bottom
  return, the second echo and the odd fish school.
- **Conning display**: heading tape, rate of turn and rudder angle.
- **Engine monitor**: tachometer, gear, load, fuel rate, temperatures.

![bridge](docs/bridge_instruments.png)

## How it's built

The realism here is **not** the engine — it's the water shader + fog + post.

- **Ocean waves** (`src/world/OceanSpectrum.js`, `OceanFFT.js`): a spectral
  sea after Tessendorf, the method used for film and AAA oceans. Wave
  amplitudes are drawn at random from a **JONSWAP** spectrum (fetch-limited
  wind sea from wind speed and fetch) plus a long swell, with Mitsuyasu
  directional spreading. The GPU advances the spectrum in time and runs an
  inverse FFT every frame for three cascades (patches of 2000 m, 120 m and
  19 m; 1000 m on phones), so wavelengths from ~1 km down to 30 cm are
  covered without visible tiling. The output is displacement (including
  choppy horizontal motion) and slope derivatives. Sea states run from
  Beaufort 2 to 8. The simulated significant wave height matches the
  spectrum (Hs 1.5 m at Bft 4, 6.7 m at Bft 8), and the sea builds up or
  calms over a few seconds when you change it.
- **Not uniform, like a real sea** (`src/world/Ocean.js`): the long waves die
  down behind the islands and up the fjords (each point's openness to the
  sea is worked out from the real coastline, see below) and the swell is
  damped where the real sea floor shoals. Drifting
  wind gusts (cat's paws) roughen the small waves in patches. Whitecaps
  appear where the summed surface folds over (Jacobian) and leave foam that
  fades. A gale blows foam into streaks along the wind, and there is surf at
  the foot of the cliffs.
- **Weather** (`src/world/Weather.js`, `CloudLayer.js`, `Rain.js`): one
  state drives the sky, light, fog, sea state, clouds and rain together, and
  a front blends over 12 s. It has four states, plus *changing*, in which the
  weather wanders by itself every few minutes:

  | weather | sea | clouds | rain | sun | fog |
  | --- | --- | --- | --- | --- | --- |
  | clear | Bft 2 | few | none | full | light haze |
  | fair | Bft 4 | broken cumulus | none | full | normal |
  | overcast, showers | Bft 6 | grey deck | showers | weak | thicker |
  | storm | Bft 8 | low dark ceiling | heavy, slanting | almost none | ~1.5 km visibility |

  The clouds are a deck ray-cast in the sky shader. They drift with the wind,
  the cloud base comes down as the weather worsens, and they fade into the
  haze. Rain is wind-slanted streaks in a box around the camera, culled inside
  the wheelhouse, plus rings on the water. A storm adds lightning. Under
  cloud the sea reflects grey, the sun glitter goes and the shadows soften.
- **Sound** (`src/systems/Sound.js`): fully procedural, spatial Web Audio
  with no sound files. The camera is the listener. Point sources sit in the
  world and fade with distance, carry direction (HRTF on desktop) and lose
  their highs far away (air absorption).
  - **The ship**: the diesel exhaust (a 6-cylinder four-stroke, 600–1200 rpm),
    water sloshing against the hull with the motion, bow wash, rigging
    whistling in a gale, VHF chatter on the bridge, and the horn (`H`,
    340/425 Hz).
  - **The land**: surf on the nearest cliffs, found by scanning the terrain
    around you, so it gets louder as you close the rocks. Gulls call near the
    shore and over the ship in fair weather; there are none at night or in
    rain.
  - **The sky**: thunder from the strike point, arriving distance / 343 m/s
    after the flash, with a crack when it is close.
  - **Everywhere**: open-sea waves (quieter up the fjord), wind with gusts,
    rain.
  - **Aboard**: the engine through the hull and the hull creaking as she
    rolls. From the wheelhouse the outside is muffled and rain drums on the
    roof; out on deck rain patters.
  - **The fjord rings**: reverb grows with how enclosed you are, and the horn
    comes back as real echoes from every cliff within 1.5 km, delayed by the
    path length.
- **Bow spray** (`src/world/Spray.js`): the bow plunging into a rising sea
  (water rising fast against the bow) throws a sheet of spray to both sides.
  It carries with the ship, blows downwind and falls back; light spray runs
  off the bow wave at speed in a seaway.
- **Waterfalls** (`src/world/Waterfalls.js`): six falls inside the fjords,
  placed where the real terrain has a high, steep face right at the water. Each is two crossed curtains hugging the cliff from lip to sea, with
  streaks accelerating as they fall and mist where they land. They run
  fuller in the rain. The two nearest roar from their foot (spatial sound).
- **Night sky** (`src/world/NightSky.js`): a dark gradient with airglow at
  the horizon, twinkling stars in two layers, the Milky Way with its denser
  star field, and the moon with maria and a halo. The moon lays a path of
  light on the sea, and clouds hide the sky in bad weather.
- **Water shading**: Fresnel sky reflection, sun or moon glitter that widens
  with distance, light scattered through thin crests, the ship's bow wave,
  wake and Kelvin arms, and distance fog. The mesh is a polar grid centred
  under the camera, about 1 m spacing close in.
- **Seakeeping** (`src/entities/Boat.js`): the water height at five points
  under the hull is summed on the CPU from the same spectrum (the ≈1800 most
  energetic wave trains), so the ship rides the rendered sea. Heave, pitch and roll are second-order
  responses with the trawler's natural periods (roll ~8 s), so she rolls
  hardest when the waves meet her rhythm.
- **Sky** (`src/world/SkyDome.js`) — three's physically-based (Preetham) sky;
  the sun direction drives the ocean shader and the directional light.
- **Post** (`src/core/Engine.js`) — `ACESFilmicToneMapping` + `UnrealBloomPass`.
  This is ~half of the "filmic" look.
- **Boat** (`src/entities/Boat.js`) — loads the Blender-built trawler (below),
  with thrust/drag physics, heel in turns and buoyancy over bow, stern and sides.
- **Presets** (`src/config.js`) — day/night are presets of one scene. All
  tuning (colors, waves, fog, bloom, camera, boat) lives here.

## The trawler

The player's vessel is a 23.95 m Scottish stern trawler built procedurally in
Blender by `blender/build_trawler.py` and exported to `src/assets/trawler.glb`.

Reference data, all from Macduff Ship Design's page for the 23.95 m trawler
*Adventurer II*:
- data sheet: LOA 23.95 m, LBP 20.00 m, breadth 9.20 m, depth 4.00 m, 337 GRT,
  2.7 m propeller in nozzle, 3 split winches, 4 net drums, crane;
- general-arrangement profile drawing: every height and position (freeboard,
  stripes, shelter deck, wheelhouse, mast platforms, raked A-frame, drums) was
  measured off it;
- delivery photo: livery, railings, equipment.

The draught (3.0 m) is assumed. Name and registration are our own. Hull
livery and ambient occlusion are baked into textures (hull 4096x1024,
fittings atlas 2048).

![compare](docs/trawler_compare.jpg)

Rebuild the model (needs Python 3.13; takes ~3 minutes):

```bash
python3.13 -m venv .blenv && .blenv/bin/pip install bpy==5.2.3 pillow
.blenv/bin/python blender/build_trawler.py -- out --render
cp out/trawler.glb src/assets/trawler.glb
```

### Below decks

The published drawing is an outboard profile only, and no complete general
arrangement of a 24 m Scottish trawler with its interiors is openly
available. The arrangement is therefore worked out from how this boat works
from outside, and from documented arrangements of comparable UK trawlers:

- Parkol Marine (Whitby) yard descriptions of their 19-22 m trawlers
  (e.g. *Sparkling Star*, *Our Lass II*, *Jubilee Quest*, *Day Dawn*):
  below deck three watertight bulkheads divide aft accommodation with the
  steering gear, the engine room, the fishroom with its ice locker and the
  forepeak tank; on the main deck an athwartships casing holds galley, mess,
  oilskins and washroom; fish handling, hopper and ice machine are in the
  shelter.
- FAO *Fishing boat designs* (Fisheries Technical Papers 188 and 239) for
  the general practice: fishroom divided into pens about 1.5 m long by
  stanchions and pound boards either side of a centre gangway, ice stowage,
  steering gear over the rudder, engine room access.

How the spaces follow from the boat itself (stations s from the transom):

- **The catch path.** The codend comes up the stern onto the working deck
  and is emptied through the hatch in the deck (s 8.15). Below it, on the main
  deck at 2.15 m, the reception hopper feeds a conveyor that carries the fish
  aft past the crew; they gut standing inboard of it and put the fish on a
  second conveyor that lifts them into the washer drum; from the washer a
  chute goes down through its own hatch into the fishroom. Offal runs in the
  floor gutter to the side discharge door (the door on the drawing). The ice
  machine stands beside the chute and drops ice into the ice locker below.
- **Fishroom** (s 9.4-16.4, about 160 m³ gross as on the data sheet), right
  under the fish handling: insulated and white, aluminium stanchions and
  pound boards in pens about 1.5 m long, boxed fish and bulk ice, the ice
  locker aft, refrigeration grids on the deckhead, a stair down from the
  hatch.
- **Engine room** (s 3.0-9.4), aft of the fishroom so the shaft is short:
  main engine (1500 hp, six in line) with gearbox aft, coupling and stern
  gland, turbo and exhaust, a hydraulic pump for the winches and net drums,
  two generator sets, switchboard, day tank, workbench, pipe runs with
  valves. The exhaust goes up a lagged trunk on the port side, along the
  deckhead, across the casing and up through a casing in the wheelhouse to
  the funnel on its roof (which is where the drawing has it).
- **Steering gear flat** (s 0.45-3.0) over the rudder, reached by its own
  hatch from the aft store: rudder stock, tiller, two hydraulic rams, power
  pack, emergency tiller, rudder-angle transmitter.
- **Aft store** under the working deck: the companion from the deck lands
  here; spare net under the stair, ropes, floats, the hatches down to the
  steering flat and the engine room.
- **Casing** (s 11.4-16.6), under the wheelhouse: changing room where the
  crew come in off the deck (lockers, oilskins, boots, bench), washroom (WC,
  shower, basin), galley (stove with fiddle rails, oven, hood, sink, fridge,
  microwave) and mess (settee, table, TV), and the stair up to the
  wheelhouse.
- **Cabins** forward: four two-berth cabins off a centreline corridor, with
  bunk curtains, reading lights and lockers.

Every space is walkable; stairs are 42-57°, as on a working boat. Below decks
the sea is masked out of the hull, the rain does not fall, the outside light
is shut out, the deckhead lights and your own lamp light the spaces, and the
engine is loud in the engine room.

![below decks](docs/below_decks.jpg)

## The land and the sea floor: Reine, Lofoten

The world is a real place: Reine on Moskenesøya in Lofoten, with Reinefjorden
and its arms, the skerries off the village and Vestfjorden outside. You start
in open water south-east of Reine, bow toward the fjord mouth.

- **Land**: Kartverket's national height model (NHM digital terrain model,
  10 m), from the Geonorge WCS (CC BY 4.0).
- **Sea floor**: the EMODnet Bathymetry digital terrain model (mean depth,
  1/16 arc-minute, about 115 x 45 m here), which includes the fjord basins
  (to about 155 m deep in Reinefjorden, 250 m in Vestfjorden).
- `tools/build_terrain.py` downloads both, merges them at the coastline (the
  coarse sea-floor model is limited by a slope off the real shore so rock
  does not drop vertically and narrow sounds keep water), smooths the
  sea-floor facets and writes two grids: 10 m over the 10 x 11 km you sail in
  and 64 m over 41 x 41 km so the mountains on the horizon are real too. It
  also works out how open each point is to the sea (fetch along 32 bearings)
  for the wave shelter. Output: `src/assets/terrain/` (about 1.7 MB).
- In the game (`src/world/Terrain.js`) the same heights answer the boat
  (grounding), camera, radar, echo sounder and chart, and drive the mesh: a
  quadtree of patches, finer near the camera, drawn as one instanced draw
  call with the heights read from a texture in the vertex shader.
- **What the ground is**: NGU's map of superficial deposits (bare rock,
  scree, moraine, beach, wind-blown sand, weathered material) and its
  1:250 000 bedrock map (monzonite to granite, migmatitic gneiss, gabbro),
  read into the same 10 m cells by `tools/build_landcover.py`. The shader
  draws what the map says is there: pale rubble on the scree fans, green
  stony moraine, beaches, dark gabbro, banded gneiss; mountain lakes are the
  real ones (dead-flat areas in the height model). Height and slope add
  snow on the high ledges and vegetation only where it can hold.
- **Stones**: blocks on the scree, erratics on the moraines and cobbles on
  the beaches, placed by the deposit map around the camera (instanced,
  refreshed as you move) and coloured by the bedrock under them.
- **The tide**: Kartverket's predicted high and low waters for Reine
  (`src/assets/terrain/tide.json`, Nov 2026 - Dec 2027). The sea level in the
  game follows the real clock (about 2.4 m range at springs), so the wet band
  on the rocks, the shallows and what you can sail over change through the
  day; the bridge shows the tide and whether it is rising or falling.
- **The village**: every building in Kartverket's register (Matrikkelen,
  788 standing buildings in the area) at its registered position, as the
  kind its type code says: houses, cabins, red rorbuer and sea houses on
  posts over the water, boathouses, sheds, the fish plants, shops. The
  register has points, not outlines, so each kind has its typical size and
  form (modelled in `blender/build_village.py`), faces downhill toward the
  shore and stands on a foundation that follows the slope. Stockfish racks
  stand near the fishery buildings (approximate places: they are not in the
  register) and carry cod from February to May.

Honest limits: the land is accurate to about 10 m; the sea floor is the
regional model, so single rocks and the shape of small coves under water are
smoothed. The deposit map is 1:50 000-ish, so its borders are a few tens of
metres off. Buildings are typical shapes at the right place, not the real
house; roads, quays and bridges are not drawn yet (OpenStreetMap could not be
reached from the build environment).

## Under water

Go over the side (`J`, or *нырнуть*) and you are a diver in a drysuit with a
12 litre, 200 bar cylinder of air; the water is about 7 °C in November.

- **Diving as it works**: the vest holds your head out at the surface and is
  let out to go down; under water you are neutral and swim where you look.
  The dive computer shows depth, maximum depth, dive time, ascent rate and
  cylinder pressure. Air goes at about 18 l/min at the surface at rest, more
  when finning, times the ambient pressure (one bar more every 10 m), so the
  same cylinder lasts half as long at 10 m and a third as long at 20 m. It
  warns when you come up faster than 10 m/min, counts down the 3-minute
  safety stop at 3-6 m after a dive deeper than 10 m, and warns past 40 m
  and when the oxygen partial pressure of air passes 1.4 bar (57 m). Out of
  air, you go straight up. Back at the ship's side, climb the ladder aboard.
- **Light in water** (`src/world/Underwater.js`, `WaterOptics.js`): red is
  taken out within a few metres, green goes deepest, blue a little less
  deep (the dissolved organic matter of coastal water). The view fades into
  the water's own colour within about 25-30 m (clear winter water) and
  darkens with depth; the eye's adaptation is allowed for, so it is not the
  unfiltered blue-green of a camera. Looking up, the sky shows only inside
  Snell's window, a circle 97° across overhead with a glowing rim, and the
  surface beyond it is a mirror of the water below (total internal
  reflection). Caustics play on the bottom in the first metres; flecks of
  marine snow drift; each breath out sends bubbles past the mask; the dive
  light lights a cone. Sound goes dull under water, the ship's diesel and
  propeller carry through it, and you hear the regulator: the hiss in, the
  bubbles out.
- **From above**, the sea is see-through where it is shallow, the bottom
  fading with depth and tinted by the water above it.
- **The bottom** (terrain shader): rock on steep bottoms and in patches,
  dark in the kelp zone and crusted pink with coralline algae below it;
  shell sand with ripples in the shallows, finer sand deeper, mud in the
  basins.
- **Life** (`src/world/SeaLife.js`), placed by the same rock-or-sand rule:
  a forest of Laminaria hyperborea on rock from just below the lowest tides
  to about 20 m (stiff stipes furred with red algae, hand-shaped blades,
  thinning to a kelp "park" deeper), sugar kelp in sheltered water, green
  sea urchins at and below the lower edge of the kelp, common starfish, a
  school of saithe in mid water that keeps its distance, and cod by the
  bottom. The kelp sways in the surge of the swell, more in shallow water
  and in a rough sea.

Honest limits: the sea-floor model is coarse (about 100 m), so near land the
bottom drops to several metres within one 10 m cell and wide shallows are
rare; the bottom types and the life are the usual pattern for this coast,
placed by rule, not mapped (Norway's detailed sea-floor maps do not cover
Reine yet). Fish are a simple school, not a simulation of behaviour.

To rebuild the terrain data:

```bash
python3 -m venv .geoenv && .geoenv/bin/pip install numpy scipy tifffile pyproj pillow
.geoenv/bin/python tools/build_terrain.py
.geoenv/bin/python tools/build_landcover.py      # cover.dat, buildings.json, tide.json
blender -b -P blender/build_village.py -- src/assets      
```

## Project layout

```
src/
  main.js              # wiring + main loop
  config.js            # all tunable values + day/night presets
  core/Engine.js       # renderer, camera, post-processing
  world/
    OceanSpectrum.js   # JONSWAP spectrum, cascades, CPU wave sampler
    OceanFFT.js        # GPU time evolution + inverse FFT + foam
    Ocean.js           # water mesh + shaders, sea states, shelter
    Weather.js         # weather states, blending, preset resolution
    CloudLayer.js      # cloud deck
    NightSky.js        # stars, Milky Way, moon
    Terrain.js         # real terrain: data, CPU heights, GPU quadtree mesh
    Tide.js            # sea level now, from Kartverket's predictions
    Village.js         # registered buildings, stockfish racks, boulders
    Underwater.js      # light in water, marine snow, bubbles, dive light
    WaterOptics.js     # attenuation constants + GLSL shared by the shaders
    SeaLife.js         # kelp, urchins, starfish, saithe, cod
    Waterfalls.js      # waterfalls on the fjord walls
    Rain.js            # rain streaks
    Spray.js           # bow spray particles
  systems/Sound.js     # procedural soundscape
    SkyDome.js         # sky + sun direction
    Environment.js     # lights + scene fog
  entities/Boat.js     # placeholder boat + buoyancy/steering
  entities/Diver.js    # the scuba diver: swimming, air, dive computer
  ui/DiveComputer.js   # dive computer panel
  systems/
    Input.js           # keyboard -> throttle/steer
    FollowCamera.js    # damped chase camera
```

## Roadmap (next phases)

Known rough edges and the planned path to reference-level fidelity:

1. ~~Cliffs / fjord terrain~~ — done: the real Reine area of Lofoten.
2. **Boat asset** — replace the primitive with a Blender-authored, baked-PBR
   trawler exported as Draco-compressed glTF.
3. **Water fidelity** — detail normal maps, better LOD near the camera, and
   eventually an FFT ocean; screen-space reflections.
4. **Real volumetric fog / god rays** — a raymarched fog post-pass instead of
   the analytic distance fog.
5. **Night sky** — moon disc, stars, and cloud layer (three's Sky is daytime
   only, so night currently uses a dark background + fog).
6. **Audio + world content** — ambient sound, points of interest to explore.
