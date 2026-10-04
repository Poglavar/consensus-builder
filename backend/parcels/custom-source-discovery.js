// Discovers a compatible live parcel source from a user-selected public HTTPS URL.
// This module only builds and probes adapter descriptors; it never persists source data.
import { createHash } from 'node:crypto';
import { bbox as geometryBbox } from '@turf/turf';
import { createParcelSource } from './sources.js';
import { providerHttpError, validateBounds, validateGeometry } from './source-contract.js';

const ADAPTER_ORDER = ['arcgis', 'wfs', 'ogc-api', 'socrata', 'geojson-snapshot'];
const PAGE_SIZE = 250;
const MAX_FEATURES = 5000;
const MAX_BBOX_KM2 = 1;
const MAX_EXACT_IDS = 500;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_FEATURES = 5000;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OID_NAMES = new Set(['objectid', 'oid', 'fid', 'ogc_fid', 'rowid', 'systemid']);

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
            .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function stableDescriptor(descriptor) {
    const hash = createHash('sha256').update(canonicalJson(descriptor)).digest('hex');
    return { ...descriptor, id: `custom-${hash}`, idPrefix: `CUSTOM-${hash}-` };
}

function descriptorFor(adapter, { city, metricSrid, ...specific }) {
    const base = {
        adapter,
        ...specific,
        cityIds: [city],
        defaultForCity: false,
        metricSrid,
        pageSize: PAGE_SIZE,
        maxFeatures: MAX_FEATURES,
        maxBboxKm2: MAX_BBOX_KM2
    };
    return stableDescriptor(base);
}

function validCityMetric(city, metricSrid) {
    return typeof city === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(city)
        && Number.isSafeInteger(metricSrid) && metricSrid > 0;
}

function normalizedInputUrl(raw) {
    let url;
    try { url = new URL(raw); } catch { throw inputError('Provide a valid public HTTPS source URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
        throw inputError('Custom parcel sources require an HTTPS URL without credentials or a fragment.');
    }
    if ([...url.searchParams.keys()].some(key => /^(token|access_token|api[_-]?key|apikey|key|password|signature|sig)$/i.test(key))) {
        throw inputError('Remove credentials from the custom source URL.');
    }
    return url;
}

function inputError(message) {
    return Object.assign(new Error(message), { status: 400, code: 'invalid-custom-source' });
}

function sourceFailure(message, details = {}) {
    return Object.assign(new Error(message), details);
}

function isTechnicalFailure(error, requestState) {
    const status = requestState.httpStatus ?? error?.httpStatus;
    return requestState.networkError === true || !status
        || [401, 403, 408, 425, 429].includes(status) || status >= 500;
}

function isNativeObjectId(field) {
    const name = String(field?.name || field?.fieldName || '').toLowerCase();
    const type = String(field?.type || field?.dataTypeName || '').toLowerCase();
    return OID_NAMES.has(name) || type.includes('fieldtypeoid') || field?.role === 'object-id';
}

function nativeIdType(field) {
    const type = String(field?.type || field?.dataTypeName || field?.format || '').toLowerCase();
    if (['esrifieldtypestring', 'string', 'text', 'varchar', 'character varying'].some(value => type.includes(value))) return 'string';
    if (['esrifieldtypeinteger', 'esrifieldtypesmallinteger', 'integer', 'int32', 'int64', 'int'].some(value => type.includes(value))) return 'integer';
    return null;
}

function stableFieldScore(field) {
    const name = String(field?.name || field?.fieldName || '');
    if (!IDENTIFIER.test(name) || isNativeObjectId(field) || !nativeIdType(field)) return -1;
    const compact = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const alias = String(field?.alias || field?.title || '').toLowerCase();
    if (field?.role === 'id' || field?.['x-ogc-role'] === 'id') return 120;
    if (/^(parcel(id|number|no|num|identifier|key)|apn|pin|pin10|bbl|sbl|taxlot(id)?|folio|cadastral(id|key)|cadastre(id|key)|lotid)$/.test(compact)) return 100;
    if (/(parcel|cadastr|cadastre|taxlot|taxparcel|landparcel|propertyparcel)/.test(compact)) return 80;
    if (/(^|_)(apn|pin|bbl|sbl|folio)(_|$)/i.test(name)) return 75;
    if (/(parcel|cadastr|cadastre|tax lot|tax parcel|folio)/.test(alias)) return 65;
    return -1;
}

function chooseNativeField(fields) {
    if (!Array.isArray(fields)) return null;
    const ranked = fields.map((field, index) => ({ field, index, score: stableFieldScore(field) }))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index);
    if (!ranked.length) return null;
    const { field } = ranked[0];
    return { name: field.name || field.fieldName, idType: nativeIdType(field), field };
}

