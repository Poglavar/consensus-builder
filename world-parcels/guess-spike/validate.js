// Repair raster contour self-touches, then reject unclosed or self-intersecting polygons.
const fs = require('node:fs');
const path = require('node:path');
const clipping = require('../../backend/node_modules/polygon-clipping');
const turf = require('../../backend/node_modules/@turf/turf');

const target = process.argv[2];
if (!target) throw new Error('Usage: node validate.js <geojson>');
const data = JSON.parse(fs.readFileSync(target, 'utf8'));
const repaired = [];
const ids = new Set();
const ringArea = ring => Math.abs(ring.reduce((sum, p, i) => {
  const q = ring[(i + 1) % ring.length];
  return sum + p[0] * q[1] - q[0] * p[1];
}, 0) / 2);
for (const feature of data.features) {
  const pieces = clipping.union(feature.geometry.coordinates);
  for (const [pieceIndex, polygon] of pieces.entries()) {
    const item = { ...feature, geometry: { type: 'Polygon', coordinates: polygon } };
    if (polygon.some(ring => ring.length < 4 || ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) ||
        turf.kinks(item).features.length || ringArea(polygon[0]) - polygon.slice(1).reduce((n, ring) => n + ringArea(ring), 0) <= 0) {
      throw new Error(`Invalid guessed polygon for seed ${feature.properties.building_seed}`);
    }
    item.properties = { ...feature.properties,
      estimated_id: `guess-${feature.properties.tile_id}-${feature.properties.method}-${feature.properties.source_osm_id ?? feature.properties.building_seed}-${feature.properties.component}-${pieceIndex + 1}` };
    if (ids.has(item.properties.estimated_id)) throw new Error(`Duplicate ${item.properties.estimated_id}`);
    ids.add(item.properties.estimated_id);
    repaired.push(item);
  }
}
data.features = repaired;
fs.writeFileSync(target, JSON.stringify(data));
console.log(`Validated ${repaired.length} polygons in ${path.basename(target)}`);
