// Adapts fixed OGC API Features GeoJSON/CQL2 collections with validated provider pagination.
import { bbox as geometryBbox, booleanIntersects, feature as geoFeature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { upstreamError, validateBounds, validateGeometry, canonicalParcelFeature, createParcelAttributeFilter } from './source-contract.js';

const CRS84 = 'http://www.opengis.net/def/crs/OGC/1.3/CRS84';
export function createOgcApiParcelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    const { id, endpoint, idField, idPrefix, outFields } = descriptor;
    const base = new URL(endpoint);
    const pagination = descriptor.pagination || 'cursor';
    const idType = descriptor.idType;
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
    if (!id || !idPrefix || !identifier.test(idField) || !['string', 'integer'].includes(idType) || !['cursor', 'startIndex', 'offset'].includes(pagination)
        || (descriptor.profile && descriptor.profile !== 'rfc7946')
        || (descriptor.idFromFeatureId !== undefined && typeof descriptor.idFromFeatureId !== 'boolean')
        || !Array.isArray(outFields) || !outFields.includes(idField)
        || (descriptor.parcelNumberField && !outFields.includes(descriptor.parcelNumberField))
        || (descriptor.idNamespace && (!identifier.test(descriptor.idNamespace.field)
            || !outFields.includes(descriptor.idNamespace.field) || typeof descriptor.idNamespace.value !== 'string' || !descriptor.idNamespace.value))
        || base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
        throw new Error('Invalid OGC API parcel source descriptor.');
    }
    const idPattern = descriptor.idPattern ? new RegExp(descriptor.idPattern) : null;
    const validId = value => idType === 'integer'
        ? /^(0|[1-9][0-9]*)$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value))
        : typeof value === 'string' && value.length > 0 && value.length <= 256 && (!idPattern || idPattern.test(value));
    const attributeFilter = createParcelAttributeFilter(descriptor);
    const pageSize = descriptor.pageSize || 1000;
    const maxFeatures = descriptor.maxFeatures || 10000;

    function nextCursor(links, original, rawCount, pageLength, matched) {
        // GeoServer omits links on short terminal pages; a full uncounted page is insufficient evidence.
        if (links === undefined && pagination === 'startIndex' && pageLength < pageSize) return null;
        if (!Array.isArray(links)) throw upstreamError('OGC API provider omitted pagination links.');
        const next = links.filter(link => link?.rel === 'next');
        if (!next.length) {
            if (pagination === 'startIndex' && pageLength === pageSize && matched !== rawCount) throw upstreamError('OGC API provider omitted continuation for a full uncounted page.');
            return null;
        }
        if (next.length !== 1 || typeof next[0].href !== 'string') throw upstreamError('OGC API provider returned ambiguous pagination.');
        let url;
        try { url = new URL(next[0].href, base); } catch { throw upstreamError('OGC API provider returned an invalid next link.'); }
        if (url.origin !== base.origin || url.pathname !== base.pathname || url.username || url.password || url.hash
            || (next[0].type && !['application/geo+json', 'application/json'].includes(next[0].type))) {
            throw upstreamError('OGC API next link left the fixed parcel collection.');
        }
        for (const key of url.searchParams.keys()) {
            if (key !== pagination && !original.has(key)) throw upstreamError('OGC API next link changed the query.');
        }
        for (const [key, value] of original) {
            if (url.searchParams.getAll(key).length !== 1 || url.searchParams.get(key) !== value) throw upstreamError('OGC API next link changed the query.');
        }
        const cursors = url.searchParams.getAll(pagination);
        if (cursors.length !== 1 || !cursors[0] || cursors[0].length > 2048) throw upstreamError('OGC API next link omitted a valid cursor.');
        if (pagination !== 'cursor' && (!/^[1-9][0-9]*$/.test(cursors[0]) || Number(cursors[0]) !== rawCount)) throw upstreamError('OGC API provider returned an incorrect page offset.');
        return cursors[0];
    }

    async function query(params) {
        const original = new URLSearchParams({ f: 'json', limit: String(pageSize), crs: CRS84,
            ...(descriptor.profile ? { profile: descriptor.profile } : {}), ...params });
        const filter = [attributeFilter.where, params.filter].filter(Boolean).map(part => `(${part})`).join(' AND ');
        if (filter) { original.set('filter', filter); original.set('filter-lang', 'cql2-text'); }
        const parcels = new Map();
        const objects = new Set();
        const cursors = new Set();
        let cursor = null, rawCount = 0, matched;
        for (;;) {
            const search = new URLSearchParams(original);
            if (cursor) search.set(pagination, cursor);
            const signal = AbortSignal.timeout(15000);
            let payload;
            try {
                // Even validated next links contribute only their paging state; no URL is followed.
                const response = await fetchImpl(`${endpoint}?${search.toString().replaceAll('+', '%20')}`, { signal, redirect: 'error', headers: { Accept: 'application/geo+json' } });
                if (!response.ok) throw upstreamError(`Parcel provider returned HTTP ${response.status}.`);
                payload = await response.json();
            } catch (error) {
                if (signal.aborted || ['TimeoutError', 'AbortError'].includes(error.name)) throw upstreamError('Parcel provider timed out.', 504);
                if (error.status) throw error;
                throw upstreamError(`Parcel provider is unavailable: ${error.message}`);
            }
            if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features)
                || payload.numberReturned !== payload.features.length || payload.features.length > pageSize) throw upstreamError('OGC API provider returned an invalid or inconsistent FeatureCollection.');
            if (payload.numberMatched !== undefined) {
                if (!Number.isSafeInteger(payload.numberMatched) || payload.numberMatched < 0
                    || (matched !== undefined && matched !== payload.numberMatched)) throw upstreamError('OGC API provider returned inconsistent match counts.');
                matched = payload.numberMatched;
                if (matched > maxFeatures) throw upstreamError('Parcel query exceeds the parcel limit; use a smaller area.');
            }
            rawCount += payload.features.length;
            if (rawCount > maxFeatures || (matched !== undefined && rawCount > matched)) throw upstreamError('Parcel query exceeds its match or parcel limit.');
            for (const feature of payload.features) {
                const props = feature?.properties || {};
                // Some OGC schemas expose their named x-ogc-role:id field only as GeoJSON feature.id.
                const nativeId = descriptor.idFromFeatureId ? feature.id : props[idField];
                if (descriptor.idFromFeatureId && props[idField] !== undefined && props[idField] !== nativeId) throw upstreamError('Parcel provider returned inconsistent native identity.');
                if (!validId(nativeId) || !attributeFilter.matches(props)) throw upstreamError('Parcel provider returned an invalid native ID or excluded ground record.');
                if (descriptor.idNamespace && props[descriptor.idNamespace.field] !== descriptor.idNamespace.value) throw upstreamError('Parcel provider returned a different native ID namespace.');
                if (!validateGeometry(feature.geometry)) throw upstreamError('Parcel provider returned invalid polygon geometry.');
                if (typeof feature.id !== 'string' || !feature.id || objects.has(feature.id)) throw upstreamError('OGC API provider repeated or omitted a feature ID.');
                objects.add(feature.id);
                const canonical = canonicalParcelFeature(descriptor, feature, nativeId);
                const previous = parcels.get(canonical.id);
                if (previous && JSON.stringify(previous.geometry) !== JSON.stringify(canonical.geometry)) throw upstreamError('Parcel provider returned conflicting geometry for one parcel ID.');
                parcels.set(canonical.id, canonical);
            }
            cursor = nextCursor(payload.links, original, rawCount, payload.features.length, matched);
            if (!cursor) {
                if (matched !== undefined && rawCount !== matched) throw upstreamError('OGC API provider ended pagination before its match count.');
                break;
            }
            if (!payload.features.length || rawCount >= maxFeatures || cursors.has(cursor)) throw upstreamError('OGC API provider returned incomplete or repeated pagination.');
            cursors.add(cursor);
        }
        return { type: 'FeatureCollection', features: [...parcels.values()], complete: true, sourceId: id, returnsWGS84: true };
    }
    function queryBounds(bbox) {
        validateBounds(bbox, descriptor.maxBboxKm2 || 25);
        return query({ bbox: bbox.join(','), 'bbox-crs': CRS84 });
    }
    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 parcel IDs.');
        const unique = [...new Set(ids)];
        const native = unique.map(value => {
            if (typeof value !== 'string' || !value.startsWith(idPrefix)) throw new HttpError(400, 'Parcel ID belongs to a different source.');
            const tail = value.slice(idPrefix.length);
            if (!validId(tail)) throw new HttpError(400, 'Invalid parcel ID.');
            if (idType === 'integer') return tail;
            return `'${tail.replaceAll("'", "''")}'`;
        });
        const result = await query({ filter: `${idField} IN (${native.join(',')})` });
        if (result.features.some(feature => !unique.includes(feature.id))) throw upstreamError('Parcel ID query returned unexpected parcels.');
        const present = new Set(result.features.map(feature => feature.id));
        return { ...result, absentIds: unique.filter(value => !present.has(value)) };
    }
    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a valid WGS84 Polygon or MultiPolygon.');
        const footprint = geoFeature(geometry);
        const result = await queryBounds(geometryBbox(footprint));
        return { ...result, features: result.features.filter(parcel => booleanIntersects(parcel, footprint)) };
    }
    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}
