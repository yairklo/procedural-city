// Dev-only travel menu: press T to jump to any neighbourhood or tile.
//
// Loaded from index.html as its own module and talks to the game only through
// window.debug (world, player, playerCamera), so it stays out of main.js.
// Enabled on the dev server, or on a build with ?dev in the URL.
//
// Destinations snap to the nearest street point (from the tile files and the legacy
// centre), so you land on a road rather than inside a building.

const ENABLED = import.meta.env.DEV || new URLSearchParams(location.search).has('dev');
const DATA = `${import.meta.env.BASE_URL}data/`;

if (ENABLED) waitForGame().then(init).catch((err) => console.warn('[teleport] disabled:', err.message));

function waitForGame(timeoutMs = 60000) {
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const d = window.debug;
      if (d?.world?.projection && d.player && d.playerCamera) return resolve(d);
      if (performance.now() - t0 > timeoutMs) return reject(new Error('game did not start'));
      setTimeout(poll, 250);
    };
    poll();
  });
}

async function loadJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** Collects street points (game coords) plus the most common street name per tile. */
async function loadStreets(world) {
  const proj = world.projection;
  const points = []; // flat x, z
  const tiles = [];
  const addRoads = (roads) => {
    const names = new Map();
    for (const r of roads) {
      const p = r.points;
      for (let k = 0; k < p.length; k += 2) {
        const q = proj.project(p[k], p[k + 1]);
        points.push(q.x, q.z);
      }
      const n = r.nameEn || r.name;
      if (n) names.set(n, (names.get(n) ?? 0) + p.length);
    }
    return [...names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([n]) => n);
  };

  const manifest = world.manifest ?? (await loadJson(`${DATA}tiles/manifest.json`));
  await Promise.all(manifest.tiles.map(async (t) => {
    try {
      const doc = await loadJson(`${DATA}tiles/${t.file}`);
      const streets = addRoads(doc.roads);
      const b = doc.bbox;
      const c = proj.project((b.south + b.north) / 2, (b.west + b.east) / 2);
      tiles.push({ id: t.id, i: t.i, j: t.j, x: c.x, z: c.z, streets, buildings: t.stats.buildings });
    } catch (err) {
      console.warn('[teleport]', err.message);
    }
  }));
  try {
    addRoads((await loadJson(`${DATA}jerusalem_data.json`)).roads);
  } catch {
    // no legacy centre: tiles only
  }
  tiles.sort((a, b) => b.j - a.j || a.i - b.i); // north row first, west to east
  return { points, tiles };
}

function nearestStreet(points, x, z) {
  let best = -1, bestD = Infinity;
  for (let k = 0; k < points.length; k += 2) {
    const d = (points[k] - x) ** 2 + (points[k + 1] - z) ** 2;
    if (d < bestD) { bestD = d; best = k; }
  }
  return best < 0 ? { x, z } : { x: points[best], z: points[best + 1] };
}

