// Read revision-pinned ZIP members by HTTP range, joining native DBF IDs to SHP records.
// Cold exact reads stop after the requested rows; spatial reads cache binary records only.
import { Inflate } from 'fflate';
import { bbox, bboxPolygon, booleanIntersects } from '@turf/turf';
import { concatBytes } from './byte-utils.js';
import { readShapefileDbf, readShapefilePolygon, verifiedProjection, SHAPEFILE_CRS } from './shapefile-zip-reader.js';
import { encodeSnapshotNativeId, decodeSnapshotNativeId } from './geojson-snapshot-source.js';
import { canonicalParcelFeature, upstreamError, providerHttpError, validateBounds, validateGeometry } from './source-contract.js';
import { HttpError } from '../utils/helpers.js';

const view = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
const MiB = 1024 ** 2;
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
    for (let n = 0; n < 8; n++) i = i & 1 ? 0xedb88320 ^ (i >>> 1) : i >>> 1;
    return i >>> 0;
});
export function createShapefileNativeRangeParcelSource(input, { fetchImpl = fetch, now = Date.now } = {}) {
    const d = structuredClone(input), members = d.zipMembers, url = new URL(d.endpoint);
    const fail = message => upstreamError(message);
    const kinds = ['dbf', 'shp', 'prj', 'cpg'];
    if (!d.id || !d.idPrefix || url.protocol !== 'https:' || url.username || url.password
        || !Object.hasOwn(SHAPEFILE_CRS, d.sourceCrs) || !/^"[^"\r\n]+"$/.test(d.expectedEtag || '')
        || !Number.isSafeInteger(d.expectedSnapshotBytes) || d.expectedSnapshotBytes < 1
        || d.expectedSnapshotBytes > 16 * MiB || !Number.isSafeInteger(d.expectedSnapshotFeatures)
        || d.expectedSnapshotFeatures < 1 || d.expectedSnapshotFeatures > 1000000
        || !Number.isSafeInteger(d.maxFeatures) || d.maxFeatures < 1 || d.maxFeatures > 10000
        || !Number.isSafeInteger(d.rangeBytes) || d.rangeBytes < 1024 || d.rangeBytes > MiB
        || !Number.isSafeInteger(d.maxRecordPoints) || d.maxRecordPoints < 4 || d.maxRecordPoints > 1000000
        || !Array.isArray(d.idFields) || !d.idFields.length || d.idFields.length > 8
        || new Set(d.idFields).size !== d.idFields.length
        || d.idFields.some(f => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(f) || /owner|address|tax|account|titular|propriet/i.test(f))
        || !Array.isArray(d.outFields) || JSON.stringify(d.outFields) !== JSON.stringify(d.idFields)
        || d.emptyIdFields !== undefined && (!Array.isArray(d.emptyIdFields) || d.emptyIdFields.length >= d.idFields.length
            || d.emptyIdFields.some(field => !d.idFields.includes(field)))
        || !members || Object.keys(members).length !== kinds.length
        || kinds.some(kind => {
            const m = members[kind];
            return !m || m.name !== `${d.sourceLayer}.${kind}` || ![0, 8].includes(m.method)
                || ![m.localOffset, m.dataStart, m.compressedBytes, m.uncompressedBytes, m.crc32].every(Number.isSafeInteger)
                || m.localOffset < 0 || m.dataStart !== m.localOffset + 30 + new TextEncoder().encode(m.name).length
                || m.compressedBytes < 1 || m.uncompressedBytes < 1 || m.crc32 < 0 || m.crc32 > 0xffffffff
                || m.dataStart + m.compressedBytes > d.expectedSnapshotBytes
                || (kind === 'prj' || kind === 'cpg') && m.uncompressedBytes > 16384
                || m.method === 0 && m.compressedBytes !== m.uncompressedBytes;
        }) || kinds.reduce((sum, kind) => sum + members[kind].compressedBytes + members[kind].uncompressedBytes, 0) > 60 * MiB) {
        throw new Error('Invalid native Shapefile range descriptor.');
    }
    let cached, pending, expires = 0;
    function budget() { return { downloadedBytes: 0, extractedBytes: 0, requests: 0, signal: AbortSignal.timeout(90000) }; }
    function checkBudget(b) {
        if (b.downloadedBytes + b.extractedBytes > 64 * MiB) throw fail('Parcel range scan exceeds its actual byte budget.');
    }
    async function range(start, end, b) {
        const r = await fetchImpl(d.endpoint, { signal: b.signal, headers: {
            // IIS serves application/x-zip-compressed and rejects application/zip alone (406).
            Accept: 'application/zip, application/x-zip-compressed, application/octet-stream', Range: `bytes=${start}-${end}`, 'If-Match': d.expectedEtag } });
        b.requests++;
        let reader;
        try {
            if (r.status !== 206) throw providerHttpError(r);
            if (r.headers.get('etag') !== d.expectedEtag
                || r.headers.get('content-range') !== `bytes ${start}-${end}/${d.expectedSnapshotBytes}`
                || r.headers.get('content-encoding') && r.headers.get('content-encoding') !== 'identity') throw fail('Parcel ZIP revision or range changed.');
            reader = r.body.getReader(); const chunks = []; let total = 0;
            for (;;) {
                const part = await reader.read(); if (part.done) break;
                total += part.value.length; b.downloadedBytes += part.value.length; checkBudget(b);
                if (total > end - start + 1 || total > 16 * MiB) throw fail('Parcel range exceeds its actual byte limit.');
                chunks.push(part.value);
            }
            if (total !== end - start + 1) throw fail('Truncated parcel ZIP range.');
            return concatBytes(chunks, total);
        } finally {
            if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
            else await r.body?.cancel().catch(() => {});
        }
    }
    async function member(kind, b, { until, sink } = {}) {
        const m = members[kind], header = await range(m.localOffset, m.dataStart - 1, b), h = view(header);
        if (h.getUint32(0, true) !== 0x04034b50 || h.getUint16(6, true) !== 0 || h.getUint16(8, true) !== m.method
            || h.getUint32(14, true) !== m.crc32 || h.getUint32(18, true) !== m.compressedBytes
            || h.getUint32(22, true) !== m.uncompressedBytes || h.getUint16(28, true) !== 0
            || new TextDecoder().decode(header.subarray(30)) !== m.name) throw fail('Parcel ZIP member metadata changed.');
        const stop = Symbol('selected native records found'), chunks = []; let total = 0, crc = 0xffffffff, final = false;
        function output(chunk, done) {
            total += chunk.length; b.extractedBytes += chunk.length; checkBudget(b);
            if (total > m.uncompressedBytes) throw fail('Parcel ZIP member exceeds extracted byte limit.');
            for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
            if (sink) { if (sink(chunk)) throw stop; }
            else {
                chunks.push(chunk);
                if (until && until(concatBytes(chunks, total))) throw stop;
            }
            final = done;
        }
        const inflater = m.method === 8 ? new Inflate(output) : null;
        try {
            // Tiny prefixes for exact IDs; larger ranges amortize a complete spatial scan.
            const step = until || sink?.exact ? d.rangeBytes : MiB;
            const inflateStep = until || sink?.exact ? 64 : 1024;
            for (let pos = 0; pos < m.compressedBytes; pos += step) {
                const data = await range(m.dataStart + pos, m.dataStart + Math.min(pos + step, m.compressedBytes) - 1, b);
                for (let i = 0; i < data.length; i += inflateStep) {
                    if (inflater) inflater.push(data.subarray(i, i + inflateStep), false);
                    else output(data.subarray(i, i + inflateStep), false);
                }
            }
            if (inflater) inflater.push(new Uint8Array(0), true); else final = true;
            if (!final || total !== m.uncompressedBytes || ((crc ^ 0xffffffff) >>> 0) !== m.crc32
                || inflater && inflater.p.length !== (inflater.s.p ? 1 : 0)) throw fail('Parcel ZIP member length or checksum changed.');
        } catch (error) { if (error !== stop) throw error; }
        return sink ? null : concatBytes(chunks, total);
    }
    async function metadata(b) {
        const prj = await member('prj', b), cpg = await member('cpg', b);
        return { projection: verifiedProjection(prj, d.sourceCrs), cpg };
    }
    // A publisher can leave one composite component empty. Keep that exact value;
    // a separate native component still supplies identity, never a row number.
    function native(props) {
        return d.idFields.map(f => props[f] === '' && d.emptyIdFields?.includes(f) ? '' : encodeSnapshotNativeId([props[f]])).join('~');
    }
    function validateNative(value) {
        if (!d.emptyIdFields?.length) return decodeSnapshotNativeId(value, d.idFields.length);
        if (value.length > 4096) throw new HttpError(400, 'Invalid native composite ID.');
        let parts; try { parts = value.split('~').map(decodeURIComponent); } catch { throw new HttpError(400, 'Invalid native composite ID.'); }
        if (parts.length !== d.idFields.length || native(Object.fromEntries(d.idFields.map((f, i) => [f, parts[i]]))) !== value) throw new HttpError(400, 'Invalid native composite ID.');
        return parts;
    }
    function shapeSink(rows, wantedRows = null) {
        let buffer = new Uint8Array(0), count = 0, header = false;
        const sink = chunk => {
            buffer = concatBytes([buffer, chunk], buffer.length + chunk.length); let pos = 0;
            if (!header) {
                if (buffer.length < 100) return false;
                const h = view(buffer);
                if (h.getUint32(0) !== 9994 || h.getUint32(24) * 2 !== members.shp.uncompressedBytes
                    || h.getUint32(28, true) !== 1000 || h.getUint32(32, true) !== 5) throw fail('Parcel SHP header changed.');
                header = true; pos = 100;
            }
            while (pos + 8 <= buffer.length) {
                const h = view(buffer), size = h.getUint32(pos + 4) * 2;
                if (h.getUint32(pos) !== count + 1 || size < 4 || size > 44 + 20 * d.maxRecordPoints) throw fail('Invalid parcel record framing.');
                if (pos + 8 + size > buffer.length) break;
                if (count >= d.expectedSnapshotFeatures) throw fail('Parcel SHP has excess records.');
                const type = h.getUint32(pos + 8, true);
                if (type !== 0 && type !== 5 || type === 0 && size !== 4 || type === 5 && size < 44) throw fail('Unsupported parcel record geometry.');
                if (!wantedRows || wantedRows.has(count)) rows.set(count, buffer.slice(pos + 8, pos + 8 + size));
                count++; pos += 8 + size;
                if (wantedRows && rows.size === wantedRows.size) return true;
            }
            buffer = buffer.slice(pos); return false;
        };
        sink.exact = !!wantedRows;
        sink.verify = () => { if (!header || buffer.length || count !== d.expectedSnapshotFeatures) throw fail('Parcel SHP record count or trailing bytes changed.'); };
        return sink;
    }
    function canonical(record, props, projection) {
        if (view(record).getUint32(0, true) === 0) throw fail('Native parcel row has no published polygon.');
        return canonicalParcelFeature(d, { properties: props,
            geometry: readShapefilePolygon(view(record), 0, record.length, projection, d).geometry }, native(props));
    }
    function result(features, b, extra = {}) {
        if (features.length > d.maxFeatures) throw fail('Parcel query exceeds feature limit.');
        return { type: 'FeatureCollection', features, complete: true, sourceId: d.id, returnsWGS84: true,
            statistics: { downloadedBytes: b.downloadedBytes, extractedBytes: b.extractedBytes, requests: b.requests }, ...extra };
    }
    async function fullIndex(b) {
        if (cached && now() < expires) return cached;
        if (!pending) pending = (async () => {
            const meta = await metadata(b), bytes = await member('dbf', b);
            const dbf = readShapefileDbf(bytes, { ...d, maxSnapshotFeatures: d.expectedSnapshotFeatures }, meta.cpg);
            const byId = new Map(), rows = new Map(); let emptyIdentityRows = 0;
            for (let i = 0; i < dbf.count; i++) {
                const props = dbf.properties(i), id = native(props);
                if (d.idFields.some(f => props[f] === '')) emptyIdentityRows++;
                if (byId.has(id)) throw fail('Parcel ZIP repeats a native composite ID.');
                byId.set(id, i);
            }
            const sink = shapeSink(rows); await member('shp', b, { sink }); sink.verify();
            const nullGeometryRows = [...rows.values()].filter(row => view(row).getUint32(0, true) === 0).length;
            cached = { ...meta, dbf, byId, rows, statistics: b, nullGeometryRows, emptyIdentityRows }; expires = now() + 300000; return cached;
        })().finally(() => { pending = null; });
        return pending;
    }
    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide 1–80 parcel IDs.');
        const wanted = new Map([...new Set(ids)].map(id => {
            if (typeof id !== 'string' || !id.startsWith(d.idPrefix)) throw new HttpError(400, 'Parcel ID belongs to another source.');
            const value = id.slice(d.idPrefix.length); validateNative(value); return [value, id];
        }));
        const warm = cached && now() < expires ? cached : pending ? await pending : null;
        const b = budget();
        if (warm) return result([...wanted.keys()].filter(id => warm.byId.has(id)).map(id => {
            const row = warm.byId.get(id); return canonical(warm.rows.get(row), warm.dbf.properties(row), warm.projection);
        }), b, { absentIds: [...wanted].filter(([id]) => !warm.byId.has(id)).map(([, id]) => id) });
        const meta = await metadata(b), found = new Map(); let checked = 0;
        await member('dbf', b, { until(bytes) {
            if (bytes.length < 33 || bytes.length < view(bytes).getUint16(8, true)) return false;
            const dbf = readShapefileDbf(bytes, { ...d, maxSnapshotFeatures: d.expectedSnapshotFeatures }, meta.cpg, { partial: true });
            while (checked < dbf.availableCount) {
                const props = dbf.properties(checked), id = native(props);
                if (wanted.has(id)) {
                    if (found.has(id)) throw fail('Parcel ZIP repeats a requested native ID.');
                    found.set(id, { row: checked, props });
                }
                checked++;
            }
            return found.size === wanted.size;
        } });
        if (found.size < wanted.size && checked !== d.expectedSnapshotFeatures) throw fail('Native ID enumeration is incomplete.');
        const rows = new Map();
        if (found.size) await member('shp', b, { sink: shapeSink(rows, new Set([...found.values()].map(x => x.row))) });
        return result([...found.values()].map(x => canonical(rows.get(x.row), x.props, meta.projection)), b,
            { absentIds: [...wanted].filter(([id]) => !found.has(id)).map(([, id]) => id) });
    }
    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide valid WGS84 polygon geometry.');
        const bounds = bbox(geometry); validateBounds(bounds, d.maxBboxKm2 || 25, d);
        const b = budget(), data = await fullIndex(b), target = [Infinity, Infinity, -Infinity, -Infinity], features = [];
        for (let i = 0; i <= 8; i++) for (const p of [
            [bounds[0] + (bounds[2] - bounds[0]) * i / 8, bounds[1]], [bounds[0] + (bounds[2] - bounds[0]) * i / 8, bounds[3]],
            [bounds[0], bounds[1] + (bounds[3] - bounds[1]) * i / 8], [bounds[2], bounds[1] + (bounds[3] - bounds[1]) * i / 8]]) {
            const q = data.projection.inverse(p);
            target[0] = Math.min(target[0], q[0] - 1); target[1] = Math.min(target[1], q[1] - 1);
            target[2] = Math.max(target[2], q[0] + 1); target[3] = Math.max(target[3], q[1] + 1);
        }
        for (const [row, record] of data.rows) {
            const v = view(record); if (v.getUint32(0, true) === 0) continue;
            const extent = [4, 12, 20, 28].map(pos => v.getFloat64(pos, true));
            if (!extent.every(Number.isFinite)) throw fail('Invalid native parcel envelope.');
            if (extent[0] > target[2] || extent[2] < target[0] || extent[1] > target[3] || extent[3] < target[1]) continue;
            const feature = canonical(record, data.dbf.properties(row), data.projection);
            if (booleanIntersects(feature, geometry)) features.push(feature);
            if (features.length > d.maxFeatures) throw fail('Parcel query exceeds feature limit.');
        }
        return result(features, b, { nullGeometryRows: data.nullGeometryRows, emptyIdentityRows: data.emptyIdentityRows });
    }
    function queryBounds(bounds) { validateBounds(bounds, d.maxBboxKm2 || 25, d); return queryGeometry(bboxPolygon(bounds).geometry); }
    return Object.freeze({ queryIds, queryBounds, queryGeometry });
}
