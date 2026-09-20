// Public, read-only proof that the paid proposal resource is present in the hosted x402 Bazaar.
// Credentials stay server-side; callers receive the exact matching catalog record and a short cache.

import { createCdpFacilitatorClient } from '@coinbase/cdp-sdk/x402';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { withBazaar } from '@x402/extensions/bazaar';
import { findBazaarListing } from '../agents/x402-demo.js';
import { readX402Config } from '../utils/x402-payment.js';

const CACHE_MS = 5 * 60 * 1000;

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

export function setupAgentDiscoveryRoute(app, {
    env = process.env,
    lookup = findBazaarListing,
    now = () => Date.now(),
    cacheMs = CACHE_MS
} = {}) {
    let cached = null;

    app.get('/agent/discovery', async (req, res) => {
        const config = readX402Config(env);
        const endpoint = `${publicBase(req, env)}/agent/proposals`;
        if (!config.enabled) {
            return res.json({
                state: 'unconfigured', endpoint, verifiedAt: null,
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
                submitUrl: endpoint,
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
