// GUGiK ULDK point-identify and exact-ID parcel lookup for Poland's county EGiB cadastre.
// ULDK answers one parcel per request and cannot enumerate an area, so this adapter never claims one.
import { concatBytes } from './byte-utils.js';
import { booleanPointInPolygon, feature as turfFeature, point as turfPoint } from '@turf/turf';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateGeometry } from './source-contract.js';

const SOURCE_ID = 'pl-gugik-uldk';
const ENDPOINT = 'https://uldk.gugik.gov.pl/';
const ID_PREFIX = 'PL-ULDK-';
const ID_FIELD = 'id';
// TERYT parcel identifier WWPPGG_R.OOOO[.AR_N].NR_DZ: voivodeship, county and commune codes, commune
// type, four-digit precinct, optional map sheet, and a parcel number that EGiB defines as a natural
// number or a fraction of two natural numbers.
export const ULDK_NATIVE_ID_PATTERN = '^[0-9]{6}_[0-9]\\.[0-9]{4}\\.(?:AR_[0-9]{1,4}\\.)?[0-9]{1,6}(?:/[0-9]{1,6})?$';
const NATIVE_ID = new RegExp(ULDK_NATIVE_ID_PATTERN);
// ULDK's documented no-result reply. Every other "-1 <message>" line is a service error.
const NO_RESULT_LINE = '-1 brak wyników';
// Live no-result replies (2026-10-12, an absent ID and a point outside Poland) add exactly this
// second line; only this exact form is accepted as absence.
const NO_RESULT_DETAIL = 'błędny format odpowiedzi XML, usługa zwróciła odpowiedźZbiorcza baza danych obsłużyła zapytanie.';
const RESULT_FIELDS = 'id,geom_wkt';
const OUTPUT_SRID = '4326';
// GUGiK publishes no rate limit; one request start per second per adapter instance is our own bound.
const PACE_MS = 1000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_BATCH_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;
// Source binding sends 80 IDs per call; at one request per second that needs well over 80 s.
const BATCH_TIMEOUT_MS = 150000;
const MAX_ID_BATCH = 80;
const MAX_VERTICES = 250000;

function unsupportedArea() {
    const error = new Error('ULDK parcel search supports point and exact-ID lookup only; complete area queries are unavailable.');
    error.status = 422;
    error.code = 'parcel-source-area-unsupported';
    return error;
}

function invalidProvider(message) {
    return upstreamError(message, 502, 'parcel-source-unavailable');
}

function timedOut() {
    return upstreamError('ULDK parcel provider timed out.', 504);
}

function invalidPoint() {
    const error = new Error('Expected a finite WGS84 point as [longitude, latitude].');
    error.status = 400;
    error.code = 'invalid-parcel-point';
    return error;
}

function invalidIds() {
    const error = new Error('Expected canonical ULDK parcel IDs using the configured source prefix.');
    error.status = 400;
    error.code = 'invalid-parcel-ids';
    return error;
}

function nativeIdOf(value) {
    return typeof value === 'string' && value.length <= 64 && NATIVE_ID.test(value) ? value : null;
}

function parseExactId(value) {
    if (typeof value !== 'string' || !value.startsWith(ID_PREFIX)) return null;
    const nativeId = nativeIdOf(value.slice(ID_PREFIX.length));
    return nativeId ? { id: value, nativeId } : null;
}

