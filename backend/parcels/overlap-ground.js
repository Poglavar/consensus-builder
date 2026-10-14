// Resolves overlapping outlines of one parcel layer into disjoint ground by a fixed precedence.
// Indian village maps were georeferenced one village at a time, so plots overlap at village seams
// (and sometimes inside a village). Each overlap goes to the larger outline; equal areas go to the
// lower ID. A parcel's ground is its outline minus every higher-ranked outline that overlaps it, so
// it depends only on that parcel and its direct neighbours, never on which view asked for it.
import { area, bbox as geometryBbox, booleanIntersects, difference, feature as geoFeature, intersect } from '@turf/turf';
import { upstreamError, validateGeometry } from './source-contract.js';
import { HttpError } from '../utils/helpers.js';

export const OVERLAP_GROUND_POLICY = 'overlap-ground-v1-area-desc-id-asc-turf6';
const KM_PER_DEGREE = 111.32;
// About 150 m: most plots that cross a view's edge end within it.
const CONTEXT_MARGIN_DEGREES = 0.0015;

const ranked = (a, b) => b.areaM2 - a.areaM2 || (a.feature.id < b.feature.id ? -1 : a.feature.id > b.feature.id ? 1 : 0);
const boxesTouch = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

function extent(features) {
    const out = [Infinity, Infinity, -Infinity, -Infinity];
    for (const feature of features) {
        const box = geometryBbox(feature);
        out[0] = Math.min(out[0], box[0]); out[1] = Math.min(out[1], box[1]);
        out[2] = Math.max(out[2], box[2]); out[3] = Math.max(out[3], box[3]);
    }
    return out;
}

const rectangle = box => ({ type: 'Polygon',
    coordinates: [[[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]], [box[0], box[1]]]] });
const pad = (box, margin) => [box[0] - margin, box[1] - margin, box[2] + margin, box[3] + margin];
const areaKm2 = box => (box[2] - box[0]) * KM_PER_DEGREE * Math.cos((box[1] + box[3]) / 2 * Math.PI / 180) * (box[3] - box[1]) * KM_PER_DEGREE;
const withinLimit = (box, maxBboxKm2) => areaKm2(box) <= maxBboxKm2;

// The parts of `box` outside `cut`, as up to four rectangles.
export function subtractBox(box, cut) {
    if (cut[0] >= box[2] || cut[2] <= box[0] || cut[1] >= box[3] || cut[3] <= box[1]) return [box];
    const out = [];
    if (box[0] < cut[0]) out.push([box[0], box[1], cut[0], box[3]]);
    if (box[2] > cut[2]) out.push([cut[2], box[1], box[2], box[3]]);
    const west = Math.max(box[0], cut[0]), east = Math.min(box[2], cut[2]);
    if (box[1] < cut[1]) out.push([west, box[1], east, cut[1]]);
    if (box[3] > cut[3]) out.push([west, cut[3], east, box[3]]);
    return out;
}

// Splits a rectangle into equal tiles each no larger than the provider's bounds limit.
export function tileBounds(box, maxBboxKm2) {
    const midLat = (box[1] + box[3]) / 2;
    const widthKm = (box[2] - box[0]) * KM_PER_DEGREE * Math.cos(midLat * Math.PI / 180);
    const heightKm = (box[3] - box[1]) * KM_PER_DEGREE;
    const limit = maxBboxKm2 * 0.9;
    const columns = Math.max(1, Math.ceil(widthKm / Math.sqrt(limit)));
    const rows = Math.max(1, Math.ceil(heightKm / Math.sqrt(limit)));
    const tiles = [];
    for (let x = 0; x < columns; x++) for (let y = 0; y < rows; y++) {
        tiles.push([box[0] + (box[2] - box[0]) * x / columns, box[1] + (box[3] - box[1]) * y / rows,
            x === columns - 1 ? box[2] : box[0] + (box[2] - box[0]) * (x + 1) / columns,
            y === rows - 1 ? box[3] : box[1] + (box[3] - box[1]) * (y + 1) / rows]);
    }
    return tiles;
}

