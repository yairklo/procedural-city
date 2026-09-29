// Fabric awnings over ground-floor shopfronts.
//
// The stone facade shader draws its shopfronts on a grid of SHOP_BAY m bays along each wall
// (u = the world position along the wall direction, turned from the outward normal), glazed
// from ~0.3 to 2.6 m above the building's ground floor with a sign band above. Awnings use the
// same grid, so each one sits over a real shopfront, just above the glass and below the sign.
// Only walls that face a street get them (a road within a few meters in front), and not where
// the sidewalk has climbed above the shop floor or dropped well below it (hillside and
// stepped streets: the awning would hang in the air).
//
// Instanced: one unit geometry (1 m wide, 1 m deep, sloping down and out, with a front
// valance and side cheeks) scaled per awning; two materials, striped and solid.

import * as THREE from 'three';

export const SHOP_BAY = 4.2; // must match the facade shader's shop bay width
const GLASS_TOP = 2.62; // above the ground floor: just over the glazing, under the sign band
const DROP = 0.42; // how far the front edge hangs below the back (per meter of depth)
const VALANCE = 0.22;

export const AWNING_COLORS = Object.freeze({
  striped: [0x8e2a24, 0x1f5a3a, 0x7a1f1c, 0x245043, 0x2a3e63],
  solid: [0xb5562f, 0xd9c9a3, 0x2c5b3f, 0x7d2320, 0xc0673a, 0xcdbb92],
});

/**
 * @param {object} p
 * @param {object[]} p.buildings  generated buildings (rings, facade, groundY, heightAboveGround)
 * @param {(x:number, z:number) => object[]} p.roadsAt  roads whose surface contains (x, z)
 * @param {(x:number, z:number) => number} p.ground
 * @param {{ next(): number, chance(p:number): boolean, pick<T>(a:T[]): T }} p.rng
 * @returns {{x:number,y:number,z:number,ry:number,w:number,d:number,color:number,striped:boolean}[]}
 */
export function generateAwnings({ buildings, roadsAt, ground, rng, share = 0.6 }) {
  const out = [];
  for (const b of buildings) {
    const f = b.facade;
    // facade[2] = shop (0 / 1) + 2 * style; the Old City's souk shops (style 1) have no awnings.
    const style = Math.floor((f?.[2] ?? 0) / 2 + 0.01), shop = (f?.[2] ?? 0) - style * 2;
    if (!f || shop < 0.5 || style === 1 || f[1] <= 0 || b.kind !== 'building' || b.heightAboveGround < 3.6) continue;
    const striped = rng.chance(0.55);
    const color = rng.pick(striped ? AWNING_COLORS.striped : AWNING_COLORS.solid);
    const floorY = f[3];
    const ring = b.rings[0];
    let area = 0;
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) area += ring[j] * ring[i + 1] - ring[i] * ring[j + 1];
    const ccw = area > 0;
    const n = ring.length / 2;
    for (let i = 0; i < n; i++) {
      const k = (i + 1) % n;
      const ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[k * 2], bz = ring[k * 2 + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < SHOP_BAY) continue;
      // Outward normal (as the extruder builds the wall), and the shader's along-wall axis.
      let nx = (bz - az) / len, nz = -(bx - ax) / len;
      if (!ccw) { nx = -nx; nz = -nz; }
      const tx = -nz, tz = nx;
      const uA = ax * tx + az * tz, uB = bx * tx + bz * tz;
      const u0 = Math.min(uA, uB), u1 = Math.max(uA, uB);
      // A street in front of this wall?
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      if (![2.5, 5, 8].some((d) => roadsAt(mx + nx * d, mz + nz * d).length)) continue;
      for (let bay = Math.ceil((u0 + 1.8) / SHOP_BAY - 0.5); (bay + 0.5) * SHOP_BAY <= u1 - 1.8; bay++) {
        if (!rng.chance(share)) continue;
        const uc = (bay + 0.5) * SHOP_BAY;
        const t = (uc - uA) / (uB - uA);
        const px = ax + (bx - ax) * t, pz = az + (bz - az) * t;
        const g = ground(px + nx * 1.2, pz + nz * 1.2);
        if (g > floorY + 0.5) continue; // the sidewalk has climbed over the shopfront
        if (g < floorY - 0.8) continue; // or dropped well below it (stepped streets): it would hang in the air
        const d = 1.1 + rng.next() * 0.35;
        out.push({ x: px + nx * 0.04, y: floorY + GLASS_TOP, z: pz + nz * 0.04, ry: Math.atan2(nx, nz), w: 3.3, d, color, striped });
      }
    }
  }
  return out;
}

/** Unit awning: x in [-0.5, 0.5], back edge at the origin, sloping down toward +z. */
export function createAwningGeometry() {
  const P = [];
  const quad = (a, b, c, d) => P.push(...a, ...b, ...c, ...a, ...c, ...d);
  const y1 = -DROP, y2 = -DROP - VALANCE;
  quad([-0.5, 0, 0], [0.5, 0, 0], [0.5, y1, 1], [-0.5, y1, 1]); // canopy
  quad([-0.5, y1, 1], [0.5, y1, 1], [0.5, y2, 1], [-0.5, y2, 1]); // front valance
  for (const x of [-0.5, 0.5]) P.push(x, 0, 0, x, y1, 1, x, y2, 1, x, 0, 0, x, y2, 1, x, y2 * 0.35, 0.12); // side cheeks
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  // A u coordinate across the width (0..1) for the stripes.
  const uv = [];
  for (let i = 0; i < P.length; i += 3) uv.push(P[i] + 0.5, P[i + 2]);
  g.setAttribute('aAw', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/**
 * Canvas awning material (instance colour = the fabric colour). `striped`: alternating stripes
 * of the colour and off-white, ~25 cm wide whatever the awning's width; the valance edge is
 * slightly darker and the fabric lets a little warm shop light through at night.
 */
export function createAwningMaterial(uniforms, { striped = false } = {}) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0, side: THREE.DoubleSide });
  mat.customProgramCacheKey = () => `awning-${striped ? 'striped' : 'solid'}`;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uniforms?.uNight ?? { value: 0 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aAw;\nvarying vec2 vAw;\nvarying float vAwY;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  float awWidth = length(vec3(instanceMatrix[0]));
  vAw = vec2(aAw.x * awWidth, aAw.y);
  vAwY = position.y;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nvarying vec2 vAw;\nvarying float vAwY;')
      .replace('#include <color_fragment>', `#include <color_fragment>
  ${striped ? `float awS = fract(vAw.x / 0.5);
  float awAa = fwidth(vAw.x / 0.5) + 1e-4;
  float awStripe = smoothstep(0.5 - awAa, 0.5 + awAa, awS) * (1.0 - smoothstep(1.0 - awAa, 1.0, awS));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.88, 0.82), awStripe);` : ''}
  // Weathering: faded near the front, a darker valance hem.
  diffuseColor.rgb *= mix(1.0, 0.82, 1.0 - smoothstep(${(-DROP - VALANCE).toFixed(2)}, ${(-DROP - 0.02).toFixed(2)}, vAwY));
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.12 + 0.03, vAw.y * 0.4);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.75, 0.45) * uNight * 0.12;`);
  };
  return mat;
}
