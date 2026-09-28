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
N day/night · P post-processing on/off · R respawn · H hide the controls line.

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
  and eases out slowly. It pulls back and widens the FOV (+14°) with glide speed.
- `src/player/PlayerProxy.js`: the stand-in, a capsule with a nose plus a striped tallit
  that hangs behind on the ground and spreads like wings in a glide, fluttering with speed.
  A rigged model replaces it by providing `object3D` and `update(snapshot, dt)`.
- `src/player/GlideEffects.js`: wind streaks that stream past during fast glides.

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
  late-afternoon sun (45° elevation, west-south-west, `#FFF3E0`) with 4 cascaded shadow maps
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
  (controller + camera + proxy + effects), keyboard input and the HUD (street,
  neighbourhood, player state and speed, touched building).

## Using the collision data

```js
const osm = await (await fetch('data/jerusalem_data.json')).json();
const city = new CityGenerator({ osm }).create();
scene.add(city.group);

// every frame, for a character whose position is its feet:
city.collision.resolveCapsule(pos, 0.4, 1.8, 0.45);  // push out of walls
pos.y = Math.max(pos.y, city.collision.groundHeight(pos.x, pos.z, pos.y + 0.45));
```
