// Complete, revision-pinned public Shapefile archives support local exact and spatial queries.
import { bbox, bboxPolygon, booleanIntersects, feature as geoFeature } from '@turf/turf';
import { concatBytes } from './byte-utils.js';
import { HttpError } from '../utils/helpers.js';
import { canonicalParcelFeature, upstreamError, providerHttpError, validateBounds, validateGeometry } from './source-contract.js';
import { decodeSnapshotNativeId, encodeSnapshotNativeId } from './geojson-snapshot-source.js';
import { sha256Hex } from './portable-hash.js';
import { SHAPEFILE_CRS, readShapefileZipMembers, indexShapefileSnapshot } from './shapefile-zip-reader.js';

const caches = new WeakMap();
let retainedState = null, coldLoadTail = Promise.resolve();
const defaults = { maxSnapshotBytes: 80 * 1024 * 1024, maxDecompressedBytes: 256 * 1024 * 1024,
    maxSnapshotFeatures: 600000, maxFeatures: 10000, maxRecordPoints: 1000000, maxSnapshotPoints: 15000000,
    zipEncoding: 'utf-8', dbfEncoding: 'utf-8', snapshotScope: 'archive' };

export function createShapefileSnapshotParcelSource(input, { fetchImpl = fetch, now = Date.now } = {}) {
    const descriptor = { ...defaults, ...input }, { id, idPrefix, idFields, outFields, shapefileMembers } = descriptor;
    let url; try { url = new URL(descriptor.endpoint); } catch { /* Validated below. */ }
    const members = shapefileMembers && Object.entries(shapefileMembers);
    const required = ['shp', 'shx', 'dbf', 'prj'];
    const caps = { maxSnapshotBytes: 80 * 1024 * 1024, maxDecompressedBytes: 512 * 1024 * 1024,
        maxSnapshotFeatures: 600000, maxFeatures: 10000, maxRecordPoints: 1000000, maxSnapshotPoints: 30000000 };
    const field = /^[A-Za-z_][A-Za-z0-9_]*$/;
    const sensitive = /owner|address|account|tax|propriet|titular|shoy|氏名|住所/i;
    if (!id || !idPrefix || url?.protocol !== 'https:' || url.username || url.password
        || typeof fetchImpl !== 'function' || typeof now !== 'function' || !Object.hasOwn(SHAPEFILE_CRS, descriptor.sourceCrs)
        || !Array.isArray(idFields) || !idFields.length || idFields.length > 8 || new Set(idFields).size !== idFields.length
        || idFields.some(name => typeof name !== 'string' || !field.test(name) || sensitive.test(name))
        || !Array.isArray(outFields) || new Set(outFields).size !== outFields.length
        || outFields.length !== idFields.length || outFields.some(name => !idFields.includes(name))
        || (descriptor.idField !== undefined && !idFields.includes(descriptor.idField))
        || ![undefined, 'integer', 'string'].includes(descriptor.idType)
        || !members || !required.every(kind => typeof shapefileMembers[kind] === 'string')
        || members.some(([kind, name]) => ![...required, 'cpg'].includes(kind) || typeof name !== 'string'
            || !name.endsWith(`.${kind}`) || name.length > 1024 || /[\\\x00-\x1f]/.test(name)
            || name.startsWith('/') || name.includes(':') || name.split('/').some(part => ['..', '.', ''].includes(part)))
        || new Set(members.map(([kind, name]) => name.slice(0, -kind.length - 1))).size !== 1
        || (descriptor.sourceLayer && shapefileMembers.shp.split('/').at(-1) !== `${descriptor.sourceLayer}.shp`)
        || !/^[a-f0-9]{64}$/.test(descriptor.expectedSnapshotSha256 || '')
        || !Number.isSafeInteger(descriptor.expectedSnapshotFeatures) || descriptor.expectedSnapshotFeatures < 0
        || descriptor.expectedSnapshotFeatures > descriptor.maxSnapshotFeatures || descriptor.snapshotScope !== 'archive'
        || Object.entries(caps).some(([key, cap]) => !Number.isSafeInteger(descriptor[key]) || descriptor[key] < 1 || descriptor[key] > cap)
        || !['utf-8', 'shift_jis', 'windows-1252'].includes(descriptor.zipEncoding)
        || !['utf-8', 'shift_jis', 'windows-1252'].includes(descriptor.dbfEncoding)
        || (descriptor.bbox !== undefined && (!Array.isArray(descriptor.bbox) || descriptor.bbox.length !== 4
            || !descriptor.bbox.every(Number.isFinite) || descriptor.bbox[0] < -180 || descriptor.bbox[2] > 180
            || descriptor.bbox[1] < -90 || descriptor.bbox[3] > 90 || descriptor.bbox[0] >= descriptor.bbox[2] || descriptor.bbox[1] >= descriptor.bbox[3]))) {
        throw new Error('Invalid verified Shapefile snapshot descriptor.');
    }
    let entries = caches.get(fetchImpl); if (!entries) { entries = new Map(); caches.set(fetchImpl, entries); }
    const key = JSON.stringify(descriptor); let state = entries.get(key);
    if (!state) { state = { index: null, expires: 0, pending: null }; entries.set(key, state); }
    async function load() {
        const signal = AbortSignal.timeout(60000); let reader, response;
        try {
            if (retainedState && retainedState !== state) { retainedState.index = null; retainedState.expires = 0; }
            retainedState = state; state.index = null;
            response = await fetchImpl(url.href, { signal, headers: { Accept: 'application/zip' } });
            if (response.status !== 200 || !response.ok) throw providerHttpError(response);
            if (response.url && new URL(response.url).protocol !== 'https:') throw upstreamError('Parcel archive redirected outside HTTPS.');
            const declared = response.headers.get('content-length');
            if (declared && (!/^\d+$/.test(declared) || Number(declared) > descriptor.maxSnapshotBytes)) throw upstreamError('Parcel archive exceeds byte limit.');
            reader = response.body?.getReader(); if (!reader) throw upstreamError('Parcel archive returned no readable body.');
            const chunks = []; let length = 0;
            for (;;) {
                if (signal.aborted) throw upstreamError('Parcel archive timed out.', 504);
                const part = await reader.read(); if (part.done) break;
                length += part.value.length; if (length > descriptor.maxSnapshotBytes) throw upstreamError('Parcel archive exceeds byte limit.');
                chunks.push(part.value);
            }
            if (declared && !response.headers.get('content-encoding') && Number(declared) !== length) throw upstreamError('Parcel archive content length disagrees.');
            let bytes = concatBytes(chunks, length); chunks.length = 0;
            if (sha256Hex(bytes) !== descriptor.expectedSnapshotSha256) throw upstreamError('Parcel archive revision differs from its verified release.');
            const members = readShapefileZipMembers(bytes, descriptor); bytes = null;
            const index = await indexShapefileSnapshot(members, descriptor, signal);
            state.index = index; state.expires = now() + 300000; return index;
        } catch (error) {
            if (reader) await reader.cancel().catch(() => {});
            else await response?.body?.cancel().catch(() => {});
            if (error.status) throw error;
            if (signal.aborted || ['AbortError', 'TimeoutError'].includes(error.name)) throw upstreamError('Parcel archive timed out.', 504);
            throw upstreamError('Parcel Shapefile archive is malformed or unavailable.');
        } finally { reader?.releaseLock(); }
    }
    async function snapshot() {
        if (state.index && now() < state.expires) return state.index;
        if (!state.pending) {
            state.pending = coldLoadTail.then(load).finally(() => { state.pending = null; });
            coldLoadTail = state.pending.then(() => undefined, () => undefined);
        }
        return state.pending;
    }
    function canonical(index, row) {
        const feature = index.feature(row);
        return canonicalParcelFeature(descriptor, feature, encodeSnapshotNativeId(idFields.map(field => feature.properties[field])));
    }
    function collection(features, extra = {}) {
        if (features.length > descriptor.maxFeatures) throw upstreamError('Parcel snapshot query exceeds feature limit.');
        return { type: 'FeatureCollection', features, complete: true, sourceId: id, returnsWGS84: true, ...extra };
    }
    async function intersect(geometry, bounds) {
        const index = await snapshot(), target = geoFeature(geometry), features = [];
        try {
            for (let i = 0; i < index.count; i++) {
                const start = i * 4, extent = index.extents;
                if (extent[start] > bounds[2] || extent[start + 2] < bounds[0] || extent[start + 1] > bounds[3] || extent[start + 3] < bounds[1]) continue;
                const feature = canonical(index, i);
                if (booleanIntersects(feature, target)) features.push(feature);
                if (features.length > descriptor.maxFeatures) throw upstreamError('Parcel snapshot query exceeds feature limit.');
            }
        } catch (error) { if (error.status) throw error; throw upstreamError('Parcel snapshot intersection failed.'); }
        return collection(features);
    }
    function queryBounds(bounds) {
        validateBounds(bounds, descriptor.maxBboxKm2 ?? 25, descriptor);
        return intersect(bboxPolygon(bounds).geometry, bounds);
    }
    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 parcel IDs.');
        const unique = [...new Set(ids)];
        const natives = unique.map(value => {
            if (typeof value !== 'string' || !value.startsWith(idPrefix)) throw new HttpError(400, 'Parcel ID belongs to a different source.');
            const native = value.slice(idPrefix.length), parts = decodeSnapshotNativeId(native, idFields.length);
            if (descriptor.idType === 'integer' && parts.some(part => !/^(0|[1-9]\d*)$/.test(part) || !Number.isSafeInteger(Number(part)))) throw new HttpError(400, 'Invalid integer parcel ID.');
            return native;
        });
        const index = await snapshot(), features = [], absentIds = [];
        natives.forEach((native, i) => { if (index.byId.has(native)) features.push(canonical(index, index.byId.get(native))); else absentIds.push(unique[i]); });
        return collection(features, { absentIds });
    }
    function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide valid WGS84 polygon geometry.');
        const bounds = bbox(geoFeature(geometry)); validateBounds(bounds, descriptor.maxBboxKm2 ?? 25, descriptor);
        return intersect(geometry, bounds);
    }
    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}
