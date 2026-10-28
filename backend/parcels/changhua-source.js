// Changhua County viewer: bounded parcel-key queries and fresh composite-key WKT reads.
import proj4 from 'proj4';
import { bbox, booleanIntersects, booleanPointInPolygon, feature, point } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { concatBytes } from './byte-utils.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';
import { parseKeralaWktPolygon } from './kerala-wkt.js';

export const CHANGHUA_ENDPOINT = 'https://urbangis.chcg.gov.tw/map/ajax/SelHandler.ashx';
export const CHANGHUA_SOURCE = 'tw-changhua-urbangis-cadastral-selhandler';
export const CHANGHUA_PREFIX = 'TW-CHANGHUA-URBANGIS-SECT-';
export const CHANGHUA_PROJECTION = '+proj=tmerc +lat_0=0 +lon_0=121 +k=0.9999 +x_0=250000 +y_0=0 +ellps=GRS80 +units=m +no_defs';
const KEY = /^(\d{4})-LANDNO8-(\d{8})$/;
const MAX_BYTES = 2 * 1024 * 1024;

// This handler also has viewer mutation operations; only permit the three parcel reads.
export function validateChanghuaForm(body) {
    const form = new URLSearchParams(body), key = form.get('key');
    const fields = key === 'getsectdata' ? ['key','timeStamp','timeName','TownName','Sect','LandNo']
        : key === 'getpoint' ? ['key','timeStamp','timeName','buff','geom']
        : key === 'getpolygon' ? ['key','timeStamp','timeName','geom'] : [];
    const bad = () => { throw new HttpError(400, 'Invalid Changhua read operation.'); };
    if (!fields.length || [...form.keys()].some(name => !fields.includes(name) || form.getAll(name).length !== 1)
        || form.get('timeStamp') !== '--' || form.get('timeName') !== '--') bad();
    if (key === 'getsectdata') {
        if (form.get('TownName') !== '彰化市' || !/^\d{4}$/.test(form.get('Sect') || '')
            || !/^\d{1,4}(?:-\d{1,4})?$/.test(form.get('LandNo') || '')) bad();
    } else {
        const pairs = (form.get('geom') || '').split(',').map(pair => pair.split(' '));
        if (pairs.length !== (key === 'getpoint' ? 1 : 5) || pairs.some(pair => pair.length !== 2
            || pair.some(value => !/^\d+(?:\.\d+)?$/.test(value)))) bad();
        const coords = pairs.map(pair => pair.map(Number));
        if (coords.some(([x,y]) => x < 150000 || x > 350000 || y < 2600000 || y > 2750000)
            || Math.max(...coords.map(p => p[0])) - Math.min(...coords.map(p => p[0])) > 1000
            || Math.max(...coords.map(p => p[1])) - Math.min(...coords.map(p => p[1])) > 1000
            || key === 'getpoint' && form.get('buff') !== '0') bad();
    }
    return form;
}

export function parseChanghuaBatch(body) {
    const form = new URLSearchParams(body);
    if (!form.has('_parcelIds')) return null;
    if ([...form.keys()].length !== 1) throw new HttpError(400, 'Invalid Changhua native batch.');
    let ids;
    try { ids = JSON.parse(form.get('_parcelIds')); } catch { throw new HttpError(400, 'Invalid Changhua native batch.'); }
    if (!Array.isArray(ids) || !ids.length || ids.length > 80 || new Set(ids).size !== ids.length
        || ids.some(id => typeof id !== 'string' || !id.startsWith(CHANGHUA_PREFIX) || !KEY.test(id.slice(CHANGHUA_PREFIX.length)))) throw new HttpError(400, 'Invalid Changhua native batch IDs.');
    return ids;
}

export function createChanghuaBrowserParcelSource(descriptor, options = {}) {
    return createChanghuaParcelSource(descriptor, {...options,batchExactReads:true});
}

