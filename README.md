# Jerusalem City (Three.js + Vite)

A walkable 3D section of central Jerusalem (Jaffa St / Mahane Yehuda / King George,
bbox `31.778,35.210 – 31.788,35.225`) built from real OpenStreetMap data.

```bash
npm install
npm run fetch-data   # one-time: downloads OSM data to public/data/jerusalem_data.json (legacy centre)
node scripts/fetch_tiles.js --phase 1   # one-time: OSM tiles to public/data/tiles/ (rerun to fill gaps)
node scripts/fetch_elevation.js --mode points   # one-time: terrain to public/data/tiles/dem_points.json
npm run dev
npm test             # node:test suite (synthetic data + the real data file when present)
npm run build
```

Controls: WASD move (camera-relative) · Shift run · Space jump (hold for higher) · jump
toward a ledge to mantle onto it · **hold Space in the air to glide** (W dive, S climb, A/D
or mouse to steer) · click for mouse look (or drag), wheel zoom · E debug super-jump ·
N day/night · L festival lighting · C free camera (WASD fly, Q/E down/up, Shift fast, wheel speed) · M mute the
wind · B hide the stats panel · G minimap · P post-processing on/off · R respawn · H hide the controls line.

## Living city (Phase 4)

Everything is batched into a few `InstancedMesh`es (one per kind, not one per agent), so
the street life costs about ten draw calls per pass.

- `src/city/RoadNetwork.js`: a navigation graph built from the roads of the near and medium
  cells. Vertices at the same spot (OSM junctions, tile cuts) are merged, so agents cross
  junctions and tile borders. `main.js` rebuilds it when cells change level (at most twice
  a second). Agents keep their place: `match(edge)` finds the same road segment in the
  new graph.
- `src/city/PedestrianSystem.js`: up to 220 walkers on the sidewalks around the camera. They
  are spawned and simulated within 80 m, and instances beyond 80 m are culled.
  - Looks: one instanced low-poly body with ±12% scale and per-instance clothing colours.
    The legs and arms swing in the vertex shader, each instance with its own phase.
  - Groups: about 60% walk in groups, either pairs side by side or a leader with trailing
    followers. Followers replay the leader's breadcrumb trail 0.5 s behind it (per place
    in the line). In narrow streets or turns faster than 30°/s, pairs close up into
    single file (lateral "accordion").
  - Flee: a hard landing, or the player gliding or falling fast within 4 m of the street,
    scatters everyone within 4 m. They run at double speed away from the impact with a
    random spread, calm down after 3 s and walk back to the sidewalk.
- `src/city/TrafficSystem.js`: cars and vans on asphalt roads.
  - Driving: right-hand lanes, one-way streets obeyed at junctions, headway to the car in
    front, slowing for junctions, and stopping for the player standing in the lane.
  - Lights: additive headlight cones and ground light pools, and red tail lights.
  - Light rail: an articulated five-module tram on Jaffa Road. It follows the longest
    chained Jaffa polyline and accelerates and brakes smoothly for junctions (4 m/s),
    stations (every ~350 m, 10 s dwell) and the termini, where it reverses. It also stops
    for the player on the track. The modules are solid (collision group `tram`).
- `src/city/StreetProps.js`: black iron lanterns along the streets (their warm pools light
  the paving at night), stone benches, bollards at pedestrian malls, cypresses and olive
  trees, instanced per cell, with collision boxes.
- Day / night (N): a low golden-hour sun by day. By night there is a sky with stars,
  randomly lit amber windows, lamp and headlight pools on the ground, and glowing
  headlights on cars and the tram.
- Traversal feedback: the FOV widens from 60° to 75° with speed in glides and fast falls,
  and wind streaks stream past on high-speed descents. `src/audio/WindAudio.js` is
  procedural Web Audio: looped white noise through a band-pass "rush" and a narrower
  "whistle" band, with a slow gust LFO, mixed and pitched by speed. It needs no audio
  files and starts on the first key press or click.
- `src/ui/BenchmarkHUD.js` (top right): FPS, frame time (average and worst of the last
  0.25 s), draw calls and triangles (all passes), plus active buildings, vehicles and
  pedestrians, and the key legend. With street life running, the real data measures about
  310–330 draw calls per frame at street level, day or night.