// Pure resolution: `targets` get ground computed against everything in `context` (targets included).
export function resolveOverlapGround(targets, context) {
    const byId = new Map();
    for (const feature of [...context, ...targets]) if (!byId.has(feature.id)) byId.set(feature.id, feature);
    const entries = [...byId.values()].map(feature => ({ feature, areaM2: area(feature), box: geometryBbox(feature) })).sort(ranked);
    const rank = new Map(entries.map((entry, index) => [entry.feature.id, index]));
    const features = [], suppressedIds = [];
    for (const target of targets) {
        const own = entries[rank.get(target.id)];
        const higher = entries.slice(0, rank.get(target.id)).filter(entry => boxesTouch(entry.box, own.box)
            && booleanIntersects(entry.feature, own.feature));
        let ground = geoFeature(own.feature.geometry);
        const cutBy = [];
        try {
            for (const entry of higher) {
                const overlap = intersect(ground, entry.feature);
                if (!overlap || !(area(overlap) > 0)) continue;
                cutBy.push(entry.feature.id);
                ground = difference(ground, entry.feature);
                if (!ground) break;
            }
        } catch (error) {
            throw upstreamError(`Parcel overlap resolution failed for ${target.id}: ${error.message}`);
        }
        if (!cutBy.length) { features.push(target); continue; }
        if (!ground || !(area(ground) > 0)) { suppressedIds.push(target.id); continue; }
        features.push({ ...target, geometry: ground.geometry, properties: { ...target.properties, geometryKind: 'derived-ground',
            derivation: { policy: OVERLAP_GROUND_POLICY, outlineAreaM2: own.areaM2, groundAreaM2: area(ground), cutByIds: cutBy } } });
    }
    return { features, suppressedIds };
}

// Wraps a provider adapter: each read also fetches every outline that touches the returned
// outlines' extent, so each parcel's higher-ranked neighbours are known before it is cut.
export function withOverlapGround(adapter, { maxBboxKm2 }) {
    async function context(features) {
        if (!features.length) return [];
        // Overlapping envelopes are read together; distant parcels (an ID read) get their own reads.
        const groups = features.map(feature => geometryBbox(feature));
        for (let merged = true; merged;) {
            merged = false;
            for (let i = 0; i < groups.length && !merged; i++) for (let j = i + 1; j < groups.length; j++) {
                if (!boxesTouch(groups[i], groups[j])) continue;
                groups[i] = [Math.min(groups[i][0], groups[j][0]), Math.min(groups[i][1], groups[j][1]),
                    Math.max(groups[i][2], groups[j][2]), Math.max(groups[i][3], groups[j][3])];
                groups.splice(j, 1); merged = true; break;
            }
        }
        const rows = [];
        for (const group of groups) for (const tile of tileBounds(group, maxBboxKm2)) {
            const result = await adapter.queryBounds(tile);
            if (result.complete === false) throw upstreamError('Parcel provider returned incomplete overlap context.');
            rows.push(...result.features);
        }
        return rows;
    }
    async function queryBounds(bounds) {
        // One padded read usually carries every neighbour of the parcels in view, so resolving
        // overlaps costs no extra request; only outlines reaching past the margin need another read.
        const padded = withinLimit(pad(bounds, CONTEXT_MARGIN_DEGREES), maxBboxKm2) ? pad(bounds, CONTEXT_MARGIN_DEGREES) : bounds;
        const wide = await adapter.queryBounds(padded);
        const view = geoFeature(rectangle(bounds));
        const features = padded === bounds ? wide.features : wide.features.filter(feature => booleanIntersects(feature, view));
        if (!features.length) return { ...wide, features };
        // Every neighbour that can overlap a returned outline intersects that outline's envelope.
        const missing = subtractBox(extent(features), padded);
        const around = [...wide.features];
        for (const box of missing) for (const tile of tileBounds(box, maxBboxKm2)) {
            const result = await adapter.queryBounds(tile);
            if (result.complete === false) throw upstreamError('Parcel provider returned incomplete overlap context.');
            around.push(...result.features);
        }
        const resolved = resolveOverlapGround(features, around);
        return { ...wide, features: resolved.features, suppressedIds: resolved.suppressedIds, overlapPolicy: OVERLAP_GROUND_POLICY };
    }
    async function queryIds(ids) {
        const result = await adapter.queryIds(ids);
        const resolved = resolveOverlapGround(result.features, await context(result.features));
        // An outline wholly covered by higher-ranked neighbours has no ground of its own.
        return { ...result, features: resolved.features, suppressedIds: resolved.suppressedIds,
            absentIds: [...(result.absentIds || []), ...resolved.suppressedIds], overlapPolicy: OVERLAP_GROUND_POLICY };
    }
    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a valid WGS84 Polygon or MultiPolygon.');
        const footprint = geoFeature(geometry);
        const result = await queryBounds(geometryBbox(footprint));
        return { ...result, features: result.features.filter(parcel => booleanIntersects(parcel, footprint)) };
    }
    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}
