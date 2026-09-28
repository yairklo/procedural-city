import * as THREE from 'three';
import { CityGenerator, findRoadsAt, findPlaceAt } from './city/CityGenerator.js';
import { createLighting } from './render/lighting.js';
import { createPostProcessing } from './render/postprocessing.js';
import { createSurroundings } from './render/surroundings.js';
import { createBenchmark, formatBenchmark } from './debug/benchmark.js';
import { PlayerController } from './player/PlayerController.js';
import { PlayerCamera } from './player/PlayerCamera.js';
import { PlayerProxy } from './player/PlayerProxy.js';
import { GlideEffects } from './player/GlideEffects.js';
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
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.3, 4000);

// ------------------------------------------------------------------------------------------------
// Lighting + day / night
// ------------------------------------------------------------------------------------------------

const lighting = createLighting({ renderer, scene, camera });
const post = createPostProcessing(renderer, scene, camera);
const surroundings = createSurroundings({ scene });

let night = 0;
let nightTarget = 0;

function applyLook(t) {
  lighting.setNight(t);
  surroundings.setNight(t);
  post.setNight(t);
  city?.setNight(t);
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

const keys = new Set();
let boostQueued = false;
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  keys.add(e.code);
  if (e.repeat) return;
  if (e.code === 'KeyN') nightTarget = nightTarget > 0.5 ? 0 : 1;
  if (e.code === 'KeyR') respawn();
  if (e.code === 'KeyP') post.enabled = !post.enabled;
  if (e.code === 'KeyE') boostQueued = true; // debug super-jump to reach rooftops
  if (e.code === 'KeyH') showHelp = !showHelp;
});
let showHelp = true;
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

const held = (...codes) => codes.some((c) => keys.has(c));

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

/** @type {ReturnType<CityGenerator['create']> | null} */
let city = null;

const DATA_URL = `${import.meta.env.BASE_URL}data/jerusalem_data.json`;
const ELEVATION_URL = `${import.meta.env.BASE_URL}data/jerusalem_elevation.json`;

async function loadData() {
  const [res, elev] = await Promise.all([fetch(DATA_URL), fetch(ELEVATION_URL).catch(() => null)]);
  if (!res.ok) throw new Error(`${DATA_URL}: HTTP ${res.status}. Run "npm run fetch-data" once to download the OpenStreetMap data.`);
  const osm = await res.json();
  // Elevation is optional: without it the city is built on flat ground.
  let elevation = null;
  if (elev?.ok) elevation = await elev.json().catch(() => null);
  if (!elevation) console.warn(`[city] no terrain (${ELEVATION_URL}); building on flat ground`);
  return { osm, elevation };
}

function buildCity({ osm, elevation }) {
  if (city) {
    scene.remove(city.group);
    city.group.traverse((o) => o.material && [o.material].flat().forEach((m) => lighting.releaseMaterial(m)));
    city.dispose();
  }
  city = new CityGenerator({ osm, elevation }).create();
  surroundings.setBaseHeight(city.data.terrain.meanEdge);
  scene.add(city.group);
  city.group.traverse((o) => {
    if (!o.material) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) lighting.setupMaterial(m);
    if (o.userData.detail) lighting.nearShadowsOnly(o);
  });
  city.setNight(night);

  player = new PlayerController(city.collision, city.data.spawn);
  playerCamera ??= new PlayerCamera(camera, renderer.domElement, city.collision);
  playerCamera.setCollision(city.collision);
  player.on('land', (e) => e.impact > 12 && console.debug(`[player] hard landing ${e.impact.toFixed(1)} m/s`));
  respawn();

  // Handy for debugging from the devtools console.
  window.city = city;
  window.debug = {
    camera, playerCamera, player, proxy, scene, renderer, lighting, post,
    setNight: (v) => { night = nightTarget = v; applyLook(v); },
  };
  console.info(`[city] ${city.data.name}`, city.data.stats);
}