- `src/player/FreeCamera.js` (C): fly anywhere. The player waits, and the world streams in
  around the camera.

## Street polish, minimap, atmosphere

- Worn, polished paving (`src/city/footfall.js`): as cells load, their roads are painted into
  a coarse "footfall" map, the green channel of the ground mask (16 m texels).
  - The painting is weighted by class. Pedestrian malls and squares score highest, then
    footways and living streets, then main-street sidewalks; quiet streets score little.
  - Where footfall is high, the ground shader polishes the slab tops (roughness down to
    ~0.35, slightly darker and warmer, the joints stay rough). Each slab also gets its own
    slight tilt, so in the low golden-hour sun the glints jump from slab to slab as the
    camera moves.
  - Pedestrian streets always count as busy.
  - Asphalt gets smoother binder patches and the odd sparkling grain.
- Awnings (`src/city/Awnings.js`): fabric canopies over ground-floor shopfronts.
  - They use the facade shader's 4.2 m shop-bay grid, so each one sits between the glazing
    and the sign band of a real shopfront.
  - Only walls facing a street get them, and not where a hillside sidewalk has climbed over
    the shop floor.
  - Colours: striped dark red, green or navy with off-white, or solid terracotta, canvas,
    green or red.
  - Two instanced meshes per nearby cell (striped / solid). The centre data gets about 675.
- Minimap (`src/ui/Minimap.js`, bottom left, G toggles): a round, north-up GPS map drawn by
  the game from the loaded OSM data, with no map images.
  - Shows streets in dark slate `#2A2D34`, building footprints in translucent `#E0DCD3`, the
    Jaffa Road light rail in teal, and the player as a heading arrow.
  - `worldToUV` places points in the geographic box S 31.778 / W 35.210 / N 31.788 /
    E 35.225, through the game's projection.
  - The map is drawn into an offscreen canvas around the player, a few cells per frame
    within a ~2.5 ms budget, and redrawn in a second canvas that is swapped in. A frame only
    copies a window and draws the arrow: no per-frame allocations.
- Bloom (`src/render/postprocessing.js` `BLOOM`) is calibrated against the scene's
  linear-HDR levels:
  - By day the threshold is 2.4. Sunlit stone (~2) doesn't bloom; the gold dome and
    polished-paving glints do.
  - At night the threshold is 0.95 with a tighter radius and a soft knee. Lanterns (~3),
    headlights (~4), tail lights and lit shops and windows (~1) get clean halos, while
    floodlit stone (< 0.6) stays crisp.
- Dust motes (`src/render/DustMotes.js`): 700 warm specks drifting in a 22 m box around the
  camera, brightest when you look toward the sun, barely visible at night. One draw call,
  animated entirely in the shader, and hidden from the ambient-occlusion pass.

## Player: traversal and tallit gliding

The character is split so the stand-in can be swapped for a rigged model without touching
the gameplay:

- `src/player/PlayerController.js`: pure logic (no three.js; runs in node tests). It
  simulates at a fixed 120 Hz against `CityCollisionWorld` and has states `ground`,
  `slide`, `air`, `glide` and `mantle`.
  - Ground: probes the terrain at the center plus box tops around the capsule rim (a
    sphere-cast stand-in), snaps down slopes and small steps (0.4 m), and slides on slopes
    over 45°. Acceleration and deceleration are smooth, facing turns toward the movement,
    and uphill is slower.
  - Jump: holding Space longer jumps higher (about 0.7 m tap, 1.9 m full); coyote time and
    jump buffering are 0.12 s each.
  - Mantle: jumping toward a wall whose top is up to 1.5 m above the feet, with room to
    stand, climbs onto it.
  - Glide: gravity is at 25%. The flight path follows the tallit's pitch, and diving turns
    height into speed (quadratic drag, ~35 m/s top speed in a steep dive). Hands-off it
    cruises at ~12 m/s, sinking ~3 m/s. A/D turn and the mouse pulls the heading along.
    Hitting a wall stalls you.
  - `snapshot()` returns plain data. Events (`jump`, `land`, `glideStart`, `glideEnd`,
    `mantleStart`, `mantleEnd`, `state`) are for animation and sound.
