// Bauru's public GeoPixel cadastral geometry, using the viewer's anonymous profile.
// Session cookies stay in transport memory; only native gid and unchanged polygons leave it.
import { concatBytes } from './byte-utils.js';
import { parseUldkPolygonWkt } from './pl-uldk-point-source.js';
import { bbox, bboxPolygon, booleanIntersects, booleanPointInPolygon, feature as turfFeature, point as turfPoint } from '@turf/turf';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateGeometry, validateBounds } from './source-contract.js';

export const GEOPIXEL_SOURCE = 'br-bauru-geopixel-base-lotes-2024';
const ROOT = 'https://bauru.geopixel.com.br/geopixelcidades-bauru_server/rest/json/';
export const GEOPIXEL_ENDPOINT = `${ROOT}getPointedGeometry?themeid=3353&x=-49.074484645653&y=-22.3181273663533&buffer=0.0005`;
const PREFIX = 'BR-BAURU-GPX-GID-';
const ID = /^[1-9][0-9]{0,11}$/;
const MAX_BYTES = 2 * 1024 * 1024;
const invalid = (phase = 'response') => upstreamError(`GeoPixel response failed validation (${phase}).`);
const inputError = () => Object.assign(new Error('Invalid GeoPixel parcel query.'), { status: 400, code: 'invalid-parcel-query' });
const validPoint = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
const validIds = ids => Array.isArray(ids) && ids.length <= 80 && ids.every(id => typeof id === 'string' && id.startsWith(PREFIX) && ID.test(id.slice(PREFIX.length)));

export function isGeopixelSource(d) {
    return d?.id === GEOPIXEL_SOURCE && d.adapter === 'geopixel' && d.endpoint === GEOPIXEL_ENDPOINT;
}

async function readText(response, checkStatus = true) {
    if (checkStatus && !response.ok) throw providerHttpError(response);
    const reader = response.body?.getReader();
    if (!reader) throw invalid();
    let size = 0;
    const chunks = [];
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BYTES) { await reader.cancel(); throw invalid(); }
            chunks.push(value);
        }
    } finally { reader.releaseLock(); }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(concatBytes(chunks, size)); }
    catch { throw invalid(); }
}

