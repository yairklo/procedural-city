// Market stalls and their goods, instanced: a handful of unit geometries (a display counter,
// a crate, a heap of produce, an open burlap sack, a steel bowl, a spice cone, a generic block,
// a price card, a market umbrella) placed thousands of times with a per-instance colour.
//
//   const kit = createStallKit();
//   kit.stall(x, y, z, ry, 'produce', rng)   // one stall: counter + goods by kind
//   const meshes = kit.build(material)       // InstancedMesh per part (a few draw calls)
//
// Kinds (what the stall sells, as seen in Mahane Yehuda and the Old City souks):
//   produce  red / green / blue plastic crates of fruit and vegetables, tilted toward the aisle
//   nuts     open burlap sacks of nuts, seeds, dried fruit
//   spice    spice cones in steel bowls, sacks of herbs, jars on shelves
//   bakery   baskets of loaves, trays of rugelach and pastries
//   halva    blocks of halva in stacks
//   butcher  a glass counter, meat
//   fabric   folded bolts and scarves in stacks, hanging textiles
//   souvenir ceramics, lamps, scarves hanging, stacked boxes
//   food     trays of sweets, pickles and olives in tubs
//   gallery  (the Cardo) glazed shop windows, no stall
// Every stall carries white price cards stuck in its goods.
//
// Units: metres; local axes: x along the shopfront, z toward the aisle, y up. No three.js
// objects are kept per instance (flat Float32Arrays), so thousands cost little.

import * as THREE from 'three';

export const PRODUCE = [0xc8321e, 0xe8841c, 0xe8d23a, 0x9ec13a, 0xb02a22, 0xe6cc4a, 0x3f7a2a, 0x3b1f3f, 0xd14a24, 0xb08a55, 0xc9a36a, 0x8e1a1f, 0x5a2a55, 0x9cb04a, 0x3f7f2f, 0xd8d0b0, 0x7a9a3a, 0xf0a030];
export const NUTS = [0xb58a5a, 0xa8a060, 0xe07a2a, 0x5a2f18, 0xc9b48a, 0x8a5a32, 0xd8c8a0, 0x6a3a22, 0xe0b060];
export const SPICES = [0xa3301a, 0xd8a01a, 0x6a7a3a, 0x9a6a3a, 0xc85a1a, 0x7a2a18, 0xe8c040, 0x4a5a2a, 0xb87a3a];
export const BREAD = [0xb87a3a, 0xc8904a, 0x9a5a2a, 0xd8a860, 0x7a4a22];
export const HALVA = [0xd8c8a8, 0xc8b08a, 0x9a7a5a, 0xe0d4b8, 0xb89878];
export const FABRIC = [0x8e2a24, 0x2a3e63, 0x1f5a3a, 0xc0a040, 0x6a2a5a, 0xd8d0c0, 0x2a2a2a, 0xa05a2a, 0x3a6a8a];
export const SOUVENIR = [0x2a5a8a, 0xc8a040, 0x8a2a2a, 0xd8d0c0, 0x2a7a6a, 0xa87a3a, 0x5a3a6a, 0xe0e0d8];
export const CRATES = [0xb02a22, 0x2a6a3a, 0x2a4a8a, 0xb02a22, 0x8a6a3a, 0x3a3a3a];
export const SIGNS = [0xb02a22, 0xe8e2d4, 0x1f2a36, 0xd8b030, 0x2a6a3a, 0x2a4a8a, 0xe8e2d4, 0x8a2a2a];

const hash = (a, b = 0) => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

// --- unit geometries (vertex colours: 1 = takes the instance colour fully) -------------------

function colored(geo, hex = 0xffffff) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('uv');
  const c = new THREE.Color(hex);
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

/** A display counter 1 m wide (scaled per stall), 0.9 m deep, 0.85 m high at the back, the top tilted toward the aisle. */
function counterGeometry() {
  const P = [];
  const quad = (a, b, c, d) => P.push(...a, ...b, ...c, ...a, ...c, ...d);
  const w = 0.5, d0 = 0, d1 = 0.9, hB = 0.92, hF = 0.72;
  quad([-w, hB, d0], [w, hB, d0], [w, hF, d1], [-w, hF, d1]); // tilted top
  quad([-w, 0, d1], [w, 0, d1], [w, hF, d1], [-w, hF, d1]); // front
  quad([w, 0, d0], [w, 0, d1], [w, hF, d1], [w, hB, d0]); // sides
  quad([-w, 0, d1], [-w, 0, d0], [-w, hB, d0], [-w, hF, d1]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  return colored(g);
}

/** An open crate 0.5 x 0.36, 0.2 high (rim and sides; the heap fills it). */
function crateGeometry() {
  return colored(new THREE.BoxGeometry(0.5, 0.2, 0.36, 1, 1, 1).translate(0, 0.1, 0));
}

/** A heap of produce: a flattened, bumpy half-dome 0.48 x 0.34. */
function heapGeometry() {
  const g = new THREE.SphereGeometry(0.5, 6, 2, 0, Math.PI * 2, 0, Math.PI / 2);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + 0.18 * (hash(Math.round(x * 50), Math.round(z * 50)) - 0.5);
    p.setXYZ(i, x * 0.48 * k, y * 0.28 * k, z * 0.34 * k);
  }
  return colored(g);
}

