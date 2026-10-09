// Uses the official anonymous PULSE viewer's short-lived reader token in memory only.
import { createArcgisParcelSource } from './arcgis-source.js';
import { providerHttpError, upstreamError } from './source-contract.js';

const viewer = 'https://lis.pulse.gop.pk/';
const bootstrap = `${viewer}api/gis/token`;
const endpointPattern = /^https:\/\/gismaps\.punjab-zameen\.gov\.pk\/arcgis\/rest\/services\/VendorMaps\/Punjab_Cdastral_Maps\/MapServer\/\d+$/;

export function createPulsePublicFetch(endpoint, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    if (!endpointPattern.test(endpoint)) throw new Error('Invalid PULSE public parcel endpoint.');
    let reader = null, pending = null;
    async function getReader() {
        if (reader && reader.refreshAt > now()) return reader.token;
        if (!pending) {
            pending = (async () => {
                try {
                    const response = await fetchImpl(bootstrap, { signal: AbortSignal.timeout(15000), redirect: 'error',
                        headers: { Accept: 'application/json', Referer: viewer } });
                    if (!response.ok) throw providerHttpError(response);
                    const body = await response.json();
                    const expiresAt = typeof body.expiresAt === 'string' ? Date.parse(body.expiresAt) : NaN;
                    const absoluteExpiry = typeof body.expiresAt === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(body.expiresAt);
                    if (body.success !== true || typeof body.token !== 'string' || !body.token
                        || !Number.isFinite(expiresAt) || (absoluteExpiry && expiresAt <= now())) {
                        throw upstreamError('Public parcel reader bootstrap returned invalid access metadata.');
                    }
                    // The publisher returns an expiry without a timezone. Do not infer its zone:
                    // renew successful anonymous bootstraps after at most thirty seconds.
                    reader = { token: body.token, refreshAt: now() + (absoluteExpiry
                        ? Math.min(30000, expiresAt - now()) : 30000) };
                    return reader.token;
                } catch (error) {
                    if (error.status) throw error;
                    throw upstreamError('Public parcel reader bootstrap is unavailable.');
                }
            })().finally(() => { pending = null; });
        }
        return pending;
    }
    return async (url, init = {}) => {
        const target = new URL(url);
        if (`${target.origin}${target.pathname}` !== `${endpoint}/query`
            || target.username || target.password || target.hash || target.searchParams.has('token')) {
            throw upstreamError('Public parcel request does not match its configured layer.');
        }
        target.searchParams.set('token', await getReader());
        const headers = new Headers(init.headers || {});
        headers.set('Referer', viewer);
        try { return await fetchImpl(target.href, { ...init, redirect: 'error', headers }); }
        catch { throw upstreamError('Public parcel provider is unavailable.'); }
    };
}

export function createPulsePublicParcelSource(descriptor, options = {}) {
    return createArcgisParcelSource(descriptor, {
        fetchImpl: createPulsePublicFetch(descriptor.endpoint, options)
    });
}
