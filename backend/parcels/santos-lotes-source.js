// Municipal PolygonZ lots: revision-bound ZIP ranges, safe LOTE references, no disk snapshots.
import { Inflate } from 'fflate';
import proj4 from 'proj4';
import { bbox, bboxPolygon, booleanIntersects, feature as turfFeature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { canonicalParcelFeature, upstreamError, providerHttpError, validateBounds, validateGeometry } from './source-contract.js';
import { concatBytes } from './byte-utils.js';
import { sha256Hex } from './portable-hash.js';
import { readShapefilePolygon, nativePolygonWkb } from './shapefile-zip-reader.js';

export const SANTOS_ENDPOINT = 'https://www.santos.sp.gov.br/static/files_www/files/portal_files/SEDURB/COINURB/Mapas_Aux/lotes_2026-sir.zip';
export const SANTOS_CRS = '+proj=utm +zone=23 +south +ellps=GRS80 +units=m +no_defs';
const fail = message => { throw upstreamError(message); };
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
    let n = i; for (let j = 0; j < 8; j++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0;
});
function crcUpdate(crc, bytes) { for (const b of bytes) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8); return crc; }

// Stream complete SHP records. Early exact-ID success cancels the compressed member immediately.
function shapeScanner(d, visit) {
    let pending = new Uint8Array(0), header = false, row = 0, total = 0, stopped = false;
    return {
        push(chunk) {
            if (stopped) return;
            pending = concatBytes([pending, chunk]); let offset = 0;
            if (!header) {
                if (pending.length < 100) return;
                const h = view(pending);
                if (h.getUint32(0) !== 9994 || h.getUint32(24) * 2 !== d.zipMembers.shp.bytes
                    || h.getUint32(28, true) !== 1000 || h.getUint32(32, true) !== 15) fail('Santos SHP header changed.');
                header = true; offset = 100; total = 100;
            }
            while (pending.length - offset >= 8) {
                const v = view(pending), length = v.getUint32(offset + 4) * 2;
                if (length < 44 || length > 32 * 1024 ** 2) fail('Santos SHP record exceeds limits.');
                if (pending.length - offset < length + 8) break;
                if (v.getUint32(offset) !== row + 1 || row >= d.expectedSnapshotFeatures) fail('Santos SHP row sequence changed.');
                const record = pending.subarray(offset + 8, offset + 8 + length);
                stopped = visit(record, row++) === true;
                total += length + 8; offset += length + 8;
                if (stopped) break;
            }
            pending = pending.slice(offset);
            if (pending.length > 32 * 1024 ** 2) fail('Santos SHP pending record exceeds limits.');
        },
        get stopped() { return stopped; },
        finish() { if (!header || pending.length || row !== d.expectedSnapshotFeatures || total !== d.zipMembers.shp.bytes) fail('Santos SHP stream is incomplete.'); }
    };
}

// Decode exactly one public reference column; never decode neighbourhood or other attributes.
export function santosLotReferences(bytes, expectedCount, rows = expectedCount) {
    const v = view(bytes), count = v.getUint32(4, true), header = v.getUint16(8, true), width = v.getUint16(10, true);
    if (bytes[0] !== 3 || count !== expectedCount || header < 33 || (header - 33) % 32
        || bytes[header - 1] !== 13 || rows < 1 || rows > count || bytes.length < header + rows * width
        || rows === count && (header + count * width + 1 !== bytes.length || bytes.at(-1) !== 26)) fail('Santos DBF envelope changed.');
    let cursor = 1, lot;
    for (let i = 32; i < header - 1; i += 32) {
        const name = new TextDecoder('ascii').decode(bytes.subarray(i, i + 11)).split('\0')[0];
        const length = bytes[i + 16];
        if (name === 'LOTE') {
            if (lot || bytes[i + 11] !== 78 || bytes[i + 17] !== 0 || length > 16) fail('Santos LOTE schema changed.');
            lot = { offset: cursor, length };
        }
        cursor += length;
    }
    if (!lot || cursor !== width) fail('Santos LOTE schema missing.');
    return Array.from({ length: rows }, (_, i) => {
        const start = header + i * width;
        if (bytes[start] !== 32) fail('Santos DBF deleted row requires review.');
        const value = new TextDecoder('ascii').decode(bytes.subarray(start + lot.offset, start + lot.offset + lot.length)).trim();
        if (!value || /^\*+$/.test(value)) return 'NULL';
        if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) fail('Invalid Santos LOTE value.');
        return String(Number(value));
    });
}

