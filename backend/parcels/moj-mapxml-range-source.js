// Selected, hash-pinned nested sheets of an official MOJ Map XML edition.
// Offsets are publication metadata, never a saved parcel cache or a geometry index.
import { bbox, bboxPolygon, booleanIntersects, feature } from '@turf/turf';
import { readBoundedZipMembers } from './shapefile-zip-reader.js';
import { parseMojMapXml } from './moj-mapxml-reader.js';
import { boundedBytes } from './gml-snapshot-source.js';
import { sha256Hex } from './portable-hash.js';
import { canonicalParcelFeature, upstreamError, providerHttpError, validateBounds, validateGeometry } from './source-contract.js';
import { HttpError } from '../utils/helpers.js';

const MIB = 1024 ** 2;
const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
export function createMojMapXmlRangeParcelSource(input, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    const d = structuredClone(input), rows = d.sheetIndex;
    const endpoint = new URL(d.endpoint);
    const resource = /^\/ckan\/dataset\/[a-f0-9-]+\/resource\/([a-f0-9-]+)\/download\/(\d{5}-\d{4}-\d{4}\.zip)$/.exec(endpoint.pathname);
    if (d.archiveAccess !== 'selected-range-v1' || !d.id || !d.idPrefix || !resource
        || endpoint.origin !== 'https://www.geospatial.jp' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password
        || !/^[a-f0-9]{64}$/.test(d.archiveSha256 || '') || !/^"[^"\r\n]+"$/.test(d.archiveEtag || '')
        || !Number.isSafeInteger(d.archiveBytes) || d.archiveBytes < 1 || !/^\d{5}$/.test(d.municipalityCode || '')
        || !['公共座標6系', '公共座標7系', '公共座標10系'].includes(d.coordinateSystem)
        || d.outFields?.length !== 1 || d.outFields[0] !== 'id' || !Array.isArray(rows) || !rows.length || rows.length > 512
        || !Number.isSafeInteger(d.maxFeatures) || d.maxFeatures < 1 || d.maxFeatures > 10000
        || rows.some(row => !/^\d{5}-\d{4}-\d+\.zip$/.test(row.zip) || row.zip.split('-')[0] !== d.municipalityCode
            || row.xml !== row.zip.replace(/\.zip$/, '.xml') || !/^[a-f0-9]{64}$/.test(row.sha256 || '')
            || ![row.rangeStart, row.rangeBytes, row.xmlBytes].every(Number.isSafeInteger)
            || row.rangeStart < 30 || row.rangeBytes < 1 || row.rangeBytes > 16 * MIB || row.xmlBytes < 1 || row.xmlBytes > 48 * MIB
            || row.rangeStart + row.rangeBytes > d.archiveBytes || row.rangeBytes + row.xmlBytes > 64 * MIB
            || !Array.isArray(row.bbox) || row.bbox.length !== 4 || !row.bbox.every(Number.isFinite)
            || row.bbox[0] >= row.bbox[2] || row.bbox[1] >= row.bbox[3])
        || new Set(rows.map(row => row.zip)).size !== rows.length) throw new Error('Invalid selected-range MOJ descriptor.');
    const sheets = new Map(), pending = new Map();
    let downloaded = 0, extracted = 0, allocated = 0, budgetExpires = 0;
    async function range(row) {
        const start = row.rangeStart, end = start + row.rangeBytes - 1;
        const signal = AbortSignal.timeout(45000);
        let url = endpoint;
        for (let hops = 0; hops <= 3; hops++) {
            const response = await fetchImpl(url.href, { signal, redirect: 'manual', headers: {
                Accept: 'application/zip', Range: `bytes=${start}-${end}`, 'If-Match': d.archiveEtag } });
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                const location = response.headers.get('location');
                await response.body?.cancel().catch(() => {});
                if (!location || hops === 3) throw upstreamError('MOJ range redirect limit exceeded.');
                const next = new URL(location, url);
                if (next.origin !== 'https://ckan-storage.s3.amazonaws.com' || next.username || next.password || next.hash
                    || next.pathname !== `/ckan/resources/${resource[1]}/${resource[2]}`) throw upstreamError('MOJ redirect left the pinned public resource.');
                url = next; continue;
            }
            try {
                if (response.status !== 206) throw providerHttpError(response);
                if (response.headers.get('etag') !== d.archiveEtag
                    || response.headers.get('content-range') !== `bytes ${start}-${end}/${d.archiveBytes}`
                    || response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') {
                    throw upstreamError('MOJ archive revision or range changed.');
                }
                const bytes = await boundedBytes(response, row.rangeBytes, signal);
                downloaded += bytes.length;
                if (downloaded + extracted > 64 * MIB || bytes.length !== row.rangeBytes || sha256Hex(bytes) !== row.sha256) {
                    throw upstreamError('MOJ selected sheet hash, length or aggregate budget changed.');
                }
                return bytes;
            } finally { await response.body?.cancel().catch(() => {}); }
        }
    }
    async function load(row) {
        // A cache generation has one budget, including concurrent reservations. Renew it
        // after expiry so a long-running production relay does not accumulate a lifetime quota.
        if (!pending.size && now() >= budgetExpires) {
            sheets.clear(); downloaded = 0; extracted = 0; allocated = 0; budgetExpires = now() + 300000;
        }
        const cached = sheets.get(row.xml);
        if (cached && now() < cached.expires) return cached;
        if (!pending.has(row.xml)) pending.set(row.xml, (async () => {
            const reservation = row.rangeBytes + row.xmlBytes;
            if (allocated + reservation > 64 * MIB) throw upstreamError('MOJ aggregate byte budget exceeded.');
            allocated += reservation;
            const bytes = await range(row);
            const xml = readBoundedZipMembers(bytes, { maxDecompressedBytes: row.xmlBytes, zipEncoding: 'utf-8' }, names => {
                if (names.length !== 1 || names[0] !== row.xml) throw upstreamError('MOJ nested member changed.');
                return { xml: row.xml };
            }).xml;
            extracted += xml.length;
            if (xml.length !== row.xmlBytes) throw upstreamError('MOJ extracted sheet length changed.');
            const parsed = parseMojMapXml(xml, row.xml, { expectedCoordinateSystem: d.coordinateSystem, municipalityCode: d.municipalityCode });
            const features = parsed.features.map(raw => {
                const native = `${row.zip.slice(0, -4)}-${raw.id.split('#')[1]}`;
                const canonical = canonicalParcelFeature(d, { geometry: raw.geometry, properties: {} }, native);
                const bounds = bbox(canonical);
                if (!overlaps(bounds, row.bbox) || bounds.some((v, i) => i < 2 ? v < row.bbox[i] - 1e-9 : v > row.bbox[i] + 1e-9)) {
                    throw upstreamError('MOJ sheet geometry left its verified envelope.');
                }
                return { feature: canonical, bbox: bounds };
            });
            const value = { features, metadata: parsed.metadata, expires: budgetExpires };
            sheets.set(row.xml, value); return value;
        })().finally(() => pending.delete(row.xml)));
        return pending.get(row.xml);
    }
    const collection = (features, extra = {}) => ({ type: 'FeatureCollection', sourceId: d.id, complete: true,
        returnsWGS84: true, snapshotId: d.archiveSha256, sourceDate: d.dataVersion,
        features: structuredClone(features), statistics: { downloadedBytes: downloaded, extractedBytes: extracted }, ...extra });
    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80 || ids.some(id => typeof id !== 'string' || !id.startsWith(d.idPrefix)
            || !/^\d{5}-\d{4}-\d+-H\d{9}$/.test(id.slice(d.idPrefix.length)))) throw new HttpError(400, 'Invalid MOJ composite parcel IDs.');
        const wanted = new Set(ids), names = new Set(ids.map(id => id.slice(d.idPrefix.length).replace(/-H\d{9}$/, '.zip')));
        const found = [];
        for (const row of rows.filter(row => names.has(row.zip))) {
            found.push(...(await load(row)).features.filter(item => wanted.has(item.feature.id)).map(item => item.feature));
        }
        return collection(found, { absentIds: [...wanted].filter(id => !found.some(item => item.id === id)) });
    }
    async function queryBounds(bounds) {
        validateBounds(bounds, d.maxBboxKm2 ?? 25, d);
        const target = bboxPolygon(bounds), found = [];
        // Sequential sheet loads keep actual extraction and download totals within one budget.
        for (const row of rows.filter(row => overlaps(row.bbox, bounds))) {
            found.push(...(await load(row)).features.filter(item => overlaps(item.bbox, bounds) && booleanIntersects(item.feature, target)).map(item => item.feature));
            if (found.length > d.maxFeatures) throw upstreamError('MOJ parcel query exceeds feature budget.');
        }
        return collection(found);
    }
    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide valid WGS84 polygon geometry.');
        const result = await queryBounds(bbox(geometry));
        return { ...result, features: result.features.filter(item => booleanIntersects(item, feature(geometry))) };
    }
    return Object.freeze({ queryIds, queryBounds, queryGeometry });
}
