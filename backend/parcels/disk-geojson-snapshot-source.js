// Complete immutable snapshots: bounded streaming parse, safe disk records and a bounded identity/extent index.
import fs from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { bbox, bboxPolygon, booleanIntersects, feature as geoFeature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';
import { encodeSnapshotNativeId, decodeSnapshotNativeId } from './geojson-snapshot-source.js';
import { readGeojsonFeatureStream } from './geojson-stream-reader.js';

const caps = { maxSnapshotBytes: 512 * 1024 ** 2, maxDiskBytes: 512 * 1024 ** 2,
    maxMemoryBytes: 512 * 1024 ** 2, maxIndexBytes: 448 * 1024 ** 2, maxRecordBytes: 4 * 1024 ** 2,
    maxSnapshotFeatures: 600000, maxFeatures: 10000, snapshotTimeoutMs: 300000 };
const STREAM_WORKSPACE_BYTES = 2 * 1024 ** 2;
const MAX_TRANSPORT_CHUNK_BYTES = 1024 ** 2;
const sensitive = /owner|address|account|tax|propriet|holder|person|氏名|住所|所有者/i;
let retained = null, tail = Promise.resolve();
const serial = operation => {
    const pending = tail.then(operation); tail = pending.catch(() => {}); return pending;
};
process.once('exit', () => { if (retained) rmSync(retained.directory, { recursive: true, force: true }); });

// GeoJSON foreign members and nonnumeric extra ordinates must never enter the safe geometry store.
// Reject them rather than stripping source content or altering any coordinate.
function safeGeometry(geometry) {
    if (!validateGeometry(geometry) || Object.keys(geometry).some(key => !['type', 'coordinates', 'bbox'].includes(key))) return false;
    if (geometry.bbox !== undefined && (!Array.isArray(geometry.bbox)
        || ![4, 6].includes(geometry.bbox.length) || !geometry.bbox.every(Number.isFinite))) return false;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    return polygons.every(polygon => polygon.every(ring => ring.every(point =>
        point.length <= 3 && point.every(value => typeof value === 'number' && Number.isFinite(value)))))
        && polygons.every(polygon => polygon.every(ring =>
            ring[0].length === ring.at(-1).length && ring[0].every((value, i) => value === ring.at(-1)[i])));
}

function verifiedDescriptor(input, requireHash = true) {
    const d = { ...input };
    let url; try { url = new URL(d.endpoint); } catch { /* Checked below. */ }
    if (d.snapshotStorage !== 'disk' || typeof d.id !== 'string' || !d.id || typeof d.idPrefix !== 'string' || !d.idPrefix
        || url?.protocol !== 'https:' || url.username || url.password
        || !Array.isArray(d.idFields) || !d.idFields.length || d.idFields.length > 8 || new Set(d.idFields).size !== d.idFields.length
        || d.idFields.some(field => typeof field !== 'string' || !field || field.length > 128 || sensitive.test(field))
        || !Array.isArray(d.outFields) || d.outFields.length !== d.idFields.length || new Set(d.outFields).size !== d.outFields.length
        || d.outFields.some(field => !d.idFields.includes(field))
        || d.snapshotFormat && d.snapshotFormat !== 'geojson'
        || d.snapshots || d.requestForm || d.nativeGeometryMode || d.partMatchFields || d.disjointParts || d.parcelNumberField
        || !/^"[^"\r\n]+"$/.test(d.expectedEtag || '')
        || (requireHash && !/^[a-f0-9]{64}$/.test(d.expectedSnapshotSha256 || ''))
        || (d.expectedSnapshotSha256 !== undefined && !/^[a-f0-9]{64}$/.test(d.expectedSnapshotSha256))
        || (requireHash && (!Number.isSafeInteger(d.expectedSnapshotFeatures) || d.expectedSnapshotFeatures < 0))
        || (d.expectedSnapshotFeatures !== undefined && (!Number.isSafeInteger(d.expectedSnapshotFeatures)
            || d.expectedSnapshotFeatures < 0 || d.expectedSnapshotFeatures > d.maxSnapshotFeatures))
        || !['reject', 'equivalent'].includes(d.duplicateNativeIdentity)
        || (requireHash && d.expectedCollectionName === undefined)
        || (d.expectedCollectionName !== undefined && (typeof d.expectedCollectionName !== 'string' || !d.expectedCollectionName || d.expectedCollectionName.length > 1024))
        || (d.idNamespace && (!d.idFields.includes(d.idNamespace.field) || typeof d.idNamespace.value !== 'string' || !d.idNamespace.value))
        || (d.bbox && (!Array.isArray(d.bbox) || d.bbox.length !== 4 || !d.bbox.every(Number.isFinite)
            || d.bbox[0] < -180 || d.bbox[2] > 180 || d.bbox[1] < -90 || d.bbox[3] > 90 || d.bbox[0] >= d.bbox[2] || d.bbox[1] >= d.bbox[3]))
        || (d.maxBboxKm2 !== undefined && (!Number.isFinite(d.maxBboxKm2) || d.maxBboxKm2 <= 0 || d.maxBboxKm2 > 25))
        || Object.entries(caps).some(([key, cap]) => !Number.isSafeInteger(d[key]) || d[key] <= 0 || d[key] > cap)
        || d.maxIndexBytes + 16 * d.maxRecordBytes + STREAM_WORKSPACE_BYTES > d.maxMemoryBytes) {
        throw new Error('Invalid verified disk GeoJSON snapshot descriptor.');
    }
    // Copy query/identity inputs so a caller cannot mutate the verified profile after construction.
    d.idFields = [...d.idFields]; d.outFields = [...d.outFields];
    if (d.idNamespace) d.idNamespace = { ...d.idNamespace };
    if (d.bbox) d.bbox = [...d.bbox];
    return d;
}

