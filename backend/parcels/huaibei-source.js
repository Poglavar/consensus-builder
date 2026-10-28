// Read the official public cadastral list incrementally, discarding non-identity attributes.
import { ECB, pkcs7Strip } from 'aes-js';
import { bbox, bboxPolygon, booleanIntersects } from '@turf/turf';
import { readGeojsonFeatureStream } from './geojson-stream-reader.js';
import { canonicalParcelFeature, validateBounds, validateGeometry, upstreamError, providerHttpError } from './source-contract.js';

export const HUAIBEI_SOURCE_ID = 'cn-huaibei-natural-resources-cadastral-viewer';
export const HUAIBEI_ENDPOINT = 'http://60.172.200.224:9293/getDJ/hbdj/tb-parcel/list';
const PREFIX = 'CN-HUAIBEI-';
// Both literals are published by the anonymous viewer, not user credentials.
const KEY = new TextEncoder().encode('14SB,DHB,2B,94SB');
const MAX_BYTES = 16 * 1024 ** 2;
const STOP = Symbol('requested native IDs found');
const fail = message => upstreamError(message, 502, 'huaibei-parcel-response-invalid');
const badInput = () => Object.assign(new Error('Invalid Huaibei parcel query.'), { status: 400 });

export function isHuaibeiSource(d) {
    return d?.id === HUAIBEI_SOURCE_ID && d.adapter === 'huaibei-cadastre'
        && d.endpoint === HUAIBEI_ENDPOINT && d.idPrefix === PREFIX && d.browserTransport === 'relay'
        && d.outFields?.length === 1 && d.outFields[0] === 'ID';
}
export function isHuaibeiParcelRequest(url, method, body) {
    return url instanceof URL && url.href === `${HUAIBEI_ENDPOINT}?token=wwg`
        && method === 'POST' && body === '{"type":0,"fields":["ID","geometry"]}';
}

// Decode the viewer's AES-ECB/base64 resultData without buffering the response or private rows.
export async function* huaibeiPlaintext(response, { onBytes = () => {} } = {}) {
    let reader, bytes = 0, prefix = '', suffix = '', encoded = '', found = false, closed = false;
    let pending = new Uint8Array(0);
    const decoder = new TextDecoder('utf-8', { fatal: true }), cipher = new ECB(KEY);
    function decrypt(text, final = false) {
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw fail('Invalid cadastral encoding.');
        const raw = Uint8Array.from(atob(text), c => c.charCodeAt(0));
        const joined = new Uint8Array(pending.length + raw.length);
        joined.set(pending); joined.set(raw, pending.length);
        // Hold the last block until PKCS7 padding can be checked at the string boundary.
        const length = final ? joined.length : Math.max(0, Math.floor((joined.length - 16) / 16) * 16);
        const plain = cipher.decrypt(joined.subarray(0, length));
        pending = joined.slice(length);
        if (final) {
            if (pending.length || !plain.length) throw fail('Truncated cadastral cipher.');
            try { return pkcs7Strip(plain); } catch { throw fail('Invalid cadastral padding.'); }
        }
        return plain;
    }
    try {
        if (!response.ok) throw providerHttpError(response);
        if (!response.body?.getReader) throw fail('Cadastral provider has no readable stream.');
        reader = response.body.getReader();
        for (;;) {
            const chunk = await reader.read(); if (chunk.done) break;
            bytes += chunk.value.byteLength; onBytes(bytes);
            if (bytes > MAX_BYTES) throw fail('Cadastral list exceeded the 16 MiB streaming budget.');
            let text = decoder.decode(chunk.value, { stream: true });
            if (!found) {
                prefix += text;
                const match = /"resultData"\s*:\s*"/.exec(prefix);
                if (!match) { if (prefix.length > 4096) throw fail('Missing cadastral result envelope.'); continue; }
                text = prefix.slice(match.index + match[0].length);
                prefix = prefix.slice(0, match.index + match[0].length - 1);
                const header = JSON.parse(prefix + 'null}');
                if (header.success !== true || header.code !== 10000) throw fail('Cadastral service refused the public request.');
                found = true;
            }
            if (closed) { suffix += text; if (suffix.length > 4096) throw fail('Excess cadastral metadata.'); continue; }
            const end = text.indexOf('"');
            encoded += end < 0 ? text : text.slice(0, end);
            // The published payload has no JSON escapes; reject rather than alter unknown encodings.
            if (/[^A-Za-z0-9+/=\r\n]/.test(encoded)) throw fail('Unexpected cadastral encoding.');
            encoded = encoded.replace(/[\r\n]/g, '');
            if (end >= 0) {
                yield decrypt(encoded, true); encoded = ''; closed = true; suffix = text.slice(end + 1);
            } else {
                const n = Math.floor(encoded.length / 4) * 4;
                if (n) { yield decrypt(encoded.slice(0, n)); encoded = encoded.slice(n); }
            }
        }
        if (decoder.decode() || !found || !closed) throw fail('Truncated cadastral envelope.');
        let envelope; try { envelope = JSON.parse(prefix + 'null' + suffix); } catch { throw fail('Invalid cadastral envelope.'); }
        if (envelope.success !== true || envelope.code !== 10000) throw fail('Cadastral service reported failure.');
    } finally {
        if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        else await response.body?.cancel().catch(() => {});
    }
}

