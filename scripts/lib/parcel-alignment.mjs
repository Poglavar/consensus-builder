// Collect native-coordinate evidence and run the independent CRS check without fitting offsets.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const COORDINATE_FIELDS = ['id', 'adapter', 'endpoint', 'idPrefix', 'idField', 'idFields', 'objectIdField',
    'featureType', 'version', 'responseSrid', 'responseCoordinatePrecision', 'geometryPrecision',
    'boundsSrid', 'boundsProjection', 'sourceCrs', 'projection', 'queryFormat', 'nativeGeometryMode',
    'partsCoordinatePrecision', 'identityKind', 'attributeFilters', 'attributeExclusions', 'attributeNotNull',
    'attributeNull', 'attributeDateEquals', 'overlapResolution'];
const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
export function alignmentContractHash(descriptor) {
    return hash(JSON.stringify(sort(Object.fromEntries(COORDINATE_FIELDS.filter(key => descriptor[key] !== undefined)
        .map(key => [key, descriptor[key]])))));
}

// The observer retains only geometry and configured source keys; it never retains other properties.
export function createArcgisAlignmentObserver(descriptor, reads) {
    return async ({ url, init, response }) => {
        if (!response.ok || !url.pathname.endsWith('/query')) return;
        const params = new URLSearchParams(url.search);
        if (typeof init.body === 'string') for (const [key, value] of new URLSearchParams(init.body)) params.set(key, value);
        if (params.get('returnGeometry') !== 'true') return;
        const data = await response.json();
        if (!Array.isArray(data.features) || data.features.length > 100) return;
        const fields = [...new Set([descriptor.objectIdField, descriptor.idField, ...(descriptor.idFields || [])].filter(Boolean))];
        reads.push({ params, features: data.features.map(feature => ({ geometry: feature.geometry,
            properties: Object.fromEntries(fields.map(key => [key, (feature.properties || feature.attributes || {})[key]])) })) });
    };
}

async function writeJson(directory, name, value) {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    await fs.writeFile(path.join(directory, name), bytes);
    return hash(bytes);
}
function error(reason) { throw Object.assign(new Error(reason), { code: 'parcel-alignment-unverified' }); }

export async function importAlignmentEvidence({ reference, candidateDir, outputDir }) {
    if (!reference || typeof reference.file !== 'string' || path.isAbsolute(reference.file)
        || !/^[0-9a-f]{64}$/.test(reference.sha256 || '')) error('Alignment evidence must be a relative, hash-bound input.');
    const within = (directory, relative) => {
        if (typeof relative !== 'string' || path.isAbsolute(relative)) error('Alignment evidence input must be relative.');
        const result = path.resolve(directory, relative);
        if (!result.startsWith(`${path.resolve(directory)}${path.sep}`)) error('Alignment evidence input escapes its directory.');
        return result;
    };
    const evidencePath = within(candidateDir, reference.file);
    const bytes = await fs.readFile(evidencePath);
    if (hash(bytes) !== reference.sha256) error('Alignment evidence input SHA-256 mismatch.');
    const evidence = JSON.parse(bytes);
    const root = path.dirname(evidencePath);
    for (const [fileKey, hashKey, target] of [['metadataFile', 'metadataSha256', 'alignment-metadata.json'],
        ['nativeFile', 'nativeSha256', 'alignment-native.json']]) {
        const data = await fs.readFile(within(root, evidence[fileKey]));
        if (hash(data) !== evidence[hashKey]) error('Alignment input file SHA-256 mismatch.');
        if (fileKey === 'nativeFile') {
            const native = JSON.parse(data);
            for (const feature of native.features || []) {
                if (Object.keys(feature).some(key => !['id', 'geometry', 'type', 'properties'].includes(key))
                    || Object.keys(feature.properties || {}).some(key => !['parcelId', 'sourceId', 'sourceParcelId'].includes(key))) {
                    error('Alignment native sample must retain only canonical IDs and geometry.');
                }
            }
        }
        await fs.writeFile(path.join(outputDir, target), data);
        evidence[fileKey] = target;
    }
    await writeJson(outputDir, 'alignment-evidence.json', evidence);
    return path.join(outputDir, 'alignment-evidence.json');
}

