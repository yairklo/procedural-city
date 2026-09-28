// Stand-in character: a capsule body with a nose (to read facing) and a tallit (white prayer
// shawl with dark stripes near its ends) that hangs behind the shoulders on the ground and
// spreads out like wings in a glide, fluttering with speed.
//
// It only reads PlayerController.snapshot(). A rigged character replaces it by implementing
// the same two members: `object3D` (added to the scene) and `update(snapshot, dt)`; the
// controller's events ('jump', 'land', 'glideStart', 'mantleStart', ...) drive animations.

import * as THREE from 'three';

const TALLIT_W = 1.7, TALLIT_H = 1.1, SEG_X = 12, SEG_Y = 6;

const damp = (current, target, lambda, dt) => current + (target - current) * (1 - Math.exp(-lambda * dt));

export class PlayerProxy {
  constructor({ radius = 0.4, height = 1.8 } = {}) {
    this.object3D = new THREE.Group();
    this.object3D.name = 'PlayerProxy';

    // Body pivots at the hips so it can lean forward into a prone glide.
    this.body = new THREE.Group();
    this.body.position.y = height * 0.5;
    this.object3D.add(this.body);

    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xff7a2f, roughness: 0.5 });
    const capsule = new THREE.Mesh(new THREE.CapsuleGeometry(radius, height - radius * 2, 4, 12), bodyMat);
    capsule.castShadow = true;
    this.body.add(capsule);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.3), new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.6 }));
    nose.position.set(0, height * 0.3, -radius);
    nose.castShadow = true;
    this.body.add(nose);

    // Tallit: hangs from a shoulder line, local -Z is forward.
    this.tallitAnchor = new THREE.Group();
    this.tallitAnchor.position.set(0, height * 0.32, radius * 0.7);
    this.body.add(this.tallitAnchor);
    const geo = new THREE.PlaneGeometry(TALLIT_W, TALLIT_H, SEG_X, SEG_Y).translate(0, -TALLIT_H / 2, 0);
    geo.setAttribute('color', tallitColors(geo));
    this._rest = Float32Array.from(geo.getAttribute('position').array);
    this.tallit = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.85 }));
    this.tallit.castShadow = true;
    this.tallitAnchor.add(this.tallit);

    this.glide = 0;
    this.lean = 0;
    this.bank = 0;
    this._t = 0;
  }

  update(s, dt) {
    this._t += dt;
    const o = this.object3D;
    o.position.set(s.position.x, s.position.y, s.position.z);
    o.rotation.y = s.yaw;

    // Glide pose: lean forward almost prone, bank into turns, tallit spread wide.
    this.glide = damp(this.glide, s.state === 'glide' ? 1 : 0, 6, dt);
    this.lean = damp(this.lean, s.state === 'glide' ? -1.25 + s.glidePitch * 0.6 : s.state === 'mantle' ? -0.3 : 0, 6, dt);
    this.bank = damp(this.bank, s.state === 'glide' ? -s.glideBank : 0, 5, dt);
    this.body.rotation.set(this.lean, 0, this.bank, 'YXZ');

    // Tallit: gathered over the shoulders (0.6x width) on the ground; in a glide the body is
    // prone, so the back plane is horizontal and the cloth spreads along it like wings (1.6x).
    const g = this.glide;
    this.tallitAnchor.rotation.x = -0.15 + g * 0.25;
    this.tallit.scale.set(0.6 + g, 1 - 0.25 * g, 1);

    // Flutter: waves travel along the cloth, stronger with speed; wingtips flex in a glide.
    const pos = this.tallit.geometry.getAttribute('position');
    const a = pos.array, r = this._rest;
    const speed = s.speed;
    const amp = 0.03 + Math.min(0.12, speed * 0.006);
    const freq = 3 + Math.min(10, speed * 0.4);
    for (let i = 0; i < a.length; i += 3) {
      const x = r[i], y = r[i + 1];
      const down = -y / TALLIT_H; // 0 at the shoulders, 1 at the hem
      const tip = Math.abs(x) / (TALLIT_W / 2);
      const wave = Math.sin(this._t * freq - down * 5 + x * 2) * amp * down;
      const lift = g * tip * tip * 0.18; // wingtips curl up in a glide
      a[i + 2] = r[i + 2] + wave + lift;
    }
    pos.needsUpdate = true;
    this.tallit.geometry.computeVertexNormals();
  }

  dispose() {
    this.object3D.traverse((obj) => {
      if (obj.isMesh) {
        obj.geometry.dispose();
        obj.material.dispose();
      }
    });
  }
}

/** White wool with two dark bands near each short end, and a fringe-colored hem. */
function tallitColors(geo) {
  const p = geo.getAttribute('position');
  const col = new Float32Array(p.count * 3);
  const white = new THREE.Color(0xf2efe6), stripe = new THREE.Color(0x1c2233), hem = new THREE.Color(0xd8d2c2);
  for (let i = 0; i < p.count; i++) {
    const u = Math.abs(p.getX(i)) / (TALLIT_W / 2); // 0 center .. 1 ends
    const onStripe = (u > 0.62 && u < 0.7) || (u > 0.76 && u < 0.8);
    const c = onStripe ? stripe : u > 0.95 ? hem : white;
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  return new THREE.BufferAttribute(col, 3);
}
