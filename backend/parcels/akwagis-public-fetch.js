// Uses AkwaGIS's anonymous public token only on its configured parcel layer; never persists it.
import { providerHttpError, upstreamError } from './source-contract.js';

export const AKWAGIS_PUBLIC_TOKEN_URL = 'https://akwagis.akwaibomstate.gov.ng/api/v1/gis/public-token';
const SERVER = 'https://akwagis.xyz/server';
const LAYER = `${SERVER}/rest/services/SurveyMap/mainDrafter/FeatureServer/3`;

export function createAkwaGisPublicFetch(fetchImpl, descriptor, { now = Date.now } = {}) {
    if (descriptor.publicTokenUrl !== AKWAGIS_PUBLIC_TOKEN_URL || descriptor.endpoint !== LAYER) {
        throw new Error('Invalid AkwaGIS public-token source contract.');
    }
    let cached, pending;
    async function token(signal) {
        if (cached && cached.expires > now() + 30_000) return cached;
        if (!pending) {
            pending = (async () => {
                const response = await fetchImpl(AKWAGIS_PUBLIC_TOKEN_URL, {
                    signal, headers: { Accept: 'application/json' },
                    credentials: 'omit', redirect: 'error', cache: 'no-store'
                });
                if (!response.ok) throw providerHttpError(response);
                const payload = await response.json();
                const data = payload?.data;
                if (payload.success !== true || data?.server !== SERVER
                    || typeof data.token !== 'string' || !data.token || data.token.length > 8192
                    || !Number.isFinite(data.expires) || data.expires <= now()) {
                    throw upstreamError('AkwaGIS returned an invalid public-token contract.');
                }
                cached = { value: data.token, expires: data.expires };
                return cached;
            })().finally(() => { pending = undefined; });
        }
        return pending;
    }
    return async (input, init = {}) => {
        const target = new URL(input);
        if (![LAYER, `${LAYER}/query`].includes(`${target.origin}${target.pathname}`)
            || target.username || target.password) {
            throw new Error('AkwaGIS public token cannot be sent to this endpoint.');
        }
        for (let attempt = 0; attempt < 2; attempt++) {
            const current = await token(init.signal);
            const url = new URL(target);
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
                try { code = (await response.clone().json()).error?.code ?? code; }
                catch { /* The ArcGIS reader reports malformed responses without exposing their contents. */ }
            }
            if (![498, 499].includes(code) || attempt === 1) return response;
            // One renewal only; denied credentials, rate limits and outages are never retried here.
            if (cached === current) cached = undefined;
        }
    };
}
