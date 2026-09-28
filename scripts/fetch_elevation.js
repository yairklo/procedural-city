#!/usr/bin/env node
// One-time data ingestion: samples terrain elevation over the Jerusalem bbox on a regular
// grid and writes a compact heightmap the game loads at runtime (no network needed).
//
//   node scripts/fetch_elevation.js              # 64 x 64 grid (default)
//   node scripts/fetch_elevation.js --size 128   # 128 x 128 grid
//   node scripts/fetch_elevation.js --out path.json
//   node scripts/fetch_elevation.js --source open-elevation   # skip Open-Meteo
//   node scripts/fetch_elevation.js --smooth 2.5              # Gaussian sigma in grid cells (0 = off)
//   node scripts/fetch_elevation.js --mode points             # DEM control points (see below)
//   node scripts/fetch_elevation.js --mode points --source terrarium   # SRTM 1" (~30 m) from AWS Terrain Tiles
//   node scripts/fetch_elevation.js --bbox 31.765,35.205,31.79,35.253   # south,west,north,east
//
// Sources, tried in order:
//   1. Open-Meteo Elevation API: Copernicus DEM GLO-90 (3 arc-sec, ~90 m), CC BY 4.0
//   2. Open-Elevation public API: measured 7.5 arc-sec pixels (~230 m), nearest-neighbour
//
// --mode points (writes public/data/tiles/dem_points.json over the tiled world's WORLD_BBOX)
//   The grid mode below oversamples a coarse DEM, so its raw values are flat plateaus with
//   steps at pixel borders. Points mode instead returns ONE sample per real DEM pixel, taken
//   at the pixel centre: exact measured heights with no plateaus, meant as control points for
//   a smooth (Catmull-Rom / cubic) interpolation. The pixel lattice (size and phase) is
//   measured from the source with dense transects rather than assumed, and the samples are
//   then verified by re-querying points around each centre. Control points extend
//   POINTS_MARGIN pixels beyond the bbox so a cubic patch is defined everywhere inside it.
// The source DEMs are coarser than the grid spacing (~17 m at 64 x 64), so the APIs return
// the same pixel for several neighbouring samples: raw terrain looks like 10-25 m steps.
// `values` is therefore Gaussian-smoothed (default sigma 2.5 cells, ~40 m); the unsmoothed
// samples are kept in `rawValues`.
//
// Output grid layout: values[row * width + col], row 0 = north edge, col 0 = west edge.
// Samples sit on cell corners, edges inclusive:
//   lat = north - row * (north - south) / (height - 1)
//   lon = west  + col * (east  - west)  / (width  - 1)

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WORLD_BBOX } from './fetch_tiles.js';

export const JERUSALEM_BBOX = Object.freeze({ south: 31.778, west: 35.21, north: 31.788, east: 35.225 });

const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../public/data');
const OUT_FILE = resolve(DATA_DIR, 'jerusalem_elevation.json');
const POINTS_FILE = resolve(DATA_DIR, 'tiles/dem_points.json'); // the terrain the game reads
const POINTS_MARGIN = 2; // extra pixels on each side of the bbox (cubic interpolation needs 1)
const ARCSEC = 1 / 3600;
// Pixel sizes of the DEMs these APIs are known to serve, largest first.
const LATTICE_CANDIDATES = [30, 15, 7.5, 3].map((s) => s * ARCSEC);
const OPEN_METEO = 'https://api.open-meteo.com/v1/elevation';
const OPEN_ELEVATION = 'https://api.open-elevation.com/api/v1/lookup';
const OPEN_METEO_BATCH = 100; // API limit: 100 coordinates per request
const OPEN_ELEVATION_BATCH = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

/** Grid sample points in output order (row-major, north to south, west to east). */
export function gridPoints(bbox, width, height) {
  const pts = [];
  for (let row = 0; row < height; row++) {
    const lat = bbox.north - (row * (bbox.north - bbox.south)) / (height - 1);
    for (let col = 0; col < width; col++) {
      const lon = bbox.west + (col * (bbox.east - bbox.west)) / (width - 1);
      pts.push({ lat: round(lat, 6), lon: round(lon, 6) });
    }
  }
  return pts;
}

