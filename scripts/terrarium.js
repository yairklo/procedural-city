// Elevation from the public AWS Terrain Tiles (Mapzen "terrarium" encoding), no API key:
//   https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
// Each pixel encodes height = (R * 256 + G + B / 256) - 32768 meters. Outside the US the
// source is mostly SRTM at 1 arc-second (~30 m), which resolves the Old City's relief (the
// Western Wall plaza, the Tyropoeon valley, the Ophel) far better than a 90 m DEM.
// Attribution: Mapzen / AWS Terrain Tiles; SRTM courtesy of NASA / USGS.
//
// decodePng(buffer)          -> { width, height, channels, data } (8-bit RGB / RGBA, non-interlaced)
// fetchTerrariumTile(z, x, y) -> { z, x, y, heights: Float32Array(256 * 256) }
// sampler(z)                  -> async (lat, lon) => meters (bilinear, tiles cached)

import { inflateSync } from 'node:zlib';

const URL_TEMPLATE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const USER_AGENT = 'procedural-city elevation fetch (one-time)';

/** Minimal PNG decoder for 8-bit truecolour (with or without alpha), non-interlaced images. */
export function decodePng(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!sig.every((b, i) => buf[i] === b)) throw new Error('not a PNG');
  let off = 8, width = 0, height = 0, depth = 0, color = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; color = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || (color !== 2 && color !== 6) || interlace) throw new Error(`unsupported PNG (depth ${depth}, colour ${color}, interlace ${interlace})`);
  const channels = color === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= channels ? out[dst + i - channels] : 0;
      const b = y > 0 ? out[dst - stride + i] : 0;
      const c = i >= channels && y > 0 ? out[dst - stride + i - channels] : 0;
      out[dst + i] = (filter === 0 ? x : filter === 1 ? x + a : filter === 2 ? x + b : filter === 3 ? x + ((a + b) >> 1) : x + paeth(a, b, c)) & 255;
    }
  }
  return { width, height, channels, data: out };
}

export function lonToTileX(lon, z) {
  return ((lon + 180) / 360) * 2 ** z;
}
export function latToTileY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

export async function fetchTerrariumTile(z, x, y) {
  const url = URL_TEMPLATE.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  let lastError;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const png = decodePng(Buffer.from(await res.arrayBuffer()));
      const heights = new Float32Array(png.width * png.height);
      for (let p = 0; p < heights.length; p++) {
        const k = p * png.channels;
        heights[p] = png.data[k] * 256 + png.data[k + 1] + png.data[k + 2] / 256 - 32768;
      }
      return { z, x, y, size: png.width, heights };
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastError;
}

/** Bilinear elevation sampler over terrarium tiles at zoom z (tiles fetched on demand, cached). */
export function sampler(z) {
  const cache = new Map();
  const tile = (x, y) => {
    const key = `${x}/${y}`;
    if (!cache.has(key)) cache.set(key, fetchTerrariumTile(z, x, y));
    return cache.get(key);
  };
  const pixel = async (px, py) => {
    const tx = Math.floor(px / 256), ty = Math.floor(py / 256);
    const t = await tile(tx, ty);
    return t.heights[(py - ty * 256) * t.size + (px - tx * 256)];
  };
  return async (lat, lon) => {
    // Pixel centres sit at +0.5.
    const fx = lonToTileX(lon, z) * 256 - 0.5, fy = latToTileY(lat, z) * 256 - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const [a, b, c, d] = await Promise.all([pixel(x0, y0), pixel(x0 + 1, y0), pixel(x0, y0 + 1), pixel(x0 + 1, y0 + 1)]);
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
}
