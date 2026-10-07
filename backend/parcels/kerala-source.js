// Public Kerala Ente Bhoomi adapter. The viewer issues a short-lived auth key to
// its normal map session; it stays only in this process's memory.
import { load } from 'cheerio';
import { bbox as geometryBbox, bboxPolygon, booleanIntersects, feature as geoFeature } from '@turf/turf';
import proj4 from 'proj4';
import { HttpError } from '../utils/helpers.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

const APP_ORIGIN = 'https://entebhoomi.kerala.gov.in';
const MAP_ORIGIN = 'https://bhunaksha.entebhoomi.kerala.gov.in';
const MAP_PATH = '/bhunaksha_v5_emaps/core/v2/map/export/';
const LOCATION_CODE = '010309';
const DISTRICT_GID = 'dfd75e07-cae4-45e8-875b-6292909b8089';
const TALUK_GID = '56d4cd54-4ad1-469a-bdbf-202951b95c39';
const VILLAGE_GID = 'ce6185fb-b497-4803-a49d-4a0a8925aef8';
const NATIVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toMetric = proj4('EPSG:4326', 'EPSG:32643');
const toWgs84 = proj4('EPSG:32643', 'EPSG:4326');
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const MAX_BYTES = 2 * 1024 * 1024;

export function parseKeralaWktPolygon(wkt) {
    if (typeof wkt !== 'string' || wkt.length > 1000000) throw upstreamError('Kerala parcel geometry is missing or too large.');
    const typeMatch = /^\s*(POLYGON|MULTIPOLYGON)(?:\s+(?:Z|M|ZM))?\s*/i.exec(wkt);
    if (!typeMatch) throw upstreamError('Kerala returned an unsupported parcel geometry.');
    const type = typeMatch[1].toUpperCase() === 'MULTIPOLYGON' ? 'MultiPolygon' : 'Polygon';
    const groupDepth = type === 'Polygon' ? 2 : 3;
    const text = wkt.slice(typeMatch[0].length);
    let at = 0;
    const numberPattern = /^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?/;
    function group(depth = 0) {
        if (depth >= groupDepth) throw upstreamError('Kerala returned excessively nested parcel geometry.');
        while (/\s/.test(text[at] || '')) at++;
        if (text[at++] !== '(') throw upstreamError('Kerala returned malformed parcel geometry.');
        const values = [];
        for (;;) {
            while (/\s/.test(text[at] || '')) at++;
            if (text[at] === '(') {
                if (depth === groupDepth - 1) throw upstreamError('Kerala returned excessively nested parcel geometry.');
                values.push(group(depth + 1));
            }
            else {
                if (depth !== groupDepth - 1) throw upstreamError('Kerala returned malformed parcel geometry nesting.');
                const point = [];
                for (;;) {
                    while (/\s/.test(text[at] || '')) at++;
                    const match = numberPattern.exec(text.slice(at));
                    if (!match) break;
                    point.push(Number(match[0])); at += match[0].length;
                }
                if (point.length < 2 || point.some(value => !Number.isFinite(value))) throw upstreamError('Kerala returned malformed parcel coordinates.');
                values.push(point.slice(0, 2));
            }
            while (/\s/.test(text[at] || '')) at++;
            if (text[at] === ',') { at++; continue; }
            if (text[at] === ')') { at++; break; }
            throw upstreamError('Kerala returned malformed parcel geometry.');
        }
        return values;
    }
    const coordinates = group();
    while (/\s/.test(text[at] || '')) at++;
    if (at !== text.length) throw upstreamError('Kerala returned malformed parcel geometry.');
    return { type, coordinates };
}