export function createSantosLotesSource(d, { fetchImpl = fetch } = {}) {
    if (d.id !== 'br-santos-prefeitura-mapa-lotes-2026' || d.endpoint !== SANTOS_ENDPOINT
        || d.sourceCrs !== 'EPSG:31983' || d.idPrefix !== 'BR-SANTOS-MAPA-LOTES-2026:LOTE:'
        || d.expectedArchiveBytes !== 4046406 || d.expectedSnapshotFeatures !== 44278
        || d.expectedEtag !== '"3dbe46-64caca3bb0900"' || d.outFields?.join() !== 'LOTE'
        || !Number.isSafeInteger(d.maxFeatures) || d.maxFeatures < 1 || d.maxFeatures > 10000
        || !Number.isSafeInteger(d.maxRecordPoints) || d.maxRecordPoints < 4 || d.maxRecordPoints > 1000000
        || !/^[a-f0-9]{64}$/.test(d.prjSha256 || '')
        || !d.zipMembers || ['shp','dbf','prj'].some(kind => {
            const m = d.zipMembers[kind];
            return !m || m.name !== `LOTES_2026-SIR.${kind}` || ![m.localOffset,m.dataOffset,m.compressedBytes,m.bytes,m.crc].every(Number.isSafeInteger)
                || m.localOffset < 0 || m.dataOffset <= m.localOffset + 30 || m.dataOffset > m.localOffset + 4096
                || m.compressedBytes < 1 || m.compressedBytes > 16 * 1024 ** 2 || m.bytes < 1 || m.bytes > 16 * 1024 ** 2
                || m.dataOffset + m.compressedBytes > d.expectedArchiveBytes;
        })) throw new Error('Invalid verified Santos lot descriptor.');
    const projection = proj4(SANTOS_CRS, 'EPSG:4326');
    let metadata, metadataRows = 0, projectionPending, fullShape, fullPending;
    const statistics = { actualStreamedBytes: 0, actualInflatedBytes: 0, cancelledAfterExactMatch: 0 };
    async function member(kind, consume, shouldStop = () => false, retain = false) {
        const m = d.zipMembers[kind], end = m.dataOffset + m.compressedBytes - 1;
        const response = await fetchImpl(d.endpoint, { signal: AbortSignal.timeout(45000), headers: {
            Accept: 'application/zip', Range: `bytes=${m.localOffset}-${end}`, 'If-Match': d.expectedEtag
        } });
        if (!response.ok) { await response.body?.cancel(); throw providerHttpError(response); }
        if (response.status !== 206 || response.headers.get('etag') !== d.expectedEtag
            || response.headers.get('content-range') !== `bytes ${m.localOffset}-${end}/${d.expectedArchiveBytes}`
            || response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') {
            await response.body?.cancel(); fail('Santos archive range or revision changed.');
        }
        const reader = response.body?.getReader(); if (!reader) fail('Santos archive has no readable body.');
        let prefix = new Uint8Array(0), received = 0, inflated = 0, crc = 0xffffffff, completed = false, checked = false;
        const chunks = [];
        const inflater = new Inflate((chunk, final) => {
            inflated += chunk.length; statistics.actualInflatedBytes += chunk.length;
            if (inflated > m.bytes) fail('Santos ZIP member exceeds inflation budget.');
            crc = crcUpdate(crc, chunk); if (retain) chunks.push(chunk); consume?.(chunk); completed = final;
        });
        try {
            for (;;) {
                const part = await reader.read(); if (part.done) break;
                received += part.value.length; statistics.actualStreamedBytes += part.value.length;
                if (received > end - m.localOffset + 1 || received > 16 * 1024 ** 2) fail('Santos range exceeds streamed byte budget.');
                let data = part.value;
                if (!checked) {
                    prefix = concatBytes([prefix, data]);
                    const size = m.dataOffset - m.localOffset;
                    if (prefix.length < size) continue;
                    const v = view(prefix), nameLength = v.getUint16(26, true);
                    if (v.getUint32(0, true) !== 0x04034b50 || v.getUint16(8, true) !== 8
                        || v.getUint16(6, true) & ~0x080e || 30 + nameLength + v.getUint16(28, true) !== size
                        || new TextDecoder().decode(prefix.subarray(30, 30 + nameLength)) !== m.name) fail('Santos ZIP local header changed.');
                    data = prefix.subarray(size); checked = true; prefix = null;
                }
                for (let offset = 0; offset < data.length; offset += 1024) {
                    inflater.push(data.subarray(offset, offset + 1024), false);
                    if (shouldStop()) { statistics.cancelledAfterExactMatch++; return null; }
                }
            }
            inflater.push(new Uint8Array(0), true);
            if (!checked || !completed || received !== end - m.localOffset + 1 || inflated !== m.bytes
                || ((crc ^ 0xffffffff) >>> 0) !== m.crc) fail('Santos member length or CRC disagrees.');
            return retain ? concatBytes(chunks, inflated) : null;
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    async function ensureProjection() {
        if (!projectionPending) projectionPending = member('prj', null, undefined, true).then(prj => {
            if (sha256Hex(prj) !== d.prjSha256) fail('Santos source projection changed.');
        }).catch(error => { projectionPending = null; throw error; });
        return projectionPending;
    }
    async function prepare(rows = d.expectedSnapshotFeatures) {
        await ensureProjection();
        if (metadata && metadataRows >= rows) return metadata;
        const chunks = []; let length = 0, required = Infinity;
        await member('dbf', chunk => {
            chunks.push(chunk); length += chunk.length;
            if (required === Infinity && length >= 32) {
                const header = view(concatBytes(chunks,length));
                required = header.getUint16(8,true) + rows * header.getUint16(10,true);
            }
        }, () => rows < d.expectedSnapshotFeatures && length >= required);
        const result = santosLotReferences(concatBytes(chunks,length),d.expectedSnapshotFeatures,rows);
        if (rows > metadataRows) { metadata = result; metadataRows = rows; }
        return result;
    }
    function parsed(record) { return readShapefilePolygon(view(record), 0, record.length, projection, d); }
    function canonical(record, lot) {
        const p = parsed(record), hash = sha256Hex(nativePolygonWkb(p.nativeGeometry));
        const native = `${lot}:GEOMSHA256:${hash}`;
        return canonicalParcelFeature(d, { properties: lot === 'NULL' ? {} : { LOTE: Number(lot) }, geometry: p.geometry }, native);
    }
    function collection(features, extra = {}) {
        if (features.length > d.maxFeatures) fail('Santos parcel query exceeds feature limit.');
        return { type: 'FeatureCollection', complete: true, sourceId: d.id, returnsWGS84: true, features,
            sourceRevision: d.expectedEtag, readStatistics: { ...statistics }, ...extra };
    }
    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80 || ids.some(id => typeof id !== 'string'
            || !id.startsWith(d.idPrefix) || !/^(?:0|-?[1-9]\d*|NULL):GEOMSHA256:[a-f0-9]{64}$/.test(id.slice(d.idPrefix.length)))) throw new HttpError(400, 'Invalid Santos parcel IDs.');
        // A release-specific row hint is only a seek accelerator, never the parcel identity.
        // Both native LOTE and native WKB hash are verified after every hinted read.
        const hints = ids.map(id => d.exactReadHints?.[id]);
        const rows = hints.every(row => Number.isSafeInteger(row) && row >= 0 && row < d.expectedSnapshotFeatures)
            ? Math.max(...hints) + 1 : d.expectedSnapshotFeatures;
        const lots = await prepare(rows), requested = new Set(ids), found = new Map();
        const wantedLots = new Set(ids.map(id => id.slice(d.idPrefix.length).split(':')[0]));
        const scanner = shapeScanner(d, (record, row) => {
            if (wantedLots.has(lots[row])) {
                const feature = canonical(record, lots[row]);
                if (requested.has(feature.id)) found.set(feature.id, feature);
            }
            return requested.size === found.size;
        });
        if (fullShape) scanner.push(fullShape);
        else await member('shp', chunk => scanner.push(chunk), () => scanner.stopped);
        if (!scanner.stopped) scanner.finish();
        if (rows < d.expectedSnapshotFeatures && found.size !== requested.size) fail('Santos verified row hint no longer matches its exact reference.');
        return collection([...found.values()], { absentIds: [...requested].filter(id => !found.has(id)) });
    }
    async function shape() {
        if (fullShape) return fullShape;
        if (!fullPending) fullPending = member('shp', null, undefined, true).then(bytes => { fullShape = bytes; return bytes; })
            .finally(() => { fullPending = null; });
        return fullPending;
    }
    async function intersect(geometry, bounds) {
        await ensureProjection();
        const bytes = await shape(), features = new Map(), selected = [];
        // Sample all four bbox edges before transforming: no fitted offset or clipping.
        const nativeBounds = [Infinity,Infinity,-Infinity,-Infinity];
        for (let i = 0; i <= 16; i++) for (const point of [
            [bounds[0] + (bounds[2]-bounds[0])*i/16,bounds[1]], [bounds[0] + (bounds[2]-bounds[0])*i/16,bounds[3]],
            [bounds[0],bounds[1] + (bounds[3]-bounds[1])*i/16], [bounds[2],bounds[1] + (bounds[3]-bounds[1])*i/16]]) {
            const p = projection.inverse(point); nativeBounds[0] = Math.min(nativeBounds[0],p[0]); nativeBounds[1] = Math.min(nativeBounds[1],p[1]);
            nativeBounds[2] = Math.max(nativeBounds[2],p[0]); nativeBounds[3] = Math.max(nativeBounds[3],p[1]);
        }
        const target = turfFeature(geometry);
        const scanner = shapeScanner(d, (record, row) => {
            const v = view(record);
            if (v.getUint32(0,true) !== 15) fail('Santos SHP contains a non-PolygonZ row.');
            const extent = [8,16,24,32].map(pos => v.getFloat64(pos - 4,true));
            if (!extent.every(Number.isFinite)) fail('Santos parcel extent is invalid.');
            if (extent[0] > nativeBounds[2] || extent[2] < nativeBounds[0] || extent[1] > nativeBounds[3] || extent[3] < nativeBounds[1]) return;
            selected.push({ record, row });
        });
        scanner.push(bytes); scanner.finish();
        if (selected.length) {
            const lots = await prepare(Math.max(...selected.map(item => item.row)) + 1);
            for (const { record, row } of selected) {
                const feature = canonical(record,lots[row]);
                if (booleanIntersects(feature,target)) features.set(feature.id,feature);
                if (features.size > d.maxFeatures) fail('Santos parcel query exceeds feature limit.');
            }
        }
        return collection([...features.values()]);
    }
    function queryBounds(bounds) { validateBounds(bounds,d.maxBboxKm2 ?? 25,d); return intersect(bboxPolygon(bounds).geometry,bounds); }
    function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400,'Provide valid WGS84 polygon geometry.');
        const bounds = bbox(turfFeature(geometry)); validateBounds(bounds,d.maxBboxKm2 ?? 25,d); return intersect(geometry,bounds);
    }
    return Object.freeze({ queryIds, queryBounds, queryGeometry });
}

// The fixed-source relay owns the ephemeral member cache; browsers receive safe polygons only.
export function createSantosBrowserSource(d, { fetchImpl = fetch } = {}) {
    return Object.freeze(Object.fromEntries(['queryIds','queryBounds','queryGeometry'].map(operation => [operation, async input => {
        const response = await fetchImpl(d.endpoint, { method:'POST', headers:{'Content-Type':'application/json'},
            body:JSON.stringify({_santosOperation:operation,input}) });
        if (!response.ok) throw providerHttpError(response);
        const reader = response.body.getReader(), chunks = []; let total = 0;
        try { for (;;) { const p = await reader.read(); if (p.done) break; total += p.value.length;
            if (total > 16*1024**2) fail('Santos browser result exceeds byte limit.'); chunks.push(p.value); }
        } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
        const result = JSON.parse(new TextDecoder().decode(concatBytes(chunks,total)));
        if (result.type !== 'FeatureCollection' || result.complete !== true || result.sourceId !== d.id
            || !Array.isArray(result.features) || result.features.length > d.maxFeatures) fail('Invalid Santos browser result.');
        return result;
    }])));
}
