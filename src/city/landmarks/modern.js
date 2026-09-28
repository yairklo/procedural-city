// Modern Jerusalem landmarks, from landmarks.json `modern` (scripts/fetch_landmarks.js):
//
//   Knesset       the parliament building on its hill in Givat Ram, as built in 1966: a stone
//                 podium levelling the slope, a colonnade of tall square stone piers on all
//                 four sides carrying a deep flat roof slab, the stone core behind it with
//                 its vertical slit windows and glazed ground floor, the plenum hall's roof
//                 lantern, a broad entrance stair, flag poles with Israeli flags, and the
//                 bronze Knesset Menorah facing the building
//   Chords Bridge the light-rail bridge at the city entrance: a curved deck rising over the
//                 junction (tram lane with rails, glass-railed walkways, white steel box
//                 girder, slender piers), the leaning, tapering 118 m pylon, and a harp of
//                 66 cables fanning from its upper half to the deck edge along the span
//
// The outline of the Knesset is the mapped building; the bridge's deck line and the pylon
// (and the Menorah) are approximate unless the data says otherwise. Collision: podium, piers,
// core and stairs of the Knesset; the bridge deck is walkable, its pylon and piers solid.

import { Mesher, STYLE, resample, signedArea } from './geometry.js';
import { orientedBox } from '../footprint.js';
import { createKit } from './kit.js';

const C = {
  stone: 0xdcd3c1, // the Knesset's pale Jerusalem stone
  stoneDark: 0xc6bca8,
  paving: 0xd8d0c0,
  opening: 0x22262a,
  glass: 0x3b4a52,
  bronze: 0x5e5a3c,
  flagWhite: 0xf3f3f0,
  flagBlue: 0x1c4ea3,
  pole: 0xd8dadc,
  steel: 0xf2f3f1, // the bridge's white steel
  tram: 0x6f6a64,
  rail: 0x4a4c50,
  railing: 0xb9c6cb,
};

/**
 * @param {object} data  landmarks.json (uses `modern`)
 * @param {object} ctx   { project, at, ground, addBox, addFootprint, quadBox, finish }
 */
export function buildModern(data, ctx) {
  const stats = { knesset: false, menorah: false, bridge: false, cables: 0 };
  const mod = data.modern;
  if (!mod) return stats;
  if (mod.knesset) Object.assign(stats, buildKnesset(mod, ctx));
  if (mod.chordsBridge?.deck?.length >= 4) Object.assign(stats, buildChordsBridge(mod.chordsBridge, ctx));
  return stats;
}

// ------------------------------------------------------------------------------------------------
// Knesset
// ------------------------------------------------------------------------------------------------

