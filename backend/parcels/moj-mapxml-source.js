// Live pinned official nested ZIP; sheet envelopes route reads, never substitute saved polygons.
import { bbox, bboxPolygon, booleanIntersects, feature } from '@turf/turf';
import { readBoundedZipMembers } from './shapefile-zip-reader.js';
import { parseMojMapXml } from './moj-mapxml-reader.js';
import { boundedBytes } from './gml-snapshot-source.js';
import { sha256Hex } from './portable-hash.js';
import { canonicalParcelFeature, upstreamError, areaLimitError, providerHttpError, validateBounds, validateGeometry } from './source-contract.js';
import { HttpError } from '../utils/helpers.js';
import { createMojMapXmlRangeParcelSource } from './moj-mapxml-range-source.js';

const intersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
export function createMojMapXmlParcelSource(descriptor, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    if (descriptor.archiveAccess === 'selected-range-v1') return createMojMapXmlRangeParcelSource(descriptor, { fetchImpl, now });
    const { id, idPrefix, endpoint, sheetIndex, archiveSha256 } = descriptor;
    if (!id || !idPrefix || new URL(endpoint).protocol !== 'https:' || !/^[a-f0-9]{64}$/.test(archiveSha256)
        || !Array.isArray(sheetIndex) || !sheetIndex.length || sheetIndex.length > 512
        || descriptor.outFields?.length !== 1 || descriptor.outFields[0] !== 'id'
        || sheetIndex.some(row => !/^\d{5}-\d{4}-\d+\.zip$/.test(row.zip) || row.xml !== row.zip.replace(/\.zip$/, '.xml')
            || !Array.isArray(row.bbox) || row.bbox.length !== 4 || !row.bbox.every(Number.isFinite))
        || new Set(sheetIndex.map(row => row.xml)).size !== sheetIndex.length) throw new Error('Invalid Ministry of Justice Map XML descriptor.');
    let pending, archive, expires = 0;
    const sheets = new Map();
    async function load() {
        if (archive && now() < expires) return archive;
        if (pending) return pending;
        archive = null; sheets.clear();
        pending = (async () => {
            const signal = AbortSignal.timeout(60000);
            const response = await fetchImpl(endpoint, { signal, redirect: 'follow', headers: { Accept: 'application/zip' } });
            if (!response.ok) throw providerHttpError(response);
            const bytes = await boundedBytes(response, descriptor.maxSnapshotBytes ?? 40 * 1024 * 1024, signal);
            if (sha256Hex(bytes) !== archiveSha256) throw upstreamError('Ministry of Justice archive edition changed; refresh its sheet index.');
            archive = bytes; expires = now() + 300000; return bytes;
        })();
        try { return await pending; } finally { pending = null; }
    }
    async function read(rows) {
        const bytes = await load();
        const missing = rows.filter(row => !sheets.has(row.xml));
        if (missing.length) {
            const members = readBoundedZipMembers(bytes, { maxDecompressedBytes: 64 * 1024 * 1024, zipEncoding: 'utf-8' },
                () => Object.fromEntries(missing.map(row => [row.zip, row.zip])));
            for (const row of missing) {
                const xml = readBoundedZipMembers(members[row.zip], { maxDecompressedBytes: 48 * 1024 * 1024, zipEncoding: 'utf-8' },
                    names => { if (names.length !== 1 || names[0] !== row.xml) throw upstreamError('Map XML sheet member changed.'); return { xml: row.xml }; }).xml;
                const parsed = parseMojMapXml(xml, row.xml);
                const features = parsed.features.map(raw => ({ feature: canonicalParcelFeature(descriptor, raw, raw.id), bbox: bbox(raw) }));
                sheets.set(row.xml, features);
            }
        }
        return rows.flatMap(row => sheets.get(row.xml));
    }
    const collection = features => ({ type: 'FeatureCollection', features: structuredClone(features), complete: true, sourceId: id,
        returnsWGS84: true, snapshotId: archiveSha256, sourceDate: '2025' });
    async function queryBounds(bounds) {
        validateBounds(bounds, descriptor.maxBboxKm2 ?? 25, descriptor);
        const rows = sheetIndex.filter(row => intersects(row.bbox, bounds));
        const candidates = rows.length ? await read(rows) : [];
        const polygon = bboxPolygon(bounds);
        const features = candidates.filter(row => intersects(row.bbox, bounds) && booleanIntersects(row.feature, polygon)).map(row => row.feature);
        if (features.length > (descriptor.maxFeatures ?? 10000)) throw areaLimitError('Map XML query exceeds the parcel limit; use smaller cells.');
        return collection(features);
    }
    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80 || ids.some(value => typeof value !== 'string' || !value.startsWith(idPrefix)
            || !/^\d{5}-\d{4}-\d+\.xml#H\d{9}$/.test(value.slice(idPrefix.length)))) throw new HttpError(400, 'Invalid Ministry of Justice parcel IDs.');
        const wanted = new Set(ids), names = new Set(ids.map(value => value.slice(idPrefix.length).split('#')[0]));
        const rows = sheetIndex.filter(row => names.has(row.xml));
        const found = (await read(rows)).filter(row => wanted.has(row.feature.id)).map(row => row.feature);
        return { ...collection(found), absentIds: [...wanted].filter(value => !found.some(row => row.id === value)) };
    }
    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide valid polygon geometry.');
        const result = await queryBounds(bbox(geometry));
        return { ...result, features: result.features.filter(row => booleanIntersects(row, feature(geometry))) };
    }
    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}
