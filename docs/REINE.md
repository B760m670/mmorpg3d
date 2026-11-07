# Reine, Lofoten: what the place is made of

Research notes for making the game world faithful to the real place. Each
item says where it comes from and whether the data can be loaded into the
game directly (D) or is descriptive only (text).

## Rock (bedrock)

- **Main rock, ~79 % of the 10 x 11 km area** — quartz monzonite to
  granite, medium-grained, locally deformed to gneiss (with syenite and
  diorite), Palaeoproterozoic, 1880-1770 Ma. In the field: the brown
  monzonitic *augen gneiss* of Moskenesøy, with feldspar "eyes" 2-3 cm long,
  interbanded with darker biotite-rich dioritic gneiss.
  (D: NGU bedrock map 1:250 000, WMS `BerggrunnWMS3`; text: Green & Jorde,
  NGU 270)
- **A 2-4 km wide strip from Hamnøy north** (the east side of the fjord
  mouth), ~12 % — gneiss of variable composition, fine-grained, migmatitic:
  dark grey with irregular veins of coarser "granitic" material, 2800-1770 Ma.
  (D: same map; text: Green & Jorde describe exactly this strip)
- **Gabbro / ferrogabbro**, small bodies, <1 % — dark. Late dolerite and
  pegmatite dykes cut everything.
- **Offshore in Vestfjorden** (~8 % of the box, under the sea): Lower
  Triassic sedimentary rock, 252-247 Ma.
- Setting: the Lofoten-Vesterålen Precambrian high-grade (granulite)
  province, the AMCG suite (anorthosite-mangerite-charnockite-granite);
  Baltica's lower crust, the lower plate in the Caledonian collision.

## Landforms

- Fretted alpine relief carved by Quaternary glaciers: sharp peaks (to
  1029 m, Hermannsdalstinden; the height model's maximum in the area is
  1023 m), cirques, glacial troughs that became the fjords, ridges that
  follow the fracture systems. Cirque moraines from the end of the last
  glaciation (Allerød-Younger Dryas, ~13 400-11 700 years ago).
- Strandflat (the low wave-cut platform with skerries) off the coast.
- Loose deposits (D: NGU superficial deposits map, WMS `LosmasserWMS2`),
  share of the area:
  - bare rock (`130`) 83 %
  - scree / rockfall material (`081`, talus cones under the walls) 9.1 %
  - moraine, continuous (`011`) 2.9 %; thin or patchy (`012`) 1.2 %; end
    moraine (`015`) 0.4 %
  - marine beach deposits (`042`) 0.7 %
  - weathered material (`070`) 0.6 %
  - wind-blown sand, dunes (`060`) 0.3 % — the dunes at Bunes beach
  - the flat lakes are in the height model

## Sea and sea floor

- Depths (D, already in the game): EMODnet Bathymetry; Reinefjorden basin
  to ~155 m, Vestfjorden to ~250 m.
- Detailed Norwegian marine base maps (2-10 m depth grids, sea-floor grain
  size, habitats; NGU `MarineGrunnkartWMS`) **do not cover Reine yet** — the
  sea-floor types below are the usual pattern, not mapped data: mud in the
  deep basins, sand / gravel / shell sand in the shallows, bare rock on the
  steep sides.
- Tide (D: Kartverket tide API, Reine is predicted from Bodø +10 min, factor
  1.01): semi-diurnal; mean sea level 1.71 m above chart datum; mean high
  water springs 2.90 m, mean low water springs 0.52 m (spring range about
  2.4 m, neap range about 1.2 m); highest astronomical tide 3.41 m.
  Example: 8 Nov 2026, low 0.72 m 04:44 UTC, high 2.99 m 10:51 UTC.
- Moskstraumen, one of the strongest tidal current systems in the world,
  runs between Lofotodden and Mosken, south-west of the area.

## Life

- Shore: the intertidal is dominated by wracks (Fucus); knotted wrack
  (Ascophyllum) only in sheltered places such as the harbour.
- Below the tide: kelp forest (Laminaria hyperborea) on rock, densest near
  the top and thinning with depth to a kelp "park"; Lofoten is near the
  northern end of these forests; sea urchins graze the lower edge.
- Land: few trees — downy birch and rowan in sheltered lowland pockets, no
  native conifers; heath (heather, crowberry, bilberry) with lichens, moss
  and grass; alpine plants down to the shore.
- Fishery: the Lofoten fishery for spawning Arctic cod (skrei) in
  Vestfjorden in late winter; the cod dries on wooden racks (hjell) from
  about February to May into stockfish.

## People and buildings

- 791 buildings in the 10 x 11 km area (D: Kartverket Matrikkelen building
  points, WFS, with type codes): detached houses 262, garages and sheds 113,
  rental cabins (largely the red rorbuer) 85, holiday homes 65, boathouses
  (naust) 47, fishery buildings 44, rorbu / sel 14, plus stores, shops,
  other accommodation.
- Settlements: Reine (municipal centre of Moskenes), Hamnøy, Sakrisøy and
  the islets; Kjerkfjorden, Vindstad and Bunes inside the fjord.

## Light and climate

- 67.9° N: midnight sun about late May to mid July, polar night about early
  December to early January (sources differ by a few days).
- Mild for the latitude (the Norwegian Atlantic Current); frequent south-
  westerly gales in Vestfjorden.

## Sources

- T. H. Green & K. Jorde, *Geology of Moskenesøy, Lofoten, North Norway*,
  NGU 270: https://static.ngu.no/FIleArchive/NGUPublikasjoner/NGUnr_270_Green_47_76.pdf
- NGU report 2005.086 (Lofoten geology, landforms):
  https://static.ngu.no/filearchive/227/2005_086.pdf
- NGU map services: https://geo.ngu.no/mapserver/BerggrunnWMS3,
  https://geo.ngu.no/mapserver/LosmasserWMS2,
  https://geo.ngu.no/mapserver/MarineGrunnkartWMS
- Kartverket tide API: https://vannstand.kartverket.no/tideapi.php
- Kartverket Matrikkelen building points (WFS):
  https://wfs.geonorge.no/skwms1/wfs.matrikkelen-bygningspunkt
- Kartverket height model and EMODnet Bathymetry: see README.
- Lofoten (overview): https://en.wikipedia.org/wiki/Lofoten ;
  Moskstraumen: https://en.wikipedia.org/wiki/Moskenstraumen
- Kelp in the Nordic seas: https://cordis.europa.eu/article/id/441973-where-and-how-big-are-the-nordic-kelp-forests
- University of Oslo, benthic macrophytes:
  https://www.mn.uio.no/ibv/english/research/sections/aqua/groups/marine-botany/benthic-macrophytes.html
- Flora of the Lofoten islands: https://rando-lofoten.net/en/660-flora-of-the-lofoten-islands
- Stockfish tradition (Norwegian intangible heritage):
  https://www.immateriellkulturarv.no/en/bidrag/the-cultural-and-culinary-traditions-of-stockfish/
- Seasons in Lofoten: https://www.68north.com/info/seasons-on-lofoten/
- MAREANO: https://www.mareano.no/en/about_mareano
