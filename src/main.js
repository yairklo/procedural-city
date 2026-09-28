import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CityGenerator, findRoadsAt, findPlaceAt } from './city/CityGenerator.js';
import { createLighting } from './render/lighting.js';
import { createPostProcessing } from './render/postprocessing.js';
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

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.5, 4000);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 4;
controls.maxDistance = 900;
controls.maxPolarAngle = Math.PI * 0.49;
controls.enablePan = false;

// ------------------------------------------------------------------------------------------------
// Lighting + day / night
// ------------------------------------------------------------------------------------------------

const lighting = createLighting({ renderer, scene, camera });
const post = createPostProcessing(renderer, scene, camera);

let night = 0;
let nightTarget = 0;

function applyLook(t) {
  lighting.setNight(t);
  post.setNight(t);
  city?.setNight(t);
}

// ------------------------------------------------------------------------------------------------
// Player (a simple capsule used to exercise the AABB collision data)
// ------------------------------------------------------------------------------------------------

const PLAYER = { radius: 0.4, height: 1.8, walk: 7, sprint: 16, jump: 9, boost: 42, gravity: 25, step: 0.45 };

const player = new THREE.Mesh(
  new THREE.CapsuleGeometry(PLAYER.radius, PLAYER.height - PLAYER.radius * 2, 4, 12).translate(0, PLAYER.height / 2, 0),
  new THREE.MeshStandardMaterial({ color: 0xff7a2f, roughness: 0.5 }),
);
player.castShadow = true;
lighting.setupMaterial(player.material);
scene.add(player);

const velocity = new THREE.Vector3();
let grounded = false;
let lastHits = [];

const keys = new Set();
window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.repeat) return;
  if (e.code === 'KeyN') nightTarget = nightTarget > 0.5 ? 0 : 1;
  if (e.code === 'KeyR') respawn();
  if (e.code === 'KeyP') post.enabled = !post.enabled;
  if (e.code === 'Space' && grounded) velocity.y = PLAYER.jump;
  if (e.code === 'KeyE') velocity.y = PLAYER.boost; // test jump for reaching rooftops
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _move = new THREE.Vector3();
const _prevTarget = new THREE.Vector3();

function updatePlayer(dt) {
  if (!city) return;
  const pos = player.position;
  const collision = city.collision;

  // Camera-relative input on the XZ plane.
  camera.getWorldDirection(_forward);
  _forward.y = 0;
  _forward.normalize();
  _right.crossVectors(_forward, THREE.Object3D.DEFAULT_UP);
  _move.set(0, 0, 0);
  if (keys.has('KeyW') || keys.has('ArrowUp')) _move.add(_forward);
  if (keys.has('KeyS') || keys.has('ArrowDown')) _move.sub(_forward);
  if (keys.has('KeyD') || keys.has('ArrowRight')) _move.add(_right);
  if (keys.has('KeyA') || keys.has('ArrowLeft')) _move.sub(_right);
  if (_move.lengthSq() > 0) _move.normalize().multiplyScalar(keys.has('ShiftLeft') || keys.has('ShiftRight') ? PLAYER.sprint : PLAYER.walk);
  velocity.x = _move.x;
  velocity.z = _move.z;
  velocity.y -= PLAYER.gravity * dt;

  // Sub-step so fast movement can't tunnel through thin boxes.
  const travel = velocity.length() * dt;
  const steps = Math.max(1, Math.ceil(travel / (PLAYER.radius * 0.5)));
  const h = dt / steps;
  grounded = false;
  const hits = new Set();

  for (let i = 0; i < steps; i++) {
    pos.addScaledVector(velocity, h);

    // Walls, ceilings, props.
    const res = collision.resolveCapsule(pos, PLAYER.radius, PLAYER.height, PLAYER.step);
    for (const b of res.hits) hits.add(b);
    if (res.ceiling && velocity.y > 0) velocity.y = 0;

    // Floor: highest surface under the feet that we can step onto (curbs, roofs, lawns).
    const floor = collision.groundHeight(pos.x, pos.z, pos.y + PLAYER.step);
    if (pos.y <= floor) {
      pos.y = floor;
      if (velocity.y < 0) velocity.y = 0;
      grounded = true;
    }
  }
  lastHits = [...hits];

  // Keep the player inside the generated area.
  const bd = city.data.bounds;
  pos.x = THREE.MathUtils.clamp(pos.x, bd.minX, bd.maxX);
  pos.z = THREE.MathUtils.clamp(pos.z, bd.minZ, bd.maxZ);
}

