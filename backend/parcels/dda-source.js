// Dubai's anonymous public viewer issues its own short-lived ArcGIS session.
// Keep that session in memory and use it only for the viewer's fixed public plot layer.
import { createArcgisParcelSource } from './arcgis-source.js';
import { upstreamError, providerHttpError } from './source-contract.js';

export const DDA_VIEWER = 'https://gis.dda.gov.ae/dis/';
export const DDA_PLOTS = 'https://gis.dda.gov.ae/server/rest/services/DIS/MAIN_MAP/MapServer/13';

export function createDdaParcelSource(descriptor, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    if (descriptor.endpoint !== DDA_PLOTS) throw new Error('Invalid Dubai public plot endpoint.');
    let session, loading;
    async function publicSession(signal) {
        if (session && session.until > now()) return session;
        if (!loading) {
            loading = (async () => {
                const response = await fetchImpl(DDA_VIEWER, { signal, headers: { Accept: 'text/html' } });
                if (!response.ok) throw providerHttpError(response);
                const html = await response.text();
                if (html.length > 2 * 1024 * 1024) throw upstreamError('Public parcel viewer configuration is unavailable.');
                let settings;
                try { settings = JSON.parse(html.match(/\bAppSettings\s*=\s*(\{[^;]*?\})\s*;/)?.[1]); }
                catch { throw upstreamError('Public parcel viewer configuration is unavailable.'); }
                if (settings.PLOT_LAYER_URL !== DDA_PLOTS || typeof settings.AGSToken !== 'string'
                    || !settings.AGSToken.length || settings.AGSToken.length > 8192) {
                    throw upstreamError('Public parcel viewer configuration is unavailable.');
                }
                session = { token: settings.AGSToken, until: now() + 60000 };
                return session;
            })().finally(() => { loading = null; });
        }
        return loading;
    }
    const publicFetch = async (input, options = {}) => {
        const target = new URL(input);
        if (target.origin + target.pathname !== DDA_PLOTS + '/query' || target.searchParams.has('token')) {
            throw new Error('Invalid Dubai public parcel query.');
        }
        for (let attempt = 0; attempt < 2; attempt++) {
            const active = await publicSession(options.signal);
            const url = new URL(target);
            const headers = new Headers(options.headers);
            headers.set('Referer', DDA_VIEWER);
            const requestOptions = { ...options, headers };
            if (options.method === 'POST') {
                const body = new URLSearchParams(options.body);
                body.set('token', active.token);
                requestOptions.body = body.toString();
            } else url.searchParams.set('token', active.token);
            let response;
            try { response = await fetchImpl(url.href, requestOptions); }
            catch { throw upstreamError('Parcel provider is unavailable.'); }
            let code = response.status;
            if (response.ok) {
                try { code = (await response.clone().json()).error?.code; } catch { /* ArcGIS validates the response body. */ }
            }
            if (![498, 499].includes(code) || attempt === 1) return response;
            if (session === active) session = null;
        }
    };
    return createArcgisParcelSource(descriptor, { fetchImpl: publicFetch });
}