// Compare exact coordinates modulo ring start/direction, hole and polygon order. No rounding or geometry changes.
export function exactPolygonFingerprint(geometry) {
    function ringKey(ring) {
        const vertices = ring.slice(0, -1).map(point => JSON.stringify(point));
        // Minimum cyclic rotation (linear time even with repeated vertices).
        function rotation(order) {
            const n = order.length; let i = 0, j = 1, k = 0;
            while (i < n && j < n && k < n) {
                const a = order[(i + k) % n], b = order[(j + k) % n];
                if (a === b) { k++; continue; }
                if (a > b) { i += k + 1; if (i === j) i++; }
                else { j += k + 1; if (i === j) j++; }
                k = 0;
            }
            const offset = Math.min(i, j);
            return JSON.stringify([...order.slice(offset), ...order.slice(0, offset)]);
        }
        const forward = rotation(vertices), reverse = rotation([...vertices].reverse());
        return forward < reverse ? forward : reverse;
    }
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    const keys = polygons.map(polygon => JSON.stringify([ringKey(polygon[0]), polygon.slice(1).map(ringKey).sort()])).sort();
    return createHash('sha256').update(JSON.stringify(keys)).digest('hex');
}

async function load(d, fetchImpl, inspection = false) {
    const signal = AbortSignal.timeout(d.snapshotTimeoutMs);
    let response, reader, file, directory;
    const hash = createHash('sha256'), byId = new Map();
    let length = 0, diskBytes = 0, indexBytes = 0, duplicates = 0, conflicts = 0;
    const conflictExamples = [];
    let pendingWrites = [], pendingBytes = 0, fileOffset = 0;
    async function flush() {
        if (!pendingBytes) return;
        const bytes = Buffer.concat(pendingWrites, pendingBytes); let written = 0;
        while (written < bytes.length) {
            const result = await file.write(bytes, written, bytes.length - written, fileOffset + written);
            if (!result.bytesWritten) throw upstreamError('Parcel snapshot disk write failed.'); written += result.bytesWritten;
        }
        fileOffset += pendingBytes; pendingWrites = []; pendingBytes = 0;
    }
    try {
        response = await fetchImpl(d.endpoint, { signal, headers: { Accept: 'application/geo+json, application/json',
            'Accept-Encoding': 'identity', 'If-Match': d.expectedEtag } });
        if (!response.ok || response.status !== 200) throw providerHttpError(response);
        if (response.headers.get('content-range')) throw upstreamError('Partial ranges cannot be complete parcel snapshots.');
        if (response.url && new URL(response.url).protocol !== 'https:') throw upstreamError('Snapshot redirected outside HTTPS.');
        if (response.headers.get('etag') !== d.expectedEtag) throw upstreamError('Parcel snapshot revision differs from its verified release.');
        if (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') throw upstreamError('Snapshot byte hash requires identity content encoding.');
        const declared = response.headers.get('content-length');
        if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > d.maxSnapshotBytes)) {
            throw upstreamError('Parcel snapshot exceeds byte limit.');
        }
        reader = response.body?.getReader(); if (!reader) throw upstreamError('Snapshot provider returned no readable body.');
        directory = await fs.mkdtemp(path.join(tmpdir(), 'parcel-geojson-'));
        file = await fs.open(path.join(directory, 'safe-records.jsonl'), 'wx+', 0o600);
        async function* chunks() {
            for (;;) {
                if (signal.aborted) throw upstreamError('Parcel snapshot provider timed out.', 504);
                const part = await reader.read(); if (part.done) break;
                if (part.value.byteLength > MAX_TRANSPORT_CHUNK_BYTES) throw upstreamError('Snapshot transport chunk exceeds memory limit.');
                length += part.value.byteLength;
                if (length > d.maxSnapshotBytes) throw upstreamError('Parcel snapshot exceeds byte limit.');
                hash.update(part.value); yield part.value;
            }
        }
        const { metadata, count } = await readGeojsonFeatureStream(chunks(), { maxRecordBytes: d.maxRecordBytes,
            onFeature: async (feature, row) => {
                if (signal.aborted) throw upstreamError('Parcel snapshot provider timed out.', 504);
                if (row >= d.maxSnapshotFeatures) throw upstreamError('Parcel snapshot exceeds feature limit.');
                if (feature?.type !== 'Feature' || !safeGeometry(feature.geometry)) throw upstreamError('Parcel snapshot returned invalid polygon geometry.', 502, 'parcel-snapshot-invalid-geometry');
                if (d.idNamespace && String(feature.properties?.[d.idNamespace.field]) !== d.idNamespace.value) throw upstreamError('Parcel snapshot returned a foreign native namespace.');
                let nativeId;
                try {
                    nativeId = encodeSnapshotNativeId(d.idFields.map(field => feature.properties?.[field]));
                    decodeSnapshotNativeId(nativeId, d.idFields.length);
                }
                catch { throw upstreamError('Parcel snapshot returned invalid native parcel identity.'); }
                const bounds = bbox(feature);
                if (d.bbox && (bounds[0] < d.bbox[0] || bounds[1] < d.bbox[1] || bounds[2] > d.bbox[2] || bounds[3] > d.bbox[3])) throw upstreamError('Snapshot polygon lies outside verified extent.');
                const fingerprint = exactPolygonFingerprint(feature.geometry), old = byId.get(nativeId);
                if (old) {
                    duplicates++;
                    if (old.fingerprint !== fingerprint || d.duplicateNativeIdentity === 'reject') {
                        conflicts++;
                        if (conflictExamples.length < 8) conflictExamples.push({ nativeId, firstRow: old.row, conflictingRow: row,
                            firstGeometrySha256: old.fingerprint, conflictingGeometrySha256: fingerprint,
                            firstBbox: old.bounds, conflictingBbox: bounds });
                    }
                    return;
                }
                // Charge conservative JS Map/string/record overhead plus the bounded parser workspace.
                indexBytes += 1024 + 4 * Buffer.byteLength(nativeId);
                if (indexBytes > d.maxIndexBytes) throw upstreamError('Parcel snapshot index exceeds memory limit.');
                const safe = { type: 'Feature', geometry: feature.geometry,
                    properties: Object.fromEntries(d.idFields.map(field => [field, feature.properties[field]])) };
                const bytes = Buffer.from(JSON.stringify(safe) + '\n');
                if (diskBytes + bytes.length > d.maxDiskBytes) throw upstreamError('Parcel snapshot exceeds disk limit.');
                pendingWrites.push(bytes); pendingBytes += bytes.length;
                byId.set(nativeId, { row, bounds, fingerprint, offset: diskBytes, length: bytes.length }); diskBytes += bytes.length;
                if (pendingBytes >= 65536) await flush();
            } });
        if (declared !== null && Number(declared) !== length) throw upstreamError('Snapshot content length does not match its complete body.');
        const snapshotSha256 = hash.digest('hex');
        if (d.expectedSnapshotSha256 !== undefined && snapshotSha256 !== d.expectedSnapshotSha256) throw upstreamError('Parcel snapshot hash differs from its immutable release.');
        if (d.expectedSnapshotFeatures !== undefined && count !== d.expectedSnapshotFeatures) throw upstreamError('Snapshot count differs from its verified release.');
        if (d.expectedCollectionName !== undefined && metadata.name !== d.expectedCollectionName) throw upstreamError('Snapshot collection vintage differs from its verified release.');
        const evidence = { httpStatus: response.status, etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified'),
            completeBody: true, snapshotBytes: length, snapshotSha256, collectionName: metadata.name ?? null, crs: metadata.crs ?? null,
            featureCount: count, uniqueNativeIds: byId.size, duplicateNativeIds: duplicates, conflictingNativeIds: conflicts,
            conflictExamples, safeDiskBytes: diskBytes, chargedIndexBytes: indexBytes };
        if (inspection) return evidence;
        if (conflicts) {
            const error = upstreamError('Complete source snapshot contains conflicting native parcel polygons; no repair is permitted.', 502, 'parcel-snapshot-conflicting-identity');
            error.snapshotEvidence = evidence; throw error;
        }
        await flush();
        const index = { byId, file, directory, evidence };
        file = null; directory = null; return index;
    } catch (error) {
        if (error.status) throw error;
        if (signal.aborted || ['AbortError', 'TimeoutError'].includes(error.name)) throw upstreamError('Parcel snapshot provider timed out.', 504);
        throw upstreamError('Parcel snapshot is malformed or unavailable.');
    } finally {
        if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        else await response?.body?.cancel().catch(() => {});
        await file?.close(); if (directory) await fs.rm(directory, { recursive: true, force: true });
    }
}

