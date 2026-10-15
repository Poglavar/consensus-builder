#!/usr/bin/env node
// Bounded, resumable CRS/adapter audit. It records provider CRS metadata and a small,
// owner-free geometry sample; it never fits or applies a surveying/imagery translation.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SaxesParser } from '../backend/node_modules/saxes/saxes.js';
import { createParcelAttributeFilter } from '../backend/parcels/source-contract.js';
import { parseCityConfigs } from './build-world-coverage.mjs';
import { createParcelSource } from '../backend/parcels/sources.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CATALOG = path.join(ROOT, 'backend/parcels/source-catalog.json');
const CITY_CONFIG = path.join(ROOT, 'frontend/js/city-config.js');
const FORMAT = 'parcel-alignment-audit-v1';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUESTS = 3_000;
const MAX_BINDING_REQUESTS = 4;
const MAX_OBSERVATION_BYTES = 1_500_000;
const MAX_OBSERVATION_VERTICES = 1_500;
const SNAPSHOT_ADAPTERS = new Set(['geojson-snapshot', 'gml-snapshot', 'hmlr-browser']);
const WFS_ADAPTERS = new Set(['wfs', 'dgu-wfs', 'gml-wfs', 'catastro-wfs', 'hamburg-alkis-wfs', 'frankfurt-wfs']);
const POINT_ADAPTERS = new Set(['msda-point', 'tkgm-point', 'pl-uldk-point']);
const SENSITIVE = /owner|propriet|address|holder|title.?name|person|company|organization|organisation/i;

export function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
export function descriptorHash(descriptor) {
    return createHash('sha256').update(stable(descriptor)).digest('hex');
}
export function sourceCrsSummary(descriptor) {
    const fields = ['sourceCrs', 'nativeCrs', 'responseCrs', 'responseSrid', 'projection', 'boundsSrid', 'boundsProjection', 'metricSrid', 'metricSridByCity'];
    return Object.fromEntries(fields.filter(key => descriptor[key] !== undefined).map(key => [key, descriptor[key]]));
}
export function adapterCrsContract(descriptor) {
    const { adapter } = descriptor;
    if (adapter === 'arcgis' || adapter === 'dda-public-plots' || adapter === 'shenzhen-land-certain' || adapter === 'pulse-public') {
        return { requestedOutput: `EPSG:${descriptor.responseSrid ?? 4326}`,
            queryBounds: descriptor.boundsSrid ? `EPSG:${descriptor.boundsSrid}` : 'EPSG:4326',
            boundsProjection: descriptor.boundsProjection || null,
            conversion: descriptor.responseSrid === 3857 ? 'Web Mercator to WGS84 via proj4 in adapter' : 'request WGS84; adapter passes provider x/y through' };
    }
    if (adapter === 'wfs' || adapter === 'dgu-wfs') {
        return { requestedOutput: descriptor.responseSrid === 3857 ? 'EPSG:3857' : 'CRS:84', queryBounds: 'CRS:84 longitude/latitude', conversion: descriptor.responseSrid === 3857 ? 'EPSG:3857 to WGS84 via proj4 in adapter' : 'CRS:84 pass-through' };
    }
    if (adapter === 'gml-wfs') return { requestedOutput: descriptor.responseCrs, schemaCrs: descriptor.responseCrs, conversion: 'profile-specific GML parser transforms declared axis order to WGS84' };
    if (adapter === 'catastro-wfs') return { requestedOutput: 'EPSG:25830 or EPSG:25831 (per bbox longitude)', queryBounds: 'WGS84 corners projected into selected UTM zone', conversion: 'INSPIRE GML axis/profile parser to WGS84' };
    if (adapter === 'hamburg-alkis-wfs') return { requestedOutput: 'CRS:84', queryBounds: 'CRS:84', conversion: 'provider GeoJSON passed through as WGS84' };
    if (adapter === 'frankfurt-wfs') return { requestedOutput: 'EPSG:25832', queryBounds: 'WGS84 bounds projected to EPSG:25832', conversion: 'ETRS89 / UTM32 to WGS84 using adapter PROJ definition' };
    if (adapter === 'bev-tiles' || adapter === 'vector-tiles') return { sourceCrs: 'Web Mercator XYZ tile matrix', requestedOutput: 'WGS84 longitude/latitude', conversion: 'inverse Web Mercator tile math in adapter' };
    if (adapter === 'kerala-entebhoomi') return { sourceCrs: 'EPSG:32643', requestedOutput: 'WGS84 longitude/latitude', conversion: 'EPSG:32643 to WGS84 via proj4 in adapter' };
    if (adapter === 'kazakhstan-pkk') return { sourceCrs: descriptor.projection, requestedOutput: 'WGS84 longitude/latitude', conversion: 'catalogue native CRS to WGS84 via proj4 in adapter' };
    if (adapter === 'msda-point') return { requestedOutput: 'EPSG:4326 per saved Tbilisi evidence', conversion: 'provider WKT coordinates passed through' };
    if (adapter === 'tkgm-point' || adapter === 'pl-uldk-point') return { requestedOutput: 'WGS84 longitude/latitude', conversion: 'provider response CRS validated by adapter' };
    if (adapter === 'geojson-snapshot') return { requestedOutput: 'WGS84 GeoJSON coordinates', conversion: 'snapshot CRS validated; coordinates passed through' };
    if (adapter === 'gml-snapshot') return { sourceCrs: 'manifest/GML declared CRS', requestedOutput: 'WGS84 longitude/latitude', conversion: 'GML reader transforms the declared profile CRS' };
    if (adapter === 'socrata') return { requestedOutput: 'WGS84 GeoJSON coordinates', conversion: 'provider geometry and projection contract are source-specific' };
    return { requestedOutput: 'WGS84 longitude/latitude', conversion: 'source-specific adapter contract; see adapter source and provider metadata' };
}

