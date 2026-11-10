# Галеон у Лофотенов

A large old sailing ship in the browser, built with **three.js**, on a real
coast: the Reine area of Lofoten, Norway, from open elevation and bathymetry
data. You sail her, walk her from the tops to the hold, and go over the side.
A spectral (FFT) ocean, fog, weather, day and night, procedural sound; ACES
tone mapping and bloom.

## The ship

A large sailing ship of the 1620s, carrying both guns and cargo, built after
the Swedish royal ship **Vasa** (1628), the one ship of that age that survives
whole. `blender/build_galleon.py` builds her in Blender from Vasa's recorded
dimensions (47.5 m between perpendiculars, 11.7 m beam, 4.8 m draught, 52.5 m
from keel to main truck, a 23° rudder), checked against the photogrammetry
the Swedish National Maritime Museums published of the ship herself (looked
at in the Sketchfab viewer, not downloaded):

* hull: flat floor, hard bilge, greatest breadth at the lower gundeck, strong
  tumblehome; six heavy wales; 24 ports in two tiers with their lids hanging
  open, red inside, plus ports in the castles; oak strakes with seams, butts
  and weathering (painted texture, baked ambient occlusion);
* stern in tiers, as on Vasa: planked tuck with the stern chasers, counter, a
  cornice on carved brackets, the great cabin's gallery between carved
  posts, the upper gallery as an arcade, our own arms, the crest, three
  lanterns; two-tier quarter galleries with lead domes;
* beakhead with head rails, grating and a leaping lion figurehead;
* bowsprit with sprit topmast; fore and main masts with topmast and
  topgallant, mizzen with topmast; round tops with rails; shrouds on
  deadeyes and channels with ratlines, stays, backstays; eleven yards.

There are no people aboard: the ship is yours alone.

**Inside, everything you can walk is walkable**, from the tops to the
ballast:

| level | what is there |
| --- | --- |
| tops | the fore, main and mizzen tops, reached up the shrouds |
| poop and royal deck | the upper cabin, the upper gallery (arcade) |
| half deck | the great cabin (table, benches, chest) and its stern gallery; the steering hatch over the whipstaff |
| upper gundeck | the steerage with the whipstaff and binnacle, the open waist with the main hatch grating and capstan, the space under the forecastle, the door onto the beak |
| lower gundeck | 24 heavy guns behind their ports |
| orlop | the cable tiers, spare sails, the bread room's casks |
| hold | ballast under planking, water and beer casks, cargo, the galley's brick hearth, the pumps |

Steep ladders go down through the hatches from deck to deck, stairs go up
each break of the decks, and doors lead through every bulkhead at the
breaks, through the stern onto the galleries and through the bow bulkhead
onto the beak. Beams, knees and pillars under every deck; hanging lanterns
below. An invisible low-poly collision mesh comes with the model (6500
triangles): the decks, ladders as ramps, the sides, bulkheads with their door
openings, guns, casks, masts, the galleries and the tops.

The sails are made in the game (`src/ship/Sails.js`): ten, as on Vasa, dark
canvas with our star on the courses and topsails, set or furled by steps,
filling with the wind, shivering when it comes too far forward and taken
aback when it comes ahead; the yards brace round by themselves.
`src/entities/Galleon.js` sails her: apparent wind, a square-rig drive curve
(nothing closer than about 60° to the wind), leeway, heel, 1200 t that carry
their way, a rudder that answers only with way on. She starts off
**Vindstad** in Reinefjorden, the largest stretch of level land beside deep
water in the area, where a harbour could be built.

## Run it (Windows / macOS / Linux)