function followCamera() {
  const target = player.position.clone();
  target.y += PLAYER.height * 0.8;
  camera.position.add(target.clone().sub(_prevTarget));
  controls.target.copy(target);
  _prevTarget.copy(target);
}

// ------------------------------------------------------------------------------------------------
// City
// ------------------------------------------------------------------------------------------------

/** @type {ReturnType<CityGenerator['create']> | null} */
let city = null;

const DATA_URL = `${import.meta.env.BASE_URL}data/jerusalem_data.json`;

async function loadOsm() {
  const res = await fetch(DATA_URL);
  if (!res.ok) throw new Error(`${DATA_URL}: HTTP ${res.status}. Run "npm run fetch-data" once to download the OpenStreetMap data.`);
  return res.json();
}

function buildCity(osm) {
  if (city) {
    scene.remove(city.group);
    city.group.traverse((o) => o.material && lighting.releaseMaterial(o.material));
    city.dispose();
  }
  city = new CityGenerator({ osm }).create();
  scene.add(city.group);
  city.group.traverse((o) => o.material && lighting.setupMaterial(o.material));
  city.setNight(night);
  respawn();

  // Handy for debugging from the devtools console.
  window.city = city;
  window.debug = { camera, controls, player, scene, renderer };
  console.info(`[city] ${city.data.name}`, city.data.stats);
}

/** Puts the player back on the spawn street, camera behind them looking along the road. */
function respawn() {
  if (!city) return;
  const s = city.data.spawn;
  player.position.set(s.x, s.y, s.z);
  velocity.set(0, 0, 0);
  _prevTarget.set(s.x, s.y + PLAYER.height * 0.8, s.z);
  camera.position.set(s.x - Math.sin(s.heading) * 14, s.y + 7, s.z - Math.cos(s.heading) * 14);
  controls.target.copy(_prevTarget);
  controls.update();
}

// ------------------------------------------------------------------------------------------------
// HUD
// ------------------------------------------------------------------------------------------------

let frames = 0;
let hudTimer = 0;

function updateHud(dt) {
  frames++;
  hudTimer += dt;
  if (hudTimer < 0.25 || !city) return;
  const fps = Math.round(frames / hudTimer);
  frames = 0;
  hudTimer = 0;

  const { data } = city;
  const p = player.position;
  const roads = findRoadsAt(data, p.x, p.z);
  const place = findPlaceAt(data, p.x, p.z);
  const named = [...new Set(roads.map((r) => r.name).filter(Boolean))];
  const where = named.length ? named.join(' & ') : roads.length ? `unnamed ${roads[0].highway}` : 'off-street';
  const touching = lastHits.find((b) => b.kind === 'building');
  const touched = touching ? data.buildingById.get(touching.ref) : null;

  const info = renderer.info.render;
  hud.innerHTML =
    `<strong>${data.name}</strong>${place ? ` <span class="dim">· ${place.name}</span>` : ''}\n` +
    `${fps} fps · ${info.calls} draw calls/frame (all passes) · ${(info.triangles / 1000).toFixed(0)}k tris\n` +
    `${data.stats.buildings} buildings · ${data.stats.colliders} colliders · built in ${data.stats.generateMs + data.stats.buildMs} ms\n` +
    `<span class="dim">at</span> ${where}  <span class="dim">y=${p.y.toFixed(1)}</span>\n` +
    (touched ? `<span class="dim">touching</span> ${touched.name ?? touched.address ?? touched.id} · ${touched.height.toFixed(1)} m (${touched.heightSource})\n` : '') +
    `<span class="dim">WASD move · Shift sprint · Space jump · E boost · drag to orbit · N day/night · P post-fx ${post.enabled ? 'on' : 'off'} · R respawn</span>\n` +
    `<span class="dim">${data.source.attribution}</span>`;
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

applyLook(night);
loadOsm()
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

  updatePlayer(dt);
  followCamera();
  controls.update();
  lighting.update();
  renderer.info.reset();
  post.render(dt);
  updateHud(dt);
});