export function createGeopixelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    if (!isGeopixelSource(descriptor) || descriptor.idField !== 'gid' || descriptor.idPrefix !== PREFIX
        || descriptor.outFields?.length !== 1 || descriptor.outFields[0] !== 'gid') throw new Error('Invalid GeoPixel parcel descriptor.');
    const cookies = new Map();
    let session;
    const result = (features, queryType, extra = {}) => ({ type: 'FeatureCollection', sourceId: GEOPIXEL_SOURCE,
        returnsWGS84: true, sourceSrid: 'EPSG:4326', complete: true, queryType, features, ...extra });
    async function request(route, params, signal, form, multipart, renewed = false) {
        const url = new URL(route, ROOT);
        if (params) url.search = new URLSearchParams(params).toString();
        const headers = new Headers({ Accept: 'application/json, text/plain' });
        if (cookies.size) headers.set('Cookie', [...cookies].map(([k, v]) => `${k}=${v}`).join('; '));
        if (form) headers.set('Content-Type', 'application/x-www-form-urlencoded');
        if (multipart) headers.set('Content-Type', 'multipart/form-data; boundary=parcel-geopixel-boundary');
        const timeout = AbortSignal.timeout(25000);
        const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        let response;
        try {
            response = await fetchImpl(url.href, { method: form || multipart ? 'POST' : 'GET', headers,
                ...(multipart ? { body: multipart } : form ? { body: new URLSearchParams(form).toString() } : {}), credentials: 'omit', redirect: 'error',
                signal: requestSignal });
        } catch (error) {
            if (signal?.aborted) throw signal.reason;
            if (timeout.aborted) throw upstreamError(`GeoPixel request timed out (${route}).`, 504);
            throw error;
        }
        if (response.status === 401 && !renewed && ['getGeometry', 'getPointedGeometry', 'getDataByGeom'].includes(route)) {
            await response.body?.cancel();
            session = undefined; cookies.clear();
            await ensureSession(signal);
            return request(route, params, signal, form, multipart, true);
        }
        // The trusted relay transport exposes upstream cookies through an internal header.
        // It strips that header before returning bytes to a browser.
        const internal = response.headers.get('x-parcel-upstream-cookies');
        const setCookies = internal ? JSON.parse(internal) : response.headers.getSetCookie?.() || [];
        for (const cookie of setCookies) {
            const pair = /^([A-Za-z0-9_-]+)=([^;\r\n]*)/.exec(cookie);
            if (pair && pair[1] === 'JSESSIONID' && pair[2].length <= 256) cookies.set(pair[1], pair[2]);
        }
        return readText(response);
    }
    const json = text => { try { return JSON.parse(text); } catch { throw invalid(); } };
    async function ensureSession(signal) {
        session ||= (async () => {
            // Same empty-credential anonymous action as the public viewer button.
            const access = json(await request('checkAccess', null, signal, { login: '', pass: '', isAnonymous: 'true' }));
            if (!access?.chave || !cookies.size || !Number.isSafeInteger(access.appUsuario?.usrId)
                || typeof access.nome !== 'string' || typeof access.login !== 'string') throw invalid('anonymous-session');
            // Match Login.setSession before asking for profiles. checkAccess alone
            // does not finish establishing the viewer's per-session access context.
            await request('../../ActionServlet', null, signal, { key: access.chave, name: access.nome,
                usr_id: String(access.appUsuario.usrId), login: access.login });
            const profiles = json(await request('profilesByKey', null, signal));
            if (!Array.isArray(profiles) || !profiles.some(p => p.prfId === 2 && p.perfil === 'Público')) throw invalid('public-profile');
            const selected = json(await request('setProfile', null, signal, { profile_id: '2' }));
            if (selected?.result !== true && !(Array.isArray(selected?.result) && selected.result[0] === true)) throw invalid('profile-selection');
            await request('../../ActionServlet', null, signal, { profile_id: '2' });
        })().catch(error => { session = undefined; cookies.clear(); throw error; });
        await session;
    }
    function feature(gid, wkt) {
        if (typeof gid !== 'string' || !ID.test(gid) || typeof wkt !== 'string') throw invalid('native-geometry-fields');
        const geometry = parseUldkPolygonWkt(wkt.trim());
        if (!validateGeometry(geometry)) throw invalid('geographic-polygon');
        return canonicalParcelFeature(descriptor, { type: 'Feature', geometry, properties: { gid } }, gid);
    }
    async function queryIds(ids, { signal } = {}) {
        if (!validIds(ids)) throw inputError();
        await ensureSession(signal);
        const features = [];
        const unique = [...new Set(ids)];
        // Viewport cells can contain dozens of lots. Bound exact-read fan-out so a
        // single cell does not hold later browser reads behind every lot's RTT.
        for (let offset = 0; offset < unique.length; offset += 4) {
            signal?.throwIfAborted();
            const batch = await Promise.allSettled(unique.slice(offset, offset + 4).map(async id => {
                const gid = id.slice(PREFIX.length);
                const wkt = await request('getGeometry', { themeid: '3353', target: gid, access: 'true', key: 'true' }, signal);
                // Exact route returns only WKT for the requested native key. Unknown replies
                // remain errors; no unverified service message becomes durable absence.
                return feature(gid, wkt);
            }));
            // Drain the batch before releasing the source operation on failure;
            // otherwise its remaining requests overlap the next queued operation.
            const failed = batch.find(read => read.status === 'rejected');
            if (failed) throw failed.reason;
            features.push(...batch.map(read => read.value));
        }
        return result(features, 'ids', { absentIds: [] });
    }
    async function queryPoint(point, { signal } = {}) {
        if (!validPoint(point)) throw inputError();
        await ensureSession(signal);
        const rows = json(await request('getPointedGeometry', { themeid: '3353', x: String(point[0]), y: String(point[1]), buffer: '0' }, signal));
        if (!Array.isArray(rows) || rows.length > 1 || rows.some(row => row.key_name !== 'gid')) throw invalid();
        const features = rows.map(row => feature(row.gid, row.st_astext));
        if (features.some(f => !booleanPointInPolygon(turfPoint(point), f))) throw invalid();
        return result(features, 'point');
    }
    async function queryBounds(bounds, { signal } = {}) {
        validateBounds(bounds, 0.25);
        if (Math.abs(bounds[1]) > 85 || Math.abs(bounds[3]) > 85) throw inputError();
        await ensureSession(signal);
        // The first-party searchThemeByGeom sends map geometry (Web Mercator),
        // with an explicit requested-column list. Only gid is requested here.
        const mercator = ([x, y]) => [x * 20037508.342789244 / 180,
            Math.log(Math.tan((90 + y) * Math.PI / 360)) * 20037508.342789244 / Math.PI];
        const [w, s, e, n] = bounds;
        const ring = [[w,s],[e,s],[e,n],[w,n],[w,s]].map(mercator);
        const wkt = `POLYGON((${ring.map(p => p.join(' ')).join(',')}))`;
        const fields = { tma_id: '3353', attrEntrada: 'gid', buffer: '0', radius: '0' };
        let body = Object.entries(fields).map(([name, value]) => `--parcel-geopixel-boundary\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join('');
        body += `--parcel-geopixel-boundary\r\nContent-Disposition: form-data; name="geom"; filename="geom.txt"\r\nContent-Type: text/plain\r\n\r\n${wkt}\r\n--parcel-geopixel-boundary--\r\n`;
        const rows = json(await request('getDataByGeom', null, signal, null, body));
        // Fail closed on a possibly saturated selection. Never claim a sampled point
        // or a truncated ID list completed an area query.
        if (!Array.isArray(rows)) throw invalid('spatial-selection-shape');
        if (rows.length >= 80) throw invalid('spatial-selection-saturated');
        if (rows.some(row => !ID.test(String(row?.gid))
            || Object.keys(row).some(key => key !== 'gid'))) throw invalid('spatial-selection-fields');
        const ids = rows.map(row => PREFIX + row.gid);
        if (new Set(ids).size !== ids.length) throw invalid('spatial-selection-duplicates');
        const read = await queryIds(ids, { signal });
        if (read.features.some(f => !booleanIntersects(f, bboxPolygon(bounds)))) throw invalid('spatial-selection-membership');
        return result(read.features, 'bounds');
    }
    async function queryGeometry(geometry, options) {
        if (!validateGeometry(geometry)) throw inputError();
        const read = await queryBounds(bbox(turfFeature(geometry)), options);
        return result(read.features.filter(f => booleanIntersects(f, turfFeature(geometry))), 'geometry');
    }
    return Object.freeze({ queryIds, queryPoint, queryBounds, queryGeometry });
}

export function parseGeopixelOperation(body) {
    let data;
    try { data = JSON.parse(body); } catch { throw inputError(); }
    if (!data || Object.keys(data).length !== 2 || !Object.hasOwn(data, 'input')
        || !['queryIds', 'queryBounds', 'queryGeometry', 'queryPoint'].includes(data._geopixelOperation)) throw inputError();
    if (data._geopixelOperation === 'queryIds' && !validIds(data.input)) throw inputError();
    if (data._geopixelOperation === 'queryPoint' && !validPoint(data.input)) throw inputError();
    if (data._geopixelOperation === 'queryBounds') validateBounds(data.input, 0.25);
    if (data._geopixelOperation === 'queryGeometry' && !validateGeometry(data.input)) throw inputError();
    return data;
}

export function createGeopixelBrowserSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    if (descriptor.browserTransport !== 'relay') throw new Error('GeoPixel browser source requires the fixed-source relay.');
    createGeopixelSource(descriptor, { fetchImpl });
    const operation = method => async (input, { signal } = {}) => {
        const body = JSON.stringify({ _geopixelOperation: method, input });
        parseGeopixelOperation(body);
        const response = await fetchImpl(GEOPIXEL_ENDPOINT, { method: 'POST', body, credentials: 'omit', redirect: 'error',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, signal });
        const text = await readText(response, false);
        let data;
        try { data = JSON.parse(text); } catch { throw invalid('relay-json'); }
        if (!response.ok) {
            // Relay errors contain no upstream body. Preserve only this adapter's fixed,
            // geometry-free validation phase; never mask HTTP denial as malformed JSON.
            if (data?.code === 'parcel-source-unavailable' && /^GeoPixel response failed validation \([a-z-]+\)\.$/.test(data.error)) {
                throw upstreamError(data.error, response.status);
            }
            throw providerHttpError(response);
        }
        if (data?.sourceId !== GEOPIXEL_SOURCE || data.type !== 'FeatureCollection' || data.complete !== true
            || !Array.isArray(data.features) || data.features.some(f => !validateGeometry(f.geometry)
                || !ID.test(f.properties?.sourceParcelId) || f.id !== PREFIX + f.properties.sourceParcelId)) throw invalid('relay-envelope');
        return data;
    };
    return Object.freeze(Object.fromEntries(['queryIds', 'queryPoint', 'queryBounds', 'queryGeometry'].map(method => [method, operation(method)])));
}
