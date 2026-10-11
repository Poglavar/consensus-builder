// A bounded fetch retry loop for idempotent HTTP requests. Callers must explicitly opt in
// non-GET/HEAD methods only when replaying the request is safe.
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_RETRY_METHODS = new Set(['GET', 'HEAD']);

function transientHttpReason(response) {
    return [408, 429].includes(response.status) || response.status >= 500
        ? `HTTP ${response.status}`
        : null;
}

export function createRetryingFetch({ fetchImpl = globalThis.fetch, attempts = 4,
    firstDelayMs = 1000, maxDelayMs = 10000, timeoutMs = 15000, wait = delay,
    retryMethods = DEFAULT_RETRY_METHODS, shouldRetryRequest = null, inspectResponse = null,
    requestLabel = ({ method }) => method.toLowerCase(),
    log = message => console.warn(`[${new Date().toISOString()}] [fetch-retry] ${message}`) } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('a fetch implementation is required');
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 6) throw new Error('fetch attempts must be between 1 and 6');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('fetch timeout must be a positive number of milliseconds');

    const permittedMethods = retryMethods instanceof Set ? retryMethods : new Set(retryMethods || []);
    const canRetry = shouldRetryRequest || (({ method }) => permittedMethods.has(method));
    return async function retryingFetch(input, init = {}) {
        const method = String(init.method || 'GET').toUpperCase();
        const request = { input, init, method };
        const limit = canRetry(request) ? attempts : 1;
        const candidateLabel = String(requestLabel(request) || 'request');
        const label = /^[A-Za-z][A-Za-z0-9,._-]{0,79}$/.test(candidateLabel) ? candidateLabel : 'request';
        for (let attempt = 1; attempt <= limit; attempt += 1) {
            let response;
            let reason;
            try {
                init.signal?.throwIfAborted();
                const timeout = AbortSignal.timeout(timeoutMs);
                const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
                response = await fetchImpl(input, { ...init, signal });
                reason = transientHttpReason(response);
                if (!reason && response.ok && inspectResponse) reason = await inspectResponse(response, request);
                if (!reason || attempt === limit) return response;
            } catch (error) {
                if (init.signal?.aborted || attempt === limit) throw error;
                reason = 'transport failure';
            }

            const retryAfter = Number(response?.headers?.get?.('retry-after'));
            const backoff = Math.min(maxDelayMs, Math.max(firstDelayMs * 2 ** (attempt - 1),
                Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0));
            try { await response?.body?.cancel?.(); } catch { /* release a transient response before retrying */ }
            // Labels and reasons are caller supplied; constrain what can reach logs so URLs, body
            // content, parameters, and provider error text are never included.
            const safeReason = typeof reason === 'string' && /^(?:HTTP \d{3}|RPC -?\d+|transport failure|invalid RPC response)$/.test(reason)
                ? reason
                : 'transient failure';
            log(`${label}: ${safeReason}; retry ${attempt + 1}/${limit} in ${backoff} ms`);
            await wait(backoff, undefined, init.signal ? { signal: init.signal } : undefined);
        }
    };
}
