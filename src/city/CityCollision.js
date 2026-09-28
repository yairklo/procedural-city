// Static AABB collision world for the city.
//
// Boxes are bucketed into a uniform grid on the XZ plane (a spatial hash), so a
// query only looks at the few cells it overlaps instead of every box in the city.
// No three.js dependency: vectors are any object with numeric x / y / z fields,
// so the same code can run in a worker or on a server for authoritative physics.

const EPS = 1e-6;
const MAX_RAY_DISTANCE = 1e5;

const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

/**
 * @typedef {object} CollisionBox
 * @property {number} minX
 * @property {number} minY
 * @property {number} minZ
 * @property {number} maxX
 * @property {number} maxY
 * @property {number} maxZ
 * @property {string} kind   e.g. 'building' | 'roof-prop' | 'sidewalk' | 'park' | 'tree'
 * @property {string|null} ref  id of the owning object (building id, block id, ...)
 * @property {number} index
 */

export class CityCollisionWorld {
  /** @param {{ cellSize?: number }} [options] */
  constructor({ cellSize = 32 } = {}) {
    this.cellSize = cellSize;
    /** @type {CollisionBox[]} */
    this.boxes = [];
    /** @type {Map<number, number[]>} */
    this.cells = new Map();
    // Per-box "last visited" stamp used to de-duplicate boxes spanning several cells.
    this._visited = [];
    this._stamp = 0;
    this._push = { x: 0, y: 0, z: 0 };
    this._candidates = [];
  }

  static cellKey(ix, iz) {
    // Unique for |ix|, |iz| < 32768 cells (≈ ±1000 km at 32 m cells).
    return (ix + 0x8000) * 0x10000 + (iz + 0x8000);
  }

