import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CityGenerator, findRoadsAt, findBlockAt } from './city/CityGenerator.js';
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
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
pmrem.dispose();

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

const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xffffff, 1);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -140;
sun.shadow.camera.right = 140;
sun.shadow.camera.top = 140;
sun.shadow.camera.bottom = -140;
sun.shadow.camera.near = 10;
sun.shadow.camera.far = 900;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.6;
scene.add(sun, sun.target);
const SUN_OFFSET = new THREE.Vector3(180, 320, 120);

const LOOK = {
  day: {
    sky: new THREE.Color(0xa9c4dc), fogFar: 1400,
    hemiSky: new THREE.Color(0xdbe8f5), hemiGround: new THREE.Color(0x6b6256), hemi: 1.1,
    sun: new THREE.Color(0xfff1dc), sunIntensity: 2.8, env: 0.55, exposure: 1.0,
  },
  night: {
    sky: new THREE.Color(0x0b1020), fogFar: 1100,
    hemiSky: new THREE.Color(0x2a3656), hemiGround: new THREE.Color(0x14120f), hemi: 0.2,
    sun: new THREE.Color(0x9fb4ff), sunIntensity: 0.35, env: 0.08, exposure: 1.25,
  },
};
scene.fog = new THREE.Fog(LOOK.day.sky.clone(), 150, LOOK.day.fogFar);
scene.background = LOOK.day.sky.clone();

let night = 0;
let nightTarget = 0;

function applyLook(t) {
  const a = LOOK.day, b = LOOK.night;
  scene.background.lerpColors(a.sky, b.sky, t);
  scene.fog.color.copy(scene.background);
  scene.fog.far = THREE.MathUtils.lerp(a.fogFar, b.fogFar, t);
  hemi.color.lerpColors(a.hemiSky, b.hemiSky, t);
  hemi.groundColor.lerpColors(a.hemiGround, b.hemiGround, t);
  hemi.intensity = THREE.MathUtils.lerp(a.hemi, b.hemi, t);
  sun.color.lerpColors(a.sun, b.sun, t);
  sun.intensity = THREE.MathUtils.lerp(a.sunIntensity, b.sunIntensity, t);
  scene.environmentIntensity = THREE.MathUtils.lerp(a.env, b.env, t);
  renderer.toneMappingExposure = THREE.MathUtils.lerp(a.exposure, b.exposure, t);
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
scene.add(player);

const velocity = new THREE.Vector3();
let grounded = false;
let lastHits = [];

const keys = new Set();
window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.repeat) return;
  if (e.code === 'KeyN') nightTarget = nightTarget > 0.5 ? 0 : 1;
  if (e.code === 'KeyR') buildCity(`city-${Math.floor(Math.random() * 1e6)}`);
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

  // The shadow camera follows the player, so shadows stay sharp everywhere.
  sun.position.copy(player.position).add(SUN_OFFSET);
  sun.target.position.copy(player.position);
}

// ------------------------------------------------------------------------------------------------
// City
// ------------------------------------------------------------------------------------------------

/** @type {ReturnType<CityGenerator['create']> | null} */
let city = null;

function buildCity(seed) {
  if (city) {
    scene.remove(city.group);
    city.dispose();
  }
  city = new CityGenerator({ seed }).create();
  scene.add(city.group);
  city.setNight(night);

  const s = city.data.spawn;
  player.position.set(s.x, s.y, s.z);
  velocity.set(0, 0, 0);
  _prevTarget.set(s.x, s.y + PLAYER.height * 0.8, s.z);
  camera.position.set(s.x - 40, 45, s.z + 60);
  controls.target.copy(_prevTarget);
  controls.update();

  // Handy for debugging from the devtools console.
  window.city = city;
  window.debug = { camera, controls, player, scene, renderer };
  console.info(`[city] ${city.data.name} (${seed})`, city.data.stats);
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
  const block = findBlockAt(data, p.x, p.z);
  let where = roads.length ? roads.map((r) => r.name).join(' & ') : block ? `${block.district} · ${block.id}` : '—';
  const touching = lastHits.find((b) => b.kind === 'building');
  const touched = touching ? data.buildingById.get(touching.ref) : null;

  const info = renderer.info.render;
  hud.innerHTML =
    `<strong>${data.name}</strong> <span class="dim">seed ${data.seed}</span>\n` +
    `${fps} fps · ${info.calls} draw calls · ${(info.triangles / 1000).toFixed(0)}k tris\n` +
    `${data.stats.buildings} buildings · ${data.stats.colliders} colliders · built in ${data.stats.generateMs + data.stats.buildMs} ms\n` +
    `<span class="dim">at</span> ${where}  <span class="dim">y=${p.y.toFixed(1)}</span>\n` +
    (touched ? `<span class="dim">touching</span> ${touched.id} · ${touched.address} (${touched.floors} fl)\n` : '') +
    `<span class="dim">WASD move · Shift sprint · Space jump · E boost · drag to orbit · N day/night · R new city</span>`;
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
}
window.addEventListener('resize', onResize);

const timer = new THREE.Clock();

buildCity('city-001');
applyLook(night);

renderer.setAnimationLoop(() => {
  const dt = Math.min(timer.getDelta(), 1 / 20);

  if (Math.abs(night - nightTarget) > 1e-3) {
    night = THREE.MathUtils.damp(night, nightTarget, 2.5, dt);
    applyLook(night);
  }

  updatePlayer(dt);
  followCamera();
  controls.update();
  renderer.render(scene, camera);
  updateHud(dt);
});
