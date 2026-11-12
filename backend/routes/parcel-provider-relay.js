import express from 'express';
import { parcelSourceCatalog } from '../parcels/sources.js';
import { fetchParcelProviderRelay, validateParcelProviderRelayRequest, validatedManualRedirect, relayError } from '../parcels/provider-relay.js';

// Fixed-source browser transport: small request envelope, bounded upstream concurrency and bytes,
// and only the response metadata required by source adapters (including session cookies and ETags).
// POST carries the full envelope (upstream method, body, cookies, tokens, redirect mode). GET carries
// a plain read of a catalog source in its query string, so the URL alone identifies the answer and
// browsers and Cloudflare may cache a successful one (CACHEABLE).
const RELAY_PATH = '/:sourceId';
const GET_HEADERS = Object.freeze({ referer: 'Referer', accept: 'Accept', 'accept-language': 'Accept-Language' });
const CACHEABLE = 'public, max-age=3600, s-maxage=86400';
const RESPONSE_HEADERS = new Set(['content-type', 'content-disposition', 'content-encoding', 'etag', 'last-modified',
    'retry-after', 'x-parcel-upstream-cookies']);
const EXPOSED_HEADERS = 'Content-Length, Content-Encoding, ETag, Last-Modified, Location, Retry-After, X-Parcel-Upstream-Cookies, X-Parcel-Upstream-Status, X-Parcel-Upstream-Location';

function sendError(res, error) {
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
    if (res.headersSent) return res.destroy();
    // A failure is never cached, by the browser or by Cloudflare.
    res.setHeader('cache-control', 'no-store');
    if (status === 503) res.setHeader('retry-after', '5');
    return res.status(status).json({ error: error?.message || 'Parcel provider is unavailable.', code: error?.code || 'parcel-provider-relay-error' });
}

async function streamResponse(upstream, res, maxBytes, controller, { manualRedirect = null, cacheable = false } = {}) {
    const encoding = upstream.headers.get('content-encoding');
    const declaredLength = (!encoding || encoding.toLowerCase() === 'identity') ? upstream.headers.get('content-length') : null;
    if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)) {
        await upstream.body?.cancel().catch(() => {});
        throw relayError(502, 'Parcel provider response length is invalid.');
    }
    if (!upstream.body && upstream.status === 200 && declaredLength !== null && Number(declaredLength) !== 0) {
        throw relayError(502, 'Parcel provider response length did not match its declaration.');
    }
    res.status(manualRedirect ? 200 : upstream.status);
    for (const [name, value] of upstream.headers) {
        if (RESPONSE_HEADERS.has(name.toLowerCase())) res.setHeader(name, value);
    }
    if (manualRedirect) {
        res.setHeader('x-parcel-upstream-status', String(manualRedirect.status));
        res.setHeader('x-parcel-upstream-location', manualRedirect.location);
    }
    if (declaredLength !== null && upstream.status === 200) res.setHeader('content-length', declaredLength);
    // Only a plain successful read without session state is shared. One cached copy serves every
    // site, so it allows any origin; the read carries no credentials.
    const shared = cacheable && upstream.status === 200 && !upstream.headers.has('x-parcel-upstream-cookies')
        && !upstream.headers.has('set-cookie');
    res.setHeader('cache-control', shared ? CACHEABLE : 'no-store');
    if (shared) res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-expose-headers', EXPOSED_HEADERS);
    if (!upstream.body) return res.end();
    const reader = upstream.body.getReader();
    let size = 0;
    let abortRead;
    const aborted = new Promise((_, reject) => {
        abortRead = () => reject(relayError(504, 'Parcel provider request timed out.'));
        controller.signal.addEventListener('abort', abortRead, { once: true });
        if (controller.signal.aborted) abortRead();
    });
    try {
        for (;;) {
            const { done, value } = await Promise.race([reader.read(), aborted]);
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) throw relayError(502, 'Parcel provider response exceeded the relay limit.');
            if (!res.write(Buffer.from(value))) {
                let onDrain;
                const drained = new Promise(resolve => { onDrain = resolve; res.once('drain', onDrain); });
                try { await Promise.race([drained, aborted]); }
                finally { res.off('drain', onDrain); }
            }
        }
        if (declaredLength !== null && size !== Number(declaredLength)) throw relayError(502, 'Parcel provider response length did not match its declaration.');
        res.end();
    } catch (error) {
        controller.abort();
        try { await reader.cancel(); } catch { /* stream is already closed */ }
        throw error;
    } finally { controller.signal.removeEventListener('abort', abortRead); reader.releaseLock(); }
}