async function withRetry(label, fn, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      // Hourly / daily quotas won't clear by waiting a minute: give up on this source now.
      if (/Hourly|Daily/i.test(err.message)) throw err;
      console.warn(`[elevation] ${label} failed (${i + 1}/${attempts}): ${err.message}`);
      // 429 = per-minute quota (Open-Meteo counts every coordinate): wait out the window.
      await sleep(/HTTP 429/.test(err.message) ? 61000 : 1500 * 2 ** i);
    }
  }
  throw lastError;
}

async function fetchOpenMeteo(points) {
  const out = [];
  for (let i = 0; i < points.length; i += OPEN_METEO_BATCH) {
    const batch = points.slice(i, i + OPEN_METEO_BATCH);
    const url = `${OPEN_METEO}?latitude=${batch.map((p) => p.lat).join(',')}&longitude=${batch.map((p) => p.lon).join(',')}`;
    const json = await withRetry(`open-meteo batch ${i / OPEN_METEO_BATCH + 1}`, async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return res.json();
    });
    if (!Array.isArray(json.elevation) || json.elevation.length !== batch.length) {
      throw new Error(`open-meteo returned ${json.elevation?.length} values for ${batch.length} points`);
    }
    out.push(...json.elevation);
    process.stdout.write(`\r[elevation] open-meteo ${out.length}/${points.length}`);
    await sleep(250); // stay well under the free-tier rate limit
  }
  process.stdout.write('\n');
  return { values: out, source: 'Open-Meteo Elevation API (Copernicus DEM GLO-90)', license: 'CC BY 4.0', attribution: 'Elevation data: Copernicus DEM GLO-90 © DLR e.V. / ESA, via Open-Meteo.com (CC BY 4.0)' };
}