/** An open burlap sack, rolled rim (0.46 across, 0.5 high); its contents are a heap on top. */
function sackGeometry() {
  const pts = [[0.2, 0], [0.24, 0.14], [0.25, 0.42], [0.27, 0.5], [0.21, 0.46]];
  const g = new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), 6);
  return colored(g, 0xc9b48a);
}

/** A steel bowl 0.5 across (for spice cones). */
function bowlGeometry() {
  const pts = [[0.12, 0], [0.24, 0.1], [0.26, 0.16]];
  return colored(new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), 7), 0xb8bcc0);
}

/** A spice cone, 0.22 radius, 0.55 high. */
function coneGeometry() {
  return colored(new THREE.ConeGeometry(0.22, 0.55, 7, 1, true).translate(0, 0.275, 0));
}

/** A unit box (1 m cube, base at y = 0): loaves, halva, fabric bolts, shelves of goods, signs. */
function blockGeometry() {
  return colored(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
}

/** A flat panel 1 x 1 (base at y = 0, facing +z): shelves of goods seen from the aisle, signs,
 * banners, hanging textiles (two triangles instead of a box's twelve). */
function panelGeometry() {
  const P = [-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  return colored(g);
}

/** A price card 0.14 x 0.1 on a stick, facing the aisle. */
function cardGeometry() {
  const P = [-0.07, 0.06, 0, 0.07, 0.06, 0, 0.07, 0.16, 0, -0.07, 0.06, 0, 0.07, 0.16, 0, -0.07, 0.16, 0];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  return colored(g);
}

/** A market umbrella: pole 2.3 m, an 8-sided canopy 2.4 m across (instance colour: canopy). */
function umbrellaGeometry() {
  const pole = colored(new THREE.CylinderGeometry(0.03, 0.03, 2.3, 5).translate(0, 1.15, 0), 0x4a4a4a);
  const canopy = colored(new THREE.ConeGeometry(1.2, 0.45, 8, 1, true).translate(0, 2.35, 0));
  const g = mergeColored([pole, canopy]);
  return g;
}

function mergeColored(parts) {
  const pos = [], nrm = [], col = [];
  for (const p of parts) {
    pos.push(...p.getAttribute('position').array);
    nrm.push(...p.getAttribute('normal').array);
    col.push(...p.getAttribute('color').array);
    p.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

const PARTS = {
  counter: { make: counterGeometry, cast: true },
  crate: { make: crateGeometry, cast: false },
  heap: { make: heapGeometry, cast: false },
  sack: { make: sackGeometry, cast: false },
  bowl: { make: bowlGeometry, cast: false },
  cone: { make: coneGeometry, cast: false },
  block: { make: blockGeometry, cast: true },
  panel: { make: panelGeometry, cast: false },
  card: { make: cardGeometry, cast: false },
  umbrella: { make: umbrellaGeometry, cast: true },
};

/** Material for the goods: vertex colour x instance colour, a little sheen, faintly self-lit
 * (market goods under a roof or an awning still read in colour). */
export function createGoodsMaterial(uniforms) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0 });
  mat.customProgramCacheKey = () => 'market-goods-v1';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uniforms?.uNight ?? { value: 0 };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  // Shop and stall lights: goods keep their colour in the shade and glow warm at night.
  totalEmissiveRadiance += diffuseColor.rgb * (0.1 + 0.35 * uNight) * vec3(1.0, 0.92, 0.8);`);
  };
  return mat;
}

export function createStallKit() {
  const items = Object.fromEntries(Object.keys(PARTS).map((k) => [k, []]));
  // An item: position, yaw, scale (x, y, z), colour, and an optional tilt (around local x).
  const put = (part, x, y, z, ry, sx, sy, sz, color, tilt = 0) => items[part].push(x, y, z, ry, sx, sy, sz, color, tilt);

  /** A point on the stall: local (u along, v out, h up) -> world. */
  const frame = (x, y, z, ry) => {
    const c = Math.cos(ry), s = Math.sin(ry);
    return (u, v, h) => [x + c * u + s * v, y + h, z - s * u + c * v];
  };

  const kit = {
    items,
    put,
    /**
     * One stall with its goods, `width` m along the shopfront, facing +z (turned by ry), its back
     * edge at (x, z) on the ground y.
     */
    stall(x, y, z, ry, kind, { width = 2.8, seed = 0, counter = true } = {}) {
      const r = (k) => hash(seed * 1.37 + k * 7.1, seed * 0.61 + k * 3.3);
      const P = frame(x, y, z, ry);
      const topY = (v) => 0.92 - (0.2 * v) / 0.9; // counter top height at depth v
      const tilt = Math.atan2(0.2, 0.9);
      if (counter && kind !== 'gallery') {
        const [cx, cy, cz] = P(0, 0, 0);
        put('counter', cx, cy, cz, ry, width, 1, 1, [0x6b5039, 0x8a8f93, 0xd8d2c4, 0x5a3a28][Math.floor(r(1) * 4)]);
      }
      const cols = Math.max(2, Math.floor(width / 0.52));
      const card = (u, v, h) => { const [px, py, pz] = P(u, v, h); put('card', px, py, pz, ry, 1, 1, 1, r(u * 9 + v) < 0.8 ? 0xf4f2ea : 0xf2e070); };
      if (kind === 'produce' || kind === 'food') {
        const palette = kind === 'produce' ? PRODUCE : [...NUTS, 0x3f6a2a, 0x7a8a3a, 0xc8321e];
        const crate = CRATES[Math.floor(r(2) * CRATES.length)];
        for (let row = 0; row < 2; row++) {
          for (let c = 0; c < cols; c++) {
            const u = -width / 2 + (c + 0.5) * (width / cols), v = 0.22 + row * 0.42;
            const [px, py, pz] = P(u, v, topY(v));
            put('crate', px, py, pz, ry, 1, 1, 1, crate, tilt);
            const [hx, hy, hz] = P(u, v, topY(v) + 0.14);
            put('heap', hx, hy, hz, ry, 1, 0.8 + r(c + row * 9) * 0.5, 1, palette[Math.floor(r(c * 3 + row + 5) * palette.length)], tilt);
            if ((c + row) % 2 === 0) card(u, v + 0.12, topY(v) + 0.22);
          }
        }
        // Crates stacked on the ground beside the counter.
        for (let k = 0; k < 3; k++) {
          const [px, py, pz] = P(width / 2 + 0.35, 0.35, k * 0.21);
          put('crate', px, py, pz, ry + (r(k + 40) - 0.5) * 0.3, 1, 1, 1, crate);
          if (k === 2) { const [hx, hy, hz] = P(width / 2 + 0.35, 0.35, k * 0.21 + 0.14); put('heap', hx, hy, hz, ry, 1, 1, 1, palette[Math.floor(r(50) * palette.length)]); }
        }
      } else if (kind === 'nuts' || kind === 'spice') {
        const palette = kind === 'nuts' ? NUTS : SPICES;
        // Sacks on the ground in front of the counter, cones in bowls on it.
        for (let c = 0; c < cols; c++) {
          const u = -width / 2 + (c + 0.5) * (width / cols);
          const [sx, sy, sz] = P(u, 1.2, 0);
          put('sack', sx, sy, sz, ry, 1, 0.9 + r(c) * 0.3, 1, 0xffffff);
          const [hx, hy, hz] = P(u, 1.2, 0.44 + r(c) * 0.08);
          put('heap', hx, hy, hz, ry, 0.5, 0.6, 0.7, palette[Math.floor(r(c * 5 + 1) * palette.length)]);
          card(u, 1.36, 0.5);
          const v = 0.45, [bx, by, bz] = P(u, v, topY(v));
          if (kind === 'spice') {
            put('bowl', bx, by, bz, ry, 1, 1, 1, 0xffffff);
            put('cone', bx, by + 0.12, bz, ry, 1, 0.8 + r(c + 20) * 0.7, 1, palette[Math.floor(r(c * 7 + 2) * palette.length)]);
          } else {
            put('crate', bx, by, bz, ry, 1, 1, 1, 0x8a6a3a, tilt);
            const [hx2, hy2, hz2] = P(u, v, topY(v) + 0.14);
            put('heap', hx2, hy2, hz2, ry, 1, 0.8, 1, palette[Math.floor(r(c * 11 + 3) * palette.length)], tilt);
          }
        }
      } else if (kind === 'bakery' || kind === 'halva') {
        const palette = kind === 'bakery' ? BREAD : HALVA;
        for (let c = 0; c < cols; c++) {
          const u = -width / 2 + (c + 0.5) * (width / cols);
          for (let row = 0; row < 2; row++) {
            const v = 0.2 + row * 0.42, [px, py, pz] = P(u, v, topY(v));
            if (kind === 'bakery') {
              put('crate', px, py, pz, ry, 1, 0.6, 1, 0xb8904a, tilt);
              for (let k = 0; k < 3; k++) {
                const [lx, ly, lz] = P(u - 0.14 + k * 0.14, v, topY(v) + 0.1);
                put('block', lx, ly, lz, ry + 0.2 * (r(k + c) - 0.5), 0.1, 0.09, 0.3, palette[Math.floor(r(c * 3 + k + row) * palette.length)], tilt);
              }
            } else {
              put('block', px, py, pz, ry, 0.36, 0.2 + r(c + row) * 0.18, 0.28, palette[Math.floor(r(c * 5 + row) * palette.length)], tilt);
            }
            if (row === 1) card(u, v + 0.16, topY(v) + 0.2);
          }
        }
      } else if (kind === 'butcher') {
        // A glass counter: a pale base and a reddish display.
        for (let c = 0; c < cols; c++) {
          const u = -width / 2 + (c + 0.5) * (width / cols), v = 0.45, [px, py, pz] = P(u, v, topY(v));
          put('block', px, py, pz, ry, width / cols - 0.05, 0.08, 0.7, [0xa83a32, 0xc86a5a, 0x8a2a24][Math.floor(r(c) * 3)], tilt);
        }
      } else if (kind === 'fabric' || kind === 'souvenir') {
        const palette = kind === 'fabric' ? FABRIC : SOUVENIR;
        for (let c = 0; c < cols; c++) {
          const u = -width / 2 + (c + 0.5) * (width / cols);
          let h = topY(0.4);
          for (let k = 0; k < 2 + Math.floor(r(c) * 4); k++) {
            const t = kind === 'fabric' ? 0.08 : 0.14 + r(c + k) * 0.12;
            const [px, py, pz] = P(u, 0.4, h);
            put('block', px, py, pz, ry + (r(c * 3 + k) - 0.5) * 0.2, 0.42, t, 0.32, palette[Math.floor(r(c * 7 + k) * palette.length)]);
            h += t;
          }
          if (c % 2 === 0) card(u, 0.62, topY(0.62) + 0.05);
        }
      }
      // Hanging goods above the stall (scarves, bags, garlic strings, lamps) on some stalls.
      if (kind !== 'produce' && kind !== 'gallery' && kind !== 'butcher' || r(90) < 0.3) {
        const palette = kind === 'produce' ? [0xe8e0c8, 0xc8321e] : kind === 'fabric' || kind === 'souvenir' ? [...FABRIC, ...SOUVENIR] : [0xd8d0b0, 0x8a2a24, 0x2a4a8a, 0xc8a040];
        for (let c = 0; c < cols + 1; c++) {
          const len = 0.3 + r(c + 71) * 0.3;
          const u = -width / 2 + (c + 0.3) * (width / (cols + 1)), [px, py, pz] = P(u, 0.08, 2.35 - len);
          put('panel', px, py, pz, ry, 0.18, len, 1, palette[Math.floor(r(c * 13 + 7) * palette.length)]);
        }
      }
    },
    /** A café table with two stools (tables in the market aisles and squares). */
    table(x, y, z, ry, seed = 0) {
      const P = frame(x, y, z, ry);
      const [tx, ty, tz] = P(0, 0, 0);
      put('block', tx, ty + 0.7, tz, ry, 0.7, 0.04, 0.7, 0x7a5a3a);
      put('block', tx, ty, tz, ry, 0.08, 0.7, 0.08, 0x3a3a3a);
      for (const s of [-0.6, 0.6]) {
        const [sx, sy, sz] = P(s, 0, 0);
        put('block', sx, sy, sz, ry, 0.34, 0.45, 0.34, [0x2a4a8a, 0xb02a22, 0x3a3a3a, 0xd8d0c0][Math.floor(hash(seed, s) * 4)]);
      }
    },
    umbrella(x, y, z, color) {
      put('umbrella', x, y, z, 0, 1, 1, 1, color);
    },
    /** Instanced meshes for everything collected (one per part used). */
    build(material) {
      const out = [];
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3(), c = new THREE.Color();
      for (const [name, list] of Object.entries(items)) {
        const n = list.length / 9;
        if (!n) continue;
        const geo = PARTS[name].make();
        const mesh = new THREE.InstancedMesh(geo, material, n);
        mesh.name = `Stalls(${name})`;
        for (let i = 0; i < n; i++) {
          const k = i * 9;
          p.set(list[k], list[k + 1], list[k + 2]);
          q.setFromEuler(e.set(list[k + 8], list[k + 3], 0, 'YXZ'));
          s.set(list[k + 4], list[k + 5], list[k + 6]);
          mesh.setMatrixAt(i, m.compose(p, q, s));
          mesh.setColorAt(i, c.setHex(list[k + 7]));
        }
        mesh.computeBoundingSphere();
        mesh.castShadow = PARTS[name].cast;
        mesh.receiveShadow = true;
        out.push(mesh);
      }
      return out;
    },
    count() {
      return Object.values(items).reduce((a, l) => a + l.length / 9, 0);
    },
  };
  return kit;
}
