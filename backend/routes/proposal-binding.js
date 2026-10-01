// POST /proposals/binding (alias POST /agent/binding): the cadastral binding of a proposal site —
// which parcels it reaches into, how far, and how much of it is open ground — computed by PostGIS
// over the full cadastre (proposals/binding.js). A read that uses POST only because a polygon does
// not fit in a query string: listed in READ_ONLY_POST_PATHS (index.js), so neither the Origin gate
// nor the write limiter applies; it has its own rate limit instead. This is the authoritative
// answer a publish uses; the browser's site-binding.js over loaded parcels is only a preview.

import { computeBinding, normalizeSiteGeometry, parseTolerance, validateSiteGeometry, BINDING_CODES } from '../proposals/binding.js';

export const PROPOSAL_BINDING_PATHS = Object.freeze(['/proposals/binding', '/agent/binding']);

const MAX_CITY_LENGTH = 100;

export function setupProposalBindingRoute(app, pool) {
    for (const routePath of PROPOSAL_BINDING_PATHS) {
        app.post(routePath, async (req, res) => {
            const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
            if (!body) return res.status(400).json({ error: 'Body must be a JSON object { site, toleranceM?, city? }.', code: BINDING_CODES.invalidSite });
            const siteError = validateSiteGeometry(body.site);
            if (siteError) return res.status(400).json({ error: siteError, code: BINDING_CODES.invalidSite });
            const tolerance = parseTolerance(body.toleranceM);
            if (!tolerance.ok) return res.status(400).json({ error: tolerance.error, code: BINDING_CODES.invalidTolerance });
            if (body.city !== undefined && body.city !== null
                && (typeof body.city !== 'string' || body.city.length > MAX_CITY_LENGTH)) {
                return res.status(400).json({ error: `city must be a string of at most ${MAX_CITY_LENGTH} characters.` });
            }
            const started = Date.now();
            try {
                const { binding } = await computeBinding(pool, {
                    site: normalizeSiteGeometry(body.site),
                    toleranceM: tolerance.value,
                    city: body.city || null
                });
                return res.json({ binding, queryMs: Date.now() - started });
            } catch (error) {
                if (error && error.code && Number.isInteger(error.status) && error.status < 500) {
                    return res.status(error.status).json({ error: error.message, code: error.code, ...(error.count ? { count: error.count } : {}) });
                }
                const badInput = /GeoJSON|geometry|parse|invalid/i.test(String(error && error.message));
                console.error(`[${new Date().toISOString()}] Error in POST ${routePath}:`, error);
                return res.status(badInput ? 400 : 500).json(badInput
                    ? { error: `Could not read the site: ${error.message}`, code: BINDING_CODES.invalidSite }
                    : { error: 'Internal server error' });
            }
        });
    }
}
