import * as THREE from 'three';
import { TileWorld } from './world/TileWorld.js';
import { WorkerCellBackend } from './world/cellBackends.js';
import { createLighting, sunDirection } from './render/lighting.js';
import { createPostProcessing } from './render/postprocessing.js';
import { createSurroundings } from './render/surroundings.js';
import { createBenchmark, formatBenchmark } from './debug/benchmark.js';
import { PlayerController } from './player/PlayerController.js';
import { PlayerCamera } from './player/PlayerCamera.js';
import { PlayerProxy } from './player/PlayerProxy.js';
import { CharacterModel } from './player/CharacterModel.js';
import { GlideEffects } from './player/GlideEffects.js';
import { FreeCamera } from './player/FreeCamera.js';
import { RoadNetwork } from './city/RoadNetwork.js';
import { PedestrianSystem } from './city/PedestrianSystem.js';
import { RiggedPedestrians } from './city/RiggedPedestrians.js';
import { buildLandmarks } from './city/landmarks/LandmarkLayer.js';
import { buildHinnom } from './city/landmarks/hinnom.js';
import { buildSites } from './city/landmarks/sites.js';
import { TrafficSystem } from './city/TrafficSystem.js';
import { WindAudio } from './audio/WindAudio.js';
import { BenchmarkHUD } from './ui/BenchmarkHUD.js';
import { Minimap } from './ui/Minimap.js';
import { DustMotes } from './render/DustMotes.js';
import './style.css';

// ------------------------------------------------------------------------------------------------
// Renderer, scene, camera
// ------------------------------------------------------------------------------------------------

const container = document.getElementById('app');
const hud = document.getElementById('hud');

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.82;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.info.autoReset = false; // count every pass of a frame (shadows, AO, post)
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.3, 4000);

// ------------------------------------------------------------------------------------------------
// Lighting + day / night
// ------------------------------------------------------------------------------------------------

const lighting = createLighting({ renderer, scene, camera });
const post = createPostProcessing(renderer, scene, camera);
const surroundings = createSurroundings({ scene });
const dust = new DustMotes({ sunDirection: sunDirection() });
scene.add(dust.object3D);
post.noAO.push(dust.object3D);

let night = 0;
let nightTarget = 0;

function applyLook(t) {
  lighting.setNight(t);
  surroundings.setNight(t);
  post.setNight(t);
  dust.setNight(t);
  world?.setNight(t);
}

// ------------------------------------------------------------------------------------------------
// Player: controller (physics) + camera + stand-in visuals
// ------------------------------------------------------------------------------------------------

/** @type {PlayerController | null} */
let player = null;
/** @type {PlayerCamera | null} */
let playerCamera = null;
const proxy = new PlayerProxy();
const glideFx = new GlideEffects();
scene.add(proxy.object3D, glideFx.object3D);
proxy.object3D.traverse((o) => o.material && lighting.setupMaterial(o.material));
// The rigged character replaces the capsule stand-in once it has loaded.
const character = new CharacterModel();
/** @type {PlayerProxy | CharacterModel} */
let avatar = proxy;
character.load(`${import.meta.env.BASE_URL}models/character.glb`)
  .then(() => {
    for (const m of character.materials()) lighting.setupMaterial(m);
    scene.remove(proxy.object3D);
    scene.add(character.object3D);
    avatar = character;
  })
  .catch((err) => console.warn('[character] model failed to load, keeping the stand-in:', err.message));
const freeCam = new FreeCamera(camera, renderer.domElement);
const wind = new WindAudio();
const benchHud = new BenchmarkHUD(document.body);