export function createChanghuaParcelSource(descriptor, { fetchImpl = globalThis.fetch, onResponseMetadata = () => {}, batchExactReads = false } = {}) {
    if (descriptor.id !== CHANGHUA_SOURCE || descriptor.adapter !== 'changhua-urbangis'
        || descriptor.endpoint !== CHANGHUA_ENDPOINT || descriptor.idPrefix !== CHANGHUA_PREFIX
        || descriptor.sourceCrs !== 'EPSG:3826' || descriptor.townName !== '彰化市'
        || JSON.stringify(descriptor.outFields) !== JSON.stringify(['SECT','LANDNO8'])
        || typeof fetchImpl !== 'function') throw new Error('Invalid Changhua parcel descriptor.');
    const projection = proj4(CHANGHUA_PROJECTION, 'EPSG:4326');
    const maxFeatures = descriptor.maxFeatures ?? 250;
    if (!Number.isSafeInteger(maxFeatures) || maxFeatures < 1 || maxFeatures > 500) throw new Error('Invalid Changhua feature limit.');
    const cache = new Map(), nativeRows = new WeakMap();
    let active = 0, downloadedBytes = 0;
    const waiting = [];
    async function post(values, options = {}) {
        const batch = Object.hasOwn(values, '_parcelIds');
        const body = new URLSearchParams(batch ? values : { timeStamp:'--', timeName:'--', ...values }).toString();
        if (batch) parseChanghuaBatch(body); else validateChanghuaForm(body);
        if (active >= 4) await new Promise(resolve => waiting.push(resolve)); else active++;
        try {
            const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000);
            const response = await fetchImpl(CHANGHUA_ENDPOINT, { method:'POST', redirect:'error', cache:'no-store', signal,
                headers:{ Accept:'application/json', 'Content-Type':'application/x-www-form-urlencoded' }, body });
            if (!response.ok) throw providerHttpError(response);
            if (Number(response.headers.get('content-length')) > MAX_BYTES || !response.body?.getReader) throw upstreamError('Changhua response exceeds the byte cap or has no stream.');
            const reader = response.body.getReader(), chunks = [];
            let size = 0, payload;
            try {
                for (;;) {
                    const {done,value} = await reader.read();
                    if (done) break;
                    size += value.byteLength;
                    downloadedBytes += value.byteLength;
                    if (downloadedBytes > 64 * 1024 * 1024) throw upstreamError('Changhua adapter download budget exceeded.');
                    if (size > MAX_BYTES) throw upstreamError('Changhua streamed response exceeds the byte cap.');
                    chunks.push(value);
                }
                onResponseMetadata({operation:values.key, httpStatus:response.status, streamedBytes:size});
                payload = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(concatBytes(chunks,size)).replace(/^\uFEFF/, ''));
            } catch (error) { await reader.cancel().catch(() => {}); throw error; }
            finally { reader.releaseLock(); }
            if (batch) {
                if (payload?.type !== 'ChanghuaNativeBatch' || payload.sourceId !== descriptor.id || !Array.isArray(payload.results)) throw upstreamError('Invalid Changhua native batch response.');
                return payload;
            }
            if (payload?.MSGCODE !== 200 || !Array.isArray(payload.DATA) || payload.DATA.length >= maxFeatures) throw upstreamError('Changhua parcel response failed or reached the feature cap; request smaller bounds.');
            return payload.DATA;
        } finally { const next = waiting.shift(); if (next) next(); else active--; }
    }
    function nativeKey(row) {
        if (typeof row.SECT !== 'string' || !/^\d{4}$/.test(row.SECT)
            || typeof row.LANDNO8 !== 'string' || !/^\d{8}$/.test(row.LANDNO8)) throw upstreamError('Changhua returned a malformed composite parcel key.');
        return row.SECT + '-LANDNO8-' + row.LANDNO8;
    }
    function idParts(id) {
        const match = typeof id === 'string' && id.startsWith(CHANGHUA_PREFIX) && KEY.exec(id.slice(CHANGHUA_PREFIX.length));
        if (!match) throw new HttpError(400, 'Expected a Changhua composite parcel ID.');
        return { section:match[1], land:match[2] };
    }
    function convert(row) {
        const native = parseKeralaWktPolygon(row.WKT);
        const walk = values => typeof values[0] === 'number' ? projection.forward(values) : values.map(walk);
        const geometry = { type:native.type, coordinates:walk(native.coordinates) };
        if (!validateGeometry(geometry)) throw upstreamError('Changhua returned unusable polygon rings; no repair applied.');
        return canonicalParcelFeature(descriptor, { geometry, properties:{SECT:row.SECT,LANDNO8:row.LANDNO8} }, nativeKey(row));
    }
    const result = (features, extra = {}) => ({ type:'FeatureCollection', features, sourceId:descriptor.id,
        returnsWGS84:true, complete:true, areaComplete:false, authoritativeAbsence:false, absentIds:[], ...extra });
    async function exact(id, options) {
        const {section,land} = idParts(id);
        const suffix = Number(land.slice(4));
        const rows = await post({key:'getsectdata',TownName:descriptor.townName,Sect:section,
            LandNo:String(Number(land.slice(0,4))) + (suffix ? '-' + suffix : '')}, options);
        let found;
        for (const row of rows) {
            if (row.TNAME !== descriptor.townName || CHANGHUA_PREFIX + nativeKey(row) !== id) throw upstreamError('Changhua exact response disagrees with the requested town or composite key.');
            const current = convert(row);
            if (found && JSON.stringify(found.geometry) !== JSON.stringify(current.geometry)) throw upstreamError('Changhua returned conflicting geometries for one composite key.');
            found = current;
            nativeRows.set(found,{SECT:row.SECT,LANDNO8:row.LANDNO8,WKT:row.WKT});
        }
        if (found) {
            cache.delete(id); cache.set(id,{feature:found,at:Date.now()});
            while (cache.size > 1500) cache.delete(cache.keys().next().value);
        }
        return found;
    }
    async function mapLimited(ids, read) {
        let cursor = 0, failure;
        const output = new Array(ids.length);
        await Promise.all(Array.from({length:Math.min(4,ids.length)},async () => {
            while (!failure) {
                const index = cursor++;
                if (index >= ids.length) break;
                try { output[index] = await read(ids[index]); } catch (error) { failure = error; }
            }
        }));
        if (failure) throw failure;
        return output;
    }
    async function exactMany(ids, options) {
        if (!batchExactReads) return mapLimited(ids,id => exact(id,options));
        const output = [];
        for (let at = 0; at < ids.length; at += 80) {
            const batch = ids.slice(at,at+80);
            const payload = await post({_parcelIds:JSON.stringify(batch)},options);
            if (payload.results.length !== batch.length || payload.results.some((row,i) => row?.id !== batch[i])) throw upstreamError('Changhua batch IDs disagree with the request.');
            for (const item of payload.results) {
                if (item.row === null) { output.push(undefined); continue; }
                const row = item.row;
                if (CHANGHUA_PREFIX + nativeKey(row) !== item.id || Object.keys(row).some(key => !['SECT','LANDNO8','WKT'].includes(key))) throw upstreamError('Invalid Changhua native batch row.');
                const current = convert(row);
                cache.delete(item.id); cache.set(item.id,{feature:current,at:Date.now()});
                while (cache.size > 1500) cache.delete(cache.keys().next().value);
                output.push(current);
            }
        }
        return output;
    }
    async function queryNativeIds(ids, options = {}) {
        const read = await queryIds(ids,options);
        const found = new Map(read.features.map(row => [row.id,nativeRows.get(row)]));
        return {type:'ChanghuaNativeBatch',sourceId:descriptor.id,results:ids.map(id => ({id,row:found.get(id) || null}))};
    }
    async function queryIds(ids, options = {}) {
        if (!Array.isArray(ids) || ids.length > 80 || new Set(ids).size !== ids.length) throw new HttpError(400,'Expected at most 80 unique parcel IDs.');
        ids.forEach(idParts);
        // Always fresh, including on a previously used adapter instance.
        const rows = await exactMany(ids,options);
        return result(rows.filter(Boolean), { complete:rows.every(Boolean), unresolvedIds:ids.filter((_,i) => !rows[i]) });
    }
    async function fromKeys(rows, options) {
        const ids = [...new Set(rows.filter(row => row.TNAME === descriptor.townName).map(row => CHANGHUA_PREFIX + nativeKey(row)))];
        const found = new Map();
        for (const id of ids) {
            const known = cache.get(id);
            if (known && Date.now() - known.at < 30000) found.set(id,known.feature);
        }
        const missing = ids.filter(id => !found.has(id));
        const fresh = await exactMany(missing,options);
        missing.forEach((id,index) => found.set(id,fresh[index]));
        const features = ids.map(id => found.get(id));
        if (features.some(row => !row)) throw upstreamError('Changhua spatial keys could not all be resolved to polygons.');
        return result(features);
    }
    async function queryPoint(coordinates, options = {}) {
        if (!Array.isArray(coordinates) || coordinates.length !== 2 || !coordinates.every(Number.isFinite)) throw new HttpError(400,'Expected a WGS84 point.');
        const native = projection.inverse(coordinates);
        const rows = await post({key:'getpoint',buff:'0',geom:native.map(n => n.toFixed(4)).join(' ')},options);
        const read = await fromKeys(rows,options);
        return { ...read, queryType:'point', features:read.features.filter(row => booleanPointInPolygon(point(coordinates),row)) };
    }
    async function queryBounds(bounds, options = {}) {
        validateBounds(bounds, descriptor.maxBboxKm2 ?? 0.25, {maxBboxWidthM:900,maxBboxHeightM:900});
        const [w,s,e,n] = bounds;
        const geom = [[w,s],[e,s],[e,n],[w,n],[w,s]].map(p => projection.inverse(p).map(n => n.toFixed(4)).join(' ')).join(',');
        const rows = await post({key:'getpolygon',geom},options);
        const read = await fromKeys(rows,options);
        const polygon = feature({type:'Polygon',coordinates:[[[w,s],[e,s],[e,n],[w,n],[w,s]]]});
        return { ...read, queryType:'bounds', features:read.features.filter(row => booleanIntersects(row,polygon)),
            completenessReason:'All returned bounded spatial keys resolved; provider transfer limits and citywide coverage are unverified.' };
    }
    async function queryGeometry(geometry, options = {}) {
        if (!validateGeometry(geometry)) throw new HttpError(400,'Expected a WGS84 polygon.');
        const read = await queryBounds(bbox(feature(geometry)),options);
        return { ...read, features:read.features.filter(row => booleanIntersects(row,feature(geometry))) };
    }
    return {queryIds,queryBounds,queryPoint,queryGeometry,queryNativeIds};
}
