// Fixed-source relay transport. Every URL is matched against a registered descriptor before DNS.
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { Readable } from 'node:stream';
import { isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import { createHttpsJsonFetch } from './https-json-fetch.js';
import { createPublicSourceFetch, isPublicSourceAddress, validatePublicSourceUrl } from './public-source-fetch.js';
import { decodeCustomSource } from './custom-source-config.js';
import { officialArchiveFetch } from './gml-snapshot-source.js';

const HMLR = 'https://use-land-property-data.service.gov.uk';
const HMLR_ROOT = `${HMLR}/datasets/inspire/download`;
const HMLR_ZIP = /^\/datasets\/inspire\/download\/[A-Za-z_-]+\.zip$/;
const DDA_VIEWER = 'https://gis.dda.gov.ae/dis/';
const PULSE_TOKEN = 'https://lis.pulse.gop.pk/api/gis/token';
const SHENZHEN_VIEWER = 'https://pnr.sz.gov.cn/d-djtcx/djtcx/index.html';
const SHENZHEN_SCRIPT = 'https://pnr.sz.gov.cn/d-djtcx/djtcx/js/main.js';
const KERALA_APP = 'https://entebhoomi.kerala.gov.in';
const KERALA_MAP = 'https://bhunaksha.entebhoomi.kerala.gov.in';
const BEV_ORIGIN = 'https://kataster.bev.gv.at';
const MAX_REQUEST_BYTES = 16 * 1024;
const NO_REDIRECT = new Set(['error', 'manual', 'follow']);
const safeManualRedirects = new WeakMap();

export const HMLR_BROWSER_DESCRIPTOR = Object.freeze({
    id: 'gb-hmlr-browser-v1', name: 'HM Land Registry INSPIRE archive', adapter: 'gml-snapshot',
    endpoint: HMLR_ROOT, countryCode: 'GB'
});

function relayError(status, message = 'Parcel provider relay request rejected.') {
    return Object.assign(new Error(message), { status, code: 'parcel-provider-relay-error' });
}
export function validatedManualRedirect(response) { return safeManualRedirects.get(response) || null; }

function exactResource(url, resource) {
    try {
        const expected = new URL(resource);
        return url.origin === expected.origin && url.pathname === expected.pathname;
    } catch { return false; }
}

function descriptorResources(descriptor) {
    const resources = [];
    if (typeof descriptor.endpoint === 'string') resources.push(descriptor.endpoint);
    if (typeof descriptor.catalogueUrl === 'string') resources.push(descriptor.catalogueUrl);
    if (typeof descriptor.manifestUrl === 'string') resources.push(descriptor.manifestUrl);
    for (const resource of descriptor.snapshots || []) if (typeof resource.endpoint === 'string') resources.push(resource.endpoint);
    if (descriptor.adapter === 'arcgis' || ['dda-public-plots', 'pulse-public', 'shenzhen-land-certain'].includes(descriptor.adapter)) {
        try { resources.push(`${new URL(descriptor.endpoint).origin}${new URL(descriptor.endpoint).pathname.replace(/\/$/, '')}/query`); } catch { /* rejected below */ }
    }
    if (descriptor.adapter === 'dda-public-plots' || descriptor.id === 'ae-dubai-municipality-public-plots') resources.push(DDA_VIEWER);
    if (descriptor.adapter === 'pulse-public') resources.push(PULSE_TOKEN);
    if (descriptor.adapter === 'shenzhen-land-certain') resources.push(SHENZHEN_VIEWER, SHENZHEN_SCRIPT);
    if (descriptor.adapter === 'kerala-entebhoomi') {
        const code = descriptor.locationCode;
        if (typeof code === 'string' && /^\d{6}$/.test(code)) {
            for (const path of ['/web/taluk/gid', '/web/village/gid', '/web/ilms/map/view', `/web/proxy/mapinfo/feature_info/${code}`]) {
                resources.push(`${KERALA_APP}${path}`);
            }
            resources.push(`${KERALA_MAP}/bhunaksha_v5_emaps/core/v2/map/export/geojson/${code}`);
        }
    }
    if (descriptor.adapter === 'catastro-wfs') resources.push('https://ovc.catastro.meh.es/INSPIRE/wfsCP.aspx');
    if (isHmlr(descriptor)) resources.push(HMLR_ROOT);
    return [...new Set(resources)];
}

function bevResourceAllowed(url) {
    if (url.origin !== BEV_ORIGIN) return false;
    const tile = /^\/tiles\/kataster\/(0|[1-9]|1[0-6])\/(0|[1-9][0-9]*)\/(0|[1-9][0-9]*)\.pbf$/.exec(url.pathname);
    if (tile) {
        const z = Number(tile[1]), x = Number(tile[2]), y = Number(tile[3]);
        return Number.isSafeInteger(x) && Number.isSafeInteger(y) && x < 2 ** z && y < 2 ** z;
    }
    if (url.pathname === '/at.gv.bev.kataster/api/all/') {
        return url.searchParams.getAll('term').length === 1 && url.searchParams.getAll('layers').length === 1
            && (url.searchParams.get('term') || '').length <= 256 && url.searchParams.get('layers') === 'GST-KG'
            && [...url.searchParams.keys()].every(key => ['term', 'layers'].includes(key));
    }
    if (/^\/at\.gv\.bev\.kataster\/api\/gst\/[0-9]{5,6}\/[1-9][0-9]*(?:\/[1-9][0-9]*)?\/$/.test(url.pathname)) {
        return url.search === '';
    }
    return false;
}

function ogcItemResourceAllowed(url, descriptor) {
    if (descriptor.adapter !== 'ogc-api' || typeof descriptor.endpoint !== 'string') return false;
    try {
        const base = new URL(descriptor.endpoint);
        if (url.origin !== base.origin || url.username || url.password || url.hash) return false;
        if (url.pathname === base.pathname) return true;
        const match = new RegExp(`^${base.pathname.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}/([A-Za-z0-9._~-]{1,256})$`).exec(url.pathname);
        return Boolean(match);
    } catch { return false; }
}

function adapterDynamicResourceAllowed(url, descriptor) {
    if (!descriptor.endpoint) return false;
    let endpoint;
    try { endpoint = new URL(descriptor.endpoint); } catch { return false; }
    if (url.origin !== endpoint.origin || url.username || url.password || url.hash) return false;
    const basePath = endpoint.pathname.replace(/\/$/, '');
    if (descriptor.adapter === 'msda-point') {
        return new RegExp(`^${basePath.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}/(?:search-by-xy|unified-search)$`).test(url.pathname);
    }
    if (descriptor.adapter === 'tkgm-point') {
        const prefix = basePath.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
        const point = new RegExp(`^${prefix}/(-?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:e[+-]?[0-9]+)?)/(-?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:e[+-]?[0-9]+)?)$`, 'i').exec(url.pathname);
        if (point) return Number.isFinite(Number(point[1])) && Math.abs(Number(point[1])) <= 90
            && Number.isFinite(Number(point[2])) && Math.abs(Number(point[2])) <= 180;
        return new RegExp(`^${prefix}/[0-9]{1,20}/[0-9]{1,20}/[0-9]{1,20}$`).test(url.pathname);
    }
    return false;
}

function isHmlr(descriptor) {
    return descriptor.adapter === 'gml-snapshot'
        && (descriptor.id === HMLR_BROWSER_DESCRIPTOR.id || descriptor.endpoint?.startsWith(`${HMLR_ROOT}/`))
        || descriptor.id === HMLR_BROWSER_DESCRIPTOR.id;
}

function resourceAllowed(url, descriptor, sourceId) {
    if (sourceId.startsWith('custom.')) {
        const endpoint = new URL(descriptor.endpoint);
        if (url.origin === endpoint.origin && (url.pathname === endpoint.pathname
            || descriptor.adapter === 'arcgis' && url.pathname === `${endpoint.pathname.replace(/\/$/, '')}/query`)) return true;
        return false;
    }
    if (isHmlr(descriptor) && url.origin === HMLR && !url.search && (url.pathname === new URL(HMLR_ROOT).pathname || HMLR_ZIP.test(url.pathname))) {
        return true;
    }
    if (descriptor.adapter === 'hmlr-browser' && hmlrMetadataResourceAllowed(url, descriptor)) return true;
    if (descriptor.adapter === 'bev-tiles' && descriptor.endpoint === 'https://kataster.bev.gv.at/tiles/kataster/{z}/{x}/{y}.pbf'
        && bevResourceAllowed(url)) return true;
    if (ogcItemResourceAllowed(url, descriptor)) return true;
    if (adapterDynamicResourceAllowed(url, descriptor)) return true;
    const resources = descriptorResources(descriptor);
    return resources.some(resource => {
        if (isHmlr(descriptor) && resource === HMLR_ROOT) return url.origin === HMLR
            && url.pathname === new URL(HMLR_ROOT).pathname && !url.search;
        if (descriptor.adapter === 'hmlr-browser' && resource === descriptor.manifestUrl) return url.href === new URL(resource).href;
        return exactResource(url, resource);
    });
}

function hmlrMetadataResourceAllowed(url, descriptor) {
    let root;
    try {
        const manifest = new URL(descriptor.manifestUrl);
        if (manifest.protocol !== 'https:' || manifest.username || manifest.password || manifest.port || manifest.search || manifest.hash
            || !manifest.pathname.endsWith('/manifest.json')) return false;
        root = manifest.pathname.slice(0, -'manifest.json'.length);
        const versioned = /\/([a-f0-9]{64})\/$/.exec(root);
        if (versioned) root = root.slice(0, -versioned[1].length - 1);
        if (url.origin !== manifest.origin || url.username || url.password || url.search || url.hash) return false;
        if (url.pathname === manifest.pathname) return true;
        return new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[a-f0-9]{64}/ids/(?:[0-9]{1,4})\\.[a-f0-9]{64}\\.json$`).test(url.pathname);
    } catch { return false; }
}

function normalizeTarget(sourceId, descriptor, input) {
    if (typeof input?.url !== 'string' || input.url.length > 16384) throw relayError(400);
    let target;
    try { target = new URL(input.url); } catch { throw relayError(400); }
    if (target.protocol !== 'https:' || target.username || target.password || target.hash || !resourceAllowed(target, descriptor, sourceId)) {
        throw relayError(403, 'Parcel provider URL is outside this source.');
    }
    if (sourceId.startsWith('custom.')) {
        try { validatePublicSourceUrl(target.href); } catch { throw relayError(403, 'Parcel provider URL is outside this source.'); }
    }
    if (descriptor.adapter === 'dgu-wfs') {
        const token = target.searchParams.getAll('token');
        if (token.length !== 1 || token[0] !== 'browser-relay') throw relayError(400);
        const serverToken = process.env.OSS_PUBLIC_ACCESS_TOKEN || process.env.OSS_TOKEN;
        if (typeof serverToken !== 'string' || !serverToken || serverToken.length > 8192 || /[\r\n\0]/.test(serverToken)) {
            throw relayError(503, 'Parcel provider relay is unavailable.');
        }
        target.searchParams.set('token', serverToken);
    }
    return target;
}

const keralaReferrers = new Set([`${KERALA_APP}/web/ilms/map`, `${KERALA_APP}/web/ilms/map/view`]);
function relayRequestHeaders(input, descriptor, target, method) {
    if (input === undefined) input = {};
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw relayError(400);
    const headers = new Headers();
    const shared = new Set(['accept', 'content-type', 'accept-language']);
    const special = descriptor.adapter;
    const permitted = new Set(shared);
    if (isHmlr(descriptor) && target.origin === HMLR) permitted.add('if-match');
    if (special === 'dlrs-sheet') permitted.add('referer');
    if (['dda-public-plots', 'pulse-public', 'shenzhen-land-certain', 'kerala-entebhoomi'].includes(special)) {
        permitted.add('referer'); permitted.add('origin');
    }
    if (special === 'shenzhen-land-certain') permitted.add('x-openapi-subscriptiontoken');
    if (special === 'kerala-entebhoomi') { permitted.add('cookie'); permitted.add('x-csrf-token'); }
    for (const [name, value] of Object.entries(input)) {
        const key = name.toLowerCase();
        if (!permitted.has(key) || typeof value !== 'string' || value.length > 8192 || /[\r\n\0]/.test(value)) throw relayError(400);
        if (key === 'if-match' && (!isHmlr(descriptor) || target.origin !== HMLR || !/^"[\x21\x23-\x7e]{1,200}"$/.test(value))) throw relayError(400);
        if (key === 'referer') {
            let referrer;
            try { referrer = new URL(value); } catch { throw relayError(400); }
            const valid = special === 'dda-public-plots' ? value === DDA_VIEWER
                : special === 'pulse-public' ? value === 'https://lis.pulse.gop.pk/'
                : special === 'shenzhen-land-certain' ? value === SHENZHEN_VIEWER
                : special === 'dlrs-sheet' ? value === 'https://settlement.gov.bd/'
                : special === 'kerala-entebhoomi' ? keralaReferrers.has(value) : false;
            if (!valid || referrer.protocol !== 'https:') throw relayError(400);
        }
        if (key === 'origin') {
            const valid = special === 'shenzhen-land-certain' && value === 'https://pnr.sz.gov.cn'
                || special === 'kerala-entebhoomi' && [KERALA_APP, KERALA_MAP].includes(value);
            if (!valid) throw relayError(400);
        }
        if (key === 'x-openapi-subscriptiontoken' && special !== 'shenzhen-land-certain') throw relayError(400);
        if ((key === 'cookie' || key === 'x-csrf-token') && special !== 'kerala-entebhoomi') throw relayError(400);
        headers.set(key, value);
    }
    const contentType = headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (method === 'POST' && !['application/x-www-form-urlencoded', 'application/json'].includes(contentType || '')) throw relayError(400);
    if (descriptor.adapter === 'kerala-entebhoomi' && headers.has('cookie') && target.origin !== KERALA_APP && target.origin !== KERALA_MAP) throw relayError(400);
    return headers;
}

export function validateParcelProviderRelayRequest(sourceId, input, { sources = [] } = {}) {
    if (typeof sourceId !== 'string' || !sourceId || sourceId.length > 4096) throw relayError(404);
    let descriptor = sources.find(source => source.id === sourceId);
    if (!descriptor && sourceId === HMLR_BROWSER_DESCRIPTOR.id) descriptor = HMLR_BROWSER_DESCRIPTOR;
    if (!descriptor && sourceId.startsWith('custom.')) {
        try { descriptor = decodeCustomSource(sourceId); } catch { throw relayError(404); }
    }
    if (!descriptor) throw relayError(404);
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['url', 'method', 'headers', 'body', 'redirect'].includes(key))) throw relayError(400);
    const method = input.method ?? 'GET';
    if (!['GET', 'POST'].includes(method) || (input.redirect !== undefined && !NO_REDIRECT.has(input.redirect))) throw relayError(400);
    const target = normalizeTarget(sourceId, descriptor, input);
    const headers = relayRequestHeaders(input.headers, descriptor, target, method);
    const body = input.body;
    if (method === 'GET' && body !== undefined && body !== null || method === 'POST' && typeof body !== 'string') throw relayError(400);
    if (method === 'POST' && Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) throw relayError(413);
    if (sourceId.startsWith('custom.') && method === 'POST' && headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
        throw relayError(400);
    }
    return { sourceId, descriptor, target, method, headers, body: body ?? undefined, redirect: input.redirect,
        hmlr: isHmlr(descriptor) && target.origin === HMLR, custom: sourceId.startsWith('custom.'),
        maxResponseBytes: responseByteLimit(descriptor, target),
        timeoutMs: isHmlr(descriptor) || descriptor.snapshotFormat === 'shapefile-zip' ? 60000 : 15000 };
}

function responseByteLimit(descriptor, target) {
    const declared = descriptor.maxResponseBytes ?? descriptor.maxSnapshotBytes;
    if (isHmlr(descriptor) && target?.origin === HMLR) return Number.isSafeInteger(declared) && declared > 0
        ? Math.min(declared, 128 * 1024 * 1024) : 128 * 1024 * 1024;
    if (descriptor.adapter === 'hmlr-browser' && hmlrMetadataResourceAllowed(target, descriptor)) return Number.isSafeInteger(declared) && declared > 0
        ? Math.min(declared, 16 * 1024 * 1024) : 16 * 1024 * 1024;
    if (Number.isSafeInteger(declared) && declared > 0) return Math.min(declared, 128 * 1024 * 1024);
    return 16 * 1024 * 1024;
}

export function createProviderRelayFetch({ lookupImpl = lookup, requestImpl = request } = {}) {
    return async function providerRelayFetch(target, { method = 'GET', headers = new Headers(), body, signal,
        userAgent = 'consensus-builder/1.0 (+https://urbangametheory.xyz)' } = {}) {
        if (!(target instanceof URL) || target.protocol !== 'https:' || target.username || target.password || target.hash
            || !['GET', 'POST'].includes(method) || (method === 'GET' && body !== undefined)
            || (method === 'POST' && (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES))) throw relayError(400);
        const host = target.hostname.replace(/^\[|\]$/g, '');
        let answers;
        try { answers = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookupImpl(host, { all: true, verbatim: true }); }
        catch { throw relayError(502, 'Parcel provider is unavailable.'); }
        if (!Array.isArray(answers) || !answers.length || answers.some(answer => !isPublicSourceAddress(answer.address)
            || answer.family !== isIP(answer.address))) throw relayError(403, 'Parcel provider address is not public.');
        if (signal?.aborted) throw relayError(499, 'Parcel provider request was cancelled.');
        const address = answers[0];
        return new Promise((resolve, reject) => {
            let req, settled = false;
            const finishError = error => { if (settled) return; settled = true; signal?.removeEventListener('abort', abort); req?.destroy(); reject(error); };
            const abort = () => finishError(relayError(499, 'Parcel provider request was cancelled.'));
            signal?.addEventListener('abort', abort, { once: true });
            try {
                const out = Object.fromEntries(headers.entries());
                out['Accept-Encoding'] = 'identity';
                out['User-Agent'] = userAgent;
                if (method === 'POST') out['Content-Length'] = String(Buffer.byteLength(body, 'utf8'));
                req = requestImpl({ protocol: 'https:', hostname: host, port: target.port || 443,
                    path: `${target.pathname}${target.search}`, method, agent: false, servername: isIP(host) ? undefined : host,
                    rejectUnauthorized: true, headers: out, lookup: (_hostname, options, callback) => {
                        if (typeof options === 'function') { callback = options; options = {}; }
                        if (options?.all) callback(null, [{ ...address }]); else callback(null, address.address, address.family);
                    } }, incoming => {
                    if (settled) { incoming.destroy(); return; }
                    settled = true; signal?.removeEventListener('abort', abort);
                    const responseHeaders = new Headers();
                    const skip = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'set-cookie']);
                    for (const [name, value] of Object.entries(incoming.headers)) {
                        if (!skip.has(name.toLowerCase()) && value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : String(value));
                    }
                    const cookies = incoming.headers['set-cookie'];
                    if (cookies) responseHeaders.set('x-parcel-upstream-cookies', JSON.stringify(Array.isArray(cookies) ? cookies : [String(cookies)]));
                    const bodyStream = [204, 205, 304].includes(incoming.statusCode) ? null : Readable.toWeb(incoming);
                    if (!bodyStream) incoming.resume();
                    const response = new Response(bodyStream, { status: incoming.statusCode, headers: responseHeaders });
                    Object.defineProperty(response, 'url', { value: target.href });
                    resolve(response);
                });
                req.once('error', () => finishError(relayError(502, 'Parcel provider is unavailable.')));
                if (signal?.aborted) abort(); else req.end(method === 'POST' ? body : undefined);
            } catch { finishError(relayError(502, 'Parcel provider is unavailable.')); }
        });
    };
}

const caFetches = new Map();
async function getCaFetch(descriptor, { caFetchFactory } = {}) {
    if (caFetchFactory) return caFetchFactory(descriptor);
    if (!descriptor.caCertificate || !/^\.\/certificates\/[A-Za-z0-9._-]+\.pem$/.test(descriptor.caCertificate)) throw relayError(502);
    if (!caFetches.has(descriptor.caCertificate)) {
        const pem = await readFile(new URL(descriptor.caCertificate, import.meta.url), 'utf8');
        caFetches.set(descriptor.caCertificate, createHttpsJsonFetch(pem, { maxBytes: 16 * 1024 * 1024 }));
    }
    return caFetches.get(descriptor.caCertificate);
}

export async function fetchParcelProviderRelay(request, options = {}) {
    const { descriptor, target, method, headers, body, custom, hmlr, timeoutMs, redirect } = request;
    const fetchOptions = { method, headers, ...(body === undefined ? {} : { body }), signal: options.signal };
    if (hmlr) return (options.archiveFetch || officialArchiveFetch)(target.href, { signal: options.signal, headers, redirect: redirect ?? 'follow' });
    let transport;
    if (custom) {
        const publicFetch = options.publicFetch || createPublicSourceFetch({ maxBytes: request.maxResponseBytes });
        transport = (url, init) => publicFetch(url.href, { ...init, redirect: 'error' });
    } else if (descriptor.caCertificate) {
        const caFetch = await getCaFetch(descriptor, options);
        transport = (url, init) => caFetch(url.href, init);
    }
    const userAgent = descriptor.adapter === 'dlrs-sheet'
        ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
        : descriptor.adapter === 'catastro-wfs'
            ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
            : descriptor.adapter === 'kerala-entebhoomi'
                ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
                : undefined;
    if (!transport) {
        const providerFetch = options.providerFetch || createProviderRelayFetch();
        transport = (url, init) => providerFetch(url, { ...init, ...(userAgent ? { userAgent } : {}) }, { timeoutMs });
    }
    let current = target, currentMethod = method, currentHeaders = new Headers(headers), currentBody = body;
    const redirectMode = redirect ?? 'none';
    for (let hops = 0; hops <= 6; hops++) {
        const response = await transport(current, { method: currentMethod, headers: currentHeaders,
            ...(currentBody === undefined ? {} : { body: currentBody }), signal: options.signal });
        if (![301, 302, 303, 307, 308].includes(response.status) || redirectMode === 'none') return response;
        const location = response.headers.get('location');
        if (redirectMode === 'error') { await response.body?.cancel().catch(() => {}); throw relayError(502, 'Parcel provider redirected when redirects were disabled.'); }
        if (!location) return response;
        let next;
        try { next = normalizeTarget(request.sourceId, descriptor, { url: new URL(location, current).href }); }
        catch { await response.body?.cancel().catch(() => {}); throw relayError(403, 'Parcel provider redirect is outside this source.'); }
        if (redirectMode === 'manual') { safeManualRedirects.set(response, { status: response.status, location: next.href }); return response; }
        if (redirectMode !== 'follow' || hops === 6) { await response.body?.cancel().catch(() => {}); throw relayError(502, 'Parcel provider redirect limit exceeded.'); }
        await response.body?.cancel().catch(() => {});
        if ((response.status === 301 || response.status === 302 || response.status === 303) && currentMethod === 'POST') {
            currentMethod = 'GET'; currentBody = undefined; currentHeaders.delete('content-type');
        }
        if (next.origin !== current.origin) {
            for (const name of ['cookie', 'x-csrf-token', 'origin', 'referer']) currentHeaders.delete(name);
        }
        current = next;
    }
    throw relayError(502, 'Parcel provider redirect limit exceeded.');
}

export { relayError };
