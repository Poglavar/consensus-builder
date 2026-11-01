// Reads the anonymous municipal viewer configuration; its public token stays in memory.
import { providerHttpError, upstreamError } from './source-contract.js';

export const MAKKAH_VIEWER = 'https://maps.holymakkah.gov.sa/';
export const MAKKAH_CONFIG = `${MAKKAH_VIEWER}Data/HashKey1?cv=633889166`;
export const MAKKAH_LAYER = `${MAKKAH_VIEWER}arcgis/rest/services/SDI/MMSDI_MD_BusinessMap/MapServer/14`;
export function isMakkahPublicSource(d) {
    return d.id === 'sa-makkah-municipality-mmsdi-regulatory-parcels'
        && d.adapter === 'arcgis' && d.endpoint === MAKKAH_LAYER && d.publicTokenUrl === MAKKAH_CONFIG;
}

async function boundedText(response, limit) {
    const reader = response.body?.getReader();
    if (!reader) throw upstreamError('Makkah returned no readable response.');
    const decoder = new TextDecoder();
    let size = 0, text = '';
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) throw upstreamError('Makkah response exceeds the byte limit.');
            text += decoder.decode(value, { stream: true });
        }
        return text + decoder.decode();
    } finally {
        // A cloned response is a tee: waiting for its cancellation would wait for
        // the original body, which the caller cannot cancel until we return.
        void reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

export function createMakkahPublicFetch(fetchImpl, descriptor) {
    if (!isMakkahPublicSource(descriptor)) throw new Error('Invalid Makkah public-viewer contract.');
    let cached, pending;
    async function token(signal) {
        if (cached) return cached;
        if (!pending) pending = (async () => {
            const response = await fetchImpl(MAKKAH_CONFIG, {
                method: 'POST', body: '', signal,
                headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', Referer: MAKKAH_VIEWER },
                credentials: 'omit', redirect: 'error', cache: 'no-store'
            });
            if (!response.ok) throw providerHttpError(response);
            let config;
            try {
                let encoded = await boundedText(response, 1024 * 1024);
                if (encoded.startsWith('"')) encoded = JSON.parse(encoded);
                for (let i = 0; i < 3; i++) encoded = atob(encoded);
                config = JSON.parse(decodeURIComponent(encoded));
            } catch { throw upstreamError('Makkah returned an invalid public configuration.'); }
            const scope = `${MAKKAH_VIEWER}arcgis/rest/services`;
            const entry = config.tokens?.find(item => item.needed === true && item.server === scope);
            if (typeof entry?.token !== 'string' || !entry.token || entry.token.length > 8192) {
                throw upstreamError('Makkah public configuration has no parcel token.');
            }
            cached = entry.token;
            return cached;
        })().finally(() => { pending = undefined; });
        return pending;
    }
    return async (input, init = {}) => {
        const target = new URL(input);
        if (![MAKKAH_LAYER, `${MAKKAH_LAYER}/query`].includes(`${target.origin}${target.pathname}`)
            || target.username || target.password) throw new Error('Makkah token destination rejected.');
        for (let attempt = 0; attempt < 2; attempt++) {
            const current = await token(init.signal), url = new URL(target);
            const headers = new Headers(init.headers);
            headers.set('Referer', MAKKAH_VIEWER);
            const options = { ...init, headers, credentials: 'omit', redirect: 'error', cache: 'no-store' };
            if (String(init.method || 'GET').toUpperCase() === 'POST') {
                const body = new URLSearchParams(init.body);
                body.set('token', current);
                options.body = body.toString();
                url.searchParams.delete('token');
            } else url.searchParams.set('token', current);
            const response = await fetchImpl(url.href, options);
            let code = response.status;
            if (response.ok) {
                try { code = JSON.parse(await boundedText(response.clone(), descriptor.maxResponseBytes ?? 16 * 1024 * 1024)).error?.code ?? code; }
                catch { await response.body?.cancel(); throw upstreamError('Makkah returned an invalid parcel response.'); }
            }
            if (![498, 499].includes(code) || attempt === 1) return response;
            await response.body?.cancel();
            if (cached === current) cached = undefined;
        }
    };
}