export function createHuaibeiParcelSource(d, { fetchImpl = fetch } = {}) {
    if (!isHuaibeiSource(d) || !Number.isSafeInteger(d.maxFeatures) || d.maxFeatures < 1 || d.maxFeatures > 10000) {
        throw new Error('Invalid Huaibei cadastral descriptor.');
    }
    const result = (features, extra = {}) => ({ type: 'FeatureCollection', features, complete: true,
        sourceId: d.id, returnsWGS84: true, ...extra });
    async function scan(wanted, geometry, indexMode = false) {
        const found = new Map(); let actualBytes = 0, count = 0, fullEnvelopeRead = false;
        const response = await fetchImpl(`${d.endpoint}?token=wwg`, { method: 'POST',
            headers: { 'Content-Type': 'application/json;charset=UTF-8', token: 'wwg' },
            body: '{"type":0,"fields":["ID","geometry"]}', signal: AbortSignal.timeout(45000), redirect: 'error' });
        try {
            await readGeojsonFeatureStream(huaibeiPlaintext(response, { onBytes: value => { actualBytes = value; } }), {
                maxRecordBytes: 1024 * 1024,
                onFeature(f) {
                    if (++count > 20000 || f?.type !== 'Feature') throw fail('Invalid cadastral row.');
                    const native = f.properties?.ID;
                    if (!Number.isSafeInteger(native) || native < 0) throw fail('Missing cadastral native ID.');
                    const id = PREFIX + native;
                    if (wanted ? !wanted.has(id) : geometry && !booleanIntersects(f.geometry, geometry)) return;
                    if (!validateGeometry(f.geometry)) throw fail('Unusable cadastral polygon.');
                    const canonical = canonicalParcelFeature(d, { geometry: f.geometry, properties: {} }, String(native));
                    if (found.has(id) && JSON.stringify(found.get(id).geometry) !== JSON.stringify(canonical.geometry)) {
                        throw fail('Conflicting cadastral native ID.');
                    }
                    found.set(id, canonical);
                    if (found.size > (indexMode ? 10000 : d.maxFeatures)) throw fail('Cadastral query exceeds feature budget.');
                    if (wanted && found.size === wanted.size) throw STOP;
                }
            });
            fullEnvelopeRead = true;
        } catch (error) { if (error !== STOP) throw error; }
        return result([...found.values()], { absentIds: wanted && fullEnvelopeRead ? [...wanted].filter(id => !found.has(id)) : [],
            evidence: { actualBytes, parsedFeatures: count, fullEnvelopeRead, streamingStop: !fullEnvelopeRead } });
    }
    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80 || ids.some(id => typeof id !== 'string'
            || !id.startsWith(PREFIX) || !/^(0|[1-9]\d{0,14})$/.test(id.slice(PREFIX.length)))) throw badInput();
        return scan(new Set(ids), null);
    }
    // The municipal list is small enough for one capped scan. Cache only native IDs and
    // unchanged geometry in runtime memory; never persist the provider's attribute table.
    let areaSnapshot = null, areaPending = null, expires = 0;
    async function snapshot() {
        if (areaSnapshot && Date.now() < expires) return areaSnapshot;
        if (!areaPending) areaPending = scan(null, null, true).then(read => {
            areaSnapshot = read; expires = Date.now() + 300000; return read;
        }).finally(() => { areaPending = null; });
        return areaPending;
    }
    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw badInput();
        validateBounds(bbox(geometry), d.maxBboxKm2 || 4, d);
        const read = await snapshot();
        const features = read.features.filter(f => booleanIntersects(f.geometry, geometry));
        if (features.length > d.maxFeatures) throw fail('Cadastral query exceeds feature budget.');
        return result(features.map(f => structuredClone(f)), { evidence: read.evidence });
    }
    async function queryBounds(bounds) {
        validateBounds(bounds, d.maxBboxKm2 || 4, d);
        return queryGeometry(bboxPolygon(bounds).geometry);
    }
    return Object.freeze({ queryIds, queryBounds, queryGeometry });
}
