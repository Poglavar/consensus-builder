// MapMoa's duplicate chunked header needs fetch's HTTP parser; retain public DNS pinning and TLS verification.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent } from 'undici';
import { isPublicSourceAddress } from './public-source-fetch.js';
import { CHEONGJU_ENDPOINT } from './cheongju-mapmoa-source.js';
import { upstreamError } from './source-contract.js';

export async function fetchCheongjuMapmoa(url, options = {}, { fetchImpl = globalThis.fetch, lookupImpl = lookup,
    dispatcherFactory = address => new Agent({ connect: { rejectUnauthorized: true,
        lookup: (_host, config, callback) => config?.all ? callback(null, [address]) : callback(null, address.address, address.family) } }) } = {}) {
    const target = new URL(url);
    if (target.origin + target.pathname !== CHEONGJU_ENDPOINT || target.username || target.password || target.hash
        || ![undefined, 'GET'].includes(options.method) || options.body !== undefined) throw upstreamError('Invalid MapMoa relay resource.', 400);
    const answers = await lookupImpl(target.hostname, { all: true, verbatim: true });
    if (!answers.length || answers.some(address => !isPublicSourceAddress(address.address)
        || address.family !== isIP(address.address))) throw upstreamError('MapMoa address is not public.', 403);
    const dispatcher = dispatcherFactory(answers[0]);
    let response;
    try {
        response = await fetchImpl(target.href, { method: 'GET', headers: options.headers, signal: options.signal,
            credentials: 'omit', redirect: 'error', dispatcher });
    } catch (error) { await dispatcher.destroy(); throw error; }
    const headers = new Headers(response.headers);
    // The provider sends subtype=gml/3.1.1 without quotes, which Express cannot parse.
    if (/^text\/xml\s*;/i.test(headers.get('content-type') || '')) headers.set('content-type', 'text/xml; charset=UTF-8');
    headers.delete('set-cookie');
    if (!response.body) { await dispatcher.destroy(); return new Response(null, { status: response.status, headers }); }
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
                if (chunk.done) { await close(); controller.close(); return; }
                bytes += chunk.value.byteLength;
                if (bytes > 2 * 1024 * 1024) throw upstreamError('MapMoa relay exceeded the byte limit.');
                controller.enqueue(chunk.value);
            } catch (error) { await close(error); controller.error(error); }
        },
        cancel: close
    });
    return new Response(body, { status: response.status, headers });
}
