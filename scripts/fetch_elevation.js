#!/usr/bin/env node
// One-time data ingestion: samples terrain elevation over the Jerusalem bbox on a regular
// grid and writes a compact heightmap the game loads at runtime (no network needed).
//
//   node scripts/fetch_elevation.js              # 64 x 64 grid (default)
//   node scripts/fetch_elevation.js --size 128   # 128 x 128 grid
//   node scripts/fetch_elevation.js --out path.json
//   node scripts/fetch_elevation.js --source open-elevation   # skip Open-Meteo
//   node scripts/fetch_elevation.js --smooth 2.5              # Gaussian sigma in grid cells (0 = off)
//
// Sources, tried in order:
//   1. Open-Meteo Elevation API: Copernicus DEM GLO-90 (~90 m), CC BY 4.0
//   2. Open-Elevation: SRTM (~30 m), public domain
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

export const JERUSALEM_BBOX = Object.freeze({ south: 31.778, west: 35.21, north: 31.788, east: 35.225 });

const OUT_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../public/data/jerusalem_elevation.json');
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
  const out = arg('--out') ?? OUT_FILE;
  const source = arg('--source') ?? 'auto';
  if (!['auto', 'open-meteo', 'open-elevation'].includes(source)) throw new Error('--source must be auto, open-meteo or open-elevation');
  const smooth = Number(arg('--smooth') ?? 2.5);
  if (!(smooth >= 0)) throw new Error('--smooth must be >= 0');

  const points = gridPoints(JERUSALEM_BBOX, size, size);
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

  const doc = buildHeightmap(JERUSALEM_BBOX, size, size, result.values, result, { smooth });
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
