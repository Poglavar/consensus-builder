#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_SAMPLES = 5;
const SENSITIVE = /owner|address|titular|titleholder|person|email|phone|taxpayer|account/i;

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function utmEpsg([lon, lat]) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -80 || lat > 84) return null;
    const zone = Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
    return `EPSG:${(lat >= 0 ? 32600 : 32700) + zone}`;
}

function localPath(sourceRoot, entry) {
    const rel = typeof entry === 'string' ? entry : entry?.repoRelativePath ?? entry?.path;
    if (typeof rel !== 'string' || path.isAbsolute(rel)) throw new Error('sample path is not repository relative');
    const root = path.resolve(sourceRoot);
    const file = path.resolve(root, rel);
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) throw new Error('sample path escapes source root');
    return file;
}

function rawNativeId(feature, descriptor) {
    const props = feature?.properties || {};
    if (typeof props.sourceParcelId === 'string' && props.sourceParcelId) return props.sourceParcelId;
    if (typeof props.parcelId === 'string' && descriptor.idPrefix && props.parcelId.startsWith(descriptor.idPrefix)) return props.parcelId.slice(descriptor.idPrefix.length);
    if (typeof props[descriptor.idField] === 'string' || typeof props[descriptor.idField] === 'number') return String(props[descriptor.idField]);
    if (typeof props.id === 'string' || typeof props.id === 'number') return String(props.id);
    if (typeof feature?.id === 'string' && descriptor.idPrefix && feature.id.startsWith(descriptor.idPrefix)) return feature.id.slice(descriptor.idPrefix.length);
    return null;
}

async function canonicalId(feature, descriptor, root) {
    if (['geojson-snapshot', 'shapefile-snapshot', 'shapefile-zip'].includes(descriptor.adapter)) {
        const { encodeSnapshotNativeId } = await import(pathToFileURL(path.join(root, 'backend/parcels/geojson-snapshot-source.js')));
        const props = feature?.properties || {};
        const fields = descriptor.idFields || [];
        if (fields.length && fields.every(field => props[field] !== undefined && props[field] !== null && props[field] !== '')) {
            return `${descriptor.idPrefix}${encodeSnapshotNativeId(fields.map(field => props[field]))}`;
        }
        // Provider sample files often store the already-combined native key in `id`.
        const native = rawNativeId(feature, descriptor);
        return native && `${descriptor.idPrefix}${native}`;
    }
    const native = rawNativeId(feature, descriptor);
    if (typeof feature?.properties?.parcelId === 'string' && feature.properties.parcelId.startsWith(descriptor.idPrefix)) return feature.properties.parcelId;
    return native ? `${descriptor.idPrefix}${native}` : null;
}

function evidenceFromPacket(city, catalogSource) {
    const reuse = city?.providerReuse || {};
    const proof = [reuse.purpose, reuse.sourcePurpose, reuse.scopeEvidence?.purpose,
        reuse.scopeEvidence?.sourcePurpose, reuse.scopeEvidence?.geographicScope]
        .filter(value => typeof value === 'string' && value.trim());
    const catalogPurpose = [catalogSource?.name, catalogSource?.description]
        .filter(value => typeof value === 'string' && value.trim());
    if (!proof.length || !catalogPurpose.length) return null;
    return [...new Set([...catalogPurpose, ...proof])];
}

