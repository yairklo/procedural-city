// Wind / speed lines around the character during fast glides: thin streaks that stream past
// along the flight direction, fading in with glide speed. One draw call (LineSegments).

import * as THREE from 'three';

const COUNT = 70;
const RADIUS_MIN = 1.2, RADIUS_MAX = 4.5;
const LENGTH_AHEAD = 10, LENGTH_BEHIND = 8;

export class GlideEffects {
  constructor() {
    this.positions = new Float32Array(COUNT * 6);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.LineBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    this.object3D = new THREE.LineSegments(geo, this.material);
    this.object3D.name = 'GlideSpeedLines';
    this.object3D.frustumCulled = false;
    this.object3D.visible = false;
    // Each streak: offset across the flight direction (a, r) and a position along it (s).
    this.streaks = Array.from({ length: COUNT }, () => this._spawn({}, true));
    this.intensity = 0;
    this._dir = new THREE.Vector3(0, 0, -1);
    this._side = new THREE.Vector3();
    this._up = new THREE.Vector3();
  }

  _spawn(st, anywhere = false) {
    st.a = Math.random() * Math.PI * 2;
    st.r = RADIUS_MIN + Math.random() * (RADIUS_MAX - RADIUS_MIN);
    st.s = anywhere ? -LENGTH_BEHIND + Math.random() * (LENGTH_AHEAD + LENGTH_BEHIND) : LENGTH_AHEAD;
    st.k = 0.7 + Math.random() * 0.6; // speed variation
    return st;
  }

  update(snapshot, dt) {
    const v = snapshot.velocity;
    const speed = snapshot.speed;
    const target = snapshot.state === 'glide' ? Math.min(1, Math.max(0, (speed - 9) / 18)) : 0;
    this.intensity += (target - this.intensity) * (1 - Math.exp(-4 * dt));
    this.object3D.visible = this.intensity > 0.01;
    if (!this.object3D.visible) return;
    this.material.opacity = 0.35 * this.intensity;

    // Frame aligned with the flight direction.
    if (speed > 0.5) this._dir.set(v.x, v.y, v.z).normalize();
    this._side.set(-this._dir.z, 0, this._dir.x);
    if (this._side.lengthSq() < 1e-6) this._side.set(1, 0, 0);
    this._side.normalize();
    this._up.crossVectors(this._side, this._dir).normalize();

    const c = snapshot.position;
    const cy = c.y + 1;
    const len = 0.6 + speed * 0.06;
    const d = this._dir, sd = this._side, up = this._up;
    for (let i = 0; i < COUNT; i++) {
      const st = this.streaks[i];
      st.s -= speed * st.k * 0.9 * dt; // streaks stream backward past the character
      if (st.s < -LENGTH_BEHIND) this._spawn(st);
      const ox = Math.cos(st.a) * st.r, oy = Math.sin(st.a) * st.r;
      const px = c.x + sd.x * ox + up.x * oy + d.x * st.s;
      const py = cy + sd.y * ox + up.y * oy + d.y * st.s;
      const pz = c.z + sd.z * ox + up.z * oy + d.z * st.s;
      const j = i * 6;
      this.positions[j] = px; this.positions[j + 1] = py; this.positions[j + 2] = pz;
      this.positions[j + 3] = px - d.x * len; this.positions[j + 4] = py - d.y * len; this.positions[j + 5] = pz - d.z * len;
    }
    this.object3D.geometry.getAttribute('position').needsUpdate = true;
  }

  dispose() {
    this.object3D.geometry.dispose();
    this.material.dispose();
  }
}
