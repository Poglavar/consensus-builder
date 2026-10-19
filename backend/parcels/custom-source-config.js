// A portable source configuration, not a parcel cache. Every read still uses the public-URL guard.
// Two kinds share one codec: parcel sources (`custom.<base64url>`) and building sources
// (`building.<base64url>`, kind 'building', with the fields that carry a height and a storey count).
// The prefixes keep them apart, so a building id can never be fed to the parcel gateway or back.
import { createHash } from 'node:crypto';
import { HttpError } from '../utils/helpers.js';
import { validatePublicSourceUrl } from './public-source-fetch.js';

const fields = ['adapter', 'endpoint', 'cityIds', 'metricSrid', 'idField', 'objectIdField', 'idType',
    'typeName', 'featureType', 'version', 'collection', 'geometryField', 'versionField', 'idFields', 'outFields', 'parcelNumberField', 'bbox',
    'boundsQueryMode', 'expectedSnapshotFeatures', 'expectedEtag', 'kind', 'heightField', 'levelsField', 'heightUnit'];
// 'overpass' is an OpenStreetMap mirror (an Overpass API endpoint), for building sources only.
const adapters = ['arcgis', 'wfs', 'ogc-api', 'socrata', 'geojson-snapshot', 'overpass'];
const invalid = () => Object.assign(new HttpError(400, 'Invalid custom parcel source configuration.'), { code: 'invalid-source-url' });

function canonicalConfig(input) {
    if (!input || !adapters.includes(input.adapter)) throw invalid();
    const config = Object.fromEntries(fields.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
    const url = new URL(validatePublicSourceUrl(config.endpoint));
    if ([...url.searchParams.keys()].some(key => /^(token|access_token|api[_-]?key|key|password|signature)$/i.test(key))) throw invalid();
    config.endpoint = url.href;
    if (config.adapter === 'overpass') {
        // An OpenStreetMap mirror: the endpoint and the city are its whole configuration.
        if (config.kind !== 'building' || Object.keys(config).some(key => !['adapter', 'endpoint', 'cityIds', 'kind'].includes(key))
            || !Array.isArray(config.cityIds) || config.cityIds.length !== 1 || !/^[a-z][a-z0-9_]{0,79}$/.test(config.cityIds[0])) throw invalid();
        return config;
    }
    if (!Array.isArray(config.cityIds) || config.cityIds.length !== 1 || !/^[a-z][a-z0-9_]{0,79}$/.test(config.cityIds[0])
        || !Number.isInteger(config.metricSrid) || config.metricSrid < 2000 || config.metricSrid > 99999
        || !Array.isArray(config.outFields) || !config.outFields.length || config.outFields.length > 40
        || config.outFields.some(value => typeof value !== 'string' || !/^:?[A-Za-z_][A-Za-z0-9_:.-]{0,79}$/.test(value))) throw invalid();
    if (config.kind !== undefined && config.kind !== 'building') throw invalid();
    if (config.heightUnit !== undefined && !['m', 'ft'].includes(config.heightUnit)) throw invalid();
    if (config.kind !== 'building' && (config.heightField !== undefined || config.levelsField !== undefined || config.heightUnit !== undefined)) throw invalid();
    for (const key of ['idField', 'objectIdField', 'parcelNumberField', 'versionField', 'heightField', 'levelsField']) {
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

const KINDS = {
    parcel: { prefix: 'custom.', idPrefix: hash => `CUSTOM-${hash}-` },
    building: { prefix: 'building.', idPrefix: hash => `CUSTOM-B-${hash}-` }
};
const kindOf = config => (config.kind === 'building' ? 'building' : 'parcel');

export function encodeCustomSource(input) {
    const config = canonicalConfig(input);
    const kind = KINDS[kindOf(config)];
    const hash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 20);
    return kind.prefix + Buffer.from(JSON.stringify({ ...config, idPrefix: kind.idPrefix(hash) })).toString('base64url');
}

function decodeKind(sourceId, kindName) {
    const kind = KINDS[kindName];
    if (typeof sourceId !== 'string' || !sourceId.startsWith(kind.prefix)
        || !/^[A-Za-z0-9_-]{1,3400}$/.test(sourceId.slice(kind.prefix.length))) throw invalid();
    let config;
    try { config = canonicalConfig(JSON.parse(Buffer.from(sourceId.slice(kind.prefix.length), 'base64url').toString('utf8'))); }
    catch (_) { throw invalid(); }
    if (kindOf(config) !== kindName || encodeCustomSource(config) !== sourceId) throw invalid();
    const hash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 20);
    return { config, idPrefix: kind.idPrefix(hash) };
}

// A building source: the same transports and limits as a parcel source, read by the building provider.
export function decodeCustomBuildingSource(sourceId) {
    const { config, idPrefix } = decodeKind(sourceId, 'building');
    return { ...config, id: sourceId, idPrefix, defaultForCity: false,
        name: new URL(config.endpoint).hostname + ' (' + config.adapter + ')',
        pageSize: 250, maxFeatures: 5000, maxBboxKm2: 1, maxSnapshotBytes: 8 * 1024 * 1024,
        maxSnapshotFeatures: 5000 };
}

export function decodeCustomSource(sourceId) {
    const { config, idPrefix } = decodeKind(sourceId, 'parcel');
    return { ...config, id: sourceId, idPrefix, defaultForCity: false,
        name: new URL(config.endpoint).hostname + ' (' + config.adapter + ')',
        pageSize: 250, maxFeatures: 5000, maxBboxKm2: 1, maxSnapshotBytes: 8 * 1024 * 1024,
        maxSnapshotFeatures: 5000 };
}
