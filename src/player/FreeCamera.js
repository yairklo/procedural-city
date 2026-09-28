// Free-flying camera (C key): fly anywhere to inspect the city; the world streams around it.
// WASD move along the view, E / Space rise, Q sink, Shift = 4x, wheel sets the speed.
// Mouse look via pointer lock or drag (the player camera is paused meanwhile).

import * as THREE from 'three';

export class FreeCamera {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.enabled = false;
    this.yaw = 0;
    this.pitch = 0;
    this.speed = 25;
    this._drag = false;
    const look = (dx, dy) => {
      this.yaw -= dx * 0.0025;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - dy * 0.0025));
    };
    dom.addEventListener('click', () => {
      if (this.enabled && document.pointerLockElement !== dom) dom.requestPointerLock?.();
    });
    dom.addEventListener('mousedown', (e) => { if (e.button === 0) this._drag = true; });
    window.addEventListener('mouseup', () => (this._drag = false));
    window.addEventListener('mousemove', (e) => {
      if (this.enabled && (document.pointerLockElement === dom || this._drag)) look(e.movementX, e.movementY);
    });
    dom.addEventListener('wheel', (e) => {
      if (this.enabled) this.speed = Math.min(400, Math.max(5, this.speed * Math.exp(-e.deltaY * 0.001)));
    });
  }

  /** Starts flying from the current view. */
  enable() {
    this.enabled = true;
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.yaw = e.y;
    this.pitch = e.x;
  }

  disable() {
    this.enabled = false;
  }

  /** @param {(code:string)=>boolean} held */
  update(dt, held) {
    if (!this.enabled) return;
    const c = this.camera;
    c.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(c.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(c.quaternion);
    const move = new THREE.Vector3();
    if (held('KeyW') || held('ArrowUp')) move.add(fwd);
    if (held('KeyS') || held('ArrowDown')) move.sub(fwd);
    if (held('KeyD') || held('ArrowRight')) move.add(right);
    if (held('KeyA') || held('ArrowLeft')) move.sub(right);
    if (held('KeyE') || held('Space')) move.y += 1;
    if (held('KeyQ')) move.y -= 1;
    if (move.lengthSq()) c.position.addScaledVector(move.normalize(), this.speed * (held('ShiftLeft') || held('ShiftRight') ? 4 : 1) * dt);
    if (Math.abs(c.fov - 60) > 0.01) {
      c.fov += (60 - c.fov) * Math.min(1, dt * 3);
      c.updateProjectionMatrix();
    }
    c.updateMatrixWorld();
  }
}
