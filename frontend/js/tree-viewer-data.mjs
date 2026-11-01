// Shared validation for the viewer's bounded, read-only tree requests.
export const HOME = Object.freeze([45.8007523, 15.9873677]);
export const HOME_ZOOM = 18;

export function parseBbox(value) {
  const parts = typeof value === 'string' ? value.split(',') : [];
  if (parts.length !== 4 || parts.some(p => !p.trim())) throw new Error('Four bounding-box coordinates are required.');
  const bbox = parts.map(Number);
  const [west, south, east, north] = bbox;
  if (!bbox.every(Number.isFinite) || west < -180 || east > 180 || south < -85 || north > 85 || west >= east || south >= north) {
    throw new Error('Invalid map bounds.');
  }
  if (east - west > 0.08 || north - south > 0.08) throw new Error('Zoom in to load individual trees.');
  return bbox;
}

export function readTrees(data) {
  if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw new Error('The tree service returned an invalid response.');
  const ids = new Set();
  return data.features.map(feature => {
    const coords = feature?.geometry?.coordinates;
    const id = feature?.properties?.sifra;
    if (feature?.geometry?.type !== 'Point' || !Array.isArray(coords) || coords.length !== 2 ||
        !coords.every(v => typeof v === 'number' && Number.isFinite(v)) ||
        Math.abs(coords[0]) > 180 || Math.abs(coords[1]) > 90 || !Number.isSafeInteger(id) || id < 0 || ids.has(id)) {
      throw new Error('The tree service returned invalid or duplicate tree records.');
    }
    ids.add(id);
    return { id, lat: coords[1], lon: coords[0] };
  });
}
