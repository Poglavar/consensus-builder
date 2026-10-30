// CityGML building reader: parses CityGML 1.0/2.0 buildings (LOD1/LOD2 solids and their roof, wall
// and ground surfaces) into the flat-face mesh records the 3D view draws, and their ground surfaces
// into footprints. Pure apart from the projection passed in; the sheet-fetching source is citygml-source.js.
import { SaxesParser } from 'saxes';

const SEMANTIC = { WallSurface: 'wall', RoofSurface: 'roof', GroundSurface: 'ground', ClosureSurface: 'closure',
    OuterCeilingSurface: 'roof', OuterFloorSurface: 'ground', FloorSurface: 'floor', CeilingSurface: 'ceiling',
    InteriorWallSurface: 'interior' };
const local = name => name.slice(name.indexOf(':') + 1);

// CityGML text → [{ id, name, attributes, measuredHeightM, roofType, storeysAboveGround, function, usage,
// surfaces: [{ kind, rings: [[[x, y, z], ...], ...] }] }] in the file's own coordinates. Surfaces of a
// building's parts belong to the building. Semantic surfaces (roof, wall, ground) are taken when a
// building has any; otherwise its geometry's polygons, as kind "surface", so a LOD1 solid still draws.
export function parseCityGml(text) {
    const parser = new SaxesParser({ xmlns: false });
    const buildings = [];
    const stack = [];
    let building = null, depth = 0, polygon = null, ring = null, chars = '', attribute = null;
    let semantic = [], dimension = 3;
    parser.on('opentag', tag => {
        const name = local(tag.name);
        stack.push(name);
        chars = '';
        if (name === 'Building' && !building) {
            building = { id: tag.attributes['gml:id'] || null, name: null, attributes: {}, measuredHeightM: null, roofType: null,
                storeysAboveGround: null, function: null, usage: null, semanticSurfaces: [], otherSurfaces: [] };
            depth = stack.length;
        }
        if (!building) return;
        if (SEMANTIC[name]) semantic.push(SEMANTIC[name]);
        if (name === 'stringAttribute' || name === 'intAttribute' || name === 'doubleAttribute') attribute = tag.attributes.name || null;
        if (name === 'Polygon') polygon = { kind: semantic.at(-1) || null, rings: [] };
        if ((name === 'posList' || name === 'pos') && tag.attributes.srsDimension) dimension = Number(tag.attributes.srsDimension) || 3;
        if (name === 'LinearRing') ring = [];
    });
    parser.on('text', text => { chars += text; });
    parser.on('closetag', tag => {
        const name = local(tag.name);
        const parent = stack[stack.length - 2];
        if (building) {
            const value = chars.trim();
            if (name === 'posList' && ring) ring.push(...triples(value, dimension));
            else if (name === 'pos' && ring) ring.push(...triples(value, dimension));
            else if (name === 'LinearRing' && polygon && ring) { if (ring.length >= 3) polygon.rings.push(ring); ring = null; }
            else if (name === 'Polygon' && polygon) {
                if (polygon.rings.length) (polygon.kind ? building.semanticSurfaces : building.otherSurfaces).push(polygon);
                polygon = null;
            } else if (SEMANTIC[name]) semantic.pop();
            else if (name === 'value' && attribute) { building.attributes[attribute] = value; attribute = null; }
            else if (name === 'name' && parent === 'Building' && stack.length === depth + 1) building.name = value;
            else if (name === 'measuredHeight' && building.measuredHeightM == null) building.measuredHeightM = finite(value);
            else if (name === 'roofType' && !building.roofType) building.roofType = value;
            else if (name === 'storeysAboveGround' && building.storeysAboveGround == null) building.storeysAboveGround = finite(value);
            else if (name === 'function' && !building.function) building.function = value;
            else if (name === 'usage' && !building.usage) building.usage = value;
            if (name === 'Building' && stack.length === depth) {
                const { semanticSurfaces, otherSurfaces, ...rest } = building;
                const surfaces = semanticSurfaces.length ? semanticSurfaces : otherSurfaces.map(surface => ({ ...surface, kind: 'surface' }));
                if (surfaces.length) buildings.push({ ...rest, surfaces });
                building = null; semantic = [];
            }
        }
        stack.pop();
        chars = '';
    });
    parser.write(text).close();
    return buildings;
}

function finite(value) {
    const number = Number(value);
    return value !== '' && Number.isFinite(number) ? number : null;
}

function triples(text, dimension) {
    const numbers = text.split(/\s+/).filter(Boolean).map(Number);
    if (dimension !== 3 || numbers.length % 3 || numbers.some(n => !Number.isFinite(n))) {
        throw new Error(`CityGML coordinates must be finite 3D triples (srsDimension ${dimension}).`);
    }
    const points = [];
    for (let i = 0; i < numbers.length; i += 3) points.push([numbers[i], numbers[i + 1], numbers[i + 2]]);
    return points;
}

// A parsed building → the 3D view's record { object_id, z_min, z_max, faces } and its footprint
// (the ground surfaces as a MultiPolygon, or null without one). toLngLat(x, y) → [lng, lat];
// heightOffsetM moves the source's height datum to metres above sea level.
export function buildingRecord(building, toLngLat, { heightOffsetM = 0, idPrefix = '' } = {}) {
    let zMin = Infinity, zMax = -Infinity;
    const project = point => {
        const [lng, lat] = toLngLat(point[0], point[1]);
        const z = point[2] + heightOffsetM;
        if (z < zMin) zMin = z;
        if (z > zMax) zMax = z;
        return [round(lng, 1e7), round(lat, 1e7), round(z, 1e3)];
    };
    const faces = [], ground = [];
    for (const surface of building.surfaces) {
        const rings = surface.rings.map(ring => closed(ring.map(project)));
        faces.push({ type: 'Polygon', coordinates: rings, kind: surface.kind });
        if (surface.kind === 'ground') ground.push(rings.map(ring => ring.map(([lng, lat]) => [lng, lat])));
    }
    if (!faces.length) return null;
    const id = `${idPrefix}${building.id || building.name}`;
    return {
        record: { object_id: id, z_min: round(zMin, 1e3), z_max: round(zMax, 1e3), faces },
        footprint: ground.length ? { type: 'MultiPolygon', coordinates: ground } : null,
        heightM: building.measuredHeightM ?? round(zMax - zMin, 1e3),
        storeys: building.storeysAboveGround
    };
}

function closed(ring) {
    const first = ring[0], last = ring[ring.length - 1];
    return first[0] === last[0] && first[1] === last[1] && first[2] === last[2] ? ring : [...ring, first];
}

function round(value, scale) {
    return Math.round(value * scale) / scale;
}
