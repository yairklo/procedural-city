// Rigged, animated pedestrians near the camera.
//
// The instanced mannequins (PedestrianSystem) fill every street in one draw call. A small
// pool of skinned models (the Haredi man in public/models/pedestrians_pilot.glb: 5k tris,
// 62 bones, idle / walk clips) takes over the nearest *eligible* agents within `radius` and
// hands them back beyond `release` (hysteresis, so nobody flickers at the boundary).
// Eligible agents are dressed like the model (black coat and trousers), so the swap between
// the mannequin far away and the rigged model up close keeps the same silhouette colours.
//
// Cost: one skinned draw call per visible model (plus its shadow), and a 62-bone mixer
// update. With max = 10 that's a few dozen draw calls; everyone else stays instanced.
//
// The walk clip is in place (no root motion): the agent's position comes from
// PedestrianSystem, and the clip's playback rate follows the agent's speed so feet don't
// slide (the clip matches 1.32 m/s at scale 1).

import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

export const DEFAULT_RIGGED_OPTIONS = Object.freeze({
  max: 10, // models in the pool
  radius: 45, // m: eligible agents closer than this get a model
  release: 52, // m: and keep it until farther than this
  clipSpeed: 1.32, // m/s the walk clip matches at scale 1
  minScale: 0.8, // children (smaller agents) stay mannequins: the model is an adult man
});

export class RiggedPedestrians {
  /**
   * @param {object} p
   * @param {THREE.Object3D} p.source  rig root (contains the SkinnedMesh and its bones)
   * @param {THREE.AnimationClip[]} p.clips  needs 'walk'; 'idle' optional
   * @param {Partial<typeof DEFAULT_RIGGED_OPTIONS>} [p.options]
   */
  constructor({ source, clips, options = {} }) {
    this.o = { ...DEFAULT_RIGGED_OPTIONS, ...options };
    const walkClip = clips.find((c) => c.name === 'walk');
    if (!walkClip) throw new Error('RiggedPedestrians: the model has no "walk" clip');
    const idleClip = clips.find((c) => c.name === 'idle') ?? null;

    this.group = new THREE.Group();
    this.group.name = 'RiggedPedestrians';
    this.slots = [];
    for (let i = 0; i < this.o.max; i++) {
      const obj = cloneSkinned(source);
      obj.position.set(0, 0, 0);
      obj.visible = false;
      obj.traverse((m) => {
        if (m.isMesh) {
          m.castShadow = true;
          m.receiveShadow = true;
        }
      });
      const mixer = new THREE.AnimationMixer(obj);
      const walk = mixer.clipAction(walkClip);
      walk.play();
      walk.time = (i / this.o.max) * walkClip.duration; // everyone out of step
      const idle = idleClip ? mixer.clipAction(idleClip) : null;
      if (idle) {
        idle.play();
        idle.setEffectiveWeight(0);
      }
      this.slots.push({ obj, mixer, walk, idle, agent: null, blend: 1 });
      this.group.add(obj);
    }
    this._agents = new Set();
    this._lastTime = null;
  }

  /** Loads the pedestrian model file (meshopt-compressed GLB) and builds the pool. */
  static async load(url, options = {}) {
    const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
      import('three/addons/loaders/GLTFLoader.js'),
      import('three/addons/libs/meshopt_decoder.module.js'),
    ]);
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url);
    const source = gltf.scene.getObjectByName('ped_rig');
    if (!source) throw new Error(`${url}: no "ped_rig" node`);
    return new RiggedPedestrians({ source, clips: gltf.animations, options });
  }

  /** Materials used by the models (shared by every clone), e.g. to enable cascaded shadows. */
  materials() {
    const set = new Set();
    this.slots[0]?.obj.traverse((m) => m.isMesh && [].concat(m.material).forEach((x) => set.add(x)));
    return [...set];
  }

  isEligible(agent) {
    return agent.rigged === true && agent.scale >= this.o.minScale;
  }

  /**
   * Chooses which agents are drawn as rigged models this frame and returns them as a Set
   * (PedestrianSystem skips them in the instanced mesh).
   */
  assign(agents, camera) {
    const p = camera.position;
    const d2 = (a) => (a.x - p.x) ** 2 + (a.z - p.z) ** 2;
    const present = new Set(agents);
    const release2 = this.o.release ** 2, radius2 = this.o.radius ** 2;

    // Keep current holders while they are still around and within the release distance.
    for (const s of this.slots) {
      if (s.agent && (!present.has(s.agent) || d2(s.agent) > release2)) s.agent = null;
    }
    const taken = new Set(this.slots.map((s) => s.agent).filter(Boolean));
    const free = this.slots.filter((s) => !s.agent);
    if (free.length) {
      const candidates = agents
        .filter((a) => !taken.has(a) && this.isEligible(a) && d2(a) < radius2)
        .sort((a, b) => d2(a) - d2(b));
      for (let i = 0; i < free.length && i < candidates.length; i++) {
        free[i].agent = candidates[i];
        free[i].blend = candidates[i].moving > 0.2 ? 1 : 0;
      }
    }
    this._agents.clear();
    for (const s of this.slots) if (s.agent) this._agents.add(s.agent);
    return this._agents;
  }

  /** Poses the models on their agents and advances the animations. `time` in seconds. */
  update(time) {
    const dt = this._lastTime === null ? 0 : Math.min(0.1, Math.max(0, time - this._lastTime));
    this._lastTime = time;
    for (const s of this.slots) {
      const a = s.agent;
      s.obj.visible = !!a;
      if (!a) continue;
      s.obj.position.set(a.x, a.y, a.z);
      s.obj.rotation.set(0, a.yaw + Math.PI, 0); // agent yaw points -Z along the walk; the model faces +Z
      s.obj.scale.setScalar(a.scale);
      // Walk when moving, idle when (nearly) standing; stride rate from the actual speed.
      const moving = Math.max(0, a.moving ?? 0);
      const target = moving > 0.2 ? 1 : 0;
      s.blend += (target - s.blend) * (1 - Math.exp(-8 * dt));
      s.walk.setEffectiveWeight(s.idle ? s.blend : 1);
      s.idle?.setEffectiveWeight(1 - s.blend);
      s.walk.timeScale = Math.max(0.3, moving / (this.o.clipSpeed * a.scale));
      s.mixer.update(dt);
    }
  }

  get visible() {
    return this._agents.size;
  }

  dispose() {
    for (const s of this.slots) s.mixer.stopAllAction();
    this.group.removeFromParent();
    // Geometry and materials are shared with the loaded file; dispose them once.
    const seen = new Set();
    this.slots[0]?.obj.traverse((m) => {
      if (!m.isMesh) return;
      if (!seen.has(m.geometry)) { seen.add(m.geometry); m.geometry.dispose(); }
      for (const x of [].concat(m.material)) if (!seen.has(x)) { seen.add(x); x.dispose(); }
    });
  }
}
