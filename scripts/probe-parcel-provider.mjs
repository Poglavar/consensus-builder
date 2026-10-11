#!/usr/bin/env node
// Probe known parcel providers over another immutable UN city location.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const unsafe = /owner|address|titular|titleholder|person|email|phone|taxpayer|account/i;
export function probeLocations(point, step = 0.0005) {
    if (!Array.isArray(point) || point.length !== 2 || point.some(x => typeof x !== 'number' || !Number.isFinite(x))
        || Math.abs(point[0]) > 90 || Math.abs(point[1]) > 180) throw new Error('Invalid UN latitude/longitude point');
    const [lat, lon] = point;
    return [[0,0],[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]].map(([x,y]) => {
        const p = [lon + x * step, lat + y * step];
        return { point:p, bbox:[p[0]-step/2,p[1]-step/2,p[0]+step/2,p[1]+step/2] };
    });
}
export function safeDescriptor(source) {
    const d = structuredClone(source);
    const fields = new Set([d.idField, d.objectIdField, d.idNamespace?.field, ...(d.idFields || []), ...(d.partMatchFields || [])]);
    for (const key of ['attributeFilters','attributeExclusions','attributeDateEquals']) for (const field of Object.keys(d[key] || {})) fields.add(field);
    for (const key of ['attributeNotNull','attributeNull']) for (const field of d[key] || []) fields.add(field);
    if (d.adapter === 'bev-tiles') for (const f of ['kg','gnr','rstatus']) fields.add(f);
    fields.delete(undefined); fields.delete(null);
    if ([...fields].some(f => unsafe.test(f))) throw new Error('Provider cannot be probed with the safe field allowlist');
    if (d.outFields) d.outFields = [...fields];
    delete d.parcelNumberField;
    if (d.adapter === 'wfs') {
        if (!d.geometryField) throw new Error('WFS requires a verified geometry field to request safe properties only');
        d.requestProperties = true;
    }
    return d;
}
export function safeSample(feature, sourceId) {
    const p = feature?.properties;
    if (!p || p.sourceId !== sourceId || typeof p.sourceParcelId !== 'string' || !p.sourceParcelId
        || typeof p.parcelId !== 'string' || !p.parcelId || !['Polygon','MultiPolygon'].includes(feature?.geometry?.type)) {
        throw new Error('Provider returned an invalid native parcel identity or geometry');
    }
    return { type:'Feature', properties:{id:p.sourceParcelId}, geometry:feature.geometry };
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
    const trackedFetch = async (input, init = {}) => {
        if (attempts.length >= 60) throw new Error('Provider city probe reached its 60-request limit');
        const u = new URL(typeof input === 'string' ? input : input.url || String(input));
        if (u.protocol !== 'https:') throw new Error('Provider discovery requires verified HTTPS');
        if ([...u.searchParams.keys()].some(k => /token|api.?key|password/i.test(k))) throw new Error('Credentialed provider request is not allowed');
        const pause = 1000 - (Date.now() - lastRequest);
        if (pause > 0) await new Promise(r=>setTimeout(r,pause));
        lastRequest = Date.now();
        const evidence = {stage,method:init.method || 'GET',url:u.toString(),checkedAt:new Date().toISOString()};
        attempts.push(evidence);
        const signal = init.signal ? AbortSignal.any([init.signal,AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000);
        try {
            const r = await original(input,{...init,signal}); evidence.httpStatus=r.status; return r;
        } catch (error) { evidence.error=error.name; throw error; }
    };
    try {
        if (!task.provider.scopeEvidence?.length || task.provider.descriptor.countryCode !== task.city.iso2) throw new Error('Provider scope and target country require positive evidence');
        const d = safeDescriptor(task.provider.descriptor);
        const noArea = d.capabilities?.areaEnumeration === false || d.areaEnumeration === false || ['tkgm-point','msda-point'].includes(d.adapter);
        globalThis.fetch = trackedFetch;
        const adapter = createParcelSource(d,{fetchImpl:trackedFetch});
        let selected=[];
        for (const location of probeLocations(task.city.point)) {
            const response = noArea ? await adapter.queryPoint(location.point) : await adapter.queryBounds(location.bbox);
            if (response?.complete !== true || !Array.isArray(response.features)) throw new Error('Provider response was incomplete');
            if (response.features.length) {
                selected=response.features.slice(0,3);
                for (const f of selected) safeSample(f,d.id);
                result.verifiedQuery = noArea ? {point:location.point} : {bbox:location.bbox};
                break;
            }
        }
        if (!selected.length) result.status='no-hit';
        else {
            stage='independent-native-id-read';
            const ids=selected.map(f=>f.properties.parcelId);
            if (new Set(ids).size !== ids.length) throw new Error('Provider returned duplicate native parcel IDs');
            const fresh=createParcelSource(d,{fetchImpl:trackedFetch});
            const exact=await fresh.queryIds(ids);
            if (exact.complete !== true || exact.features?.length !== ids.length || exact.absentIds?.length !== 0) throw new Error('Native ID reread did not return the complete requested set');
            const found = new Map(exact.features.map(f=>[f.properties.parcelId,f]));
            if (found.size !== ids.length || selected.some(f=>!found.has(f.properties.parcelId) || hash(f.geometry)!==hash(found.get(f.properties.parcelId).geometry))) throw new Error('Native identity or full polygon changed during independent reread');
            const sample={type:'FeatureCollection',features:selected.map(f=>safeSample(f,d.id))};
            await fs.writeFile(path.join(output,'samples.geojson'),JSON.stringify(sample)+'\n');
            result={...result,status:'discovered',sourceId:d.id,sampleFile:'samples.geojson',nativeIds:sample.features.map(f=>f.properties.id),geometryHashes:selected.map(f=>hash(f.geometry)),descriptor:d};
        }
    } catch(error) { result={...result,status:'held',reason:String(error.message).slice(0,400)}; }
    finally { globalThis.fetch=original; }
    await fs.writeFile(path.join(output,'probe.json'),JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify({status:result.status,cityCode:task.city.cityCode,sourceId:task.provider.descriptor.id,requests:attempts.length,reason:result.reason}));
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(e=>{ console.error(e.message); process.exitCode=2; });