function projectCoordinates(coordinates, transform, depth, coordinateDepth) {
    if (!Array.isArray(coordinates) || !coordinates.length) throw upstreamError('Kerala returned malformed parcel coordinates.');
    if (depth === coordinateDepth) {
        if (coordinates.length < 2 || !coordinates.every(Number.isFinite)) throw upstreamError('Kerala returned malformed parcel coordinates.');
        const result = transform.forward(coordinates.slice(0, 2));
        if (result.some(value => !Number.isFinite(value))) throw upstreamError('Kerala parcel coordinates could not be projected.');
        return result.map(value => Math.round(value * 1e8) / 1e8);
    }
    return coordinates.map(value => projectCoordinates(value, transform, depth + 1, coordinateDepth));
}

function projectGeometry(geometry, transform) {
    if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) throw upstreamError('Kerala returned an unsupported parcel geometry.');
    const coordinateDepth = geometry.type === 'Polygon' ? 2 : 3;
    const projected = { type: geometry.type, coordinates: projectCoordinates(geometry.coordinates, transform, 0, coordinateDepth) };
    if (!validateGeometry(projected)) throw upstreamError('Kerala returned invalid parcel geometry.');
    return projected;
}

export function createKeralaParcelSource(descriptor, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    const { id, idPrefix, outFields = ['parcel_gid', 'survey_no', 'block_no'], parcelNumberField = 'survey_no' } = descriptor;
    const maxBboxKm2 = descriptor.maxBboxKm2 ?? 0.001;
    const maxFeatures = descriptor.maxFeatures ?? 1000;
    const maxResponseBytes = descriptor.maxResponseBytes ?? MAX_BYTES;
    if (typeof id !== 'string' || !id || descriptor.endpoint !== `${APP_ORIGIN}/web/ilms/map` || idPrefix !== 'IN-KL-ENTEBHOOMI-010309-'
        || !Array.isArray(outFields) || outFields.length !== 3 || !['parcel_gid', 'survey_no', 'block_no'].every(field => outFields.includes(field))
        || !outFields.includes(parcelNumberField) || !Number.isFinite(maxBboxKm2) || maxBboxKm2 > 1 || maxBboxKm2 <= 0
        || !Number.isSafeInteger(maxFeatures) || maxFeatures < 1 || maxFeatures > 5000
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > MAX_BYTES) {
        throw new Error('Invalid Kerala Ente Bhoomi parcel source descriptor.');
    }

    let sessionPromise = null;
    const recent = new Map();
    const result = (features, extra = {}) => ({ type: 'FeatureCollection', features,
        complete: true, sourceId: id, returnsWGS84: true, ...extra });
    function remember(feature) {
        recent.delete(feature.id);
        recent.set(feature.id, { feature: structuredClone(feature), expires: now() + 60000 });
        while (recent.size > 10000) recent.delete(recent.keys().next().value);
    }

    function cookieHeader(response) {
        const values = typeof response.headers?.getSetCookie === 'function' ? response.headers.getSetCookie()
            : [response.headers?.get?.('set-cookie')].filter(Boolean);
        return values.map(value => value.split(';', 1)[0]).filter(Boolean).join('; ');
    }

    async function readBytes(response, limit) {
        const declared = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(declared) && declared > limit) throw upstreamError('Kerala parcel response exceeds the byte limit; use a smaller area.');
        if (!response.body?.getReader) throw upstreamError('Kerala returned no readable response.');
        let reader;
        try { reader = response.body.getReader(); }
        catch (error) { throw streamReadError(error); }
        const chunks = [];
        let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > limit) throw upstreamError('Kerala parcel response exceeds the byte limit; use a smaller area.');
                chunks.push(Buffer.from(value));
            }
        } catch (error) {
            try { await reader.cancel(); } catch { /* The stream may have closed already. */ }
            throw streamReadError(error);
        } finally { reader.releaseLock(); }
        if (Number.isFinite(declared) && declared > 0 && !response.headers?.get?.('content-encoding') && declared !== size) {
            throw upstreamError('Kerala parcel response body was incomplete.');
        }
        return Buffer.concat(chunks, size);
    }

    function streamReadError(error) {
        if (error?.code) return error;
        if (['AbortError', 'TimeoutError'].includes(error?.name)) return upstreamError('Kerala parcel provider timed out.', 504);
        return upstreamError('Kerala parcel provider response was interrupted.');
    }

    async function fetchResponse(url, options, timeoutMs = 15000) {
        const signal = AbortSignal.timeout(timeoutMs);
        try { return await fetchImpl(url, { ...options, redirect: 'error', signal }); }
        catch (error) {
            if (error.status) throw error;
            if (signal.aborted || ['AbortError', 'TimeoutError'].includes(error.name)) throw upstreamError('Kerala parcel provider timed out.', 504);
            throw Object.assign(upstreamError('Kerala parcel provider is unavailable.'), { cause: error });
        }
    }

    async function checkedResponse(url, options, limit = maxResponseBytes) {
        const response = await fetchResponse(url, options);
        if (!response.ok) throw providerHttpError(response);
        const bytes = await readBytes(response, limit);
        return { response, bytes };
    }

    async function bootstrap() {
        const page = await checkedResponse(`${APP_ORIGIN}/web/ilms/map`, { headers: { 'User-Agent': USER_AGENT,
            Accept: 'text/html', 'Accept-Language': 'en-IN,en;q=0.9,ml;q=0.8' } }, 2 * 1024 * 1024);
        const $ = load(page.bytes.toString('utf8'));
        const csrfHeader = $('meta[name="_csrf_header"]').attr('content');
        const csrf = $('meta[name="_csrf"]').attr('content');
        if (!csrfHeader || !/^[A-Za-z0-9-]{1,80}$/.test(csrfHeader) || !csrf) throw upstreamError('Kerala map session could not be initialized.');
        const cookie = cookieHeader(page.response);
        const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json,text/html,*/*',
            'Accept-Language': 'en-IN,en;q=0.9,ml;q=0.8', Referer: `${APP_ORIGIN}/web/ilms/map`,
            [csrfHeader]: csrf, ...(cookie ? { Cookie: cookie } : {}) };

        const districtOptions = $('select#districtGid option').map((_, element) => $(element).attr('value')).get();
        if (!districtOptions.includes(DISTRICT_GID)) throw upstreamError('Kerala district selector no longer contains Manikkal.');
        const getJson = async (path, params = {}) => {
            const url = new URL(path, APP_ORIGIN); url.search = new URLSearchParams(params);
            const fetched = await checkedResponse(url.href, { headers }, 2 * 1024 * 1024);
            try { return JSON.parse(fetched.bytes.toString('utf8')); }
            catch { throw upstreamError('Kerala map selector returned invalid JSON.'); }
        };
        const talukList = await getJson('/web/taluk/gid', { districtId: DISTRICT_GID });
        const taluks = talukList?.dataPojo?.talukids;
        if (!Array.isArray(taluks) || !taluks.some(item => item?.gid === TALUK_GID)) throw upstreamError('Kerala taluk selector no longer contains Manikkal.');
        const villageList = await getJson('/web/village/gid', { talukId: TALUK_GID,
            loadAllVillage: 'true', loadPublishedVillage: 'true' });
        const villages = villageList?.dataPojo?.villageids;
        if (!Array.isArray(villages) || !villages.some(item => item?.gid === VILLAGE_GID)) throw upstreamError('Kerala village selector no longer contains Manikkal.');
        const selected = await checkedResponse(`${APP_ORIGIN}/web/ilms/map/view`, { method: 'POST', headers: {
            ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
            districtGid: DISTRICT_GID, talukGid: TALUK_GID, villageGid: VILLAGE_GID }) }, 2 * 1024 * 1024);
        const map = load(selected.bytes.toString('utf8'));
        let config;
        try { config = JSON.parse(map('#initdata').attr('value')); }
        catch { throw upstreamError('Kerala village map did not return its map configuration.'); }
        if (config?.location_code !== LOCATION_CODE || typeof config.fgb_url !== 'string') throw upstreamError('Kerala selected an unexpected cadastral village.');
        let authUrl;
        try { authUrl = new URL(config.fgb_url); } catch { throw upstreamError('Kerala viewer did not issue a valid map session.'); }
        if (authUrl.protocol !== 'https:' || authUrl.hostname !== 'bhunaksha.entebhoomi.kerala.gov.in'
            || authUrl.pathname !== `${MAP_PATH}fgb/${LOCATION_CODE}` || !authUrl.searchParams.get('auth_key')) {
            throw upstreamError('Kerala viewer did not issue a valid map session.');
        }
        const authKey = authUrl.searchParams.get('auth_key');
        return { headers, authKey, createdAt: now() };
    }

    function getSession() {
        if (!sessionPromise) sessionPromise = bootstrap().catch(error => { sessionPromise = null; throw error; });
        return sessionPromise;
    }

    function mapUrl(format, authKey) {
        const url = new URL(`${MAP_PATH}${format}/${LOCATION_CODE}`, MAP_ORIGIN);
        url.searchParams.set('auth_key', authKey);
        return url.href;
    }

    async function postMap(format, body, attempt = 0) {
        const session = await getSession();
        const response = await fetchResponse(mapUrl(format, session.authKey), { method: 'POST', headers: {
            ...session.headers, 'Content-Type': 'application/json', Accept: 'application/geo+json,application/json,*/*' },
            body: JSON.stringify(body) });
        if ([401, 403, 498, 499].includes(response.status) && attempt === 0) {
            sessionPromise = null;
            return postMap(format, body, 1);
        }
        if (!response.ok) throw providerHttpError(response);
        const bytes = await readBytes(response, maxResponseBytes);
        if (!bytes.length || !/json/i.test(response.headers.get('content-type') || '')) throw upstreamError('Kerala map export returned no parcel data.');
        let payload;
        try { payload = JSON.parse(bytes.toString('utf8')); }
        catch { throw upstreamError('Kerala map export returned invalid parcel JSON.'); }
        return payload;
    }

    function canonicalFromGeoJson(feature) {
        const properties = feature?.properties;
        if (!properties || !NATIVE_ID.test(String(properties.parcel_gid || ''))) throw upstreamError('Kerala parcel row has an invalid native ID.');
        const geometry = projectGeometry(feature.geometry, toWgs84);
        return canonicalParcelFeature(descriptor, { geometry, properties }, String(properties.parcel_gid).toLowerCase());
    }

    function exactId(value) {
        if (typeof value !== 'string' || !value.startsWith(idPrefix) || !NATIVE_ID.test(value.slice(idPrefix.length))) {
            throw new HttpError(400, 'Invalid Kerala parcel ID.');
        }
        return value.slice(idPrefix.length).toLowerCase();
    }

    async function queryBounds(bounds) {
        validateBounds(bounds, maxBboxKm2, descriptor);
        const [west, south, east, north] = bounds;
        // Densify the small WGS84 viewport edges before projection so the metric
        // envelope conservatively contains every curved transformed edge.
        const points = [];
        for (let step = 0; step <= 8; step++) {
            const t = step / 8;
            points.push([west + (east - west) * t, south], [west + (east - west) * t, north],
                [west, south + (north - south) * t], [east, south + (north - south) * t]);
        }
        const projected = points.map(point => toMetric.forward(point));
        if (projected.some(point => point.some(value => !Number.isFinite(value)))) throw new HttpError(400, 'Invalid projected parcel bounds.');
        const metricBounds = [Math.min(...projected.map(point => point[0])), Math.min(...projected.map(point => point[1])),
            Math.max(...projected.map(point => point[0])), Math.max(...projected.map(point => point[1]))];
        const payload = await postMap('geojson', { map_type: 'GENERIC_MAP', layer_code: 'LAND_PARCEL', srs: 'EPSG:32643',
            bbox: metricBounds.join(','), limit: maxFeatures });
        if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features)) throw upstreamError('Kerala returned an invalid parcel FeatureCollection.');
        const reportedCounts = ['numberMatched', 'numberReturned', 'totalFeatures'].filter(key => payload[key] !== undefined)
            .map(key => Number(payload[key]));
        const hasNextPage = Array.isArray(payload.links) && payload.links.some(link => String(link?.rel).toLowerCase().split(/\s+/).includes('next'));
        if (payload.features.length >= maxFeatures || payload.exceededTransferLimit === true || payload.transferLimitExceeded === true
            || hasNextPage || payload.next !== undefined && payload.next !== null
            || reportedCounts.some(count => !Number.isSafeInteger(count) || count !== payload.features.length)) {
            throw upstreamError('Kerala parcel viewport response may be incomplete; use a smaller area.');
        }
        const footprint = bboxPolygon(bounds);
        const byId = new Map();
        for (const row of payload.features) {
            const parcel = canonicalFromGeoJson(row);
            if (!booleanIntersects(parcel, footprint)) continue;
            const previous = byId.get(parcel.id);
            if (previous && JSON.stringify(previous.geometry) !== JSON.stringify(parcel.geometry)) throw upstreamError('Kerala returned conflicting geometry for one parcel ID.');
            byId.set(parcel.id, parcel);
        }
        const features = [...byId.values()];
        for (const parcel of features) remember(parcel);
        return result(features);
    }

    async function exactFeature(nativeId, attempt = 0) {
        const session = await getSession();
        const endpoint = `${APP_ORIGIN}/web/proxy/mapinfo/feature_info/${LOCATION_CODE}`;
        const response = await fetchResponse(endpoint, { method: 'POST', headers: { ...session.headers,
            'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({
            map_type: 'GENERIC_MAP', layer_code: 'LAND_PARCEL', attributes: { parcel_gid: nativeId }, fit_to_this: 'false', type: 'json' }) });
        if ([401, 403, 498, 499].includes(response.status) && attempt === 0) {
            sessionPromise = null;
            return exactFeature(nativeId, 1);
        }
        if (!response.ok) throw providerHttpError(response);
        return parseExact(await readBytes(response, maxResponseBytes), nativeId);
    }

    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 Kerala parcel IDs.');
        const unique = [...new Set(ids.map(value => `${idPrefix}${exactId(value)}`))];
        const nativeIds = unique.map(value => value.slice(idPrefix.length));
        const features = [];
        for (let index = 0; index < unique.length; index++) {
            const idValue = unique[index];
            const cached = recent.get(idValue);
            if (cached && cached.expires > now()) { features.push(structuredClone(cached.feature)); continue; }
            recent.delete(idValue);
            const nativeId = nativeIds[index];
            features.push(...await exactFeature(nativeId));
        }
        const present = new Set(features.map(feature => feature.id));
        return result(features, { absentIds: unique.filter(value => !present.has(value)) });
    }

    function parseExact(bytes, requestedNativeId) {
        let rows;
        try { rows = JSON.parse(bytes.toString('utf8')); } catch { throw upstreamError('Kerala exact parcel lookup returned invalid JSON.'); }
        if (!Array.isArray(rows) || rows.length > 1) throw upstreamError('Kerala exact parcel lookup returned an invalid record set.');
        if (!rows.length) return [];
        const row = rows[0];
        const properties = row?.attributes;
        if (row?.locationCode !== LOCATION_CODE || !properties || String(properties.parcel_gid || '').toLowerCase() !== requestedNativeId) {
            throw upstreamError('Kerala exact parcel lookup returned an unexpected parcel.');
        }
        const geometry = projectGeometry(parseKeralaWktPolygon(row.geom), toWgs84);
        const feature = canonicalParcelFeature(descriptor, { geometry, properties }, requestedNativeId);
        remember(feature);
        return [feature];
    }

    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a valid WGS84 Polygon or MultiPolygon.');
        const footprint = geoFeature(geometry);
        const bounds = await queryBounds(geometryBbox(footprint));
        return { ...bounds, features: bounds.features.filter(parcel => booleanIntersects(parcel, footprint)) };
    }

    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}