/** Puts the player back on the spawn street, camera behind them looking along the road. */
function respawn() {
  if (!city || !player) return;
  player.reset(city.data.spawn);
  playerCamera.snapTo(player.snapshot());
}

// ------------------------------------------------------------------------------------------------
// HUD
// ------------------------------------------------------------------------------------------------

let frames = 0;
let hudTimer = 0;

function updateHud(dt) {
  frames++;
  hudTimer += dt;
  if (hudTimer < 0.25 || !city || !player) return;
  const fps = Math.round(frames / hudTimer);
  frames = 0;
  hudTimer = 0;

  const { data } = city;
  const s = player.snapshot();
  const p = s.position;
  const roads = findRoadsAt(data, p.x, p.z);
  const place = findPlaceAt(data, p.x, p.z);
  const named = [...new Set(roads.map((r) => r.name).filter(Boolean))];
  const where = named.length ? named.join(' & ') : roads.length ? `unnamed ${roads[0].highway}` : 'off-street';
  const touching = player.hits.find((b) => b.kind === 'building');
  const touched = touching ? data.buildingById.get(touching.ref) : null;
  const locked = document.pointerLockElement === renderer.domElement;

  const info = renderer.info.render;
  hud.innerHTML =
    `<strong>${data.name}</strong>${place ? ` <span class="dim">· ${place.name}</span>` : ''}\n` +
    `${fps} fps · ${info.calls} draw calls/frame (all passes) · ${(info.triangles / 1000).toFixed(0)}k tris\n` +
    `<span class="dim">at</span> ${where}  <span class="dim">${(p.y + data.terrain.datum).toFixed(0)} m ASL</span>\n` +
    `<span class="dim">${s.state}</span> ${s.horizontalSpeed.toFixed(1)} m/s` +
    (s.state === 'glide' ? ` · sink ${(-s.velocity.y).toFixed(1)} m/s · pitch ${((s.glidePitch * 180) / Math.PI).toFixed(0)}°` : '') +
    (s.grounded && s.slopeDeg > 1 ? ` · slope ${s.slopeDeg.toFixed(0)}°` : '') + '\n' +
    (touched ? `<span class="dim">touching</span> ${touched.name ?? touched.address ?? touched.id} · ${touched.heightAboveGround.toFixed(1)} m (${touched.heightSource})\n` : '') +
    (showHelp
      ? `<span class="dim">WASD move · Shift run · Space jump (hold: higher) · hold Space in the air: glide (W dive · S climb · A/D or mouse steer) · ` +
        `${locked ? 'Esc frees the mouse' : 'click: mouse look'} · wheel zoom · E boost · N night · P post-fx ${post.enabled ? 'on' : 'off'} · R respawn · H hide</span>\n`
      : `<span class="dim">H: controls</span>\n`) +
    `<span class="dim">${data.source.attribution}${data.terrain.source ? ` · ${data.terrain.source.attribution}` : ''}</span>`;
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
loadData()
  .then(buildCity)
  .catch((err) => {
    console.error(err);
    hud.textContent = `Could not load city data.\n${err.message}`;
  });

renderer.setAnimationLoop(() => {
  const dt = Math.min(timer.getDelta(), 1 / 20);

  if (Math.abs(night - nightTarget) > 1e-3) {
    night = THREE.MathUtils.damp(night, nightTarget, 2.5, dt);
    applyLook(night);
  }

  if (bench && city && !bench.running && !bench.result) bench.start(city.data.spawn);
  const benchFrame = bench?.running ? bench.update() : null;
  if (player) {
    if (!benchFrame) player.update(dt, readInput());
    const snap = player.snapshot();
    proxy.update(snap, dt);
    glideFx.update(snap, dt);
    if (!benchFrame) playerCamera.update(dt, snap);
  }
  lighting.update();
  surroundings.update(camera);
  city?.update(camera);
  renderer.info.reset();
  post.render(dt);
  if (benchFrame) {
    bench.record(benchFrame);
    if (bench.result) hud.innerHTML = formatBenchmark(bench.result);
  } else if (!bench?.result) {
    updateHud(dt);
  }
});