const keys = new Set();
let boostQueued = false;
// Browsers only start audio from a user gesture.
window.addEventListener('pointerdown', () => wind.start());
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  keys.add(e.code);
  if (e.repeat) return;
  wind.start();
  if (e.code === 'KeyC') toggleFreeCam();
  if (e.code === 'KeyM') wind.toggleMute();
  if (e.code === 'KeyB') benchHud.toggle();
  if (e.code === 'KeyG') minimap?.toggle();
  if (e.code === 'KeyL') landmarkLayer?.setFestival?.(!landmarkLayer.festival); // ceremonial lighting on the walls
  if (e.code === 'KeyN') nightTarget = nightTarget > 0.5 ? 0 : 1;
  if (e.code === 'KeyR' && !freeCam.enabled) respawn();
  if (e.code === 'KeyP') post.enabled = !post.enabled;
  if (e.code === 'KeyE' && !freeCam.enabled) boostQueued = true; // debug super-jump to reach rooftops
  if (e.code === 'KeyH') showHelp = !showHelp;
});
let showHelp = true;
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

const held = (...codes) => codes.some((c) => keys.has(c));

/** C: fly the camera freely (the player waits where it is; the world streams around the camera). */
function toggleFreeCam() {
  if (!player) return;
  if (freeCam.enabled) {
    freeCam.disable();
    playerCamera.enabled = true;
    playerCamera.snapTo(player.snapshot());
  } else {
    playerCamera.enabled = false;
    freeCam.enable();
  }
}

function readInput() {
  const input = {
    moveX: (held('KeyD', 'ArrowRight') ? 1 : 0) - (held('KeyA', 'ArrowLeft') ? 1 : 0),
    moveY: (held('KeyW', 'ArrowUp') ? 1 : 0) - (held('KeyS', 'ArrowDown') ? 1 : 0),
    cameraYaw: playerCamera?.yaw ?? 0,
    cameraSteer: playerCamera?.steering ?? false,
    jump: held('Space'),
    sprint: held('ShiftLeft', 'ShiftRight'),
    boost: boostQueued,
  };
  boostQueued = false;
  return input;
}

// ------------------------------------------------------------------------------------------------
// City
// ------------------------------------------------------------------------------------------------

/** @type {TileWorld | null} */
let world = null;
/** @type {Minimap | null} */
let minimap = null;
const _mapDir = new THREE.Vector3();
const _mapPlayer = { x: 0, z: 0, yaw: 0 };

/** The minimap follows the player (or the free / benchmark camera, pointing where it looks). */
function updateMinimap(snap, flying) {
  if (!minimap) return;
  if (flying || !snap) {
    camera.getWorldDirection(_mapDir);
    _mapPlayer.x = camera.position.x;
    _mapPlayer.z = camera.position.z;
    _mapPlayer.yaw = Math.atan2(-_mapDir.x, -_mapDir.z);
  } else {
    _mapPlayer.x = snap.position.x;
    _mapPlayer.z = snap.position.z;
    _mapPlayer.yaw = snap.yaw;
  }
  minimap.update(_mapPlayer, world, traffic?.rail?.path.points ?? null);
}
/** @type {PedestrianSystem | null} */
let pedestrians = null;
/** @type {TrafficSystem | null} */
let traffic = null;

const DATA = `${import.meta.env.BASE_URL}data/`;
const getJson = async (url, { optional = false } = {}) => {
  const res = await fetch(url).catch((err) => ({ ok: false, status: err.message }));
  if (res.ok) return res.json();
  if (optional) return null;
  throw new Error(`${url}: HTTP ${res.status}`);
};

/** @type {ReturnType<typeof buildLandmarks> | null} */
let landmarkLayer = null;
/** @type {ReturnType<typeof buildHinnom> | null} */
let hinnomLayer = null;
/** @type {ReturnType<typeof buildSites> | null} */
let sitesLayer = null;

/**
 * Unmapped-height buildings: single storey, no shopfronts on the Temple Mount (small
 * fountains, porticoes, offices), 2-3 storeys in the rest of the Old City and in the
 * villages around it. The first area containing a building wins.
 */
