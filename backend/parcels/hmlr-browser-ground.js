// Browser-capable deterministic HMLR ground resolution over a complete native-coordinate context.
import initGeos from 'geos-wasm';
import { geojsonToGeosGeom, geosGeomToGeojson } from 'geos-wasm/helpers';
import proj4 from 'proj4';
import { sha256Hex } from './portable-hash.js';
import { canonicalParcelFeature } from './source-contract.js';

export const HMLR_BROWSER_GROUND_SOURCE = 'gb-hmlr-browser-v1';
export const HMLR_BROWSER_GROUND_PREFIX = 'GB-HMLR-BROWSER-v1-';
export const HMLR_BROWSER_GROUND_POLICY = 'hmlr-browser-v1-area-desc-id-asc-grid1mm-project-before-overlay-geos3.13.0';
export const HMLR_BROWSER_GROUND_GRID_METERS = 0.001;

const descriptor = Object.freeze({ id: HMLR_BROWSER_GROUND_SOURCE, idPrefix: HMLR_BROWSER_GROUND_PREFIX,
    parcelNumberField: 'INSPIREID', outFields: ['INSPIREID'] });
const GEOMETRY_COLLECTION = 7;
proj4.defs('EPSG:27700', '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.1502,0.2470,0.8421,-20.4894 +units=m +no_defs');
const project = proj4('EPSG:27700', 'EPSG:4326');
const unproject = proj4('EPSG:4326', 'EPSG:27700');

function nativeId(feature) {
    const value = feature?.properties?.INSPIREID ?? feature?.properties?.sourceProperties?.INSPIREID;
    const text = String(value ?? '');
    if (!/^[0-9]{1,64}$/.test(text)) throw new Error('Invalid HMLR native INSPIREID.');
    return text.replace(/^0+(?=\d)/, '');
}
function validateNativeGeometry(geometry, id) {
    if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) throw new Error(`Invalid HMLR polygon for ${id}.`);
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    if (!Array.isArray(polygons) || !polygons.length) throw new Error(`Invalid HMLR polygon for ${id}.`);
    for (const polygon of polygons) {
        if (!Array.isArray(polygon) || !polygon.length) throw new Error(`Invalid HMLR polygon for ${id}.`);
        for (const ring of polygon) {
            if (!Array.isArray(ring) || ring.length < 4 || ring.some(point => !Array.isArray(point) || point.length !== 2
                || !point.every(Number.isFinite)) || ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) {
                throw new Error(`Invalid native HMLR ring for ${id}.`);
            }
        }
    }
}
function polygonCoordinates(geometry, output = []) {
    if (!geometry) return output;
    if (geometry.type === 'Polygon') output.push(geometry.coordinates);
    else if (geometry.type === 'MultiPolygon') output.push(...geometry.coordinates);
    else if (geometry.type === 'GeometryCollection') for (const child of geometry.geometries || []) polygonCoordinates(child, output);
    return output;
}
function polygonal(geometry) {
    const coordinates = polygonCoordinates(geometry);
    return coordinates.length ? { type: 'MultiPolygon', coordinates } : null;
}
function mapCoordinates(value, fn) {
    if (typeof value?.[0] === 'number') return fn(value);
    return value.map(child => mapCoordinates(child, fn));
}
function projectGeometry(geometry) {
    return { type: geometry.type, coordinates: mapCoordinates(geometry.coordinates, point => {
        const result = project.forward(point);
        if (!result.every(Number.isFinite)) throw new Error('Invalid projected HMLR coordinate.');
        return result;
    }) };
}
function unprojectGeometry(geometry) {
    return { type: geometry.type, coordinates: mapCoordinates(geometry.coordinates, point => {
        const result = unproject.forward(point);
        if (!result.every(Number.isFinite)) throw new Error('Invalid inverse projected HMLR coordinate.');
        return result;
    }) };
}
function bounds(geometry) {
    const out = [Infinity, Infinity, -Infinity, -Infinity];
    const visit = value => {
        if (typeof value?.[0] === 'number') {
            out[0] = Math.min(out[0], value[0]); out[1] = Math.min(out[1], value[1]);
            out[2] = Math.max(out[2], value[0]); out[3] = Math.max(out[3], value[1]);
        } else for (const child of value || []) visit(child);
    };
    visit(geometry.coordinates);
    return out;
}
function overlaps(a, b) { return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]; }
// Absorbs overlay rounding when a policy input is compared with a query rectangle (about 1 cm).
const BOUNDS_TEST_PAD_DEGREES = 1e-7;
function polygonalResult(geos, pointer) { return polygonal(geosGeomToGeojson(pointer, geos)); }
// The policy's input normalization, shared by resolution and rectangle tests: repair, keep the
// polygonal part, normalize, then snap to the 1 mm grid. `own` registers pointers for disposal.
function normalizeNativeInput(geos, own, raw, id) {
    const wasValid = geos.GEOSisValid(raw) === 1;
    const valid = own(geos.GEOSMakeValid(raw));
    const validGeo = polygonalResult(geos, valid);
    if (!validGeo) throw new Error(`HMLR geometry ${id} has no polygonal area after repair.`);
    const polygon = own(geojsonToGeosGeom(validGeo, geos));
    geos.GEOSNormalize(polygon);
    const normalized = own(geos.GEOSGeom_setPrecision(polygon, HMLR_BROWSER_GROUND_GRID_METERS, 0));
    if (geos.GEOSisEmpty(normalized) || geos.GEOSisValid(normalized) !== 1) throw new Error(`HMLR geometry ${id} collapsed or became invalid on the 1 mm grid.`);
    const normalizedGeo = polygonalResult(geos, normalized);
    if (!normalizedGeo) throw new Error(`HMLR geometry ${id} has no polygon after grid normalization.`);
    return { wasValid, valid, polygon, normalized, normalizedGeo };
}

