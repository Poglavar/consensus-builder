// A pinned ZIP geometry member is streamed without downloading the archive or its attributes.
import { Inflate } from 'fflate';
import proj4 from 'proj4';
import { bbox, bboxPolygon, booleanIntersects } from '@turf/turf';
import { readShapefilePolygon } from './shapefile-zip-reader.js';
import { sha256Hex } from './portable-hash.js';
import { canonicalParcelFeature, upstreamError, providerHttpError, validateBounds, validateGeometry } from './source-contract.js';
import { HttpError } from '../utils/helpers.js';
import { createGeojsonRangeBrowserSource } from './geojson-range-source.js';

const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
    for (let j = 0; j < 8; j++) i = i & 1 ? 0xedb88320 ^ (i >>> 1) : i >>> 1;
    return i >>> 0;
});
const view = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
export const createShapefileRangeBrowserSource = createGeojsonRangeBrowserSource;

export function createShapefileRangeParcelSource(input, { fetchImpl = fetch, now = Date.now } = {}) {
    const d = structuredClone(input), m = d.geometryMember;
    const fail = message => upstreamError(message, 502, 'parcel-shape-range-invalid');
    // The alternate format must be the very same publisher resource stem, not an arbitrary URL.
    if (!d.id || d.idPrefix !== `${d.id}/native-shape-sha256-v1/` || d.outFields?.length !== 0
        || new URL(d.endpoint).protocol !== 'https:' || d.geometryEndpoint !== d.endpoint.replace(/\.geojson$/, '.shp.zip')
        || !/^"[^"\r\n]+"$/.test(d.geometryEtag || '')
        || d.sourceCrs !== 'EPSG:6673' || !Number.isSafeInteger(d.geometryArchiveBytes)
        || !m || ![m.dataStart, m.compressedBytes, m.uncompressedBytes, m.crc32, m.records, d.rangeBytes, d.maxFeatures]
            .every(Number.isSafeInteger)
        || m.dataStart < 30 || m.compressedBytes < 1 || m.uncompressedBytes < 100 || m.records < 1
        || m.records > 100000 || m.dataStart + m.compressedBytes > d.geometryArchiveBytes
        || m.crc32 < 0 || m.crc32 > 0xffffffff || m.compressedBytes + m.uncompressedBytes > 64 * 1024 ** 2
        || d.rangeBytes < 1024 || d.rangeBytes > 16 * 1024 ** 2 || d.maxFeatures < 1 || d.maxFeatures > 10000) {
        throw new Error('Invalid range Shapefile descriptor.');
    }
    // JGD2011 / Japan Plane Rectangular CS V; source SHP ordinates are easting,northing.
    // No fitted translation, epoch correction or unverified grid is applied.
    const projection = proj4('+proj=tmerc +lat_0=36 +lon_0=134.333333333333 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs', 'EPSG:4326');
    let cached, pending, expires = 0;
    function canonical(record, hash) {
        const geometry = readShapefilePolygon(view(record), 0, record.length, projection,
            { maxRecordPoints: 60000 }).geometry;
        return canonicalParcelFeature(d, { geometry, properties: {} }, hash);
    }
    async function scan(wanted = null) {
        const rows = new Map(), found = new Map();
        let buffer = new Uint8Array(0), header = false, count = 0, inflated = 0, crc = 0xffffffff, finished = false;
        const stop = Symbol('requested geometry found');
        const inflater = new Inflate((chunk, final) => {
            inflated += chunk.length;
            if (inflated > m.uncompressedBytes) throw fail('Geometry member exceeds its extracted byte budget.');
            for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
            const joined = new Uint8Array(buffer.length + chunk.length); joined.set(buffer); joined.set(chunk, buffer.length);
            buffer = joined;
            let pos = 0;
            if (!header) {
                if (buffer.length < 100) return;
                const v = view(buffer);
                if (v.getUint32(0) !== 9994 || v.getUint32(24) * 2 !== m.uncompressedBytes
                    || v.getUint32(28, true) !== 1000 || v.getUint32(32, true) !== 5) throw fail('Geometry member header changed.');
                header = true; pos = 100;
            }
            while (pos + 8 <= buffer.length) {
                const v = view(buffer), size = v.getUint32(pos + 4) * 2;
                if (size < 4 || size > 1024 * 1024 || v.getUint32(pos) !== count + 1) throw fail('Invalid geometry record framing.');
                if (pos + 8 + size > buffer.length) break;
                if (++count > m.records) throw fail('Geometry member has excess records.');
                const record = buffer.slice(pos + 8, pos + 8 + size), rv = view(record), hash = sha256Hex(record);
                if (wanted?.has(d.idPrefix + hash)) {
                    found.set(d.idPrefix + hash, canonical(record, hash));
                    if (found.size === wanted.size) throw stop;
                }
                if (!wanted) {
                    if (!rows.has(hash)) rows.set(hash, { record, nativeBbox: size >= 44 && rv.getUint32(0, true) === 5
                        ? [4, 12, 20, 28].map(offset => rv.getFloat64(offset, true)) : null });
                    else if (rows.get(hash).record.some((n, i) => n !== record[i])) throw fail('Geometry hash collision.');
                }
                pos += 8 + size;
            }
            buffer = buffer.slice(pos);
            if (buffer.length > 1024 * 1024 + 8) throw fail('Geometry record exceeds memory budget.');
            finished = final;
        });
        const signal = AbortSignal.timeout(90000);
        let downloaded = 0;
        try {
            // Exact samples use small prefixes; complete geometry scans amortize HTTP latency.
            const rangeBytes = wanted ? d.rangeBytes : 4 * 1024 ** 2;
            for (let offset = 0; offset < m.compressedBytes; offset += rangeBytes) {
                const start = m.dataStart + offset, end = Math.min(start + rangeBytes, m.dataStart + m.compressedBytes) - 1;
                const response = await fetchImpl(d.geometryEndpoint, { signal, headers: {
                    Accept: 'application/zip', Range: `bytes=${start}-${end}`, 'If-Match': d.geometryEtag } });
                let reader;
                try {
                    if (response.status !== 206) throw providerHttpError(response);
                    if (response.headers.get('etag') !== d.geometryEtag
                        || response.headers.get('content-range') !== `bytes ${start}-${end}/${d.geometryArchiveBytes}`
                        || response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity'
                        || response.headers.has('content-length') && response.headers.get('content-length') !== String(end - start + 1)) {
                        throw fail('Geometry range revision or byte positions changed.');
                    }
                    reader = response.body.getReader(); let actual = 0;
                    for (;;) {
                        const part = await reader.read(); if (part.done) break;
                        actual += part.value.byteLength; downloaded += part.value.byteLength;
                        if (actual > end - start + 1 || downloaded > m.compressedBytes) throw fail('Geometry range exceeded actual byte budget.');
                        // Limit temporary inflater output, even for transports returning large chunks.
                        for (let i = 0; i < part.value.length; i += 1024) inflater.push(part.value.subarray(i, i + 1024), false);
                    }
                    if (actual !== end - start + 1) throw fail('Truncated geometry range.');
                } finally {
                    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
                    else await response.body?.cancel().catch(() => {});
                }
            }
            inflater.push(new Uint8Array(0), true);
            if (!finished || buffer.length || count !== m.records || inflated !== m.uncompressedBytes
                || ((crc ^ 0xffffffff) >>> 0) !== m.crc32 || inflater.p.length !== (inflater.s.p ? 1 : 0)) {
                throw fail('Geometry member checksum, record count or extracted length changed.');
            }
        } catch (error) { if (error !== stop) throw error; }
        return { rows, found, statistics: { downloadedBytes: downloaded, extractedBytes: inflated, recordsRead: count } };
    }
    async function index() {
        if (cached && now() < expires) return cached;
        if (!pending) pending = scan().then(value => { cached = value; expires = now() + 300000; return value; })
            .finally(() => { pending = null; });
        return pending;
    }
    function result(features, extra = {}) {
        if (features.length > d.maxFeatures) throw fail('Geometry query exceeds feature budget.');
        return { type: 'FeatureCollection', sourceId: d.id, complete: true, returnsWGS84: true,
            features: structuredClone(features), ...extra };
    }
    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80 || ids.some(id => typeof id !== 'string'
            || !id.startsWith(d.idPrefix) || !/^[a-f0-9]{64}$/.test(id.slice(d.idPrefix.length)))) throw new HttpError(400, 'Invalid geometry-derived parcel reference.');
        const wanted = new Set(ids);
        // Cold reads stop as soon as all requested hashes are found; no saved sample or index is used.
        const data = await scan(wanted);
        return result([...data.found.values()], { absentIds: [...wanted].filter(id => !data.found.has(id)), statistics: data.statistics });
    }
    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide valid WGS84 polygon geometry.');
        const bounds = bbox(geometry); validateBounds(bounds, d.maxBboxKm2 || 25, d);
        const data = await index(), selected = [];
        // Test envelopes in the native metric frame. Small WGS84 queries are densely sampled
        // along their edges so projection curvature cannot exclude a nearby parcel.
        const target = [Infinity, Infinity, -Infinity, -Infinity];
        for (let i = 0; i <= 8; i++) for (const p of [
            [bounds[0] + (bounds[2] - bounds[0]) * i / 8, bounds[1]], [bounds[0] + (bounds[2] - bounds[0]) * i / 8, bounds[3]],
            [bounds[0], bounds[1] + (bounds[3] - bounds[1]) * i / 8], [bounds[2], bounds[1] + (bounds[3] - bounds[1]) * i / 8]]) {
            const q = projection.inverse(p);
            target[0] = Math.min(target[0], q[0] - 1); target[1] = Math.min(target[1], q[1] - 1);
            target[2] = Math.max(target[2], q[0] + 1); target[3] = Math.max(target[3], q[1] + 1);
        }
        for (const [hash, row] of data.rows) {
            if (!row.nativeBbox?.every(Number.isFinite)) continue;
            if (!overlaps(row.nativeBbox, target)) continue;
            const feature = canonical(row.record, hash);
            if (booleanIntersects(feature, geometry)) selected.push(feature);
        }
        return result(selected, { statistics: data.statistics });
    }
    function queryBounds(bounds) { validateBounds(bounds, d.maxBboxKm2 || 25, d); return queryGeometry(bboxPolygon(bounds).geometry); }
    return Object.freeze({ queryIds, queryBounds, queryGeometry });
}