function lowRiseAreas(landmarks) {
  const out = [];
  // Few windows: the madrasas and porticoes on the edges of the esplanade are mostly stone.
  if (landmarks.templeMount) out.push({ ring: landmarks.templeMount.outer[0], floorsMin: 1, floorsMax: 1, shops: false, windows: 0.3 });
  if (landmarks.oldCity) out.push({ ...landmarks.oldCity, facade: 'old' });
  // Villages around the Old City (Silwan, the Kidron, At-Tur): 2-3 storey houses.
  for (const a of landmarks.lowRise ?? []) out.push(a);
  return out;
}

async function loadWorld() {
  const [manifest, dem, legacy, landmarks, hinnom, sites] = await Promise.all([
    getJson(`${DATA}tiles/manifest.json`),
    getJson(`${DATA}tiles/dem_points.json`),
    // The old city-centre file stays as a "legacy" source until tiles cover it.
    getJson(`${DATA}jerusalem_data.json`, { optional: true }),
    // Old City landmarks (walls, gates, Western Wall, Tower of David, Holy Sepulchre).
    getJson(`${DATA}landmarks.json`, { optional: true }),
    // The Hinnom Valley: Mishkenot Sha'ananim, the windmill, Sultan's Pool, terraces.
    getJson(`${DATA}hinnom.json`, { optional: true }),
    // Markets and remaining landmarks: Mahane Yehuda, the Old City souks and infill, the Hurva,
    // the YMCA, the King David Hotel, Mamilla.
    getJson(`${DATA}sites.json`, { optional: true }),
  ]);
  // Landmark terrain patches (the esplanade, the plaza below the Western Wall) go into the
  // elevation data itself, so the main thread and the cell worker build the same terrain.
  if (landmarks?.patches?.length) dem.patches = landmarks.patches;
  if (hinnom?.patches?.length) dem.patches = [...(dem.patches ?? []), ...hinnom.patches];
  // Cell generation and geometry building run in a web worker (no hitches when cells stream
  // in); if workers are unavailable the world falls back to building on the main thread.
  let backend = null;
  try {
    const worker = new Worker(new URL('./world/cellWorker.js', import.meta.url), { type: 'module' });
    backend = (w) => new WorkerCellBackend(w, { worker, tileUrl: (file) => new URL(`${DATA}tiles/${file}`, window.location.href).href });
  } catch (err) {
    console.warn('[world] no web worker, building cells on the main thread:', err.message);
  }
  world = new TileWorld({
    manifest, dem, legacy, loadTile: (file) => getJson(`${DATA}tiles/${file}`), backend,
    // Buildings the landmark models replace are not generated from the map data.
    // Inside the Old City, buildings without a mapped height are low-rise (2-3 storeys).
    options: landmarks || hinnom || sites ? { city: {
      excludeBuildings: [...(landmarks?.replaces ?? []), ...(hinnom?.replaces ?? []), ...(sites?.replaces ?? [])],
      lowRiseAreas: [...(landmarks ? lowRiseAreas(landmarks) : []), ...(hinnom?.lowRise ?? []), ...(sites?.lowRise ?? [])],
    } } : {},
  });
  scene.add(world.group);
  if (landmarks) {
    try {
      landmarkLayer = buildLandmarks(landmarks, { projection: world.projection, terrain: world.terrain, collision: world.collision, uniforms: world.uniforms });
      for (const m of landmarkLayer.materials ?? [landmarkLayer.material]) lighting.setupMaterial(m);
      scene.add(landmarkLayer.group);
      console.info('[landmarks]', landmarkLayer.stats);
    } catch (err) {
      console.error('[landmarks] could not be built:', err);
    }
  }
  if (hinnom) {
    try {
      hinnomLayer = buildHinnom(hinnom, {
        projection: world.projection, terrain: world.terrain, collision: world.collision, uniforms: world.uniforms,
        props: { material: world.materials.props, olive: world.materials.geometries.olive, cypress: world.materials.geometries.cypress },
        show: landmarkLayer?.show, // same night-lighting clock and festival switch as the Old City
      });
      lighting.setupMaterial(hinnomLayer.material);
      // The groves only cast shadows into the near cascades, like the city's trees.
      hinnomLayer.group.traverse((o) => o.isInstancedMesh && lighting.nearShadowsOnly(o));
      scene.add(hinnomLayer.group);
      console.info('[hinnom]', hinnomLayer.stats);
    } catch (err) {
      console.error('[hinnom] could not be built:', err);
    }
  }
  if (sites) {
    try {
      const mats = world.materials;
      sitesLayer = buildSites(sites, {
        projection: world.projection, terrain: world.terrain, collision: world.collision, uniforms: world.uniforms, landmarks,
        show: landmarkLayer?.show, // the Old City's night-lighting clock
        props: { material: mats.props, olive: mats.geometries.olive, cypress: mats.geometries.cypress, awningGeometry: mats.geometries.awning, awningStriped: mats.awningStriped, awningSolid: mats.awningSolid },
      });
      lighting.setupMaterial(sitesLayer.material);
      lighting.setupMaterial(sitesLayer.goodsMaterial);
      // Stall goods and trees cast shadows into the near cascades only.
      sitesLayer.group.traverse((o) => o.isInstancedMesh && o.castShadow && lighting.nearShadowsOnly(o));
      scene.add(sitesLayer.group);
      console.info('[sites]', sitesLayer.stats);
    } catch (err) {
      console.error('[sites] could not be built:', err);
    }
  }
  lighting.setupMaterial(world.groundMaterial);
  lighting.setupMaterial(world.outerMaterial);
  for (const m of world.materials.list) lighting.setupMaterial(m);
  world.onChunkBuilt = (group) => group.traverse((o) => o.userData.detail && lighting.nearShadowsOnly(o));
  surroundings.setBaseHeight(world.terrain.meanEdge);
  world.setNight(night);

  hud.textContent = 'Loading Jerusalem…';
  const spawn = await world.findSpawn();
  player = new PlayerController(world.collision, spawn);
  character.bind(player);
  minimap = new Minimap({ projection: world.projection });
  playerCamera ??= new PlayerCamera(camera, renderer.domElement, world.collision);
  playerCamera.setCollision(world.collision);
  player.on('land', (e) => {
    lastLanding = { x: player.position.x, z: player.position.z, impact: e.impact, time: timer.elapsedTime };
    if (e.impact > 12) console.debug(`[player] hard landing ${e.impact.toFixed(1)} m/s`);
  });

  // Street life: pedestrians on the sidewalks, cars / vans and the light rail on the roads.
  pedestrians = new PedestrianSystem({ collision: world.collision });
  // Crowds in the markets, the souks, Mamilla and downtown.
  if (sitesLayer?.busyZones) pedestrians.setBusyZones(sitesLayer.busyZones);
  traffic = new TrafficSystem({ collision: world.collision, uniforms: world.uniforms, environment: scene.environment });
  traffic.setPoolMaterial(world.materials.pool);
  lighting.setupMaterial(pedestrians.mesh.material);
  lighting.nearShadowsOnly(pedestrians.mesh);
  scene.add(pedestrians.mesh, traffic.group);
  // Up close, some pedestrians (Haredi men) are drawn as a rigged, animated model. Loaded in
  // the background; until then (or if it fails) everyone stays an instanced mannequin.
  const peds = pedestrians;
  RiggedPedestrians.load(`${import.meta.env.BASE_URL}models/pedestrians_pilot.glb`)
    .then((rigged) => {
      if (pedestrians !== peds) return rigged.dispose();
      for (const m of rigged.materials()) lighting.setupMaterial(m);
      scene.add(rigged.group);
      peds.attachRigged(rigged);
    })
    .catch((err) => console.warn(`[pedestrians] rigged models unavailable: ${err.message}`));
  respawn();

  // Handy for debugging from the devtools console.
  window.world = world;
  window.debug = {
    landmarks: landmarkLayer,
    hinnom: hinnomLayer,
    sites: sitesLayer,
    THREE, camera, playerCamera, player, proxy, character, scene, renderer, lighting, post, world, pedestrians, traffic, freeCam, wind,
    setNight: (v) => { night = nightTarget = v; applyLook(v); },
  };
  console.info('[world]', world.stats(), `legacy: ${world.legacy ? `${world.legacy.kept} features kept, ${world.legacy.skipped} superseded by tiles` : 'none'}`);
}

