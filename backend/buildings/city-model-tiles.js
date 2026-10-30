// A city model cut into square tiles of CityJSON 2.0, for a city that publishes one file too large to
// read per request (New York's 3D model, nyc-3d.js). Pure: which tiles a building touches, and one
// tile's buildings (the shared building shape of city-model-reader.js) written as a CityJSON document
// that cityjson.js reads back into the same shape. Coordinates stay in the source's CRS.

// Our surface kinds and CityJSON's semantic surface types.
const SEMANTIC = { wall: 'WallSurface', roof: 'RoofSurface', ground: 'GroundSurface', closure: 'ClosureSurface',
    floor: 'FloorSurface', ceiling: 'CeilingSurface', interior: 'InteriorWallSurface' };

export const tileId = (x, y) => `${x}_${y}`;

// The [minX, minY, maxX, maxY] of a building's surfaces, in its own coordinates.
export function buildingBox(building) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const surface of building.surfaces) for (const ring of surface.rings) for (const [x, y] of ring) {
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

// Every tile of side `size` a box touches: a building on a tile edge is in each tile it reaches, so a
// box read from the tiles it touches finds it (readers join buildings by id).
export function tilesOf([minX, minY, maxX, maxY], size) {
    const ids = [];
    for (let x = Math.floor(minX / size); x <= Math.floor(maxX / size); x++) {
        for (let y = Math.floor(minY / size); y <= Math.floor(maxY / size); y++) ids.push(tileId(x, y));
    }
    return ids;
}

// Buildings → one CityJSON 2.0 document: each a Building with one LoD 2 MultiSurface whose semantics
// keep the surface kinds, its attributes as read, vertices as integers at `scale` units.
export function cityJsonTile(buildings, { referenceSystem, scale = 0.01, metadata = {} }) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    for (const building of buildings) for (const surface of building.surfaces) for (const ring of surface.rings) for (const [x, y, z] of ring) {
        if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    }
    const translate = [minX, minY, minZ].map(value => Number.isFinite(value) ? Math.floor(value) : 0);
    const vertices = [], index = new Map();
    const vertex = point => {
        const key = point.map((value, k) => Math.round((value - translate[k]) / scale));
        const k = key.join(',');
        if (!index.has(k)) { index.set(k, vertices.length); vertices.push(key); }
        return index.get(k);
    };
    const objects = {};
    for (const building of buildings) {
        const kinds = [...new Set(building.surfaces.map(surface => surface.kind))];
        const boundaries = building.surfaces.map(surface => surface.rings.map(ring => {
            const open = ring.length > 1 && ring[0].every((value, k) => value === ring[ring.length - 1][k]) ? ring.slice(0, -1) : ring;
            return open.map(vertex);
        }));
        const typed = kinds.filter(kind => SEMANTIC[kind]);
        const attributes = { ...building.attributes };
        if (building.name) attributes.name = building.name;
        if (building.measuredHeightM != null) attributes.measuredHeight = building.measuredHeightM;
        if (building.storeysAboveGround != null) attributes.storeysAboveGround = building.storeysAboveGround;
        if (building.roofType) attributes.roofType = building.roofType;
        if (building.function) attributes.function = building.function;
        if (building.usage) attributes.usage = building.usage;
        objects[building.id] = { type: 'Building', attributes, geometry: [{ type: 'MultiSurface', lod: '2', boundaries,
            ...(typed.length ? { semantics: { surfaces: typed.map(kind => ({ type: SEMANTIC[kind] })),
                values: building.surfaces.map(surface => SEMANTIC[surface.kind] ? typed.indexOf(surface.kind) : null) } } : {}) }] };
    }
    return { type: 'CityJSON', version: '2.0', transform: { scale: [scale, scale, scale], translate },
        metadata: { referenceSystem, ...metadata }, CityObjects: objects, vertices };
}
