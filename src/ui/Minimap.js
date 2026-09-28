// GPS-style minimap (bottom left): the loaded OSM streets and building footprints, drawn
// by the game itself into an offscreen 2D canvas (no map images), the Jaffa Road light rail,
// and the player as a heading arrow in the middle. North up.
//
// Geography: the map is aligned to a geographic bounding box (by default central Jerusalem,
// S 31.778 / W 35.210 / N 31.788 / E 35.225): `worldToUV` maps world (x, z) to that box's
// (u, v) = ((lon - W) / (E - W), (N - lat) / (N - S)), through the game's own projection,
// so a point's place on the map is its real latitude / longitude. The map keeps working
// outside the box (u, v simply leave 0..1).
//
// Cost: the streets and buildings are drawn once into a large offscreen "base" canvas around
// the player, a few cells per frame within a small time budget (no hitch when many cells
// load at once). A second base canvas is drawn in the background when the player nears the
// edge or new cells have loaded, then swapped in. Each frame only copies a window of the base
// canvas and draws the arrow: no per-frame allocations.

export const JERUSALEM_BBOX = Object.freeze({ south: 31.778, west: 35.21, north: 31.788, east: 35.225 });

const STYLE = {
  background: '#f3efe7',
  building: 'rgba(224, 220, 211, 0.9)', // #E0DCD3, warm translucent grey
  buildingEdge: 'rgba(160, 152, 140, 0.55)',
  road: '#2a2d34', // dark slate
  pedestrian: '#5b606b',
  tram: 'rgba(63, 167, 160, 0.85)',
  player: '#e8553a',
};

export class Minimap {
  /**
   * @param {object} p
   * @param {{ project(lat:number, lon:number): {x:number, z:number} }} p.projection
   * @param {HTMLElement} [p.parent]
   * @param {typeof JERUSALEM_BBOX} [p.bbox]
   * @param {number} [p.size]  CSS pixels (diameter)
   * @param {number} [p.metersAcross]  map width shown
   */
  constructor({ projection, parent = document.body, bbox = JERUSALEM_BBOX, size = 190, metersAcross = 340 }) {
    this.projection = projection;
    this.bbox = bbox;
    // Geographic frame: world coordinates of the box corners.
    const nw = projection.project(bbox.north, bbox.west), se = projection.project(bbox.south, bbox.east);
    this.geo = { x0: nw.x, z0: nw.z, w: se.x - nw.x, h: se.z - nw.z };

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.size = size;
    this.px = Math.round(size * dpr);
    this.scale = this.px / metersAcross; // device pixels per meter
    this.el = document.createElement('div');
    this.el.className = 'minimap';
    this.el.style.width = this.el.style.height = `${size}px`;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = this.px;
    this.el.appendChild(this.canvas);
    parent.appendChild(this.el);
    this.ctx = this.canvas.getContext('2d');
    this.font = `600 ${Math.round(this.px * 0.07)}px system-ui, sans-serif`;

    // Two base canvases: `front` is shown, `back` is being drawn.
    this.baseSize = 2048;
    const make = () => {
      const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(this.baseSize, this.baseSize) : Object.assign(document.createElement('canvas'), { width: this.baseSize, height: this.baseSize });
      return { canvas: c, ctx: c.getContext('2d'), cx: 0, cz: 0, ready: false };
    };
    this.front = make();
    this.back = make();
    this.job = null;
    this.version = -1;
    this.lastStart = -Infinity;
    this.visible = true;
    this._last = { x: NaN, z: NaN, yaw: NaN };
  }

  /** (u, v) of a world point in the geographic box (0..1 inside it). */
  worldToUV(x, z) {
    return { u: (x - this.geo.x0) / this.geo.w, v: (z - this.geo.z0) / this.geo.h };
  }

  toggle() {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? '' : 'none';
  }

  /**
   * @param {{x:number, z:number, yaw:number}} player  yaw 0 faces north (-z), + turns left
   * @param {{ cells: Iterable<object>, version: number }} world  TileWorld (cells with `data`)
   * @param {number[] | null} tram  the light-rail polyline [x, z, ...], if any
   */
  update(player, world, tram = null) {
    if (!this.visible) return;
    const now = performance.now();
    const half = (this.baseSize / this.scale) / 2;
    const f = this.front;
    const off = Math.max(Math.abs(player.x - f.cx), Math.abs(player.z - f.cz));
    const needCenter = !f.ready || off > half * 0.55;
    const needData = world.version !== this.version && now - this.lastStart > 1500;
    if (!this.job && (needCenter || needData)) this._startJob(player, world, tram, now);
    if (this.job) this._work(now + 2.5); // at most ~2.5 ms per frame
    this._draw(player);
  }