export async function prepareCandidate(city, { repoRoot, sourceRoot } = {}) {
    const needs = reason => ({ status: 'needs-llm', reason });
    try {
        if (!isRecord(city)) return needs('Frozen city record is invalid.');
        const root = path.resolve(repoRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
        if (!sourceRoot) return needs('Source repository root is missing.');
        const frozen = city;
        const packetPath = frozen.packetRepoRelativePath ?? frozen.cityPacketRepoRelativePath;
        const packet = packetPath ? await readJson(localPath(sourceRoot, packetPath)) : frozen;
        if (packetPath && (String(packet.cityCode ?? packet.wupCityCode ?? '') !== String(frozen.cityCode)
            || JSON.stringify(packet.point) !== JSON.stringify(frozen.point)
            || String(packet.cityName ?? packet.name ?? '') !== String(frozen.cityName ?? ''))) {
            return needs('Provider packet does not match frozen queue city identity or point.');
        }
        packet.sampleFiles = frozen.sampleFiles ?? packet.sampleFiles;
        if (!isRecord(packet.providerReuse)) return needs('No trusted provider reuse descriptor is present.');
        const inputDescriptor = packet.providerReuse.descriptor;
        if (!isRecord(inputDescriptor) || typeof inputDescriptor.id !== 'string' || !inputDescriptor.id) return needs('Provider packet has no reusable source descriptor.');
        const inputFields = [...(Array.isArray(inputDescriptor.outFields) ? inputDescriptor.outFields : []), inputDescriptor.idField, inputDescriptor.objectIdField].filter(Boolean);
        if (inputFields.some(field => SENSITIVE.test(String(field)))) return needs('Provider descriptor requests sensitive fields that require source-specific review.');

        const { parcelSourceCatalog, createParcelSource } = await import(pathToFileURL(path.join(root, 'backend/parcels/sources.js')));
        const catalogSource = parcelSourceCatalog.sources.find(source => source.id === inputDescriptor.id);
        if (!catalogSource) return needs('Provider descriptor does not resolve to an existing production catalog source.');

        let descriptor = { ...structuredClone(catalogSource), ...structuredClone(inputDescriptor) };
        // Catalog identity remains authoritative; reuse packet adapter settings after safety checks.
        for (const [key, value] of Object.entries(inputDescriptor)) {
            if (['id', 'adapter', 'idPrefix', 'endpoint'].includes(key)
                && Object.hasOwn(catalogSource, key) && JSON.stringify(catalogSource[key]) !== JSON.stringify(value)) return needs(`Provider descriptor conflicts with catalog identity field ${key}.`);
        }
        if (descriptor.adapter === 'wfs' && !descriptor.geometryField && descriptor.id === 'fr-ign-parcellaire-express') {
            // The shared production WFS descriptor deliberately leaves propertyName unspecified.
            // Keep only the canonical native key in the candidate and drop the catalogue label field.
            descriptor.outFields = descriptor.nativeIdMode === 'feature-id' ? [] : [descriptor.idField];
            delete descriptor.parcelNumberField;
            delete descriptor.requestProperties;
        } else {
            const { safeDescriptor } = await import(pathToFileURL(path.join(root, 'scripts/probe-parcel-provider.mjs')));
            descriptor = safeDescriptor(descriptor);
        }
        if (!Array.isArray(descriptor.cityIds)) return needs('Catalog descriptor has no city scope list.');
        const cityCode = String(frozen.cityCode ?? packet.cityCode ?? packet.wupCityCode ?? '');
        if (!cityCode) return needs('Frozen city code is missing.');
        if (!descriptor.cityIds.includes(cityCode)) descriptor.cityIds = [...descriptor.cityIds, cityCode];

        const pointLatLon = frozen.point ?? packet.point;
        if (!Array.isArray(pointLatLon) || pointLatLon.length !== 2 || !pointLatLon.every(Number.isFinite)) return needs('Frozen UN point is invalid.');
        const point = [pointLatLon[1], pointLatLon[0]];
        const metricEpsg = utmEpsg(point);
        if (!metricEpsg || !/^EPSG:32[67]\d\d$/.test(metricEpsg)) return needs('Frozen UN point is outside supported UTM latitude bounds.');
        if (descriptor.metricSridByCity) {
            descriptor.metricSridByCity = { ...descriptor.metricSridByCity, [cityCode]: Number(metricEpsg.slice(5)) };
        }

        const refs = frozen.sampleFiles ?? packet.sampleFiles;
        if (!Array.isArray(refs) || !refs.length || !sourceRoot) return needs('Provider packet has no readable sample geometry files.');
        const features = [];
        for (const ref of refs) {
            const file = localPath(sourceRoot, ref);
            if (ref && typeof ref === 'object' && ref.sha256) {
                const digest = createHash('sha256').update(await fs.readFile(file)).digest('hex');
                if (digest !== ref.sha256) return needs('Sample file hash differs from frozen queue evidence.');
            }
            const data = await readJson(file);
            if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) return needs('Sample file is not a GeoJSON FeatureCollection.');
            features.push(...data.features);
        }
        const sampleIds = [];
        const sampleGeometries = new Map();
        for (const feature of features) {
            if (!['Polygon', 'MultiPolygon'].includes(feature?.geometry?.type)) return needs('A sample has no native polygon geometry.');
            const id = await canonicalId(feature, descriptor, root);
            if (!id) return needs('A sample lacks its provider-native parcel identity.');
            const previousGeometry = sampleGeometries.get(id);
            if (previousGeometry && JSON.stringify(previousGeometry) !== JSON.stringify(feature.geometry)) return needs(`Sample files contain conflicting geometry for ${id}.`);
            if (!previousGeometry) sampleGeometries.set(id, feature.geometry);
            if (!sampleIds.includes(id)) sampleIds.push(id);
        }
        if (!sampleIds.length) return needs('No native parcel sample IDs were found.');

        const idPrefix = descriptor.idPrefix;
        if (typeof idPrefix !== 'string' || !idPrefix || sampleIds.some(id => !id.startsWith(idPrefix))) return needs('Canonical sample IDs do not use the catalog source prefix.');
        const codec = await absentId(descriptor, features[0], root);
        if (typeof codec !== 'string' || !codec.startsWith(idPrefix) || sampleIds.includes(codec)) return needs('No existing identity codec can safely produce a format-valid absent ID for this adapter.');
        const checkedSampleIds = sampleIds.slice(0, MAX_SAMPLES);

        // Ask the production adapter to parse every exact ID, with all fetches replaced by a
        // sentinel that cannot reach the network. Reaching that sentinel proves syntax validation passed.
        const adapter = createParcelSource(descriptor, { fetchImpl: async () => {
            throw Object.assign(new Error('qualification network disabled'), { code: 'qualification-network-disabled' });
        } });
        if (!['geojson-snapshot', 'shapefile-snapshot', 'shapefile-zip', 'nairobi-outlines'].includes(descriptor.adapter)) {
            try {
                await adapter.queryIds([...checkedSampleIds, codec]);
            } catch (error) {
                if (Number(error?.status ?? error?.httpStatus) === 400) {
                    return needs('Production adapter rejected the native sample or absent-ID encoding.');
                }
            }
        }

        const proofTexts = [];
        for (const ref of packet.providerReuse.sourceEvidenceFiles || []) {
            const file = localPath(sourceRoot, ref);
            if (ref.sha256) {
                const digest = createHash('sha256').update(await fs.readFile(file)).digest('hex');
                if (digest !== ref.sha256) return needs('Provider proof hash differs from packet evidence.');
            }
            const proof = await readJson(file);
            for (const value of [proof.purpose, proof.scope, proof.description]) {
                if (typeof value === 'string' && value.trim()) proofTexts.push(value.trim());
            }
            for (const source of proof.sources || []) {
                if (source.id === descriptor.id) {
                    for (const value of [source.name, source.description, source.scope]) if (typeof value === 'string' && value.trim()) proofTexts.push(value.trim());
                }
            }
        }
        const evidence = evidenceFromPacket({ ...packet, providerReuse: { ...packet.providerReuse,
            purpose: [...proofTexts, packet.providerReuse.purpose, packet.providerReuse.sourcePurpose].filter(Boolean).join('; ') } }, catalogSource);
        if (!evidence) return needs('Packet lacks first-party source-purpose evidence suitable for parcel classification.');
        const fields = [...(descriptor.outFields || []), descriptor.idField, descriptor.objectIdField].filter(Boolean);
        if (fields.some(field => SENSITIVE.test(String(field)))) return needs('Catalog descriptor requests sensitive fields that require source-specific review.');

        return { status: 'prepared', candidate: {
            descriptor,
            city: { code: cityCode, name: String(frozen.cityName ?? packet.cityName ?? packet.name ?? ''), point },
            sampleIds: checkedSampleIds, absentId: codec, metricEpsg,
            sourceClassification: { isParcel: true, evidence },
            cellSizeDegrees: 0.001
        } };
    } catch (error) {
        return needs(error instanceof Error ? error.message : 'Input could not be prepared safely.');
    }
}

