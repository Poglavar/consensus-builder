// HMLR parcel tile format, shared by the tile build job and the browser reader. A tile holds the raw
// INSPIRE input polygons whose native (EPSG:27700) bounding box touches its 1 km grid square, in
// integer millimetres with per-ring deltas; decoding restores the exact parsed coordinates.
export const HMLR_TILE_FORMAT = 1;
export const HMLR_TILE_SIZE_M = 1000;
export const HMLR_INDEX_SHARD_TILES = 10;

export const tileKey = (e, n) => `${e}_${n}`;
export const indexShardKey = (e, n) => `${Math.floor(e / HMLR_INDEX_SHARD_TILES)}_${Math.floor(n / HMLR_INDEX_SHARD_TILES)}`;
export const idBucket = id => (id.length < 4 ? id : id.slice(0, 4));

// Inclusive tile range [e0, n0, e1, n1] covering a native bounding box.
export function tileRange(bbox) {
    return [Math.floor(bbox[0] / HMLR_TILE_SIZE_M), Math.floor(bbox[1] / HMLR_TILE_SIZE_M),
        Math.floor(bbox[2] / HMLR_TILE_SIZE_M), Math.floor(bbox[3] / HMLR_TILE_SIZE_M)];
}

function nativeBbox(geometry) {
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    for (const polygon of polygons) for (const ring of polygon) for (const [x, y] of ring) {
        if (x < box[0]) box[0] = x; if (y < box[1]) box[1] = y; if (x > box[2]) box[2] = x; if (y > box[3]) box[3] = y;
    }
    return box;
}

// [id, kind, polygons, raw?]: kind 0 = Polygon, 1 = MultiPolygon. Rings are [x0, y0, dx1, dy1, ...]
// in millimetres. A coordinate that integer millimetres cannot reproduce exactly keeps the whole
// row as raw coordinates (raw flag 1), so decoding never changes a parsed value.
export function encodeTileRow(feature) {
    const id = String(feature.properties?.INSPIREID ?? feature.id).replace(/^0+(?=\d)/, '');
    if (!/^\d{1,64}$/.test(id)) throw new Error('Invalid native HMLR ID.');
    const geometry = feature.geometry, kind = geometry.type === 'Polygon' ? 0 : geometry.type === 'MultiPolygon' ? 1 : -1;
    if (kind < 0) throw new Error(`Unsupported HMLR geometry ${geometry.type}.`);
    const polygons = kind === 0 ? [geometry.coordinates] : geometry.coordinates;
    let exact = true;
    const encoded = polygons.map(polygon => polygon.map(ring => {
        const flat = []; let px = 0, py = 0;
        ring.forEach(([x, y], index) => {
            const mx = Math.round(x * 1000), my = Math.round(y * 1000);
            if (mx / 1000 !== x || my / 1000 !== y || ring[index].length !== 2) exact = false;
            flat.push(index ? mx - px : mx, index ? my - py : my); px = mx; py = my;
        });
        return flat;
    }));
    const bbox = nativeBbox(geometry);
    return exact ? { row: [id, kind, encoded], raw: false, bbox } : { row: [id, kind, polygons, 1], raw: true, bbox };
}

// The parsed native feature exactly as gml-parcel-reader produces it for HMLR archives.
export function decodeTileRow(row) {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || !/^\d{1,64}$/.test(row[0]) || ![0, 1].includes(row[1]) || !Array.isArray(row[2])) {
        throw new Error('Invalid HMLR tile row.');
    }
    const [id, kind, data, raw] = row;
    const polygons = raw === 1 ? data : data.map(polygon => polygon.map(flat => {
        const ring = []; let x = 0, y = 0;
        for (let index = 0; index < flat.length; index += 2) {
            x = index ? x + flat[index] : flat[index]; y = index ? y + flat[index + 1] : flat[index + 1];
            ring.push([x / 1000, y / 1000]);
        }
        return ring;
    }));
    const geometry = kind === 0 ? { type: 'Polygon', coordinates: polygons[0] } : { type: 'MultiPolygon', coordinates: polygons };
    const bbox = nativeBbox(geometry);
    return { type: 'Feature', id, properties: { INSPIREID: id }, geometry, bbox };
}
