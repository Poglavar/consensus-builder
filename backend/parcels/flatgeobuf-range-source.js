// Spatial-index and exact-record HTTP ranges; never loads a prefecture snapshot.
import { bbox, booleanIntersects } from '@turf/turf';
import { flatgeobufLevels, readFlatgeobufHeader, readFlatgeobufFeature } from './flatgeobuf-reader.js';
import { sha256Hex } from './portable-hash.js';
import { canonicalParcelFeature, validateBounds, validateGeometry, upstreamError, providerHttpError } from './source-contract.js';
import { HttpError } from '../utils/helpers.js';
const MiB = 1024 ** 2, view = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
const SAFE_FIELDS = ['筆ID', '市区町村コード', '地図名', '地図番号', '精度区分', '座標値種別'];
const intersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const fail = message => upstreamError(message);
export function createFlatgeobufRangeParcelSource(input, { fetchImpl = globalThis.fetch } = {}) {
    const d = structuredClone(input), url = new URL(d.endpoint);
    if (!d.id || !d.idPrefix || url.protocol !== 'https:' || url.username || url.password
        || !/^"[\x21\x23-\x7e]+"$/.test(d.expectedEtag || '')
        || !Number.isSafeInteger(d.expectedSnapshotBytes) || d.expectedSnapshotBytes < 100
        || !Number.isSafeInteger(d.expectedSnapshotFeatures) || d.expectedSnapshotFeatures < 1
        || !Number.isSafeInteger(d.maxFeatures) || d.maxFeatures < 1 || d.maxFeatures > 10000
        || ![4326, 6668].includes(d.sourceSrid) || !Array.isArray(d.outFields)
        || d.outFields.some(f => !SAFE_FIELDS.includes(f)) || !d.outFields.includes('市区町村コード')
        || !/^\d{5}$/.test(d.municipalityCode || '')) throw new Error('Invalid FlatGeobuf parcel descriptor.');
    let metadataPromise;
    const budget = () => ({ bytes: 0, requests: 0, signal: AbortSignal.timeout(60000) });
    async function range(start, end, b) {
        if (![start, end].every(Number.isSafeInteger) || start < 0 || end < start || end >= d.expectedSnapshotBytes || end - start + 1 > 16 * MiB || ++b.requests > 250) throw fail('FlatGeobuf range budget exceeded.');
        const r = await fetchImpl(d.endpoint, { headers: { Accept: 'application/octet-stream', Range: `bytes=${start}-${end}`, 'If-Match': d.expectedEtag }, signal: b.signal });
        let reader;
        try {
            if (r.status !== 206) throw providerHttpError(r);
            if (r.headers.get('etag') !== d.expectedEtag || r.headers.get('content-range') !== `bytes ${start}-${end}/${d.expectedSnapshotBytes}`
                || r.headers.get('content-encoding') && r.headers.get('content-encoding') !== 'identity') throw fail('FlatGeobuf revision or range changed.');
            reader = r.body.getReader(); const result = new Uint8Array(end - start + 1); let size = 0;
            for (;;) {
                const part = await reader.read(); if (part.done) break;
                size += part.value.length; b.bytes += part.value.length;
                if (size > result.length || b.bytes > 16 * MiB) throw fail('FlatGeobuf actual byte budget exceeded.');
                result.set(part.value, size - part.value.length);
            }
            if (size !== result.length) throw fail('Truncated FlatGeobuf range.');
            return result;
        } finally {
            if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
            else await r.body?.cancel().catch(() => {});
        }
    }
    async function metadata(b) {
        if (!metadataPromise) metadataPromise = (async () => {
            const prefix = await range(0, 11, b);
            if (Array.from(prefix.slice(0, 8)).join() !== '102,103,98,3,102,103,98,1') throw fail('Unsupported FlatGeobuf magic.');
            const size = view(prefix).getUint32(8, true); if (size < 8 || size > 65536) throw fail('Invalid FlatGeobuf header size.');
            const bytes = await range(12, 11 + size, b), header = readFlatgeobufHeader(bytes);
            if (sha256Hex(bytes) !== d.expectedHeaderSha256 || header.crs !== d.sourceSrid || header.featuresCount !== d.expectedSnapshotFeatures) throw fail('FlatGeobuf header differs from verified release.');
            const levels = flatgeobufLevels(header.featuresCount, header.nodeSize), treeStart = size + 12;
            const dataStart = treeStart + levels.at(-1).end * 40;
            if (dataStart >= d.expectedSnapshotBytes) throw fail('Invalid FlatGeobuf index size.');
            return { header, levels, treeStart, dataStart };
        })().catch(e => { metadataPromise = undefined; throw e; });
        return metadataPromise;
    }
    function result(features, b, extra = {}) {
        return { type: 'FeatureCollection', features, sourceId: d.id, complete: true, returnsWGS84: true,
            statistics: { downloadedBytes: b.bytes, requests: b.requests }, ...extra };
    }
    function canonical(bytes, offset, m) {
        const f = readFlatgeobufFeature(bytes, m.header, d.outFields);
        if (String(f.properties['市区町村コード']) !== d.municipalityCode) return null;
        // Preserve all coordinates, nesting and rings. No normalization, rounding or repair.
        const hash = sha256Hex(JSON.stringify({ type: f.geometry.type, coordinates: f.geometry.coordinates }));
        const native = `g1~${offset}~${hash}`;
        const feature = canonicalParcelFeature(d, f, native);
        feature.properties.parcelIdentityKind = 'geometry-sha256-offset-v1';
        feature.properties.sourceGeometryHash = hash;
        return feature;
    }
    async function record(offset, b, m, length) {
        const start = m.dataStart + offset;
        if (start < m.dataStart || start + 4 > d.expectedSnapshotBytes) return null;
        let bytes;
        if (length) bytes = await range(start, start + length - 1, b);
        else {
            const prefix = await range(start, start + 3, b), n = view(prefix).getUint32(0, true);
            if (n < 8 || n > MiB || start + 4 + n > d.expectedSnapshotBytes) throw fail('Invalid FlatGeobuf record size.');
            bytes = await range(start, start + 3 + n, b);
        }
        if (bytes.length < 12 || view(bytes).getUint32(0, true) !== bytes.length - 4) throw fail('Invalid FlatGeobuf feature framing.');
        return canonical(bytes.subarray(4), offset, m);
    }
    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80 || ids.some(id => typeof id !== 'string' || !id.startsWith(d.idPrefix))) throw new HttpError(400, 'Provide 1–80 IDs from this parcel source.');
        const parsed = [...new Set(ids)].map(id => {
            const match = /^g1~(0|[1-9]\d{0,14})~([a-f0-9]{64})$/.exec(id.slice(d.idPrefix.length));
            if (!match || !Number.isSafeInteger(Number(match[1]))) throw new HttpError(400, 'Invalid geometry-derived parcel reference.');
            return { id, offset: Number(match[1]) };
        });
        const b = budget(), m = await metadata(b), features = [], absentIds = [];
        for (const p of parsed) {
            const f = await record(p.offset, b, m);
            if (f && f.id === p.id) features.push(f); else absentIds.push(p.id);
        }
        return result(features, b, { absentIds });
    }
    async function queryBounds(bounds) {
        validateBounds(bounds, d.maxBboxKm2 || 25, d);
        const b = budget(), m = await metadata(b), leaves = [];
        let ranges = [{ start: 0, end: 1 }];
        for (let level = 0; level < m.levels.length && ranges.length; level++) {
            const next = [], leaf = level === m.levels.length - 1;
            // Merge adjacent index ranges to avoid one network request per tree node.
            const merged = [];
            for (const r of ranges.sort((a, b) => a.start - b.start)) {
                const last = merged.at(-1);
                if (last && r.start <= last.end + 32 && r.end - last.start <= 16384) last.end = Math.max(last.end, r.end);
                else merged.push({ ...r });
            }
            for (const r of merged) {
                const readEnd = Math.min(r.end + (leaf ? 1 : 0), m.levels[level].end);
                const bytes = await range(m.treeStart + r.start * 40, m.treeStart + readEnd * 40 - 1, b), v = view(bytes);
                for (let index = r.start; index < r.end; index++) {
                    const p = (index - r.start) * 40, box = [0, 8, 16, 24].map(i => v.getFloat64(p + i, true));
                    if (!box.every(Number.isFinite)) throw fail('Invalid FlatGeobuf index envelope.');
                    if (!intersects(bounds, box)) continue;
                    const offset = Number(v.getBigUint64(p + 32, true)); if (!Number.isSafeInteger(offset)) throw fail('Invalid FlatGeobuf index offset.');
                    if (leaf) {
                        const end = index + 1 < m.levels[level].end ? Number(v.getBigUint64(p + 72, true)) : d.expectedSnapshotBytes - m.dataStart;
                        const length = end - offset;
                        if (!Number.isSafeInteger(length) || length < 12 || length > MiB) throw fail('Invalid FlatGeobuf index record length.');
                        leaves.push({ offset, length });
                        if (leaves.length > d.maxFeatures) throw fail('FlatGeobuf query exceeds feature budget; use smaller cells.');
                    } else {
                        const child = m.levels[level + 1];
                        if (offset < child.start || offset >= child.end) throw fail('Invalid FlatGeobuf child pointer.');
                        next.push({ start: offset, end: Math.min(offset + m.header.nodeSize, child.end) });
                    }
                }
            }
            ranges = next;
        }
        const features = [];
        // Batched feature ranges include only a small gap; source properties outside outFields are skipped.
        const groups = [];
        for (const l of leaves.sort((a, b) => a.offset - b.offset)) {
            const last = groups.at(-1), end = l.offset + l.length;
            if (last && l.offset <= last.end + 2048 && end - last.start <= 256 * 1024) { last.end = end; last.rows.push(l); }
            else groups.push({ start: l.offset, end, rows: [l] });
        }
        for (const g of groups) {
            const bytes = await range(m.dataStart + g.start, m.dataStart + g.end - 1, b);
            for (const l of g.rows) {
                const row = bytes.subarray(l.offset - g.start, l.offset - g.start + l.length);
                if (view(row).getUint32(0, true) !== l.length - 4) throw fail('FlatGeobuf feature framing differs from index.');
                const f = canonical(row.subarray(4), l.offset, m); if (f) features.push(f);
            }
        }
        return result(features, b);
    }
    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a WGS84 polygon.');
        const r = await queryBounds(bbox(geometry));
        return { ...r, features: r.features.filter(f => booleanIntersects(f.geometry, geometry)) };
    }
    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}
