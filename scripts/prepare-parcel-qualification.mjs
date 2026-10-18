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

        // Qualification tests the descriptor production runs: the catalog wins for every field it
        // defines (a packet holds a snapshot from discovery time, possibly before a catalog fix), and
        // the packet only adds settings the catalog lacks. A packet naming another identity is refused.
        for (const [key, value] of Object.entries(inputDescriptor)) {
            if (!IDENTITY_FIELDS.includes(key) || !Object.hasOwn(catalogSource, key)) continue;
            const same = key === 'endpoint' ? sameUrl(catalogSource[key], value) : JSON.stringify(catalogSource[key]) === JSON.stringify(value);
            if (!same) return needs(`Provider descriptor conflicts with catalog identity field ${key}.`);
        }
        let descriptor = { ...structuredClone(inputDescriptor), ...structuredClone(catalogSource) };
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
        // Binding reads the first sample's footprint, which must fit the source's bounded area
        // (maxBboxKm2): put the smallest sample first.
        const bboxArea = geometry => {
            const points = (geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat()).flat();
            const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
            return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
        };
        sampleIds.sort((a, b) => bboxArea(sampleGeometries.get(a)) - bboxArea(sampleGeometries.get(b)) || a.localeCompare(b));

        const idPrefix = descriptor.idPrefix;
        if (typeof idPrefix !== 'string' || !idPrefix || sampleIds.some(id => !id.startsWith(idPrefix))) return needs('Canonical sample IDs do not use the catalog source prefix.');
        // Ask the production adapter to parse every exact ID, with all fetches replaced by a
        // sentinel that cannot reach the network. Reaching that sentinel proves syntax validation passed.
        const adapter = createParcelSource(descriptor, { fetchImpl: async () => {
            throw Object.assign(new Error('qualification network disabled'), { code: 'qualification-network-disabled' });
        } });
        const acceptsId = async id => {
            try { await adapter.queryIds([id]); return true; } catch (error) { return Number(error?.status ?? error?.httpStatus) !== 400; }
        };
        const generatedAbsentId = await absentId(descriptor, features[0], root, acceptsId);
        const codec = typeof generatedAbsentId === 'string' && generatedAbsentId.startsWith(idPrefix) && !sampleIds.includes(generatedAbsentId)
            ? generatedAbsentId : null;
        const checkedSampleIds = sampleIds.slice(0, MAX_SAMPLES);
        if (!['geojson-snapshot', 'shapefile-snapshot', 'shapefile-zip', 'nairobi-outlines'].includes(descriptor.adapter)) {
            try {
                await adapter.queryIds(checkedSampleIds);
            } catch (error) {
                if (Number(error?.status ?? error?.httpStatus) === 400) {
                    return needs('Production adapter rejected one or more native sample IDs.');
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
        // Jurisdiction-first discovery records the provider's documented scope (a basis sentence
        // backed by evidence files) in the queue, the packet and the catalog entry's own profile.
        const jurisdiction = catalogSource.discovery?.jurisdiction;
        const scopeItems = Array.isArray(packet.providerReuse.scopeEvidence) ? packet.providerReuse.scopeEvidence : [];
        for (const item of [...scopeItems, ...(jurisdiction ? [jurisdiction] : [])]) {
            const text = typeof item === 'string' ? item : item?.basis;
            const country = typeof item === 'string' ? null : item?.countryCode;
            const backed = typeof item === 'string' || (Array.isArray(item?.evidence) && item.evidence.length > 0);
            if (typeof text === 'string' && text.trim() && backed && (!country || country === catalogSource.countryCode)) proofTexts.push(text.trim());
        }
        const evidence = evidenceFromPacket({ ...packet, providerReuse: { ...packet.providerReuse,
            purpose: [...proofTexts, packet.providerReuse.purpose, packet.providerReuse.sourcePurpose].filter(Boolean).join('; ') } }, catalogSource);
        if (!evidence) return needs('Packet lacks first-party source-purpose evidence suitable for parcel classification.');
        const fields = [...(descriptor.outFields || []), descriptor.idField, descriptor.objectIdField].filter(Boolean);
        if (fields.some(field => SENSITIVE.test(String(field)))) return needs('Catalog descriptor requests sensitive fields that require source-specific review.');

        return { status: 'prepared', candidate: {
            descriptor,
            city: { code: cityCode, name: String(frozen.cityName ?? packet.cityName ?? packet.name ?? ''), point },
            sampleIds: checkedSampleIds, ...(codec ? { absentId: codec } : {}), metricEpsg,
            sourceClassification: { isParcel: true, evidence },
            cellSizeDegrees: 0.001
        } };
    } catch (error) {
        return needs(error instanceof Error ? error.message : 'Input could not be prepared safely.');
    }
}

const IDENTITY_FIELDS = ['id', 'adapter', 'idPrefix', 'endpoint'];

// URL hosts are case-insensitive (RFC 3986 §3.2.2): a packet written through a URL parser
// carries the lower-cased host of the same catalog endpoint.
function sameUrl(a, b) {
    try { return new URL(a).href === new URL(b).href; } catch { return false; }
}

// Format-valid stand-ins for one native ID, simplest first: letters to z/Z (or hex letters to f/F),
// digits to 9 with the last digit 8 (all nines is a common placeholder in published registers).
// Later candidates keep more of the native's own leading and trailing characters, so the fixed
// parts of an ID format survive (Baden-Württemberg 08…, Hessen DEHE…FL).
function* absentNativeCandidates(native) {
    const lastDigit = text => text.replace(/9(?=[^0-9]*$)/, '8');
    const letters = char => /\d/.test(char) ? '9' : /[a-z]/.test(char) ? 'z' : /[A-Z]/.test(char) ? 'Z' : char;
    const hexDigits = char => /\d/.test(char) ? '9' : /[a-f]/i.test(char) ? (char === char.toUpperCase() ? 'F' : 'f') : char;
    const seen = new Set([native]);
    // Hex mapping (GUIDs) only after every kept prefix/suffix failed with plain letters.
    for (const map of [letters, hexDigits]) {
        for (let kept = 0; kept <= 8; kept++) {
            for (let keepStart = kept; keepStart >= 0; keepStart--) {
                const keepEnd = kept - keepStart;
                if (keepStart + keepEnd >= native.length) continue;
                const candidate = native.slice(0, keepStart)
                    + lastDigit([...native.slice(keepStart, native.length - keepEnd)].map(map).join('')) + native.slice(native.length - keepEnd);
                if (!seen.has(candidate)) { seen.add(candidate); yield candidate; }
            }
        }
    }
    yield `${native}Z`;
}

// The first candidate that the descriptor's pattern (if any) and the adapter's own syntax check accept;
// some formats live only in the adapter (Hessen's GML profile), so the adapter has the last word.
async function absentNative(native, pattern, acceptsNative = async () => true) {
    let regex = null;
    if (pattern) { try { regex = new RegExp(pattern); } catch { return null; } }
    for (const candidate of absentNativeCandidates(native)) {
        if (regex && !regex.test(candidate)) continue;
        if (await acceptsNative(candidate)) return candidate;
    }
    return null;
}

async function absentId(descriptor, sampleFeature, root, acceptsId = async () => true) {
    if (['geojson-snapshot', 'shapefile-snapshot', 'shapefile-zip'].includes(descriptor.adapter)) {
        const codec = await import(pathToFileURL(path.join(root, 'backend/parcels/geojson-snapshot-source.js')));
        const count = descriptor.idFields?.length;
        if (!Number.isInteger(count) || count < 1) return null;
        const tail = codec.encodeSnapshotNativeId(Array(count).fill('qualification-absent'));
        codec.decodeSnapshotNativeId(tail, count);
        return `${descriptor.idPrefix}${tail}`;
    }
    if (descriptor.identityKind === 'geometry-sha256-v1') {
        const codec = await import(pathToFileURL(path.join(root, 'backend/parcels/geometry-identity.js')));
        try {
            const sampleId = await canonicalId(sampleFeature, descriptor, root);
            const locator = codec.parseGeometryParcelId(descriptor, sampleId);
            const hash = (locator.hash === '0'.repeat(64) ? 'f' : '0').repeat(64);
            const candidate = `${descriptor.idPrefix}g1~${locator.longitude}~${locator.latitude}~${hash}`;
            codec.parseGeometryParcelId(descriptor, candidate);
            return candidate;
        } catch { return null; }
    }
    const sampleNative = rawNativeId(sampleFeature, descriptor);
    if (!sampleNative) return null;
    if (descriptor.adapter === 'pl-uldk-point') {
        // ULDK IDs are TERYT precinct + optional map sheet (AR_n) + parcel number; keep the precinct
        // and sheet, and ask for parcel 999999 there (verified live as explicit absence 2026-10-12).
        const candidate = sampleNative.replace(/\.[0-9]{1,6}(?:\/[0-9]{1,6})?$/, '.999999');
        if (candidate === sampleNative || !new RegExp(descriptor.idPattern).test(candidate)) return null;
        return `${descriptor.idPrefix}${candidate}`;
    }
    const native = sampleNative;
    const pattern = descriptor.idPattern || descriptor.nativeIdPattern;
    let candidate;
    if (descriptor.adapter === 'arcgis' && Array.isArray(descriptor.idFields) && descriptor.idFields.length) {
        // Composite IDs are percent-encoded parts joined by "~": map the decoded parts, never the escapes.
        const { encodeArcgisCompositeId, splitArcgisCompositeId } = await import(pathToFileURL(path.join(root, 'backend/parcels/arcgis-source.js')));
        const parts = splitArcgisCompositeId(native);
        if (parts.length !== descriptor.idFields.length) return null;
        const mapped = await Promise.all(parts.map((part, index) => descriptor.idFieldTypes?.[descriptor.idFields[index]] === 'string'
            ? absentNative(part, pattern) : '9'.repeat(Math.max(part.length - 1, 1)) + (part.length > 1 ? '8' : '')));
        if (mapped.some(part => !part)) return null;
        candidate = encodeArcgisCompositeId(mapped);
    } else if (descriptor.idType === 'integer' || descriptor.idType === 'number' || descriptor.idPattern === 'integer') {
        candidate = /^0\d+$/.test(native) ? `${'9'.repeat(native.length - 1)}8` : '999999998';
    } else {
        candidate = await absentNative(native, pattern, value => acceptsId(`${descriptor.idPrefix}${value}`));
        if (!candidate) return null;
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