async function fetchOpenElevation(points) {
  const out = [];
  for (let i = 0; i < points.length; i += OPEN_ELEVATION_BATCH) {
    const batch = points.slice(i, i + OPEN_ELEVATION_BATCH);
    const json = await withRetry(`open-elevation batch ${i / OPEN_ELEVATION_BATCH + 1}`, async () => {
      const res = await fetch(OPEN_ELEVATION, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ locations: batch.map((p) => ({ latitude: p.lat, longitude: p.lon })) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return res.json();
    });
    if (!Array.isArray(json.results) || json.results.length !== batch.length) {
      throw new Error(`open-elevation returned ${json.results?.length} values for ${batch.length} points`);
    }
    out.push(...json.results.map((r) => r.elevation));
    process.stdout.write(`\r[elevation] open-elevation ${out.length}/${points.length}`);
    await sleep(500);
  }
  process.stdout.write('\n');
  return { values: out, source: 'Open-Elevation (SRTM)', license: 'Public domain (SRTM)', attribution: 'Elevation data: NASA SRTM via Open-Elevation' };
}

const FETCHERS = { 'open-meteo': fetchOpenMeteo, 'open-elevation': fetchOpenElevation };

/**
 * DEM control points from the AWS Terrain Tiles (terrarium; SRTM at 1 arc-second, ~30 x 26 m
 * here): one sample per SRTM pixel centre (integer arc-seconds) over the bbox plus a margin,
 * the same dem-points-v1 layout as fetchDemPoints. Three times finer than Copernicus GLO-90:
 * it resolves the Tyropoeon valley south of the Western Wall plaza, the Ophel and the Kidron.
 */
export async function fetchTerrariumPoints(bbox, { zoom = 14, fetchedAt = new Date().toISOString() } = {}) {
  const { sampler } = await import('./terrarium.js');
  const at = sampler(zoom);
  const step = ARCSEC;
  const kLat0 = Math.floor(bbox.south / step) - POINTS_MARGIN, kLat1 = Math.ceil(bbox.north / step) + POINTS_MARGIN;
  const kLon0 = Math.floor(bbox.west / step) - POINTS_MARGIN, kLon1 = Math.ceil(bbox.east / step) + POINTS_MARGIN;
  const width = kLon1 - kLon0 + 1, height = kLat1 - kLat0 + 1;
  const north = kLat1 * step, west = kLon0 * step;
  const values = new Array(width * height);
  for (let row = 0; row < height; row++) {
    const lat = north - row * step;
    const line = await Promise.all(Array.from({ length: width }, (_, col) => at(lat, west + col * step)));
    for (let col = 0; col < width; col++) values[row * width + col] = line[col];
    if (row % 10 === 0) process.stdout.write(`\r[elevation] terrarium rows ${row + 1}/${height}`);
  }
  process.stdout.write('\n');
  const min = Math.min(...values), max = Math.max(...values);
  if (min < 300 || max > 1200) throw new Error(`implausible elevation range ${min}..${max} m`);
  const midLat = ((bbox.north + bbox.south) / 2) * (Math.PI / 180);
  return {
    format: 'dem-points-v1',
    source: 'AWS Terrain Tiles (terrarium, SRTM 1 arc-second)',
    license: 'Public domain (SRTM); tiles by Mapzen / AWS Open Data',
    attribution: 'Elevation data: SRTM courtesy of NASA / USGS, via Mapzen / AWS Terrain Tiles',
    fetchedAt,
    bbox: { ...bbox },
    lattice: {
      north: round(north, 8), west: round(west, 8), stepLatDeg: step, stepLonDeg: step,
      stepMeters: { lat: round(step * 111320, 1), lon: round(step * 111320 * Math.cos(midLat), 1) },
      measured: false,
    },
    width,
    height,
    margin: POINTS_MARGIN,
    layout: 'row-major; row 0 = north; lat = lattice.north - row * stepLatDeg, lon = lattice.west + col * stepLonDeg',
    meaning: 'SRTM samples at 1 arc-second pixel centres (bilinear from terrarium tiles); use as control points for Catmull-Rom / cubic interpolation',
    units: 'meters above sea level',
    minElevation: round(min, 1),
    maxElevation: round(max, 1),
    verification: { method: 'none (fixed SRTM lattice)', checked: 0, matched: 0 },
    values: values.map((v) => round(v, 1)),
  };
}

const mod = (v, m) => ((v % m) + m) % m;

/** Mean of positions on a circle of the given period (so 0.1 and period - 0.1 average to 0). */
function circularMean(values, period) {
  let sx = 0, sy = 0;
  for (const v of values) {
    const a = (2 * Math.PI * v) / period;
    sx += Math.cos(a);
    sy += Math.sin(a);
  }
  return mod((Math.atan2(sy, sx) / (2 * Math.PI)) * period, period);
}

/**
 * Measures the DEM pixel lattice along one axis: pixel size and where pixel centres sit.
 * Samples two dense transects and looks at where the returned value changes.
 * @returns {{ step: number, center: number, boundaries: number, continuous: boolean }}
 */
export async function detectAxisLattice(fetcher, bbox, axis) {
  const span = 30 * ARCSEC, n = 120, d = span / n;
  const midLat = (bbox.south + bbox.north) / 2, midLon = (bbox.west + bbox.east) / 2;
  const perps = axis === 'lat'
    ? [bbox.west + (bbox.east - bbox.west) * 0.3, bbox.west + (bbox.east - bbox.west) * 0.7]
    : [bbox.south + (bbox.north - bbox.south) * 0.3, bbox.south + (bbox.north - bbox.south) * 0.7];
  const pts = [];
  for (const perp of perps) {
    for (let i = 0; i < n; i++) {
      const along = (axis === 'lat' ? midLat : midLon) - span / 2 + i * d;
      pts.push(axis === 'lat' ? { lat: round(along, 7), lon: round(perp, 7) } : { lat: round(perp, 7), lon: round(along, 7) });
    }
  }
  const { values } = await fetcher(pts);
  const coord = (p) => (axis === 'lat' ? p.lat : p.lon);

  const boundaries = [];
  const diffs = [];
  for (let t = 0; t < perps.length; t++) {
    let prev = null;
    for (let i = t * n + 1; i < (t + 1) * n; i++) {
      if (values[i] === values[i - 1]) continue;
      const b = (coord(pts[i]) + coord(pts[i - 1])) / 2;
      boundaries.push(b);
      if (prev != null) diffs.push(b - prev);
      prev = b;
    }
  }

  // A source that interpolates changes value at almost every sample: there is no lattice to align to.
  if (boundaries.length > pts.length * 0.5) return { step: 3 * ARCSEC, center: 0, boundaries: boundaries.length, continuous: true };
  if (diffs.length < 2) throw new Error(`could not measure the ${axis} pixel lattice (terrain too flat along the transects)`);

  const tol = 2 * d;
  for (const step of LATTICE_CANDIDATES) {
    const multiples = diffs.every((x) => {
      const k = Math.round(x / step);
      return k >= 1 && Math.abs(x - k * step) <= tol;
    });
    if (!multiples) continue;
    const phase = circularMean(boundaries.map((b) => mod(b, step)), step);
    const aligned = boundaries.every((b) => Math.abs(mod(b - phase + step / 2, step) - step / 2) <= tol);
    if (!aligned) continue;
    return { step, center: mod(phase + step / 2, step), boundaries: boundaries.length, continuous: false };
  }
  throw new Error(`${axis} pixel borders don't match a known DEM lattice: ${diffs.map((x) => (x / ARCSEC).toFixed(2)).join(', ')} arc-sec`);
}

/** Samples one point per DEM pixel (at its centre) over the bbox plus a margin, and verifies them. */
export async function fetchDemPoints(fetcher, bbox, fetchedAt = new Date().toISOString()) {
  const lat = await detectAxisLattice(fetcher, bbox, 'lat');
  const lon = await detectAxisLattice(fetcher, bbox, 'lon');
  console.log(`[elevation] lattice: ${(lat.step / ARCSEC).toFixed(2)}" x ${(lon.step / ARCSEC).toFixed(2)}"` +
    `${lat.continuous || lon.continuous ? ' (source interpolates; using its nominal 3" grid)' : ''}`);

  // Lattice positions are center + k * step.
  const kLat0 = Math.floor((bbox.south - lat.center) / lat.step) - POINTS_MARGIN;
  const kLat1 = Math.ceil((bbox.north - lat.center) / lat.step) + POINTS_MARGIN;
  const kLon0 = Math.floor((bbox.west - lon.center) / lon.step) - POINTS_MARGIN;
  const kLon1 = Math.ceil((bbox.east - lon.center) / lon.step) + POINTS_MARGIN;
  const width = kLon1 - kLon0 + 1, height = kLat1 - kLat0 + 1;
  const north = lat.center + kLat1 * lat.step, west = lon.center + kLon0 * lon.step;

  const pts = [];
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) pts.push({ lat: round(north - row * lat.step, 7), lon: round(west + col * lon.step, 7) });
  }
  const res = await fetcher(pts);
  const values = res.values;
  if (!values.every((v) => typeof v === 'number' && Number.isFinite(v))) throw new Error('non-numeric elevation value');

  // Verification: nudging a query 30% of a pixel off-centre must still return the same pixel.
  let verification = { method: 'skipped: source interpolates', checked: 0, matched: 0 };
  if (!lat.continuous && !lon.continuous) {
    const probes = [];
    const expected = [];
    const rowStep = Math.max(1, Math.floor(height / 6)), colStep = Math.max(1, Math.floor(width / 6));
    for (let row = 1; row < height - 1; row += rowStep) {
      for (let col = 1; col < width - 1; col += colStep) {
        const p = pts[row * width + col];
        for (const [dLat, dLon] of [[0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]]) {
          probes.push({ lat: round(p.lat + dLat * lat.step, 7), lon: round(p.lon + dLon * lon.step, 7) });
          expected.push(values[row * width + col]);
        }
      }
    }
    const got = (await fetcher(probes)).values;
    const matched = got.filter((v, i) => Math.abs(v - expected[i]) < 0.5).length;
    verification = { method: 'requery at +-0.3 pixel from each centre', checked: probes.length, matched };
    if (matched < probes.length * 0.9) throw new Error(`control points failed verification: ${matched}/${probes.length} probes matched their pixel`);
  }

  const min = Math.min(...values), max = Math.max(...values);
  if (min < 300 || max > 1200) throw new Error(`implausible elevation range ${min}..${max} m`);
  const midLat = ((bbox.north + bbox.south) / 2) * (Math.PI / 180);
  return {
    format: 'dem-points-v1',
    source: res.source,
    license: res.license,
    attribution: res.attribution,
    fetchedAt,
    bbox: { ...bbox },
    lattice: {
      north: round(north, 8),
      west: round(west, 8),
      stepLatDeg: lat.step,
      stepLonDeg: lon.step,
      stepMeters: { lat: round(lat.step * 111320, 1), lon: round(lon.step * 111320 * Math.cos(midLat), 1) },
      measured: !(lat.continuous || lon.continuous),
    },
    width,
    height,
    margin: POINTS_MARGIN,
    layout: 'row-major; row 0 = north; lat = lattice.north - row * stepLatDeg, lon = lattice.west + col * stepLonDeg',
    meaning: 'exact DEM samples at pixel centres (no smoothing); use as control points for Catmull-Rom / cubic interpolation',
    units: 'meters above sea level',
    minElevation: round(min, 1),
    maxElevation: round(max, 1),
    verification,
    values: values.map((v) => round(v, 1)),
  };
}