  _startJob(player, world, tram, now) {
    const b = this.back;
    // Snap the centre to 64 m so small moves don't trigger redraws.
    b.cx = Math.round(player.x / 64) * 64;
    b.cz = Math.round(player.z / 64) * 64;
    b.ready = false;
    b.ctx.setTransform(1, 0, 0, 1, 0, 0);
    b.ctx.fillStyle = STYLE.background;
    b.ctx.fillRect(0, 0, this.baseSize, this.baseSize);
    const half = (this.baseSize / this.scale) / 2;
    const cells = [];
    for (const cell of world.cells.values ? world.cells.values() : world.cells) {
      const d = cell.data;
      if (!d?.bounds) continue;
      const bb = d.bounds;
      if (bb.maxX < b.cx - half || bb.minX > b.cx + half || bb.maxZ < b.cz - half || bb.minZ > b.cz + half) continue;
      cells.push(d);
    }
    // Buildings of every cell first, then the streets on top, then the tram line.
    this.job = { steps: [...cells.map((d) => ['buildings', d]), ...cells.map((d) => ['roads', d]), ...(tram ? [['tram', tram]] : [])], i: 0 };
    this.version = world.version;
    this.lastStart = now;
  }

  _work(deadline) {
    const b = this.back, ctx = b.ctx, s = this.scale, o = this.baseSize / 2;
    // World -> base pixels.
    ctx.setTransform(s, 0, 0, s, o - b.cx * s, o - b.cz * s);
    while (this.job.i < this.job.steps.length && performance.now() < deadline) {
      const [kind, d] = this.job.steps[this.job.i++];
      if (kind === 'buildings') this._buildings(ctx, d);
      else if (kind === 'roads') this._roads(ctx, d);
      else this._line(ctx, d, STYLE.tram, 2.2 / s * 2, [6 / s * 2, 4 / s * 2]);
    }
    if (this.job.i >= this.job.steps.length) {
      b.ready = true;
      [this.front, this.back] = [this.back, this.front];
      this.job = null;
    }
  }

  _buildings(ctx, d) {
    ctx.beginPath();
    if (d.outlines) {
      const p = d.outlines, st = d.outlineStarts;
      for (let k = 0; k + 1 < st.length; k++) {
        if (st[k + 1] - st[k] < 6) continue;
        ctx.moveTo(p[st[k]], p[st[k] + 1]);
        for (let i = st[k] + 2; i < st[k + 1]; i += 2) ctx.lineTo(p[i], p[i + 1]);
        ctx.closePath();
      }
    } else {
      for (const bld of d.buildings ?? []) {
        const r = bld.rings?.[0];
        if (!r || r.length < 6) continue;
        ctx.moveTo(r[0], r[1]);
        for (let i = 2; i < r.length; i += 2) ctx.lineTo(r[i], r[i + 1]);
        ctx.closePath();
      }
    }
    ctx.fillStyle = STYLE.building;
    ctx.fill();
    ctx.lineWidth = 0.8 / this.scale;
    ctx.strokeStyle = STYLE.buildingEdge;
    ctx.stroke();
  }

  _roads(ctx, d) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const r of d.roads ?? []) {
      const ped = r.surface === 'paving';
      if (r.rings) {
        ctx.beginPath();
        for (const ring of r.rings) {
          ctx.moveTo(ring[0], ring[1]);
          for (let i = 2; i < ring.length; i += 2) ctx.lineTo(ring[i], ring[i + 1]);
          ctx.closePath();
        }
        ctx.fillStyle = STYLE.pedestrian;
        ctx.fill('evenodd');
      } else if (r.points) {
        this._line(ctx, r.points, ped ? STYLE.pedestrian : STYLE.road, Math.max(r.width ?? 4, 2.5 / this.scale));
      }
    }
  }

  _line(ctx, p, style, width, dash = null) {
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    if (dash) ctx.setLineDash(dash);
    ctx.stroke();
    if (dash) ctx.setLineDash([]);
  }

  _draw(player) {
    const l = this._last;
    const moved = Math.abs(player.x - l.x) * this.scale > 0.25 || Math.abs(player.z - l.z) * this.scale > 0.25 || Math.abs(player.yaw - l.yaw) > 0.005;
    if (!moved && !this._swapped()) return;
    l.x = player.x; l.z = player.z; l.yaw = player.yaw;
    const ctx = this.ctx, px = this.px, f = this.front;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = STYLE.background;
    ctx.fillRect(0, 0, px, px);
    if (f.ready) {
      // The window of the base canvas around the player (1 base pixel = 1 map pixel).
      const o = this.baseSize / 2;
      const sx = o + (player.x - f.cx) * this.scale - px / 2, sy = o + (player.z - f.cz) * this.scale - px / 2;
      ctx.drawImage(f.canvas, sx, sy, px, px, 0, 0, px, px);
    }
    // Player: an arrow pointing along the heading (yaw 0 = north = up on the map).
    const c = px / 2, r = px * 0.055;
    ctx.translate(c, c);
    ctx.rotate(-player.yaw);
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.5);
    ctx.lineTo(r, r);
    ctx.lineTo(0, r * 0.45);
    ctx.lineTo(-r, r);
    ctx.closePath();
    ctx.fillStyle = STYLE.player;
    ctx.fill();
    ctx.lineWidth = Math.max(1, px / 160);
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // North marker.
    ctx.fillStyle = 'rgba(42, 45, 52, 0.85)';
    ctx.font = this.font;
    ctx.textAlign = 'center';
    ctx.fillText('N', c, px * 0.1);
  }

  _swapped() {
    const f = this.front;
    if (f === this._shown) return false;
    this._shown = f;
    return true;
  }

  dispose() {
    this.el.remove();
  }
}
