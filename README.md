# Open World — Ocean

Atmospheric open-world ocean prototype in the browser, built with **three.js**.
Inspired by the filmic "boat sailing through a fjord" look: a spectral (FFT)
ocean, hazy distance fog, a chase camera and a drivable trawler, all graded
with ACES tone mapping and bloom.

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

On a phone: the left stick turns the wheel (or walks), ▲ ▼ step the telegraph,
drag the right half of the screen to look, buttons switch view and take or
leave the helm; *day / night* and *weather* are in the top-right corner.

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
  down going up the fjord and the swell is damped near the cliffs. Drifting
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
    Rain.js            # rain streaks
    SkyDome.js         # sky + sun direction
    Environment.js     # lights + scene fog
  entities/Boat.js     # placeholder boat + buoyancy/steering
  systems/
    Input.js           # keyboard -> throttle/steer
    FollowCamera.js    # damped chase camera
```

## Roadmap (next phases)

Known rough edges and the planned path to reference-level fidelity:

1. **Cliffs / fjord terrain** — the big missing visual. Height-displaced
   terrain or Blender-sculpted cliff meshes (glTF) lining a channel.
2. **Boat asset** — replace the primitive with a Blender-authored, baked-PBR
   trawler exported as Draco-compressed glTF.
3. **Water fidelity** — detail normal maps, better LOD near the camera, and
   eventually an FFT ocean; screen-space reflections.
4. **Real volumetric fog / god rays** — a raymarched fog post-pass instead of
   the analytic distance fog.
5. **Night sky** — moon disc, stars, and cloud layer (three's Sky is daytime
   only, so night currently uses a dark background + fog).
6. **Audio + world content** — ambient sound, points of interest to explore.
