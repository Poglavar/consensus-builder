// Health check routes: the API itself, and whether the live Kazakhstan cadastre still answers.
import { readFileSync } from 'node:fs';
import { createHttpsJsonFetch } from '../parcels/https-json-fetch.js';
import { kazakhstanPkkLayerEndpoint } from '../parcels/kazakhstan-pkk-source.js';

const PROBE_CACHE_MS = 10 * 60 * 1000;
// About 300 m of Alatau (Yntymak), in the district view's native grid: dozens of parcels.
const PROBE_URL = `${kazakhstanPkkLayerEndpoint('egkn:u_view')}?${new URLSearchParams({ service: 'WFS', version: '2.0.0',
    request: 'GetFeature', typename: 'egkn:u_view', outputFormat: 'application/json', propertyname: 'gid,kad_nomer',
    count: '50', viewparams: 'district_id:364', bbox: '13659424.7,4810294.3,13659724.7,4810594.3' })}`;
const PROBE_HEADERS = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://map.gov4c.kz/egkn/', Accept: 'application/json' };

/**
 * Asks the live cadastre directly: { status: 'ok', parcels } or { status: 'blocked' | 'error',
 * httpStatus?, error? }. The hourly alerts-server check reads it, so a new block is reported and the
 * saved copies (scripts/snapshot-kazakhstan-pkk.mjs) can be put into service by hand.
 */
export function createKzCadastreProbe({ fetchImpl, now = Date.now } = {}) {
    let fetchJson = fetchImpl;
    let cached = null;
    return async function probe() {
        if (cached && now() - cached.at < PROBE_CACHE_MS) return cached.result;
        fetchJson ||= createHttpsJsonFetch(readFileSync(new URL('../parcels/certificates/sectigo-public-server-authentication-ca-dv-r36.pem', import.meta.url), 'utf8'));
        let result;
        try {
            const response = await fetchJson(PROBE_URL, { headers: PROBE_HEADERS, signal: AbortSignal.timeout(20000) });
            if (response.status !== 200) result = { status: 'blocked', httpStatus: response.status };
            else {
                const page = await response.json();
                const parcels = Array.isArray(page?.features) ? page.features.length : 0;
                result = parcels > 0 ? { status: 'ok', parcels } : { status: 'error', error: 'no parcels in the probe area' };
            }
        } catch (error) {
            result = { status: 'error', error: error.name === 'TimeoutError' ? 'timed out' : error.message };
        }
        result = { ...result, checkedAt: new Date(now()).toISOString() };
        cached = { at: now(), result };
        return result;
    };
}

export function setupHealthRoute(app, { kzCadastreProbe = createKzCadastreProbe() } = {}) {
    app.get('/health', (_req, res) => {
        res.json({ status: 'ok' });
    });
    app.get('/health/kz-cadastre', async (_req, res) => {
        const result = await kzCadastreProbe();
        res.set('Cache-Control', 'no-store');
        res.status(result.status === 'ok' ? 200 : 503).json(result);
    });
}
