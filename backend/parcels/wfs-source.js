// Adapts fixed WFS 1.0/1.1/2.0 GeoJSON layers with attribute IDs or verified native feature-ID routes.
import { bbox as geometryBbox, bboxPolygon, booleanIntersects, feature as geoFeature } from '@turf/turf';
import proj4 from 'proj4';
import { HttpError } from '../utils/helpers.js';
import { concatBytes } from './byte-utils.js';
import { upstreamError, areaLimitError, providerHttpError, validateBounds, validateGeometry, canonicalParcelFeature, createParcelAttributeFilter } from './source-contract.js';
import { geoJsonResponseCrsMatches } from './response-crs.js';
import { createOgunWfsSchemaGuard } from './ogun-wfs-schema.js';
import { createO2mapPnuSource } from './o2map-pnu-source.js';
import { createTasproWfsSource } from './taspro-wfs-source.js';
import { createWfsLayerFamilySource } from './wfs-layer-family-source.js';
import { isTucumanWfsSource } from './tucuman-wfs-transport.js';
import { wfsUrlProxy } from './wfs-url-proxy.js';
import { createZurichAvwfsSource } from './zh-avwfs-source.js';
import { createIgacPublicWfsSource } from './igac-public-wfs-source.js';
import { sha256Hex } from './portable-hash.js';
import { createMylandWfsSource } from './myland-wfs-source.js';
import { createHaleconnectInspireSource } from './haleconnect-inspire-source.js';
import { createPraiaGrandeReaderFetch } from './praia-grande-reader-fetch.js';

const sourceRequestQueues = new Map();

function queueSourceRequest(key, minRequestIntervalMs, request) {
    if (minRequestIntervalMs === undefined) return request();
    let queue = sourceRequestQueues.get(key);
    if (!queue) {
        queue = { lastStartedAt: null, tail: Promise.resolve() };
        sourceRequestQueues.set(key, queue);
    }
    const run = queue.tail.then(async () => {
        if (queue.lastStartedAt !== null) {
            const waitMs = queue.lastStartedAt + minRequestIntervalMs - Date.now();
            if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
        }
        queue.lastStartedAt = Date.now();
        return request();
    });
    // Keep the shared queue usable after a failed provider request.
    queue.tail = run.then(() => undefined, () => undefined);
    return run;
}

