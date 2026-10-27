// Guangxi's published IPv6 route responds here while both IPv4 routes time out.
// Prefer the current public AAAA answer, retaining hostname/SNI and normal TLS checks.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent } from 'undici';
import { isPublicSourceAddress } from './public-source-fetch.js';
import { upstreamError } from './source-contract.js';

export const GUANGXI_SOURCE_ID = 'cn-gx-tianditu-zongdi-natural-building';
export const GUANGXI_ENDPOINT = 'https://guangxi.tianditu.gov.cn/mapgxservice/rest/services/TMP/oldTM260414new/MapServer/8';
export function isGuangxiParcelSource(descriptor) {
    return descriptor?.id === GUANGXI_SOURCE_ID && descriptor.adapter === 'arcgis'
        && descriptor.endpoint === GUANGXI_ENDPOINT;
}

export async function fetchGuangxiParcel(url, options = {}, { fetchImpl = globalThis.fetch, lookupImpl = lookup,
    dispatcherFactory = address => new Agent({ connect: { rejectUnauthorized: true,
        lookup: (_host, config, callback) => config?.all ? callback(null, [address]) : callback(null, address.address, address.family) } }) } = {}) {
    const target = new URL(url);
    if (target.origin + target.pathname !== `${GUANGXI_ENDPOINT}/query` || target.username || target.password || target.hash
        || ![undefined, 'GET', 'POST'].includes(options.method)
        || (options.method !== 'POST' && options.body !== undefined)
        || (options.method === 'POST' && (typeof options.body !== 'string' || Buffer.byteLength(options.body) > 16384))) {
        throw upstreamError('Invalid Guangxi parcel resource.', 400);
    }
    const answers = await lookupImpl(target.hostname, { all: true, verbatim: true });
    if (!answers.length || answers.some(address => !isPublicSourceAddress(address.address)
        || address.family !== isIP(address.address))) throw upstreamError('Guangxi parcel address is not public.', 403);
    const address = answers.find(answer => answer.family === 6) || answers[0];
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
                if (bytes > 16 * 1024 * 1024) throw upstreamError('Guangxi parcel response exceeds the byte limit.');
                controller.enqueue(chunk.value);
            } catch (error) { controller.error(error); await close(error); }
        },
        cancel: close
    });
    return new Response(body, { status: response.status, headers: response.headers });
}