// Strict 2D WKT reader for the POLYGON / MULTIPOLYGON text ULDK prints. Z/M, EMPTY, curves and
// any vertex without exactly two coordinates are rejected; rings and holes are kept as received.
export function parseUldkPolygonWkt(text) {
    const typeMatch = /^(POLYGON|MULTIPOLYGON)\s*(?=\()/.exec(text);
    if (!typeMatch) throw invalidProvider('ULDK returned an unsupported parcel geometry type.');
    const multi = typeMatch[1] === 'MULTIPOLYGON';
    const numberPattern = /-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
    let at = typeMatch[0].length;
    let vertices = 0;
    const malformed = () => invalidProvider('ULDK returned malformed parcel WKT.');
    const skipSpace = () => { while (text[at] === ' ' || text[at] === '\t') at++; };
    const expect = character => { skipSpace(); if (text[at] !== character) throw malformed(); at++; };
    const number = () => {
        skipSpace();
        numberPattern.lastIndex = at;
        const match = numberPattern.exec(text);
        if (!match) throw malformed();
        at = numberPattern.lastIndex;
        const value = Number(match[0]);
        if (!Number.isFinite(value)) throw malformed();
        return value;
    };
    const list = item => {
        expect('(');
        const values = [item()];
        for (;;) {
            skipSpace();
            if (text[at] === ',') { at++; values.push(item()); continue; }
            if (text[at] === ')') { at++; return values; }
            throw malformed();
        }
    };
    const vertex = () => {
        const x = number();
        if (text[at] !== ' ' && text[at] !== '\t') throw malformed();
        const y = number();
        if (++vertices > MAX_VERTICES) throw invalidProvider('ULDK parcel geometry exceeds the vertex limit.');
        return [x, y];
    };
    const polygon = () => list(() => list(vertex));
    const coordinates = multi ? list(polygon) : polygon();
    skipSpace();
    if (at !== text.length) throw malformed();
    return { type: multi ? 'MultiPolygon' : 'Polygon', coordinates };
}

// ULDK answers from different backends (county services or its aggregate database) whose WGS84
// transforms differ around 1e-11 degrees: parcel 226301_1.0013.571 read 17.021863016563902 by point
// and 17.0218630165707 by ID on 2026-10-12. Coordinates are canonicalised to 1e-7 degrees (~1 cm,
// far below EGiB accuracy) so that noise cannot change a parcel's identity; vertices are not moved
// beyond that and rings are not repaired.
const COORDINATE_SCALE = 1e7;
function canonicalCoordinates(geometry) {
    const round = value => Math.round(value * COORDINATE_SCALE) / COORDINATE_SCALE;
    const rings = polygon => polygon.map(ring => ring.map(([x, y]) => [round(x), round(y)]));
    return { type: geometry.type, coordinates: geometry.type === 'Polygon' ? rings(geometry.coordinates) : geometry.coordinates.map(rings) };
}

function validateDescriptor(descriptor, { fetchImpl, timeoutMs, maxResponseBytes, waitImpl, now }) {
    const { id, idPrefix, endpoint, idField, idPattern, parcelNumberField, outFields } = descriptor || {};
    if (descriptor?.adapter !== 'pl-uldk-point' || id !== SOURCE_ID || idPrefix !== ID_PREFIX || endpoint !== ENDPOINT
        || idField !== ID_FIELD || idPattern !== ULDK_NATIVE_ID_PATTERN || parcelNumberField !== undefined
        || !Array.isArray(outFields) || outFields.length !== 1 || outFields[0] !== ID_FIELD
        || typeof fetchImpl !== 'function' || typeof waitImpl !== 'function' || typeof now !== 'function'
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > MAX_BYTES) {
        throw new Error('Invalid ULDK point parcel source descriptor.');
    }
}

async function readTextBounded(response, maxBytes) {
    const contentLength = response.headers?.get?.('content-length');
    if (typeof contentLength === 'string' && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
        throw invalidProvider('ULDK response exceeds the configured byte limit.');
    }
    const reader = response.body?.getReader?.();
    if (!reader) throw invalidProvider('ULDK returned no readable response body.');
    const chunks = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) {
                try { await reader.cancel(); } catch { /* response may already be closed */ }
                throw invalidProvider('ULDK response exceeds the configured byte limit.');
            }
            chunks.push(value);
        }
    } finally {
        try { reader.releaseLock(); } catch { /* ignore closed streams */ }
    }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(concatBytes(chunks, size)); }
    catch { throw invalidProvider('ULDK returned a response that is not valid UTF-8.'); }
    return { text, bytesRead: size };
}

