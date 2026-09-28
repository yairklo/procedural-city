// The player character: the rigged model (public/models/character.glb) driven by the
// controller's snapshot and events. Same interface as PlayerProxy (`object3D`,
// `update(snapshot, dt)`), so it drops in for the capsule stand-in once loaded.
//
// Asset facts (see the model's notes): metres, Y-up, faces +Z, feet at y = 0. Five clips:
// idle, run (in place, ~4.4 m/s), jump (once: crouch 0.3 s, peak ~0.8 s, land ~1.3 s),
// glide and fall (prone, hips ~1 m above the origin). The tallit's motion is baked into every
// clip, so crossfades stay short (0.15–0.3 s) or the cape visibly swings through the blend.
// The files use meshopt compression, so the loader needs the MeshoptDecoder.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const damp = (current, target, lambda, dt) => current + (target - current) * (1 - Math.exp(-lambda * dt));

const RUN_CLIP_SPEED = 4.4; // m/s the run cycle was captured at
const JUMP_SKIP_CROUCH = 0.25; // the controller takes off at once: start the clip after the crouch
const HIP_HEIGHT = 1.0; // glide / fall bodies pivot around the hips

/** Picks the clip for a controller state. Pure, so it can be tested without a model. */
export function chooseClip(s, { sinceJump = Infinity, mantle = false } = {}) {
  if (s.state === 'glide') return 'glide';
  if (s.state === 'mantle' || mantle) return 'jump';
  if (s.state === 'air') {
    // Right after a jump: the jump clip until it runs out or we drop fast; else free fall.
    if (s.velocity.y > 0 || (sinceJump < 1.0 && s.velocity.y > -8)) return 'jump';
    return s.velocity.y < -5 ? 'fall' : sinceJump < 1.4 ? 'jump' : 'fall';
  }
  return s.horizontalSpeed > 0.6 ? 'run' : 'idle';
}

export class CharacterModel {
  constructor() {
    this.object3D = new THREE.Group();
    this.object3D.name = 'Character';
    // Lean / bank pivot at hip height (the glide pose tilts with the flight path).
    this.pivot = new THREE.Group();
    this.pivot.position.y = HIP_HEIGHT;
    this.object3D.add(this.pivot);
    this.loaded = false;
    this.mixer = null;
    this.actions = {};
    this.current = null;
    this.clip = null;
    this.lean = 0;
    this.bank = 0;
    this._time = 0;
    this._jumpAt = -Infinity;
    this._mantle = false;
  }

  /** Loads the model; resolves once it can be shown. */
  async load(url) {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(url);
    const model = gltf.scene;
    model.position.y = -HIP_HEIGHT; // origin (feet) back at the group's origin
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false; // skinned: bind-pose bounds don't follow the animation
    });
    this.pivot.add(model);
    this.model = model;
    this.mixer = new THREE.AnimationMixer(model);
    for (const clip of gltf.animations) this.actions[clip.name] = this.mixer.clipAction(clip);
    const jump = this.actions.jump;
    if (jump) {
      jump.setLoop(THREE.LoopOnce, 1);
      jump.clampWhenFinished = true;
    }
    this._play('idle', 0);
    this.loaded = true;
    return this;
  }

  /** Listens to the controller's events (jump / land / mantle restart or end clips). */
  bind(player) {
    player.on('jump', () => {
      this._jumpAt = this._time;
      this._play('jump', 0.12, JUMP_SKIP_CROUCH);
    });
    player.on('land', () => {
      this._jumpAt = -Infinity;
    });
    player.on('mantleStart', () => {
      this._mantle = true;
      this._play('jump', 0.1, 0.9); // the tuck and landing half of the jump
    });
    player.on('mantleEnd', () => (this._mantle = false));
  }

  /** Every mesh material, for the lighting / shadow setup. */
  materials() {
    const out = new Set();
    this.model?.traverse((o) => o.isMesh && [].concat(o.material).forEach((m) => out.add(m)));
    return [...out];
  }

  update(s, dt) {
    this._time += dt;
    const o = this.object3D;
    o.position.set(s.position.x, s.position.y, s.position.z);
    o.rotation.y = s.yaw + Math.PI; // controller yaw 0 faces -Z, the model faces +Z
    if (!this.loaded) return;

    const name = chooseClip(s, { sinceJump: this._time - this._jumpAt, mantle: this._mantle });
    // Short fades between very different poses (the cape is baked per clip).
    const fade = (this.clip === 'run' || this.clip === 'idle') && (name === 'glide' || name === 'fall') ? 0.15 : 0.22;
    if (name !== this.clip) this._play(name, fade, name === 'jump' ? JUMP_SKIP_CROUCH : 0);

    // The run cycle is in place: match its cadence to the ground speed.
    if (this.clip === 'run') this.current.timeScale = THREE.MathUtils.clamp(s.horizontalSpeed / RUN_CLIP_SPEED, 0.55, 1.9);

    // The glide pose is already prone; tilt it with the flight path and bank into turns.
    const gliding = s.state === 'glide';
    this.lean = damp(this.lean, gliding ? -s.glidePitch * 0.6 : 0, 6, dt);
    this.bank = damp(this.bank, gliding ? s.glideBank : 0, 5, dt);
    this.pivot.rotation.set(this.lean, 0, this.bank, 'YXZ');

    this.mixer.update(dt);
  }

  _play(name, fade, startAt = 0) {
    const next = this.actions[name];
    if (!next) return;
    const prev = this.current;
    next.reset();
    next.time = startAt;
    next.timeScale = 1;
    next.setEffectiveWeight(1).play();
    if (prev && prev !== next && fade > 0) prev.crossFadeTo(next, fade, false);
    else if (prev && prev !== next) prev.stop();
    this.current = next;
    this.clip = name;
  }

  dispose() {
    this.mixer?.stopAllAction();
    this.model?.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.dispose();
      for (const m of [].concat(o.material)) {
        for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
        m.dispose();
      }
    });
  }
}
