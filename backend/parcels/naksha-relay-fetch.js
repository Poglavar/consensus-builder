// NAKSHA responds to Fetch while the legacy node:https relay stalls.
// Use Fetch with public DNS pinning, normal TLS verification and bounded streams.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent } from 'undici';
import { isPublicSourceAddress } from './public-source-fetch.js';
import { upstreamError } from './source-contract.js';

import { NAKSHA_PUBLIC_TOKEN_URL, NAKSHA_PARCEL_LAYER } from './naksha-public-fetch.js';

export async function fetchNakshaRelay(url, options = {}, { fetchImpl = globalThis.fetch, lookupImpl = lookup,
    dispatcherFactory = address => new Agent({ connect: { rejectUnauthorized: true,
        lookup: (_host, config, callback) => config?.all ? callback(null, [address]) : callback(null, address.address, address.family) } }) } = {}) {
    const target = new URL(url);
    const tokenRequest = target.href === NAKSHA_PUBLIC_TOKEN_URL;
    if ((!tokenRequest && target.origin + target.pathname !== NAKSHA_PARCEL_LAYER)
        || target.username || target.password || target.hash
        || (tokenRequest && (options.method !== 'POST' || options.body !== '{}'))
        || ![undefined, 'GET', 'POST'].includes(options.method)
        || (options.method !== 'POST' && options.body !== undefined)
        || (options.method === 'POST' && (typeof options.body !== 'string' || Buffer.byteLength(options.body) > 16384))) {
        throw upstreamError('Invalid NAKSHA relay resource.', 400);
    }
    const answers = await lookupImpl(target.hostname, { all: true, verbatim: true });
    if (!answers.length || answers.some(address => !isPublicSourceAddress(address.address)
        || address.family !== isIP(address.address))) throw upstreamError('NAKSHA address is not public.', 403);
    const address = answers[0];
    const dispatcher = dispatcherFactory(address);
    let response;
    try {
        response = await fetchImpl(target.href, { ...options, credentials: 'omit', redirect: 'error', dispatcher });
    } catch (error) { await dispatcher.destroy(); throw error; }
    if (!response.body) { await dispatcher.destroy(); return response; }
    const reader = response.body.getReader();
    let bytes = 0, closed = false;
    async function close(reason) {
        if (closed) return;
        closed = true;
        try { await reader.cancel(reason).catch(() => {}); } finally { reader.releaseLock(); await dispatcher.destroy(); }
    }
    const body = new ReadableStream({
        async pull(controller) {
            try {
                const chunk = await reader.read();
                if (chunk.done) { controller.close(); await close(); return; }
                bytes += chunk.value.byteLength;
                if (bytes > (tokenRequest ? 16384 : 16 * 1024 * 1024)) throw upstreamError('NAKSHA response exceeds the byte limit.');
                controller.enqueue(chunk.value);
            } catch (error) { controller.error(error); await close(error); }
        },
        cancel: close
    });
    // Fetch has already decoded compressed bytes. Forwarding the upstream encoding
    // or compressed length would make the browser decode the parcel JSON twice.
    const headers = new Headers(response.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    headers.delete('set-cookie');
    return new Response(body, { status: response.status, headers });
}
