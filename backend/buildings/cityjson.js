// CityJSON building reader: CityJSON 1.x/2.0 documents and CityJSONFeatures (CityJSONSeq, OGC API
// pages) → the same building shape parseCityGml returns ({ id, name, attributes, measuredHeightM,
// roofType, storeysAboveGround, function, usage, surfaces: [{ kind, rings }] }), in the file's own
// coordinates. A building's parts join it; each object draws its most detailed geometry up to maxLod.

const SEMANTIC = { WallSurface: 'wall', RoofSurface: 'roof', GroundSurface: 'ground', ClosureSurface: 'closure',
    OuterCeilingSurface: 'roof', OuterFloorSurface: 'ground', FloorSurface: 'floor', CeilingSurface: 'ceiling',
    InteriorWallSurface: 'interior' };
const BUILDING_TYPES = new Set(['Building']);
const PART_TYPES = new Set(['BuildingPart']);

// doc: a CityJSON object, or { transform, features: [CityJSONFeature] } (the features' vertices use the
// transform of the document that carries them). options.maxLod caps the level of detail (e.g. 2.2).
export function parseCityJson(doc, { maxLod = Infinity } = {}) {
    if (!doc || typeof doc !== 'object') throw new Error('CityJSON must be an object.');
    const pieces = doc.type === 'CityJSON' && !Array.isArray(doc.features)
        ? [{ CityObjects: doc.CityObjects || {}, vertices: doc.vertices || [] }]
        : (doc.features || []).map(feature => {
            if (feature?.type !== 'CityJSONFeature') throw new Error('Expected CityJSONFeature items.');
            return feature;
        });
    const transform = doc.transform || doc.metadata?.transform || null;
    const buildings = [];
    for (const piece of pieces) {
        const real = realVertices(piece.vertices, transform);
        const objects = piece.CityObjects || {};
        for (const [id, object] of Object.entries(objects)) {
            if (!BUILDING_TYPES.has(object.type)) continue;
            const members = [object, ...(object.children || []).map(child => objects[child]).filter(part => part && PART_TYPES.has(part.type))];
            // A LoD 0 footprint stands in only when no member has a body (3D BAG keeps one on the building
            // and the solids on its part): taken together, the ground would count twice.
            const picks = members.map(member => bestGeometry(member.geometry, maxLod)).filter(Boolean);
            const bodies = picks.filter(geometry => Number(geometry.lod) > 0);
            const surfaces = (bodies.length ? bodies : picks).flatMap(geometry => surfacesOf(geometry, real));
            if (!surfaces.length) continue;
            const attributes = object.attributes || {};
            buildings.push({
                id, name: attributes.name ?? null, attributes,
                measuredHeightM: finite(attributes.measuredHeight),
                roofType: attributes.roofType ?? null,
                storeysAboveGround: finite(attributes.storeysAboveGround),
                function: attributes.function ?? null,
                usage: attributes.usage ?? null,
                surfaces
            });
        }
    }
    return buildings;
}

function finite(value) {
    const number = typeof value === 'string' ? Number(value) : value;
    return typeof number === 'number' && Number.isFinite(number) ? number : null;
}

function realVertices(vertices, transform) {
    if (!Array.isArray(vertices)) throw new Error('CityJSON vertices must be an array.');
    const scale = transform?.scale || [1, 1, 1], translate = transform?.translate || [0, 0, 0];
    return vertices.map(([x, y, z]) => [x * scale[0] + translate[0], y * scale[1] + translate[1], z * scale[2] + translate[2]]);
}

// The most detailed geometry of one object up to maxLod.
function bestGeometry(geometries, maxLod) {
    let best = null, bestLod = -Infinity;
    for (const geometry of geometries || []) {
        const lod = Number(geometry.lod);
        if (!Number.isFinite(lod) || lod > maxLod || geometry.type === 'GeometryInstance') continue;
        if (lod > bestLod) { best = geometry; bestLod = lod; }
    }
    return best;
}

function surfacesOf(geometry, vertices) {
    if (!geometry) return [];
    const semantics = geometry.semantics;
    const kindOf = index => {
        const surface = index == null ? null : semantics?.surfaces?.[index];
        return (surface && SEMANTIC[surface.type]) || (Number(geometry.lod) === 0 ? 'ground' : 'surface');
    };
    const ring = indices => indices.map(index => {
        const point = vertices[index];
        if (!point) throw new Error(`CityJSON vertex ${index} does not exist.`);
        return point;
    });
    const surface = (boundary, value) => ({ kind: kindOf(value), rings: boundary.map(ring).filter(points => points.length >= 3) });
    const values = semantics?.values;
    const out = [];
    switch (geometry.type) {
        case 'MultiSurface': case 'CompositeSurface':
            geometry.boundaries.forEach((boundary, s) => out.push(surface(boundary, values?.[s])));
            break;
        case 'Solid':
            geometry.boundaries.forEach((shell, h) => shell.forEach((boundary, s) => out.push(surface(boundary, values?.[h]?.[s]))));
            break;
        case 'MultiSolid': case 'CompositeSolid':
            geometry.boundaries.forEach((solid, d) => solid.forEach((shell, h) => shell.forEach((boundary, s) =>
                out.push(surface(boundary, values?.[d]?.[h]?.[s])))));
            break;
        default:
            return [];
    }
    return out.filter(entry => entry.rings.length);
}