function parcelLike(value) {
    return /(parcel|cadastr|cadastre|tax.?lot|tax.?parcel|land.?lot)/i.test(String(value || ''));
}

function buildingLike(value) {
    return /(building|bldg|zgrad|geb(ae|ä)ude|edific|b(a|â)timent|footprint)/i.test(String(value || ''));
}

const compactName = field => String(field?.name || field?.fieldName || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// A building needs SOME stable key for the scene and the carve, not a legal identifier: a named
// building key is best, a generic id next, and the layer's own object id is acceptable.
function chooseBuildingId(fields, objectIdField) {
    if (!Array.isArray(fields)) return null;
    const score = field => {
        const name = String(field?.name || field?.fieldName || '');
        if (!IDENTIFIER.test(name)) return -1;
        const compact = compactName(field);
        const type = nativeIdType(field) || (isNativeObjectId(field) ? 'integer' : null);
        if (!type) return -1;
        if (field?.role === 'id' || field?.['x-ogc-role'] === 'id') return 120;
        if (/^(building|bldg|zgrada|gebaeude|edificio|batiment)(id|no|num|number|key)?$/.test(compact)
            || /^(bin|uprn|egid|osmid|gmlid)$/.test(compact)) return 100;
        if (/(building|bldg|zgrad|gebaeud|edific|batiment)/.test(compact) && /(id|no|num|key)$/.test(compact)) return 80;
        if (/^(id|gid|fid|uid|ogcfid)$/.test(compact)) return 50;
        if (name === objectIdField || isNativeObjectId(field)) return 30;
        return -1;
    };
    const ranked = fields.map((field, index) => ({ field, index, score: score(field) }))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index);
    if (!ranked.length) return null;
    const { field } = ranked[0];
    return { name: field.name || field.fieldName, idType: nativeIdType(field) || 'integer', field };
}

// The fields that carry a building's height (metres, or feet when the name says so) and its storey
// count. Either may be missing; the provider then estimates (buildings/building-heights.js).
function buildingHeightFields(fields) {
    const list = Array.isArray(fields) ? fields : [];
    const named = re => list.find(field => IDENTIFIER.test(String(field?.name || field?.fieldName || '')) && re.test(compactName(field)));
    const height = named(/^(height|heightm|heightft|measuredheight|bldgheight|buildingheight|roofheight|heightroof|hoehe|visina|altura|hauteur|hgt)$/);
    const levels = named(/^(levels|buildinglevels|floors|numfloors|nofloors|numberoffloors|storeys|stories|etaze|brojetaza|geschosse|anzahlgeschosse|pisos|niveaux)$/);
    const heightField = height ? (height.name || height.fieldName) : undefined;
    const levelsField = levels ? (levels.name || levels.fieldName) : undefined;
    return {
        heightField,
        levelsField,
        heightUnit: heightField && /(ft|feet)/i.test(heightField) ? 'ft' : (heightField ? 'm' : undefined)
    };
}

// What differs between a parcel source and a building source: which layer counts, which field is
// the key, which extra fields ride along, and whether every id must round-trip exactly (a parcel is
// a legal identity; a building only needs to draw and carve consistently).
const PROFILES = {
    parcel: {
        noun: 'parcel',
        layerLike: parcelLike,
        chooseId: fields => chooseNativeField(fields),
        idMayBeObjectId: false,
        extras: () => ({}),
        verifyIds: true
    },
    building: {
        noun: 'building',
        layerLike: buildingLike,
        chooseId: (fields, objectIdField) => chooseBuildingId(fields, objectIdField),
        idMayBeObjectId: true,
        extras: fields => ({ kind: 'building', ...buildingHeightFields(fields) }),
        verifyIds: false
    }
};

// outFields plus the height/storey fields, deduplicated; the extras without undefined keys.
function withExtras(profile, fields, outFields) {
    const extras = Object.fromEntries(Object.entries(profile.extras(fields)).filter(([, value]) => value !== undefined));
    const out = [...new Set([...outFields, ...[extras.heightField, extras.levelsField].filter(Boolean)])];
    return { extras, outFields: out };
}

function stripQuery(url) {
    const clean = new URL(url);
    clean.search = '';
    clean.hash = '';
    return clean;
}

