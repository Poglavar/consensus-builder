// Adapts a fixed Socrata polygon dataset with counted, ordered pages and publication-revision checks.
import { bbox as geometryBbox, booleanIntersects, feature as geoFeature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { upstreamError, validateBounds, validateGeometry, canonicalParcelFeature, createParcelAttributeFilter } from './source-contract.js';

export function createSocrataParcelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    const { id, endpoint, idField, idPrefix, outFields, geometryField, versionField, objectIdField } = descriptor;
    const base = new URL(endpoint);
    const field = /^[A-Za-z_][A-Za-z0-9_]*$/;
    if (!id || !idPrefix || descriptor.idType !== 'string' || !Array.isArray(outFields)
        || ![idField, geometryField, versionField, objectIdField, ...outFields].every(name => field.test(name))
        || !outFields.includes(idField) || !outFields.includes(versionField) || !outFields.includes(objectIdField)
        || (descriptor.parcelNumberField && !outFields.includes(descriptor.parcelNumberField))
        || outFields.includes(geometryField) || base.protocol !== 'https:' || base.search || base.hash || base.username || base.password) throw new Error('Invalid Socrata parcel source descriptor.');
    const pattern = descriptor.idPattern ? new RegExp(descriptor.idPattern) : null;
    const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && (!pattern || pattern.test(value));
    const attributeFilter = createParcelAttributeFilter(descriptor);
    const pageSize = descriptor.pageSize || 1000;
    const maxFeatures = descriptor.maxFeatures || 10000;

    async function request(params) {
        const signal = AbortSignal.timeout(15000);
        try {
            const response = await fetchImpl(`${endpoint}?${new URLSearchParams(params)}`, { signal, redirect: 'error', headers: { Accept: 'application/json' } });
            if (!response.ok) throw upstreamError(`Parcel provider returned HTTP ${response.status}.`);
            const rows = await response.json();
            if (!Array.isArray(rows)) throw upstreamError('Socrata provider returned an invalid row response.');
            return rows;
        } catch (error) {
            if (signal.aborted || ['TimeoutError', 'AbortError'].includes(error.name)) throw upstreamError('Parcel provider timed out.', 504);
            if (error.status) throw error;
            throw upstreamError(`Parcel provider is unavailable: ${error.message}`);
        }
    }
    async function signature(where) {
        const rows = await request({ $select: `count(*) as matched,max(${versionField}) as revision`, $where: where });
        const value = rows[0]?.matched;
        if (rows.length !== 1 || typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw upstreamError('Socrata provider omitted a valid match count.');
        const matched = Number(value);
        if (matched > maxFeatures) throw upstreamError('Parcel query exceeds the parcel limit; use a smaller area.');
        if (matched && (typeof rows[0].revision !== 'string' || !rows[0].revision)) throw upstreamError('Socrata provider omitted its publication revision.');
        return { matched, revision: rows[0].revision ?? null };
    }
    async function query(filter) {
        const where = [attributeFilter.where, filter].filter(Boolean).map(value => `(${value})`).join(' AND ');
        const before = await signature(where);
        const parcels = new Map();
        const objects = new Set();
        let offset = 0;
        while (offset < before.matched) {
            const rows = await request({ $select: [geometryField, ...outFields].join(','), $where: where,
                $order: [...new Set([idField, objectIdField])].join(','), $limit: String(pageSize), $offset: String(offset) });
            if (!rows.length || rows.length > pageSize || offset + rows.length > before.matched) throw upstreamError('Socrata provider returned incomplete or inconsistent paging.');
            for (const props of rows) {
                const nativeId = props?.[idField];
                if (!validId(nativeId) || !attributeFilter.matches(props) || !validateGeometry(props?.[geometryField])) throw upstreamError('Socrata provider returned invalid identity, excluded ground or polygon geometry.');
                const objectId = props[objectIdField];
                if (typeof objectId !== 'string' || !objectId || objects.has(objectId)) throw upstreamError('Socrata provider repeated or omitted a row ID.');
                objects.add(objectId);
                const previous = parcels.get(nativeId);
                if (previous && JSON.stringify(previous.geometry) !== JSON.stringify(props[geometryField])) throw upstreamError('Socrata provider returned conflicting geometry for one ground parcel ID.');
                const feature = { type: 'Feature', geometry: props[geometryField], properties: props };
                if (!previous) parcels.set(nativeId, canonicalParcelFeature(descriptor, feature, nativeId));
            }
            offset += rows.length;
        }
        const after = await signature(where);
        if (before.matched !== after.matched || before.revision !== after.revision) throw upstreamError('Socrata dataset changed while paging; retry the query.');
        return { type: 'FeatureCollection', features: [...parcels.values()], complete: true, sourceId: id, returnsWGS84: true };
    }
    function queryBounds(bbox) {
        validateBounds(bbox, descriptor.maxBboxKm2 || 25);
        const [w, s, e, n] = bbox;
        // intersects includes boundary-crossing parcels; within_box would discard those pieces.
        return query(`intersects(${geometryField},'POLYGON((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s}))')`);
    }
    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 parcel IDs.');
        const unique = [...new Set(ids)];
        const native = unique.map(value => {
            if (typeof value !== 'string' || !value.startsWith(idPrefix) || !validId(value.slice(idPrefix.length))) throw new HttpError(400, 'Invalid parcel ID for this source.');
            return `'${value.slice(idPrefix.length).replaceAll("'", "''")}'`;
        });
        const result = await query(`${idField} IN (${native.join(',')})`);
        if (result.features.some(f => !unique.includes(f.id))) throw upstreamError('Parcel ID query returned unexpected parcels.');
        const present = new Set(result.features.map(f => f.id));
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
