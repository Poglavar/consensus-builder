// A portable source configuration, not a parcel cache. Every read still uses the public-URL guard.
import { createHash } from 'node:crypto';
import { HttpError } from '../utils/helpers.js';
import { validatePublicSourceUrl } from './public-source-fetch.js';

const fields = ['adapter', 'endpoint', 'cityIds', 'metricSrid', 'idField', 'objectIdField', 'idType',
    'typeName', 'featureType', 'version', 'collection', 'geometryField', 'versionField', 'idFields', 'outFields', 'parcelNumberField', 'bbox',
    'boundsQueryMode', 'expectedSnapshotFeatures', 'expectedEtag'];
const adapters = ['arcgis', 'wfs', 'ogc-api', 'socrata', 'geojson-snapshot'];
const invalid = () => Object.assign(new HttpError(400, 'Invalid custom parcel source configuration.'), { code: 'invalid-source-url' });

function canonicalConfig(input) {
    if (!input || !adapters.includes(input.adapter)) throw invalid();
    const config = Object.fromEntries(fields.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
    const url = new URL(validatePublicSourceUrl(config.endpoint));
    if ([...url.searchParams.keys()].some(key => /^(token|access_token|api[_-]?key|key|password|signature)$/i.test(key))) throw invalid();
    config.endpoint = url.href;
    if (!Array.isArray(config.cityIds) || config.cityIds.length !== 1 || !/^[a-z][a-z0-9_]{0,79}$/.test(config.cityIds[0])
        || !Number.isInteger(config.metricSrid) || config.metricSrid < 2000 || config.metricSrid > 99999
        || !Array.isArray(config.outFields) || !config.outFields.length || config.outFields.length > 40
        || config.outFields.some(value => typeof value !== 'string' || !/^:?[A-Za-z_][A-Za-z0-9_:.-]{0,79}$/.test(value))) throw invalid();
    for (const key of ['idField', 'objectIdField', 'parcelNumberField', 'versionField']) {
        if (config[key] !== undefined && !config.outFields.includes(config[key])) throw invalid();
    }
    if (config.geometryField !== undefined && (typeof config.geometryField !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(config.geometryField))) throw invalid();
    if (config.idFields !== undefined && (!Array.isArray(config.idFields) || !config.idFields.length
        || config.idFields.length > 8 || config.idFields.some(key => !config.outFields.includes(key)))) throw invalid();
    for (const key of ['typeName', 'featureType', 'collection']) {
        if (config[key] !== undefined && (typeof config[key] !== 'string' || !/^[A-Za-z0-9_:.-]{1,160}$/.test(config[key]))) throw invalid();
    }
    if (config.idType !== undefined && !['integer', 'string'].includes(config.idType)) throw invalid();
    if (config.version !== undefined && !['1.1.0', '2.0.0'].includes(config.version)) throw invalid();
    if (config.boundsQueryMode !== undefined && !['offset', 'object-ids'].includes(config.boundsQueryMode)) throw invalid();
    if (config.bbox !== undefined && (!Array.isArray(config.bbox) || config.bbox.length !== 4
        || !config.bbox.every(Number.isFinite) || config.bbox[0] < -180 || config.bbox[2] > 180
        || config.bbox[1] < -90 || config.bbox[3] > 90 || config.bbox[0] >= config.bbox[2] || config.bbox[1] >= config.bbox[3])) throw invalid();
    if (config.expectedSnapshotFeatures !== undefined && (!Number.isSafeInteger(config.expectedSnapshotFeatures)
        || config.expectedSnapshotFeatures < 0 || config.expectedSnapshotFeatures > 5000)) throw invalid();
    if (config.expectedEtag !== undefined && (typeof config.expectedEtag !== 'string' || !/^"[^"\r\n]{1,200}"$/.test(config.expectedEtag))) throw invalid();
    if (JSON.stringify(config).length > 2400) throw invalid();
    return config;
}

export function encodeCustomSource(input) {
    const config = canonicalConfig(input);
    const hash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 20);
    return 'custom.' + Buffer.from(JSON.stringify({ ...config, idPrefix: `CUSTOM-${hash}-` })).toString('base64url');
}

export function decodeCustomSource(sourceId) {
    if (typeof sourceId !== 'string' || !/^custom\.[A-Za-z0-9_-]{1,3400}$/.test(sourceId)) throw invalid();
    let config;
    try { config = canonicalConfig(JSON.parse(Buffer.from(sourceId.slice(7), 'base64url').toString('utf8'))); }
    catch (_) { throw invalid(); }
    if (encodeCustomSource(config) !== sourceId) throw invalid();
    const hash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 20);
    return { ...config, id: sourceId, idPrefix: `CUSTOM-${hash}-`, defaultForCity: false,
        name: new URL(config.endpoint).hostname + ' (' + config.adapter + ')',
        pageSize: 250, maxFeatures: 5000, maxBboxKm2: 1, maxSnapshotBytes: 8 * 1024 * 1024,
        maxSnapshotFeatures: 5000 };
}
