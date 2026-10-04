// Spain's INSPIRE CP WFS serves GML and does not implement offset pagination.
// Small, unpaged windows must match the collection's total; a truncated reply is unavailable.
import proj4 from 'proj4';
import { bbox as geometryBbox, booleanIntersects, feature as geoFeature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';
import { parseGmlParcels } from './gml-parcel-reader.js';

const ENDPOINT = 'https://ovc.catastro.meh.es/INSPIRE/wfsCP.aspx';
const ID_FIELD = 'nationalCadastralReference';
const KEY = /^[A-Z0-9]{14}$/;
const utm = zone => `+proj=utm +zone=${zone} +ellps=GRS80 +units=m +no_defs`;

export function createCatastroWfsParcelSource(descriptor, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    if (descriptor.endpoint !== ENDPOINT || descriptor.idField !== ID_FIELD || descriptor.idPrefix !== 'ES-DGC-'
        || descriptor.maxBboxKm2 > 1 || !descriptor.outFields?.includes(ID_FIELD)) {
        throw new Error('Invalid Spanish cadastral WFS descriptor.');
    }
    const maxFeatures = descriptor.maxFeatures || 5000;
    const maxBytes = descriptor.maxResponseBytes || 8 * 1024 * 1024;
    // A minute of positive viewport identities avoids one upstream request per visible parcel.
    // Expired/unknown IDs still require the official stored query; absence is never cached.
    const recent = new Map();
    function remember(features) {
        for (const feature of features) {
            recent.delete(feature.id);
            recent.set(feature.id, { feature: structuredClone(feature), expires: now() + 60000 });
            if (recent.size > 10000) recent.delete(recent.keys().next().value);
        }
        return features;
    }
    async function query(params) {
        const signal = AbortSignal.timeout(15000);
        let reader;
        try {
            const url = new URL(ENDPOINT);
            url.search = new URLSearchParams({ service: 'WFS', version: '2.0.0', request: 'GetFeature', ...params });
            const response = await fetchImpl(url.href, { signal, redirect: 'error', headers: {
                Accept: 'application/gml+xml, application/xml', 'Accept-Language': 'es,ca;q=0.8,en;q=0.5',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
            } });
            if (!response.ok) throw providerHttpError(response);
            const declared = response.headers.get('content-length');
            if (declared && Number(declared) > maxBytes) throw upstreamError('Cadastral WFS response exceeds byte limit; use a smaller area.');
            reader = response.body?.getReader();
            if (!reader) throw upstreamError('Cadastral WFS returned no readable response.');
            const chunks = [];
            let size = 0;
            for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                size += chunk.value.byteLength;
                if (size > maxBytes) throw upstreamError('Cadastral WFS response exceeds byte limit; use a smaller area.');
                chunks.push(Buffer.from(chunk.value));
            }
            if (declared && !response.headers.get('content-encoding') && Number(declared) !== size) {
                throw upstreamError('Cadastral WFS response body is incomplete.');
            }
            const parsed = await parseGmlParcels(Buffer.concat(chunks, size), { idField: ID_FIELD,
                maxBytes, maxFeatures, signal });
            if (!Number.isSafeInteger(parsed.numberMatched) || parsed.numberMatched !== parsed.featureCount
                || parsed.duplicateNativeCount || parsed.features.some(f => !KEY.test(f.properties[ID_FIELD]))) {
                throw upstreamError('Cadastral WFS did not return a complete unique parcel set; use a smaller area.');
            }
            return parsed.features.map(feature => canonicalParcelFeature(descriptor, feature, feature.properties[ID_FIELD]));
        } catch (error) {
            if (reader) { try { await reader.cancel(); } catch { /* Failed stream may already be closed. */ } }
            if (error.status) throw error;
            if (signal.aborted || ['AbortError', 'TimeoutError'].includes(error.name)) throw upstreamError('Cadastral WFS timed out.', 504);
            throw upstreamError('Cadastral WFS is unavailable.');
        } finally { reader?.releaseLock(); }
    }
    const result = (features, extra = {}) => ({ type: 'FeatureCollection', features,
        complete: true, sourceId: descriptor.id, returnsWGS84: true, ...extra });

    async function queryBounds(bounds) {
        validateBounds(bounds, descriptor.maxBboxKm2 || 1, descriptor);
        const [w, s, e, n] = bounds;
        const zone = (w + e) / 2 < 0 ? 30 : 31;
        const points = [[w, s], [w, n], [e, s], [e, n]].map(p => proj4('EPSG:4326', utm(zone), p));
        const box = [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])),
            Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
        const srid = `EPSG::${25800 + zone}`;
        return result(remember(await query({ typeNames: 'CP:CadastralParcel', srsName: srid, bbox: box.join(',') })));
    }

    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 parcel IDs.');
        const unique = [...new Set(ids)];
        const native = unique.map(value => {
            if (typeof value !== 'string' || !value.startsWith(descriptor.idPrefix)
                || !KEY.test(value.slice(descriptor.idPrefix.length))) throw new HttpError(400, 'Invalid Spanish parcel ID.');
            return value.slice(descriptor.idPrefix.length);
        });
        const features = [];
        // This provider resets connections during parallel exact reads. Keep each batch sequential.
        for (const key of native) {
            const cached = recent.get(descriptor.idPrefix + key);
            if (cached && cached.expires > now()) {
                features.push(structuredClone(cached.feature));
                continue;
            }
            recent.delete(descriptor.idPrefix + key);
            const found = await query({ STOREDQUERY_ID: 'GetParcel', REFCAT: key, SRSNAME: 'EPSG::25830' });
            if (found.length > 1 || found.some(f => f.properties.sourceParcelId !== key)) {
                throw upstreamError('Cadastral exact lookup returned an unexpected native parcel.');
            }
            features.push(...remember(found));
        }
        const present = new Set(features.map(f => f.id));
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
