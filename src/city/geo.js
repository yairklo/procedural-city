// Lat/lon -> local game coordinates (meters).
//
// A local tangent-plane (equirectangular) projection around the center of the data's
// bounding box. Over a couple of kilometers the error is well under a centimeter,
// so real distances, angles and footprint shapes are preserved.
//
// Axes follow three.js conventions: +X = east, +Y = up, -Z = north (so +Z = south).

const DEG = Math.PI / 180;

/** @param {{south:number, west:number, north:number, east:number}} bbox */
export function createProjection(bbox) {
  const lat0 = (bbox.south + bbox.north) / 2;
  const lon0 = (bbox.west + bbox.east) / 2;
  const phi = lat0 * DEG;
  // Length of one degree on the WGS84 ellipsoid at this latitude.
  const metersPerDegLat = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi) - 0.0023 * Math.cos(6 * phi);
  const metersPerDegLon = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi) + 0.118 * Math.cos(5 * phi);

  const project = (lat, lon) => ({ x: (lon - lon0) * metersPerDegLon, z: -(lat - lat0) * metersPerDegLat });
  const unproject = (x, z) => ({ lat: lat0 - z / metersPerDegLat, lon: lon0 + x / metersPerDegLon });

  /** Flat [lat, lon, lat, lon, ...] -> flat [x, z, x, z, ...]. */
  const projectFlat = (coords) => {
    const out = new Array(coords.length);
    for (let i = 0; i < coords.length; i += 2) {
      out[i] = (coords[i + 1] - lon0) * metersPerDegLon;
      out[i + 1] = -(coords[i] - lat0) * metersPerDegLat;
    }
    return out;
  };

  const sw = project(bbox.south, bbox.west);
  const ne = project(bbox.north, bbox.east);

  return {
    origin: { lat: lat0, lon: lon0 },
    metersPerDegLat,
    metersPerDegLon,
    project,
    unproject,
    projectFlat,
    bounds: { minX: sw.x, maxX: ne.x, minZ: ne.z, maxZ: sw.z },
  };
}