function addQuery(url, params) {
    const result = new URL(url);
    result.search = '';
    for (const [key, value] of Object.entries(params)) result.searchParams.set(key, value);
    return result.href;
}

function layerFromArcgisUrl(input) {
    const url = stripQuery(input);
    const match = url.pathname.match(/\/(featureserver|mapserver)(?:\/(\d+))?(?:\/query)?\/?$/i);
    if (!match) return null;
    url.pathname = url.pathname.replace(/\/query\/?$/i, '').replace(/\/$/, '');
    return { serviceType: match[1].toLowerCase(), layerId: match[2] ?? null, serviceUrl: url.href };
}

function objectIdFieldFromLayer(metadata) {
    if (IDENTIFIER.test(metadata.objectIdField || '')) return metadata.objectIdField;
    const field = metadata.fields?.find(item => String(item.type || '').toLowerCase() === 'esrifieldtypeoid');
    return field?.name || null;
}

function wfsTypeNames(xml) {
    const names = [];
    for (const match of String(xml).matchAll(/<(?:[\w.-]+:)?FeatureType\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?FeatureType>/gi)) {
        const name = match[1].match(/<(?:[\w.-]+:)?Name\b[^>]*>([^<]+)<\//i)?.[1]?.trim();
        if (name) names.push(name);
    }
    return [...new Set(names)];
}

function wfsSchemaFields(xml) {
    const fields = [];
    for (const match of String(xml).matchAll(/<(?:[\w.-]+:)?element\b([^>]*?)\/?\s*>/gi)) {
        const attributes = match[1];
        const name = attributes.match(/\bname\s*=\s*['"]([^'"]+)['"]/i)?.[1];
        const type = attributes.match(/\btype\s*=\s*['"]([^'"]+)['"]/i)?.[1] || '';
        if (name && !name.includes(':')) fields.push({ name, type });
    }
    return fields;
}

function schemaProperties(collection) {
    const schema = collection?.itemPropertiesSchema || collection?.propertiesSchema || collection?.schema;
    const properties = schema?.properties || collection?.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return [];
    return Object.entries(properties).map(([name, value]) => ({
        name, type: value?.type, format: value?.format,
        role: value?.['x-ogc-role'] || value?.role, 'x-ogc-role': value?.['x-ogc-role']
    }));
}

function socrataSlug(pathname) {
    const resource = pathname.match(/\/resource\/([A-Za-z0-9-]{4,20})\.json\/?$/i);
    const metadata = pathname.match(/\/api\/views\/([A-Za-z0-9-]{4,20})\/?$/i);
    return { id: resource?.[1] || metadata?.[1] || null, metadata: Boolean(metadata) };
}

function socrataFieldType(column) {
    const type = String(column.dataTypeName || column.renderTypeName || '').toLowerCase();
    if (['text', 'number'].includes(type)) return 'string';
    return null;
}

function propertyGeometryField(columns) {
    const preferred = ['the_geom', 'shape', 'geometry', 'geom'];
    const geometries = columns.filter(column => /polygon|location/i.test(String(column.dataTypeName || ''))
        && IDENTIFIER.test(column.fieldName || ''));
    for (const name of preferred) {
        const field = geometries.find(column => column.fieldName.toLowerCase() === name);
        if (field) return field.fieldName;
    }
    return geometries.find(column => /polygon/i.test(String(column.dataTypeName || '')))?.fieldName || null;
}

function isValidExtent(extent) {
    return Array.isArray(extent) && extent.length === 4 && extent.every(Number.isFinite)
        && extent[0] >= -180 && extent[2] <= 180 && extent[1] >= -90 && extent[3] <= 90
        && extent[0] < extent[2] && extent[1] < extent[3];
}

function covers(outer, inner) {
    return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
}

function httpStatusFromError(error) {
    if (Number.isInteger(error?.httpStatus)) return error.httpStatus;
    const match = String(error?.message || '').match(/HTTP\s+(\d{3})/i);
    return match ? Number(match[1]) : undefined;
}

function publicError(error) {
    const status = Number.isInteger(error?.httpStatus) ? error.httpStatus
        : Number.isInteger(error?.upstreamStatus) ? error.upstreamStatus : undefined;
    const code = typeof error?.code === 'string' && /^[a-z0-9-]{1,80}$/.test(error.code) ? error.code : undefined;
    const localMessages = new Set([
        'The probe bbox returned no polygons; identity cannot be verified.',
        'The probe returned invalid or repeated parcel identity/geometry.',
        'The adapter did not prove a complete spatial FeatureCollection.',
        'The adapter did not resolve every probed parcel ID.',
        'The exact-ID query returned an invalid or unexpected parcel.',
        'The exact-ID query returned geometry that differs from the spatial record.',
        'The exact-ID query omitted a spatially observed parcel.'
    ]);
    return {
        message: status ? `Parcel provider responded with HTTP ${status}.`
            : localMessages.has(error?.message) ? error.message : 'Source probe could not be verified.',
        ...(status ? { httpStatus: status } : {}),
        ...(code ? { code } : {})
    };
}

function discoveryFailure(attempts) {
    const technical = [...attempts].reverse().find(isTechnicalAttempt);
    const last = technical || [...attempts].reverse().find(attempt => attempt.status === 'failed' || attempt.status === 'rejected');
    if (technical) {
        const upstreamStatus = technical.error?.httpStatus;
        const rateLimited = upstreamStatus === 429;
        const blocked = [401, 403].includes(upstreamStatus);
        const timedOut = [408, 504].includes(upstreamStatus) || technical.networkError;
        const code = rateLimited ? 'parcel-source-rate-limited' : blocked ? 'parcel-source-blocked' : 'parcel-source-unavailable';
        return Object.assign(providerHttpError(upstreamStatus || (timedOut ? 504 : 502), technical.retryAfterSeconds), {
            code,
            status: timedOut ? 504 : 502,
            ...(upstreamStatus ? { upstreamStatus } : {}),
            ...(technical.retryAfterSeconds ? { retryAfterSeconds: technical.retryAfterSeconds } : {}),
            attempts
        });
    }
    return Object.assign(new Error(last?.error?.message || 'No supported parcel adapter passed identity and geometry verification.'), {
        code: 'no-available-adapter', attempts
    });
}

function isTechnicalAttempt(attempt) {
    if (attempt?.status !== 'failed') return false;
    const status = attempt.error?.httpStatus;
    return attempt.networkError === true || [401, 403, 408, 425, 429].includes(status) || status >= 500;
}

function descriptorBase(adapter, details, city, metricSrid) {
    return descriptorFor(adapter, { city, metricSrid, ...details });
}

export function discoverCustomParcelSource(input, options) {
    return discoverCustomSource({ ...input, kind: 'parcel' }, options);
}

export function discoverCustomBuildingSource(input, options) {
    return discoverCustomSource({ ...input, kind: 'building' }, options);
}

async function discoverCustomSource({ url: rawUrl, city, metricSrid, bbox, kind = 'parcel' }, {
    fetchImpl = globalThis.fetch,
    createSource = createParcelSource
} = {}) {
    const profile = PROFILES[kind];
    if (!profile) throw inputError('Unknown source kind.');
    if (!validCityMetric(city, metricSrid)) throw inputError('Provide a city ID and a positive metric SRID.');
    if (typeof fetchImpl !== 'function' || typeof createSource !== 'function') throw inputError('A public source fetcher is required.');
    const inputUrl = normalizedInputUrl(rawUrl);
    try { validateBounds(bbox, MAX_BBOX_KM2); } catch (error) { throw Object.assign(error, { code: 'invalid-custom-source' }); }

    const attempts = ADAPTER_ORDER.map(adapter => ({ adapter, status: 'not-applicable' }));
    const attemptByAdapter = new Map(attempts.map(attempt => [attempt.adapter, attempt]));
    const requestState = { httpStatus: undefined, networkError: false, retryAfterSeconds: undefined };
    const trackedFetch = async (target, options = {}) => {
        requestState.httpStatus = undefined;
        requestState.networkError = false;
        requestState.retryAfterSeconds = undefined;
        try {
            const response = await fetchImpl(target, { ...options, redirect: 'error' });
            requestState.httpStatus = response?.status;
            const retryAfter = response?.headers?.get?.('retry-after');
            if (retryAfter && /^\d+$/.test(retryAfter)) requestState.retryAfterSeconds = Math.min(Number(retryAfter), 86400);
            return response;
        } catch (error) {
            requestState.networkError = true;
            throw error;
        }
    };
    const requestJson = async (adapter, stage, target, accept = 'application/json') => {
        const response = await trackedFetch(target, { headers: { Accept: accept } });
        if (!response?.ok || response.status !== 200) {
            throw providerHttpError(response || 502);
        }
        try { return await response.json(); }
        catch { throw sourceFailure(`${adapter} ${stage} was not valid JSON.`, { code: 'invalid-json' }); }
    };
    const requestText = async (adapter, stage, target) => {
        const response = await trackedFetch(target, { headers: { Accept: 'application/xml, text/xml, application/json' } });
        if (!response?.ok || response.status !== 200) {
            throw providerHttpError(response || 502);
        }
        try { return await response.text(); }
        catch { throw sourceFailure(`${adapter} ${stage} could not be read.`, { code: 'invalid-body' }); }
    };

    const tryCandidate = async (adapter, build) => {
        const attempt = attemptByAdapter.get(adapter);
        attempt.status = 'probing';
        attempt.stages = [];
        let stage = 'metadata';
        try {
            const descriptor = await build({ requestJson, requestText, stage: value => { stage = value; attempt.stages.push(value); } });
            if (!descriptor) { attempt.status = 'not-applicable'; return null; }
            stage = 'adapter-verification';
            attempt.stages.push(stage);
            const adapterInstance = createSource(descriptor, { fetchImpl: trackedFetch });
            const spatial = await adapterInstance.queryBounds(bbox);
            if (!spatial || spatial.complete !== true || !Array.isArray(spatial.features)) {
                throw sourceFailure('Adapter did not prove a complete spatial FeatureCollection.', { code: 'incomplete-bounds' });
            }
            if (!spatial.features.length) throw sourceFailure('The probe bbox returned no polygons; identity cannot be verified.', { code: 'empty-bounds' });
            if (!profile.verifyIds) {
                if (spatial.features.some(feature => !validateGeometry(feature?.geometry))) {
                    throw sourceFailure(`The probe returned an invalid ${profile.noun} polygon.`, { code: 'invalid-geometry' });
                }
                attempt.status = 'verified';
                attempt.verifiedFeatureCount = spatial.features.length;
                return { descriptor, attempts };
            }
            if (spatial.features.length > MAX_EXACT_IDS) {
                throw sourceFailure(`The probe returned more than ${MAX_EXACT_IDS} polygons; use a smaller bbox for exact identity checks.`, { code: 'probe-too-large' });
            }
            const byId = new Map();
            for (const feature of spatial.features) {
                if (typeof feature?.id !== 'string' || !feature.id || !validateGeometry(feature.geometry) || byId.has(feature.id)) {
                    throw sourceFailure('The probe returned invalid or repeated parcel identity/geometry.', { code: 'invalid-parcel' });
                }
                byId.set(feature.id, feature);
            }
            const ids = [...byId.keys()];
            const returned = new Map();
            for (let offset = 0; offset < ids.length; offset += 80) {
                const batch = ids.slice(offset, offset + 80);
                const exact = await adapterInstance.queryIds(batch);
                if (!exact || exact.complete !== true || !Array.isArray(exact.features)
                    || !Array.isArray(exact.absentIds) || exact.absentIds.length) {
                    throw sourceFailure('The adapter did not resolve every probed parcel ID.', { code: 'exact-id-incomplete' });
                }
                for (const feature of exact.features) {
                    if (typeof feature?.id !== 'string' || !batch.includes(feature.id) || returned.has(feature.id)
                        || !validateGeometry(feature.geometry)) {
                        throw sourceFailure('The exact-ID query returned an invalid or unexpected parcel.', { code: 'exact-id-invalid' });
                    }
                    if (canonicalJson(byId.get(feature.id).geometry) !== canonicalJson(feature.geometry)) {
                        throw sourceFailure('The exact-ID query returned geometry that differs from the spatial record.', { code: 'exact-id-geometry-mismatch' });
                    }
                    returned.set(feature.id, feature);
                }
            }
            if (returned.size !== byId.size || ids.some(id => !returned.has(id))) {
                throw sourceFailure('The exact-ID query omitted a spatially observed parcel.', { code: 'exact-id-incomplete' });
            }
            attempt.status = 'verified';
            attempt.verifiedFeatureCount = byId.size;
            return { descriptor, attempts };
        } catch (error) {
            attempt.status = requestState.networkError || isTechnicalFailure(error, requestState) ? 'failed' : 'rejected';
            attempt.failedStage = stage;
            attempt.error = { ...publicError(error), ...(error?.httpStatus ?? error?.upstreamStatus ?? requestState.httpStatus) !== undefined
                ? { httpStatus: error?.httpStatus ?? error?.upstreamStatus ?? requestState.httpStatus } : {} };
            if (requestState.networkError) attempt.networkError = true;
            if (requestState.retryAfterSeconds) attempt.retryAfterSeconds = requestState.retryAfterSeconds;
            return null;
        }
    };

    const arcgis = layerFromArcgisUrl(inputUrl);
    if (arcgis) {
        const result = await tryCandidate('arcgis', async ({ requestJson, stage }) => {
            let endpoint = arcgis.serviceUrl;
            let layerId = arcgis.layerId;
            if (!layerId) {
                stage('service-metadata');
                const service = await requestJson('arcgis', 'service metadata', addQuery(endpoint, { f: 'json' }));
                const layers = (service.layers || []).filter(layer => profile.layerLike(layer.name));
                if (layers.length !== 1) throw sourceFailure(`ArcGIS service does not identify exactly one ${profile.noun} layer.`, { code: 'ambiguous-layer' });
                layerId = String(layers[0].id);
                endpoint = `${endpoint.replace(/\/$/, '')}/${layerId}`;
            }
            stage('layer-metadata');
            const metadata = await requestJson('arcgis', 'layer metadata', addQuery(endpoint, { f: 'json' }));
            if (metadata.error) throw sourceFailure('ArcGIS metadata reported an error.', { code: 'metadata-error' });
            const objectIdField = objectIdFieldFromLayer(metadata);
            const native = profile.chooseId(metadata.fields, objectIdField);
            if (!native || !objectIdField || (native.name === objectIdField && !profile.idMayBeObjectId)) {
                throw sourceFailure(`ArcGIS layer has no recognized stable ${profile.noun} key and object ID.`, { code: 'missing-stable-id' });
            }
            const { extras, outFields } = withExtras(profile, metadata.fields, [objectIdField, native.name]);
            return descriptorBase('arcgis', {
                endpoint, idField: native.name, idType: native.idType, objectIdField,
                parcelNumberField: native.name, outFields, ...extras
            }, city, metricSrid);
        });
        if (result) return result;
        const attempt = attemptByAdapter.get('arcgis');
        if (isTechnicalAttempt(attempt)) throw discoveryFailure(attempts);
    }

    const wfsUrl = stripQuery(inputUrl);
    const wfsParams = new URLSearchParams(inputUrl.search);
    const typeName = wfsParams.get('typeNames') || wfsParams.get('typeName') || wfsParams.get('typenames') || '';
    const isWfs = [...wfsParams.keys()].some(key => key.toLowerCase() === 'service' && wfsParams.get(key).toLowerCase() === 'wfs')
        || Boolean(typeName) || /\/(?:wfs|ows)\/?$/i.test(inputUrl.pathname)
        // A user may paste a vendor-named URL that is actually a WFS endpoint.
        || Boolean(arcgis && attempts.find(attempt => attempt.adapter === 'arcgis')?.status === 'rejected');
    if (isWfs) {
        const result = await tryCandidate('wfs', async ({ requestText, stage }) => {
            let version = wfsParams.get('version') || '2.0.0';
            let featureType = typeName;
            if (!featureType) {
                stage('capabilities');
                const capabilitiesUrl = addQuery(wfsUrl.href, { service: 'WFS', request: 'GetCapabilities' });
                const capabilities = await requestText('wfs', 'GetCapabilities', capabilitiesUrl);
                const declared = wfsTypeNames(capabilities).filter(profile.layerLike);
                if (declared.length !== 1) throw sourceFailure(`WFS capabilities do not identify exactly one ${profile.noun} feature type.`, { code: 'ambiguous-feature-type' });
                featureType = declared[0];
                version = capabilities.match(/<(?:(?:[\w.-]+):)?(?:WFS_Capabilities|WFS_CapabilitiesType)\b[^>]*\bversion\s*=\s*['"]([^'"]+)/i)?.[1] || version;
            }
            if (!['1.1.0', '2.0.0'].includes(version)) version = '2.0.0';
            if (!/^[A-Za-z0-9_.]+:[A-Za-z0-9_]+$/.test(featureType)) {
                throw sourceFailure('WFS feature type name is not supported.', { code: 'invalid-feature-type' });
            }
            stage('describe-feature-type');
            const describe = addQuery(wfsUrl.href, { service: 'WFS', version, request: 'DescribeFeatureType',
                [version === '1.1.0' ? 'typeName' : 'typeNames']: featureType });
            const schema = await requestText('wfs', 'DescribeFeatureType', describe);
            const schemaFields = wfsSchemaFields(schema);
            const native = profile.chooseId(schemaFields);
            if (!native) throw sourceFailure(`WFS feature type exposes no recognized stable ${profile.noun} key.`, { code: 'missing-stable-id' });
            const { extras, outFields } = withExtras(profile, schemaFields, [native.name]);
            return descriptorBase('wfs', {
                endpoint: wfsUrl.href, featureType, typeName: featureType, version,
                idField: native.name, idType: native.idType, parcelNumberField: native.name,
                outFields, ...extras
            }, city, metricSrid);
        });
        if (result) return result;
        const attempt = attemptByAdapter.get('wfs');
        if (isTechnicalAttempt(attempt)) throw discoveryFailure(attempts);
    }

    const ogc = inputUrl.pathname.match(/^(.*)\/collections(?:\/([^/]+))?(?:\/items)?\/?$/i);
    if (ogc) {
        const result = await tryCandidate('ogc-api', async ({ requestJson, stage }) => {
            const prefix = `${inputUrl.origin}${ogc[1]}`.replace(/\/$/, '');
            let collectionId = ogc[2] ? decodeURIComponent(ogc[2]) : '';
            if (!collectionId) {
                stage('collections');
                const body = await requestJson('ogc-api', 'collections metadata', `${prefix}/collections?f=json`);
                const candidates = (body.collections || []).filter(item => profile.layerLike(item.id) || profile.layerLike(item.title));
                if (candidates.length !== 1) throw sourceFailure(`OGC API does not identify exactly one ${profile.noun} collection.`, { code: 'ambiguous-collection' });
                collectionId = candidates[0].id;
            }
            const endpoint = `${prefix}/collections/${encodeURIComponent(collectionId)}/items`;
            stage('collection-metadata');
            const collection = await requestJson('ogc-api', 'collection metadata', `${prefix}/collections/${encodeURIComponent(collectionId)}?f=json`);
            let ogcFields = schemaProperties(collection);
            let native = profile.chooseId(ogcFields);
            if (!native) {
                stage('collection-sample');
                const sampleUrl = addQuery(endpoint, { bbox: bbox.join(','), limit: '1', crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84', f: 'json' });
                const sample = await requestJson('ogc-api', 'collection sample', sampleUrl, 'application/geo+json, application/json');
                const props = sample?.features?.[0]?.properties;
                if (props && typeof props === 'object') {
                    ogcFields = Object.entries(props).map(([name, value]) => ({
                        name, type: Number.isSafeInteger(value) ? 'integer' : typeof value === 'string' ? 'string' : ''
                    }));
                    native = profile.chooseId(ogcFields);
                }
            }
            if (!native) throw sourceFailure(`OGC API collection schema exposes no filterable stable ${profile.noun} key.`, { code: 'missing-stable-id' });
            const { extras, outFields } = withExtras(profile, ogcFields, [native.name]);
            return descriptorBase('ogc-api', {
                endpoint, collection: collectionId, idField: native.name, idType: native.idType,
                parcelNumberField: native.name, outFields, ...extras
            }, city, metricSrid);
        });
        if (result) return result;
        const attempt = attemptByAdapter.get('ogc-api');
        if (isTechnicalAttempt(attempt)) throw discoveryFailure(attempts);
    }

    const socrata = socrataSlug(inputUrl.pathname);
    if (socrata.id) {
        const result = await tryCandidate('socrata', async ({ requestJson, stage }) => {
            const origin = inputUrl.origin;
            const metadataUrl = `${origin}/api/views/${socrata.id}`;
            stage('dataset-metadata');
            const metadata = await requestJson('socrata', 'dataset metadata', metadataUrl);
            const columns = Array.isArray(metadata.columns) ? metadata.columns : [];
            const socrataFields = columns.map(column => ({
                name: column.fieldName, alias: column.name, type: socrataFieldType(column)
            }));
            const nativeColumn = profile.chooseId(socrataFields);
            const geometryField = propertyGeometryField(columns);
            if (!nativeColumn || !geometryField) throw sourceFailure(`Socrata dataset lacks a stable ${profile.noun} key or polygon field.`, { code: 'missing-parcel-schema' });
            const endpoint = `${origin}/resource/${socrata.id}.json`;
            const { extras, outFields } = withExtras(profile, socrataFields, [nativeColumn.name, ':id', ':updated_at']);
            return descriptorBase('socrata', {
                endpoint, idField: nativeColumn.name, idType: 'string', objectIdField: ':id',
                geometryField, versionField: ':updated_at', parcelNumberField: nativeColumn.name,
                outFields, ...extras
            }, city, metricSrid);
        });
        if (result) return result;
        const attempt = attemptByAdapter.get('socrata');
        if (isTechnicalAttempt(attempt)) throw discoveryFailure(attempts);
    }

    const isSnapshotUrl = /\.(?:geojson|json)$/i.test(inputUrl.pathname)
        && !/\/resource\/[^/]+\.json$/i.test(inputUrl.pathname)
        && !/\/api\/views\//i.test(inputUrl.pathname);
    if (isSnapshotUrl) {
        const result = await tryCandidate('geojson-snapshot', async ({ stage }) => {
            stage('full-snapshot');
            if (inputUrl.search) throw sourceFailure('GeoJSON snapshot URLs with query parameters cannot be safely pinned.', { code: 'snapshot-query-unsupported' });
            const response = await trackedFetch(inputUrl.href, { headers: { Accept: 'application/geo+json, application/json' } });
            if (!response?.ok || response.status !== 200) {
                throw providerHttpError(response || 502);
            }
            const declaredLength = Number(response.headers?.get?.('content-length'));
            if (Number.isFinite(declaredLength) && declaredLength > MAX_SNAPSHOT_BYTES) {
                throw sourceFailure('Snapshot exceeds the 8 MiB complete-source discovery limit.', { code: 'snapshot-too-large' });
            }
            const etag = response.headers?.get?.('etag');
            if (typeof etag !== 'string' || !/^"[^"\r\n]+"$/.test(etag)) {
                throw sourceFailure('Snapshot must provide a strong ETag so complete coverage can be pinned.', { code: 'snapshot-etag-required' });
            }
            const collection = await response.json();
            if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features)
                || collection.complete === false || collection.exceededTransferLimit === true) {
                throw sourceFailure('Snapshot is not an explicitly complete FeatureCollection.', { code: 'snapshot-incomplete' });
            }
            const statedCount = collection.totalFeatures ?? collection.numberMatched;
            if (collection.complete !== true && statedCount === undefined) {
                throw sourceFailure('Snapshot must assert completeness or provide an exact feature count.', { code: 'snapshot-completeness-unknown' });
            }
            if (statedCount !== undefined && Number(statedCount) !== collection.features.length) {
                throw sourceFailure('Snapshot feature count does not match its declared total.', { code: 'snapshot-count-mismatch' });
            }
            if (!collection.features.length || collection.features.length > MAX_SNAPSHOT_FEATURES
                || collection.features.length > MAX_FEATURES) {
                throw sourceFailure('Snapshot is empty or exceeds the 5,000-feature limit.', { code: 'snapshot-feature-limit' });
            }
            const extent = collection.bbox;
            if (!isValidExtent(extent) || !covers(extent, bbox)) {
                throw sourceFailure('Snapshot must declare a WGS84 bbox covering the complete probe area.', { code: 'snapshot-extent-unknown' });
            }
            if (collection.crs && !['CRS84', 'OGC:CRS84', 'EPSG:4326', 'urn:ogc:def:crs:OGC::CRS84',
                'urn:ogc:def:crs:OGC:1.3:CRS84', 'urn:ogc:def:crs:EPSG::4326'].includes(collection.crs?.properties?.name)) {
                throw sourceFailure('Snapshot must use WGS84 GeoJSON coordinates.', { code: 'snapshot-crs-unsupported' });
            }
            const fields = Object.keys(collection.features[0]?.properties || {}).map(name => ({ name, type: typeof collection.features[0].properties[name] === 'number' ? 'integer' : 'string' }));
            const native = profile.chooseId(fields);
            if (!native) throw sourceFailure(`Snapshot features expose no recognized stable ${profile.noun} key.`, { code: 'missing-stable-id' });
            for (const feature of collection.features) {
                if (feature?.type !== 'Feature' || !validateGeometry(feature.geometry)) {
                    throw sourceFailure('Snapshot contains a non-polygon or invalid polygon feature.', { code: 'invalid-snapshot-geometry' });
                }
                const featureExtent = geometryBbox(feature);
                if (!covers(extent, featureExtent)) throw sourceFailure('Snapshot feature lies outside its declared WGS84 extent.', { code: 'snapshot-extent-mismatch' });
            }
            const { extras, outFields } = withExtras(profile, fields, [native.name]);
            return descriptorBase('geojson-snapshot', {
                endpoint: inputUrl.href, idFields: [native.name], idType: native.idType,
                parcelNumberField: native.name, outFields, bbox: extent,
                expectedSnapshotFeatures: collection.features.length, expectedEtag: etag, ...extras
            }, city, metricSrid);
        });
        if (result) return result;
        const attempt = attemptByAdapter.get('geojson-snapshot');
        if (isTechnicalAttempt(attempt)) throw discoveryFailure(attempts);
    }

    throw discoveryFailure(attempts);
}
