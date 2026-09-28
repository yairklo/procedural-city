// OpenStreetMap editing API (api.openstreetmap.org/api/0.6/map) as a data source.
//
// The public Overpass servers are often overloaded (504 / 429). The main API returns every
// node, way and relation in a small bbox as XML, quickly and reliably. It is meant for light
// use: fine for a few dozen one-time requests over small boxes (at most 0.25 deg², 50k
// nodes each), not for bulk downloads. https://operations.osmfoundation.org/policies/api/
//
// parseOsmXml(xml)            -> { nodes: Map, ways: Map, relations: Map }
// toOverpassJson(osm, filter) -> Overpass-style JSON ({ elements } with `geometry` on ways and
//                                on relation way members), so convertOverpass() can read it
// fetchOsmMap(bbox)           -> parsed data for a bbox (rate-limited, with retries)
//
// Data © OpenStreetMap contributors, available under the Open Database License (ODbL 1.0).

const API = 'https://api.openstreetmap.org/api/0.6/map';
const USER_AGENT = 'procedural-city data fetch (one-time; github.com/yairklo/procedural-city)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? unescape(m[1]) : null;
};

/** Parses an OSM XML document (as returned by /api/0.6/map). */
export function parseOsmXml(xml) {
  const nodes = new Map(), ways = new Map(), relations = new Map();
  // Elements are either self-closing (<node .../>) or have children up to their closing tag.
  const re = /<(node|way|relation)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g;
  for (const m of xml.matchAll(re)) {
    const [, type, head, , body = ''] = m;
    const id = Number(attr(head, 'id'));
    if (attr(head, 'visible') === 'false') continue;
    const tags = {};
    for (const t of body.matchAll(/<tag\s+k="([^"]*)"\s+v="([^"]*)"\s*\/>/g)) tags[unescape(t[1])] = unescape(t[2]);
    if (type === 'node') {
      nodes.set(id, { id, lat: Number(attr(head, 'lat')), lon: Number(attr(head, 'lon')), tags });
    } else if (type === 'way') {
      const refs = [...body.matchAll(/<nd\s+ref="(\d+)"/g)].map((r) => Number(r[1]));
      ways.set(id, { id, refs, tags });
    } else {
      const members = [...body.matchAll(/<member\s+([^>]*?)\/>/g)].map((r) => ({
        type: attr(` ${r[1]}`, 'type'),
        ref: Number(attr(` ${r[1]}`, 'ref')),
        role: attr(` ${r[1]}`, 'role') ?? '',
      }));
      relations.set(id, { id, members, tags });
    }
  }
  return { nodes, ways, relations };
}

/** Merges several parsed documents (neighbouring bboxes); later ones win on duplicates. */
export function mergeOsm(docs) {
  const out = { nodes: new Map(), ways: new Map(), relations: new Map() };
  for (const d of docs) {
    for (const k of ['nodes', 'ways', 'relations']) for (const [id, v] of d[k]) out[k].set(id, v);
  }
  return out;
}

export function wayGeometry(osm, way) {
  const g = [];
  for (const ref of way.refs) {
    const n = osm.nodes.get(ref);
    if (n) g.push({ lat: n.lat, lon: n.lon });
  }
  return g;
}

/**
 * The same selection as buildQuery() in fetch_jerusalem.js, so tiles built from the API match
 * tiles built from Overpass.
 */
export function cityFeatureFilter(el) {
  const t = el.tags;
  if (el.type === 'node') return t.natural === 'tree' || /^(neighbourhood|quarter|suburb)$/.test(t.place ?? '');
  if (el.type === 'relation') return !!t.building && t.type === 'multipolygon';
  return !!t.building || !!t.highway || /^(park|garden|playground)$/.test(t.leisure ?? '') || /^(grass|recreation_ground|village_green)$/.test(t.landuse ?? '');
}

/** Converts parsed OSM data to Overpass `out body geom` style JSON. */
export function toOverpassJson(osm, filter = () => true) {
  const elements = [];
  for (const n of osm.nodes.values()) {
    if (!Object.keys(n.tags).length) continue;
    const el = { type: 'node', id: n.id, lat: n.lat, lon: n.lon, tags: n.tags };
    if (filter(el)) elements.push(el);
  }
  for (const w of osm.ways.values()) {
    const el = { type: 'way', id: w.id, tags: w.tags };
    if (!filter(el)) continue;
    el.geometry = wayGeometry(osm, w);
    if (el.geometry.length >= 2) elements.push(el);
  }
  for (const r of osm.relations.values()) {
    const el = { type: 'relation', id: r.id, tags: r.tags };
    if (!filter(el)) continue;
    el.members = r.members.map((m) => {
      const way = m.type === 'way' ? osm.ways.get(m.ref) : null;
      return { ...m, geometry: way ? wayGeometry(osm, way) : undefined };
    });
    elements.push(el);
  }
  return { version: 0.6, generator: 'osm_api.js (api.openstreetmap.org)', elements };
}

let lastRequest = 0;

/** Downloads and parses one bbox { south, west, north, east }. */
export async function fetchOsmMap(bbox, { attempts = 3, minInterval = 1500 } = {}) {
  const url = `${API}?bbox=${bbox.west},${bbox.south},${bbox.east},${bbox.north}`;
  let lastError;
  for (let i = 0; i < attempts; i++) {
    const wait = lastRequest + minInterval - Date.now();
    if (wait > 0) await sleep(wait); // be gentle with the shared API
    lastRequest = Date.now();
    try {
      const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return parseOsmXml(await res.text());
    } catch (err) {
      lastError = err;
      console.warn(`[osm-api] ${url} failed (${i + 1}/${attempts}): ${err.message}`);
      await sleep(3000 * (i + 1));
    }
  }
  throw lastError;
}