// A packed binary bbox tree keeps candidate lookup near O(log N + matches), including large parcels.
function buildIndex(items) {
    const build = list => {
        if (list.length <= 12) {
            const box = [Infinity, Infinity, -Infinity, -Infinity];
            for (const item of list) for (let i = 0; i < 4; i++) box[i] = i < 2 ? Math.min(box[i], item.box[i]) : Math.max(box[i], item.box[i]);
            return { box, items: list };
        }
        const box = [Infinity, Infinity, -Infinity, -Infinity];
        for (const item of list) for (let i = 0; i < 4; i++) box[i] = i < 2 ? Math.min(box[i], item.box[i]) : Math.max(box[i], item.box[i]);
        const axis = box[2] - box[0] >= box[3] - box[1] ? 0 : 1;
        list.sort((a, b) => (a.box[axis] + a.box[axis + 2]) - (b.box[axis] + b.box[axis + 2]));
        const middle = list.length >>> 1;
        return { box, left: build(list.slice(0, middle)), right: build(list.slice(middle)) };
    };
    return items.length ? build(items.slice()) : null;
}
function searchIndex(root, box, result = []) {
    if (!root || !overlaps(root.box, box)) return result;
    if (root.items) {
        for (const item of root.items) if (overlaps(item.box, box)) result.push(item);
    } else {
        searchIndex(root.left, box, result);
        searchIndex(root.right, box, result);
    }
    return result;
}

