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
N day/night · C free camera (WASD fly, Q/E down/up, Shift fast, wheel speed) · M mute the
wind · B hide the stats panel · P post-processing on/off · R respawn · H hide the controls line.

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