export function createParcelProviderRelayRouter({ sources = parcelSourceCatalog.sources, relayFetch = fetchParcelProviderRelay,
    // The relay only forwards to catalog sources and has no per-visitor request limit: one map view
    // reads dozens of cells. The in-flight cap only bounds open sockets on this host.
    maxConcurrent = 64, maxQueued = 512, queueTimeoutMs = 30000 } = {}) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || !Number.isSafeInteger(maxQueued) || maxQueued < 0
        || !Number.isSafeInteger(queueTimeoutMs) || queueTimeoutMs < 1) throw new TypeError('Invalid parcel provider relay concurrency limits.');
    let active = 0;
    const waiting = [];
    function acquire(signal) {
        if (signal.aborted) return Promise.reject(relayError(499, 'Parcel provider request was cancelled.'));
        if (active < maxConcurrent) { active++; return Promise.resolve(releaseSlot); }
        if (waiting.length >= maxQueued) return Promise.reject(relayError(503, 'Parcel provider relay is busy.'));
        return new Promise((resolve, reject) => {
            const entry = { resolve, reject, signal, timer: null, abort: null };
            const remove = () => { const index = waiting.indexOf(entry); if (index >= 0) waiting.splice(index, 1); };
            const cleanup = () => { clearTimeout(entry.timer); signal.removeEventListener('abort', entry.abort); };
            entry.abort = () => { remove(); cleanup(); reject(relayError(499, 'Parcel provider request was cancelled.')); };
            entry.timer = setTimeout(() => { remove(); cleanup(); reject(relayError(503, 'Parcel provider relay queue timed out.')); }, queueTimeoutMs);
            entry.timer.unref?.();
            signal.addEventListener('abort', entry.abort, { once: true });
            waiting.push(entry);
        });
    }
    function releaseSlot() {
        const entry = waiting.shift();
        if (!entry) { active--; return; }
        clearTimeout(entry.timer);
        entry.signal.removeEventListener('abort', entry.abort);
        entry.resolve(releaseSlot);
    }
    const router = express.Router();
    router.post(RELAY_PATH, express.json({ limit: '32kb', strict: true }), async (req, res) => {
        let validated;
        const declaredRequestBytes = Number(req.get?.('content-length'));
        if (Number.isFinite(declaredRequestBytes) && declaredRequestBytes > 32 * 1024) return sendError(res, relayError(413));
        try {
            if (Buffer.byteLength(JSON.stringify(req.body), 'utf8') > 32 * 1024) return sendError(res, relayError(413));
        } catch { return sendError(res, relayError(400)); }
        try { validated = validateParcelProviderRelayRequest(req.params.sourceId, req.body, { sources }); }
        catch (error) { return sendError(res, error); }
        return relay(req, res, validated, { cacheable: false });
    });
    // ?url=<provider URL>[&referer=…][&accept=…][&accept-language=…][&redirect=error|follow]. Only
    // catalog sources: a visitor's own source (custom.*) or the HMLR archive keeps the POST form.
    router.get(RELAY_PATH, async (req, res) => {
        const query = req.query;
        const allowed = ['url', 'redirect', ...Object.keys(GET_HEADERS)];
        if (!sources.some(source => source.id === req.params.sourceId)) return sendError(res, relayError(404));
        if (typeof query.url !== 'string' || Object.entries(query).some(([key, value]) => !allowed.includes(key) || typeof value !== 'string')
            || query.redirect === 'manual' || req.originalUrl.length > 8192) return sendError(res, relayError(400));
        const headers = Object.fromEntries(Object.entries(GET_HEADERS).filter(([key]) => query[key] !== undefined)
            .map(([key, name]) => [name, query[key]]));
        let validated;
        try {
            validated = validateParcelProviderRelayRequest(req.params.sourceId,
                { url: query.url, method: 'GET', headers, ...(query.redirect === undefined ? {} : { redirect: query.redirect }) }, { sources });
        } catch (error) { return sendError(res, error); }
        return relay(req, res, validated, { cacheable: true });
    });
    async function relay(req, res, validated, { cacheable }) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), validated.timeoutMs);
        timeout.unref?.();
        const cancel = () => controller.abort();
        req.once('aborted', cancel);
        res.once('close', () => { if (!res.writableEnded) cancel(); });
        let release;
        try {
            release = await acquire(controller.signal);
            const upstream = await relayFetch(validated, { signal: controller.signal });
            if (controller.signal.aborted) { await upstream.body?.cancel().catch(() => {}); throw relayError(504, 'Parcel provider request timed out.'); }
            await streamResponse(upstream, res, validated.maxResponseBytes, controller, {
                manualRedirect: validated.redirect === 'manual' ? validatedManualRedirect(upstream) : null, cacheable
            });
        } catch (error) { sendError(res, controller.signal.aborted && !res.writableEnded
            ? relayError(504, 'Parcel provider request timed out.') : error); }
        finally { release?.(); clearTimeout(timeout); req.off('aborted', cancel); }
    }
    return router;
}

export default createParcelProviderRelayRouter;