export async function createHmlrBrowserGroundEngine() {
    const geos = await initGeos();
    return Object.freeze({ async intersectsBounds(featuresNative27700, wgsBounds) {
        // Derived ground is a subset of its normalized projected input, so an input that misses
        // the rectangle can never publish ground inside it. Answers align with the input order.
        if (!Array.isArray(featuresNative27700)) throw new TypeError('Expected native HMLR features.');
        if (!Array.isArray(wgsBounds) || wgsBounds.length !== 4 || !wgsBounds.every(Number.isFinite)
            || wgsBounds[0] > wgsBounds[2] || wgsBounds[1] > wgsBounds[3]) throw new TypeError('Expected WGS84 bounds.');
        const [west, south, east, north] = [wgsBounds[0] - BOUNDS_TEST_PAD_DEGREES, wgsBounds[1] - BOUNDS_TEST_PAD_DEGREES,
            wgsBounds[2] + BOUNDS_TEST_PAD_DEGREES, wgsBounds[3] + BOUNDS_TEST_PAD_DEGREES];
        const rectangle = geojsonToGeosGeom({ type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] }, geos);
        if (!rectangle) throw new Error('GEOS failed to create a geometry.');
        try {
            return featuresNative27700.map(feature => {
                const owned = new Set();
                const own = pointer => { if (!pointer) throw new Error('GEOS failed to create a geometry.'); owned.add(pointer); return pointer; };
                try {
                    const id = nativeId(feature);
                    validateNativeGeometry(feature.geometry, id);
                    const raw = own(geojsonToGeosGeom(feature.geometry, geos));
                    const { normalizedGeo } = normalizeNativeInput(geos, own, raw, id);
                    return geos.GEOSIntersects(own(geojsonToGeosGeom(projectGeometry(normalizedGeo), geos)), rectangle) === 1;
                } finally { for (const pointer of owned) geos.GEOSGeom_destroy(pointer); }
            });
        } finally { geos.GEOSGeom_destroy(rectangle); }
    }, async resolve(featuresNative27700, { selectedIds } = {}) {
        if (!Array.isArray(featuresNative27700)) throw new TypeError('Expected the complete native HMLR feature context.');
        const owned = new Set();
        const own = pointer => { if (!pointer) throw new Error('GEOS failed to create a geometry.'); owned.add(pointer); return pointer; };
        const dispose = pointer => { if (pointer && owned.delete(pointer)) geos.GEOSGeom_destroy(pointer); };
        const result = pointer => polygonalResult(geos, pointer);
        const area = pointer => {
            const at = geos.Module._malloc(8);
            try { if (!geos.GEOSArea(pointer, at)) throw new Error('GEOS could not measure HMLR area.'); return geos.Module.getValue(at, 'double'); }
            finally { geos.Module._free(at); }
        };
        const collection = pointers => {
            if (!pointers.length) return null;
            const at = geos.Module._malloc(pointers.length * 4);
            try {
                geos.Module.HEAPU32.set(pointers, at / 4);
                const ptr = geos.GEOSGeom_createCollection(GEOMETRY_COLLECTION, at, pointers.length);
                if (!ptr) throw new Error('GEOS could not create an obstacle collection.');
                for (const child of pointers) owned.delete(child); // GEOS collection owns its members.
                return own(ptr);
            } finally { geos.Module._free(at); }
        };
        try {
            const unique = new Map();
            for (const feature of featuresNative27700) {
                const id = nativeId(feature);
                validateNativeGeometry(feature.geometry, id);
                const originalHash = sha256Hex(JSON.stringify(feature.geometry));
                const raw = own(geojsonToGeosGeom(feature.geometry, geos));
                let valid, polygon, normalized;
                try {
                    const input = normalizeNativeInput(geos, own, raw, id);
                    ({ valid, polygon, normalized } = input);
                    const { wasValid, normalizedGeo } = input;
                    const originalValidAreaM2 = area(polygon);
                    const normalizedAreaM2 = area(normalized);
                    const duplicate = unique.get(id);
                    if (duplicate) {
                        if (geos.GEOSEquals(duplicate.rawPtr, polygon) !== 1) throw new Error(`Conflicting geometry for HMLR native ID ${id}.`);
                        if (originalHash < duplicate.originalGeometrySha256) {
                            duplicate.originalGeometrySha256 = originalHash;
                            duplicate.originalValidAreaM2 = originalValidAreaM2;
                            duplicate.inputRepaired = !wasValid;
                        }
                    } else {
                        const rawPtr = own(geos.GEOSGeom_clone(polygon));
                        const projectedGeometry = projectGeometry(normalizedGeo);
                        const projectedPtr = own(geojsonToGeosGeom(projectedGeometry, geos));
                        if (geos.GEOSisEmpty(projectedPtr) || geos.GEOSisValid(projectedPtr) !== 1) throw new Error(`Projected HMLR input is invalid for ${id}.`);
                        unique.set(id, { id, projectedPtr, projectedGeometry, box: bounds(projectedGeometry),
                            rawPtr, originalGeometrySha256: originalHash, originalValidAreaM2, normalizedAreaM2, inputRepaired: !wasValid });
                    }
                } finally { dispose(normalized); dispose(polygon); dispose(valid); dispose(raw); }
            }
            const ranked = [...unique.values()].sort((a, b) => b.originalValidAreaM2 - a.originalValidAreaM2
                || (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
            for (const item of ranked) { dispose(item.rawPtr); item.rawPtr = null; }
            const rank = new Map(ranked.map((item, index) => [item.id, index]));
            const index = buildIndex(ranked.map(item => ({ id: item.id, box: item.box, item })));
            if (selectedIds !== undefined && (!Array.isArray(selectedIds) || selectedIds.length > 10000
                || selectedIds.some(value => typeof value !== 'string'))) throw new TypeError('selectedIds must contain at most 10000 string IDs.');
            const selected = selectedIds === undefined ? null : new Set(selectedIds.map(value => {
                const text = String(value);
                const native = text.startsWith(HMLR_BROWSER_GROUND_PREFIX) ? text.slice(HMLR_BROWSER_GROUND_PREFIX.length) : text;
                return nativeId({ properties: { INSPIREID: native } });
            }));
            const features = [], suppressedIds = [];
            for (const [position, item] of ranked.entries()) {
                if (selected && !selected.has(item.id)) continue;
                const candidateItems = searchIndex(index, item.box).map(entry => entry.item)
                    .filter(candidate => rank.get(candidate.id) < position && geos.GEOSIntersects(item.projectedPtr, candidate.projectedPtr) === 1)
                    .sort((a, b) => rank.get(a.id) - rank.get(b.id));
                let groundPtr = null, obstacleCollection = null, obstacleUnion = null;
                try {
                    if (candidateItems.length) {
                        obstacleCollection = collection(candidateItems.map(candidate => own(geos.GEOSGeom_clone(candidate.projectedPtr))));
                        obstacleUnion = own(geos.GEOSUnaryUnion(obstacleCollection));
                        groundPtr = own(geos.GEOSDifference(item.projectedPtr, obstacleUnion));
                    } else groundPtr = own(geos.GEOSGeom_clone(item.projectedPtr));
                    if (geos.GEOSisValid(groundPtr) !== 1) throw new Error(`Derived HMLR ground is invalid for ${item.id}.`);
                    const geometry = result(groundPtr);
                    if (!geometry || geos.GEOSisEmpty(groundPtr)) {
                        suppressedIds.push(`${HMLR_BROWSER_GROUND_PREFIX}${item.id}`);
                        continue;
                    }
                    geos.GEOSNormalize(groundPtr);
                    const normalizedOutput = result(groundPtr);
                    const nativeOutputPtr = own(geojsonToGeosGeom(unprojectGeometry(normalizedOutput), geos));
                    let groundAreaM2;
                    try { groundAreaM2 = area(nativeOutputPtr); } finally { dispose(nativeOutputPtr); }
                    const feature = canonicalParcelFeature(descriptor, { geometry: normalizedOutput, properties: { INSPIREID: item.id } }, item.id);
                    feature.properties.geometryKind = 'derived-ground';
                    feature.properties.derivation = { policy: HMLR_BROWSER_GROUND_POLICY,
                        originalGeometrySha256: item.originalGeometrySha256,
                        groundGeometrySha256: sha256Hex(JSON.stringify(normalizedOutput)),
                        publishedGeometrySha256: sha256Hex(JSON.stringify(normalizedOutput)),
                        originalValidAreaM2: item.originalValidAreaM2, normalizedInputAreaM2: item.normalizedAreaM2,
                        groundAreaM2, inputRepaired: item.inputRepaired,
                        intersectingHigherPriorityCount: candidateItems.length };
                    if (!selected || selected.has(item.id)) features.push(feature);
                } finally { dispose(groundPtr); dispose(obstacleUnion); dispose(obstacleCollection); }
            }
            return { type: 'FeatureCollection', complete: true, sourceId: HMLR_BROWSER_GROUND_SOURCE,
                normalizationPolicy: HMLR_BROWSER_GROUND_POLICY, returnsWGS84: true, features, suppressedIds };
        } finally { for (const pointer of owned) geos.GEOSGeom_destroy(pointer); owned.clear(); }
    } });
}
