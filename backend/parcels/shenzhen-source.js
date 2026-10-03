// Shenzhen's public cadastral viewer ships an opaque client token in its anonymous JavaScript.
// Resolve that published value transiently, then restrict it to the one verified polygon layer.
import { createArcgisParcelSource } from './arcgis-source.js';
import { upstreamError, providerHttpError } from './source-contract.js';
import { createHash } from 'node:crypto';

export const shenzhenLandCertainDescriptor = Object.freeze({
    adapter: 'arcgis',
    id: 'cn-shenzhen-land-certain',
    cityIds: ['shenzhen'],
    endpoint: 'https://pnr.sz.gov.cn:8001/d-suplicmap/dynamap_1/rest/services/LAND_CERTAIN/MapServer/0',
    catalogueUrl: 'https://pnr.sz.gov.cn/d-djtcx/djtcx/index.html',
    idField: 'PARCEL_NO',
    objectIdField: 'OBJECTID',
    idPrefix: 'CN-SZ-LANDCERTAIN-',
    idType: 'string',
    idPattern: '^[A-Za-z0-9_./()（）\\u3000-\\u303f\\u4e00-\\u9fff\\uff00-\\uffef-]{1,128}$',
    parcelNumberField: 'PARCEL_NO',
    outFields: ['OBJECTID', 'PARCEL_NO', 'LOT_NO'],
    pageSize: 80,
    maxFeatures: 10000,
    maxBboxKm2: 25,
    boundsQueryMode: 'object-ids',
    metricSrid: 4547
});

const PUBLIC_CLIENT_SCRIPT = 'https://pnr.sz.gov.cn/d-djtcx/djtcx/js/main.js';
const PUBLIC_VIEWER = 'https://pnr.sz.gov.cn/d-djtcx/djtcx/index.html';
const LAYER_URL = shenzhenLandCertainDescriptor.endpoint;
const QUERY_URL = `${LAYER_URL}/query`;
const SCRIPT_ORIGIN = 'https://pnr.sz.gov.cn';
const LAYER_ORIGIN = 'https://pnr.sz.gov.cn:8001';
const TOKEN_HEADER = 'X-OPENAPI-SubscriptionToken';
const IDENTIFIER = /^[A-Za-z0-9_./()（）\u3000-\u303f\u4e00-\u9fff\uff00-\uffef-]{1,128}$/;
const ALLOWED_PARAMS = new Set([
    'where', 'geometry', 'geometryType', 'inSR', 'spatialRel', 'outSR', 'returnCountOnly', 'returnIdsOnly',
    'objectIds', 'outFields', 'returnGeometry', 'f', 'orderByFields', 'resultRecordCount', 'resultOffset'
]);

function decodeJsString(raw) {
    let value = '';
    for (let i = 0; i < raw.length; i += 1) {
        const character = raw[i];
        if (character !== '\\') {
            value += character;
            continue;
        }
        const escaped = raw[++i];
        if (escaped === undefined) throw new Error('Incomplete string escape.');
        if (escaped === 'x' || escaped === 'u') {
            const length = escaped === 'x' ? 2 : 4;
            const digits = raw.slice(i + 1, i + 1 + length);
            if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(digits)) throw new Error('Invalid Unicode escape.');
            value += String.fromCharCode(Number.parseInt(digits, 16));
            i += length;
            continue;
        }
        if (escaped === '\n') continue;
        value += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' })[escaped] ?? escaped;
    }
    return value;
}

function parseStringArray(source, openingBracket) {
    const values = [];
    let index = openingBracket + 1;
    while (index < source.length) {
        while (/\s/.test(source[index] || '')) index += 1;
        if (source[index] === ']') return values;
        const quote = source[index];
        if (quote !== "'" && quote !== '"') throw new Error('Client string table is not a literal array.');
        index += 1;
        let raw = '';
        let closed = false;
        while (index < source.length) {
            const character = source[index++];
            if (character === quote) {
                closed = true;
                break;
            }
            if (character === '\\') {
                raw += character;
                if (index >= source.length) throw new Error('Incomplete string table escape.');
                raw += source[index++];
                if (raw.endsWith('\\x')) raw += source.slice(index, index += 2);
                else if (raw.endsWith('\\u')) raw += source.slice(index, index += 4);
                continue;
            }
            raw += character;
        }
        if (!closed) throw new Error('Unterminated client string table value.');
        values.push(decodeJsString(raw));
        while (/\s/.test(source[index] || '')) index += 1;
        if (source[index] === ',') {
            index += 1;
            continue;
        }
        if (source[index] === ']') return values;
        throw new Error('Malformed client string table.');
    }
    throw new Error('Unterminated client string table.');
}

