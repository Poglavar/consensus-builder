// POST /proposals/prepare (alias POST /agent/prepare): prepare a proposal for publication
// (projections.md §3, proposals/prepare.js). The server materialises what it derives — a corridor's
// land, from its lanes, in its own operation frame — binds the site, hashes it, and signs the result:
// a content-addressed artifact. The answer is { preparationId, digest, preparedAt, signature,
// artifact, proposal }: the client shows the artifact, uploads metadata and mints with ITS site and
// binding, and publishes `proposal` — the record with its derived land, declaration, `preparation`
// reference and the artifact itself (`preparedArtifact`) filled in. Nothing is stored here: the
// artifact is kept only when the proposal is published. The browser path sits behind the Origin
// gate; both paths share the binding rate limit (index.js).

import { prepareProposal } from '../proposals/prepare.js';
import { normalizeCityCode } from './proposals.js';

export const PROPOSAL_PREPARE_PATHS = Object.freeze(['/proposals/prepare', '/agent/prepare']);
const MAX_CITY_LENGTH = 100;
const MAX_SOURCE_ID_LENGTH = 200;

export function setupProposalPrepareRoute(app, pool) {
    for (const routePath of PROPOSAL_PREPARE_PATHS) {
        app.post(routePath, async (req, res) => {
            const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
            if (!body || !body.proposal || typeof body.proposal !== 'object' || Array.isArray(body.proposal)) {
                return res.status(400).json({ error: 'Body must be a JSON object { proposal, city?, parcelSourceId?, toleranceM? }.' });
            }
            if (body.city !== undefined && body.city !== null && (typeof body.city !== 'string' || body.city.length > MAX_CITY_LENGTH)) {
                return res.status(400).json({ error: `city must be a string of at most ${MAX_CITY_LENGTH} characters.` });
            }
            if (body.parcelSourceId !== undefined && body.parcelSourceId !== null
                && (typeof body.parcelSourceId !== 'string' || body.parcelSourceId.length > MAX_SOURCE_ID_LENGTH)) {
                return res.status(400).json({ error: `parcelSourceId must be a string of at most ${MAX_SOURCE_ID_LENGTH} characters.` });
            }
            const started = Date.now();
            try {
                const prepared = await prepareProposal(pool, body.proposal, {
                    city: normalizeCityCode(body.city || body.proposal.city) || null,
                    parcelSourceId: body.parcelSourceId ?? null,
                    toleranceM: body.toleranceM ?? body.proposal.toleranceM
                });
                return res.status(201).json({ ...prepared, queryMs: Date.now() - started });
            } catch (error) {
                // a server without a signing key prepares nothing, and says why (503)
                if (error && error.code === 'preparation-unavailable') console.error(`[${new Date().toISOString()}] Error in POST ${routePath}: ${error.message}`);
                if (error && error.code && Number.isInteger(error.status) && (error.status < 500 || error.code === 'preparation-unavailable')) {
                    if (error.retryAfterSeconds !== undefined) res.set('Retry-After', String(error.retryAfterSeconds));
                    const { message, code, status, stack, ...details } = error;
                    return res.status(status).json({ error: message, code, ...details });
                }
                console.error(`[${new Date().toISOString()}] Error in POST ${routePath}:`, error);
                return res.status(500).json({ error: 'Internal server error' });
            }
        });
    }
}
