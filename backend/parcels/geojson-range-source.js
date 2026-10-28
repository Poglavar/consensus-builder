// Read pinned public GeoJSON in capped HTTP ranges; retain only safe geometry and derived IDs.
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { bbox as geometryBbox, bboxPolygon, booleanIntersects } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { sha256Hex } from './portable-hash.js';
import { readGeojsonFeatureStream } from './geojson-stream-reader.js';
import { canonicalParcelFeature, validateGeometry, validateBounds, upstreamError, providerHttpError } from './source-contract.js';

export function geometryHashReference(geometry) {
    return sha256Hex(JSON.stringify({ type: geometry.type, coordinates: geometry.coordinates }));
}

export function createGeojsonRangeParcelSource(input, { fetchImpl = fetch, now = Date.now } = {}) {
    const d = structuredClone(input), url = new URL(d.endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || !d.id || !d.idPrefix
        || d.idPrefix !== `${d.id}/geometry-sha256-v1/` || !Array.isArray(d.outFields) || d.outFields.length
        || !/^"[^"\r\n]+"$/.test(d.expectedEtag || '') || !/^[a-f0-9]{64}$/.test(d.expectedSnapshotSha256 || '')
        || typeof d.expectedCollectionName !== 'string' || !d.expectedCollectionName
        || !Number.isSafeInteger(d.expectedSnapshotBytes) || d.expectedSnapshotBytes < 1 || d.expectedSnapshotBytes > 64 * 1024 ** 2
        || !Number.isSafeInteger(d.expectedSnapshotFeatures) || d.expectedSnapshotFeatures < 1 || d.expectedSnapshotFeatures > 100000
        || !Number.isSafeInteger(d.rangeBytes) || d.rangeBytes < 1024 || d.rangeBytes > 16 * 1024 ** 2
        || !Number.isSafeInteger(d.maxFeatures) || d.maxFeatures < 1 || d.maxFeatures > 10000) {
        throw new Error('Invalid range GeoJSON descriptor.');
    }
    let index = null, expires = 0, pending = null;
    const done = Symbol('all requested exact geometries found');
    const fail = message => upstreamError(message, 502, 'parcel-range-invalid');
    function validateIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80 || ids.some(id => typeof id !== 'string'
            || !id.startsWith(d.idPrefix) || !/^[a-f0-9]{64}$/.test(id.slice(d.idPrefix.length)))) {
            throw new HttpError(400, 'Provide 1–80 geometry-hash IDs from this source.');
        }
        return [...new Set(ids)];
    }
    function envelope(metadata) {
        if (metadata.type !== 'FeatureCollection' || metadata.name !== d.expectedCollectionName
            || metadata.crs?.type !== 'name' || metadata.crs.properties?.name !== 'urn:ogc:def:crs:OGC::CRS84') {
            throw fail('Range source envelope differs from its verified release.');
        }
    }
    async function scan(ids = null) {
        const wanted = ids && new Set(ids), found = new Map(), hash = sha256.create();
        const signal = AbortSignal.timeout(45000);
        let actualBytes = 0, count = 0;
        async function* chunks() {
            for (let start = 0; start < d.expectedSnapshotBytes; start += d.rangeBytes) {
                const end = Math.min(start + d.rangeBytes, d.expectedSnapshotBytes) - 1;
                const response = await fetchImpl(d.endpoint, { signal, headers: {
                    Accept: 'application/geo+json, application/json', Range: `bytes=${start}-${end}`, 'If-Match': d.expectedEtag
                } });
                let reader;
                try {
                    if (response.status !== 206) throw providerHttpError(response);
                    if (response.headers.get('etag') !== d.expectedEtag
                        || response.headers.get('content-range') !== `bytes ${start}-${end}/${d.expectedSnapshotBytes}`
                        || response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity'
                        || response.headers.has('content-length') && response.headers.get('content-length') !== String(end - start + 1)) {
                        throw fail('Range response has inconsistent revision, encoding or byte positions.');
                    }
                    if (!response.body?.getReader) throw fail('Range source has no readable body.');
                    reader = response.body.getReader();
                    let rangeBytes = 0;
                    for (;;) {
                        const part = await reader.read(); if (part.done) break;
                        rangeBytes += part.value.byteLength; actualBytes += part.value.byteLength;
                        if (rangeBytes > end - start + 1 || rangeBytes > 16 * 1024 ** 2 || actualBytes > d.expectedSnapshotBytes) {
                            throw fail('Range source exceeded its actual byte budget.');
                        }
                        hash.update(part.value); yield part.value;
                    }
                    if (rangeBytes !== end - start + 1) throw fail('Range source returned a truncated body.');
                } finally {
                    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
                    else await response.body?.cancel().catch(() => {});
                }
            }
        }
        let complete = false;
        try {
            const result = await readGeojsonFeatureStream(chunks(), { maxRecordBytes: 256 * 1024,
                onFeature(feature, _number, metadata) {
                    envelope(metadata);
                    if (++count > d.expectedSnapshotFeatures || feature?.type !== 'Feature' || !validateGeometry(feature.geometry)
                        || (feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates)
                            .some(polygon => polygon.some(ring => ring.some(point => !point.every(value => typeof value === 'number' && Number.isFinite(value)))))
                        || Object.keys(feature.geometry).some(key => !['type', 'coordinates'].includes(key))) {
                        throw fail('Range source returned malformed polygon geometry or excess features.');
                    }
                    const nativeId = geometryHashReference(feature.geometry), id = d.idPrefix + nativeId;
                    if (!wanted || wanted.has(id)) {
                        const canonical = canonicalParcelFeature(d, { geometry: feature.geometry, properties: {} }, nativeId);
                        found.set(id, { feature: canonical, bbox: geometryBbox(canonical) });
                    }
                    if (wanted && found.size === wanted.size) throw done;
                } });
            envelope(result.metadata);
            if (count !== d.expectedSnapshotFeatures || actualBytes !== d.expectedSnapshotBytes
                || bytesToHex(hash.digest()) !== d.expectedSnapshotSha256) throw fail('Range snapshot count or SHA-256 differs from its verified release.');
            complete = true;
        } catch (error) { if (error !== done) throw error; }
        return { found, complete, actualBytes, count };
    }
    function result(features, extra = {}) {
        if (features.length > d.maxFeatures) throw fail('Range parcel query exceeds feature limit.');
        return { type: 'FeatureCollection', features: structuredClone(features), complete: true, sourceId: d.id,
            returnsWGS84: true, ...extra };
    }
    async function snapshot() {
        if (index && now() < expires) return index;
        if (!pending) pending = scan().then(data => {
            index = data.found; expires = now() + 300000; return index;
        }).finally(() => { pending = null; });
        return pending;
    }
    async function queryIds(ids) {
        const unique = validateIds(ids);
        const data = pending ? await pending : index && now() < expires ? index : (await scan(unique)).found;
        return result(unique.filter(id => data.has(id)).map(id => data.get(id).feature), {
            absentIds: unique.filter(id => !data.has(id)) });
    }
    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a valid WGS84 polygon.');
        const bounds = geometryBbox(geometry); validateBounds(bounds, d.maxBboxKm2 || 25, d);
        const data = await snapshot();
        return result([...data.values()].filter(item => item.bbox[0] <= bounds[2] && item.bbox[2] >= bounds[0]
            && item.bbox[1] <= bounds[3] && item.bbox[3] >= bounds[1]
            && booleanIntersects(item.feature.geometry, geometry)).map(item => item.feature));
    }
    function queryBounds(bounds) {
        validateBounds(bounds, d.maxBboxKm2 || 25, d);
        return queryGeometry(bboxPolygon(bounds).geometry);
    }
    return Object.freeze({ queryIds, queryBounds, queryGeometry });
}

// The fixed-source relay runs the same range reader, so browsers need no private-data snapshot.
export function createGeojsonRangeBrowserSource(d, { fetchImpl = fetch } = {}) {
    const query = operation => async (input, { signal } = {}) => {
        signal?.throwIfAborted();
        const response = await fetchImpl(d.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            signal,
            body: JSON.stringify({ _geojsonRangeOperation: operation, input }) });
        if (!response.ok) throw providerHttpError(response);
        const reader = response.body.getReader(), chunks = []; let size = 0;
        try {
            for (;;) {
                const part = await reader.read(); if (part.done) break;
                size += part.value.byteLength;
                if (size > 16 * 1024 ** 2) throw upstreamError('Range query exceeds browser byte budget.');
                chunks.push(part.value);
            }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const data = JSON.parse(await new Blob(chunks).text());
        if (data.type !== 'FeatureCollection' || data.complete !== true || data.sourceId !== d.id
            || !Array.isArray(data.features) || data.features.length > d.maxFeatures) throw upstreamError('Invalid range parcel relay result.');
        return data;
    };
    return Object.freeze(Object.fromEntries(['queryIds', 'queryBounds', 'queryGeometry'].map(name => [name, query(name)])));
}