export function createWfsParcelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    if (descriptor.wfsPublicReader !== undefined) fetchImpl = createPraiaGrandeReaderFetch(descriptor, fetchImpl);
    if (descriptor.wfsProfile === 'haleconnect-inspire-v1') return createHaleconnectInspireSource(descriptor, { fetchImpl });
    if (descriptor.wfsProfile === 'myland-bounds-cache-v1') return createMylandWfsSource(descriptor, { fetchImpl }, createWfsParcelSource);
    if (descriptor.wfsProfile === 'igac-public-fes-v1') return createIgacPublicWfsSource(descriptor, { fetchImpl });
    if (descriptor.wfsProfile === 'zh-avwfs-lv95-v1') return createZurichAvwfsSource(descriptor, { fetchImpl });
    if (descriptor.wfsProfile === 'native-feature-id-layers-v1') return createWfsLayerFamilySource(descriptor, { fetchImpl }, createWfsParcelSource);
    if (descriptor.wfsProfile === 'o2map-pnu-v1') return createO2mapPnuSource(descriptor, { fetchImpl });
    if (descriptor.wfsProfile === 'taspro-grid-cache-v1') return createTasproWfsSource(descriptor, { fetchImpl }, createWfsParcelSource);
    const { id, endpoint, featureType, idField, idPrefix, outFields } = descriptor;
    const version = descriptor.version ?? '2.0.0';
    // Municipal viewers can expose WFS through a fixed proxy whose parameter contains
    // the relative service path and the entire encoded WFS query (Seoul S-MAP).
    const proxyParameter = descriptor.wfsProxyParameter;
    const endpointUrl = new URL(endpoint);
    const urlProxy = wfsUrlProxy(descriptor);
    const proxyPath = proxyParameter === undefined ? null : endpointUrl.searchParams.get(proxyParameter);
    if (proxyParameter !== undefined && (typeof proxyParameter !== 'string'
        || !/^[A-Za-z][A-Za-z0-9_]*$/.test(proxyParameter)
        || endpointUrl.searchParams.getAll(proxyParameter).length !== 1
        || !/^\/(?!\/)[A-Za-z0-9_/-]+$/.test(proxyPath || ''))) {
        throw new Error('Invalid WFS proxy configuration.');
    }
    function requestUrl(search) {
        const url = new URL(endpointUrl);
        if (proxyParameter !== undefined) url.searchParams.set(proxyParameter, `${proxyPath}?${search}`);
        else for (const [key, value] of search) url.searchParams.set(key, value);
        if (urlProxy) {
            const proxy = new URL(urlProxy);
            proxy.searchParams.set('url', url.href);
            return proxy.href;
        }
        return descriptor.proxyEndpoint
            ? `${descriptor.proxyEndpoint}?${new URLSearchParams({ url: url.href })}` : url.href;
    }
    const responseSrid = descriptor.responseSrid;
    // Some municipal services cannot transform CRS:84 spatial filters into their
    // custom native CRS, but accept the viewer's EPSG:3857 wire coordinates.
    const boundsSrid = descriptor.boundsSrid;
    const boundsProjection = descriptor.boundsProjection;
    if ((boundsSrid !== undefined && boundsSrid !== 3857
        && (!Number.isSafeInteger(boundsSrid) || boundsSrid <= 0 || typeof boundsProjection !== 'string'))
        || (boundsProjection !== undefined && (boundsSrid === undefined || boundsSrid === 3857
            || typeof boundsProjection !== 'string' || !/^\+proj=/.test(boundsProjection)))
        || (descriptor.boundsFilter !== undefined && descriptor.boundsFilter !== 'cql')) {
        throw new Error('Invalid WFS bounds CRS/filter.');
    }
    // MAFRA accepts the viewer's EPSG:5186 CQL window while returning unmodified
    // EPSG:4326 GeoJSON. Transform only the query envelope, never those polygons.
    const toBounds = boundsSrid === 3857 ? proj4('EPSG:4326', 'EPSG:3857')
        : boundsProjection ? proj4('EPSG:4326', boundsProjection) : null;
    // Projected responses require a published operation in the descriptor and independent
    // native-coordinate alignment evidence before the source is admitted.
    const responseProjection = responseSrid !== undefined && ![3857, 4326].includes(responseSrid)
        ? descriptor.projection : undefined;
    const responseCoordinatePrecision = descriptor.responseCoordinatePrecision;
    const requestProperties = descriptor.requestProperties;
    const idBatchSize = descriptor.idBatchSize ?? 80;
    const idType = descriptor.idType;
    const minRequestIntervalMs = descriptor.minRequestIntervalMs;
    const timeoutMs = descriptor.timeoutMs ?? 15000;
    const connectRetries = descriptor.connectRetries ?? 0;
    const remainingMatchCount = descriptor.matchCountMode === 'remaining';
    const featureIdMode = descriptor.nativeIdMode === 'feature-id';
    const ogcIdFilter = descriptor.idFilter === 'ogc';
    if (descriptor.idFilter !== undefined && (!ogcIdFilter || featureIdMode
        || !['1.0.0', '1.1.0'].includes(version) || descriptor.attributeFilters
        || descriptor.attributeExclusions || descriptor.attributeNotNull || descriptor.attributeNull)) {
        throw new Error('Invalid WFS exact-ID filter configuration.');
    }
    // Joined cadastral records can share an attribute key and have generated FIDs.
    // Preserve the publisher's geometry verbatim and disambiguate by its exact JSON hash.
    const compositeIdentity = descriptor.identityKind === 'attribute-geometry-sha256-v1';
    if (compositeIdentity && (featureIdMode || idType !== 'string' || requestProperties !== true
        || responseSrid !== undefined || descriptor.paginationIdentity !== undefined)) {
        throw new Error('Invalid composite WFS identity configuration.');
    }
    // Some joined cadastral layers reuse a transport FID for distinct native parcel
    // records. Their verified parcel key, also used for exact reads, proves paging.
    const nativePagingIdentity = descriptor.paginationIdentity === 'native-id';
    // Some municipal joins repeat the very same native parcel row. An explicit
    // profile may collapse identical rows within one counted page only; changing
    // geometry, distinct IDs, or a repeated ID across pages still fail closed.
    const identicalPageRows = descriptor.duplicateNativeRows === 'same-page-identical-geometry';
    // A provider's indexed transport order can differ from its durable parcel key.
    const sortField = descriptor.sortField ?? idField;
    // An explicit sort can force a municipal datastore to scan the whole layer
    // before answering a tiny spatial query. Its bounded first page needs no offset.
    const omitSortBy = descriptor.omitSortBy === true;
    const schemaGuard = descriptor.unfilteredSchemaProfile === undefined ? null
        : createOgunWfsSchemaGuard(descriptor, { fetchImpl });
    const featureIdParameter = descriptor.featureIdParameter ?? (version === '2.0.0' ? 'resourceId' : 'featureID');
    // XML NCNames permit Unicode letters, digits and combining marks, excluding CQL operators.
    const identifier = /^[\p{L}_][\p{L}\p{N}\p{M}_]*$/u;
    // GeoServer KVP typeNames can publish digit-leading local names (Salta's
    // public:10_catastros_Jun2026); these are URL parameters, not XML element names.
    const featureTypeName = /^([\p{L}_][\p{L}\p{N}\p{M}_.-]*):([\p{L}\p{N}_][\p{L}\p{N}\p{M}_.-]*)$/u;
    if (!id || !idPrefix || (featureIdMode ? idField !== null || idType !== 'string' || (requestProperties !== true && !schemaGuard)
        || !['resourceId', 'featureID'].includes(featureIdParameter)
        || (version === '1.1.0' && featureIdParameter !== 'featureID')
        || !Array.isArray(outFields) || outFields.length !== 0
        : typeof idField !== 'string' || !identifier.test(idField)) || !['string', 'integer', 'decimal'].includes(idType)
        || (descriptor.nativeIdMode !== undefined && !featureIdMode)
        || (!featureIdMode && descriptor.featureIdParameter !== undefined)
        || (descriptor.paginationIdentity !== undefined && (!nativePagingIdentity || featureIdMode))
        || (descriptor.duplicateNativeRows !== undefined && (!identicalPageRows || !nativePagingIdentity || compositeIdentity))
        || (descriptor.sortField !== undefined && (featureIdMode
            || typeof descriptor.sortField !== 'string' || !identifier.test(descriptor.sortField)))
        || !['1.0.0', '1.1.0', '2.0.0'].includes(version)
        || (responseSrid !== undefined && ![3857, 4326].includes(responseSrid)
            && (!Number.isSafeInteger(responseSrid) || responseSrid <= 0 || typeof responseProjection !== 'string'))
        || (responseProjection !== undefined && (responseSrid === undefined || [3857, 4326].includes(responseSrid)
            || !/^\+proj=/.test(responseProjection)))
        || (responseCoordinatePrecision !== undefined && (responseSrid !== 3857
            || !Number.isInteger(responseCoordinatePrecision) || responseCoordinatePrecision < 0 || responseCoordinatePrecision > 8))
        || (requestProperties !== undefined && typeof requestProperties !== 'boolean')
        || (descriptor.filterBoundsGeometry !== undefined && typeof descriptor.filterBoundsGeometry !== 'boolean')
        || (descriptor.omitSortBy !== undefined && typeof descriptor.omitSortBy !== 'boolean')
        || !Number.isSafeInteger(idBatchSize) || idBatchSize < 1 || idBatchSize > 80
        || (minRequestIntervalMs !== undefined && (!Number.isSafeInteger(minRequestIntervalMs) || minRequestIntervalMs < 100 || minRequestIntervalMs > 5000))
        || (descriptor.timeoutMs !== undefined && (!Number.isSafeInteger(descriptor.timeoutMs)
            || timeoutMs < 1000 || timeoutMs > 45000))
        || !Number.isSafeInteger(connectRetries) || connectRetries < 0 || connectRetries > 2
        || (descriptor.matchCountMode !== undefined && (!remainingMatchCount || version !== '1.1.0'))
        || !featureTypeName.test(featureType)
        || !Array.isArray(outFields) || (!featureIdMode && !outFields.includes(idField))
        || (requestProperties && (typeof descriptor.geometryField !== 'string' || !identifier.test(descriptor.geometryField)
            || outFields.some(field => typeof field !== 'string' || !identifier.test(field))))
        || (descriptor.parcelNumberField && !outFields.includes(descriptor.parcelNumberField))
        || (new URL(endpoint).protocol !== 'https:' && !isTucumanWfsSource(descriptor))
        || (descriptor.proxyEndpoint && new URL(descriptor.proxyEndpoint).protocol !== 'https:')) throw new Error('Invalid WFS parcel source descriptor.');
    const attributeFilter = createParcelAttributeFilter(descriptor);
    const hasFixedAttributeFilter = Boolean(attributeFilter.where);
    if ((hasFixedAttributeFilter || descriptor.boundsFilter === 'cql') && (typeof descriptor.geometryField !== 'string' || !identifier.test(descriptor.geometryField))) {
        throw new Error('Invalid WFS parcel source descriptor.');
    }
    const idPattern = descriptor.idPattern ? new RegExp(descriptor.idPattern) : null;
    const pageSize = featureIdMode ? descriptor.pageSize ?? 1000 : descriptor.pageSize || 1000;
    const maxFeatures = featureIdMode ? descriptor.maxFeatures ?? 10000 : descriptor.maxFeatures || 10000;
    const maxBboxKm2 = featureIdMode ? descriptor.maxBboxKm2 ?? 25 : descriptor.maxBboxKm2 || 25;
    const maxResponseBytes = descriptor.maxResponseBytes ?? 8 * 1024 * 1024;
    if (descriptor.maxResponseBytes !== undefined && (!Number.isSafeInteger(maxResponseBytes)
        || maxResponseBytes < 1 || maxResponseBytes > 20 * 1024 * 1024)) {
        throw new Error('Invalid WFS parcel source limits.');
    }
    if (featureIdMode && (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 10000
        || !Number.isSafeInteger(maxFeatures) || maxFeatures < 1 || maxFeatures > 100000
        || !Number.isFinite(maxBboxKm2) || maxBboxKm2 <= 0
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 20 * 1024 * 1024)) {
        throw new Error('Invalid WFS parcel source limits.');
    }
    // A few GeoServer deployments round GeoJSON to four decimal places. Asking for
    // metres preserves their source precision; transform only an explicitly tagged CRS.
    const toWgs84 = responseSrid === 3857 ? proj4('EPSG:3857', 'EPSG:4326')
        : responseProjection ? proj4(responseProjection, 'EPSG:4326') : null;
    function wgs84Geometry(geometry) {
        if (!toWgs84) return geometry;
        try {
            if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) throw new Error();
            const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
            const coordinates = polygons.map(polygon => polygon.map(ring => ring.map(point => {
                if (!Array.isArray(point) || point.length < 2 || point.slice(0, 2).some(value =>
                    typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 20037508.34278925)) throw new Error();
                // Mixed upstream serializers can alternate between full precision and a
                // fixed decimal limit. Normalize in metres at the documented read precision.
                const xy = responseCoordinatePrecision === undefined ? point.slice(0, 2)
                    : point.slice(0, 2).map(value => Number(value.toFixed(responseCoordinatePrecision)));
                return toWgs84.forward(xy);
            })));
            return { type: geometry.type, coordinates: geometry.type === 'Polygon' ? coordinates[0] : coordinates };
        } catch (_) {
            throw upstreamError('WFS parcel provider returned invalid projected polygon geometry.');
        }
    }
    // Some published numeric keys (RAN PIT20 PAR_ID) contain fractional values.
    // Keep their exact JS decimal representation; rounding would merge source records.
    const validDecimalId = value => typeof value === 'number' && Number.isFinite(value)
        && value >= 0 && value <= Number.MAX_SAFE_INTEGER && !Object.is(value, -0)
        && /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(String(value));
    const validId = value => idType === 'decimal' ? validDecimalId(value) : idType === 'integer'
        ? typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        : typeof value === 'string' && value.length > 0 && value.length <= 256
            && (!idPattern || idPattern.test(value));
    const validExternalId = value => idType === 'decimal'
        ? typeof value === 'string' && validDecimalId(Number(value)) && String(Number(value)) === value
        : idType === 'integer'
        ? typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value))
        : validId(value);
    const routableFeatureId = value => validId(value) && /^[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/.test(value);
    // GeoTools' fid-<JVM UID> values are generated transport identities, even if a
    // single server happens to reuse them. They cannot become durable parcel keys.
    const generatedFeatureId = value => /(?:^|\.)fid--?[0-9a-f]+_[0-9a-f]+_-?[0-9a-f]+$/i.test(value);
    const unstableIdentity = () => upstreamError('WFS provider has no stable native feature identity.', 502, 'parcel-source-unstable-identity');

    async function readPayload(response) {
        // Attribute-ID services can opt into the same streamed byte budget as native-FID layers.
        // Check actual chunks, including responses without a truthful Content-Length header.
        if (!featureIdMode && descriptor.maxResponseBytes === undefined) return response.json();
        const reader = response.body?.getReader();
        if (!reader) throw upstreamError('WFS provider omitted its response body.');
        let bytes = 0;
        const chunks = [];
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes > maxResponseBytes) throw upstreamError('WFS provider exceeded the response byte limit.');
                chunks.push(value);
            }
            return JSON.parse(new TextDecoder('utf-8').decode(concatBytes(chunks)));
        } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
        }
    }

    async function query(params) {
        // Ogun's reviewed non-personal schema is checked before any unfiltered read.
        if (schemaGuard) await schemaGuard.verify();
        const byId = new Map();
        const seenObjects = new Set();
        let offset = 0;
        let matched;
        let duplicateRows = 0;
        for (;;) {
            const search = new URLSearchParams({
                service: 'WFS', version, request: 'GetFeature',
                ...(version !== '2.0.0' ? { typeName: featureType } : { typeNames: featureType }),
                outputFormat: 'application/json', srsName: responseSrid ? `EPSG:${responseSrid}` : version === '1.0.0' ? 'EPSG:4326' : 'CRS:84',
                ...(!featureIdMode && !omitSortBy ? { sortBy: sortField } : {}),
                ...(requestProperties ? { propertyName: [...new Set([descriptor.geometryField, ...outFields])].join(',') } : {}),
                // GeoServer accepts count beside WFS 1.0 maxFeatures; both advertise the
                // same observed limit to the qualification request recorder.
                ...(version === '1.0.0' ? { maxFeatures: String(pageSize), count: String(pageSize) }
                    : version === '1.1.0' ? { maxFeatures: String(pageSize) } : { count: String(pageSize) }),
                // GeoServer requests a natural primary-key sort even for startIndex=0.
                // A feature-ID-only layer has no attribute to invent for that sort.
                ...(!featureIdMode && !omitSortBy || offset > 0 ? { startIndex: String(offset) } : {}), ...params
            });
            let payload;
            try {
                payload = await queueSourceRequest(endpoint, minRequestIntervalMs, async () => {
                    // Start the timeout after any provider-specific rate-limit wait.
                    const signal = AbortSignal.timeout(timeoutMs);
                    try {
                        let response;
                        // Node's connection deadline can expire before the query deadline,
                        // especially during cold DNS resolution. Retry only connection failures,
                        // within the original deadline; HTTP and payload failures remain errors.
                        for (let attempt = 0; ; attempt++) {
                            try {
                                response = await fetchImpl(requestUrl(search), { signal, redirect: 'error',
                                    ...(featureIdMode ? { cache: 'no-store' } : {}),
                                    headers: { Accept: 'application/geo+json, application/json' } });
                                break;
                            } catch (error) {
                                const code = error?.cause?.code ?? error?.code;
                                if (attempt >= connectRetries || signal.aborted
                                    || !['UND_ERR_CONNECT_TIMEOUT', 'EAI_AGAIN'].includes(code)) throw error;
                            }
                        }
                        if (!response.ok) throw providerHttpError(response);
                        return await readPayload(response);
                    } catch (error) {
                        if (signal.aborted || error.name === 'TimeoutError' || error.name === 'AbortError') throw upstreamError('Parcel provider timed out.', 504);
                        if (error.status) throw error;
                        throw upstreamError('Parcel provider is unavailable.');
                    }
                });
            } catch (error) {
                if (error.status) throw error;
                throw upstreamError('Parcel provider is unavailable.');
            }
            if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features)) throw upstreamError('WFS parcel provider returned an invalid FeatureCollection.');
            if (!geoJsonResponseCrsMatches(payload.crs, responseSrid ?? 4326,
                { required: toWgs84 !== null && payload.features.length > 0 })) {
                throw upstreamError(toWgs84
                    ? 'WFS parcel provider omitted or changed its projected response CRS.'
                    : 'WFS parcel provider declared an unsupported or mismatched response CRS.');
            }
            const page = schemaGuard ? payload.features.map(feature => schemaGuard.minimize(feature)) : payload.features;
            if (page.length > pageSize) throw upstreamError('WFS parcel provider returned more features than the configured page limit.');
            const reportedMatched = version !== '2.0.0' ? payload.totalFeatures : payload.numberMatched;
            // Pohang's WFS 1.1 totalFeatures counts rows remaining after startIndex.
            // Normalize that documented wire count, then require the same full total
            // on every page; never infer completeness from a short page alone.
            const pageMatched = remainingMatchCount && Number.isSafeInteger(reportedMatched)
                ? offset + reportedMatched : reportedMatched;
            if (!Number.isSafeInteger(pageMatched) || pageMatched < 0
                || (version === '2.0.0' && payload.numberReturned !== page.length)
                || (version !== '2.0.0' && ((payload.numberMatched !== undefined && payload.numberMatched !== pageMatched)
                    || (payload.numberReturned !== undefined && payload.numberReturned !== page.length)))
                || (matched !== undefined && pageMatched !== matched)) {
                throw upstreamError('WFS parcel provider returned missing, inconsistent or changing match counts.');
            }
            matched = pageMatched;
            if (matched > maxFeatures) throw areaLimitError('Parcel provider query exceeds the parcel limit; use a smaller area.');
            if (offset + page.length > matched || (!page.length && offset < matched)) throw upstreamError('WFS parcel provider returned incomplete pagination.');
            // A repeated whole page cannot establish a complete enumeration.
            if (compositeIdentity && offset > 0 && page.every(row => seenObjects.has(`${row.properties?.[idField]}|geom-sha256=${sha256Hex(JSON.stringify(row.geometry))}`))) {
                throw upstreamError('WFS parcel provider repeated a composite identity page.');
            }
            const pageNativeGeometry = new Map();
            for (const feature of page) {
                if (hasFixedAttributeFilter && !attributeFilter.matches(feature?.properties || {})) {
                    throw upstreamError('WFS parcel provider returned a feature outside its configured attribute filter.');
                }
                const nativeId = featureIdMode ? feature?.id : feature?.properties?.[idField];
                if (featureIdMode && typeof nativeId === 'string' && generatedFeatureId(nativeId)) throw unstableIdentity();
                if (featureIdMode ? !routableFeatureId(nativeId) : !validId(nativeId)) throw upstreamError('Parcel provider returned a missing or invalid native parcel ID.');
                const geometry = wgs84Geometry(feature.geometry);
                if (!validateGeometry(geometry)) throw upstreamError('Parcel provider returned invalid polygon geometry.');
                // Keep distinct native records sharing a transport FID and geometry.
                // Repeated keys fail except explicitly permitted identical rows
                // within this page; cross-page repetitions always fail.
                const retainedId = compositeIdentity ? `${nativeId}|geom-sha256=${sha256Hex(JSON.stringify(geometry))}` : nativeId;
                const pagingIdentity = compositeIdentity ? retainedId : nativePagingIdentity ? nativeId : feature.id;
                if (nativePagingIdentity && seenObjects.has(pagingIdentity)) {
                    if (identicalPageRows && pageNativeGeometry.get(nativeId) === JSON.stringify(geometry)) {
                        duplicateRows++;
                        continue;
                    }
                    throw upstreamError('WFS parcel provider repeated a native parcel ID.');
                }
                if (!compositeIdentity && (typeof feature.id !== 'string' || !feature.id || (!nativePagingIdentity && seenObjects.has(pagingIdentity)))) throw upstreamError('WFS parcel provider repeated or omitted a feature ID.');
                seenObjects.add(pagingIdentity);
                if (identicalPageRows) pageNativeGeometry.set(nativeId, JSON.stringify(geometry));
                const canonical = canonicalParcelFeature(descriptor, { ...feature, geometry }, retainedId);
                if (compositeIdentity) {
                    canonical.properties.sourceParcelId = nativeId;
                    canonical.properties.parcelIdentityKind = descriptor.identityKind;
                    canonical.properties.sourceGeometryHash = retainedId.slice(-64);
                }
                const previous = byId.get(canonical.id);
                if (previous && JSON.stringify(previous.geometry) !== JSON.stringify(canonical.geometry)) throw upstreamError('Parcel provider returned conflicting geometry for one parcel ID.');
                byId.set(canonical.id, canonical);
            }
            offset += page.length;
            if (offset === matched) break;
            // Construct subsequent requests at the fixed endpoint. Never follow provider-supplied links.
        }
        return { type: 'FeatureCollection', features: [...byId.values()], complete: true, sourceId: id, returnsWGS84: true,
            ...(identicalPageRows ? { duplicateRows } : {}) };
    }

    function queryBounds(bbox) {
        validateBounds(bbox, maxBboxKm2, descriptor);
        // Project all four corners; a transverse Mercator window is not axis-aligned.
        const corners = toBounds ? [[bbox[0], bbox[1]], [bbox[2], bbox[1]],
            [bbox[2], bbox[3]], [bbox[0], bbox[3]]].map(point => toBounds.forward(point)) : null;
        const wireBbox = corners ? [Math.min(...corners.map(p => p[0])), Math.min(...corners.map(p => p[1])),
            Math.max(...corners.map(p => p[0])), Math.max(...corners.map(p => p[1]))] : bbox;
        const boundsCrs = toBounds ? `EPSG:${boundsSrid}` : version === '1.0.0' ? 'EPSG:4326' : 'CRS:84';
        // CRS:84 fixes longitude/latitude order for both the spatial filter and GeoJSON response.
        let result;
        if (hasFixedAttributeFilter || descriptor.boundsFilter === 'cql') {
            const [west, south, east, north] = wireBbox;
            const spatial = `BBOX(${descriptor.geometryField},${west},${south},${east},${north},'${toBounds ? boundsCrs : 'CRS:84'}')`;
            result = query({ cql_filter: hasFixedAttributeFilter ? `(${attributeFilter.where}) AND (${spatial})` : spatial });
        } else {
            const pending = query({ bbox: `${wireBbox.join(',')},${boundsCrs}` });
            result = featureIdMode ? verifyFeatureIds(pending) : pending;
        }
        // Daegu's WFS BBOX uses feature envelopes. Filter only after complete paging;
        // retain every ring and vertex of intersecting parcels, without clipping.
        if (descriptor.filterBoundsGeometry) {
            const footprint = bboxPolygon(bbox);
            return result.then(complete => ({ ...complete,
                features: complete.features.filter(parcel => booleanIntersects(parcel, footprint)) }));
        }
        return result;
    }

    async function verifyFeatureIds(resultPromise) {
        const result = await resultPromise;
        // No schema attribute exists to sort on. Check every enumerated feature
        // through the official ID route, without trusting page position or geometry IDs.
        for (let offset = 0; offset < result.features.length; offset += idBatchSize) {
            const batch = result.features.slice(offset, offset + idBatchSize);
            const exact = await queryIds(batch.map(feature => feature.id));
            const byId = new Map(exact.features.map(feature => [feature.id, feature]));
            if (exact.absentIds.length || batch.some(feature => !byId.has(feature.id)
                || JSON.stringify(feature.geometry) !== JSON.stringify(byId.get(feature.id).geometry))) throw unstableIdentity();
        }
        return result;
    }

    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 parcel IDs.');
        const unique = [...new Set(ids)];
        const native = unique.map(value => {
            if (typeof value !== 'string' || !value.startsWith(idPrefix)) throw new HttpError(400, 'Parcel ID belongs to a different source.');
            let tail = value.slice(idPrefix.length);
            if (compositeIdentity) {
                const match = /^(.*)\|geom-sha256=([0-9a-f]{64})$/.exec(tail);
                if (!match) throw new HttpError(400, 'Invalid composite parcel ID.');
                tail = match[1];
            }
            if (featureIdMode ? !routableFeatureId(tail) : !validExternalId(tail)) throw new HttpError(400, 'Invalid parcel ID.');
            // A vanished generated ID is not proof of parcel absence. Reject it even
            // when the provider would answer the official route with an empty result.
            if (featureIdMode && generatedFeatureId(tail)) throw unstableIdentity();
            if (featureIdMode) return tail;
            if (ogcIdFilter) return tail;
            if (idType === 'integer' || idType === 'decimal') {
                return tail;
            }
            return `'${tail.replaceAll("'", "''")}'`;
        });
        const features = [];
        for (let offset = 0; offset < native.length; offset += idBatchSize) {
            const batchIds = unique.slice(offset, offset + idBatchSize);
            const batch = native.slice(offset, offset + idBatchSize).join(',');
            let params;
            if (featureIdMode) params = { [featureIdParameter]: batch };
            else if (ogcIdFilter) {
                // Standard OGC Filter Encoding is independently supported by providers
                // whose public WFS does not accept the optional CQL extension.
                const escapeXml = value => String(value).replace(/[&<>"']/g, char =>
                    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
                const comparisons = native.slice(offset, offset + idBatchSize).map(value =>
                    `<PropertyIsEqualTo><PropertyName>${idField}</PropertyName><Literal>${escapeXml(value)}</Literal></PropertyIsEqualTo>`);
                const expression = comparisons.length === 1 ? comparisons[0] : `<Or>${comparisons.join('')}</Or>`;
                params = { filter: `<Filter xmlns="http://www.opengis.net/ogc">${expression}</Filter>` };
            }
            else {
                // GeoTools treats bare ID IN (...) as feature-ID syntax, not the attribute
                // called "id". Quote that reserved identifier to query the published row key.
                const nativeField = /^id$/i.test(idField) ? `"${idField}"` : idField;
                const idFilter = `${nativeField} IN (${batch})`;
                params = { cql_filter: hasFixedAttributeFilter ? `(${attributeFilter.where}) AND (${idFilter})` : idFilter };
            }
            const result = await query(params);
            if (compositeIdentity) {
                // The source key is non-unique. Enumerate it completely, then retain
                // only the requested key+geometry identities; siblings are not absence.
                const requestedKeys = batchIds.map(value => value.slice(idPrefix.length).split('|geom-sha256=')[0]);
                if (result.features.some(feature => !requestedKeys.includes(feature.properties.sourceParcelId))) {
                    throw upstreamError('Parcel ID query returned unexpected source keys.');
                }
                features.push(...result.features.filter(feature => batchIds.includes(feature.id)));
                continue;
            }
            if (result.features.some(feature => !batchIds.includes(feature.id))) throw upstreamError('Parcel ID query returned unexpected parcels.');
            features.push(...result.features);
        }
        // Publish absence only after every batch completed; a failed later request is not a partial answer.
        const present = new Set(features.map(feature => feature.id));
        return { type: 'FeatureCollection', features, complete: true, sourceId: id, returnsWGS84: true,
            absentIds: unique.filter(value => !present.has(value)) };
    }

    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a valid WGS84 Polygon or MultiPolygon.');
        const footprint = geoFeature(geometry);
        const result = await queryBounds(geometryBbox(footprint));
        return { ...result, features: result.features.filter(parcel => booleanIntersects(parcel, footprint)) };
    }

    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}
