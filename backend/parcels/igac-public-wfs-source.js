// IGAC's public ArcGIS WFS uses projected FES envelopes and omits GeoJSON match counts.
// Keep layer-qualified Codigo identities and source coordinates in both JS runtimes.
import proj4 from 'proj4';
import { bbox, bboxPolygon, booleanIntersects } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { concatBytes } from './byte-utils.js';
import { canonicalParcelFeature, validateBounds, validateGeometry, upstreamError, providerHttpError } from './source-contract.js';
import { geoJsonResponseCrsMatches } from './response-crs.js';

const NAMESPACE = 'CATASTRO_PUBLICO_31082026';
const ENDPOINT = `https://dservices2.arcgis.com/RVvWzU3lgJISqdke/arcgis/services/${NAMESPACE}/WFSServer`;
const PREFIX = `CO-IGAC-${NAMESPACE}-`;
const LAYERS = ['U_TERRENO', 'R_TERRENO'];
const mercator = proj4('EPSG:4326', 'EPSG:3857');
const equal = (field, value) => `<fes:PropertyIsEqualTo><fes:ValueReference>${field}</fes:ValueReference><fes:Literal>${value}</fes:Literal></fes:PropertyIsEqualTo>`;

export function createIgacPublicWfsSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    const { municipalityCode, idPrefix, pageSize = 1000, maxFeatures = 10000,
        maxResponseBytes = 16 * 1024 * 1024, timeoutMs = 30000, idBatchSize = 1 } = descriptor;
    if (descriptor.endpoint !== ENDPOINT || idPrefix !== PREFIX || descriptor.idField !== 'Codigo'
        || descriptor.geometryField !== 'Shape' || !/^\d{5}$/.test(municipalityCode)
        || JSON.stringify(descriptor.outFields) !== '["Codigo"]'
        || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 3000
        || !Number.isSafeInteger(maxFeatures) || maxFeatures < 1 || maxFeatures > 10000
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 16 * 1024 * 1024
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 45000
        || !Number.isSafeInteger(idBatchSize) || idBatchSize < 1 || idBatchSize > 80) {
        throw new Error('Invalid IGAC public WFS descriptor.');
    }
    const validCode = code => typeof code === 'string' && /^\d{30}$/.test(code) && code.startsWith(municipalityCode);
    const state = () => ({ requests: 0, bytes: 0 });

    async function read(layer, predicate, limit, budget) {
        const url = new URL(ENDPOINT);
        url.search = new URLSearchParams({ service: 'WFS', version: '2.0.0', request: 'GetFeature',
            typeNames: `${NAMESPACE}:${layer}`, outputFormat: 'geojson', srsName: 'EPSG:4326',
            propertyName: 'Codigo,Shape', count: String(limit),
            filter: '<fes:Filter xmlns:fes="http://www.opengis.net/fes/2.0" xmlns:gml="http://www.opengis.net/gml/3.2">'
                + `<fes:And>${equal('codigo_municipio', municipalityCode)}${predicate}</fes:And></fes:Filter>` }).toString();
        let response;
        for (let attempt = 0; ; attempt++) {
            if (++budget.requests > 128) throw upstreamError('IGAC query exceeded its bounded request budget; use a smaller area.');
            response = await fetchImpl(url.href, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
                cache: 'no-store', headers: { Accept: 'application/geo+json, application/json' } });
            if (response.ok) break;
            await response.body?.cancel();
            // Live identical, valid FES requests intermittently return ArcGIS HTTP 400
            // and then succeed. Retry that service fault twice; never retry access denials.
            if (attempt >= 2 || ![400, 500, 502, 503, 504].includes(response.status)) throw providerHttpError(response);
        }
        const reader = response.body?.getReader();
        if (!reader) throw upstreamError('IGAC omitted its response body.');
        const chunks = [];
        let bytes = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                budget.bytes += value.byteLength;
                if (bytes > maxResponseBytes || budget.bytes > 64 * 1024 * 1024) throw upstreamError('IGAC exceeded its response byte budget.');
                chunks.push(value);
            }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        let payload;
        try { payload = JSON.parse(new TextDecoder().decode(concatBytes(chunks))); }
        catch { throw upstreamError('IGAC returned an invalid GeoJSON response.'); }
        if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features)
            || payload.features.length > limit || !geoJsonResponseCrsMatches(payload.crs, 4326, { required: true })) {
            throw upstreamError('IGAC returned an invalid or mismatched-CRS FeatureCollection.');
        }
        const seen = new Set();
        return payload.features.map(feature => {
            const code = feature?.properties?.Codigo;
            if (!validCode(code) || !validateGeometry(feature.geometry) || seen.has(code)) {
                throw upstreamError('IGAC returned a foreign, repeated or malformed parcel.');
            }
            seen.add(code);
            // ArcGIS adds transport identifiers despite propertyName. Drop them here.
            return canonicalParcelFeature({ ...descriptor, outFields: [] },
                { type: 'Feature', geometry: feature.geometry, properties: {} }, `${layer}-${code}`);
        });
    }

    function collection(features, extra = {}) {
        return { type: 'FeatureCollection', features, complete: true, sourceId: descriptor.id, returnsWGS84: true, ...extra };
    }

    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 parcel IDs.');
        const unique = [...new Set(ids)];
        const parsed = unique.map(id => {
            const match = typeof id === 'string' && id.startsWith(idPrefix)
                ? /^(U_TERRENO|R_TERRENO)-(\d{30})$/.exec(id.slice(idPrefix.length)) : null;
            if (!match || !validCode(match[2])) throw new HttpError(400, 'Invalid IGAC parcel ID.');
            return { id, layer: match[1], code: match[2] };
        });
        const budget = state(), features = [];
        for (const layer of LAYERS) {
            const group = parsed.filter(item => item.layer === layer);
            for (let index = 0; index < group.length; index += idBatchSize) {
                const batch = group.slice(index, index + idBatchSize);
                const terms = batch.map(item => equal('Codigo', item.code));
                const predicate = terms.length === 1 ? terms[0] : `<fes:Or>${terms.join('')}</fes:Or>`;
                // An extra record exposes duplicate keys instead of silently truncating them.
                const found = await read(layer, predicate, batch.length + 1, budget);
                if (found.length > batch.length || found.some(feature => !batch.some(item => item.id === feature.id))) {
                    throw upstreamError('IGAC exact-ID query returned unexpected parcel identities.');
                }
                features.push(...found);
            }
        }
        const present = new Set(features.map(feature => feature.id));
        return collection(features, { absentIds: unique.filter(id => !present.has(id)) });
    }

    async function queryBounds(bounds) {
        validateBounds(bounds, descriptor.maxBboxKm2 ?? 25, descriptor);
        const budget = state(), byId = new Map(), footprint = bboxPolygon(bounds);
        async function visit(layer, box, depth) {
            const [w, s] = mercator.forward(box.slice(0, 2));
            const [e, n] = mercator.forward(box.slice(2));
            const spatial = '<fes:BBOX><fes:ValueReference>Shape</fes:ValueReference>'
                + '<gml:Envelope srsName="urn:ogc:def:crs:EPSG::3857">'
                + `<gml:lowerCorner>${w} ${s}</gml:lowerCorner><gml:upperCorner>${e} ${n}</gml:upperCorner>`
                + '</gml:Envelope></fes:BBOX>';
            const features = await read(layer, spatial, pageSize, budget);
            if (features.length === pageSize) {
                // This service has no reliable offset/count manifest. A full page is
                // unresolved until both smaller spatial envelopes terminate short.
                if (depth >= 12) throw upstreamError('IGAC spatial query cannot be completely enumerated; use a smaller area.');
                const axis = box[2] - box[0] >= box[3] - box[1] ? 0 : 1;
                const midpoint = (box[axis] + box[axis + 2]) / 2;
                const left = [...box], right = [...box];
                left[axis + 2] = midpoint; right[axis] = midpoint;
                await visit(layer, left, depth + 1);
                await visit(layer, right, depth + 1);
                return;
            }
            for (const feature of features) {
                const previous = byId.get(feature.id);
                if (previous && JSON.stringify(previous.geometry) !== JSON.stringify(feature.geometry)) {
                    throw upstreamError('IGAC returned conflicting geometry for a parcel ID.');
                }
                if (booleanIntersects(feature, footprint)) byId.set(feature.id, feature);
                if (byId.size > maxFeatures) throw upstreamError('IGAC query exceeds the parcel limit; use a smaller area.');
            }
        }
        for (const layer of LAYERS) await visit(layer, bounds, 0);
        return collection([...byId.values()]);
    }

    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a valid WGS84 Polygon or MultiPolygon.');
        const result = await queryBounds(bbox(geometry));
        return { ...result, features: result.features.filter(feature => booleanIntersects(feature, geometry)) };
    }
    return Object.freeze({ queryIds, queryBounds, queryGeometry });
}