- `src/player/PlayerCamera.js`: third-person orbit with pointer lock or drag and zoom. It
  drifts behind the character when the mouse is idle (faster while gliding). For
  occlusion it casts a ray against the collision world and the terrain: it pulls in fast
  and eases out slowly. It pulls back in glides and widens the FOV from 60° to 75° with
  speed in glides and fast falls.
- `src/player/CharacterModel.js`: the player character, `public/models/character.glb`
  (1.8 m, 32k triangles, 66 bones; meshopt-compressed geometry and WebP textures, loaded
  with `GLTFLoader` + `MeshoptDecoder`). It has the same interface as the proxy.
  - Clips: `idle` / `run` on the ground. The run cycle is in place, so its playback rate
    follows the ground speed (clip speed 4.4 m/s). `jump` starts on the jump event, after
    the crouch, because the controller takes off at once. `fall` plays when dropping fast,
    and `glide` plays in a glide, tilted with the flight path and banked into turns
    around the hips.
  - Crossfades are 0.15–0.22 s, because the tallit is baked per clip.
  - The capsule proxy stays on screen until the model has loaded, or if it fails to load.
- `src/player/PlayerProxy.js`: the stand-in, a capsule with a nose plus a striped tallit
  that hangs behind on the ground and spreads like wings in a glide, fluttering with speed.
  A rigged model replaces it by providing `object3D` and `update(snapshot, dt)`.
- `src/player/GlideEffects.js`: wind streaks that stream past during fast glides and falls.

## Performance

Open the app with `?bench` (or `?bench&night`) to run a fixed 24-second camera benchmark:
street level, rooftop level and aerial orbits around the spawn point. The HUD then shows,
per phase, average fps, median / p95 frame time, 1% lows, draw calls and triangles per
frame, plus the GPU name. The same numbers are on `window.benchResult`. The in-editor
preview pane throttles frames, so measure in a normal browser tab on the target machine.

Budget per frame (all passes: 4 shadow cascades, AO normal pass, main pass), measured on the
real data: about 175 draw calls and 1.9M triangles (was 356 / 6.8M before the performance
pass). The main pass alone is about 37 draw calls. What keeps it there:

- Rooftop props (8k solar heaters, 5.7k AC units) were ~95% of shadow-casting triangles.
  Each heater is one merged instanced geometry (6-sided tank + collector + frame). Props sit
  in 250 m chunks that are hidden beyond 450 m, and they cast shadows only in the two
  nearest cascades.
- GTAO runs at half resolution and doesn't re-render the shadow maps for its normal pass.
- Terrain: an 8 m grid only over the city, 32 m for the surroundings. Curbs are thin edge
  bands, not full-width ribbons.
- Terrain lookups read a pre-baked 2 m bicubic grid; city build takes about 1.4 s in total.

## Data

`scripts/fetch_jerusalem.js` queries the Overpass API once for `building=*` (ways and
multipolygon relations, with courtyards), `highway=*`, parks, `natural=tree` and
neighbourhood names, and writes a compact pre-parsed JSON (flat `[lat, lon, ...]` rings).
The app then runs fully offline. If Overpass is unreachable, save a response yourself and
convert it with `node scripts/fetch_jerusalem.js --from raw.json`.

### Old City landmarks and the Temple Mount

`scripts/fetch_landmarks.js` downloads the Old City from the OSM API and writes
`public/data/landmarks.json`, which the hand-built models in `src/city/landmarks/` read.
Those models replace the generic buildings with the same OSM ids (`replaces`). The data covers:
the walls and gates, the Western Wall and its plaza, the Tower of David and the Holy
Sepulchre. It also has `haram`, the buildings on the Temple Mount esplanade
(`src/city/landmarks/haram.js`):

- The raised platform around the Dome of the Rock, 4 m above the esplanade (744.5 m). Its
  outline is the hull of the eight arcades (qanatir), which stand at the top of its stairs.
  It is a terrain patch like the esplanade, so walking, collision and buildings all follow
  it. Under each arcade there is a flight of 0.25 m steps.
