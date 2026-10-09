// Bounded WFS 2.0 adapter for Hamburg's simplified ALKIS parcel layer.
// Match counts are checked before and after paging so a changing service cannot
// be mistaken for a complete collection.
import { bbox as geometryBbox, bboxPolygon, booleanIntersects, feature as geoFeature } from '@turf/turf';
import { SaxesParser } from 'saxes';
import { HttpError } from '../utils/helpers.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

const ENDPOINT = 'https://geodienste.hamburg.de/WFS_HH_ALKIS_vereinfacht';
const TYPE = 'ave:Flurstueck';
const ID_FIELD = 'flstkennz';
const GEOMETRY_FIELD = 'geometrie';
const KEY = /^02[0-9_]{18}$/;
const WFS = 'http://www.opengis.net/wfs/2.0';
const MAX_BYTES = 4 * 1024 * 1024;

function parseMatched(xml) {
    let rootSeen = false, rootClosed = false, depth = 0, matched;
    const parser = new SaxesParser({ xmlns: true });
    const fail = () => { throw upstreamError('Hamburg ALKIS returned an invalid WFS hits response.'); };
    parser.on('doctype', fail);
    parser.on('error', fail);
    parser.on('opentag', tag => {
        if (depth > 0 || rootSeen || tag.uri !== WFS || tag.local !== 'FeatureCollection') fail();
        rootSeen = true; depth++;
        const allowed = new Set(['numberMatched', 'numberReturned', 'timeStamp', 'xsi:schemaLocation']);
        for (const [name, attr] of Object.entries(tag.attributes)) {
            if (name === 'xmlns' || name.startsWith('xmlns:') || allowed.has(name)) continue;
            fail();
        }
        const raw = tag.attributes.numberMatched?.value;
        const returned = tag.attributes.numberReturned?.value;
        if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw))
            || returned !== '0') fail();
        matched = Number(raw);
    });
    parser.on('closetag', () => { depth--; rootClosed = depth === 0; });
    try { parser.write(xml).close(); } catch (error) { if (error.status) throw error; fail(); }
    if (!rootSeen || !rootClosed || !Number.isSafeInteger(matched)) fail();
    return matched;
}