function buildKnesset(mod, ctx) {
  const { project, at, ground, addBox, addFootprint, quadBox, finish } = ctx;
  const m = new Mesher();
  const kit = createKit(m, { addBox, quadBox });
  const ring = project(mod.knesset.ring);
  const box = orientedBox(ring);
  // Local frame: a along the long side, n across it.
  const ax = box.ax, az = box.az, nx = -az, nz = ax;
  const hl = box.hl, hw = box.hw;
  const P = (s, t) => [box.cx + ax * s + nx * t, box.cz + az * s + nz * t];
  const rect = (s0, s1, t0, t1) => [...P(s0, t0), ...P(s1, t0), ...P(s1, t1), ...P(s0, t1)];

  // Ground under the building and around it.
  let gMin = Infinity, gMax = -Infinity;
  for (let s = -hl - 6; s <= hl + 6; s += 6) {
    for (let t = -hw - 6; t <= hw + 6; t += 6) {
      const [x, z] = P(s, t);
      const g = ground(x, z);
      gMin = Math.min(gMin, g);
      gMax = Math.max(gMax, g);
    }
  }
  const floor = gMax + 0.9; // the podium top: level across the hill
  const H = 16.5; // colonnade height (floor to roof slab)
  const roofTop = floor + H + 2.3;

  // Front: the side facing the Menorah (the main approach).
  const menorah = mod.menorah ? at(mod.menorah) : null;
  const sides = [
    { dx: ax, dz: az, half: hl, len: hw * 2, s: 1 },
    { dx: -ax, dz: -az, half: hl, len: hw * 2, s: -1 },
    { dx: nx, dz: nz, half: hw, len: hl * 2, t: 1 },
    { dx: -nx, dz: -nz, half: hw, len: hl * 2, t: -1 },
  ];
  let front = sides[0];
  if (menorah) {
    let best = -Infinity;
    for (const sd of sides) {
      const d = (menorah.x - box.cx) * sd.dx + (menorah.z - box.cz) * sd.dz;
      if (d > best) { best = d; front = sd; }
    }
  }

  // --- podium ---------------------------------------------------------------------------------
  const pod = 5;
  const podRing = rect(-hl - pod, hl + pod, -hw - pod, hw + pod);
  m.paint(C.stoneDark, 0.55, 1.4, STYLE.ashlar);
  m.prism(podRing, gMin - 1, floor, { top: false });
  m.paint(C.paving, 1, 1.2, STYLE.paving);
  m.polygon([podRing], floor, 1);
  addFootprint([podRing], gMin - 1, floor, 'building', 'knesset');

  // --- core: stone walls with slit windows, glazed ground floor -------------------------------
  const ins = 5.5;
  const coreRing = rect(-hl + ins, hl - ins, -hw + ins, hw - ins);
  m.paint(C.stone, 0.6, 1.5, STYLE.ashlar);
  m.prism(coreRing, floor, floor + H, { top: false });
  addFootprint([coreRing], floor, floor + H, 'building', 'knesset');
  for (const sd of sides) {
    // Face of the core on this side.
    const fx = box.cx + sd.dx * (sd.half - ins), fz = box.cz + sd.dz * (sd.half - ins);
    const ux = -sd.dz, uz = sd.dx; // along the face
    const L = sd.len - 2 * ins;
    m.paint(C.glass, 1, 1, STYLE.plain);
    // Glazed ground floor band with mullions.
    m.quad([fx + ux * (-L / 2) + sd.dx * 0.03, floor + 0.2, fz + uz * (-L / 2) + sd.dz * 0.03], [fx + ux * (L / 2) + sd.dx * 0.03, floor + 0.2, fz + uz * (L / 2) + sd.dz * 0.03],
      [fx + ux * (L / 2) + sd.dx * 0.03, floor + 3.6, fz + uz * (L / 2) + sd.dz * 0.03], [fx + ux * (-L / 2) + sd.dx * 0.03, floor + 3.6, fz + uz * (-L / 2) + sd.dz * 0.03], [sd.dx, 0, sd.dz]);
    m.paint(C.stone, 0.6, 1.5, STYLE.ashlar);
    for (let s = -L / 2; s <= L / 2 + 0.01; s += 3) m.orientedBox(fx + ux * s + sd.dx * 0.12, fz + uz * s + sd.dz * 0.12, ux, uz, 0.08, 0.12, floor + 0.2, floor + 3.6);
    // Vertical slit windows above, in pairs.
    m.paint(C.opening, 1, 1, STYLE.plain);
    for (let s = -L / 2 + 3; s < L / 2 - 2; s += 4.2) {
      for (const o of [-0.6, 0.6]) {
        const cx = fx + ux * (s + o) + sd.dx * 0.03, cz = fz + uz * (s + o) + sd.dz * 0.03;
        m.quad([cx - ux * 0.22, floor + 5, cz - uz * 0.22], [cx + ux * 0.22, floor + 5, cz + uz * 0.22], [cx + ux * 0.22, floor + H - 2, cz + uz * 0.22], [cx - ux * 0.22, floor + H - 2, cz - uz * 0.22], [sd.dx, 0, sd.dz]);
      }
    }
  }

  // --- colonnade -------------------------------------------------------------------------------
  m.paint(C.stone, 0.6, 1.5, STYLE.ashlar);
  const pier = 1.35;
  let piers = 0;
  for (const sd of sides) {
    const ux = -sd.dz, uz = sd.dx;
    const L = sd.len;
    const n = Math.max(4, Math.round(L / 6.2));
    for (let k = 0; k <= n; k++) {
      if ((sd.s === -1 || sd.t === -1) && (k === 0 || k === n)) continue; // corners once
      const s = -L / 2 + (k * L) / n;
      const cx = box.cx + sd.dx * (sd.half - pier / 2) + ux * s, cz = box.cz + sd.dz * (sd.half - pier / 2) + uz * s;
      m.orientedBox(cx, cz, ux, uz, pier / 2, pier / 2, floor, floor + H);
      addBox({ minX: cx - pier * 0.7, maxX: cx + pier * 0.7, minZ: cz - pier * 0.7, maxZ: cz + pier * 0.7, minY: floor, maxY: floor + H }, 'building', 'knesset');
      piers++;
    }
  }

  // --- roof slab with its deep fascia, the plenum lantern ---------------------------------------
  const over = 1.4;
  const roofRing = rect(-hl - over, hl + over, -hw - over, hw + over);
  m.paint(C.stone, 0.45, 2.2, STYLE.ashlar);
  m.prism(roofRing, floor + H, roofTop, { top: true, bottom: true });
  addFootprint([roofRing], floor + H, roofTop, 'building', 'knesset');
  // The plenum hall rises through the roof: a stone drum-block with a low pleated roof.
  const lw = Math.min(hl, hw) * 0.42;
  const lantern = rect(-lw * 1.15, lw * 1.15, -lw, lw);
  m.paint(C.stone, 0.6, 1.5, STYLE.ashlar);
  m.prism(lantern, roofTop, roofTop + 3.2, { top: false });
  m.paint(C.stoneDark, 1, 1, STYLE.lead);
  m.pyramid(lantern, roofTop + 3.2, 2.4);
  addFootprint([lantern], roofTop, roofTop + 4.5, 'building', 'knesset');

  // --- entrance stair, forecourt, flags --------------------------------------------------------
  const fux = -front.dz, fuz = front.dx;
  const edge = front.half + pod;
  const [ex, ez] = [box.cx + front.dx * edge, box.cz + front.dz * edge];
  const gFront = ground(ex + front.dx * 12, ez + front.dz * 12);
  const drop = Math.max(0, floor - gFront);
  const steps = Math.ceil(drop / 0.3);
  const SW = 34;
  for (let k = 0; k < steps; k++) {
    const top = floor - (k + 1) * (drop / steps);
    const d0 = k * 0.42, d1 = d0 + 0.44;
    const q = (s, d) => [ex + fux * s + front.dx * d, ez + fuz * s + front.dz * d];
    const stepRing = [...q(-SW / 2, d0), ...q(SW / 2, d0), ...q(SW / 2, d1), ...q(-SW / 2, d1)];
    m.paint(k % 2 ? C.paving : C.stone, 0.3, 1.2, STYLE.paving);
    m.prism(stepRing, gFront - 1, top);
    addFootprint([stepRing], gFront - 1, top, 'stairs', 'knesset');
  }
  // Flag poles at the head of the stair: Israeli flags (white, two blue stripes, the Star of
  // David outline), hanging in a breeze along the facade.
  const flag = (x, z, y) => {
    m.paint(C.pole, 1, 1, STYLE.metal);
    m.cylinder(x, z, 0.07, 0.05, y, y + 12, 6);
    const fw = 2.6, fh = 1.9, top = y + 11.8;
    const F = (s, h, off = 0) => [x + fux * (0.1 + s) + front.dx * off, top - h, z + fuz * (0.1 + s) + front.dz * off];
    const N = [front.dx, 0, front.dz], B = [-front.dx, 0, -front.dz];
    for (const [nrm, off] of [[N, 0.01], [B, -0.01]]) {
      m.paint(C.flagWhite, 1, 1, STYLE.plain);
      m.quad(F(0, 0, off), F(fw, 0, off), F(fw, fh, off), F(0, fh, off), nrm);
      m.paint(C.flagBlue, 1, 1, STYLE.plain);
      const o2 = off * 2;
      for (const [h0, h1] of [[0.14, 0.34], [fh - 0.34, fh - 0.14]]) m.quad(F(0, h0, o2), F(fw, h0, o2), F(fw, h1, o2), F(0, h1, o2), nrm);
      // Star of David: two triangles as thin bars.
      const cx = fw / 2, cy = fh / 2, r = 0.36;
      for (const rot of [Math.PI / 2, -Math.PI / 2]) {
        const v = [0, 1, 2].map((i) => [cx + Math.cos(rot + (i * 2 * Math.PI) / 3) * r, cy - Math.sin(rot + (i * 2 * Math.PI) / 3) * r]);
        for (let i = 0; i < 3; i++) {
          const [s0, h0] = v[i], [s1, h1] = v[(i + 1) % 3];
          const nxs = -(h1 - h0), nys = s1 - s0, l = Math.hypot(nxs, nys) || 1, w = 0.035;
          m.quad(F(s0 - (nxs / l) * w, h0 - (nys / l) * w, o2), F(s1 - (nxs / l) * w, h1 - (nys / l) * w, o2), F(s1 + (nxs / l) * w, h1 + (nys / l) * w, o2), F(s0 + (nxs / l) * w, h0 + (nys / l) * w, o2), nrm);
        }
      }
    }
    addBox({ minX: x - 0.1, maxX: x + 0.1, minZ: z - 0.1, maxZ: z + 0.1, minY: y, maxY: y + 12 }, 'pole', 'knesset-flag');
  };
  for (const s of [-12, -6, 6, 12]) flag(box.cx + front.dx * (front.half + 2.5) + fux * s, box.cz + front.dz * (front.half + 2.5) + fuz * s, floor);

  // --- office wings: low stone blocks around courtyards, continuous window bands ---------------
  let wings = 0;
  for (const w of mod.knessetWings ?? []) {
    const outer = project(w.ring);
    const holes = (w.holes ?? []).map((h) => project(h));
    const gs = [];
    for (let i = 0; i < outer.length; i += 2) gs.push(ground(outer[i], outer[i + 1]));
    gs.sort((p, q) => p - q);
    const wMin = gs[0];
    // Built into the slope below the Knesset: about two storeys over its own (median) ground,
    // so its roof meets the hilltop and the downhill side shows three.
    const top = Math.min(floor - 1, gs[gs.length >> 1] + 8.5);
    m.paint(C.stoneDark, 0.6, 1.5, STYLE.ashlar);
    m.prism(outer, wMin - 1, top, { top: false });
    for (const h of holes) {
      const rev = [];
      for (let i = h.length - 2; i >= 0; i -= 2) rev.push(h[i], h[i + 1]);
      m.prism(rev, wMin - 1, top, { top: false }); // courtyard walls face inward
    }
    m.paint(C.stone, 0.45, 1.5, STYLE.ashlar);
    m.polygon([outer, ...holes], top, 1);
    addFootprint([outer, ...holes], wMin - 1, top, 'building', 'knesset-wing');
    // Window bands on the outer walls.
    const ccw = signedArea(outer) > 0;
    m.paint(C.glass, 1, 1, STYLE.plain);
    for (let i = 0; i < outer.length; i += 2) {
      const j = (i + 2) % outer.length;
      const ax = outer[i], az = outer[i + 1], bx = outer[j], bz = outer[j + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 3) continue;
      let nx2 = (bz - az) / len, nz2 = -(bx - ax) / len;
      if (!ccw) { nx2 = -nx2; nz2 = -nz2; }
      for (const [y0, y1] of [[top - 6.6, top - 5.0], [top - 3.4, top - 1.8]]) {
        if (y0 < ground((ax + bx) / 2, (az + bz) / 2) + 0.5) continue;
        m.quad([ax + nx2 * 0.03, y0, az + nz2 * 0.03], [bx + nx2 * 0.03, y0, bz + nz2 * 0.03], [bx + nx2 * 0.03, y1, bz + nz2 * 0.03], [ax + nx2 * 0.03, y1, az + nz2 * 0.03], [nx2, 0, nz2]);
      }
    }
    wings++;
  }

  finish(m, 'Knesset');
  const out = { knesset: true, knessetPiers: piers, knessetWings: wings };

  // --- the Knesset Menorah ---------------------------------------------------------------------
  if (menorah) {
    const mm = new Mesher();
    const mk = createKit(mm, { addBox, quadBox });
    const g = ground(menorah.x, menorah.z);
    // Facing the Knesset: its arms spread across the line of sight.
    let fx = box.cx - menorah.x, fz = box.cz - menorah.z;
    const fl = Math.hypot(fx, fz) || 1;
    fx /= fl; fz /= fl;
    const wx = -fz, wz = fx; // across (the plane of the arms)
    mm.paint(C.stoneDark, 0.4, 1.0, STYLE.ashlar);
    mm.orientedBox(menorah.x, menorah.z, wx, wz, 2.1, 1.1, g - 0.5, g + 1.3);
    const y0 = g + 1.3;
    const top = y0 + 4.3;
    mm.paint(C.bronze, 1, 1, STYLE.metal);
    mm.orientedBox(menorah.x, menorah.z, wx, wz, 0.9, 0.5, y0, y0 + 0.5); // foot
    mk.tube([menorah.x, y0 + 0.5, menorah.z], [menorah.x, top, menorah.z], 0.2, 0.17, 8);
    // Three pairs of arms: half-circles below a common top line, centred on the stem.
    for (const r of [0.62, 1.22, 1.82]) {
      const K = 12;
      for (let k = 0; k < K; k++) {
        const a0 = Math.PI + (k / K) * Math.PI, a1 = Math.PI + ((k + 1) / K) * Math.PI;
        const p = (a) => [menorah.x + wx * Math.cos(a) * r, top + Math.sin(a) * r, menorah.z + wz * Math.cos(a) * r];
        mk.tube(p(a0), p(a1), 0.13, 0.13, 6);
      }
    }
    // Cups on the seven branch tips.
    for (const s of [-1.82, -1.22, -0.62, 0, 0.62, 1.22, 1.82]) {
      const x = menorah.x + wx * s, z = menorah.z + wz * s;
      mm.cylinder(x, z, 0.12, 0.26, top, top + 0.35, 8);
    }
    addBox({ minX: menorah.x - 2.3, maxX: menorah.x + 2.3, minZ: menorah.z - 2.3, maxZ: menorah.z + 2.3, minY: g - 0.5, maxY: y0 }, 'building', 'knesset-menorah');
    addBox({ minX: menorah.x - 0.3, maxX: menorah.x + 0.3, minZ: menorah.z - 0.3, maxZ: menorah.z + 0.3, minY: y0, maxY: top }, 'building', 'knesset-menorah');
    finish(mm, 'KnessetMenorah');
    out.menorah = true;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Chords Bridge
// ------------------------------------------------------------------------------------------------

function buildChordsBridge(cb, ctx) {
  const { project, at, ground, addBox, addFootprint, quadBox, finish } = ctx;
  const m = new Mesher();
  const kit = createKit(m, { addBox, quadBox });
  const line = project(cb.deck);
  const pts = resample(line, 4); // { x, z, d }
  const L = pts[pts.length - 1].d;
  const W = 14, girderDepth = 2.2;

  // Deck level: at street level at both ends, rising over the junction so it clears the
  // roads below by 7 m along the middle of the span; near the ends it rides just above the
  // ground like a ramp.
  const g = pts.map((p) => ground(p.x, p.z));
  const base = (i) => g[0] + (g[g.length - 1] - g[0]) * (pts[i].d / L);
  const bump = (i) => Math.sin(Math.PI * (pts[i].d / L)) ** 0.7;
  const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const middle = (i) => sstep(0.12, 0.3, pts[i].d / L) * (1 - sstep(0.7, 0.88, pts[i].d / L));
  let H = 0;
  for (let i = 0; i < pts.length; i++) {
    if (bump(i) < 0.2) continue;
    H = Math.max(H, (g[i] + 7 * middle(i) - base(i)) / bump(i));
  }
  const y = pts.map((_, i) => Math.max(base(i) + H * bump(i), g[i] + 0.25));

  // Frames along the deck: tangent and the left normal (x east, z south).
  const frame = pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
    return { tx: dx / l, tz: dz / l, nx: -dz / l, nz: dx / l };
  });
  const off = (i, o, dy = 0) => [pts[i].x + frame[i].nx * o, y[i] + dy, pts[i].z + frame[i].nz * o];

  for (let i = 0; i + 1 < pts.length; i++) {
    const j = i + 1;
    const strip = (o0, o1, dy, color, style) => {
      m.paint(color, 1, 1.2, style);
      m.quad(off(i, o0, dy), off(i, o1, dy), off(j, o1, dy), off(j, o0, dy), [0, 1, 0]);
    };
    // Walkways (stone paving), the tram bed between low kerbs.
    strip(-W / 2, -3.6, 0.05, C.paving, STYLE.paving);
    strip(3.6, W / 2, 0.05, C.paving, STYLE.paving);
    strip(-3.6, 3.6, 0, C.tram, STYLE.paving);
    // Rails.
    m.paint(C.rail, 1, 1, STYLE.metal);
    for (const o of [-2.4, -0.97, 0.97, 2.4]) {
      const a = off(i, o, 0.02), b = off(j, o, 0.02);
      m.quad([a[0] - frame[i].nx * 0.04, a[1] + 0.14, a[2] - frame[i].nz * 0.04], [a[0] + frame[i].nx * 0.04, a[1] + 0.14, a[2] + frame[i].nz * 0.04],
        [b[0] + frame[j].nx * 0.04, b[1] + 0.14, b[2] + frame[j].nz * 0.04], [b[0] - frame[j].nx * 0.04, b[1] + 0.14, b[2] - frame[j].nz * 0.04], [0, 1, 0]);
    }
    // The white girder: slanted sides down to a narrower soffit.
    m.paint(C.steel, 1, 1, STYLE.metal);
    for (const side of [-1, 1]) {
      const n = [frame[i].nx * side * 0.8, -0.6, frame[i].nz * side * 0.8];
      m.quad(off(i, side * W / 2, 0.05), off(j, side * W / 2, 0.05), off(j, side * 3.2, -girderDepth), off(i, side * 3.2, -girderDepth), n);
    }
    m.quad(off(i, -3.2, -girderDepth), off(i, 3.2, -girderDepth), off(j, 3.2, -girderDepth), off(j, -3.2, -girderDepth), [0, -1, 0]);
    // Glass balustrades on both edges (a pale panel on a steel rail).
    for (const side of [-1, 1]) {
      const o = side * (W / 2 - 0.1);
      m.paint(C.railing, 1, 1, STYLE.plain);
      m.quad(off(i, o, 0.05), off(j, o, 0.05), off(j, o, 1.15), off(i, o, 1.15), [frame[i].nx * side, 0, frame[i].nz * side]);
      m.quad(off(j, o, 0.05), off(i, o, 0.05), off(i, o, 1.15), off(j, o, 1.15), [-frame[i].nx * side, 0, -frame[i].nz * side]);
      m.paint(C.steel, 1, 1, STYLE.metal);
      kit.tube(off(i, o, 1.18), off(j, o, 1.18), 0.05, 0.05, 4, { caps: false });
    }
    // Walkable deck: 1 m pieces (small steps on the ramps), each overlapping its neighbours a
    // little so the curve leaves no slivers between them.
    const SUB = 4;
    for (let k = 0; k < SUB; k++) {
      const t0 = k / SUB, t1 = (k + 1) / SUB;
      const lerp = (a, b, t) => a + (b - a) * t;
      const px = (t) => lerp(pts[i].x, pts[j].x, t), pz = (t) => lerp(pts[i].z, pts[j].z, t);
      const fnx = lerp(frame[i].nx, frame[j].nx, 0.5), fnz = lerp(frame[i].nz, frame[j].nz, 0.5);
      const tx = frame[i].tx, tz = frame[i].tz, ext = 0.3;
      const c0 = [px(t0) - tx * ext, pz(t0) - tz * ext], c1 = [px(t1) + tx * ext, pz(t1) + tz * ext];
      const quad = [c0[0] - fnx * W / 2, c0[1] - fnz * W / 2, c1[0] - fnx * W / 2, c1[1] - fnz * W / 2, c1[0] + fnx * W / 2, c1[1] + fnz * W / 2, c0[0] + fnx * W / 2, c0[1] + fnz * W / 2];
      const top = Math.min(lerp(y[i], y[j], t0), lerp(y[i], y[j], t1)) + 0.05;
      addFootprint([quad], top - girderDepth, top, 'bridge', 'chords-bridge');
    }
  }

  // Piers along the approaches (not under the main span, which the cables carry).
  const pylon = at(cb.pylon);
  let pylonI = 0, best = Infinity;
  pts.forEach((p, i) => { const d = Math.hypot(p.x - pylon.x, p.z - pylon.z); if (d < best) { best = d; pylonI = i; } });
  // The span runs from the pylon toward the far end of the deck.
  const spanDir = pylonI < pts.length / 2 ? 1 : -1;
  const spanEnd = Math.min(pts.length - 1, Math.max(0, pylonI + spanDir * Math.round(160 / 4)));
  const inSpan = (i) => (spanDir > 0 ? i > pylonI && i < spanEnd : i < pylonI && i > spanEnd);
  m.paint(C.steel, 1, 1, STYLE.metal);
  for (let i = 3; i < pts.length - 3; i += 8) {
    if (inSpan(i) || y[i] - g[i] < 3) continue;
    const p = pts[i];
    m.cylinder(p.x, p.z, 0.85, 1.1, g[i] - 1, y[i] - girderDepth + 0.1, 12);
    addBox({ minX: p.x - 1, maxX: p.x + 1, minZ: p.z - 1, maxZ: p.z + 1, minY: g[i] - 1, maxY: y[i] - girderDepth }, 'building', 'chords-bridge');
  }

  // Pylon: leaning back, away from the span, and tapering; a slight bow like a harp's neck.
  const sp = frame[pylonI];
  const back = [-sp.tx * spanDir, -sp.tz * spanDir];
  const lean = (24 * Math.PI) / 180;
  const LEN = 118;
  const g0 = ground(pylon.x, pylon.z) - 1;
  const axis = (t) => {
    const bow = Math.sin(Math.PI * t) * 3.5;
    const h = Math.cos(lean) * LEN * t, o = Math.sin(lean) * LEN * t + bow;
    return [pylon.x + back[0] * o, g0 + h, pylon.z + back[1] * o];
  };
  const SEG = 14;
  m.paint(C.steel, 1, 1, STYLE.metal);
  for (let k = 0; k < SEG; k++) {
    const t0 = k / SEG, t1 = (k + 1) / SEG;
    const r = (t) => 2.6 * (1 - t) + 0.7 * t;
    kit.tube(axis(t0), axis(t1), r(t0), r(t1), 8, { caps: k === 0 || k === SEG - 1 });
    const a = axis(t0), b = axis(t1), rr = r(t0);
    addBox({ minX: Math.min(a[0], b[0]) - rr, maxX: Math.max(a[0], b[0]) + rr, minZ: Math.min(a[2], b[2]) - rr, maxZ: Math.max(a[2], b[2]) + rr, minY: a[1], maxY: b[1] }, 'building', 'chords-pylon');
  }
  // Cables: 66, from the upper 55% of the pylon to the deck's edge on the pylon side, spread
  // over the span: the curved deck twists them into a harp-string surface.
  const pylonSide = Math.sign((pylon.x - pts[pylonI].x) * sp.nx + (pylon.z - pts[pylonI].z) * sp.nz) || 1;
  const n = 66;
  const span = Math.abs(spanEnd - pylonI);
  m.paint(C.steel, 1, 1, STYLE.metal);
  for (let k = 0; k < n; k++) {
    const f = k / (n - 1);
    const top = axis(0.42 + 0.56 * f);
    const di = pylonI + spanDir * Math.round(3 + f * (span - 4));
    const anchor = off(di, pylonSide * (W / 2 - 0.3), 0.1);
    kit.tube(top, anchor, 0.07, 0.07, 4, { caps: false });
  }
  finish(m, 'ChordsBridge');
  return { bridge: true, cables: n, bridgeLength: Math.round(L), bridgeClearance: Math.round(H) };
}
