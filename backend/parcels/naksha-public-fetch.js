// The official cadastral viewer publishes this anonymous, short-lived ArcGIS token.
// Keep it in transport memory and send it only to the discovery-bound parcel layer.
import { providerHttpError, upstreamError } from './source-contract.js';

export const NAKSHA_PUBLIC_TOKEN_URL = 'https://naksha.dolr.gov.in/NakshaPortalAPI/api/Map/GetArcGISToken';
export const NAKSHA_PARCEL_LAYER = 'https://nakshagis.dolr.gov.in/utm4647/rest/services/Naksha_46/Naksha_mz_15_46/FeatureServer/0/query';
export function isNakshaPublicSource(descriptor) {
    return descriptor.id === 'in-mz-naksha-aizawl-urban-parcels'
        && descriptor.adapter === 'arcgis' && descriptor.endpoint === NAKSHA_PARCEL_LAYER
        && descriptor.publicTokenUrl === NAKSHA_PUBLIC_TOKEN_URL;
}

async function boundedJson(response, limit) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0, text = '';
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > limit) throw upstreamError('Naksha response exceeds the byte limit.');
            text += decoder.decode(value, { stream: true });
        }
        return JSON.parse(text + decoder.decode());
    } finally {
        // A tee branch cannot await cancellation before its sibling is cancelled.
        void reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

export function createNakshaPublicFetch(fetchImpl, descriptor, { now = Date.now } = {}) {
    if (!isNakshaPublicSource(descriptor)) throw new Error('Invalid Naksha public-viewer source contract.');
    let cached, pending;
    async function token(signal) {
        if (cached && cached.expires > now() + 30_000) return cached;
        if (!pending) pending = (async () => {
            const response = await fetchImpl(NAKSHA_PUBLIC_TOKEN_URL, {
                signal, method: 'POST', body: '{}', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
                credentials: 'omit', redirect: 'error', cache: 'no-store'
            });
            if (!response.ok) throw providerHttpError(response);
            const envelope = await boundedJson(response, 16 * 1024);
            const payload = envelope?.data;
            if (envelope.status !== true || !payload || payload.ssl !== true || typeof payload.token !== 'string' || !payload.token
                || payload.token.length > 8192 || !Number.isFinite(payload.expires) || payload.expires <= now()) {
                throw upstreamError('Naksha returned an invalid public-viewer token contract.');
            }
            cached = { value: payload.token, expires: payload.expires };
            return cached;
        })().finally(() => { pending = undefined; });
        return pending;
    }
    return async (input, init = {}) => {
        const target = new URL(input);
        if (![NAKSHA_PARCEL_LAYER, NAKSHA_PARCEL_LAYER.replace(/\/query$/, '')].includes(`${target.origin}${target.pathname}`)
            || target.username || target.password) throw new Error('Naksha public token cannot be sent to this endpoint.');
        for (let attempt = 0; attempt < 2; attempt++) {
            const current = await token(init.signal), url = new URL(target);
            const options = { ...init, credentials: 'omit', redirect: 'error', cache: 'no-store' };
            if (String(init.method || 'GET').toUpperCase() === 'POST') {
                const body = new URLSearchParams(init.body);
                body.set('token', current.value);
                options.body = body.toString();
                url.searchParams.delete('token');
            } else url.searchParams.set('token', current.value);
            const response = await fetchImpl(url.href, options);
            let code = response.status;
            if (response.ok) {
                try { code = (await boundedJson(response.clone(), descriptor.maxResponseBytes ?? 16 * 1024 * 1024)).error?.code ?? code; }
                catch { await response.body?.cancel(); throw upstreamError('Naksha returned an invalid parcel response.'); }
            }
            if (![498, 499].includes(code) || attempt === 1) return response;
            await response.body?.cancel();
            if (cached === current) cached = undefined;
        }
    };
}