/** Puts the player back on the spawn street, camera behind them looking along the road. */
function respawn() {
  if (!world || !player) return;
  player.reset(world.spawn);
  playerCamera.snapTo(player.snapshot());
}

// ------------------------------------------------------------------------------------------------
// Street life
// ------------------------------------------------------------------------------------------------

let lastLanding = null;
let networkVersion = -1;
let networkTimer = 0;
const shadowed = new WeakSet();

/** Rebuilds the shared road graph when cells change level (at most twice a second). */
function updateRoadNetwork(dt) {
  networkTimer -= dt;
  if (world.version === networkVersion || networkTimer > 0) return;
  networkVersion = world.version;
  networkTimer = 0.5;
  const network = RoadNetwork.fromRoads(world.activeRoads());
  pedestrians.setNetwork(network);
  traffic.setNetwork(network);
  // The tram is (re)built with the network: hook its materials into the shadows.
  traffic.group.traverse((o) => {
    if (o.material) lighting.setupMaterial(o.material);
    if (o.isInstancedMesh && o.castShadow && !shadowed.has(o)) {
      shadowed.add(o);
      lighting.nearShadowsOnly(o);
    }
  });
}

/**
 * What pedestrians scatter from: the player gliding or falling fast close above the street,
 * or a hard landing in the last half second.
 */