// Discovery produces only bounded safe evidence, never queryable data; production requires the discovered hash/count/name.
export async function inspectGeojsonSnapshot(descriptor, { fetchImpl = fetch } = {}) {
    const d = verifiedDescriptor(descriptor, false);
    return serial(async () => { await discard(); return load(d, fetchImpl, true); });
}

async function discard() {
    if (!retained) return;
    const old = retained; retained = null; clearTimeout(old.timer);
    await old.file.close(); await fs.rm(old.directory, { recursive: true, force: true });
}

export function createDiskGeojsonSnapshotParcelSource(input, { fetchImpl = fetch, now = Date.now } = {}) {
    const d = verifiedDescriptor(input), key = JSON.stringify(d);
    if (typeof fetchImpl !== 'function' || typeof now !== 'function') throw new Error('Invalid snapshot transport.');
    async function run(operation) {
        return serial(async () => {
            if (!retained || retained.key !== key || retained.fetchImpl !== fetchImpl || now() >= retained.expires) {
                await discard();
                const index = await load(d, fetchImpl);
                retained = { ...index, key, fetchImpl, expires: now() + 300000 };
                retained.timer = setTimeout(() => { serial(discard).catch(() => {}); }, 300000); retained.timer.unref();
            }
            try { return await operation(retained); }
            catch (error) { if (error.status) throw error; throw upstreamError('Parcel snapshot local query failed.'); }
        });
    }
    async function read(index, nativeId, row) {
        const bytes = Buffer.alloc(row.length); let offset = 0;
        while (offset < bytes.length) {
            const result = await index.file.read(bytes, offset, bytes.length - offset, row.offset + offset);
            if (!result.bytesRead) throw upstreamError('Parcel snapshot safe disk record is truncated.'); offset += result.bytesRead;
        }
        const feature = JSON.parse(bytes.toString('utf8'));
        if (encodeSnapshotNativeId(d.idFields.map(field => feature.properties?.[field])) !== nativeId
            || exactPolygonFingerprint(feature.geometry) !== row.fingerprint) throw upstreamError('Parcel snapshot safe disk geometry changed.');
        return canonicalParcelFeature(d, feature, nativeId);
    }
    function result(features, evidence, extra = {}) {
        return { type: 'FeatureCollection', features, complete: true, returnsWGS84: true, sourceId: d.id,
            snapshotSha256: evidence.snapshotSha256, ...extra };
    }
    function queryMemory(index, retainedBytes, row) {
        if (index.evidence.chargedIndexBytes + 16 * (d.maxRecordBytes + retainedBytes + row.length) + STREAM_WORKSPACE_BYTES > d.maxMemoryBytes) {
            throw upstreamError('Parcel query exceeds memory limit.');
        }
    }
    async function intersect(geometry, bounds) {
        return run(async index => {
            const features = [], target = geoFeature(geometry); let retainedBytes = 0;
            for (const [nativeId, row] of index.byId) {
                const b = row.bounds;
                if (b[0] > bounds[2] || b[2] < bounds[0] || b[1] > bounds[3] || b[3] < bounds[1]) continue;
                queryMemory(index, retainedBytes, row);
                const feature = await read(index, nativeId, row);
                if (booleanIntersects(feature, target)) { features.push(feature); retainedBytes += row.length; }
                if (features.length > d.maxFeatures) throw upstreamError('Parcel query exceeds feature limit.');
            }
            return result(features, index.evidence);
        });
    }
    function queryBounds(bounds) {
        validateBounds(bounds, d.maxBboxKm2 ?? 25, d); return intersect(bboxPolygon(bounds).geometry, bounds);
    }
    function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide valid WGS84 polygon geometry.');
        const bounds = bbox(geoFeature(geometry)); validateBounds(bounds, d.maxBboxKm2 ?? 25, d); return intersect(geometry, bounds);
    }
    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 parcel IDs.');
        const unique = [...new Set(ids)], natives = unique.map(value => {
            if (typeof value !== 'string' || !value.startsWith(d.idPrefix)) throw new HttpError(400, 'Parcel ID belongs to a different source.');
            const native = value.slice(d.idPrefix.length); decodeSnapshotNativeId(native, d.idFields.length); return native;
        });
        return run(async index => {
            const features = [], absentIds = []; let retainedBytes = 0;
            for (const [i, nativeId] of natives.entries()) {
                const row = index.byId.get(nativeId);
                if (row) {
                    queryMemory(index, retainedBytes, row); features.push(await read(index, nativeId, row)); retainedBytes += row.length;
                } else absentIds.push(unique[i]);
                if (features.length > d.maxFeatures) throw upstreamError('Parcel query exceeds feature limit.');
            }
            return result(features, index.evidence, { absentIds });
        });
    }
    return Object.freeze({ queryBounds, queryGeometry, queryIds,
        close: () => serial(async () => { if (retained?.key === key && retained.fetchImpl === fetchImpl) await discard(); }) });
}