/** Separable Gaussian blur of a row-major grid, clamped at the edges. */
export function smoothGrid(values, width, height, sigma) {
  if (!(sigma > 0)) return values.slice();
  const r = Math.ceil(sigma * 3);
  const kernel = [];
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const k = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(k);
    sum += k;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  const clamp = (v, max) => (v < 0 ? 0 : v > max ? max : v);
  const tmp = new Array(values.length);
  const out = new Array(values.length);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += kernel[i + r] * values[row * width + clamp(col + i, width - 1)];
      tmp[row * width + col] = acc;
    }
  }
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += kernel[i + r] * tmp[clamp(row + i, height - 1) * width + col];
      out[row * width + col] = acc;
    }
  }
  return out;
}

/** Builds the output document; throws if the data looks wrong. */
export function buildHeightmap(bbox, width, height, rawValues, meta, { fetchedAt = new Date().toISOString(), smooth = 2.5 } = {}) {
  const values = smoothGrid(rawValues, width, height, smooth);
  if (values.length !== width * height) throw new Error(`expected ${width * height} values, got ${values.length}`);
  if (!values.every((v) => typeof v === 'number' && Number.isFinite(v))) throw new Error('non-numeric elevation value');
  const min = Math.min(...values), max = Math.max(...values);
  // Jerusalem's centre sits roughly 700-850 m above sea level; anything far outside means a bad response.
  if (min < 300 || max > 1200) throw new Error(`implausible elevation range ${min}..${max} m`);

  // Approximate ground size of the bbox, for consumers that want meters without re-projecting.
  const midLat = ((bbox.north + bbox.south) / 2) * (Math.PI / 180);
  const metersPerDegLat = 111320;
  const sizeX = (bbox.east - bbox.west) * metersPerDegLat * Math.cos(midLat);
  const sizeZ = (bbox.north - bbox.south) * metersPerDegLat;

  return {
    format: 'heightmap-v1',
    source: meta.source,
    license: meta.license,
    attribution: meta.attribution,
    fetchedAt,
    bbox: { ...bbox },
    width,
    height,
    layout: 'row-major; row 0 = north, col 0 = west; samples on cell corners, edges inclusive',
    units: 'meters above sea level',
    smoothing: smooth > 0 ? `gaussian, sigma ${smooth} cells` : 'none',
    approxSizeMeters: { x: round(sizeX, 1), z: round(sizeZ, 1) },
    minElevation: round(min, 1),
    maxElevation: round(max, 1),
    values: values.map((v) => round(v, 1)),
    rawValues: rawValues.map((v) => round(v, 1)),
  };
}