function playerThreat(s) {
  const p = s.position;
  const low = p.y - world.collision.terrainHeight(p.x, p.z) < 4;
  const fast = (s.state === 'glide' && s.speed > 7) || (s.state === 'air' && s.velocity.y < -9);
  if (low && fast) return { x: p.x, z: p.z, active: true };
  if (lastLanding && timer.elapsedTime - lastLanding.time < 0.5 && lastLanding.impact > 7) {
    return { x: lastLanding.x, z: lastLanding.z, active: true };
  }
  return null;
}

function updateStreetLife(dt, snap) {
  updateRoadNetwork(dt);
  const center = camera.position;
  pedestrians.update(dt, center, snap && !freeCam.enabled ? playerThreat(snap) : null);
  traffic.update(dt, center, snap?.position ?? null);
  pedestrians.render(camera, timer.elapsedTime);
  traffic.render(camera);
}

// ------------------------------------------------------------------------------------------------
// HUD
// ------------------------------------------------------------------------------------------------

let frames = 0;
let hudTimer = 0;

function updateHud(dt) {
  frames++;
  hudTimer += dt;
  if (hudTimer < 0.25 || !world || !player) return;
  frames = 0;
  hudTimer = 0;

  const s = player.snapshot();
  const p = s.position;
  const roads = world.findRoadsAt(p.x, p.z);
  const place = world.findPlaceAt(p.x, p.z);
  const named = [...new Set(roads.map((r) => r.name).filter(Boolean))];
  const where = named.length ? named.join(' & ') : roads.length ? `unnamed ${roads[0].highway}` : 'off-street';
  const touching = player.hits.find((b) => b.kind === 'building');
  const touched = touching ? world.buildingById(touching.ref) : null;
  const locked = document.pointerLockElement === renderer.domElement;

  hud.innerHTML =
    `<strong>${world.name}</strong>${place ? ` <span class="dim">· ${place.name}</span>` : ''}\n` +
    `<span class="dim">at</span> ${where}  <span class="dim">${(p.y + world.terrain.datum).toFixed(0)} m ASL</span>\n` +
    `<span class="dim">${s.state}</span> ${s.horizontalSpeed.toFixed(1)} m/s` +
    (s.state === 'glide' ? ` · sink ${(-s.velocity.y).toFixed(1)} m/s · pitch ${((s.glidePitch * 180) / Math.PI).toFixed(0)}°` : '') +
    (s.grounded && s.slopeDeg > 1 ? ` · slope ${s.slopeDeg.toFixed(0)}°` : '') + '\n' +
    (touched ? `<span class="dim">touching</span> ${touched.name ?? touched.address ?? touched.id} · ${touched.heightAboveGround.toFixed(1)} m (${touched.heightSource})\n` : '') +
    (showHelp
      ? `<span class="dim">WASD move · Shift run · Space jump (hold: higher) · hold Space in the air: glide (W dive · S climb · A/D or mouse steer) · ` +
        `${locked ? 'Esc frees the mouse' : 'click: mouse look'} · wheel zoom · E boost · N night · L ceremonial lights · C free cam (Q/E down/up) · M mute · B stats · P post-fx ${post.enabled ? 'on' : 'off'} · R respawn · H hide</span>\n`
      : `<span class="dim">H: controls</span>\n`) +
    (() => { const w = world.stats(); return `<span class="dim">tiles ${w.levels.near} near · ${w.levels.medium} medium · ${w.levels.far} far · ${w.colliders} colliders${w.loading ? ` · loading ${w.loading}` : ''}</span>\n`; })() +
    `<span class="dim">${world.attribution}</span>`;
}