async function absentId(descriptor, sampleFeature, root) {
    if (['geojson-snapshot', 'shapefile-snapshot', 'shapefile-zip'].includes(descriptor.adapter)) {
        const codec = await import(pathToFileURL(path.join(root, 'backend/parcels/geojson-snapshot-source.js')));
        const count = descriptor.idFields?.length;
        if (!Number.isInteger(count) || count < 1) return null;
        const tail = codec.encodeSnapshotNativeId(Array(count).fill('qualification-absent'));
        codec.decodeSnapshotNativeId(tail, count);
        return `${descriptor.idPrefix}${tail}`;
    }
    if (descriptor.adapter === 'nairobi-outlines') {
        const codec = await import(pathToFileURL(path.join(root, 'backend/parcels/geometry-identity.js')));
        const coordinate = sampleFeature?.geometry?.coordinates?.[0]?.[0]?.[0];
        if (!Array.isArray(coordinate) || coordinate.length < 2) return null;
        const candidate = `${descriptor.idPrefix}g1~${Math.round(coordinate[0] * 1e7)}~${Math.round(coordinate[1] * 1e7)}~${'0'.repeat(64)}`;
        try { codec.parseGeometryParcelId(descriptor, candidate); return candidate; } catch { return null; }
    }
    const sampleNative = rawNativeId(sampleFeature, descriptor);
    if (!sampleNative) return null;
    const native = sampleNative;
    let candidate;
    if (descriptor.idType === 'integer' || descriptor.idType === 'number' || descriptor.idPattern === 'integer') {
        candidate = /^0\d+$/.test(native) ? '9'.repeat(native.length) : '999999999';
    } else {
        candidate = [...native].map(char => /\d/.test(char) ? '9' : /[a-z]/.test(char) ? 'z' : /[A-Z]/.test(char) ? 'Z' : char).join('');
        if (candidate === native) candidate = `${native}Z`;
        const pattern = descriptor.idPattern || descriptor.nativeIdPattern;
        if (pattern) {
            try {
                const regex = new RegExp(pattern);
                if (!regex.test(candidate)) {
                    const hex = [...native].map(char => /\d/.test(char) ? '9' : /[a-f]/i.test(char) ? (char === char.toUpperCase() ? 'F' : 'f') : char).join('');
                    if (!regex.test(hex)) return null;
                    candidate = hex;
                }
            } catch { return null; }
        }
    }
    const id = `${descriptor.idPrefix}${candidate}`;
    return id === `${descriptor.idPrefix}${native}` ? null : id;
}

