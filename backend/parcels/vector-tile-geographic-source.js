// Whole source polygons on the geographic 2^z by 2^(z-1) tile matrix. Tile/hash
// references permit fresh exact reads without trusting tile-local feature IDs.
import { VectorTile, classifyRings } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { bbox, bboxPolygon, booleanIntersects, feature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';
import { GEOMETRY_IDENTITY_KIND } from './geometry-identity.js';
import { sha256Hex } from './portable-hash.js';
import { concatBytes } from './byte-utils.js';

async function readBytes(response) {
    const reader = response.body?.getReader();
    if (!reader) throw upstreamError('Geographic parcel tile has no readable body.');
    const chunks = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 16 * 1024 * 1024) throw upstreamError('Geographic parcel tile exceeds the byte limit.');
            chunks.push(value);
        }
    } finally { await reader.cancel(); reader.releaseLock(); }
    return concatBytes(chunks, size);
}

const contains = (outer, inner) => inner[0] >= outer[0] && inner[1] >= outer[1]
    && inner[2] <= outer[2] && inner[3] <= outer[3];

export function createGeographicInteriorTileSource(d, { fetchImpl = globalThis.fetch } = {}) {
    const { zoom, extent = 4096, maxTiles = 9, maxFeatures = 4000, maxBboxKm2 = 4 } = d;
    let url;
    try { url = new URL(d.endpoint); } catch { /* Validated below. */ }
    if (!d.id || !d.idPrefix || !url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
        || !['{z}', '{x}', '{y}'].every(token => d.endpoint.includes(token))
        || d.tileMatrix !== 'geographic-2x1' || d.geometryMode !== 'interior-only'
        || d.identityKind !== GEOMETRY_IDENTITY_KIND || d.outFields?.length !== 0 || d.overlapResolution !== undefined
        || !Number.isSafeInteger(zoom) || zoom < 10 || zoom > 18 || extent !== 4096
        || typeof d.layer !== 'string' || !d.layer.length
        || !Number.isSafeInteger(maxTiles) || maxTiles < 1 || maxTiles > 64
        || !Number.isSafeInteger(maxFeatures) || maxFeatures < 1 || maxFeatures > 10000
        || !Number.isFinite(maxBboxKm2) || maxBboxKm2 <= 0 || maxBboxKm2 > 9
        || typeof fetchImpl !== 'function') throw new Error('Invalid geographic interior tile descriptor.');
    validateBounds(d.idLookupBounds, 100);
    const count = 2 ** zoom, degrees = 360 / count;
    const tileAt = ([lon, lat]) => [Math.floor((lon + 180) / degrees), Math.floor((90 - lat) / degrees)];
    const [west, north] = tileAt([d.idLookupBounds[0], d.idLookupBounds[3] - 1e-10]);
    const [east, south] = tileAt([d.idLookupBounds[2] - 1e-10, d.idLookupBounds[1] + 1e-10]);
    if ((east - west + 1) * (south - north + 1) > maxTiles) throw new Error('Geographic lookup window exceeds its tile budget.');
    const tiles = new Map();
    const collection = (features, extra = {}) => ({ type: 'FeatureCollection', features, sourceId: d.id,
        returnsWGS84: true, complete: true, citywideComplete: false, coverage: 'whole-interior-polygons-only', ...extra });

    async function download(x, y) {
        let response;
        try { response = await fetchImpl(d.endpoint.replace('{z}', zoom).replace('{x}', x).replace('{y}', y),
            { signal: AbortSignal.timeout(20000) }); }
        catch { throw upstreamError('Geographic parcel tile service is unavailable.'); }
        if (response.status === 204 || response.status === 404) return { features: [], excludedFragments: 0 };
        if (!response.ok) throw providerHttpError(response);
        const bytes = await readBytes(response);
        if (!bytes.length) return { features: [], excludedFragments: 0 };
        let layer;
        try { layer = new VectorTile(new PbfReader(bytes)).layers[d.layer]; }
        catch { throw upstreamError('Geographic parcel tile could not be decoded.'); }
        if (!layer) throw upstreamError('Geographic parcel layer is missing.');
        if (layer.extent !== extent || layer.length > 50000) throw upstreamError('Geographic parcel layer contract changed.');
        const byId = new Map();
        let excludedFragments = 0;
        for (let i = 0; i < layer.length; i++) {
            const row = layer.feature(i);
            if (row.type !== 3) continue;
            // Never copy attributes (including location text or unproven mvt_id).
            const rings = row.loadGeometry();
            if (rings.some(ring => ring.some(p => p.x <= 0 || p.y <= 0 || p.x >= extent || p.y >= extent))) {
                excludedFragments++; continue;
            }
            const polygons = classifyRings(rings).map(polygon => polygon.map(ring => ring.map(p =>
                [-180 + (x + p.x / extent) * degrees, 90 - (y + p.y / extent) * degrees])));
            const geometry = polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] }
                : { type: 'MultiPolygon', coordinates: polygons };
            if (!validateGeometry(geometry)) throw upstreamError('Geographic parcel polygon is invalid.');
            if (!contains(d.idLookupBounds, bbox(feature(geometry)))) continue;
            // Ring order, geometry type and every unrounded converted vertex participate.
            const hash = sha256Hex(`${d.id}\ngeographic-interior-v1\n${zoom}/${x}/${y}\n${JSON.stringify(geometry)}`);
            const parcelId = `${d.idPrefix}t1~${zoom}~${x}~${y}~${hash}`;
            const parcel = { type: 'Feature', id: parcelId, geometry, properties: {
                id: parcelId, parcelId, sourceId: d.id, sourceParcelId: null, parcelNumber: null,
                parcelIdentityKind: GEOMETRY_IDENTITY_KIND, sourceGeometryHash: hash,
                geometryDisplayId: `G1-${hash.slice(0, 12)}`, cadMunicipalityName: null,
                ownershipType: 'unknown', sourceProperties: {}
            } };
            const previous = byId.get(parcelId);
            if (previous && JSON.stringify(previous.geometry) !== JSON.stringify(geometry)) throw upstreamError('Geographic parcel hash collision.');
            byId.set(parcelId, parcel);
            if (byId.size > maxFeatures) throw upstreamError('Geographic parcel tile exceeds its feature budget.');
        }
        return { features: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)), excludedFragments };
    }
    function tile(x, y) {
        const key = `${x}/${y}`;
        if (!tiles.has(key)) {
            const pending = download(x, y);
            pending.catch(() => tiles.delete(key));
            tiles.set(key, pending);
        }
        return tiles.get(key);
    }
    function parseId(id) {
        const parts = typeof id === 'string' && id.startsWith(d.idPrefix) ? id.slice(d.idPrefix.length).split('~') : [];
        if (parts.length !== 5 || parts[0] !== 't1' || parts[1] !== String(zoom)
            || !/^(0|[1-9][0-9]*)$/.test(parts[2]) || !/^(0|[1-9][0-9]*)$/.test(parts[3]) || !/^[0-9a-f]{64}$/.test(parts[4])) {
            throw new HttpError(400, 'Invalid geographic geometry-derived parcel reference.');
        }
        const x = Number(parts[2]), y = Number(parts[3]);
        if (x < west || x > east || y < north || y > south || x >= count || y >= count / 2) {
            throw new HttpError(400, 'Parcel reference is outside the configured geographic window.');
        }
        return { x, y };
    }
    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide 1–80 parcel references.');
        const wanted = [...new Set(ids)], locations = wanted.map(parseId), features = [];
        for (let i = 0; i < wanted.length; i++) {
            const { x, y } = locations[i], result = await tile(x, y);
            const parcel = result.features.find(f => f.id === wanted[i]);
            // A changed outline or a tile fragment is unresolved, never authoritative absence.
            if (!parcel) throw upstreamError('Parcel reference is unresolved in the current geographic tile.');
            features.push(parcel);
        }
        return collection(features, { absentIds: [] });
    }
    async function queryBounds(bounds) {
        validateBounds(bounds, maxBboxKm2);
        const view = bboxPolygon(bounds), features = [];
        let excludedTileFragments = 0;
        for (let x = west; x <= east; x++) for (let y = north; y <= south; y++) {
            const result = await tile(x, y);
            features.push(...result.features.filter(parcel => booleanIntersects(parcel, view)));
            excludedTileFragments += result.excludedFragments;
        }
        if (features.length > maxFeatures) throw upstreamError('Geographic parcel query exceeds its feature budget.');
        return collection(features, { complete: contains(d.idLookupBounds, bounds), excludedTileFragments });
    }
    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a valid geographic polygon.');
        const result = await queryBounds(bbox(feature(geometry)));
        return { ...result, features: result.features.filter(parcel => booleanIntersects(parcel, feature(geometry))) };
    }
    return Object.freeze({ queryIds, queryBounds, queryGeometry });
}