async function init(debug) {
  const { world } = debug;
  const { points, tiles } = await loadStreets(world);

  const destinations = [{ label: 'Spawn (Jaffa Road)', group: 'Start', go: () => world.spawn }];

  // Old City landmarks: stand a little way off, facing the landmark.
  try {
    const lm = await loadJson(`${DATA}landmarks.json`);
    const proj = world.projection;
    const centroid = (ring) => {
      let x = 0, z = 0;
      for (let i = 0; i < ring.length; i += 2) { const p = proj.project(ring[i], ring[i + 1]); x += p.x; z += p.z; }
      return { x: (x * 2) / ring.length, z: (z * 2) / ring.length };
    };
    const wallPts = lm.walls.flatMap((w) => w.points);
    const oc = centroid(wallPts);
    const facing = (from, to) => ({ x: from.x, z: from.z, heading: Math.atan2(to.x - from.x, to.z - from.z) });
    const away = (p, dist) => {
      const dx = p.x - oc.x, dz = p.z - oc.z, l = Math.hypot(dx, dz) || 1;
      return facing({ x: p.x + (dx / l) * dist, z: p.z + (dz / l) * dist }, p);
    };
    const land = (label, spot) => destinations.push({ label, group: 'Old City landmarks', exact: true, ...spot });
    if (lm.plaza && lm.westernWall) land('Western Wall Plaza', facing(centroid(lm.plaza.ring), centroid(lm.westernWall.ring)));
    if (lm.templeMount) {
      const dome = proj.project(31.77805, 35.2354);
      land('Temple Mount esplanade', facing(proj.project(31.7773, 35.2356), dome));
    }
    if (lm.haram?.domeOfTheRock) {
      const c = centroid(lm.haram.domeOfTheRock.ring);
      land('Dome of the Rock', facing({ x: c.x, z: c.z + 60 }, c));
    }
    if (lm.haram?.aqsa) {
      const c = centroid(lm.haram.aqsa.ring);
      land('al-Aqsa', facing({ x: c.x - 10, z: c.z - 95 }, c));
    }
    if (lm.citadel) land('Tower of David', away(centroid(lm.citadel.outer[0]), 45));
    // Beyond the Old City: the Knesset, the Chords Bridge, the Mount of Olives, Mount Scopus.
    const pt = (p) => proj.project(p.lat, p.lon);
    if (lm.modern?.knesset) {
      const c = centroid(lm.modern.knesset.ring);
      const m = lm.modern.menorah ? pt(lm.modern.menorah) : { x: c.x + 60, z: c.z + 60 };
      const dx = m.x - c.x, dz = m.z - c.z, l = Math.hypot(dx, dz) || 1;
      land('Knesset', facing({ x: m.x + (dx / l) * 25, z: m.z + (dz / l) * 25 }, c));
    }
    if (lm.modern?.chordsBridge) {
      const d = lm.modern.chordsBridge.deck;
      land('Chords Bridge', facing(pt({ lat: d[0], lon: d[1] }), pt(lm.modern.chordsBridge.pylon)));
    }
    if (lm.olives?.sevenArches) land('Mount of Olives lookout', facing(pt({ lat: lm.olives.sevenArches.lat, lon: lm.olives.sevenArches.lon - 0.0004 }), proj.project(31.77805, 35.2354)));
    if (lm.scopus?.universityTower) land('Mount Scopus', away(pt(lm.scopus.universityTower), 40));
    if (lm.sepulchre) land('Holy Sepulchre', away(centroid(lm.sepulchre.ring), 40));
    for (const g of lm.gates) land(g.name, away(proj.project(g.lat, g.lon), 28));
  } catch (err) {
    console.warn('[teleport] no landmarks:', err.message);
  }
  const places = [...world.places].sort((a, b) => a.name.localeCompare(b.name));
  for (const p of places) {
    destinations.push({ label: p.nameLocal && p.nameLocal !== p.name ? `${p.name} · ${p.nameLocal}` : p.name, group: 'Neighbourhoods', x: p.x, z: p.z });
  }
  for (const t of tiles) {
    destinations.push({ label: `Tile ${t.id} · ${t.buildings} bldg${t.streets.length ? ` · ${t.streets.join(', ')}` : ''}`, group: 'Tiles (north row first)', x: t.x, z: t.z });
  }

  const teleport = (dest) => {
    const target = dest.go ? dest.go() : dest.exact ? { x: dest.x, z: dest.z, heading: dest.heading } : { ...nearestStreet(points, dest.x, dest.z) };
    if (!dest.go) {
      // Drop from just above the ground; the controller settles onto the road surface.
      const ground = world.terrain?.heightAt ? world.terrain.heightAt(target.x, target.z) : 0;
      target.y = ground + 1.5;
    }
    debug.player.reset(target);
    debug.playerCamera.snapTo(debug.player.snapshot());
    console.info(`[teleport] ${dest.label} -> x ${target.x.toFixed(0)}, z ${target.z.toFixed(0)}`);
  };

  const panel = buildPanel(destinations, (d) => {
    teleport(d);
    toggle(false);
  });

  let open = false;
  const toggle = (v = !open) => {
    open = v;
    panel.style.display = open ? 'block' : 'none';
    if (open && document.pointerLockElement) document.exitPointerLock();
  };
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyT' && !e.repeat) toggle();
    else if (e.code === 'Escape' && open) toggle(false);
  });
  window.teleport = (name) => {
    const d = destinations.find((x) => x.label.toLowerCase().includes(String(name).toLowerCase()));
    if (!d) return `no destination matching "${name}"`;
    teleport(d);
    return d.label;
  };
  console.info(`[teleport] ready: press T (${destinations.length} destinations), or teleport('Talbiye') in the console`);
}

function buildPanel(destinations, onPick) {
  const panel = document.createElement('div');
  panel.style.cssText = [
    'position:fixed', 'top:12px', 'right:12px', 'z-index:20', 'display:none',
    'width:min(340px,calc(100vw - 24px))', 'max-height:calc(100vh - 24px)', 'overflow:auto',
    'padding:10px', 'border-radius:8px', 'background:rgba(10,14,20,0.9)', 'color:#e6edf3',
    'font:12px/1.4 system-ui,sans-serif',
  ].join(';');
  const title = document.createElement('div');
  title.textContent = 'Travel (T / Esc to close)';
  title.style.cssText = 'font-weight:600;font-size:13px;margin-bottom:6px';
  panel.appendChild(title);

  let group = null;
  for (const d of destinations) {
    if (d.group !== group) {
      group = d.group;
      const h = document.createElement('div');
      h.textContent = group;
      h.style.cssText = 'margin:8px 0 3px;color:#9aa7b4;text-transform:uppercase;font-size:10px;letter-spacing:.06em';
      panel.appendChild(h);
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = d.label;
    b.style.cssText = 'display:block;width:100%;text-align:left;padding:5px 7px;margin:1px 0;border:0;border-radius:5px;background:transparent;color:inherit;font:inherit;cursor:pointer';
    b.onmouseenter = () => (b.style.background = 'rgba(255,255,255,0.1)');
    b.onmouseleave = () => (b.style.background = 'transparent');
    b.onclick = (e) => {
      e.stopPropagation();
      onPick(d);
    };
    panel.appendChild(b);
  }
  // Keep clicks in the panel from reaching the game (which would grab the pointer).
  for (const ev of ['mousedown', 'pointerdown', 'click', 'wheel']) panel.addEventListener(ev, (e) => e.stopPropagation());
  document.body.appendChild(panel);
  return panel;
}
