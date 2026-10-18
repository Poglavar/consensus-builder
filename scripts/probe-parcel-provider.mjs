#!/usr/bin/env node
// Probe known parcel providers over another immutable UN city location.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { GEOMETRY_IDENTITY_KIND, parseGeometryParcelId } from '../backend/parcels/geometry-identity.js';
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const unsafe = /owner|address|titular|titleholder|person|email|phone|taxpayer|account/i;
export function safeRequestUrl(input) {
    const url = new URL(input);
    url.username = ''; url.password = '';
    // The publisher's S3 redirect is presigned. Retain the resource, not its credentials.
    if (url.hostname === 'datapub-prd-s3-bucket.s3.amazonaws.com') url.search = '';
    else for (const key of [...url.searchParams.keys()]) {
        if (/token|api.?key|password|credential|signature|secret/i.test(key)) url.searchParams.set(key, '[redacted]');
    }
    return url.href;
}
export function probeLocations(point, step = 0.0005) {
    if (!Array.isArray(point) || point.length !== 2 || point.some(x => typeof x !== 'number' || !Number.isFinite(x))
        || Math.abs(point[0]) > 90 || Math.abs(point[1]) > 180) throw new Error('Invalid UN latitude/longitude point');
    const [lat, lon] = point;
    return [[0,0],[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]].map(([x,y]) => {
        const p = [lon + x * step, lat + y * step];
        return { point:p, bbox:[p[0]-step/2,p[1]-step/2,p[0]+step/2,p[1]+step/2] };
    });
}
// Where to look: the 3x3 core grid around the UN point, then rings (metres) at 8 bearings with
// ~110 m boxes. The queue states each provider's rings, so a changed pattern is a new pair.
const RING_BOX_DEG = 0.001;
export function searchLocations(point, ringsM) {
    if (!Array.isArray(ringsM) || ringsM.some(r => !Number.isFinite(r) || r <= 0 || r > 20_000)) throw new Error('Search rings must be positive metre radii');
    const [lat, lon] = point;
    const out = probeLocations(point).map(location => ({ ...location, ringM: 0 }));
    const metresPerDegLon = 111_320 * Math.cos(lat * Math.PI / 180);
    for (const ringM of ringsM) for (let k = 0; k < 8; k++) {
        const bearing = k * Math.PI / 4;
        const p = [lon + ringM * Math.sin(bearing) / metresPerDegLon, lat + ringM * Math.cos(bearing) / 111_320];
        const h = RING_BOX_DEG / 2;
        out.push({ point:p, bbox:[p[0]-h,p[1]-h,p[0]+h,p[1]+h], ringM });
    }
    return out;
}
export function safeDescriptor(source) {
    const d = structuredClone(source);
    const fields = new Set([d.idField, d.objectIdField, d.idNamespace?.field, ...(d.idFields || []), ...(d.partMatchFields || []), ...(d.groupFields || [])]);
    for (const key of ['attributeFilters','attributeExclusions','attributeDateEquals']) for (const field of Object.keys(d[key] || {})) fields.add(field);
    for (const key of ['attributeNotNull','attributeNull']) for (const field of d[key] || []) fields.add(field);
    if (d.adapter === 'bev-tiles') for (const f of ['kg','gnr','rstatus']) fields.add(f);
    fields.delete(undefined); fields.delete(null);
    if ([...fields].some(f => unsafe.test(f))) throw new Error('Provider cannot be probed with the safe field allowlist');
    // A provider whose adapter validates its full published field list declares so in its own
    // discovery profile (after review that every field is an ID part); others are narrowed.
    if (d.discovery?.keepPublishedFields === true) {
        if ([...(d.outFields || []), d.parcelNumberField].some(f => f && unsafe.test(f))) throw new Error('Provider cannot be probed with the safe field allowlist');
    } else {
        if (d.outFields) d.outFields = [...fields];
        delete d.parcelNumberField;
    }
    if (d.adapter === 'wfs') {
        if (!d.geometryField) throw new Error('WFS requires a verified geometry field to request safe properties only');
        d.requestProperties = true;
    }
    return d;
}
const WGS84_CRS_NAMES = new Set([
    'EPSG:4326', 'urn:ogc:def:crs:EPSG::4326', 'OGC:CRS84', 'CRS84',
    'urn:ogc:def:crs:OGC::CRS84', 'urn:ogc:def:crs:OGC:1.3:CRS84'
]);
function hasWgs84GeometryCrs(crs) {
    if (crs === undefined || crs === null) return true;
    return crs?.type === 'name' && Object.keys(crs).every(key => ['type', 'properties'].includes(key))
        && crs.properties && Object.keys(crs.properties).every(key => key === 'name')
        && WGS84_CRS_NAMES.has(crs.properties.name);
}
function validWgs84Polygon(type, coordinates) {
    const polygons = type === 'Polygon' ? [coordinates] : coordinates;
    if (!Array.isArray(polygons) || !polygons.length) return false;
    for (const rings of polygons) {
        if (!Array.isArray(rings) || !rings.length) return false;
        for (const ring of rings) {
            if (!Array.isArray(ring) || ring.length < 4) return false;
            for (const position of ring) {
                if (!Array.isArray(position) || position.length < 2
                    || position.some(value => typeof value !== 'number' || !Number.isFinite(value))) return false;
                const [longitude, latitude] = position;
                if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) return false;
            }
            if (ring[0].length !== ring.at(-1).length || ring[0].some((value, index) => value !== ring.at(-1)[index])) return false;
        }
    }
    return true;
}
export function safeSample(feature, sourceId, { returnsWGS84 = false, descriptor } = {}) {
    const p = feature?.properties;
    let reference = p?.sourceParcelId;
    if (descriptor?.identityKind === GEOMETRY_IDENTITY_KIND && p?.sourceId === sourceId) {
        const parsed = parseGeometryParcelId(descriptor, p.parcelId);
        if (descriptor.id !== sourceId || p.parcelIdentityKind !== GEOMETRY_IDENTITY_KIND
            || p.sourceParcelId !== null || p.sourceGeometryHash !== parsed.hash || feature.id !== p.parcelId) {
            throw new Error('Provider returned an invalid geometry-derived parcel reference');
        }
        reference = p.parcelId.slice(descriptor.idPrefix.length);
    }
    if (!p || p.sourceId !== sourceId || typeof reference !== 'string' || !reference
        || typeof p.parcelId !== 'string' || !p.parcelId || returnsWGS84 !== true
        || !['Polygon','MultiPolygon'].includes(feature?.geometry?.type)) {
        throw new Error('Provider returned an invalid native parcel identity or geometry');
    }
    const sourceGeometry = feature.geometry;
    if (Object.keys(sourceGeometry).some(key => !['type', 'coordinates', 'crs'].includes(key))
        || !hasWgs84GeometryCrs(sourceGeometry.crs)
        || !validWgs84Polygon(sourceGeometry.type, sourceGeometry.coordinates)) {
        throw new Error('Provider returned geometry outside the canonical WGS84 polygon contract');
    }
    // Adapters return normalized WGS84 coordinates. Remove only legacy CRS metadata
    // after that contract and the geographic coordinate bounds have been verified.
    const geometry = { type:sourceGeometry.type, coordinates:sourceGeometry.coordinates };
    return { type:'Feature', properties:{id:reference}, geometry };
}
async function main() {
    const argv = process.argv.slice(2);
    if (!argv.includes('--task') || !argv.includes('--output')) {
        console.log('Usage: probe-parcel-provider.mjs --task JSON --output DIR'); return;
    }
    const task = JSON.parse(await fs.readFile(argv[argv.indexOf('--task')+1], 'utf8'));
    const output = path.resolve(argv[argv.indexOf('--output')+1]);
    await fs.mkdir(output, {recursive:true});
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const { createParcelSource } = await import(pathToFileURL(path.join(root,'backend/parcels/sources.js')));
    const attempts = [];
    let result = {status:'held',city:task.city,provider:task.provider,attempts};
    const original = globalThis.fetch;
    let lastRequest = 0;
    let stage = 'bounded-city-probe';
    // A HMLR city can touch 32 council archives; each needs a session,
    // redirect and ZIP request, followed by an independent native-ID read.
    const hmlr = task.provider.descriptor.adapter === 'hmlr-browser';
    // Rings add up to 24 sample boxes after the 9 core cells.
    const requestLimit = hmlr ? 300 : 150;
    const requestTimeoutMs = hmlr ? 180_000 : 25_000;
    // Pacing is the provider's own rule (e.g. Catastro resets connections under bursts).
    const paceMs = task.provider.descriptor.discovery?.paceMs ?? 1000;
    if (!Number.isSafeInteger(paceMs) || paceMs < 250 || paceMs > 10_000) throw new Error('discovery.paceMs must be 250..10000 ms');
    // A 403/429 blocks the provider, not this city: report it so the controller stops the provider.
    let blockedStatus = null;
    const trackedFetch = async (input, init = {}) => {
        if (attempts.length >= requestLimit) throw Object.assign(new Error(`Provider city probe reached its ${requestLimit}-request limit`), { code: 'provider-probe-request-budget' });
        const u = new URL(typeof input === 'string' ? input : input.url || String(input));
        if (u.protocol !== 'https:') throw new Error('Provider discovery requires verified HTTPS');
        if ([...u.searchParams.keys()].some(k => /token|api.?key|password/i.test(k))) throw new Error('Credentialed provider request is not allowed');
        const pause = paceMs - (Date.now() - lastRequest);
        if (pause > 0) await new Promise(r=>setTimeout(r,pause));
        lastRequest = Date.now();
        const evidence = {stage,method:init.method || 'GET',url:safeRequestUrl(u),checkedAt:new Date().toISOString()};
        attempts.push(evidence);
        const timeout = AbortSignal.timeout(requestTimeoutMs);
        const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
        try {
            const r = await original(input,{...init,signal}); evidence.httpStatus=r.status;
            if (r.status === 403 || r.status === 429) blockedStatus = r.status;
            return r;
        } catch (error) { evidence.error=error.cause?.code || error.name; throw error; }
    };
    try {
        if (!task.provider.scopeEvidence?.length || task.provider.descriptor.countryCode !== task.city.iso2) throw new Error('Provider scope and target country require positive evidence');
        const d = safeDescriptor(task.provider.descriptor);
        const noArea = d.capabilities?.areaEnumeration === false || d.areaEnumeration === false || ['tkgm-point','msda-point'].includes(d.adapter);
        globalThis.fetch = trackedFetch;
        const adapter = createParcelSource(d,{fetchImpl:trackedFetch});
        let selected=[];
        for (const location of searchLocations(task.city.point, task.provider.searchRingsM)) {
            let response;
            // One retry for a transport failure at this location; HTTP errors and blocks are final.
            for (let tryNo = 0; ; tryNo++) {
                try { response = noArea ? await adapter.queryPoint(location.point) : await adapter.queryBounds(location.bbox); break; }
                catch (error) {
                    const transport = attempts.at(-1)?.error && attempts.at(-1).httpStatus === undefined;
                    if (blockedStatus || !transport || tryNo === 1 || error.code === 'provider-probe-request-budget') throw error;
                    await new Promise(r=>setTimeout(r,5000));
                }
            }
            if (blockedStatus) break;
            if (response?.complete !== true || response.returnsWGS84 !== true || !Array.isArray(response.features)) {
                throw new Error('Provider response was incomplete or not normalized to WGS84');
            }
            if (response.features.length) {
                selected=response.features.slice(0,3);
                for (const f of selected) safeSample(f,d.id,{...response,descriptor:d});
                result.verifiedQuery = noArea ? {point:location.point} : {bbox:location.bbox};
                result.hitRingM = location.ringM;
                break;
            }
        }
        if (blockedStatus) throw new Error(`Provider blocked access (HTTP ${blockedStatus})`);
        if (!selected.length) result.status='no-hit';
        else {
            stage='independent-native-id-read';
            const ids=selected.map(f=>f.properties.parcelId);
            if (new Set(ids).size !== ids.length) throw new Error('Provider returned duplicate native parcel IDs');
            const fresh=createParcelSource(d,{fetchImpl:trackedFetch});
            const exact=await fresh.queryIds(ids);
            if (blockedStatus) throw new Error(`Provider blocked access (HTTP ${blockedStatus})`);
            if (exact.complete !== true || exact.returnsWGS84 !== true || exact.features?.length !== ids.length
                || exact.absentIds?.length !== 0) throw new Error('Native ID reread did not return the complete WGS84 requested set');
            const found = new Map(exact.features.map(f=>[f.properties.parcelId,f]));
            if (found.size !== ids.length || selected.some(f=>!found.has(f.properties.parcelId) || hash(f.geometry)!==hash(found.get(f.properties.parcelId).geometry))) throw new Error('Native identity or full polygon changed during independent reread');
            const sample={type:'FeatureCollection',features:selected.map(f=>safeSample(f,d.id,{...exact,descriptor:d}))};
            await fs.writeFile(path.join(output,'samples.geojson'),JSON.stringify(sample)+'\n');
            const derived = d.identityKind === GEOMETRY_IDENTITY_KIND;
            result={...result,status:'discovered',sourceId:d.id,sampleFile:'samples.geojson',
                nativeIds:derived ? [] : sample.features.map(f=>f.properties.id),
                ...(derived ? { referenceIds:sample.features.map(f=>f.properties.id),identityProvenance:{
                    kind:GEOMETRY_IDENTITY_KIND,native:false,sourceNamespace:d.id,
                    canonicalization:'geometry-identity.js: SHA-256 of the source ID, identity kind and canonical MultiPolygon coordinates at 1e7 precision.',
                    collisionPolicy:'Canonical references must be unique and independently reread with identical geometry.',
                    stabilityLimits:'References identify a reconstructed snapshot outline; changed geometry changes the reference. They are not published cadastral numbers.',
                    overlapResolution:d.overlapResolution ?? null
                }} : {}),geometryHashes:sample.features.map(f=>hash(f.geometry)),descriptor:d};
        }
    } catch(error) { result={...result,status:blockedStatus ? 'blocked' : 'held',reason:String(error.message).slice(0,400)}; }
    finally { globalThis.fetch=original; }
    await fs.writeFile(path.join(output,'probe.json'),JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify({status:result.status,cityCode:task.city.cityCode,sourceId:task.provider.descriptor.id,requests:attempts.length,reason:result.reason}));
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(e=>{ console.error(e.message); process.exitCode=2; });