// ------------------------------------------------------------------------------------------------
// Resize + loop
// ------------------------------------------------------------------------------------------------

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  post.setSize(w, h);
  lighting.onResize();
}
window.addEventListener('resize', onResize);

const timer = new THREE.Clock();

// ?bench runs a fixed camera benchmark (add &night for the night look).
const params = new URLSearchParams(window.location.search);
const benchControls = { enabled: true }; // the benchmark flies the camera itself
const bench = params.has('bench') ? createBenchmark({ camera, controls: benchControls, renderer }) : null;
if (params.has('night')) night = nightTarget = 1;

applyLook(night);
loadWorld()
  .catch((err) => {
    console.error(err);
    hud.textContent = `Could not load city data.\n${err.message}`;
  });

renderer.setAnimationLoop(() => {
  const rawDt = timer.getDelta();
  const dt = Math.min(rawDt, 1 / 20);

  if (Math.abs(night - nightTarget) > 1e-3) {
    night = THREE.MathUtils.damp(night, nightTarget, 2.5, dt);
    applyLook(night);
  }

  if (bench && player && !bench.running && !bench.result) bench.start(world.spawn);
  const benchFrame = bench?.running ? bench.update() : null;
  const flying = benchFrame || freeCam.enabled; // camera not tied to the player
  let snap = null;
  if (player) {
    if (!flying) player.update(dt, readInput());
    snap = player.snapshot();
    avatar.update(snap, dt);
    glideFx.update(snap, dt);
    wind.update(flying ? { speed: 0, state: 'ground' } : snap);
    if (freeCam.enabled) freeCam.update(dt, held);
    else if (!benchFrame) playerCamera.update(dt, snap);
  }
  lighting.update();
  surroundings.update(camera);
  if (world && player) {
    world.update(flying ? camera.position : player.position);
    world.updateCamera(camera);
    updateStreetLife(dt, snap);
    updateMinimap(snap, flying);
  }
  dust.update(camera, timer.elapsedTime, renderer.getPixelRatio());
  landmarkLayer?.update?.(timer.elapsedTime); // Chords Bridge light show, festival projections
  renderer.info.reset();
  post.render(dt);
  if (world && player) {
    benchHud.update(rawDt, () => {
      const info = renderer.info.render;
      return {
        calls: info.calls, triangles: info.triangles, buildings: world.stats().buildings,
        vehicles: traffic.count, trams: traffic.rail ? 1 : 0, pedestrians: pedestrians.count,
        extra: freeCam.enabled ? 'free camera · wheel: speed' : wind.muted ? 'sound muted' : '',
      };
    });
  }
  if (benchFrame) {
    bench.record(benchFrame);
    if (bench.result) hud.innerHTML = formatBenchmark(bench.result);
  } else if (!bench?.result) {
    updateHud(dt);
  }
});
