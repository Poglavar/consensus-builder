// Public, read-only proof that our paid resource, the verified oracle facts (GET /agent/oracle/facts),
// is present in the hosted x402 Bazaar. Credentials stay server-side; callers receive the exact
// matching catalog record and a short cache.

import { createCdpFacilitatorClient } from '@coinbase/cdp-sdk/x402';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { withBazaar } from '@x402/extensions/bazaar';
import { readX402OracleConfig } from '../utils/x402-payment.js';
import { AGENT_ORACLE_FACTS_PATH } from './agent-oracle-facts.js';

const CACHE_MS = 5 * 60 * 1000;
// The one paid resource; ?resource= names it, so a listing link says what it proves.
const RESOURCE = 'oracle-facts';

function clean(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeBaseUrl(value) {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
}

function publicBase(req, env) {
    return (env.PUBLIC_API_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

function bazaarClient(config, env) {
    const facilitator = config.usesCdp
        ? createCdpFacilitatorClient({
            apiKeyId: env.CDP_API_KEY_ID,
            apiKeySecret: env.CDP_API_KEY_SECRET,
            baseUrl: config.facilitatorUrl
        })
        : new HTTPFacilitatorClient({ url: config.facilitatorUrl });
    return withBazaar(facilitator);
}

/** Query the facilitator-owned public Bazaar catalog for this exact resource URL. */
export async function findBazaarListing({ facilitatorUrl, resourceUrl, payTo, network, bazaarClient: client = null } = {}) {
    if (!clean(facilitatorUrl)) return { state: 'unconfigured', listing: null };
    try {
        const bazaar = (client ?? withBazaar(new HTTPFacilitatorClient({ url: facilitatorUrl }))).extensions.bazaar;
        const expected = normalizeBaseUrl(resourceUrl);
        const matches = item => {
            try { return normalizeBaseUrl(item.resource) === expected; } catch { return false; }
        };
        // CDP's public catalog currently ignores list filters (including payTo/network) and caps
        // list pages at 20. Searching for the exact public URL avoids treating an unrelated first
        // page as the whole Bazaar. Older facilitators may not expose search, so keep the list call
        // as a compatibility fallback.
        if (typeof bazaar.search === 'function') {
            const result = await bazaar.search({
                query: expected,
                type: 'http',
                payTo: clean(payTo) || undefined,
                network: clean(network) || undefined,
                extensions: 'bazaar',
                // CDP currently rejects search limits above 20.
                limit: 20
            });
            const listing = (result?.resources || []).find(matches) ?? null;
            return {
                state: listing ? 'listed' : 'not-listed',
                listing,
                total: result?.resources?.length ?? null,
                partialResults: Boolean(result?.partialResults)
            };
        }
        const page = await bazaar.listResources({
            type: 'http',
            payTo: clean(payTo) || undefined,
            network: clean(network) || undefined,
            extensions: 'bazaar',
            limit: 100,
            offset: 0
        });
        const listing = (page?.items || []).find(matches) ?? null;
        return { state: listing ? 'listed' : 'not-listed', listing, total: page?.pagination?.total ?? null };
    } catch (error) {
        return { state: 'unavailable', listing: null, error: error instanceof Error ? error.message : String(error) };
    }
}

export function setupAgentDiscoveryRoute(app, {
    env = process.env,
    lookup = findBazaarListing,
    now = () => Date.now(),
    cacheMs = CACHE_MS
} = {}) {
    let cached = null;

    app.get('/agent/discovery', async (req, res) => {
        const resource = req.query.resource || RESOURCE;
        if (resource !== RESOURCE) {
            return res.status(400).json({ error: `resource must be ${RESOURCE}` });
        }
        const config = readX402OracleConfig(env);
        const endpoint = `${publicBase(req, env)}${AGENT_ORACLE_FACTS_PATH}`;
        if (!config.enabled) {
            return res.json({
                state: 'unconfigured', resource, endpoint, verifiedAt: null,
                facilitatorUrl: config.facilitatorUrl,
                missing: config.missing
            });
        }

        const current = now();
        if (cached && current - cached.checkedAt < cacheMs) {
            return res.json({ ...cached.payload, cached: true });
        }

        let result;
        try {
            result = await lookup({
                facilitatorUrl: config.facilitatorUrl,
                resourceUrl: endpoint,
                payTo: config.payTo,
                network: config.network,
                bazaarClient: bazaarClient(config, env)
            });
        } catch (_) {
            result = {
                state: 'unavailable',
                error: 'Hosted facilitator discovery lookup failed.'
            };
        }
        const payload = {
            state: result.state,
            resource,
            endpoint,
            verifiedAt: new Date(current).toISOString(),
            facilitatorUrl: config.facilitatorUrl,
            network: config.network,
            payTo: config.payTo,
            listing: result.listing || null,
            totalMatches: result.total ?? null,
            partialResults: Boolean(result.partialResults),
            error: result.error || null,
            cached: false
        };
        cached = { checkedAt: current, payload };
        return res.json(payload);
    });
}

export { CACHE_MS, publicBase };