export function createHamburgAlkisParcelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    const pageSize = descriptor?.pageSize ?? 100;
    const maxFeatures = descriptor?.maxFeatures ?? 5000;
    const maxBytes = descriptor?.maxResponseBytes ?? MAX_BYTES;
    const maxBboxKm2 = descriptor?.maxBboxKm2 ?? 1;
    if (descriptor?.id !== 'de-hh-alkis-flurstueck' || descriptor?.adapter !== 'hamburg-alkis-wfs'
        || descriptor?.endpoint !== ENDPOINT || descriptor?.featureType !== TYPE || descriptor?.idField !== ID_FIELD
        || descriptor?.idPrefix !== 'DE-HH-ALKIS-' || descriptor?.idPattern !== KEY.source
        || !Array.isArray(descriptor?.outFields) || descriptor.outFields.length !== 2
        || descriptor.outFields[0] !== 'flstkennz' || descriptor.outFields[1] !== 'oid'
        || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 500
        || !Number.isSafeInteger(maxFeatures) || maxFeatures < 1 || maxFeatures > 5000
        || typeof maxBboxKm2 !== 'number' || !Number.isFinite(maxBboxKm2) || maxBboxKm2 <= 0 || maxBboxKm2 > 1
        || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > MAX_BYTES) {
        throw new Error('Invalid Hamburg ALKIS parcel source descriptor.');
    }

    async function request(params, wantJson) {
        const url = new URL(ENDPOINT);
        url.search = new URLSearchParams({ SERVICE: 'WFS', VERSION: '2.0.0', REQUEST: 'GetFeature',
            TYPENAMES: TYPE, SRSNAME: 'CRS:84', SORTBY: ID_FIELD, ...params });
        const signal = AbortSignal.timeout(15000);
        let reader;
        try {
            const response = await fetchImpl(url.href, { signal, redirect: 'error', headers: {
                Accept: wantJson ? 'application/geo+json, application/json' : 'application/gml+xml, application/xml'
            } });
            if (!response.ok) throw providerHttpError(response);
            const declared = response.headers.get('content-length');
            if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw upstreamError('Hamburg ALKIS response exceeds byte limit.');
            reader = response.body?.getReader();
            if (!reader) throw upstreamError('Hamburg ALKIS returned no readable response.');
            const chunks = [];
            let size = 0;
            for (;;) {
                const part = await reader.read();
                if (part.done) break;
                size += part.value.byteLength;
                if (size > maxBytes) throw upstreamError('Hamburg ALKIS response exceeds byte limit.');
                chunks.push(Buffer.from(part.value));
            }
            if (declared && !response.headers.get('content-encoding') && Number(declared) !== size) throw upstreamError('Hamburg ALKIS response body is incomplete.');
            const body = Buffer.concat(chunks, size).toString('utf8');
            if (!wantJson) return parseMatched(body);
            let payload;
            try { payload = JSON.parse(body); } catch { throw upstreamError('Hamburg ALKIS returned invalid GeoJSON.'); }
            if (!payload || payload.type !== 'FeatureCollection' || !Array.isArray(payload.features)) throw upstreamError('Hamburg ALKIS returned invalid GeoJSON.');
            return payload;
        } catch (error) {
            if (error.status) throw error;
            if (signal.aborted || ['AbortError', 'TimeoutError'].includes(error.name)) throw upstreamError('Hamburg ALKIS timed out.', 504);
            throw upstreamError('Hamburg ALKIS is unavailable.');
        } finally {
            if (reader) { try { await reader.cancel(); } catch { /* closed response */ } reader.releaseLock(); }
        }
    }

    async function query(params, allowedIds = null) {
        const before = await request({ ...params, RESULTTYPE: 'hits' }, false);
        if (before > maxFeatures) throw upstreamError('Hamburg ALKIS query exceeds the parcel limit; use a smaller area.');
        const features = [], nativeIds = new Set(), transportIds = new Set();
        let previousId = null;
        for (let offset = 0; offset < before; offset += pageSize) {
            const expected = Math.min(pageSize, before - offset);
            const page = await request({ ...params, OUTPUTFORMAT: 'application/geo+json', COUNT: String(expected), STARTINDEX: String(offset),
                PROPERTYNAME: `ave:${GEOMETRY_FIELD},ave:${ID_FIELD},ave:oid` }, true);
            if (page.features.length !== expected) throw upstreamError('Hamburg ALKIS returned an incomplete WFS page.');
            if ((Object.hasOwn(page, 'numberMatched') && page.numberMatched !== before)
                || (Object.hasOwn(page, 'numberReturned') && page.numberReturned !== page.features.length)) {
                throw upstreamError('Hamburg ALKIS GeoJSON counts disagree with its hits response.');
            }
            for (const feature of page.features) {
                const nativeId = feature?.properties?.[ID_FIELD];
                const oid = feature?.properties?.oid;
                if (typeof nativeId !== 'string' || !KEY.test(nativeId) || typeof oid !== 'string' || !oid
                    || typeof feature.id !== 'string' || !feature.id || nativeIds.has(nativeId) || transportIds.has(feature.id)
                    || (previousId !== null && nativeId <= previousId) || (allowedIds && !allowedIds.has(nativeId))
                    || !validateGeometry(feature.geometry)) throw upstreamError('Hamburg ALKIS returned an invalid or repeated parcel.');
                previousId = nativeId;
                nativeIds.add(nativeId); transportIds.add(feature.id);
                features.push(canonicalParcelFeature(descriptor, feature, nativeId));
            }
        }
        const after = await request({ ...params, RESULTTYPE: 'hits' }, false);
        if (after !== before || features.length !== before) throw upstreamError('Hamburg ALKIS changed during the parcel query.');
        return features;
    }

    const result = (features, extra = {}) => ({ type: 'FeatureCollection', features,
        complete: true, sourceId: descriptor.id, returnsWGS84: true, ...extra });

    async function queryBounds(bounds) {
        validateBounds(bounds, maxBboxKm2, { maxBboxWidthM: 1000, maxBboxHeightM: 1000 });
        const [w, s, e, n] = bounds;
        // BBOX is expanded to a native projected envelope by this provider. An exact
        // geographic Intersects filter avoids its measured sub-metre false positives.
        const positions = `${w} ${s} ${e} ${s} ${e} ${n} ${w} ${n} ${w} ${s}`;
        const filter = `<fes:Filter xmlns:fes="http://www.opengis.net/fes/2.0" xmlns:gml="http://www.opengis.net/gml/3.2"><fes:Intersects><fes:ValueReference>${GEOMETRY_FIELD}</fes:ValueReference><gml:Polygon srsName="CRS:84"><gml:exterior><gml:LinearRing><gml:posList>${positions}</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></fes:Intersects></fes:Filter>`;
        const features = await query({ FILTER: filter });
        const footprint = bboxPolygon(bounds);
        for (const parcel of features) {
            if (!booleanIntersects(parcel, footprint)) throw upstreamError('Hamburg ALKIS returned a parcel outside the requested extent.');
        }
        return result(features);
    }

    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 parcel IDs.');
        const unique = [...new Set(ids)];
        const native = unique.map(value => {
            if (typeof value !== 'string' || !value.startsWith(descriptor.idPrefix) || !KEY.test(value.slice(descriptor.idPrefix.length))) throw new HttpError(400, 'Invalid Hamburg ALKIS parcel ID.');
            return value.slice(descriptor.idPrefix.length);
        });
        const features = [];
        for (let offset = 0; offset < native.length; offset += 8) {
            const batch = native.slice(offset, offset + 8);
            const predicates = batch.map(value => `<fes:PropertyIsEqualTo><fes:ValueReference>${ID_FIELD}</fes:ValueReference><fes:Literal>${value}</fes:Literal></fes:PropertyIsEqualTo>`);
            const filter = `<fes:Filter xmlns:fes="http://www.opengis.net/fes/2.0">${predicates.length === 1 ? predicates[0] : `<fes:Or>${predicates.join('')}</fes:Or>`}</fes:Filter>`;
            features.push(...await query({ FILTER: filter }, new Set(batch)));
        }
        const present = new Set(features.map(feature => feature.id));
        return result(features, { absentIds: unique.filter(id => !present.has(id)) });
    }

    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a valid WGS84 Polygon or MultiPolygon.');
        const footprint = geoFeature(geometry);
        const bounds = await queryBounds(geometryBbox(footprint));
        return { ...bounds, features: bounds.features.filter(parcel => booleanIntersects(parcel, footprint)) };
    }

    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}
