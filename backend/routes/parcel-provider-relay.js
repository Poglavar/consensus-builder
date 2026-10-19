import express from 'express';
import rateLimit from 'express-rate-limit';
import { parcelSourceCatalog } from '../parcels/sources.js';
import { fetchParcelProviderRelay, validateParcelProviderRelayRequest, validatedManualRedirect, relayError } from '../parcels/provider-relay.js';

// Fixed-source browser transport: small request envelope, bounded upstream concurrency and bytes,
// and only the response metadata required by source adapters (including session cookies and ETags).
const RELAY_PATH = '/:sourceId';
const RESPONSE_HEADERS = new Set(['content-type', 'content-disposition', 'content-encoding', 'etag', 'last-modified',
    'retry-after', 'x-parcel-upstream-cookies']);
const EXPOSED_HEADERS = 'Content-Length, Content-Encoding, ETag, Last-Modified, Location, Retry-After, X-Parcel-Upstream-Cookies, X-Parcel-Upstream-Status, X-Parcel-Upstream-Location, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset';

function sendError(res, error) {
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
    if (res.headersSent) return res.destroy();
    if (status === 503) res.setHeader('retry-after', '5');
    return res.status(status).json({ error: error?.message || 'Parcel provider is unavailable.', code: error?.code || 'parcel-provider-relay-error' });
}

async function streamResponse(upstream, res, maxBytes, controller, { manualRedirect = null } = {}) {
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
    res.setHeader('cache-control', 'no-store');
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
    maxConcurrent = 6, maxQueued = 24, queueTimeoutMs = 5000,
    limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false,
        message: { error: 'Parcel provider relay rate limit exceeded.', code: 'parcel-provider-rate-limited' } }) } = {}) {
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
    router.post(RELAY_PATH, limiter, express.json({ limit: '32kb', strict: true }), async (req, res) => {
        let validated;
        const declaredRequestBytes = Number(req.get?.('content-length'));
        if (Number.isFinite(declaredRequestBytes) && declaredRequestBytes > 32 * 1024) return sendError(res, relayError(413));
        try {
            if (Buffer.byteLength(JSON.stringify(req.body), 'utf8') > 32 * 1024) return sendError(res, relayError(413));
        } catch { return sendError(res, relayError(400)); }
        try { validated = validateParcelProviderRelayRequest(req.params.sourceId, req.body, { sources }); }
        catch (error) { return sendError(res, error); }
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
                manualRedirect: validated.redirect === 'manual' ? validatedManualRedirect(upstream) : null
            });
        } catch (error) { sendError(res, controller.signal.aborted && !res.writableEnded
            ? relayError(504, 'Parcel provider request timed out.') : error); }
        finally { release?.(); clearTimeout(timeout); req.off('aborted', cancel); }
    });
    return router;
}

export default createParcelProviderRelayRouter;