Requires [Node.js](https://nodejs.org/) 18+.

```bash
npm install
npm run dev
```

Then open the printed URL (default http://localhost:5173). For a production
build: `npm run build` then `npm run preview`.

### Controls

You can sail her from outside, take the whipstaff, or walk about her.

| Key | Outside view / at the whipstaff | Walking aboard |
| --- | --- | --- |
| `A` / `D` | helm to port / starboard (amidships when let go) | step left / right |
| `W` / `S` | set / take in sail, a step at a time | walk forward / back; on the shrouds, climb up / down |
| `Shift` | | run |
| `F` | outside → aboard; aboard → outside | back to the outside view |
| `E` | at the whipstaff: let go of it | take the whipstaff (standing at it); go up / down the shrouds (at their foot or in the top) |
| `J` | over the side | over the side |
| `N` / `B` / `M` | day ↔ night / weather / sound on-off | |
| `C` | free orbit camera (outside view) | |
| mouse | drag to orbit, wheel to zoom | click to look around |

Sail: courses, then topsails, then topgallants. Nothing drives her closer than
about 60° to the wind; head to wind the sails go aback and she gathers
sternway. The top-left panel shows her speed, the canvas set, the wind on her
(close-hauled, beam reach, broad reach, running) and the helm.

On a phone:

- **Bottom left**: a joystick, always there. With the conn (outside or at the
  whipstaff) left and right put the helm over in proportion, back amidships
  when you let go; held up or down it sets or takes in sail. Aboard it walks,
  and on the shrouds it climbs.
- **Anywhere else**: drag to look (aboard) or to fly round the ship; pinch to
  zoom.
- **Top right**: the one thing you can do where you stand (take the
  whipstaff, climb, come aboard), over the side, the view, and ☰ with
  day/night, weather and sound.

### Getting about the ship

`F` puts you on the half deck, abaft the mainmast. Walk forward and down the
stairs at either side of the break into the waist; through the doors in the
break bulkheads into the steerage aft or under the forecastle forward; down
the ladder through the hatch forward of the main hatch to the lower gundeck,
on down to the orlop and the hold. The great cabin is aft on the half deck,
through the door in the break of the poop; its stern door opens onto the
gallery. A line at the bottom of the screen names the space you are in.

Below decks the sun and sky are shut out: what light there is comes from the
two hanging lanterns nearest you and the lantern you carry, and the eye opens
up to it. Sound is muffled through the oak, the sea is close outside the
planking, rain drums on the deck overhead, and her timbers work as she rolls.

## How it's built

- **Ocean waves** (`src/world/OceanSpectrum.js`, `OceanFFT.js`): a spectral
  sea after Tessendorf. Wave amplitudes are drawn at random from a
  **JONSWAP** spectrum (fetch-limited wind sea from wind speed and fetch) plus
  a long swell, with Mitsuyasu directional spreading. The GPU advances the
  spectrum in time and runs an inverse FFT every frame for three cascades
  (2000 m, 120 m and 19 m; 1000 m on phones), so wavelengths from ~1 km down
  to 30 cm are covered without visible tiling. Sea states run from Beaufort 2
  to 8 (Hs 1.5 m at Bft 4, 6.7 m at Bft 8) and build up or calm down over a
  few seconds.
- **Not uniform, like a real sea** (`src/world/Ocean.js`): the long waves die
  down behind the islands and up the fjords (each point's openness to the
  sea is worked out from the real coastline) and the swell is damped where
  the sea floor shoals. Cat's paws roughen the small waves in patches.
  Whitecaps appear where the surface folds over (Jacobian) and leave foam; a
  gale blows it into streaks; there is surf at the foot of the cliffs.
- **Weather** (`src/world/Weather.js`, `CloudLayer.js`, `Rain.js`): one state
  drives the sky, light, fog, sea, clouds, rain and wind, blended over 12 s:

  | weather | sea | clouds | rain | sun | fog |
  | --- | --- | --- | --- | --- | --- |
  | clear | Bft 2 | few | none | full | light haze |
  | fair | Bft 4 | broken cumulus | none | full | normal |
  | overcast, showers | Bft 6 | grey deck | showers | weak | thicker |
  | storm | Bft 8 | low dark ceiling | heavy, slanting | almost none | ~1.5 km visibility |

  A storm adds lightning. The wind on the sails is the weather's wind, eased
  in the lee of the mountains.
- **Sound** (`src/systems/Sound.js`): procedural, spatial Web Audio, no sound
  files; the camera is the listener and sources fade with distance, carry
  direction (HRTF on desktop) and lose their highs far away.
  - **The ship**: water working along her sides, the bow wave, the shrouds
    moaning and the running rigging whistling as the wind gets up, canvas
    flogging and cracking when the wind is on the wrong side of it, the
    timbers working in a seaway, a dull boom when she buries her bow.
  - **The land**: surf on the nearest cliffs (found by scanning the
    terrain), the waterfalls, gulls near the shore in fair weather.
  - **The sky**: thunder from the strike point, arriving distance / 343 m/s
    after the flash.
  - **Below decks** the outside is muffled, the sea is close through the
    planking and rain drums overhead; the fjord walls ring (reverb grows with
    how enclosed you are).
- **Seakeeping**: the water height at five points under the hull is summed
  on the CPU from the same spectrum, so she rides the rendered sea; heave,
  pitch and roll are second-order responses with a ship of 1200 t's natural
  periods (roll ~12 s).
- **Walking aboard** (`src/entities/Player.js`, `src/ship/Aboard.js`): you
  live in the ship's own frame, so her heave, roll and heel carry you; rays
  against the collision mesh find the deck under you and stop you at walls;
  the shrouds are climbed as ladders. The access data (ladders, named
  spaces, the whipstaff, where you come aboard) is written by the Blender
  script into `src/ship/galleon_rig.json`.
- **Bow spray** (`src/world/Spray.js`), **waterfalls** (`Waterfalls.js`),
  **night sky** with moon and Milky Way (`NightSky.js`), a physically based
  sky (`SkyDome.js`), and the post chain (`src/core/Engine.js`).

### Building the model

```bash
python3 -m venv .blenv && .blenv/bin/pip install bpy scipy   # Blender as a Python module
.blenv/bin/python blender/build_galleon.py -- out --atlas 4096
tools/pack_glb.sh out/galleon.glb src/assets/galleon.glb.gz
```

The script writes the model, the rig and access data
(`src/ship/galleon_rig.json`) and preview renders; `--shape` makes only
quick previews (no bake, no export). `tools/pack_glb.sh` quantizes the
geometry and gzips it; the game unzips it with fflate (no WebAssembly
decoder).

## The land and the sea floor: Reine, Lofoten

The world is a real place: Reine on Moskenesøya in Lofoten, with Reinefjorden
and its arms, the skerries off the village and Vestfjorden outside.

- **Land**: Kartverket's national height model (NHM digital terrain model,
  10 m), from the Geonorge WCS (CC BY 4.0).
- **Sea floor**: the EMODnet Bathymetry digital terrain model (about
  115 x 45 m here), which includes the fjord basins (to about 155 m deep in
  Reinefjorden, 250 m in Vestfjorden).
- `tools/build_terrain.py` downloads both, merges them at the coastline and
  writes two grids: 10 m over the 10 x 11 km you sail in and 64 m over
  41 x 41 km so the mountains on the horizon are real too. It also works out
  how open each point is to the sea for the wave shelter. Output:
  `src/assets/terrain/`.
- In the game (`src/world/Terrain.js`) the same heights answer the ship
  (grounding), the camera and the diver, and drive the mesh: a quadtree of
  patches drawn as one instanced draw call.
- **What the ground is**: NGU's map of superficial deposits and its bedrock
  map, read into the same 10 m cells by `tools/build_landcover.py`. The shader
  draws what the map says is there: scree, moraine, beaches, dark gabbro,
  banded gneiss; mountain lakes are the real ones. Snow on the high ledges
  and vegetation only where it can hold.
- **Stones**: blocks on the scree, erratics on the moraines and cobbles on
  the beaches, placed by the deposit map around the camera.
- **No houses**: the land is shown as the map and the height model give it,
  without the present-day buildings.
- **The tide**: Kartverket's predicted high and low waters for Reine
  (`src/assets/terrain/tide.json`). The sea level follows the real clock
  (about 2.4 m range at springs).

Honest limits: the land is accurate to about 10 m; the sea floor is the
regional model, so single rocks and small coves under water are smoothed.

## Under water

Go over the side (`J`) and you are a diver in a drysuit with a 12 litre,
200 bar cylinder of air; the water is about 7 °C in November.

- **Diving as it works**: the vest holds your head out at the surface and is
  let out to go down; under water you swim where you look. The dive computer
  shows depth, maximum depth, dive time, ascent rate and cylinder pressure;
  air use grows with depth; it warns of fast ascents, counts the safety stop,
  and warns past 40 m and at 1.4 bar of oxygen (57 m). Back at the ship's
  side, climb aboard (`E`) up her side amidships.
- **Light in water** (`src/world/Underwater.js`, `WaterOptics.js`): red goes
  first, green deepest; the view fades into the water's own colour within
  about 25-30 m; Snell's window overhead; caustics, marine snow, bubbles, a
  dive light.
- **The bottom and its life** (`src/world/SeaLife.js`): rock and kelp forest
  (Laminaria hyperborea) to about 20 m, sugar kelp, urchins, starfish, saithe
  and cod; shell sand, finer sand deeper, mud in the basins.

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
  main.js              # wiring, modes, main loop
  config.js            # tunable values, weather, sea states, day/night presets
  core/Engine.js       # renderer, camera, post-processing
  entities/
    Galleon.js         # the ship: model, collider, sailing, seakeeping
    Player.js          # you aboard: walking, ladders, the whipstaff
    Diver.js           # the scuba diver: swimming, air
  ship/
    Sails.js           # sails, yards, flags
    Aboard.js          # ladders and named spaces from the access data
    galleon_rig.json   # written by blender/build_galleon.py
  world/               # ocean, weather, clouds, night sky, terrain, tide,
                       # stones, under water, sea life, waterfalls, rain, spray
  systems/
    Sound.js           # procedural soundscape
    Input.js           # keyboard, mouse, touch -> one interface
    TouchControls.js   # phone joystick and buttons
    FollowCamera.js    # outside view
  ui/DiveComputer.js   # dive computer panel
blender/
  build_galleon.py     # the ship
  build_village.py     # stones (and the buildings, not shown)
tools/                 # terrain, land cover, model packing
```

## Next

1. A small harbour at Vindstad: a quay to lie alongside, an anchor to let go.
2. Atmosphere: mist on the fjord, low cloud on the peaks, light as in the
   reference video.
