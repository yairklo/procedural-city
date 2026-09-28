// Third-person follow camera.
//
// - Orbits a pivot above the character (behind and slightly above by default).
// - Mouse look: click the canvas for pointer lock, or drag with the left button. Wheel zooms.
// - Drifts back behind the character while it moves and the mouse is idle (faster in a glide).
// - Occlusion: a ray from the pivot to the wanted camera spot; when a wall or the terrain is
//   in the way the camera pulls in quickly, and eases back out slowly once it is clear.
// - Glide feel: pulls back and widens the FOV with speed.
//
// Uses the collision world for occlusion (no scene raycasts), so it is cheap and matches
// what the character collides with.

import * as THREE from 'three';

export const DEFAULT_CAMERA_OPTIONS = Object.freeze({
  pivotHeight: 1.55,
  distance: 5.5,
  minDistance: 2,
  maxDistance: 14,
  glideExtraDistance: 2.5,
  pitch: 0.28, // radians above the horizontal, looking down at the character
  minPitch: -0.35,
  maxPitch: 1.25,
  sensitivity: 0.0025,
  followDelay: 1.2, // seconds of mouse idle before the camera drifts behind the character
  followRate: 1.6, // rad/s drift on the ground
  glideFollowRate: 3,
  fov: 62,
  glideFovBoost: 14, // extra degrees at high glide speed
  fovSpeedRange: [12, 32], // m/s over which the boost ramps in
  collisionPadding: 0.35,
  terrainClearance: 0.4,
});

const damp = (current, target, lambda, dt) => current + (target - current) * (1 - Math.exp(-lambda * dt));
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class PlayerCamera {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {HTMLElement} dom  element that receives mouse input (the canvas)
   * @param {import('../city/CityCollision.js').CityCollisionWorld} collision
   * @param {Partial<typeof DEFAULT_CAMERA_OPTIONS>} [options]
   */
  constructor(camera, dom, collision, options = {}) {
    this.o = { ...DEFAULT_CAMERA_OPTIONS, ...options };
    this.camera = camera;
    this.dom = dom;
    this.collision = collision;
    this.enabled = true;
    this.yaw = 0;
    this.pitch = this.o.pitch;
    this.zoom = this.o.distance;
    this.currentDistance = this.o.distance;
    this.pivot = new THREE.Vector3();
    this.glideAmount = 0;
    this.lastLookTime = -Infinity;
    this._time = 0;
    this._dragging = false;
    this._bind();
  }

  /** True while the player is turning the camera with the mouse (glide steering uses it). */
  get steering() {
    return this._time - this.lastLookTime < 0.25;
  }

  setCollision(collision) {
    this.collision = collision;
  }

  /** Puts the camera right behind the character with no smoothing. */
  snapTo(snapshot) {
    this.yaw = snapshot.yaw;
    this.pitch = this.o.pitch;
    this.pivot.set(snapshot.position.x, snapshot.position.y + this.o.pivotHeight, snapshot.position.z);
    this.currentDistance = this.zoom;
    this._place(this.zoom);
  }

  update(dt, snapshot) {
    if (!this.enabled) return;
    const o = this.o;
    this._time += dt;

    // Pivot follows the character (a little lag reads as weight; tighter in fast glides).
    const gliding = snapshot.state === 'glide';
    this.glideAmount = damp(this.glideAmount, gliding ? 1 : 0, 3, dt);
    const tx = snapshot.position.x, ty = snapshot.position.y + o.pivotHeight, tz = snapshot.position.z;
    const lag = gliding ? 20 : snapshot.state === 'mantle' ? 10 : 14;
    this.pivot.set(damp(this.pivot.x, tx, lag, dt), damp(this.pivot.y, ty, lag, dt), damp(this.pivot.z, tz, lag, dt));

    // Drift behind the character while it moves and the mouse is idle.
    const idle = this._time - this.lastLookTime > o.followDelay;
    if ((idle || gliding) && snapshot.horizontalSpeed > 1 && snapshot.state !== 'mantle' && !this.steering) {
      const rate = gliding ? o.glideFollowRate : o.followRate;
      const diff = wrapAngle(snapshot.yaw - this.yaw);
      this.yaw = wrapAngle(this.yaw + Math.sign(diff) * Math.min(Math.abs(diff), rate * dt * Math.min(1, Math.abs(diff) * 2)));
    }

    // Distance: zoom + pull back in glides; occlusion shortens it.
    const want = this.zoom + o.glideExtraDistance * this.glideAmount;
    const dir = this._direction();
    const hit = this.collision?.raycast(this.pivot, dir, want + o.collisionPadding, { filter: (b) => b.kind !== 'tree' });
    const clear = hit ? Math.max(o.minDistance * 0.5, hit.distance - o.collisionPadding) : want;
    this.currentDistance = clear < this.currentDistance ? damp(this.currentDistance, clear, 30, dt) : damp(this.currentDistance, clear, 3, dt);
    this._place(this.currentDistance);

    // FOV widens with glide speed.
    const [s0, s1] = o.fovSpeedRange;
    const k = Math.min(1, Math.max(0, (snapshot.speed - s0) / (s1 - s0))) * this.glideAmount;
    const fov = damp(this.camera.fov, o.fov + o.glideFovBoost * k, 3, dt);
    if (Math.abs(fov - this.camera.fov) > 1e-3) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  dispose() {
    for (const [target, type, fn] of this._handlers) target.removeEventListener(type, fn);
    if (document.pointerLockElement === this.dom) document.exitPointerLock?.();
  }

  // ------------------------------------------------------------------------------------------

  /** Unit vector from the pivot toward the camera. */
  _direction() {
    const cp = Math.cos(this.pitch);
    return new THREE.Vector3(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
  }

  _place(distance) {
    const d = this._direction();
    const cam = this.camera.position.copy(this.pivot).addScaledVector(d, distance);
    const floor = (this.collision?.terrainHeight(cam.x, cam.z) ?? 0) + this.o.terrainClearance;
    if (cam.y < floor) cam.y = floor;
    this.camera.lookAt(this.pivot);
    this.camera.updateMatrixWorld();
  }

  _look(dx, dy) {
    const s = this.o.sensitivity;
    this.yaw = wrapAngle(this.yaw - dx * s);
    this.pitch = Math.min(this.o.maxPitch, Math.max(this.o.minPitch, this.pitch + dy * s));
    this.lastLookTime = this._time;
  }

  _bind() {
    const dom = this.dom;
    this._handlers = [];
    const on = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      this._handlers.push([target, type, fn]);
    };
    on(dom, 'click', () => {
      if (this.enabled && document.pointerLockElement !== dom) dom.requestPointerLock?.();
    });
    on(dom, 'mousedown', (e) => {
      if (e.button === 0) this._dragging = true;
    });
    on(window, 'mouseup', () => (this._dragging = false));
    on(window, 'mousemove', (e) => {
      if (!this.enabled) return;
      if (document.pointerLockElement === dom || this._dragging) this._look(e.movementX, e.movementY);
    });
    on(dom, 'wheel', (e) => {
      e.preventDefault();
      this.zoom = Math.min(this.o.maxDistance, Math.max(this.o.minDistance, this.zoom * Math.exp(e.deltaY * 0.001)));
    }, { passive: false });
  }
}