function parseArgs(argv) {
    const values = {};
    for (let index = 0; index < argv.length; index++) {
        const flag = argv[index];
        if (!['--request', '--output'].includes(flag) || !argv[index + 1] || argv[index + 1].startsWith('--') || values[flag]) throw new Error('Usage: prepare-parcel-qualification.mjs --request <worker-request.json> --output <candidate.json>');
        values[flag] = argv[++index];
    }
    if (!values['--request'] || !values['--output']) throw new Error('Usage: prepare-parcel-qualification.mjs --request <worker-request.json> --output <candidate.json>');
    return { request: path.resolve(values['--request']), output: path.resolve(values['--output']) };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const request = await readJson(args.request);
    const result = await prepareCandidate(request.city, { repoRoot: request.repoRoot, sourceRoot: request.sourceRoot });
    await fs.mkdir(path.dirname(args.output), { recursive: true });
    if (result.status === 'prepared') await fs.writeFile(args.output, `${JSON.stringify(result.candidate, null, 2)}\n`);
    await fs.writeFile(path.join(path.dirname(args.output), 'preparation.json'), `${JSON.stringify(result.status === 'prepared' ? { status: result.status } : result, null, 2)}\n`);
    process.exitCode = result.status === 'prepared' ? 0 : 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { console.error(error.message); process.exitCode = 2; });
}
