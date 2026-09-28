# Procedural City (Three.js + Vite)

```bash
npm install
npm run dev
```

Controls: WASD move · Shift sprint · Space jump · E boost jump (reach rooftops) · drag to orbit · N day/night · R new random city.

## Layout

- `src/city/CityGenerator.js`: seeded generation of roads, blocks, lots, massing and names (`generate()`, pure data), then chunked `InstancedMesh` rendering with a procedural facade shader (`build()`).
- `src/city/CityCollision.js`: static AABB world on a uniform XZ grid: `queryAABB`, `queryPoint`, `groundHeight`, `resolveSphere`, `resolveCapsule`, `raycast` (2D DDA). No three.js dependency.
- `src/city/random.js`: deterministic RNG with forkable sub-streams.
- `src/city/names.js`: generic street, district and city names.
- `src/main.js`: renderer, lights, day/night, a test player capsule, HUD, resize and the animation loop.

## Using the collision data

```js
const city = new CityGenerator({ seed: 'my-seed' }).create();
scene.add(city.group);

// every frame, for a character whose position is its feet:
city.collision.resolveCapsule(pos, 0.4, 1.8, 0.45);  // push out of walls
pos.y = Math.max(pos.y, city.collision.groundHeight(pos.x, pos.z, pos.y + 0.45));

// every building part is also in city.data.buildings[i].parts as {minX,minY,minZ,maxX,maxY,maxZ}
```
