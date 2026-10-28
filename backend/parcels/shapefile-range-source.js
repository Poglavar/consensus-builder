// A pinned ZIP geometry member is streamed without downloading the archive or its attributes.
import { Inflate, inflateSync } from 'fflate';
import proj4 from 'proj4';
import { bbox, bboxPolygon, booleanIntersects } from '@turf/turf';
import { readShapefilePolygon } from './shapefile-zip-reader.js';
import { sha256Hex } from './portable-hash.js';
import { canonicalParcelFeature, upstreamError, providerHttpError, validateBounds, validateGeometry } from './source-contract.js';
import { HttpError } from '../utils/helpers.js';
import { createGeojsonRangeBrowserSource } from './geojson-range-source.js';
import { createShapefileNativeRangeParcelSource } from './shapefile-native-range-source.js';
import { createShapefileMemberStreamSource } from './shapefile-member-stream-source.js';

const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
    for (let j = 0; j < 8; j++) i = i & 1 ? 0xedb88320 ^ (i >>> 1) : i >>> 1;
    return i >>> 0;
});
const view = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
export const createShapefileRangeBrowserSource = createGeojsonRangeBrowserSource;

export function createShapefileRangeParcelSource(input, { fetchImpl = fetch, now = Date.now } = {}) {
    if (input.archiveAccess === 'streamed-zip-members-v1') return createShapefileMemberStreamSource(input, { fetchImpl });
    if (input.archiveAccess === 'native-dbf-range-v1') return createShapefileNativeRangeParcelSource(input, { fetchImpl, now });
    const d = structuredClone(input), m = d.geometryMember;
    const geographic = d.geometryMemberProfile === 'wgs84-zip-member-v1';
    // A full DBF audit proves gid=record number for this exact pinned release. This is
    // a certified native field mapping, not an identity inferred from response order.
    const sequence = d.archiveAccess === 'verified-native-sequence-v1';
    const mapping = d.nativeIdMapping;
    if (sequence && (!geographic || d.geometryEndpoint !== d.endpoint || d.idPrefix !== `${d.id}/gid/`
        || d.idField !== 'gid' || JSON.stringify(d.outFields) !== '["gid"]'
        || mapping?.field !== 'gid' || mapping?.operation !== 'one-based-shp-record'
        || mapping?.count !== m?.records || !/^[a-f0-9]{64}$/.test(mapping?.dbfSha256 || '')
        || !/^[a-f0-9]{64}$/.test(d.projectionSha256 || '')
        || !['dbf', 'shp', 'prj'].every(kind => {
            const member = d.zipMembers?.[kind];
            return member && typeof member.name === 'string' && member.name === `${d.sourceLayer}.${kind}`
                && [member.localOffset, member.dataStart, member.compressedBytes, member.uncompressedBytes, member.crc32].every(Number.isSafeInteger)
                && member.localOffset >= 0 && member.dataStart >= member.localOffset + 30
                && member.compressedBytes > 0 && member.uncompressedBytes > 0 && [0, 8].includes(member.method)
                && member.dataStart + member.compressedBytes <= d.geometryArchiveBytes;
        }) || (d.zipMembers.shp.dataStart !== m.dataStart
            || d.zipMembers.shp.crc32 !== m.crc32 || d.zipMembers.shp.compressedBytes !== m.compressedBytes
            || d.zipMembers.shp.uncompressedBytes !== m.uncompressedBytes || d.zipMembers.shp.method !== 8 || d.zipMembers.prj.uncompressedBytes > 16384))) {
        throw new Error('Invalid verified native sequence mapping.');
    }
    const fail = message => upstreamError(message, 502, 'parcel-shape-range-invalid');
    // The alternate format must be the very same publisher resource stem, not an arbitrary URL.
    if (!d.id || (!sequence && (d.idPrefix !== `${d.id}/native-shape-sha256-v1/` || d.outFields?.length !== 0))
        || new URL(d.endpoint).protocol !== 'https:'
        || (geographic ? new URL(d.geometryEndpoint).protocol !== 'https:' || new URL(d.geometryEndpoint).username || new URL(d.geometryEndpoint).password
            : d.geometryEndpoint !== d.endpoint.replace(/\.geojson$/, '.shp.zip'))
        || !/^"[^"\r\n]+"$/.test(d.geometryEtag || '')
        || d.sourceCrs !== (geographic ? 'EPSG:4326' : 'EPSG:6673') || !Number.isSafeInteger(d.geometryArchiveBytes)
        || !m || ![m.dataStart, m.compressedBytes, m.uncompressedBytes, m.crc32, m.records, d.rangeBytes, d.maxFeatures]
            .every(Number.isSafeInteger)
        || m.dataStart < 30 || m.compressedBytes < 1 || m.uncompressedBytes < 100 || m.records < 1
        || m.records > 250000 || m.dataStart + m.compressedBytes > d.geometryArchiveBytes
        || m.crc32 < 0 || m.crc32 > 0xffffffff || m.compressedBytes + m.uncompressedBytes > 64 * 1024 ** 2
        || d.rangeBytes < 1024 || d.rangeBytes > 16 * 1024 ** 2 || d.maxFeatures < 1 || d.maxFeatures > 10000) {
        throw new Error('Invalid range Shapefile descriptor.');
    }
    // JGD2011 / Japan Plane Rectangular CS V; source SHP ordinates are easting,northing.
    // No fitted translation, epoch correction or unverified grid is applied.
    const projection = geographic ? { forward: p => [...p], inverse: p => [...p] }
        : proj4('+proj=tmerc +lat_0=36 +lon_0=134.333333333333 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs', 'EPSG:4326');
    let cached, pending, expires = 0;
    function canonical(record, hash) {
        const geometry = readShapefilePolygon(view(record), 0, record.length, projection,
            { maxRecordPoints: 60000 }).geometry;
        return canonicalParcelFeature(d, { geometry, properties: sequence ? { gid: Number(hash) } : {} }, hash);
    }
    async function scan(wanted = null) {
        const rows = new Map(), found = new Map();
        let buffer = new Uint8Array(0), header = false, count = 0, inflated = 0, crc = 0xffffffff, finished = false;
        const stop = Symbol('requested geometry found');
        let downloaded = 0, metadataExtracted = 0;
        const signal = AbortSignal.timeout(90000);
        function checkBudget() {
            if (downloaded + inflated + metadataExtracted > 64 * 1024 ** 2) throw fail('Geometry read exceeds its actual byte budget.');
        }
        async function smallRange(start, end) {
            const response = await fetchImpl(d.geometryEndpoint, { signal, headers: {
                Accept: 'application/zip, application/x-zip-compressed, application/octet-stream',
                Range: `bytes=${start}-${end}`, 'If-Match': d.geometryEtag } });
            let reader;
            try {
                if (response.status !== 206) throw providerHttpError(response);
                if (response.headers.get('etag') !== d.geometryEtag
                    || response.headers.get('content-range') !== `bytes ${start}-${end}/${d.geometryArchiveBytes}`
                    || response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') throw fail('Native identity metadata revision changed.');
                reader = response.body.getReader(); const chunks = []; let size = 0;
                for (;;) {
                    const part = await reader.read(); if (part.done) break;
                    size += part.value.length; downloaded += part.value.length; checkBudget();
                    if (size > end - start + 1 || size > 16384) throw fail('Native identity metadata exceeds byte limit.');
                    chunks.push(part.value);
                }
                if (size !== end - start + 1) throw fail('Truncated native identity metadata.');
                const bytes = new Uint8Array(size); let offset = 0;
                for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
                return bytes;
            } finally {
                if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
                else await response.body?.cancel().catch(() => {});
            }
        }
        if (sequence) {
            // Bind the audited DBF mapping and projection to this live archive revision.
            for (const kind of ['dbf', 'shp', 'prj']) {
                const member = d.zipMembers[kind], bytes = await smallRange(member.localOffset, member.dataStart - 1), h = view(bytes);
                if (h.getUint32(0, true) !== 0x04034b50 || h.getUint16(6, true) !== 0
                    || h.getUint16(8, true) !== member.method || h.getUint32(14, true) !== member.crc32
                    || h.getUint32(18, true) !== member.compressedBytes || h.getUint32(22, true) !== member.uncompressedBytes
                    || 30 + h.getUint16(26, true) + h.getUint16(28, true) !== bytes.length
                    || new TextDecoder().decode(bytes.subarray(30, 30 + h.getUint16(26, true))) !== member.name) throw fail('Audited native ZIP metadata changed.');
            }
            const member = d.zipMembers.prj, raw = await smallRange(member.dataStart, member.dataStart + member.compressedBytes - 1);
            // Fixed small output allocation prevents oversized metadata inflation.
            const prj = member.method === 8 ? inflateSync(raw, { out: new Uint8Array(member.uncompressedBytes) }) : raw;
            metadataExtracted += prj.length; checkBudget();
            if (prj.length !== member.uncompressedBytes || sha256Hex(prj) !== d.projectionSha256) throw fail('Verified WGS84 projection changed.');
        }
        const inflater = new Inflate((chunk, final) => {
            inflated += chunk.length; checkBudget();
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
                const record = buffer.slice(pos + 8, pos + 8 + size), rv = view(record), hash = sequence ? String(count) : sha256Hex(record);
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
        try {
            // Exact samples use small prefixes; complete geometry scans amortize HTTP latency.
            const rangeBytes = wanted ? d.rangeBytes : 4 * 1024 ** 2;
            for (let offset = 0; offset < m.compressedBytes; offset += rangeBytes) {
                const start = m.dataStart + offset, end = Math.min(start + rangeBytes, m.dataStart + m.compressedBytes) - 1;
                const response = await fetchImpl(d.geometryEndpoint, { signal, headers: {
                    Accept: 'application/zip, application/x-zip-compressed, application/octet-stream', Range: `bytes=${start}-${end}`, 'If-Match': d.geometryEtag } });
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
                        actual += part.value.byteLength; downloaded += part.value.byteLength; checkBudget();
                        if (actual > end - start + 1 || actual > 16 * 1024 ** 2) throw fail('Geometry range exceeded actual byte budget.');
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
        return { rows, found, statistics: { downloadedBytes: downloaded, extractedBytes: inflated + metadataExtracted, recordsRead: count } };
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
            || !id.startsWith(d.idPrefix) || !(sequence ? /^[1-9]\d{0,8}$/.test(id.slice(d.idPrefix.length)) : /^[a-f0-9]{64}$/.test(id.slice(d.idPrefix.length))))) throw new HttpError(400, 'Invalid source parcel reference.');
        const wanted = new Set(ids);
        // Cold reads stop as soon as all requested hashes are found; no saved sample or index is used.
        const warm = cached && now() < expires ? cached : pending ? await pending : null;
        if (warm) return result([...wanted].filter(id => warm.rows.has(id.slice(d.idPrefix.length)))
            .map(id => canonical(warm.rows.get(id.slice(d.idPrefix.length)).record, id.slice(d.idPrefix.length))),
        { absentIds: [...wanted].filter(id => !warm.rows.has(id.slice(d.idPrefix.length))), statistics: { downloadedBytes: 0, extractedBytes: 0 } });
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
            const margin = geographic ? 1e-10 : 1;
            target[0] = Math.min(target[0], q[0] - margin); target[1] = Math.min(target[1], q[1] - margin);
            target[2] = Math.max(target[2], q[0] + margin); target[3] = Math.max(target[3], q[1] + margin);
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
