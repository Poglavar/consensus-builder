// Anonymous SuperMap map queries with safe native IDs and unchanged REGION rings.
import { bbox as geometryBbox, booleanIntersects, booleanPointInPolygon, feature, point, polygon } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

export function supermapRegionGeometry(region) {
    const { points, parts, partTopo } = region || {};
    if (region?.type !== 'REGION' || !Array.isArray(points) || !Array.isArray(parts) || !parts.length
        || !Array.isArray(partTopo) || partTopo.length !== parts.length || partTopo.some(t => t !== 1 && t !== -1)
        || parts.some(n => !Number.isSafeInteger(n) || n < 4) || parts.reduce((a, b) => a + b, 0) !== points.length) {
        throw upstreamError('SuperMap returned unsupported REGION topology.');
    }
    let offset = 0;
    const rings = parts.map(n => {
        const ring = points.slice(offset, offset += n).map(p => [p.x, p.y]);
        if (!validateGeometry({ type: 'Polygon', coordinates: [ring] })) throw upstreamError('SuperMap returned an invalid ring.');
        return ring;
    });
    const shells = rings.flatMap((ring, i) => partTopo[i] === 1 ? [{ ring, holes: [] }] : []);
    const ringArea = ring => Math.abs(ring.slice(1).reduce((sum, p, i) => sum + ring[i][0] * p[1] - p[0] * ring[i][1], 0));
    for (let i = 0; i < rings.length; i++) if (partTopo[i] === -1) {
        const hole = rings[i];
        // Provider order need not put a hole immediately after its shell. Attach it to the
        // smallest containing island, preserving nested islands and every coordinate.
        const parents = shells.filter(s => hole.every(p => booleanPointInPolygon(point(p), polygon([s.ring]))))
            .sort((a, b) => ringArea(a.ring) - ringArea(b.ring));
        if (!parents.length) throw upstreamError('SuperMap returned a hole without a containing island.');
        parents[0].holes.push(hole);
    }
    if (!shells.length) throw upstreamError('SuperMap returned no REGION islands.');
    const coordinates = shells.map(s => [s.ring, ...s.holes]);
    return coordinates.length === 1 ? { type: 'Polygon', coordinates: coordinates[0] } : { type: 'MultiPolygon', coordinates };
}

