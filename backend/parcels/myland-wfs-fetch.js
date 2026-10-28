// MyLand intermittently stalls before headers and exceeds fetch's default connect timeout.
// Reuse healthy HTTP/1 connections and bound pre-response retries within the WFS deadline.
import { Agent } from 'undici';
import { upstreamError } from './source-contract.js';
import { MYLAND_ENDPOINT } from './myland-wfs-source.js';
export { MYLAND_SOURCE_ID, MYLAND_ENDPOINT, isMylandWfsSource } from './myland-wfs-source.js';

const dispatcher = new Agent({ connect: { timeout: 10000, rejectUnauthorized: true },
    connections: 2, pipelining: 1, keepAliveTimeout: 4000 });

export async function fetchMylandWfs(url, options = {}, { fetchImpl = globalThis.fetch, headersTimeoutMs = 12000 } = {}) {
    const target = new URL(url);
    if (target.origin + target.pathname !== MYLAND_ENDPOINT || target.username || target.password || target.hash
        || ![undefined, 'GET'].includes(options.method) || options.body !== undefined
        || target.searchParams.getAll('propertyName').length !== 1
        || target.searchParams.get('propertyName') !== 'geom') {
        throw upstreamError('Invalid MyLand parcel resource.', 400);
    }
    // Keep the caller's fetch so qualification observes the actual provider requests.
    // The WFS adapter retains its cancellation, streamed byte cap and exact-ID checks.
    const deadline = options.signal || AbortSignal.timeout(45000);
    for (let attempt = 0; attempt < 3; attempt++) {
        deadline.throwIfAborted();
        const headerDeadline = new AbortController();
        const timer = setTimeout(() => headerDeadline.abort(), headersTimeoutMs);
        const signal = AbortSignal.any([deadline, headerDeadline.signal]);
        try {
            return await fetchImpl(target.href, { ...options, signal, credentials: 'omit', redirect: 'error', dispatcher });
        } catch (error) {
            // Retry only an idempotent GET that failed before receiving HTTP headers.
            // HTTP denials, partial bodies and caller cancellations remain failures.
            if (deadline.aborted) throw error;
            const transient = headerDeadline.signal.aborted
                || ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'ECONNRESET'].includes(error.cause?.code || error.code)
                || error.code === 'parcel-provider-relay-error' && error.status === 502;
            if (attempt === 2 || !transient) {
                // A local header deadline is a gateway timeout, never a provider access denial.
                if (headerDeadline.signal.aborted) throw upstreamError('Parcel provider timed out.', 504);
                throw error;
            }
        } finally { clearTimeout(timer); }
    }
}