  /**
   * Adds a static box. Returns the stored box.
   * @param {{minX:number,minY:number,minZ:number,maxX:number,maxY:number,maxZ:number,kind?:string,ref?:string|null}} box
   */
  add(box) {
    const b = {
      minX: box.minX, minY: box.minY, minZ: box.minZ,
      maxX: box.maxX, maxY: box.maxY, maxZ: box.maxZ,
      kind: box.kind ?? 'solid',
      ref: box.ref ?? null,
      index: this.boxes.length,
    };
    if (!(b.maxX > b.minX && b.maxY > b.minY && b.maxZ > b.minZ)) {
      throw new Error(`CityCollisionWorld.add: degenerate box ${JSON.stringify(box)}`);
    }
    this.boxes.push(b);
    this._visited.push(0);

    const cs = this.cellSize;
    const ix0 = Math.floor(b.minX / cs), ix1 = Math.floor(b.maxX / cs);
    const iz0 = Math.floor(b.minZ / cs), iz1 = Math.floor(b.maxZ / cs);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const key = CityCollisionWorld.cellKey(ix, iz);
        let cell = this.cells.get(key);
        if (!cell) {
          cell = [];
          this.cells.set(key, cell);
        }
        cell.push(b.index);
      }
    }
    return b;
  }

  /** All boxes overlapping the given AABB (touching counts). */
  queryAABB(minX, minY, minZ, maxX, maxY, maxZ, out = []) {
    const cs = this.cellSize;
    const stamp = ++this._stamp;
    const ix0 = Math.floor(minX / cs), ix1 = Math.floor(maxX / cs);
    const iz0 = Math.floor(minZ / cs), iz1 = Math.floor(maxZ / cs);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const cell = this.cells.get(CityCollisionWorld.cellKey(ix, iz));
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          const idx = cell[i];
          if (this._visited[idx] === stamp) continue;
          this._visited[idx] = stamp;
          const b = this.boxes[idx];
          if (b.minX <= maxX && b.maxX >= minX && b.minY <= maxY && b.maxY >= minY && b.minZ <= maxZ && b.maxZ >= minZ) {
            out.push(b);
          }
        }
      }
    }
    return out;
  }

  /** All boxes containing the point. */
  queryPoint(x, y, z, out = []) {
    return this.queryAABB(x, y, z, x, y, z, out);
  }

  /**
   * Height of the highest box top under (x, z) that is at or below `maxY`.
   * Pass the character's feet height + step height as `maxY` so it can step onto
   * curbs but not "teleport" onto a roof above it.
   */
  groundHeight(x, z, maxY = Infinity, baseHeight = 0) {
    let best = baseHeight;
    const cs = this.cellSize;
    const cell = this.cells.get(CityCollisionWorld.cellKey(Math.floor(x / cs), Math.floor(z / cs)));
    if (!cell) return best;
    for (let i = 0; i < cell.length; i++) {
      const b = this.boxes[cell[i]];
      if (b.maxY > best && b.maxY <= maxY && x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) {
        best = b.maxY;
      }
    }
    return best;
  }

  /**
   * Pushes a sphere out of every box it overlaps. Mutates `center`.
   * @returns {{collided:boolean, grounded:boolean, ceiling:boolean, hits:CollisionBox[]}}
   */
  resolveSphere(center, radius, maxIterations = 4) {
    return this._resolve(center, radius, 0, 0, maxIterations);
  }

  /**
   * Pushes a vertical capsule out of every box it overlaps. Mutates `feet`.
   * `feet` is the bottom of the capsule; `height` its total height (>= 2 * radius).
   * Boxes whose top is within `stepHeight` of the feet (curbs, low ledges) are ignored
   * here so the character can walk onto them; use groundHeight() to stand on them.
   * @returns {{collided:boolean, grounded:boolean, ceiling:boolean, hits:CollisionBox[]}}
   */
  resolveCapsule(feet, radius, height, stepHeight = 0, maxIterations = 4) {
    const segLow = radius;
    const segHigh = Math.max(radius, height - radius);
    return this._resolve(feet, radius, segLow, segHigh, maxIterations, true, stepHeight);
  }

  _resolve(p, radius, segLow, segHigh, maxIterations, isCapsule = false, stepHeight = -Infinity) {
    const result = { collided: false, grounded: false, ceiling: false, hits: [] };
    const push = this._push;
    const seen = new Set();

    for (let iter = 0; iter < maxIterations; iter++) {
      const bottom = isCapsule ? p.y : p.y - radius;
      const top = isCapsule ? p.y + segHigh + radius : p.y + radius;
      const candidates = this.queryAABB(p.x - radius, bottom, p.z - radius, p.x + radius, top, p.z + radius, (this._candidates.length = 0, this._candidates));
      let moved = false;

      for (const b of candidates) {
        if (b.maxY <= p.y + stepHeight) continue;
        // Sphere center: for a capsule, the point on its axis nearest the box.
        let cy = p.y;
        if (isCapsule) {
          const yLow = p.y + segLow, yHigh = p.y + segHigh;
          cy = yHigh < b.minY ? yHigh : yLow > b.maxY ? yLow : clamp((b.minY + b.maxY) * 0.5, yLow, yHigh);
        }
        if (!sphereVsBox(p.x, cy, p.z, radius, b, push)) continue;

        p.x += push.x;
        p.y += push.y;
        p.z += push.z;
        moved = true;
        result.collided = true;
        const len = Math.hypot(push.x, push.y, push.z);
        if (len > EPS) {
          if (push.y / len > 0.7) result.grounded = true;
          else if (push.y / len < -0.7) result.ceiling = true;
        }
        if (!seen.has(b)) {
          seen.add(b);
          result.hits.push(b);
        }
      }
      if (!moved) break;
    }
    return result;
  }

  /**
   * Casts a ray against all boxes (and optionally the y = groundY plane).
   * Walks the grid cells along the ray with a 2D DDA, stopping as soon as a hit
   * is closer than the next cell boundary.
   * @returns {{distance:number, point:{x:number,y:number,z:number}, normal:{x:number,y:number,z:number}, box:CollisionBox|null} | null}
   */
  raycast(origin, direction, maxDistance = 1000, { includeGround = true, groundY = 0, filter = null } = {}) {
    let dx = direction.x, dy = direction.y, dz = direction.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < EPS) return null;
    dx /= len; dy /= len; dz /= len;
    const ox = origin.x, oy = origin.y, oz = origin.z;
    const maxT = Math.min(maxDistance, MAX_RAY_DISTANCE);

    const cs = this.cellSize;
    let ix = Math.floor(ox / cs), iz = Math.floor(oz / cs);
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    let tMaxX = stepX !== 0 ? ((ix + (stepX > 0 ? 1 : 0)) * cs - ox) / dx : Infinity;
    let tMaxZ = stepZ !== 0 ? ((iz + (stepZ > 0 ? 1 : 0)) * cs - oz) / dz : Infinity;
    const tDeltaX = stepX !== 0 ? cs / Math.abs(dx) : Infinity;
    const tDeltaZ = stepZ !== 0 ? cs / Math.abs(dz) : Infinity;

    const stamp = ++this._stamp;
    const hit = { t: 0, axis: 0, sign: 0 };
    let bestT = maxT, bestBox = null, bestAxis = -1, bestSign = 0;

    for (let guard = 0; guard < 1e6; guard++) {
      const cell = this.cells.get(CityCollisionWorld.cellKey(ix, iz));
      if (cell) {
        for (let i = 0; i < cell.length; i++) {
          const idx = cell[i];
          if (this._visited[idx] === stamp) continue;
          this._visited[idx] = stamp;
          const b = this.boxes[idx];
          if (filter && !filter(b)) continue;
          if (rayVsBox(ox, oy, oz, dx, dy, dz, b, bestT, hit) && hit.t < bestT) {
            bestT = hit.t;
            bestBox = b;
            bestAxis = hit.axis;
            bestSign = hit.sign;
          }
        }
      }
      const tNext = Math.min(tMaxX, tMaxZ);
      if (tNext > bestT || tNext === Infinity) break;
      if (tMaxX < tMaxZ) {
        ix += stepX;
        tMaxX += tDeltaX;
      } else {
        iz += stepZ;
        tMaxZ += tDeltaZ;
      }
    }

    const normal = { x: 0, y: 0, z: 0 };
    if (bestBox) {
      if (bestAxis === 0) normal.x = bestSign;
      else if (bestAxis === 1) normal.y = bestSign;
      else if (bestAxis === 2) normal.z = bestSign;
      else { normal.x = -dx; normal.y = -dy; normal.z = -dz; } // origin inside the box
    }

    if (includeGround && dy < -EPS) {
      const tg = (groundY - oy) / dy;
      if (tg >= 0 && tg < bestT) {
        bestT = tg;
        bestBox = null;
        normal.x = 0; normal.y = 1; normal.z = 0;
        return { distance: tg, point: { x: ox + dx * tg, y: groundY, z: oz + dz * tg }, normal, box: null };
      }
    }

    if (!bestBox) return null;
    return { distance: bestT, point: { x: ox + dx * bestT, y: oy + dy * bestT, z: oz + dz * bestT }, normal, box: bestBox };
  }

  stats() {
    return { boxes: this.boxes.length, cells: this.cells.size, cellSize: this.cellSize };
  }
}