function finitePair(p) { return Array.isArray(p) && p.length === 2 && p.every(v => typeof v === 'number' && Number.isFinite(v)); }
function geometryVertices(geometry) {
    let count = 0;
    const walk = value => {
        if (finitePair(value)) { count++; return; }
        if (Array.isArray(value)) for (const child of value) walk(child);
    };
    walk(geometry?.coordinates);
    return count;
}
export function safeGeometry(geometry) {
    if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type) || geometryVertices(geometry) > MAX_OBSERVATION_VERTICES) return null;
    let valid = true;
    const check = value => {
        if (finitePair(value)) { if (Math.abs(value[0]) > 1e9 || Math.abs(value[1]) > 1e9) valid = false; return; }
        if (!Array.isArray(value)) { valid = false; return; }
        for (const child of value) check(child);
    };
    check(geometry.coordinates);
    return valid ? { type: geometry.type, coordinates: geometry.coordinates } : null;
}
function crsToken(value) {
    if (typeof value !== 'string') return null;
    const clean = value.trim().slice(0, 160);
    return /^(?:CRS:84|CRS84|OGC:CRS84|EPSG:\d{4,6}|urn:ogc:def:crs:EPSG::\d{4,6}|https?:\/\/www\.opengis\.net\/def\/crs\/EPSG\/0\/\d{4,6})$/i.test(clean) ? clean : null;
}
function spatialReference(value) {
    if (!value || typeof value !== 'object') return null;
    const srid = value.latestWkid ?? value.wkid;
    if (Number.isSafeInteger(srid) && srid > 0) return { wkid: value.wkid ?? null, latestWkid: value.latestWkid ?? null };
    const wkt = typeof value.wkt === 'string' ? value.wkt : '';
    if (!wkt) return null;
    const axes = [...wkt.matchAll(/AXIS\s*\[\s*"([^"]{1,60})"\s*,\s*(EAST|WEST|NORTH|SOUTH)\b/gi)].map(m => `${m[1]}:${m[2].toUpperCase()}`);
    return { wktName: wkt.match(/(?:PROJCS|GEOGCS|PROJCRS|GEOGCRS)\s*\[\s*"([^"]{1,100})"/i)?.[1] ?? null,
        datum: wkt.match(/(?:DATUM|GEODDATUM|ENSEMBLE)\s*\[\s*"([^"]{1,100})"/i)?.[1] ?? null,
        axisOrder: axes.length ? axes : null };
}
function payloadCrs(payload, feature) {
    return crsToken(payload?.crs?.properties?.name)
        || spatialReference(feature?.geometry?.spatialReference)
        || spatialReference(payload?.spatialReference)
        || spatialReference(payload?.sourceSpatialReference)
        || spatialReference(payload?.extent?.spatialReference)
        || spatialReference(payload?.fullExtent?.spatialReference);
}
function extractGeometry(feature) {
    const geometry = safeGeometry(feature?.geometry);
    if (geometry) return geometry;
    const esri = feature?.geometry;
    if (Array.isArray(esri?.rings) && esri.rings.length === 1) return safeGeometry({ type: 'Polygon', coordinates: [esri.rings[0]] });
    return null;
}
function safeId(value) {
    if (typeof value === 'string' && value.length <= 256 && !SENSITIVE.test(value)) return value;
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
    return null;
}
export function safeProviderObservation(payload, descriptor) {
    const features = Array.isArray(payload?.features) ? payload.features : [];
    const first = features.find(feature => extractGeometry(feature));
    if (!first) return { responseCrs: payloadCrs(payload, null), featureSample: null };
    const idField = typeof descriptor?.idField === 'string' && !SENSITIVE.test(descriptor.idField) ? descriptor.idField : null;
    return { responseCrs: payloadCrs(payload, first), featureSample: {
        nativeId: safeId(first.properties?.[idField] ?? first.attributes?.[idField] ?? first.id),
        geometry: extractGeometry(first)
    } };
}
export function compareGeometryPassThrough(observations, features) {
    const samples = observations.flatMap(item => item?.featureSample?.geometry ? [item.featureSample] : []);
    for (const sample of samples) {
        const match = (features || []).some(feature => JSON.stringify(safeGeometry(feature?.geometry)) === JSON.stringify(sample.geometry));
        if (match) return true;
    }
    return false;
}
export function buildProbeBounds([lon, lat], maxBboxKm2 = 0.1) {
    const halfMetres = Math.min(20, Math.sqrt(Math.max(0.00001, maxBboxKm2) * 1_000_000) * 0.35);
    const dLat = halfMetres / 111_320;
    const dLon = halfMetres / (111_320 * Math.max(0.05, Math.cos(lat * Math.PI / 180)));
    return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

function atomicJson(file, value) {
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    renameSync(temp, file);
}
function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }
function fileKey(sourceId, cityId = '') { return createHash('sha256').update(`${sourceId}\n${cityId}`).digest('hex'); }
function normalizeCrs(value) {
    if (typeof value !== 'string') return null;
    if (/^(?:CRS:84|CRS84|OGC:CRS84)$/i.test(value)) return 'CRS:84';
    const match = /(?:EPSG:|EPSG::|EPSG\/0\/)(\d{4,6})$/i.exec(value);
    return match ? `EPSG:${match[1]}` : null;
}
function requestedCrs(descriptor) {
    if (descriptor.adapter === 'arcgis' || ['dda-public-plots', 'shenzhen-land-certain', 'pulse-public'].includes(descriptor.adapter)) return `EPSG:${descriptor.responseSrid ?? 4326}`;
    if (descriptor.adapter === 'wfs' || descriptor.adapter === 'dgu-wfs') return descriptor.responseSrid === 3857 ? 'EPSG:3857' : 'CRS:84';
    if (descriptor.adapter === 'hamburg-alkis-wfs') return 'CRS:84';
    if (descriptor.adapter === 'frankfurt-wfs') return 'EPSG:25832';
    return descriptor.responseCrs || descriptor.nativeCrs || descriptor.sourceCrs || null;
}
function arcgisMetadataUrl(endpoint) { const url = new URL(endpoint); url.search = ''; url.searchParams.set('f', 'pjson'); return url.href; }
function wfsMetadataUrl(descriptor) {
    const url = new URL(descriptor.endpoint);
    url.search = '';
    url.searchParams.set('service', 'WFS'); url.searchParams.set('request', 'GetCapabilities');
    url.searchParams.set('version', descriptor.version || '2.0.0');
    return url.href;
}
function parseWfsCrs(text) {
    const values = [];
    for (const match of text.matchAll(/<(?:\w+:)?(?:DefaultCRS|OtherCRS|DefaultSRS|OtherSRS|DefaultCRS|DefaultSrs)\b[^>]*>([^<]{1,200})<\//gi)) {
        const value = match[1].trim(); if (crsToken(value) && !values.includes(value)) values.push(value);
    }
    return values.slice(0, 20);
}
export function parseWfsCapabilities(text, selectedName) {
    const serviceCrs = parseWfsCrs(text);
    const featureTypes = [];
    let current = null, capture = null, capturedText = '';
    const parser = new SaxesParser({ xmlns: true });
    parser.on('opentag', tag => {
        if (tag.local === 'FeatureType') { current = { name: null, crs: [] }; featureTypes.push(current); }
        else if (current && tag.local === 'Name') { capture = 'name'; capturedText = ''; }
        else if (current && ['DefaultCRS', 'OtherCRS', 'DefaultSRS', 'OtherSRS'].includes(tag.local)) {
            capture = 'crs'; capturedText = '';
        }
    });
    parser.on('text', value => { if (capture) capturedText += value; });
    parser.on('closetag', tag => {
        if (current && capture === 'name' && tag.local === 'Name') {
            current.name = capturedText.trim().slice(0, 200); capture = null;
        } else if (current && capture === 'crs' && ['DefaultCRS', 'OtherCRS', 'DefaultSRS', 'OtherSRS'].includes(tag.local)) {
            const value = capturedText.trim(); if (crsToken(value) && current.crs.length < 20) current.crs.push(value);
            capture = null;
        } else if (tag.local === 'FeatureType' && current) current = null;
    });
    try { parser.write(text).close(); } catch {
        return { scope: 'service-wide', selectedFeatureType: selectedName || null,
            selectedFeatureTypeMatched: false, advertisedCrs: serviceCrs, featureTypes: [] };
    }
    const bounded = featureTypes.slice(0, 100).map(item => ({ name: item.name, crs: [...new Set(item.crs)] }));
    const selected = selectedName ? bounded.find(item => item.name === selectedName) : null;
    return { scope: selected ? 'selected-feature-type' : 'service-wide', selectedFeatureType: selectedName || null,
        selectedFeatureTypeMatched: Boolean(selected), advertisedCrs: selected?.crs || serviceCrs, featureTypes: bounded };
}
async function boundedText(response) {
    const reader = response.clone().body?.getReader();
    if (!reader) return null;
    const chunks = []; let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_OBSERVATION_BYTES) { await reader.cancel().catch(() => {}); return null; }
            chunks.push(value);
        }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}
