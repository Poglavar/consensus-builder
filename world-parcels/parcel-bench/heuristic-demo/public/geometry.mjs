// Raster-cell unions initialize shared plot geometry; export projects the final displayed polygons.
export const PROJECTIONS = {
  'EPSG:32736': '+proj=utm +zone=36 +south +datum=WGS84 +units=m +no_defs',
  'EPSG:32645': '+proj=utm +zone=45 +datum=WGS84 +units=m +no_defs',
  'EPSG:3765': '+proj=tmerc +lat_0=0 +lon_0=16.5 +k=0.9999 +x_0=500000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
};
export function cellPolygons(result, union) {
  const { labels, width, height, regions } = result, rectangles = new Map();
  for (let y = 0; y < height; y++) for (let x = 0; x < width;) {
    const label = labels[y * width + x], start = x;
    while (x < width && labels[y * width + x] === label) x++;
    if (!label) continue;
    if (!rectangles.has(label)) rectangles.set(label, []);
    rectangles.get(label).push([[[start, y], [x, y], [x, y + 1], [start, y + 1], [start, y]]]);
  }
  return regions.map(region => {
    // Integer-grid unions avoid the contour gaps, overlaps and self-crossings found in the earlier spike.
    const polygons = union(...rectangles.get(region.id));
    if (!polygons.length) throw new Error('A plot lost its geometry during construction.');
    return { id: region.id, polygons };
  });
}
export function vectorize(result, sample, settings, edits, { project }) {
  if (!PROJECTIONS[sample.crs]) throw new Error('This imagery projection is not configured.');
  const { width, height, regions, plots } = result, [x0, y0, x1, y1] = sample.bbox;
  const toWorld = ([x, y]) => project(PROJECTIONS[sample.crs], 'EPSG:4326', [x0 + x / width * (x1 - x0), y1 - y / height * (y1 - y0)]);
  const byId = new Map(plots.map(plot => [plot.id, plot.polygons]));
  const features = regions.map(region => {
    const polygons = byId.get(region.id);
    return { type: 'Feature', id: `${sample.id}:plot-${region.id}`,
      properties: { estimated: true, interpretation: 'illustrative-plot', method: result.recipe,
        seed_kind: region.kind, source_feature_id: region.source_id, area_m2: region.area_m2,
        sample_id: sample.id, image_sha256: sample.image_sha256, accuracy: 'unvalidated' },
      // Flipping image Y to northing reverses ring winding; restore GeoJSON's exterior CCW rule.
      geometry: { type: 'MultiPolygon', coordinates: polygons.map(polygon => polygon.map(ring => ring.map(toWorld).reverse())) } };
  });
  return { type: 'FeatureCollection', features, demo: { schema: 'illustrative-plots-v2', recipe: result.recipe,
    disclaimer: 'Illustrative plots generated from mapped features and visible divisions; not surveyed cadastral boundaries or ownership.',
    source_image: { sha256: sample.image_sha256, url: sample.source_url, attribution: sample.attribution, license: sample.license },
    source_features: { ...sample.provenance, attribution: sample.osm_attribution, license: sample.osm_license,
      fetched_at: sample.osm_fetched_at, snapshot_at: sample.osm_snapshot_at },
    raster: { width, height, bbox: sample.bbox, crs: sample.crs }, straightening: result.straightening, settings, edits,
    stats: result.stats, warnings: [...sample.warnings, ...result.warnings] } };
}