/** Minimum translation that moves a sphere out of a box, written into `out`. */
function sphereVsBox(cx, cy, cz, r, b, out) {
  const px = clamp(cx, b.minX, b.maxX);
  const py = clamp(cy, b.minY, b.maxY);
  const pz = clamp(cz, b.minZ, b.maxZ);
  const dx = cx - px, dy = cy - py, dz = cz - pz;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= r * r - EPS) return false;

  if (d2 > EPS * EPS) {
    const d = Math.sqrt(d2);
    const k = (r - d) / d;
    out.x = dx * k; out.y = dy * k; out.z = dz * k;
    return true;
  }

  // Center is inside the box: exit through the nearest face.
  const pen = [
    cx - b.minX + r, b.maxX - cx + r,
    cy - b.minY + r, b.maxY - cy + r,
    cz - b.minZ + r, b.maxZ - cz + r,
  ];
  let m = 0;
  for (let i = 1; i < 6; i++) if (pen[i] < pen[m]) m = i;
  out.x = 0; out.y = 0; out.z = 0;
  const sign = m % 2 === 0 ? -1 : 1;
  if (m < 2) out.x = sign * pen[m];
  else if (m < 4) out.y = sign * pen[m];
  else out.z = sign * pen[m];
  return true;
}

/** Slab test. On hit writes entry distance, entry axis (0/1/2, -1 = inside) and face sign into `out`. */
function rayVsBox(ox, oy, oz, dx, dy, dz, b, tLimit, out) {
  let tMin = 0, tMax = tLimit, axis = -1, sign = 0;
  const o = [ox, oy, oz], d = [dx, dy, dz];
  const mins = [b.minX, b.minY, b.minZ], maxs = [b.maxX, b.maxY, b.maxZ];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < EPS) {
      if (o[a] < mins[a] || o[a] > maxs[a]) return false;
      continue;
    }
    const inv = 1 / d[a];
    let t1 = (mins[a] - o[a]) * inv;
    let t2 = (maxs[a] - o[a]) * inv;
    let s = -1; // entering through the min face -> normal points -axis
    if (t1 > t2) {
      const t = t1; t1 = t2; t2 = t;
      s = 1;
    }
    if (t1 > tMin) { tMin = t1; axis = a; sign = s; }
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return false;
  }
  out.t = tMin;
  out.axis = axis;
  out.sign = sign;
  return true;
}