export function createSupermapParcelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    const { id, idPrefix, endpoint, layer, idField } = descriptor;
    const pageSize = descriptor.pageSize ?? 100, maxFeatures = descriptor.maxFeatures ?? 5000;
    const maxPages = descriptor.maxPages ?? 100, timeoutMs = descriptor.timeoutMs ?? 15000;
    const maxBytes = descriptor.maxResponseBytes ?? 8 * 1024 * 1024;
    const nativePattern = /^[0-9A-Za-z]{1,80}$/;
    if (!id || !idPrefix || new URL(endpoint).protocol !== 'https:' || !layer || idField !== 'BDCDYH'
        || JSON.stringify(descriptor.outFields) !== JSON.stringify([idField])
        || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000
        || !Number.isSafeInteger(maxFeatures) || maxFeatures < pageSize || maxFeatures > 10000
        || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 200
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 45000
        || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 20 * 1024 * 1024) throw new Error('Invalid SuperMap parcel descriptor.');

    async function read({ bbox, codes }) {
        const byId = new Map(), pages = new Set();
        const signal = AbortSignal.timeout(timeoutMs);
        let readCount = 0, cursor = null, expectedTotal, totalBytes = 0;
        for (let page = 0; page < maxPages; page++) {
            // This proxy ignores startRecord. Ordered SMID keyset paging was verified live;
            // SMID is only a safe row cursor, never the canonical parcel identity.
            const filters = [codes ? `${idField} IN (${codes.map(c => `'${c}'`).join(',')})` : null,
                cursor === null ? null : `SMID > ${cursor}`].filter(Boolean);
            const queryParam = { name: layer, fields: [idField], orderBy: 'SMID ASC',
                ...(filters.length ? { attributeFilter: filters.join(' AND ') } : {}) };
            const body = { queryMode: bbox ? 'SpatialQuery' : 'SqlQuery',
                ...(bbox ? { spatialQueryMode: 'INTERSECT', geometry: { type: 'REGION', parts: [5],
                    points: [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]], [bbox[0], bbox[1]]].map(([x, y]) => ({ x, y })) } } : {}),
                queryParameters: { queryParams: [queryParam], startRecord: 0, expectCount: pageSize, queryOption: 'ATTRIBUTEANDGEOMETRY' } };
            const response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', signal,
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
            if (!response.ok) throw providerHttpError(response);
            const reader = response.body.getReader();
            const chunks = []; let size = 0;
            try {
                for (;;) {
                    const { done, value } = await reader.read(); if (done) break;
                    size += value.byteLength; totalBytes += value.byteLength;
                    if (size > maxBytes || totalBytes > maxBytes * 4) throw upstreamError('SuperMap response exceeds the byte limit.');
                    chunks.push(value);
                }
            } catch (error) { await reader.cancel().catch(() => {}); throw error; }
            finally { reader.releaseLock(); }
            const bytes = new Uint8Array(size); let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
            let payload;
            try { payload = JSON.parse(new TextDecoder().decode(bytes)); }
            catch { throw upstreamError('SuperMap returned invalid JSON.'); }
            if (!Array.isArray(payload.recordsets) || payload.recordsets.length !== 1
                || !Array.isArray(payload.recordsets[0].features) || !Number.isSafeInteger(payload.totalCount)
                || payload.totalCount < 0 || payload.totalCount > maxFeatures) throw upstreamError('SuperMap query is invalid or exceeds the feature limit.');
            const rows = payload.recordsets[0].features;
            if (expectedTotal !== undefined && expectedTotal !== readCount + payload.totalCount) throw upstreamError('SuperMap total changed during cursor paging.');
            expectedTotal ??= payload.totalCount;
            if (rows.length > pageSize || payload.currentCount !== rows.length || readCount + rows.length > expectedTotal
                || (!rows.length && readCount < expectedTotal)) throw upstreamError('SuperMap returned an incomplete page.');
            const signature = JSON.stringify(rows.map(r => r.fieldValues));
            if (rows.length && pages.has(signature)) throw upstreamError('SuperMap repeated a page.');
            pages.add(signature);
            for (const row of rows) {
                if (!Number.isSafeInteger(row.ID) || row.ID < 0 || cursor !== null && row.ID <= cursor) throw upstreamError('SuperMap returned an invalid or repeated row cursor.');
                cursor = row.ID;
                if (JSON.stringify(row.fieldNames) !== JSON.stringify([idField]) || row.fieldValues?.length !== 1) throw upstreamError('SuperMap ignored the safe field projection.');
                const native = row.fieldValues[0];
                if (typeof native !== 'string' || !nativePattern.test(native) || codes && !codes.includes(native)) throw upstreamError('SuperMap returned an invalid or unrequested ID.');
                const geometry = supermapRegionGeometry(row.geometry);
                const previous = byId.get(native);
                if (previous && JSON.stringify(previous.geometry) !== JSON.stringify(geometry)) throw upstreamError('SuperMap returned conflicting geometry for one parcel ID.');
                byId.set(native, canonicalParcelFeature(descriptor, { geometry, properties: { [idField]: native } }, native));
            }
            readCount += rows.length;
            if (readCount === expectedTotal) return [...byId.values()];
        }
        throw upstreamError('SuperMap query exceeds the page limit.');
    }
    const result = features => ({ type: 'FeatureCollection', sourceId: id, features, complete: true, returnsWGS84: true });
    async function queryBounds(bbox) {
        validateBounds(bbox, descriptor.maxBboxKm2 ?? 2, descriptor);
        return result(await read({ bbox }));
    }
    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 SuperMap parcel IDs.');
        const unique = [...new Set(ids)];
        const codes = unique.map(value => {
            if (typeof value !== 'string' || !value.startsWith(idPrefix) || !nativePattern.test(value.slice(idPrefix.length))) throw new HttpError(400, 'Invalid SuperMap parcel ID.');
            return value.slice(idPrefix.length);
        });
        const features = await read({ codes }), found = new Set(features.map(f => f.id));
        return { ...result(features), absentIds: unique.filter(value => !found.has(value)) };
    }
    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a valid Polygon or MultiPolygon.');
        const footprint = feature(geometry), response = await queryBounds(geometryBbox(footprint));
        return { ...response, features: response.features.filter(parcel => booleanIntersects(parcel, footprint)) };
    }
    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}