function makeFetchGate(maxRequests, onRequest = () => {}) {
    const tails = new Map(); let count = 0;
    return {
        get count() { return count; },
        async request(input, options = {}) {
            const url = new URL(input instanceof Request ? input.url : input);
            if (url.protocol !== 'https:') throw Object.assign(new Error('Non-HTTPS provider request blocked'), { code: 'parcel-audit-non-https' });
            const host = url.host;
            const previous = tails.get(host) || Promise.resolve();
            let release;
            const turn = new Promise(resolve => { release = resolve; });
            const tail = previous.then(() => turn);
            tails.set(host, tail);
            await previous;
            try {
                if (count >= maxRequests) throw Object.assign(new Error('Audit request budget exhausted'), { code: 'parcel-audit-request-budget' });
                count++;
                onRequest(count, url.href);
                const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
                const supplied = options.signal;
                const signal = supplied ? AbortSignal.any([supplied, timeout]) : timeout;
                const response = await globalThis.fetch(input, { ...options, signal, redirect: 'error' });
                const headers = new Headers(response.headers);
                for (const header of ['content-length', 'content-encoding', 'transfer-encoding']) headers.delete(header);
                if (!response.body) return new Response(null, { status: response.status, statusText: response.statusText, headers });
                const reader = response.body.getReader(); const chunks = []; let size = 0;
                try {
                    for (;;) {
                        const { done, value } = await reader.read(); if (done) break;
                        size += value.byteLength;
                        if (size > MAX_OBSERVATION_BYTES) {
                            await reader.cancel().catch(() => {});
                            throw Object.assign(new Error('Provider response exceeded the bounded audit response size'), { code: 'parcel-audit-response-too-large' });
                        }
                        chunks.push(value);
                    }
                } finally { reader.releaseLock(); }
                const bytes = new Uint8Array(size); let offset = 0;
                for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
                return new Response(bytes, { status: response.status, statusText: response.statusText, headers });
            } finally {
                release();
                if (tails.get(host) === tail) tails.delete(host);
            }
        }
    };
}
function requestSignature(input, options) {
    const url = new URL(input instanceof Request ? input.url : input);
    for (const key of [...url.searchParams.keys()]) if (/^(?:token|access_token|api_key|apikey|session)$/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    let body = '';
    if (typeof options.body === 'string') {
        try {
            const params = new URLSearchParams(options.body);
            for (const key of [...params.keys()]) if (/^(?:token|access_token|api_key|apikey|session)$/i.test(key)) params.delete(key);
            params.sort(); body = params.toString();
        } catch { body = '[body]'; }
    }
    return `${options.method || 'GET'} ${url.href} ${body}`;
}
function observerFor(descriptor, gate, perBindingLimit = Infinity) {
    const observations = []; const seenRequests = new Set(); let count = 0;
    return {
        observations,
        get count() { return count; },
        fetchImpl: async (input, options = {}) => {
            const signature = requestSignature(input, options);
            if (seenRequests.has(signature)) throw Object.assign(new Error('Repeated request blocked; audit retries are disabled'), { code: 'parcel-audit-retry-blocked' });
            seenRequests.add(signature);
            if (++count > perBindingLimit) throw Object.assign(new Error('Per-binding request cap reached'), { code: 'parcel-audit-binding-request-cap' });
            const response = await gate.request(input, options);
            const contentType = response.headers?.get?.('content-type') || '';
            if (/(?:json|xml|text)/i.test(contentType) && observations.length < 4) {
                const text = await boundedText(response);
                if (text !== null) {
                    let payload;
                    try { payload = JSON.parse(text); } catch { payload = null; }
                    if (payload) observations.push(safeProviderObservation(payload, descriptor));
                    else observations.push({ responseCrsTags: parseWfsCrs(text), featureSample: null });
                } else observations.push({ responseCrsTags: [], featureSample: null, responseTooLargeToInspect: true });
            }
            return response;
        }
    };
}
async function sourceMetadata(descriptor, gate) {
    const adapter = descriptor.adapter;
    const url = adapter === 'arcgis' ? arcgisMetadataUrl(descriptor.endpoint)
        : WFS_ADAPTERS.has(adapter) ? wfsMetadataUrl(descriptor) : null;
    const selectedFeatureType = descriptor.featureType || descriptor.typeName || null;
    const base = { fetched: false, method: url ? (adapter === 'arcgis' ? 'ArcGIS layer pjson' : 'WFS GetCapabilities') : 'no common metadata endpoint',
        metadataUrl: url, declaredCrs: sourceCrsSummary(descriptor), selectedFeatureType,
        observedAt: new Date().toISOString(), metadataScope: url && adapter !== 'arcgis' ? 'service-wide' : 'layer', wfsCapabilities: null, arcgis: null };
    if (!url) return base;
    const observer = observerFor(descriptor, gate);
    try {
        const response = await observer.fetchImpl(url, { headers: { Accept: adapter === 'arcgis' ? 'application/json' : 'application/xml,text/xml' } });
        if (!response.ok) return { ...base, fetched: true, httpStatus: response.status };
        const text = await boundedText(response);
        if (text === null) return { ...base, fetched: true, httpStatus: response.status, metadataTooLarge: true };
        if (adapter === 'arcgis') {
            const json = JSON.parse(text);
            const sr = json.spatialReference || json.extent?.spatialReference || json.fullExtent?.spatialReference || null;
            const sourceSr = json.sourceSpatialReference || null;
            return { ...base, fetched: true, httpStatus: response.status, arcgis: {
                geometryType: typeof json.geometryType === 'string' ? json.geometryType : null,
                spatialReference: spatialReference(sr), sourceSpatialReference: spatialReference(sourceSr),
                extentSpatialReference: spatialReference(json.extent?.spatialReference || json.fullExtent?.spatialReference)
            } };
        }
        const wfsCapabilities = parseWfsCapabilities(text, selectedFeatureType);
        return { ...base, fetched: true, httpStatus: response.status, metadataScope: wfsCapabilities.scope,
            selectedFeatureTypeMatched: wfsCapabilities.selectedFeatureTypeMatched, wfsCapabilities };
    } catch (error) { return { ...base, fetched: true, error: safeFailure(error) }; }
}
function arcgisNativeWkid(metadata) {
    const sr = metadata?.metadata?.arcgis?.sourceSpatialReference || metadata?.metadata?.arcgis?.spatialReference
        || metadata?.metadata?.arcgis?.extentSpatialReference;
    const wkid = sr?.latestWkid ?? sr?.wkid;
    return Number.isSafeInteger(wkid) && wkid > 0 ? wkid : null;
}
export function safeEsriNativeFeature(payload, descriptor, requestedWkid) {
    const feature = payload?.features?.find(row => Array.isArray(row?.geometry?.rings));
    if (!feature || payload.features.length !== 1) return null;
    const actualSr = payload.spatialReference || feature.geometry.spatialReference;
    const actualWkid = actualSr?.latestWkid ?? actualSr?.wkid;
    if (!Number.isSafeInteger(actualWkid) || actualWkid <= 0) return null;
    const actualLatestWkid = actualSr?.latestWkid;
    if (actualWkid !== requestedWkid && actualLatestWkid !== requestedWkid) return null;
    const rings = feature.geometry.rings;
    let vertices = 0;
    if (!rings.length || rings.some(ring => !Array.isArray(ring) || ring.length < 4
        || ring.some(point => !finitePair(point) || point.some(value => Math.abs(value) > 1e9) || ++vertices > MAX_OBSERVATION_VERTICES))) return null;
    const idField = typeof descriptor.idField === 'string' && !SENSITIVE.test(descriptor.idField) ? descriptor.idField : null;
    return { nativeId: safeId(feature.attributes?.[idField]), responseCrs: `EPSG:${actualLatestWkid ?? actualWkid}`,
        responseSpatialReference: spatialReference(actualSr),
        geometry: { type: 'EsriRings', rings } };
}
export async function queryArcgisNativeSample(descriptor, features, metadata, observer) {
    const wkid = arcgisNativeWkid(metadata);
    if (!wkid) return { status: 'held', reason: 'ArcGIS metadata has no EPSG wkid for native response; WKT-only CRS needs an explicit transform operation' };
    if (observer.count >= MAX_BINDING_REQUESTS) return { status: 'held', reason: 'adapter bounds read used the complete per-binding request budget' };
    const idField = descriptor.idField;
    const columnName = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,7}$/.test(value);
    if (!columnName(idField) || SENSITIVE.test(idField) || !descriptor.outFields?.includes(idField)) {
        return { status: 'held', reason: 'catalogue does not expose a safe single native ID field for a paired exact read' };
    }
    if (descriptor.nativeGeometryMode === 'parts' || descriptor.idFields) return { status: 'held', reason: 'source assembles multipart/native composite geometry; single-row native read is not an equivalent sample' };
    const nativeId = features[0]?.properties?.sourceParcelId;
    if (typeof nativeId !== 'string' || !nativeId || nativeId.length > 256) return { status: 'held', reason: 'bounded output omitted a safe native ID for paired exact read' };
    const literal = descriptor.idType === 'integer' ? (/^(?:0|[1-9]\d*)$/.test(nativeId) ? nativeId : null)
        : typeof nativeId === 'string' ? `'${nativeId.replaceAll("'", "''")}'` : null;
    if (!literal) return { status: 'held', reason: 'native ID cannot be encoded as a safe exact ArcGIS query literal' };
    const objectIdField = descriptor.objectIdField || 'OBJECTID';
    if (!columnName(objectIdField) || !descriptor.outFields.includes(objectIdField)) {
        return { status: 'held', reason: 'catalogue object ID field cannot be safely included in the native sample read' };
    }
    let valuesFilter;
    try { valuesFilter = createParcelAttributeFilter(descriptor); }
    catch { return { status: 'held', reason: 'catalogue attribute filter could not be safely reproduced for the exact read' }; }
    if (Object.hasOwn(descriptor, 'attributeDateEquals') && descriptor.attributeDateEquals === null) {
        return { status: 'held', reason: 'catalogue date filter could not be safely reproduced for the exact read' };
    }
    const dateEquals = descriptor.attributeDateEquals || {};
    if (!dateEquals || typeof dateEquals !== 'object' || Array.isArray(dateEquals)
        || Object.entries(dateEquals).length > 8
        || Object.entries(dateEquals).some(([field, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)
            || !descriptor.outFields.includes(field) || descriptor.attributeNull?.includes(field)
            || typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(value)
            || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)) {
        return { status: 'held', reason: 'catalogue date filter could not be safely reproduced for the exact read' };
    }
    const dateWhere = Object.entries(dateEquals).map(([field, value]) =>
        `${field} = TIMESTAMP '${value.slice(0, 19).replace('T', ' ')}'`);
    const where = [...(valuesFilter.where ? [valuesFilter.where] : []), ...dateWhere, `${idField} = ${literal}`]
        .map(part => `(${part})`).join(' AND ');
    const params = new URLSearchParams({ f: 'json', where, outFields: `${idField},${objectIdField}`,
        returnGeometry: 'true', outSR: String(wkid), resultRecordCount: '2' });
    try {
        const response = await observer.fetchImpl(`${descriptor.endpoint}/query?${params}`, { headers: { Accept: 'application/json' } });
        if (!response.ok) return { status: 'held', reason: `native sample endpoint returned HTTP ${response.status}` };
        const text = await boundedText(response);
        if (text === null) return { status: 'held', reason: 'native sample response exceeded the bounded observation size' };
        const payload = JSON.parse(text);
        if (payload?.error) return { status: 'held', reason: 'native sample endpoint returned an ArcGIS error object' };
        const sample = safeEsriNativeFeature(payload, descriptor, wkid);
        if (sample && String(sample.nativeId) !== nativeId) return { status: 'held', reason: 'native exact read returned an ID different from the requested bounded feature' };
        return sample ? { status: 'sampled', ...sample } : { status: 'held', reason: 'native response omitted a matching explicit EPSG spatialReference or a bounded safe polygon sample' };
    } catch (error) { return { status: 'held', error: safeFailure(error) }; }
}
function safeFailure(error) {
    return { type: typeof error?.name === 'string' ? error.name : 'Error',
        ...(typeof error?.code === 'string' ? { code: error.code } : {}),
        ...(Number.isSafeInteger(error?.status) ? { status: error.status } : {}) };
}
export function centerInventory(configs, sources) {
    const cityById = new Map(configs.map(city => [city.id, city]));
    const ids = new Set(sources.flatMap(source => source.cityIds || []));
    return [...ids].sort().map(cityId => {
        const config = cityById.get(cityId);
        const bindings = sources.filter(source => source.cityIds?.includes(cityId)).map(source => ({ sourceId: source.id,
            optIn: source.defaultForCity === false, configuredDefault: config?.sourceId === source.id,
            sourceDescriptorHash: descriptorHash(source) }));
        return { cityId, ...(config ? { center: [config.lon, config.lat], name: config.name } : {}), bindings,
            status: config ? 'configured-center' : 'unresolved-center' };
    });
}
function bindingRecordPath(out, sourceId, cityId) { return path.join(out, 'records', `${fileKey(sourceId, cityId)}.json`); }
function chooseQueryMode(descriptor, cityConfig) {
    return POINT_ADAPTERS.has(descriptor.adapter) || descriptor.queryMode === 'point' || cityConfig?.queryMode === 'point' ? 'point' : 'bounds';
}
function validateOutputPath(out) {
    const absolute = path.resolve(out);
    const tempRoot = path.resolve(process.env.TMPDIR || '/tmp');
    const ignoredTmp = path.join(ROOT, 'tmp');
    const underTmp = absolute === ignoredTmp || absolute.startsWith(`${ignoredTmp}${path.sep}`);
    const underSystemTmp = absolute === tempRoot || absolute.startsWith(`${tempRoot}${path.sep}`)
        || absolute === '/tmp' || absolute.startsWith('/tmp/');
    if (!underTmp && !underSystemTmp) {
        throw new Error('--output must be under an ignored tmp directory or the system temporary directory.');
    }
    return absolute;
}
async function auditBinding(descriptor, city, cityConfig, gate, out, sourceCrs) {
    const descriptorDigest = descriptorHash(descriptor);
    const file = bindingRecordPath(out, descriptor.id, city);
    const prior = readJson(file);
    if (prior?.format === FORMAT && prior.sourceDescriptorHash === descriptorDigest && prior.cityId === city) return prior;
    const recordBase = { format: FORMAT, sourceId: descriptor.id, adapter: descriptor.adapter, cityId: city,
        optInSource: descriptor.defaultForCity === false, sourceDescriptorHash: descriptorDigest,
        sourceCrs, center: [cityConfig.lon, cityConfig.lat], queryMode: chooseQueryMode(descriptor, cityConfig),
        surveyToImageryAlignment: 'unverified; no translation, rotation or scale was fitted or applied' };
    if (SNAPSHOT_ADAPTERS.has(descriptor.adapter)) {
        const record = { ...recordBase, status: 'held', reason: 'archive-reuse-required; live probe would require loading a potentially large snapshot' };
        atomicJson(file, record); return record;
    }
    const bindingCap = descriptor.adapter === 'arcgis' ? 4 : 3;
    const observer = observerFor(descriptor, gate, bindingCap);
    let adapter, result;
    try {
        adapter = createParcelSource(descriptor, { fetchImpl: observer.fetchImpl,
            ...(descriptor.adapter === 'dgu-wfs' ? { token: process.env.OSS_PUBLIC_ACCESS_TOKEN || process.env.OSS_TOKEN } : {}) });
        if (recordBase.queryMode === 'point') result = await adapter.queryPoint([cityConfig.lon, cityConfig.lat]);
        else result = await adapter.queryBounds(buildProbeBounds([cityConfig.lon, cityConfig.lat], descriptor.maxBboxKm2 || 0.1));
    } catch (error) {
        const record = { ...recordBase, status: 'request-error', error: safeFailure(error), requests: observer.count };
        atomicJson(file, record); return record;
    }
    const features = Array.isArray(result?.features) ? result.features : [];
    const samples = features.slice(0, 3).map(feature => ({ id: safeId(feature.id), geometry: safeGeometry(feature.geometry) })).filter(item => item.geometry);
    if (!features.length) {
        const record = { ...recordBase, status: 'empty', reason: 'bounded query completed with no polygons at the configured city center', requests: observer.count,
            responseCrs: observer.observations.map(item => item.responseCrs || null), sample: [] };
        atomicJson(file, record); return record;
    }
    const nativeSample = descriptor.adapter === 'arcgis'
        ? await queryArcgisNativeSample(descriptor, features, sourceCrs, observer) : null;
    const requested = normalizeCrs(requestedCrs(descriptor));
    const observed = observer.observations.map(item => normalizeCrs(item.responseCrs)).filter(Boolean);
    const passthrough = compareGeometryPassThrough(observer.observations, features);
    const explicitWgs = observed.some(crs => crs === 'CRS:84' || crs === 'EPSG:4326');
    const status = requested && ['CRS:84', 'EPSG:4326'].includes(requested) && explicitWgs && passthrough
        ? 'adapter-output-exact-passthrough' : 'held';
    const record = { ...recordBase, status,
        ...(status === 'held' ? { reason: requested && !['CRS:84', 'EPSG:4326'].includes(requested)
            ? 'transformed or projected output lacks an independent CRS transformation check'
            : !explicitWgs ? 'provider response did not expose an explicit WGS84/CRS:84 tag in the bounded observation'
                : 'provider geometry sample did not exactly match canonical output geometry' } : {}),
        requestedOutputCrs: requestedCrs(descriptor), observedResponseCrs: observer.observations.map(item => item.responseCrs || item.responseCrsTags || null),
        geometryPassThroughExact: passthrough,
        coordinateScope: status === 'adapter-output-exact-passthrough'
            ? 'canonical output equals the bounded provider sample and declares WGS84/CRS:84; provider CRS truth and survey-to-imagery alignment remain unverified' : null,
        canonicalFeatureCount: features.length, requests: observer.count, sample: samples };
    if (nativeSample) {
        const nativeId = nativeSample.nativeId;
        const paired = nativeId === null ? null : features.find(feature => feature.properties?.sourceParcelId === String(nativeId)) || null;
        record.nativeSample = { ...nativeSample, pairedCanonicalId: safeId(paired?.id),
            sameNativeIdInBoundedOutput: Boolean(paired), axisOrder: nativeSample.axisOrder || sourceCrs?.metadata?.arcgis?.sourceSpatialReference?.axisOrder || null,
            metadataFile: sourceCrs?.metadataFile || null, metadataSha256: sourceCrs?.metadataSha256 || null,
            metadataUrl: sourceCrs?.metadata?.metadataUrl || null,
            transformOperation: 'not inferred by this script; compare declared native coordinates with independent PROJ operation and canonical WGS84 sample' };
    }
    atomicJson(file, record);
    return record;
}
function makeProgressTracker(out, selected, maxRequests) {
    const file = path.join(out, 'progress.json');
    const selectionHash = descriptorHash(selected.map(source => [source.id, descriptorHash(source)]));
    const previous = readJson(file);
    const resumable = previous?.format === FORMAT && previous.selectionHash === selectionHash;
    const sources = resumable ? { ...(previous.sources || {}) } : {};
    const bindings = resumable ? { ...(previous.bindings || {}) } : {};
    const sourceTotal = selected.length;
    const bindingTotal = selected.reduce((total, source) => total + (source.cityIds?.length || 0), 0);
    let requests = resumable && Number.isSafeInteger(previous.requests) ? previous.requests : 0;
    let requestsThisRun = 0;
    let bindingCompletionEvents = 0;
    const keyFor = (source, city) => `${source.id}\n${city}`;
    const completedSourceCount = () => Object.values(sources).filter(item => item.status === 'completed').length;
    const completedBindingCount = () => Object.values(bindings).filter(item => item.status === 'completed').length;
    const persist = (event = null) => atomicJson(file, { format: FORMAT, selectionHash, updatedAt: new Date().toISOString(),
        limits: { maxRequests, sourceTotal, bindingTotal }, requests, requestsThisRun,
        completed: { sources: completedSourceCount(), sourceTotal, bindings: completedBindingCount(), bindingTotal },
        sources, bindings, lastEvent: event });
    const sourceStarted = (source, index) => {
        const prior = sources[source.id];
        sources[source.id] = { status: prior?.status === 'completed' ? 'completed' : 'running',
            startedAt: prior?.startedAt || new Date().toISOString(), ...(prior?.completedAt ? { completedAt: prior.completedAt } : {}) };
        persist({ type: 'source-started', sourceId: source.id, at: new Date().toISOString() });
        console.log(`[parcel-audit] source ${index + 1}/${sourceTotal} ${source.id} started`);
    };
    const sourceCompleted = source => {
        sources[source.id] = { status: 'completed', startedAt: sources[source.id]?.startedAt || new Date().toISOString(), completedAt: new Date().toISOString() };
        persist({ type: 'source-completed', sourceId: source.id, at: new Date().toISOString() });
        console.log(`[parcel-audit] source ${completedSourceCount()}/${sourceTotal} ${source.id} complete`);
    };
    return {
        sourceStarted, sourceCompleted,
        bindingStarted(source, cityId) {
            const key = keyFor(source, cityId), prior = bindings[key];
            bindings[key] = { sourceId: source.id, cityId, status: prior?.status === 'completed' ? 'completed' : 'running',
                startedAt: prior?.startedAt || new Date().toISOString(), ...(prior?.completedAt ? { completedAt: prior.completedAt } : {}) };
            persist({ type: 'binding-started', sourceId: source.id, cityId, at: new Date().toISOString() });
        },
        bindingCompleted(source, cityId, status) {
            const key = keyFor(source, cityId), prior = bindings[key];
            const isNewCompletion = prior?.status !== 'completed';
            bindings[key] = { sourceId: source.id, cityId, status: 'completed', resultStatus: status,
                startedAt: prior?.startedAt || new Date().toISOString(), completedAt: new Date().toISOString() };
            persist({ type: 'binding-completed', sourceId: source.id, cityId, at: bindings[key].completedAt });
            if (isNewCompletion) bindingCompletionEvents++;
            if (isNewCompletion && (bindingCompletionEvents % 5 === 0 || completedBindingCount() === bindingTotal)) {
                console.log(`[parcel-audit] bindings ${completedBindingCount()}/${bindingTotal} complete; requests ${requestsThisRun}/${maxRequests}`);
            }
        },
        request() { requests++; requestsThisRun++; persist({ type: 'request-started', at: new Date().toISOString() }); },
        summary() { return { requests, requestsThisRun, completedSources: completedSourceCount(), sourceTotal,
            completedBindings: completedBindingCount(), bindingTotal }; }
    };
}
async function sourceWorker(descriptor, cityMap, gate, out, inventory) {
    const digest = descriptorHash(descriptor);
    const metaFile = path.join(out, 'sources', `${fileKey(descriptor.id)}.json`);
    let metadata = readJson(metaFile);
    if (metadata?.sourceDescriptorHash !== digest) {
        const fetched = await sourceMetadata(descriptor, gate);
        metadata = { format: FORMAT, sourceId: descriptor.id, adapter: descriptor.adapter, sourceDescriptorHash: digest,
            optInSource: descriptor.defaultForCity === false, crsContract: adapterCrsContract(descriptor), metadata: fetched };
        atomicJson(metaFile, metadata);
    }
    metadata = { ...metadata, metadataFile: path.relative(out, metaFile), metadataSha256: createHash('sha256').update(readFileSync(metaFile)).digest('hex') };
    const results = [];
    for (const cityId of descriptor.cityIds || []) {
        const city = cityMap.get(cityId);
        if (!city) {
            const file = bindingRecordPath(out, descriptor.id, cityId);
            const prior = readJson(file);
            if (prior?.format === FORMAT && prior.sourceDescriptorHash === digest) {
                results.push(prior); inventory.bindingCompleted(descriptor, cityId, prior.status); continue;
            }
            const unresolved = { format: FORMAT, sourceId: descriptor.id, adapter: descriptor.adapter, cityId,
                optInSource: descriptor.defaultForCity === false, sourceDescriptorHash: digest, status: 'unresolved',
                reason: 'city center is not present in parseCityConfigs output', surveyToImageryAlignment: 'unverified' };
            atomicJson(file, unresolved); results.push(unresolved); inventory.bindingCompleted(descriptor, cityId, unresolved.status); continue;
        }
        inventory.bindingStarted(descriptor, cityId);
        const record = await auditBinding(descriptor, cityId, city, gate, out, metadata);
        results.push(record); inventory.bindingCompleted(descriptor, cityId, record.status);
    }
    inventory.sourceCompleted(descriptor);
    return results;
}
async function parallelLimit(items, limit, worker) {
    let cursor = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        for (;;) { const index = cursor++; if (index >= items.length) return; await worker(items[index]); }
    });
    await Promise.all(runners);
}
function parseArgs(args) {
    const options = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--run') options.run = true;
        else if (arg === '--output' || arg === '--catalog' || arg === '--source' || arg === '--max-requests') {
            const value = args[++i]; if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
            options[arg.slice(2)] = value;
        } else if (arg === '--help' || arg === '-h') options.help = true;
        else throw new Error(`Unknown option: ${arg}`);
    }
    return options;
}
export async function runAudit({ catalogPath = DEFAULT_CATALOG, output, sourceId, maxRequests = MAX_REQUESTS }) {
    if (!output) throw new Error('--run requires --output in an ignored tmp directory.');
    if (!Number.isSafeInteger(Number(maxRequests)) || Number(maxRequests) < 1 || Number(maxRequests) > 5000) throw new Error('--max-requests must be 1..5000.');
    const out = validateOutputPath(output); mkdirSync(out, { recursive: true });
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    const descriptors = catalog.sources;
    if (!Array.isArray(descriptors)) throw new Error('Catalog has no sources array.');
    const configs = parseCityConfigs(readFileSync(CITY_CONFIG, 'utf8'));
    const cities = centerInventory(configs, descriptors);
    const cityMap = new Map(configs.map(city => [city.id, city]));
    const adapterCounts = Object.fromEntries([...new Set(descriptors.map(source => source.adapter))].sort().map(adapter => [adapter, {
        total: descriptors.filter(source => source.adapter === adapter).length,
        defaultEligible: descriptors.filter(source => source.adapter === adapter && source.defaultForCity !== false).length,
        optIn: descriptors.filter(source => source.adapter === adapter && source.defaultForCity === false).length
    }]));
    const selected = sourceId ? descriptors.filter(item => item.id === sourceId) : descriptors;
    if (sourceId && !selected.length) throw new Error(`Source ID is not in the catalog: ${sourceId}`);
    const inventory = { format: FORMAT, generatedAt: new Date().toISOString(), catalogPath: path.relative(ROOT, catalogPath),
        sourceCount: descriptors.length, adapterTypes: [...new Set(descriptors.map(item => item.adapter))].sort(), adapterCounts,
        defaultEligibleSourceCount: descriptors.filter(source => source.defaultForCity !== false).length,
        optInSourceCount: descriptors.filter(source => source.defaultForCity === false).length,
        sourcesWithoutCityIds: descriptors.filter(source => !source.cityIds?.length).map(source => source.id),
        sources: descriptors.map(source => ({ sourceId: source.id, adapter: source.adapter, sourceDescriptorHash: descriptorHash(source),
            optIn: source.defaultForCity === false, cityIds: source.cityIds || [], crs: sourceCrsSummary(source), crsContract: adapterCrsContract(source),
            selected: !sourceId || source.id === sourceId })),
        cityCount: cities.length, configuredAppCityCount: configs.length, cities,
        bindingCount: descriptors.reduce((n, source) => n + (source.cityIds?.length || 0), 0),
        selectedSourceId: sourceId || null, maxRequests: Number(maxRequests) };
    atomicJson(path.join(out, 'inventory.json'), inventory);
    const progress = makeProgressTracker(out, selected, Number(maxRequests));
    const gate = makeFetchGate(Number(maxRequests), () => progress.request());
    let sourceIndex = 0;
    await parallelLimit(selected, 3, async descriptor => {
        const index = sourceIndex++;
        progress.sourceStarted(descriptor, index);
        try { await sourceWorker(descriptor, cityMap, gate, out, progress); }
        catch (error) {
            // Keep the source/city inventory complete even if source metadata or setup fails.
            for (const cityId of descriptor.cityIds || []) {
                const file = bindingRecordPath(out, descriptor.id, cityId);
                const prior = readJson(file);
                if (prior?.sourceDescriptorHash === descriptorHash(descriptor)) {
                    progress.bindingCompleted(descriptor, cityId, prior.status || 'pending'); continue;
                }
                const config = cityMap.get(cityId);
                const record = { format: FORMAT, sourceId: descriptor.id, adapter: descriptor.adapter, cityId,
                    optInSource: descriptor.defaultForCity === false, sourceDescriptorHash: descriptorHash(descriptor),
                    status: config ? 'request-error' : 'unresolved', error: safeFailure(error),
                    ...(config ? { center: [config.lon, config.lat] } : {}), surveyToImageryAlignment: 'unverified' };
                atomicJson(file, record); progress.bindingCompleted(descriptor, cityId, record.status);
            }
            progress.sourceCompleted(descriptor);
        }
    });
    const selectedIds = new Set(selected.map(item => item.id));
    const records = [];
    for (const source of descriptors) for (const cityId of source.cityIds || []) {
        if (!selectedIds.has(source.id)) { records.push({ sourceId: source.id, cityId, status: 'not-selected' }); continue; }
        records.push(readJson(bindingRecordPath(out, source.id, cityId)) || { sourceId: source.id, cityId, status: 'pending' });
    }
    const counts = Object.fromEntries([...new Set(records.map(record => record.status))].sort().map(status => [status, records.filter(record => record.status === status).length]));
    const summary = { format: FORMAT, completedAt: new Date().toISOString(), sourceCount: descriptors.length, cityCount: cities.length,
        bindingCount: records.length, selectedSourceId: sourceId || null, requests: gate.count, statuses: counts, progress: progress.summary() };
    atomicJson(path.join(out, 'summary.json'), summary);
    return summary;
}
export function usage() {
    return 'Usage: node scripts/audit-parcel-alignment.mjs --run --output tmp/parcel-alignment-audit [--source ID] [--catalog FILE] [--max-requests N]\nNo arguments or --help performs no requests and writes no files.';
}
const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
    try {
        const options = parseArgs(process.argv.slice(2));
        if (options.help || !options.run) console.log(usage());
        else {
            const summary = await runAudit({ catalogPath: options.catalog || DEFAULT_CATALOG, output: options.output,
                sourceId: options.source, maxRequests: options['max-requests'] || MAX_REQUESTS });
            console.log(JSON.stringify(summary, null, 2));
        }
    } catch (error) { console.error(`Parcel alignment audit stopped: ${error.message}`); process.exitCode = 1; }
}