- The Dome of the Rock:
  - the octagon: marble below, blue tilework above, arched windows, four porches;
  - the lead roof ring;
  - the tiled drum with 16 windows;
  - the gold dome with its crescent finial.
- al-Aqsa: the hall with a raised nave and lead gable roof, the seven-arch portico on the
  north facade, and the grey dome over the qibla end.
- The Dome of the Chain: open rings of columns, a tiled drum and the dome.
- The eight small domes: open column pavilions, or closed square and octagonal buildings.
- Four minarets: the square Mamluk towers, and the round Ottoman shaft at Bab al-Asbat.
  The Fakhriyya and Bab al-Silsila minarets stand on their mapped OSM nodes. Bab
  al-Ghawanima and Bab al-Asbat are not mapped, so they stand at approximate positions next
  to their gates, flagged `approximate`.
- Groves: grass and olive trees in the mapped gardens and groves. The mapped trees
  themselves are planted by the city.

The three new materials (glazed tiles, gold leaf and marble panels) are styles of the
shared landmark shader (`materials.js`), so the whole compound is a single mesh. On the
esplanade, buildings without a mapped height are built at one storey with no shopfronts.

### The Knesset, the Chords Bridge, the Mount of Olives and Mount Scopus

These are also in `landmarks.json` (`modern`, `olives`, `scopus`), built by
`src/city/landmarks/modern.js` and `hills.js` with the shared kit (`kit.js`: arches,
arcades, windows, domes, finials, tubes).

- The Knesset (the mapped outline, OSM w551414758):
  - a stone podium that levels the hilltop;
  - a colonnade of tall square stone piers on all four sides, carrying a deep flat roof slab;
  - the stone core with vertical slit windows and a glazed ground floor;
  - the plenum hall's lantern with its low pleated roof;
  - a broad entrance stair with flag poles (Israeli flags, the Star of David as an outline);
  - the bronze Knesset Menorah facing the building (seven branches, three pairs of arms as
    half-circles);
  - the office wing next to it (a relation with courtyards), low and built into the slope,
    with window bands.
- The Chords Bridge:
  - a 270 m curved deck with a tram lane and rails, glass-railed walkways and a white box
    girder on slender piers. The deck line is the centre line between the two mapped
    light-rail tracks on the bridge (w75517167, w255019640), chained end to end;
  - the deck rises 7 m over the junction and meets the street at both ends, and it is
    walkable end to end (1 m collision pieces);
  - the 118 m pylon leans 24 degrees back from the span and tapers, with a slight bow;
  - 66 cables fan from its upper half to the deck edge, and the curve of the deck twists them
    into a harp.

  The junction under the bridge is a flat terrain patch at road level, like the Western Wall
  plaza. Its level is the median of the DEM under the middle of the deck (805.4 m), so the
  Central Bus Station's hump in SRTM, just east of the bridge, doesn't reach the roads below.
  The bridge lies just west of the tiled world, so no streets are drawn around it.
- The Mount of Olives:
  - the Jewish cemetery: ~28,000 limestone slabs in rows along the contours, long axis down
    the slope toward the Temple Mount, inside the mapped cemetery outline (w30913757). They
    form one instanced mesh that receives shadows but casts none, and they skip the mapped
    buildings and the roads and paths through the cemetery (`olives.cemetery.exclude`);
  - the Church of Mary Magdalene with seven gilded onion domes;
  - the Church of All Nations, with its portico, gold mosaic pediment and twelve domes;
  - Absalom's Tomb (cube, drum and concave "hat") and the Tomb of Zechariah (pyramid);
  - the Russian bell tower of the Ascension, the Chapel of the Ascension in its court, and
    the Seven Arches Hotel.
- Mount Scopus: the Hebrew University tower with campus blocks, and Augusta Victoria (the
  church and its bell tower).

The full `node scripts/fetch_landmarks.js` downloads small areas around each landmark
(`EXTRA_BBOXES`) and takes mapped geometry by name or structure. It also reads the buildings in
the tile files, so the cemetery's `exclude` list and the replaced ids see every mapped building.
`--save-raw <file>` keeps the downloaded OSM data, and `--raw <file>` re-extracts from it
without network access.

