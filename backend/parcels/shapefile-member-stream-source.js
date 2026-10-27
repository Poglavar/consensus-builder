// Select only parcel SHP/PRJ members from municipal ZIP streams; never decode DBF attributes.
import { Unzip, UnzipInflate } from 'fflate';
import proj4 from 'proj4';
import { bbox, bboxPolygon, booleanIntersects } from '@turf/turf';
import { concatBytes } from './byte-utils.js';
import { sha256Hex } from './portable-hash.js';
import { readShapefilePolygon, verifiedProjection, SHAPEFILE_CRS } from './shapefile-zip-reader.js';
import { canonicalParcelFeature, validateBounds, validateGeometry, upstreamError, providerHttpError } from './source-contract.js';
import { HttpError } from '../utils/helpers.js';

const MiB = 1024 ** 2, view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
// Exclude record framing and the redundant envelope; hash exact part counts, starts and XY ordinates.
export const nativeShapePartsHash = record => sha256Hex(record.subarray(36));

export function createShapefileMemberStreamSource(input, { fetchImpl = fetch } = {}) {
    const d = structuredClone(input), fail = message => upstreamError(message);
    if (!d.id || d.idPrefix !== `${d.id}/native-shp-parts-sha256-v1/` || d.sourceCrs !== 'EPSG:6677'
        || !Array.isArray(d.outFields) || d.outFields.length || !Array.isArray(d.snapshots) || !d.snapshots.length
        || d.snapshots.length > 7 || d.snapshots[0].endpoint !== d.endpoint
        || new Set(d.snapshots.map(s => s.key)).size !== d.snapshots.length
        || !Number.isSafeInteger(d.maxFeatures) || d.maxFeatures < 1 || d.maxFeatures > 10000
        || d.snapshots.some(s => {
            let u; try { u = new URL(s.endpoint); } catch { return true; }
            return u.protocol !== 'https:' || u.username || u.password || !/^\d{2}$/.test(s.key)
                || !Number.isSafeInteger(s.bytes) || s.bytes < 1 || s.bytes > 16 * MiB
                || !Number.isSafeInteger(s.records) || s.records < 1 || s.records > 1000000
                || s.shp !== `${s.key}_地番図${s.key}/筆界線${s.key}.shp`
                || s.prj !== s.shp.replace(/\.shp$/, '.prj')
                || !Array.isArray(s.nativeBbox) || s.nativeBbox.length !== 4 || !s.nativeBbox.every(Number.isFinite);
        })) throw new Error('Invalid selective Shapefile stream descriptor.');
    const projection = proj4(SHAPEFILE_CRS[d.sourceCrs], 'EPSG:4326');
    const indexes = new Map(), pending = new Map();
    function canonical(record, key) {
        const { geometry } = readShapefilePolygon(view(record), 0, record.length, projection, { maxRecordPoints: 100000 });
        return canonicalParcelFeature(d, { geometry, properties: {} }, `${key}/${nativeShapePartsHash(record)}`);
    }
    function budget() { return { downloadedBytes: 0, extractedBytes: 0, resources: [], signal: AbortSignal.timeout(90000) }; }
    function check(b) {
        if (b.downloadedBytes + b.extractedBytes > 64 * MiB) throw fail('Selected parcel members exceed the actual 64 MiB download/extraction budget.');
    }
    async function scan(s, b, wanted = null, signal) {
        const r = await fetchImpl(s.endpoint, { signal: signal ? AbortSignal.any([b.signal, signal]) : b.signal,
            headers: { Accept: 'application/zip' } });
        let reader;
        const stop = Symbol('bounded parcel read finished');
        try {
            if (!r.ok || r.status !== 200) throw providerHttpError(r);
            if (r.url && new URL(r.url).protocol !== 'https:') throw fail('Parcel ZIP redirected outside HTTPS.');
            if (r.headers.get('content-length') !== String(s.bytes)) throw fail('Parcel ZIP release length changed.');
            reader = r.body.getReader();
            let downloaded = 0, buffer = new Uint8Array(0), header = false, count = 0, shpBytes = 0, expectedBytes = 0;
            let prj, seenShp = false, prjDone = false;
            const rows = new Map(), found = new Map();
            const unzip = new Unzip(file => {
                if (![s.shp, s.prj].includes(file.name)) return; // Unselected members are never inflated or decoded.
                if (file.name === s.prj) {
                    if (prj) throw fail('Repeated parcel projection member.');
                    prj = new Uint8Array(0);
                    file.ondata = (error, chunk, final) => {
                        if (error) throw error;
                        b.extractedBytes += chunk.length; check(b);
                        if (prj.length + chunk.length > 16384) throw fail('Parcel projection exceeds metadata budget.');
                        prj = concatBytes([prj, chunk]);
                        if (final) { verifiedProjection(prj, d.sourceCrs); prjDone = true; }
                    };
                } else {
                    if (seenShp || !prjDone) throw fail('Parcel member order or projection changed.');
                    seenShp = true;
                    file.ondata = (error, chunk, final) => {
                        if (error) throw error;
                        shpBytes += chunk.length; b.extractedBytes += chunk.length; check(b);
                        buffer = concatBytes([buffer, chunk]); let pos = 0;
                        if (!header && buffer.length >= 100) {
                            const h = view(buffer); expectedBytes = h.getUint32(24) * 2;
                            if (h.getUint32(0) !== 9994 || h.getUint32(28, true) !== 1000 || h.getUint32(32, true) !== 5
                                || expectedBytes < 100 || expectedBytes > 64 * MiB) throw fail('Invalid parcel SHP header.');
                            header = true; pos = 100;
                        }
                        if (header) while (pos + 8 <= buffer.length) {
                            const h = view(buffer), size = h.getUint32(pos + 4) * 2;
                            if (size < 4 || size > 2 * MiB || h.getUint32(pos) !== count + 1) throw fail('Invalid parcel record framing.');
                            if (pos + 8 + size > buffer.length) break;
                            if (++count > s.records) throw fail('Excess parcel records.');
                            const record = buffer.slice(pos + 8, pos + 8 + size), v = view(record);
                            if (v.getUint32(0, true) === 5 && size >= 44) {
                                const hash = nativeShapePartsHash(record);
                                if (!wanted) rows.set(hash, record);
                                else if (wanted.has(hash)) {
                                    found.set(hash, record);
                                    if (found.size === wanted.size) throw stop;
                                }
                            } else if (v.getUint32(0, true) !== 0) throw fail('Non-polygon parcel record.');
                            pos += size + 8;
                        }
                        buffer = buffer.slice(pos);
                        if (buffer.length > 2 * MiB + 8) throw fail('Parcel record exceeds memory limit.');
                        if (final) {
                            if (!header || buffer.length || count !== s.records || shpBytes !== expectedBytes) throw fail('Incomplete parcel SHP member.');
                            throw stop; // No label, line, DBF, SHX or other archive member is needed.
                        }
                    };
                }
                file.start();
            });
            unzip.register(UnzipInflate);
            try {
                for (;;) {
                    const part = await reader.read(); if (part.done) break;
                    downloaded += part.value.length; b.downloadedBytes += part.value.length; check(b);
                    if (downloaded > s.bytes || downloaded > 16 * MiB) throw fail('Parcel ZIP exceeds its actual stream limit.');
                    // Bound inflater output and stop promptly after exact records.
                    for (let i = 0; i < part.value.length; i += 1024) unzip.push(part.value.subarray(i, i + 1024), false);
                }
                throw fail('Required parcel member is missing or truncated.');
            } catch (error) { if (error !== stop) throw error; }
            b.resources.push({ key: s.key, recordsRead: count, memberBytes: shpBytes, expectedMemberBytes: expectedBytes, downloadedBytes: downloaded });
            return wanted ? found : rows;
        } finally {
            if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
            else await r.body?.cancel().catch(() => {});
        }
    }
    async function index(s, b, signal) {
        signal?.throwIfAborted();
        if (indexes.has(s.key)) return indexes.get(s.key);
        if (!pending.has(s.key)) {
            const entry = { controller: new AbortController(), users: 0 };
            entry.promise = scan(s, b, null, entry.controller.signal).then(rows => {
                indexes.set(s.key, rows); return rows;
            }).finally(() => { if (pending.get(s.key) === entry) pending.delete(s.key); });
            pending.set(s.key, entry);
        }
        const entry = pending.get(s.key);
        entry.users++;
        let cancel;
        try {
            return await Promise.race([entry.promise, new Promise((_, reject) => {
                cancel = () => reject(signal.reason);
                signal?.addEventListener('abort', cancel, { once: true });
                if (signal?.aborted) cancel();
            })]);
        } finally {
            signal?.removeEventListener('abort', cancel);
            // Viewport cells share one live scan. Cancel it only after its last reader
            // leaves; a superseded viewport must not finish downloading unused shards.
            if (--entry.users === 0 && pending.get(s.key) === entry) {
                pending.delete(s.key);
                entry.controller.abort();
            }
        }
    }
    function result(features, b, extra = {}) {
        if (features.length > d.maxFeatures) throw fail('Parcel query exceeds feature limit.');
        return { type: 'FeatureCollection', sourceId: d.id, returnsWGS84: true, complete: true, features,
            statistics: { downloadedBytes: b.downloadedBytes, extractedBytes: b.extractedBytes, resources: b.resources }, ...extra };
    }
    async function queryIds(ids, { signal } = {}) {
        signal?.throwIfAborted();
        if (!Array.isArray(ids) || !ids.length || ids.length > 80 || ids.some(id => typeof id !== 'string'
            || !id.startsWith(d.idPrefix) || !/^\d{2}\/[a-f0-9]{64}$/.test(id.slice(d.idPrefix.length))
            || !d.snapshots.some(s => id.slice(d.idPrefix.length).startsWith(`${s.key}/`)))) throw new HttpError(400, 'Invalid source geometry IDs.');
        const unique = [...new Set(ids)], features = [], absentIds = [], b = budget();
        for (const s of d.snapshots) {
            const prefix = `${d.idPrefix}${s.key}/`, selected = unique.filter(id => id.startsWith(prefix));
            if (!selected.length) continue;
            const rows = pending.has(s.key) ? await index(s, b, signal) : indexes.get(s.key)
                || await scan(s, b, new Set(selected.map(id => id.slice(prefix.length))), signal);
            for (const id of selected) {
                const record = rows.get(id.slice(prefix.length));
                if (record) features.push(canonical(record, s.key)); else absentIds.push(id);
            }
        }
        return result(features, b, { absentIds });
    }
    async function queryGeometry(geometry, { signal } = {}) {
        signal?.throwIfAborted();
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide valid WGS84 polygon geometry.');
        const bounds = bbox(geometry); validateBounds(bounds, d.maxBboxKm2 || 25, d);
        const target = [Infinity, Infinity, -Infinity, -Infinity];
        for (let i = 0; i <= 8; i++) for (const p of [[bounds[0]+(bounds[2]-bounds[0])*i/8,bounds[1]],
            [bounds[0]+(bounds[2]-bounds[0])*i/8,bounds[3]], [bounds[0],bounds[1]+(bounds[3]-bounds[1])*i/8],
            [bounds[2],bounds[1]+(bounds[3]-bounds[1])*i/8]]) {
            const q = projection.inverse(p);
            target[0]=Math.min(target[0],q[0]-1); target[1]=Math.min(target[1],q[1]-1);
            target[2]=Math.max(target[2],q[0]+1); target[3]=Math.max(target[3],q[1]+1);
        }
        const b = budget(), features = [];
        for (const s of d.snapshots.filter(s => overlaps(s.nativeBbox, target))) {
            const rows = await index(s, b, signal);
            for (const record of rows.values()) {
                const v = view(record), envelope = [4,12,20,28].map(p => v.getFloat64(p,true));
                if (!overlaps(envelope,target)) continue;
                const feature = canonical(record,s.key);
                if (booleanIntersects(feature,geometry)) features.push(feature);
                if (features.length > d.maxFeatures) throw fail('Parcel query exceeds feature limit.');
            }
        }
        return result(features,b);
    }
    function queryBounds(bounds, options) { validateBounds(bounds,d.maxBboxKm2 || 25,d); return queryGeometry(bboxPolygon(bounds).geometry, options); }
    return Object.freeze({ queryIds, queryBounds, queryGeometry });
}