async function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  const size = Number(arg('--size') ?? 64);
  if (!Number.isInteger(size) || size < 2 || size > 256) throw new Error('--size must be an integer between 2 and 256');
  const mode = arg('--mode') ?? 'grid';
  if (!['grid', 'points'].includes(mode)) throw new Error('--mode must be grid or points');
  const out = arg('--out') ?? (mode === 'points' ? POINTS_FILE : OUT_FILE);
  const source = arg('--source') ?? 'auto';
  if (!['auto', 'open-meteo', 'open-elevation', 'terrarium'].includes(source)) throw new Error('--source must be auto, open-meteo, open-elevation or terrarium');
  const smooth = Number(arg('--smooth') ?? 2.5);
  let bbox = mode === 'points' ? WORLD_BBOX : JERUSALEM_BBOX;
  if (arg('--bbox')) {
    const [south, west, north, east] = arg('--bbox').split(',').map(Number);
    if (![south, west, north, east].every(Number.isFinite) || !(north > south && east > west)) throw new Error('--bbox must be south,west,north,east');
    bbox = { south, west, north, east };
  }
  if (!(smooth >= 0)) throw new Error('--smooth must be >= 0');

  if (mode === 'points' && source === 'terrarium') {
    const doc = await fetchTerrariumPoints(bbox);
    await mkdir(dirname(out), { recursive: true });
    const json = JSON.stringify(doc);
    await writeFile(out, json);
    console.log(`[elevation] wrote ${out} (${(json.length / 1024).toFixed(0)} KB): ${doc.width} x ${doc.height} SRTM points, ${doc.minElevation}..${doc.maxElevation} m`);
    return;
  }
  if (mode === 'points') {
    const order = source === 'auto' ? ['open-meteo', 'open-elevation'] : [source];
    let doc, lastError;
    for (const name of order) {
      try {
        console.log(`[elevation] points mode via ${name}`);
        doc = await fetchDemPoints(FETCHERS[name], bbox);
        break;
      } catch (err) {
        lastError = err;
        console.warn(`[elevation] ${name} failed: ${err.message}`);
      }
    }
    if (!doc) throw lastError;
    await mkdir(dirname(out), { recursive: true });
    const json = JSON.stringify(doc);
    await writeFile(out, json);
    console.log(`[elevation] wrote ${out} (${(json.length / 1024).toFixed(1)} KB): ${doc.width} x ${doc.height} control points, ` +
      `${doc.lattice.stepMeters.lat} x ${doc.lattice.stepMeters.lon} m pixels, ${doc.minElevation}..${doc.maxElevation} m, ` +
      `verified ${doc.verification.matched}/${doc.verification.checked}`);
    return;
  }

  const points = gridPoints(bbox, size, size);
  console.log(`[elevation] sampling ${size} x ${size} = ${points.length} points`);

  let result;
  if (source === 'open-elevation') {
    result = await fetchOpenElevation(points);
  } else {
    try {
      result = await fetchOpenMeteo(points);
    } catch (err) {
      if (source === 'open-meteo') throw err;
      console.warn(`[elevation] Open-Meteo failed (${err.message}); trying Open-Elevation`);
      result = await fetchOpenElevation(points);
    }
  }

  const doc = buildHeightmap(bbox, size, size, result.values, result, { smooth });
  await mkdir(dirname(out), { recursive: true });
  const json = JSON.stringify(doc);
  await writeFile(out, json);
  console.log(`[elevation] wrote ${out} (${(json.length / 1024).toFixed(0)} KB) from ${doc.source}: ${doc.minElevation}..${doc.maxElevation} m`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
