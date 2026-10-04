// Official authority snapshots stay in transient memory; no ZIP, XML or parcel is written to disk.
import { Unzip, UnzipInflate } from 'fflate';
import { bbox as geometryBbox, booleanIntersects, bboxPolygon, feature as geoFeature } from '@turf/turf';
import { parseGmlParcels } from './gml-parcel-reader.js';
import { canonicalParcelFeature, upstreamError, providerHttpError, validateBounds, validateGeometry } from './source-contract.js';
import { HttpError } from '../utils/helpers.js';

const caches = new WeakMap();
let coldLoadTail = Promise.resolve();
const DEFAULT_BYTES = 24 * 1024 * 1024, DEFAULT_XML = 160 * 1024 * 1024;
const HMLR = 'use-land-property-data.service.gov.uk', S3 = 'datapub-prd-s3-bucket.s3.amazonaws.com';
async function boundedBytes(response, limit, signal) {
    const length = response.headers?.get?.('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw upstreamError('Parcel archive exceeds byte limit.');
    const reader = response.body?.getReader?.();
    if (!reader) throw upstreamError('Parcel archive returned no readable body.');
    const chunks = [];let total = 0;
    try {
        for (;;) {
            if (signal?.aborted) throw upstreamError('Parcel archive load aborted.');
            const part = await reader.read();if (part.done) break;
            total += part.value.byteLength;if (total > limit) throw upstreamError('Parcel archive exceeds byte limit.');
            chunks.push(part.value);
        }
    } catch (error) { await reader.cancel().catch(()=>{});throw error; }
    finally { reader.releaseLock(); }
    if (length && !response.headers.get('content-encoding') && total !== Number(length)) throw upstreamError('Parcel archive response was incomplete.');
    const bytes = new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}

// The anonymous session is scoped to HMLR only. Presigned S3 URLs and cookies are never logged/cached.
async function officialArchiveFetch(endpoint, { signal } = {}) {
    const original = new URL(endpoint);
    if (original.protocol !== 'https:' || original.hostname !== HMLR || original.username || original.password || original.port
        || !/^\/datasets\/inspire\/download\/[A-Za-z_]+\.zip$/.test(original.pathname) || original.search) throw upstreamError('Unsupported official parcel archive endpoint.');
    const cookies = new Map();
    async function follow(initial) {
        let url = new URL(initial);
        for(let redirects=0;redirects<=6;redirects++) {
            if (url.protocol !== 'https:' || ![HMLR,S3].includes(url.hostname) || url.port || url.username || url.password) throw upstreamError('Parcel archive redirected outside its verified publisher.');
            const response = await globalThis.fetch(url,{signal,redirect:'manual',headers:{
                'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
                Accept:'text/html,application/xml,application/zip,*/*', 'Accept-Language':'en-GB,en;q=0.9',
                ...(url.hostname===HMLR&&cookies.size?{Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; ')}:{})}});
            if(url.hostname===HMLR) for(const item of response.headers.getSetCookie?.()||[]) {
                const pair=item.split(';',1)[0],index=pair.indexOf('=');if(index>0)cookies.set(pair.slice(0,index),pair.slice(index+1));
                if(cookies.size>32||[...cookies.values()].join('').length>16384)throw upstreamError('Parcel archive session exceeds limit.');
            }
            if([301,302,303,307,308].includes(response.status)) {
                const location=response.headers.get('location');await response.body?.cancel();
                if(!location||redirects===6)throw upstreamError('Parcel archive redirect limit exceeded.');
                url=new URL(location,url);continue;
            }
            return response;
        }
        throw upstreamError('Parcel archive redirect limit exceeded.');
    }
    const catalogue=await follow(`https://${HMLR}/datasets/inspire/download`);
    if(!catalogue.ok)throw providerHttpError(catalogue);
    await boundedBytes(catalogue,1024*1024,signal);
    return follow(endpoint);
}

// Inspect central-directory sizes before decompressing; actual output is independently bounded below.
async function* gmlMember(bytes, limit, signal) {
    const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(view.getUint32(i,true)===0x06054b50){end=i;break;}
    if(end<0||view.getUint16(end+4,true)!==0||view.getUint16(end+6,true)!==0)throw upstreamError('Invalid parcel ZIP archive.');
    const entries=view.getUint16(end+10,true),directory=view.getUint32(end+16,true);let offset=directory,match=null,declaredTotal=0;
    if(entries===65535||directory===0xffffffff||entries>20)throw upstreamError('Unsupported parcel ZIP archive.');
    const decoder=new TextDecoder('utf-8',{fatal:true});
    for(let i=0;i<entries;i++) {
        if(offset+46>bytes.length||view.getUint32(offset,true)!==0x02014b50)throw upstreamError('Invalid parcel ZIP directory.');
        const flags=view.getUint16(offset+8,true),size=view.getUint32(offset+24,true),nameLength=view.getUint16(offset+28,true),extra=view.getUint16(offset+30,true),comment=view.getUint16(offset+32,true);
        const name=decoder.decode(bytes.subarray(offset+46,offset+46+nameLength));declaredTotal+=size;
        if(flags&1||size===0xffffffff||declaredTotal>limit||name.includes('..')||name.startsWith('/'))throw upstreamError('Parcel ZIP exceeds limits or has unsafe members.');
        if(name.toLowerCase().endsWith('.gml')){if(match)throw upstreamError('Parcel ZIP has ambiguous GML members.');match={name,size,crc:view.getUint32(offset+16,true)};}
        offset+=46+nameLength+extra+comment;
    }
    if(!match)throw upstreamError('Parcel ZIP has no GML member.');
    let chunks=[];let total=0,finished=false,failure=null,crc=0xffffffff;
    const table=new Uint32Array(256);for(let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=c&1?0xedb88320^(c>>>1):c>>>1;table[i]=c>>>0;}
    const unzip=new Unzip(file=>{
        if(file.name!==match.name)return;
        file.ondata=(error,data,final)=>{
            if(error){failure=upstreamError('Invalid or incomplete parcel ZIP member.');return;}
            total+=data.byteLength;
            if(total>limit||total>match.size){failure=upstreamError('Parcel ZIP decompressed size exceeds limit.');file.terminate();return;}
            for(const byte of data)crc=table[(crc^byte)&255]^(crc>>>8);
            chunks.push(data);if(final)finished=true;
        };
        file.start();
    });unzip.register(UnzipInflate);
    try{
        for(let offset=0;offset<bytes.length;offset+=65536){
            if(signal?.aborted)throw upstreamError('Parcel archive load aborted.');
            unzip.push(bytes.subarray(offset,offset+65536),offset+65536>=bytes.length);
            if(failure)throw failure;
            const ready=chunks;chunks=[];for(const chunk of ready)yield chunk;
            await new Promise(resolve=>setImmediate(resolve));
        }
    }catch(error){if(error.status)throw error;throw upstreamError('Invalid or incomplete parcel ZIP member.');}
    if(!finished||total!==match.size||((crc^0xffffffff)>>>0)!==match.crc)throw upstreamError('Parcel ZIP decompressed size or checksum is inconsistent.');

}

export function createGmlSnapshotParcelSource(descriptor, { fetchImpl = officialArchiveFetch, now = Date.now,
    cacheTtlMs = 5 * 60 * 1000 } = {}) {
    const endpoint=new URL(descriptor.endpoint);
    const {id,idPrefix,idField='INSPIREID'}=descriptor;
    const maxBytes=descriptor.maxSnapshotBytes??DEFAULT_BYTES,maxXml=descriptor.maxDecompressedBytes??DEFAULT_XML;
    const maxSnapshotFeatures=descriptor.maxSnapshotFeatures??150000,maxFeatures=descriptor.maxFeatures??10000;
    if(!id||!idPrefix||!['INSPIREID','nationalCadastralReference'].includes(idField)||endpoint.protocol!=='https:'||endpoint.username||endpoint.password
        ||!Array.isArray(descriptor.outFields)||!descriptor.outFields.includes(idField)||typeof fetchImpl!=='function'||typeof now!=='function'
        ||![maxBytes,maxXml,maxSnapshotFeatures,maxFeatures,cacheTtlMs].every(v=>Number.isSafeInteger(v)&&v>0)
        ||maxBytes>DEFAULT_BYTES||maxXml>DEFAULT_XML||maxSnapshotFeatures>150000||cacheTtlMs>300000)throw new Error('Invalid GML snapshot descriptor.');
    const key=JSON.stringify([id,endpoint.href,idPrefix,idField,maxBytes,maxXml,maxSnapshotFeatures,maxFeatures,descriptor.bbox,descriptor.expectedEtag,descriptor.outFields,descriptor.parcelNumberField,cacheTtlMs]);
    let entries=caches.get(fetchImpl);if(!entries){entries=new Map();caches.set(fetchImpl,entries);}
    let state=entries.get(key);if(!state){state={index:null,expires:0,pending:null};entries.set(key,state);}
    async function load() {
        if(state.index&&now()<state.expires)return state.index;
        if(state.pending)return state.pending;
        state.index=null;state.expires=0;
        const work=async()=>{
            // Bound the number of retained authority snapshots independently of adapter instances.
            const retained=[...entries.values()].filter(entry=>entry!==state&&entry.index);
            while(retained.length>=2){const entry=retained.shift();entry.index=null;entry.expires=0;}
            const signal=AbortSignal.timeout(60000);
            let response;
            try{response=await fetchImpl(endpoint.href,{signal});}catch(error){if(error.status)throw error;if(signal.aborted)throw upstreamError('Parcel archive provider timed out.',504);throw upstreamError('Parcel archive provider is unavailable.');}
            if(!response.ok||response.status!==200)throw providerHttpError(response);
            if(descriptor.expectedEtag!==undefined&&response.headers.get('etag')!==descriptor.expectedEtag)throw upstreamError('Parcel archive revision changed.');
            let compressed=await boundedBytes(response,maxBytes,signal);
            const parsed=await parseGmlParcels(gmlMember(compressed,maxXml,signal),{idField,maxBytes:maxXml,maxFeatures:maxSnapshotFeatures,signal});compressed=null;
            if(!parsed.features.length)throw upstreamError('Parcel authority archive contains no verified polygons.');
            if(parsed.numberMatched!==undefined&&parsed.numberMatched!==parsed.featureCount)throw upstreamError('Parcel archive reports incomplete coverage.');
            const byId=new Map();
            const features=[];
            for(let i=0;i<parsed.features.length;i++) {
                const feature=parsed.features[i];
                if(descriptor.bbox&&(feature.bbox[0]<descriptor.bbox[0]||feature.bbox[1]<descriptor.bbox[1]||feature.bbox[2]>descriptor.bbox[2]||feature.bbox[3]>descriptor.bbox[3]))throw upstreamError('Parcel archive lies outside its advertised extent.');
                const canonical=canonicalParcelFeature(descriptor,feature,feature.properties[idField]);
                byId.set(canonical.id,canonical);features.push({feature:canonical,bbox:feature.bbox});
                parsed.features[i]=null;
            }
            parsed.features.length=0;
            const index={features,byId};state.index=index;state.expires=now()+cacheTtlMs;return index;
        };
        const pending=coldLoadTail.then(work);coldLoadTail=pending.then(()=>undefined,()=>undefined);
        state.pending=pending;
        try{return await pending;}finally{state.pending=null;}
    }
    const collection=features=>({type:'FeatureCollection',features:structuredClone(features),complete:true,sourceId:id,returnsWGS84:true});
    async function queryBounds(bounds){validateBounds(bounds,descriptor.maxBboxKm2??25,descriptor);const index=await load(),shape=bboxPolygon(bounds);
        const features=index.features.filter(row=>row.bbox[0]<=bounds[2]&&row.bbox[2]>=bounds[0]&&row.bbox[1]<=bounds[3]&&row.bbox[3]>=bounds[1]&&booleanIntersects(row.feature,shape)).map(row=>row.feature);
        if(features.length>maxFeatures)throw upstreamError('Parcel snapshot query exceeds the parcel limit; use a smaller area.');return collection(features);}
    async function queryIds(ids){
        if(!Array.isArray(ids)||!ids.length||ids.length>80)throw new HttpError(400,'Provide between 1 and 80 parcel IDs.');
        const unique=[...new Set(ids)];if(unique.some(value=>typeof value!=='string'||!value.startsWith(idPrefix)||value.slice(idPrefix.length).length>256||!(idField==='INSPIREID'?/^[0-9]+$/:/^[A-Za-z0-9._/-]+$/).test(value.slice(idPrefix.length))))throw new HttpError(400,'Invalid parcel ID or different source.');
        const index=await load();return{...collection(unique.filter(key=>index.byId.has(key)).map(key=>index.byId.get(key))),absentIds:unique.filter(key=>!index.byId.has(key))};}
    async function queryGeometry(geometry){if(!validateGeometry(geometry))throw new HttpError(400,'Provide valid polygon geometry.');
        const result=await queryBounds(geometryBbox(geometry));return{...result,features:result.features.filter(f=>booleanIntersects(f,geoFeature(geometry)))};}
    return Object.freeze({queryBounds,queryIds,queryGeometry});
}
