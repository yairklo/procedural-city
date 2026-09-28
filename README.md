# Jerusalem City (Three.js + Vite)

A walkable 3D section of central Jerusalem (Jaffa St / Mahane Yehuda / King George,
bbox `31.778,35.210 – 31.788,35.225`) built from real OpenStreetMap data.

```bash
npm install
npm run fetch-data   # one-time: downloads OSM data to public/data/jerusalem_data.json
npm run dev
npm test             # node:test suite (synthetic data + the real data file when present)
npm run build
```

Controls: WASD move · Shift sprint · Space jump · E boost jump (reach rooftops) · drag to orbit · N day/night · P post-processing on/off · R respawn.

## Data

`scripts/fetch_jerusalem.js` queries the Overpass API once for `building=*` (ways and
multipolygon relations, with courtyards), `highway=*`, parks, `natural=tree` and
neighbourhood names, and writes a compact pre-parsed JSON (flat `[lat, lon, ...]` rings).
The app then runs fully offline. If Overpass is unreachable, save a response yourself and
convert it with `node scripts/fetch_jerusalem.js --from raw.json`.

**License:** map data © OpenStreetMap contributors, ODbL 1.0. The game must show the
attribution (the HUD does). The JSON file is a derivative database: if you distribute it
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
    trees as chunked `InstancedMesh`es. About 45 meshes in the scene. Counting
    the shadow cascades and the AO normal pass, a frame is roughly 350 draw calls.
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
- `src/city/geo.js`: lat/lon → local meters (+X east, −Z north, origin at the bbox center).
- `src/city/footprint.js`: polygon helpers and `decomposeFootprint()`, which turns any
  footprint (rotated, concave, with holes) into axis-aligned boxes for collision.
  The boxes match the real walls to within `collisionStep / 2` (0.3 m).
- `src/city/CityCollision.js`: static AABB world on a uniform XZ grid: `queryAABB`,
  `queryPoint`, `groundHeight`, `resolveSphere`, `resolveCapsule`, `raycast`.
- `src/main.js`: loads the data, then sets up the renderer, lights, day/night, the test
  player capsule and the HUD (street name, neighbourhood, touched building).

## Using the collision data

```js
const osm = await (await fetch('data/jerusalem_data.json')).json();
const city = new CityGenerator({ osm }).create();
scene.add(city.group);

// every frame, for a character whose position is its feet:
city.collision.resolveCapsule(pos, 0.4, 1.8, 0.45);  // push out of walls
pos.y = Math.max(pos.y, city.collision.groundHeight(pos.x, pos.z, pos.y + 0.45));
```
