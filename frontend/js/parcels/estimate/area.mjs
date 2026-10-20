// Bounded square areas and source geometry in locally scaled Web Mercator metres.
const R = 6378137, HALF_WORLD = Math.PI * R, RAD = Math.PI / 180;
export const GRID = 512;
export const SIZES = [128, 256, 512];
export function mercator([lon, lat]) {
  return [R * lon * RAD, R * Math.log(Math.tan(Math.PI / 4 + lat * RAD / 2))];
}
export function geographic([x, y]) {
  return [x / R / RAD, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) / RAD];
}
export function makeArea({ lng, lat }, size = 256) {
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) >= 180 || Math.abs(lat) > 80 || !SIZES.includes(size)) {
    throw new Error('area');
  }
  const scale = Math.cos(lat * RAD), [cx, cy] = mercator([lng, lat]), half = size / scale / 2;
  const mercatorBox = [cx - half, cy - half, cx + half, cy + half];
  const bounds = [...geographic(mercatorBox.slice(0, 2)), ...geographic(mercatorBox.slice(2))];
  if (bounds[0] < -180 || bounds[2] > 180) throw new Error('area');
  return { size, scale, center: [lng, lat], mercatorBox, bounds, bbox: mercatorBox.map(v => v * scale) };
}
export function toPixel(coordinate, area) {
  const [x, y] = mercator(coordinate), [w, , e, n] = area.mercatorBox;
  return [(x - w) / (e - w) * GRID, (n - y) / (e - w) * GRID];
}
export function tilePlan(area) {
  const z = Math.min(22, Math.max(0, Math.floor(Math.log2(2 * HALF_WORLD * area.scale * GRID / (256 * area.size)))));
  const span = 2 * HALF_WORLD / 2 ** z, [w, s, e, n] = area.mercatorBox;
  const left = (w + HALF_WORLD) / span, top = (HALF_WORLD - n) / span;
  const right = (e + HALF_WORLD) / span, bottom = (HALF_WORLD - s) / span;
  const tiles = [];
  for (let y = Math.floor(top); y < Math.ceil(bottom); y++) for (let x = Math.floor(left); x < Math.ceil(right); x++) {
    tiles.push({ z, x, y, dx: (x - left) / (right - left) * GRID, dy: (y - top) / (bottom - top) * GRID,
      size: GRID / (right - left) });
  }
  if (tiles.length > 9) throw new Error('area');
  return tiles;
}
export function prepareSample(area, collection, imageHash, contextHash) {
  if (collection.partial || collection.truncated || !Array.isArray(collection.features)) throw new Error('context');
  const features = { buildings: [], roads: [], water: [], waterways: [] };
  for (const feature of collection.features) {
    const p = feature.properties || {}, g = feature.geometry;
    if (!g) throw new Error('context');
    const id = p.source_id || feature.id;
    if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
      const target = p.kind === 'building' ? features.buildings : p.kind === 'water' ? features.water : null;
      if (target) for (const rings of g.type === 'Polygon' ? [g.coordinates] : g.coordinates) {
        target.push({ id, rings: rings.map(ring => ring.map(point => toPixel(point, area))) });
      }
    } else if (g.type === 'LineString') {
      const target = p.kind === 'road' ? features.roads : p.kind === 'water' || p.kind === 'waterway' ? features.waterways : null;
      if (target) target.push({ id, points: g.coordinates.map(point => toPixel(point, area)),
        highway: p.highway, width_m: p.width_m, bridge: p.bridge, tunnel: p.tunnel });
    }
  }
  return { id: `estimate-${area.center.join(',')}-${area.size}-${imageHash.slice(0, 12)}-${contextHash.slice(0, 12)}`,
    width: GRID, height: GRID, bbox: area.bbox, crs: 'LOCAL:SCALED_WEB_MERCATOR',
    mercator_scale: area.scale, center: area.center, features, image_sha256: imageHash,
    image_hash_format: 'RGBA8 512x512', image_tiles: tilePlan(area).map(({ z, x, y }) => ({ z, x, y })),
    source_url: 'https://www.maptiler.com/satellite/', attribution: 'MapTiler satellite imagery',
    license: 'MapTiler terms; non-commercial academic derived data',
    osm_attribution: '© OpenStreetMap contributors', osm_license: 'ODbL-1.0',
    provenance: { context_sha256: contextHash, source: 'OpenStreetMap via Overpass' },
    warnings: ['Illustrative rectangles; source imagery and OSM may be incomplete or out of date. Areas use locally scaled Web Mercator, not a cadastral survey.'] };
}
