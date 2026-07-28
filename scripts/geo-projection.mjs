// Shared GISCO-to-SVG projection helpers used by build-geo.mjs (NUTS3) and build-geo-nuts2.mjs
// (NUTS2). Both layers must share the exact same bbox + scale so their paths land in the same
// coordinate space and align pixel-perfect when overlaid — see build-geo-nuts2.mjs.

export const SCALE = 219; // degrees -> user units; ~1000 wide viewBox for clean rounding

export function eachCoord(c, cb) {
  if (typeof c[0] === 'number') cb(c);
  else c.forEach((x) => eachCoord(x, cb));
}

// Bounding box (in degrees) spanning every coordinate in the given GeoJSON features.
export function computeBbox(features) {
  let lonMin = Infinity,
    lonMax = -Infinity,
    latMin = Infinity,
    latMax = -Infinity;
  for (const f of features)
    eachCoord(f.geometry.coordinates, ([lon, lat]) => {
      lonMin = Math.min(lonMin, lon);
      lonMax = Math.max(lonMax, lon);
      latMin = Math.min(latMin, lat);
      latMax = Math.max(latMax, lat);
    });
  return { lonMin, lonMax, latMin, latMax };
}

// Plain equirectangular projection fitted to `bbox`, x scaled by cos(midLat) so the country is not
// horizontally stretched. Returns projector fns plus the resulting integer viewBox width/height.
export function makeProjector({ lonMin, lonMax, latMin, latMax }, scale = SCALE) {
  const k = Math.cos((((latMin + latMax) / 2) * Math.PI) / 180);
  const px = (lon) => +((lon - lonMin) * k * scale).toFixed(1);
  const py = (lat) => +((latMax - lat) * scale).toFixed(1); // flip Y for SVG
  const W = Math.round((lonMax - lonMin) * k * scale);
  const H = Math.round((latMax - latMin) * scale);

  const polysOf = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);
  function pathD(geom) {
    let d = '';
    for (const poly of polysOf(geom))
      for (const ring of poly) {
        ring.forEach(([lon, lat], i) => (d += `${i ? 'L' : 'M'}${px(lon)},${py(lat)}`));
        d += 'Z';
      }
    return d;
  }

  return { px, py, W, H, pathD };
}