function resolvePublishedClientToken(script) {
    const findFeatureAt = script.indexOf('function findFeature(');
    if (findFeatureAt < 0) throw new Error('Public viewer feature-query function was not found.');
    const headerAt = script.indexOf(TOKEN_HEADER, findFeatureAt);
    const headerMatch = script.slice(headerAt, headerAt + 160).match(/X-OPENAPI-SubscriptionToken['"]?\s*:\s*([A-Za-z_$][\w$]*)\((0x[0-9a-f]+)\)/i);
    if (headerAt < 0 || !headerMatch) throw new Error('Public viewer token reference was not found.');
    const [, tokenAlias, tokenIndexText] = headerMatch;
    const functionHead = script.slice(findFeatureAt, headerAt);
    const aliasMatch = functionHead.match(new RegExp(`\\b${tokenAlias}\\s*=\\s*([A-Za-z_$][\\w$]*)`));
    if (!aliasMatch) throw new Error('Public viewer token decoder alias was not found.');
    const decoderName = aliasMatch[1];

    const tableMatch = script.match(/function\s+([A-Za-z_$][\w$]*)\(\)\s*\{\s*var\s+([A-Za-z_$][\w$]*)\s*=\s*\[/);
    if (!tableMatch) throw new Error('Public viewer string table was not found.');
    const [, tableName, tableVariable] = tableMatch;
    const tableStart = tableMatch.index + tableMatch[0].lastIndexOf('[');
    const tableEnd = script.indexOf('];', tableStart);
    if (tableEnd < 0) throw new Error('Public viewer string table was not terminated.');
    const table = parseStringArray(script, tableStart);
    const decoderPattern = new RegExp(`function\\s+${decoderName}\\([^)]*\\)\\s*\\{\\s*var\\s+[A-Za-z_$][\\w$]*\\s*=\\s*${tableName}\\(\\);\\s*return\\s+${decoderName}=function\\(([A-Za-z_$][\\w$]*)[^)]*\\)\\{\\s*\\1=\\1-(0x[0-9a-f]+);`, 'i');
    const decoderMatch = script.slice(tableEnd).match(decoderPattern);
    if (!decoderMatch) throw new Error('Public viewer string decoder was not recognized.');
    const decoderBase = Number.parseInt(decoderMatch[2], 16);

    const preTable = script.slice(0, tableMatch.index);
    const rotationCall = preTable.match(new RegExp(`}\\s*\\(\\s*${tableName}\\s*,\\s*(0x[0-9a-f]+)\\s*\\)\\s*\\);`, 'i'));
    if (rotationCall) {
        const target = Number.parseInt(rotationCall[1], 16);
        const checksum = preTable.match(/var\s+([A-Za-z_$][\w$]*)=([\s\S]*?);if\(\1===([A-Za-z_$][\w$]*)\)/);
        const decoderAlias = preTable.match(new RegExp(`var\\s+([A-Za-z_$][\\w$]*)=${decoderName}`));
        if (!checksum || !decoderAlias) throw new Error('Public viewer string-table rotation was not recognized.');
        let expression = checksum[2];
        const referencePattern = new RegExp(`parseInt\\(\\s*${decoderAlias[1]}\\(\\s*(0x[0-9a-f]+)\\s*\\)\\s*\\)`, 'ig');
        expression = expression.replace(referencePattern, (_match, indexText) => {
            const tableValue = table[Number.parseInt(indexText, 16) - decoderBase];
            const number = Number.parseInt(tableValue, 10);
            return Number.isNaN(number) ? 'NaN' : String(number);
        });
        if (!/^[0-9a-fA-FxXNaN().+\-*/\s]+$/.test(expression)) throw new Error('Unsafe viewer string-table checksum expression.');
        const checksumMatches = () => {
            const actual = Function(`"use strict"; return (${expression});`)();
            return Number.isFinite(actual) && actual === target;
        };
        let rotated = false;
        for (let offset = 0; offset < table.length; offset += 1) {
            if (checksumMatches()) {
                rotated = true;
                break;
            }
            table.push(table.shift());
            expression = checksum[2].replace(referencePattern, (_match, indexText) => {
                const tableValue = table[Number.parseInt(indexText, 16) - decoderBase];
                const number = Number.parseInt(tableValue, 10);
                return Number.isNaN(number) ? 'NaN' : String(number);
            });
            if (!/^[0-9a-fA-FxXNaN().+\-*/\s]+$/.test(expression)) throw new Error('Unsafe viewer string-table checksum expression.');
        }
        if (!rotated) throw new Error('Public viewer string-table rotation did not validate.');
    }

    const token = table[Number.parseInt(tokenIndexText, 16) - decoderBase];
    if (typeof token !== 'string' || !/^[0-9a-f]{32}$/i.test(token)) throw new Error('Public viewer did not expose a valid client key.');
    return token;
}

function jsonResponse(body) {
    return { ok: true, status: 200, json: async () => body };
}

function parseExactNativeWhere(where) {
    const prefix = `${shenzhenLandCertainDescriptor.idField} IN (`;
    if (typeof where !== 'string' || !where.startsWith(prefix) || !where.endsWith(')')) return null;
    const list = where.slice(prefix.length, -1);
    const values = [];
    let offset = 0;
    const literal = /^'([^']*)'(?:,|$)/;
    while (offset < list.length) {
        const match = list.slice(offset).match(literal);
        if (!match || !IDENTIFIER.test(match[1])) return null;
        values.push(match[1]);
        offset += match[0].length;
        if (match[0].endsWith(',')) continue;
        if (offset !== list.length) return null;
    }
    if (!values.length || values.length > 80 || new Set(values).size !== values.length) return null;
    return values;
}

export function createShenzhenLandCertainSource({ fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
    let tokenPromise;
    const nativeToObjectId = new Map();
    const objectIdToNative = new Map();
    const objectIdToGeometry = new Map();

    async function clientToken() {
        if (!tokenPromise) {
            tokenPromise = (async () => {
                const controller = AbortSignal.timeout(15000);
                let response;
                try {
                    response = await fetchImpl(PUBLIC_CLIENT_SCRIPT, {
                        method: 'GET', signal: controller, redirect: 'error', credentials: 'omit',
                        headers: { Accept: 'application/javascript, text/javascript' }
                    });
                    if (!response.ok) throw providerHttpError(response);
                    return resolvePublishedClientToken(await response.text());
                } catch (error) {
                    if (error.status) throw error;
                    if (controller.aborted || ['TimeoutError', 'AbortError'].includes(error.name)) {
                        throw upstreamError('Shenzhen public client script timed out.', 504);
                    }
                    throw upstreamError('Shenzhen public client token could not be resolved.');
                }
            })();
            tokenPromise.catch(() => { tokenPromise = undefined; });
        }
        return tokenPromise;
    }

    async function requestLayer(params) {
        const query = new URLSearchParams(params);
        for (const key of query.keys()) if (!ALLOWED_PARAMS.has(key)) throw upstreamError('Shenzhen parcel query contains an unsupported parameter.');
        const target = new URL(QUERY_URL);
        const asPost = `${target.href}?${query}`.length > 1800;
        if (!asPost) target.search = query.toString();
        if (target.origin !== LAYER_ORIGIN || target.pathname !== new URL(QUERY_URL).pathname) {
            throw upstreamError('Shenzhen parcel query escaped the fixed provider endpoint.');
        }
        const token = await clientToken();
        const signal = AbortSignal.timeout(15000);
        let response;
        try { response = await fetchImpl(target, {
            method: asPost ? 'POST' : 'GET', ...(asPost ? { body: query.toString() } : {}),
            signal, redirect: 'error', credentials: 'omit',
            headers: { Accept: 'application/geo+json, application/json', Referer: PUBLIC_VIEWER,
                Origin: SCRIPT_ORIGIN, ...(asPost ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
                [TOKEN_HEADER]: token }
        }); } catch (error) {
            if (signal.aborted || ['TimeoutError', 'AbortError'].includes(error.name)) throw upstreamError('Shenzhen parcel provider timed out.', 504);
            throw upstreamError('Shenzhen parcel provider is unavailable.');
        }
        if (response.status === 401 || response.status === 403) tokenPromise = undefined;
        if (!response.ok) throw providerHttpError(response);
        let payload;
        try { payload = await response.json(); } catch { throw upstreamError('Shenzhen parcel provider returned an invalid response.'); }
        if (payload.error) throw providerHttpError(payload.error.code);
        return payload;
    }

    function rememberFeatures(payload) {
        if (payload.type !== 'FeatureCollection' || !Array.isArray(payload.features)) return;
        for (const feature of payload.features) {
            const properties = feature.properties || {};
            const nativeId = properties[shenzhenLandCertainDescriptor.idField];
            const objectId = properties[shenzhenLandCertainDescriptor.objectIdField] ?? feature.id;
            if (typeof nativeId !== 'string' || !IDENTIFIER.test(nativeId) || objectId === undefined || objectId === null) {
                throw upstreamError('Shenzhen parcel provider returned a missing or invalid native ID.');
            }
            const nativeKey = String(nativeId);
            const objectKey = String(objectId);
            const priorObjectId = nativeToObjectId.get(nativeKey);
            const priorNativeId = objectIdToNative.get(objectKey);
            const geometry = createHash('sha256').update(JSON.stringify(feature.geometry)).digest('hex');
            const priorGeometry = objectIdToGeometry.get(objectKey);
            if ((priorObjectId !== undefined && priorObjectId !== objectKey)
                || (priorNativeId !== undefined && priorNativeId !== nativeKey)
                || (priorGeometry !== undefined && priorGeometry !== geometry)) {
                throw upstreamError('Shenzhen parcel provider returned duplicate IDs or conflicting geometry.');
            }
            nativeToObjectId.set(nativeKey, objectKey);
            objectIdToNative.set(objectKey, nativeKey);
            objectIdToGeometry.set(objectKey, geometry);
        }
    }

    async function fetchSource(input, init = {}) {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
        const fixed = new URL(QUERY_URL);
        if (url.origin !== fixed.origin || url.pathname !== fixed.pathname || init.redirect && init.redirect !== 'error') {
            throw upstreamError('Shenzhen parcel request escaped the fixed provider endpoint.');
        }
        const params = new URLSearchParams(url.search);
        if (typeof init.body === 'string') for (const [key, value] of new URLSearchParams(init.body)) params.set(key, value);
        for (const key of params.keys()) if (!ALLOWED_PARAMS.has(key)) throw upstreamError('Shenzhen parcel query contains an unsupported parameter.');
        if (params.get('outFields') && params.get('outFields') !== shenzhenLandCertainDescriptor.outFields.join(',')) {
            throw upstreamError('Shenzhen parcel query requested fields outside the approved ID whitelist.');
        }
        if (params.get('returnGeometry') === 'true' && params.get('outSR') !== '4326') {
            throw upstreamError('Shenzhen polygon geometry must be returned in WGS84.');
        }
        if (params.has('geometry') && (params.get('geometryType') !== 'esriGeometryEnvelope'
            || params.get('inSR') !== '4326' || params.get('spatialRel') !== 'esriSpatialRelIntersects')) {
            throw upstreamError('Shenzhen parcel query used an unsupported spatial filter.');
        }
        const where = params.get('where');
        if (where && where !== '1=1' && !parseExactNativeWhere(where)) {
            throw upstreamError('Shenzhen parcel query contains an unsupported filter.');
        }
        if (where && where !== '1=1' && !params.has('geometry') && !params.has('objectIds')) {
            const values = parseExactNativeWhere(where);
            const fields = params.get('outFields');
            if (!values || fields !== shenzhenLandCertainDescriptor.outFields.join(',')) {
                throw upstreamError('Shenzhen exact-ID query does not match the approved contract.');
            }
            const countResponse = await requestLayer({ where, returnCountOnly: 'true', f: 'json' });
            const count = countResponse.count;
            if (!Number.isSafeInteger(count) || count < 0 || count > values.length || count > shenzhenLandCertainDescriptor.maxFeatures) {
                throw upstreamError('Shenzhen exact-ID count is invalid or reveals a duplicate native key.');
            }
            const manifest = await requestLayer({ where, returnIdsOnly: 'true', f: 'json' });
            const ids = count === 0 && manifest.objectIds === null ? [] : manifest.objectIds;
            if (!Array.isArray(ids) || ids.length !== count || new Set(ids.map(String)).size !== ids.length
                || manifest.exceededTransferLimit === true
                || (manifest.objectIdFieldName && manifest.objectIdFieldName !== shenzhenLandCertainDescriptor.objectIdField)) {
                throw upstreamError('Shenzhen exact-ID manifest is incomplete.');
            }
            const found = [];
            for (let start = 0; start < ids.length; start += 80) {
                const batch = ids.slice(start, start + 80);
                const exact = await requestLayer({ objectIds: batch.join(','), outFields: fields,
                    returnGeometry: 'true', outSR: '4326', f: 'geojson' });
                if (exact.type !== 'FeatureCollection' || !Array.isArray(exact.features)
                    || exact.exceededTransferLimit === true || exact.features.length !== batch.length) {
                    throw upstreamError('Shenzhen exact native-ID geometry batch was incomplete.');
                }
                const exactIds = exact.features.map(feature => String(feature?.properties?.OBJECTID ?? feature?.id));
                if (new Set(exactIds).size !== exactIds.length || exactIds.some(id => !batch.map(String).includes(id))) {
                    throw upstreamError('Shenzhen exact native-ID geometry batch returned unexpected object IDs.');
                }
                found.push(...exact.features);
            }
            const matched = new Map(values.map(value => [value, 0]));
            for (const feature of found) {
                const nativeId = feature.properties?.[shenzhenLandCertainDescriptor.idField];
                if (!matched.has(nativeId)) throw upstreamError('Shenzhen exact native-ID read returned an unexpected parcel.');
                matched.set(nativeId, matched.get(nativeId) + 1);
                if (matched.get(nativeId) > 1) throw upstreamError('Shenzhen exact native-ID read found a duplicated parcel key.');
            }
            const result = { type: 'FeatureCollection', features: found, exceededTransferLimit: false };
            rememberFeatures(result);
            return jsonResponse(result);
        }
        if (!where) throw upstreamError('Shenzhen parcel query omitted its fixed filter.');
        const method = init.method || 'GET';
        const body = method === 'POST' ? params.toString() : undefined;
        const target = new URL(QUERY_URL);
        if (method === 'GET') target.search = params.toString();
        const token = await clientToken();
        const signal = init.signal || AbortSignal.timeout(15000);
        let response;
        try { response = await fetchImpl(target, {
            method, ...(body ? { body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } } : {}),
            signal, redirect: 'error', credentials: 'omit',
            headers: { ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
                Accept: 'application/geo+json, application/json', Referer: PUBLIC_VIEWER, Origin: SCRIPT_ORIGIN,
                [TOKEN_HEADER]: token }
        }); } catch (error) {
            if (signal.aborted || ['TimeoutError', 'AbortError'].includes(error.name)) throw upstreamError('Shenzhen parcel provider timed out.', 504);
            throw upstreamError('Shenzhen parcel provider is unavailable.');
        }
        if (response.status === 401 || response.status === 403) tokenPromise = undefined;
        if (!response.ok) throw providerHttpError(response);
        let payload;
        try { payload = await response.json(); } catch { throw upstreamError('Shenzhen parcel provider returned an invalid response.'); }
        if (payload.error) throw providerHttpError(payload.error.code);
        rememberFeatures(payload);
        return jsonResponse(payload);
    }

    const adapter = createArcgisParcelSource(shenzhenLandCertainDescriptor, { fetchImpl: fetchSource });
    return Object.freeze({ queryBounds: adapter.queryBounds, queryIds: adapter.queryIds, queryGeometry: adapter.queryGeometry });
}