- From the map: the Knesset outline and its office wing (the building multipolygon
  r6183664, with its courtyards), the Knesset Menorah (a node), the bridge deck, the
  cemetery outline, Mary Magdalene, All Nations and the two tombs.
- The ridge models at mapped positions:
  - the Russian bell tower (the 64 m bell tower in the Convent of the Ascension);
  - the Chapel of the Ascension;
  - the Seven Arches Hotel (its buildings' centroid);
  - the Hebrew University tower (Har Hatzofim Tower);
  - the Lutheran Church of the Ascension at Augusta Victoria.

  Their generic OSM buildings are replaced, including the Augusta Victoria courtyard building
  that the church stands in.
- Still approximate (`approximate: true`):
  - the bridge's pylon: not mapped. It stands where the straighter Herzl end of the deck meets
    the curve, on the inside;
  - the junction patch.

  Approximate ridge towers (only in `--from-tiles` data) are placed on the highest ground
  within 40 m. Mount Scopus is north of the tiled world, so the campus blocks around the tower
  are procedural.

The terrain now extends beyond the tiles, to Mount Scopus, the Chords Bridge and the
Mount of Olives ridge (`dem_points.json`, SRTM 30 m:
`node scripts/fetch_elevation.js --mode points --source terrarium --bbox 31.765,35.196,31.798,35.256`).
Inside the old area the heights are unchanged, and the datum is the same. The coarse
surroundings mesh has skirts, so steep real terrain at the world edge leaves no cracks.

### Landmarks at night

Each landmark mesh carries a night-lighting profile (`aLight`: the height above its own
ground, and the profile; `LIGHT` in `geometry.js`), and the landmark shader floodlights it
the way the real places are lit:

- `sodium`: the Old City walls, the gates, the Citadel and the Temple Mount's retaining
  walls. Warm yellow uplights at the foot of the walls: bright low, fading with the height,
  so the walls glow gold over the Hinnom and Kidron valleys.
- `warm`: the Temple Mount buildings, the Western Wall and the churches, in warm white.
  Floodlit gold (the Dome of the Rock) blazes.
- `white`: the Knesset and the Chords Bridge, in cool white.
- `dark`: the Mount of Olives cemetery stays dark.
- Festival (the L key), as for the Light Festival and national days: the walls become a
  projection screen, with blue-and-white bands rising up them, then colour fields sweeping
  along with twinkling points.

The Chords Bridge light show (`bridgeLights.js`). The real bridge has 14,400 LEDs on 58 of
its 66 cables and plays clips and messages on them. Here the cables are a pixel screen too:
across the strings, and along each one, with 248 LEDs per lit string (the eight shortest
cables stay dark). Programmes of 16 s crossfade into each other:

1. a harp whose strings are plucked in turn;
2. the flag, with the Star of David outlined across the strings;
3. a rainbow sweep;
4. sparks racing up to the pylon;
5. ripples from the middle;
6. "ירושלים · JERUSALEM" scrolling across the strings.

The cables are their own mesh: white steel by day, glowing LEDs at night (with bloom).

Around the walls, a few rules keep the generic buildings believable:

- A footprint that straddles a platform's retaining wall no longer takes its floor from the
  foot of the wall and its roof line from the platform (that made 20 m towers along the
  Temple Mount walls). If the centroid is on the platform, the building stands on it, and a
  mapped height measured from the foot of the wall loses the drop. If the centroid is off
  the platform, the building stands below the wall. (`footprintGround` in `terrain.js`.)
- Tombs, monuments and ruins (Absalom's Tomb, the Monolith of Silwan) are solid stone
  without windows. Churches, mosques and synagogues are one tall volume with few windows
  and no shops. (`buildingClass` in `CityGenerator.js`.)
- Silwan and the City of David, and the Kidron Valley with the Mount of Olives slope, are
  low-rise areas (2-3 storeys). OSM has no outlines for these villages: Silwan is only a
  place node, and just the City of David ridge has a small residential area. So the outlines
  are approximate boxes (`lowRise` in landmarks.json, flagged `approximate`).
- The tiles now reach the Mount of Olives ridge (columns i = 6-7: At-Tur, Ras al-Amud, the
  ridge road), fetched with `node scripts/fetch_tiles.js --tiles 6_0,...,7_4 --source osm-api`.

Without network access, `node scripts/fetch_landmarks.js --from-tiles` rebuilds `haram`
from the tile files. Tiles have no nodes and no land-use areas, so in that mode all
minarets are approximate and the only groves are the mapped gardens.

### Tiled world (what the game loads)

`public/data/tiles/`:

- `manifest.json` (`tiles-v1`): `worldBBox`, the grid (tile `(i, j)` covers lon
  `[west + i·dLon, +dLon)`, lat `[south + j·dLat, +dLat)`, i east, j north), the list of tiles
  that exist, phases and place names.
- `osm_<i>_<j>.json`: the same format as `jerusalem_data.json`, one per listed tile. Buildings
  and parks belong to the tile containing their centroid; roads are cut at tile borders.
- `dem_points.json` (`dem-points-v1`): Copernicus 90 m DEM control points for the whole world
  (574–833 m), interpolated with Catmull-Rom. It replaces `jerusalem_elevation.json` and
  `jerusalem_dem_points.json`, which the game no longer reads.

`src/world/TileWorld.js` streams it:

- One projection for everything: `createProjection(manifest.worldBBox)`, with a fixed origin at
  the world centre. Adding tiles never moves anything.
- Every grid cell gets its content from, in order: its manifest tile; else the legacy
  city-centre file (`jerusalem_data.json`), keeping only the features whose centroid (roads:
  midpoint) falls in that cell; else nothing (terrain only). Legacy features in cells that
  have a tile are skipped, so there are no duplicates, and a new tile takes over its cell
  with no code change. A tile listed but missing or broken shows terrain only.
- Levels by distance from the player (with 120 m hysteresis): near ≤ 500 m (full detail and
  collision), medium ≤ 1200 m (simplified buildings, roads, no props or collision), far ≤ 2600 m
  (building silhouettes), otherwise unloaded. Collision boxes are added and removed per cell
  (`CityCollisionWorld.add(box, group)` / `removeGroup`). City data stays cached; meshes are
  rebuilt at most one cell per frame.
- The terrain is always there: one grid per cell (8 / 16 / 32 m by level, with skirts that
  hide cracks between levels), plus coarse terrain around the world. The ground shader shows
  paving where there is city data and hillside elsewhere, using a mask texture.
- Spawn: on Jaffa Road while the legacy data is loaded, otherwise on a street in a loaded tile.
- Ownership rules (vertex average, half-open bounds, road cutting) are shared with the pipeline
  in `src/city/tiling.js`; legacy data is partitioned with the very same functions.
- Cells are generated and built in a web worker (`src/world/cellWorker.js`, via
  `WorkerCellBackend`): the worker returns light lookup data (colliders, roads, building
  records) and geometry as transferred buffers, and the main thread only assembles meshes.
  Node tests use the same-thread `LocalCellBackend`.
- Far and unloaded cells share one merged coarse terrain mesh (one draw call).

**License:** map data © OpenStreetMap contributors, ODbL 1.0; elevation data as named in
`dem_points.json` (Copernicus DEM GLO-90 © DLR e.V. / ESA, CC BY 4.0). The game must show
the attribution (the HUD does). The JSON file is a derivative database: if you distribute it
(it ships inside the web build), it must stay available under the ODbL. Get legal review
before a commercial release.

## Layout

- `src/city/CityGenerator.js`
  - `generate()` (pure data): projects footprints, resolves heights (OSM `height` →
    `building:levels` → typical Jerusalem 3–6 stories), registers collision, places
    rooftop equipment, indexes roads and picks a spawn on a real street (Jaffa Road preferred).
  - `build()`: extrudes the real footprint shapes (walls, flat roofs, canopy undersides),
    merges them per 500 m chunk with `BufferGeometryUtils.mergeGeometries`, renders roads
    as ribbons along OSM lines, and draws solar water heaters (dud shemesh), AC units and
    trees as chunked `InstancedMesh`es (see Performance).
  - Jerusalem stone material: `MeshStandardMaterial` (limestone `#E4D8C8` to `#D6C5B2`,
    roughness 0.85) extended in the shader, in world space on any wall direction (no UVs):
    36 cm masonry courses with mortar joints, bevelled and chiselled block relief (normal
    perturbation), recessed rectangular or arched windows with sills and green, blue or
    wooden shutters, ground-floor shops with sign bands and roll-down shutters, and lit
    windows at night.
- Roofs: flat roofs get solar water heaters (dud shemesh) and AC units. Low (≤ 3 floor)
  buildings that OSM maps with a pitched roof, and whose footprint is close to a rectangle,
  get a hipped terracotta roof (`#A0432E` / `#B33B24`). Two stepped collision tiers let you
  stand on the roof without walking through it (377 of 1,282 buildings in the current data).
- Ground: stone-slab sidewalks, worn asphalt with gray (`#808080`) curb stones and dashed
  center lines on wider roads, dry-grass parks. All procedural shaders, merged per layer.
- `src/render/lighting.js`: physical sky (also the image-based ambient light), a
  golden-hour sun (32° elevation, west-south-west, `#FFDDB0`) with 4 cascaded shadow maps
  (CSM, 2048² each, out to 700 m), and a hemisphere fill (`#87CEEB` sky / `#D2B48C` ground).
- `src/render/postprocessing.js`: 4x MSAA HDR render → GTAO (ambient occlusion, 2.2 m radius,
  for contact shadows in streets and alleys) → bloom (highlights only) → warm color grade →
  vignette → ACES Filmic tone mapping.
- `src/render/surroundings.js`: the rest of the city around the modelled area. A distant
  skyline ring (~1.8 km out, rolling hills of low buildings) is a hazy ridge by day and a
  silhouette with scattered lit windows by night. A night sky dome has an orange
  light-pollution horizon and a few stars. At night the land between them fills with
  street lights (outer-ground shader).
- `src/city/terrain.js`: `heightAt(x, z)`, bicubic (Catmull-Rom) over the heightmap, pre-baked to a 2 m grid. The datum is the
  lowest sample, so y = 0 is 767 m above sea level. Outside the grid, heights ease to the
  mean edge height. Buildings stand on the lowest ground under their footprint, with
  foundations 0.6 m below it. Floors count from there and the roof line from the highest
  ground point, so downhill sides show an extra storey. Roads, sidewalks and parks are
  subdivided (edges ≤ 6 m) and draped over the terrain mesh (8 m grid). Collision uses the
  same function: `groundHeight` and `raycast` follow the terrain.
- `src/city/geo.js`: lat/lon → local meters (+X east, −Z north, origin at the bbox center).
- `src/city/footprint.js`: polygon helpers and `decomposeFootprint()`, which turns any
  footprint (rotated, concave, with holes) into axis-aligned boxes for collision.
  The boxes match the real walls to within `collisionStep / 2` (0.3 m).
- `src/city/CityCollision.js`: static AABB world on a uniform XZ grid: `queryAABB`,
  `queryPoint`, `groundHeight`, `resolveSphere`, `resolveCapsule`, `raycast`.
- `src/world/TileWorld.js`: the streamed tiled world (see Tiled world above). The per-cell
  building blocks live in `CityGenerator.js`: `generateCityChunk` (data), `buildCityChunk`
  (meshes per level), `createCityMaterials` (shared materials) and `createGroundMaterial`.
- `src/main.js`: loads the data, then wires the renderer, lights, day/night, the player
  (controller + camera + proxy + effects), street life (road network, pedestrians, traffic),
  wind audio, the free camera, keyboard input and the HUDs (street, neighbourhood, player
  state and speed, touched building; benchmark panel).

## Using the collision data

```js
const osm = await (await fetch('data/jerusalem_data.json')).json();
const city = new CityGenerator({ osm }).create();
scene.add(city.group);

// every frame, for a character whose position is its feet:
city.collision.resolveCapsule(pos, 0.4, 1.8, 0.45);  // push out of walls
pos.y = Math.max(pos.y, city.collision.groundHeight(pos.x, pos.z, pos.y + 0.45));
```