// A reply is either the no-result reply (documented line, optionally with the observed detail line),
// or status "0" followed by exactly one record.
// Count lines (multi-record replies), other "-1" messages, HTML and empty bodies are not answers.
function parseReply(text) {
    const lines = text.replace(/\r?\n$/, '').split(/\r?\n/);
    const noResult = line => line.normalize('NFC').replace(/[ \t]+$/, '');
    if (lines.length === 1 && noResult(lines[0]) === NO_RESULT_LINE) return { absent: true };
    if (lines.length === 2 && noResult(lines[0]) === NO_RESULT_LINE && noResult(lines[1]) === NO_RESULT_DETAIL) return { absent: true };
    if (lines.length === 2 && lines[0] === '0' && lines[1]) return { absent: false, record: lines[1] };
    throw invalidProvider('ULDK returned an unrecognised reply status.');
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createUldkPointSource(descriptor, {
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = MAX_BYTES,
    waitImpl = delay,
    now = Date.now
} = {}) {
    validateDescriptor(descriptor, { fetchImpl, timeoutMs, maxResponseBytes, waitImpl, now });
    const { id } = descriptor;
    // One slot per adapter instance: request starts are at least PACE_MS apart, even for concurrent callers.
    let nextSlot = 0;
    let lastStart = -Infinity;

    const result = (features, queryType, extra = {}) => ({
        type: 'FeatureCollection', features, complete: true, queryType,
        sourceId: id, returnsWGS84: true, ...extra
    });

    async function request(params, { deadline = null, budgetSignal = null, maxBytes = maxResponseBytes } = {}) {
        const slot = Math.max(now(), nextSlot);
        nextSlot = slot + PACE_MS;
        if (deadline !== null && slot >= deadline) throw timedOut();
        // Timers fire early or late by a millisecond; measure from the previous actual start too.
        for (let waitMs; (waitMs = Math.max(slot, lastStart + PACE_MS) - now()) > 0;) await waitImpl(waitMs);
        lastStart = now();
        if (budgetSignal?.aborted) throw timedOut();
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const signal = budgetSignal ? AbortSignal.any([timeoutSignal, budgetSignal]) : timeoutSignal;
        const url = `${ENDPOINT}?${new URLSearchParams({ request: params.request, [params.key]: params.value, result: RESULT_FIELDS, srid: OUTPUT_SRID })}`;
        let response;
        try {
            response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal, headers: { Accept: 'text/plain' } });
        } catch (error) {
            if (signal.aborted || ['AbortError', 'TimeoutError'].includes(error?.name)) throw timedOut();
            throw Object.assign(upstreamError('ULDK parcel provider is unavailable.'), { cause: error });
        }
        if (!response.ok) {
            try { await response.body?.cancel(); } catch { /* body may already be closed */ }
            throw providerHttpError(response);
        }
        if (!/^text\/plain(?:\s*;|$)/i.test(response.headers?.get?.('content-type') || '')) {
            try { await response.body?.cancel(); } catch { /* body may already be closed */ }
            throw invalidProvider('ULDK returned a non-text reply.');
        }
        try {
            const { text, bytesRead } = await readTextBounded(response, maxBytes);
            return { reply: parseReply(text), bytesRead };
        } catch (error) {
            if (signal.aborted || ['AbortError', 'TimeoutError'].includes(error?.name)) throw timedOut();
            throw error;
        }
    }

    function sourceFeature(record, expectedNativeId = null) {
        const parts = record.split('|');
        if (parts.length !== 2) throw invalidProvider('ULDK returned a record without exactly an ID and a geometry.');
        const nativeId = nativeIdOf(parts[0]);
        if (!nativeId) throw invalidProvider('ULDK returned a parcel ID outside the documented TERYT format.');
        if (expectedNativeId !== null && nativeId !== expectedNativeId) {
            throw invalidProvider('ULDK exact-ID response did not match the requested parcel identity.');
        }
        if (!parts[1].startsWith(`SRID=${OUTPUT_SRID};`)) throw invalidProvider('ULDK returned geometry outside the requested WGS84 SRID.');
        const geometry = canonicalCoordinates(parseUldkPolygonWkt(parts[1].slice(`SRID=${OUTPUT_SRID};`.length)));
        if (!validateGeometry(geometry)) throw invalidProvider('ULDK returned an invalid WGS84 parcel polygon.');
        return canonicalParcelFeature(descriptor, { type: 'Feature', geometry, properties: { [ID_FIELD]: nativeId } }, nativeId);
    }

    async function queryPoint(coordinates) {
        if (!Array.isArray(coordinates) || coordinates.length !== 2
            || !coordinates.every(value => typeof value === 'number' && Number.isFinite(value))
            || coordinates[0] < -180 || coordinates[0] > 180
            || coordinates[1] < -90 || coordinates[1] > 90) throw invalidPoint();
        const [longitude, latitude] = coordinates;
        // ULDK reads xy in the WKT axis order of the stated SRID: longitude,latitude for EPSG:4326.
        const { reply } = await request({ request: 'GetParcelByXY', key: 'xy', value: `${longitude},${latitude},${OUTPUT_SRID}` });
        if (reply.absent) return result([], 'point', { point: [longitude, latitude] });
        const feature = sourceFeature(reply.record);
        let contains;
        try { contains = booleanPointInPolygon(turfPoint([longitude, latitude]), turfFeature(feature.geometry)); }
        catch { throw invalidProvider('ULDK parcel geometry could not be checked against the requested point.'); }
        if (!contains) throw invalidProvider('ULDK returned parcel geometry that does not contain the requested point.');
        return result([feature], 'point', { point: [longitude, latitude] });
    }

    async function queryIds(ids) {
        if (!Array.isArray(ids) || ids.length > MAX_ID_BATCH) throw invalidIds();
        const parsed = [...new Set(ids)].map(parseExactId);
        if (parsed.some(value => value === null)) throw invalidIds();

        const features = [];
        const absentIds = [];
        const deadline = now() + BATCH_TIMEOUT_MS;
        const budgetSignal = AbortSignal.timeout(BATCH_TIMEOUT_MS);
        let remainingBytes = MAX_BATCH_BYTES;
        for (const requested of parsed) {
            if (remainingBytes < 1) throw invalidProvider('ULDK exact-ID response batch exceeds the byte limit.');
            const { reply, bytesRead } = await request({ request: 'GetParcelById', key: 'id', value: requested.nativeId }, {
                deadline, budgetSignal, maxBytes: Math.min(maxResponseBytes, remainingBytes)
            });
            remainingBytes -= bytesRead;
            if (reply.absent) { absentIds.push(requested.id); continue; }
            features.push(sourceFeature(reply.record, requested.nativeId));
        }
        return result(features, 'ids', { absentIds });
    }

    return Object.freeze({
        queryPoint,
        queryIds,
        queryBounds: async () => { throw unsupportedArea(); },
        queryGeometry: async () => { throw unsupportedArea(); }
    });
}