export async function collectArcgisAlignment({ descriptor, cityCode, exactFeatures, reads, outputDir, fetchImpl }) {
    const metadataUrl = new URL(descriptor.endpoint);
    metadataUrl.search = '?f=json';
    const response = await fetchImpl(metadataUrl.href, { headers: { Accept: 'application/json' } });
    if (!response.ok) error('First-party CRS metadata is unavailable.');
    const raw = await response.json();
    if (raw.error) error('First-party CRS metadata is unavailable.');
    const reference = raw.sourceSpatialReference || raw.spatialReference || raw.extent?.spatialReference;
    const srid = reference?.latestWkid ?? reference?.wkid;
    // ArcGIS-only WKIDs require an authoritative mapping; never guess an EPSG equivalent.
    if (!Number.isSafeInteger(srid) || srid <= 0) error('Layer metadata has no usable declared native CRS.');
    const metadata = { ...(raw.sourceSpatialReference ? { sourceSpatialReference: raw.sourceSpatialReference } : {}),
        ...(raw.extent?.spatialReference ? { extent: { spatialReference: raw.extent.spatialReference } } : {}),
        ...(raw.spatialReference ? { spatialReference: raw.spatialReference } : {}) };
    const selected = new Map();
    const wanted = [...exactFeatures.values()].slice(0, 3);
    if (!wanted.length) error('Alignment requires a successfully read parcel sample.');
    for (const read of reads) for (const feature of read.features) {
        const objectId = feature.properties[descriptor.objectIdField];
        if (!Number.isSafeInteger(objectId) || objectId < 0) continue;
        let match;
        if (descriptor.idField) match = wanted.find(item => item.properties.sourceParcelId === String(feature.properties[descriptor.idField]));
        else if (descriptor.identityKind === 'geometry-sha256-v1') {
            const geometryHash = hash(JSON.stringify(feature.geometry));
            match = wanted.find(item => item.properties.sourceParcelId === geometryHash);
        }
        // Composite/multipart/derived ground needs a source-specific unchanged-native proof.
        if (match && !selected.has(match.id)) selected.set(match.id, { id: match.id, objectId, params: read.params });
    }
    if (selected.size !== wanted.length) error('Native sample mapping needs a source-specific identity/geometry proof.');
    const samples = [];
    // Preserve the production predicate and status filters from each observed read. Change only
    // the output CRS and transport, and use one known source object per bounded native request.
    for (const item of selected.values()) {
        const params = new URLSearchParams(item.params);
        params.set('objectIds', String(item.objectId));
        params.set('outSR', String(srid)); params.set('f', 'json'); params.set('returnGeometry', 'true');
        params.set('outFields', descriptor.objectIdField); params.set('returnTrueCurves', 'true');
        for (const key of ['resultOffset', 'resultRecordCount', 'orderByFields', 'geometryPrecision']) params.delete(key);
        const url = new URL(`${descriptor.endpoint}/query`); url.search = params.toString();
        const nativeResponse = await fetchImpl(url.href, { headers: { Accept: 'application/json' } });
        if (!nativeResponse.ok) error('Declared-native parcel query is unavailable.');
        const native = await nativeResponse.json();
        const gotSrid = native.spatialReference?.latestWkid ?? native.spatialReference?.wkid;
        if (native.error || gotSrid !== srid || native.exceededTransferLimit === true || native.features?.length !== 1) {
            error('Native parcel query omitted or changed its CRS, object identity or completeness.');
        }
        const feature = native.features[0];
        if (feature.attributes?.[descriptor.objectIdField] !== item.objectId || !Array.isArray(feature.geometry?.rings)
            || feature.geometry.curveRings || feature.geometry.paths) error('Native parcel query has no unchanged linear polygon.');
        samples.push({ id: item.id, geometry: { rings: feature.geometry.rings } });
    }
    const metadataSha256 = await writeJson(outputDir, 'alignment-metadata.json', metadata);
    const nativeSha256 = await writeJson(outputDir, 'alignment-native.json', { type: 'NativeParcelSamples', features: samples });
    const evidence = { schemaVersion: 1, sourceId: descriptor.id, cityCode: String(cityCode),
        contractSha256: alignmentContractHash(descriptor), nativeCrs: `EPSG:${srid}`, nativeAxisOrder: 'east-north',
        metadataUrl: metadataUrl.href, metadataFile: 'alignment-metadata.json', metadataSha256,
        nativeFile: 'alignment-native.json', nativeSha256 };
    await writeJson(outputDir, 'alignment-evidence.json', evidence);
    return path.join(outputDir, 'alignment-evidence.json');
}

export async function checkParcelAlignment({ descriptor, cityCode, evidencePath, cachePath, outputDir, scriptPath }) {
    if (!evidencePath) return { passed: false, reason: 'Declared native CRS, wire axis order and unchanged native sample evidence are required.',
        sourceGeoreferencing: 'unverified', fittedOffsetApplied: false };
    const reportPath = path.join(outputDir, 'alignment-report.json');
    const run = spawnSync('python3', [scriptPath, evidencePath, cachePath, reportPath, '--source-id', descriptor.id,
        '--city-code', String(cityCode), '--contract-sha256', alignmentContractHash(descriptor)],
    { encoding: 'utf8', timeout: 90_000, maxBuffer: 256 * 1024 });
    if (run.error || ![0, 2].includes(run.status)) error('Independent CRS check could not run.');
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    if (report.passed === true && (report.sourceId !== descriptor.id || report.cityCode !== String(cityCode)
        || report.contractSha256 !== alignmentContractHash(descriptor)
        || report.cacheSha256 !== hash(await fs.readFile(cachePath)) || report.sourceGeometryChanged !== false
        || report.fittedOffsetApplied !== false || report.bestOperationAvailable !== true || report.ballparkAllowed !== false)) {
        error('Independent CRS report does not bind to the actual source/output or uses an inferred transform.');
    }
    return { ...report, reportFile: 'alignment-report.json' };
}
