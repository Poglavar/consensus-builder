// Proposals API endpoints: the read side of the proposal table, which the chain readers and the
// frontend still use until M3 (plan-design-agreement.md). Nothing here writes a proposal; designs
// and agreements are published through routes/content-routes.js.
// GET /proposals/:id - Digits address a database row; other identifiers address an authored proposalId.

import { createRequire } from 'node:module';
import { createJsonBodyValidator, validators } from '../utils/request-validation.js';
import { oneProposalByIdentifierClause, partitionProposalIdentifiers, indexProposalRows } from '../proposals/identifiers.js';
import { canonicalizeLifecycleStatus } from '../proposals/lifecycle.js';
import { projectProposalLifecycleEvidence, serializeProposalRow, isInvalidRecordError } from '../proposals/serializer.js';
import { attachProposalFloorModels } from '../buildings/floor-models.js';
import { normalizeCityCode } from '../utils/city-code.js';

const require = createRequire(import.meta.url);
const proposalDesignGoals = require('../../frontend/js/proposals/design-goals.js');

const MAX_PROPOSAL_ID_LENGTH = 255;

// List endpoints return whole rows; an uncapped ?limit= is a one-request table dump. The summary cap
// stays above the largest city's proposal count because the share dialog asks for count+50 in one
// call and falls back to per-proposal checks when the list comes back short.
export const MAX_SUMMARY_LIMIT = 1000;
export const MAX_PARCEL_PROPOSALS_LIMIT = 200;

function validateIdentifierField(fieldLabel) {
    return validators.custom((value) => {
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) {
                return validators.fail(`${fieldLabel} must be a string or number.`);
            }
            return validators.ok(String(value));
        }

        if (typeof value !== 'string') {
            return validators.fail(`${fieldLabel} must be a string or number.`);
        }

        const normalized = value.trim();
        if (!normalized) {
            return validators.fail(`${fieldLabel} must not be empty.`);
        }
        if (normalized.length > MAX_PROPOSAL_ID_LENGTH) {
            return validators.fail(`${fieldLabel} must be at most ${MAX_PROPOSAL_ID_LENGTH} characters.`);
        }
        if (/\p{C}/u.test(normalized)) {
            return validators.fail(`${fieldLabel} contains invalid control characters.`);
        }

        return validators.ok(normalized);
    });
}

function parseProposalViewportBbox(raw) {
    if (raw === undefined) return { ok: true, value: null };
    const pieces = typeof raw === 'string' ? raw.split(',').map(value => value.trim()) : [];
    const bbox = pieces.map(value => Number(value));
    if (bbox.length !== 4 || pieces.some(value => value === '') || !bbox.every(Number.isFinite)
        || bbox[0] < -180 || bbox[0] > 180 || bbox[2] < -180 || bbox[2] > 180
        || bbox[1] < -90 || bbox[1] > 90 || bbox[3] < -90 || bbox[3] > 90
        || bbox[0] > bbox[2] || bbox[1] > bbox[3]) {
        return { ok: false, error: 'bbox must be west,south,east,north in ordered WGS84 coordinates.' };
    }
    return { ok: true, value: bbox };
}

// What the record is, beyond an ordinary proposal. Absent = an ordinary proposal by a proposer.
// 'owner-offer': an attested owner offering its own parcels. Only a known role is served.
export const PROPOSAL_ROLES = Object.freeze(['owner-offer']);

// A shared plan can carry hundreds of proposal ids. Fetching each record through
// GET /proposals/:id turns one plan open into hundreds of HTTP requests, even though Postgres can
// answer the same set in one query. Keep this endpoint additive: an older backend simply makes the
// frontend fall back to the individual route.
const proposalBatchBodyValidator = createJsonBodyValidator({
    schema: {
        ids: {
            required: true,
            validate: validators.arrayOf(validateIdentifierField('ids'), {
                label: 'ids',
                minItems: 1,
                maxItems: 1000
            })
        }
    }
});

// The marketplace/on-chain LIFECYCLE status, past-expiry-aware (shared with GET /markets). A proposal past expires_at reads
// as 'Expired' only when its stored lifecycle is Active. This one expression is used both for the
// returned lifecycleStatus and for the ?lifecycle= FILTER, so filtering and display agree
// (case-insensitive — the DB may carry both 'Executed' and 'executed').
export const EFFECTIVE_STATUS_SQL = `
    CASE
        WHEN LOWER(BTRIM(COALESCE(lifecycle_status, ''))) = 'active'
            AND expires_at IS NOT NULL AND expires_at <= now()
        THEN 'Expired'
        WHEN LOWER(BTRIM(COALESCE(lifecycle_status, ''))) = 'executed' THEN 'Executed'
        WHEN LOWER(BTRIM(COALESCE(lifecycle_status, ''))) = 'cancelled' THEN 'Cancelled'
        WHEN LOWER(BTRIM(COALESCE(lifecycle_status, ''))) = 'expired' THEN 'Expired'
        WHEN LOWER(BTRIM(COALESCE(lifecycle_status, ''))) = 'draft' THEN 'draft'
        WHEN LOWER(BTRIM(COALESCE(lifecycle_status, ''))) = 'active' THEN 'Active'
        ELSE 'Unknown'
    END`;

const PROPOSAL_LIFECYCLE_EVENT_SQL = `(
    SELECT jsonb_build_object(
        'id', event_id,
        'eventType', event_type,
        'subject', jsonb_build_object('type', subject_type, 'id', subject_id),
        'outcome', outcome,
        'observedAt', source_observed_at,
        'attester', jsonb_build_object('kind', 'solana_program', 'address', attester),
        'source', jsonb_build_object(
            'chain', evidence->'source'->>'chain',
            'transaction', transaction_signature,
            'hash', source_hash
        ),
        'evidence', evidence
    )
    FROM consensus.land_event
    WHERE event_type = 'proposal_lifecycle'
      AND subject_type = 'proposal'
      AND subject_id = proposal_data->'chainMirror'->'ref'->>'tokenId'
    ORDER BY source_observed_at DESC, created_at DESC
    LIMIT 1
)`;

export function setupProposalsRoute(app, pool) {

    // The complete public proposal representation. The single and batch endpoints deliberately
    // share this list and serializeProposalRow so a plan does not receive a thinner record than a
    // direct proposal link.
    const FULL_PROPOSAL_COLUMNS = `
        id, proposal_id, city, name, title, description, author, type,
        lifecycle_status, ${EFFECTIVE_STATUS_SQL} AS effective_status,
        offer, offer_currency, budget, budget_currency,
        created_at, expires_at, updated_at,
        decay_enabled, decay_percent, decay_duration_ms,
        deposit_enabled, deposit_percent,
        is_conditional, disbursement_mode,
        cadastre_parcel_ids, ownership_flow, cadastre_frame,
        accepted_parcel_ids, owner_acceptances,
        road_proposal, building_proposal, structure_proposal, reparcellization,
        lens, bounds, onchain_data, screenshot_url, agent_payment_id, proposal_data,
        ${PROPOSAL_LIFECYCLE_EVENT_SQL} AS lifecycle_event`;

    // ORDER BY only over columns the summary actually carries. Computed sorts the client offers
    // (area, parcel count, acceptance ratio) need per-row geometry/JSONB work the list endpoint
    // does not do, so they stay client-side; these are the DB-derivable ones.
    const SORT_ORDER_BY = {
        'created-desc': 'created_at DESC',
        'created-asc': 'created_at ASC',
        'author-asc': "COALESCE(author, proposal_data->>'author', '') ASC",
        'author-desc': "COALESCE(author, proposal_data->>'author', '') DESC",
        'value-desc': "NULLIF(proposal_data->>'offer', '')::numeric DESC NULLS LAST",
        'value-asc': "NULLIF(proposal_data->>'offer', '')::numeric ASC NULLS LAST"
    };

    const parseFilters = (req) => {
        const city = normalizeCityCode(req.query.city);
        // The lifecycle-phase filter also exposes Unknown read results. Named `?lifecycle=`.
        const lifecycleRaw = typeof req.query.lifecycle === 'string' && req.query.lifecycle.trim()
            ? req.query.lifecycle.trim()
            : null;
        const lifecycle = lifecycleRaw?.toLowerCase() === 'unknown' ? 'Unknown'
            : lifecycleRaw ? canonicalizeLifecycleStatus(lifecycleRaw) : null;
        const type = req.query.type;
        const author = req.query.author;
        const goal = typeof req.query.goal === 'string' && req.query.goal.trim() ? req.query.goal.trim() : null;
        const q = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : null;
        const sort = Object.prototype.hasOwnProperty.call(SORT_ORDER_BY, req.query.sort) ? req.query.sort : null;
        const limit = parseInt(req.query.limit, 10);
        const offset = parseInt(req.query.offset, 10);
        // The proposals declaring any of these cadastral parcels (?parcel_ids=a,b,c): a parcel's, a
        // selection's or a site's Proposals tab asks for what is published on its land.
        const parcelIds = typeof req.query.parcel_ids === 'string'
            ? Array.from(new Set(req.query.parcel_ids.split(',').map(id => id.trim()).filter(Boolean))).slice(0, 500)
            : [];

        return {
            city,
            parcelIds,
            lifecycle,
            lifecycleError: lifecycleRaw && !lifecycle
                ? 'lifecycle must be one of: Active, Executed, Cancelled, Expired, draft, Unknown.'
                : null,
            type,
            author,
            goal,
            q,
            sort,
            limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_SUMMARY_LIMIT) : 100,
            offset: Number.isFinite(offset) && offset >= 0 ? offset : 0
        };
    };

    const buildFilterQuery = ({
        city,
        parcelIds,
        lifecycle,
        type,
        author,
        goal,
        q,
        sort,
        baseSelect,
        spatialBounds,
        includePagination = true,
        limit,
        offset
    }) => {
        let sql = baseSelect || '';
        const params = [];
        const clauses = [];

        if (spatialBounds) {
            const first = params.length + 1;
            params.push(...spatialBounds);
            const boundsWest = `COALESCE(bounds->>'west', bounds->>'minX', bounds->>'minLng', bounds->>0)`;
            const boundsSouth = `COALESCE(bounds->>'south', bounds->>'minY', bounds->>'minLat', bounds->>1)`;
            const boundsEast = `COALESCE(bounds->>'east', bounds->>'maxX', bounds->>'maxLng', bounds->>2)`;
            const boundsNorth = `COALESCE(bounds->>'north', bounds->>'maxY', bounds->>'maxLat', bounds->>3)`;
            const safeNumber = (value) => `(CASE WHEN ${value} ~ '^-?[0-9]+(\\.[0-9]+)?([eE][+-]?[0-9]+)?$' THEN (${value})::double precision END)`;
            const west = safeNumber(boundsWest);
            const south = safeNumber(boundsSouth);
            const east = safeNumber(boundsEast);
            const north = safeNumber(boundsNorth);
            clauses.push(`(
                (site IS NOT NULL AND site && ST_MakeEnvelope($${first}, $${first + 1}, $${first + 2}, $${first + 3}, 4326)
                    AND ST_Intersects(site, ST_MakeEnvelope($${first}, $${first + 1}, $${first + 2}, $${first + 3}, 4326)))
                OR (${west} <= $${first + 2} AND ${east} >= $${first}
                    AND ${south} <= $${first + 3} AND ${north} >= $${first + 1})
            )`);
        }

        if (city) {
            clauses.push(`city = $${params.length + 1}`);
            params.push(city);
        }

        if (parcelIds && parcelIds.length) {
            clauses.push(`cadastre_parcel_ids ?| $${params.length + 1}::text[]`);
            params.push(parcelIds);
        }

        if (lifecycle) {
            // Filter on the EFFECTIVE lifecycle so ?lifecycle=Active excludes expired-but-stale rows
            // and ?lifecycle=Expired finds them — matching what the summary returns.
            clauses.push(`LOWER(${EFFECTIVE_STATUS_SQL}) = LOWER($${params.length + 1})`);
            params.push(lifecycle);
        }

        if (type) {
            clauses.push(`type = $${params.length + 1}`);
            params.push(type);
        }

        if (author) {
            clauses.push(`author = $${params.length + 1}`);
            params.push(author);
        }

        if (goal) {
            clauses.push(`proposal_data->>'goal' = $${params.length + 1}`);
            params.push(goal);
        }

        if (q) {
            // Free-text over the display name/title and author — the same fields the client search
            // box matches, but across ALL rows instead of only the fetched page.
            const p = params.length + 1;
            clauses.push(
                `(COALESCE(name, title, proposal_data->>'name', proposal_data->>'title', '') ILIKE $${p}`
                + ` OR COALESCE(author, proposal_data->>'author', '') ILIKE $${p})`
            );
            params.push(`%${q}%`);
        }

        if (clauses.length) {
            sql += `\n            WHERE ${clauses.join(' AND ')}`;
        }

        if (includePagination) {
            const orderBy = SORT_ORDER_BY[sort] || SORT_ORDER_BY['created-desc'];
            sql += `\n            ORDER BY ${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
            params.push(limit, offset);
        }

        return { sql, params };
    };

    app.get('/proposals/count', async (req, res) => {
        try {
            const filters = parseFilters(req);
            if (filters.lifecycleError) return res.status(400).json({ error: filters.lifecycleError });
            const parsedBbox = parseProposalViewportBbox(req.query.bbox);
            if (!parsedBbox.ok) return res.status(400).json({ error: parsedBbox.error });
            const spatialBounds = parsedBbox.value;
            const city = filters.city === 'explore' ? null : filters.city;
            const { sql, params } = buildFilterQuery({
                ...filters,
                city,
                spatialBounds,
                baseSelect: '\n            SELECT COUNT(DISTINCT id) AS count FROM proposal',
                includePagination: false
            });

            const result = await pool.query(sql, params);
            const count = result.rows.length > 0 ? parseInt(result.rows[0].count, 10) : 0;

            res.json({
                count,
                city: city || null,
                lifecycle: filters.lifecycle || null,
                type: filters.type || null,
                author: filters.author || null,
                ...(spatialBounds ? { bbox: spatialBounds } : {})
            });
        } catch (err) {
            console.error('Error in GET /proposals/count:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // Per-parcel proposal counts for the map badges. The client passes the parcel ids it can see
    // (?parcel_ids=a,b,c) and gets { counts: { a: 2, c: 1 } } back from flat cadastral declarations.
    // Ids with no proposals are simply absent (treat as 0).
    app.get('/proposals/counts', async (req, res) => {
        try {
            const raw = typeof req.query.parcel_ids === 'string' ? req.query.parcel_ids : '';
            const parcelIds = Array.from(new Set(
                raw.split(',').map(s => s.trim()).filter(Boolean)
            )).slice(0, 5000); // cap the array so a huge querystring can't blow up the query
            if (!parcelIds.length) {
                return res.status(400).json({ error: 'parcel_ids query parameter is required' });
            }
            const city = normalizeCityCode(req.query.city);

            const params = [parcelIds];
            const cityClause = city ? `AND p.city = $${params.push(city)}` : '';

            // The canonical root declaration is the only proposal-to-land relationship.
            const sql = `
                SELECT ids.pid AS parcel_id, COUNT(DISTINCT p.id)::int AS n
                FROM proposal p
                CROSS JOIN LATERAL (
                    SELECT DISTINCT e AS pid
                    FROM jsonb_array_elements_text(
                        COALESCE(p.cadastre_parcel_ids, '[]'::jsonb)
                    ) AS e
                ) ids
                WHERE p.cadastre_parcel_ids ?| $1::text[]
                  AND ids.pid = ANY($1::text[])
                  ${cityClause}
                GROUP BY ids.pid
            `;

            const result = await pool.query(sql, params);
            const counts = {};
            result.rows.forEach(row => { counts[row.parcel_id] = row.n; });
            res.json({ counts });
        } catch (err) {
            console.error('Error in GET /proposals/counts:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    app.get('/proposals/summary', async (req, res) => {
        try {
            const filters = parseFilters(req);
            if (filters.lifecycleError) return res.status(400).json({ error: filters.lifecycleError });
            const parsedBbox = parseProposalViewportBbox(req.query.bbox);
            if (!parsedBbox.ok) return res.status(400).json({ error: parsedBbox.error });
            const city = filters.city === 'explore' ? null : filters.city;

            const { sql, params } = buildFilterQuery({
                ...filters,
                city,
                spatialBounds: parsedBbox.value,
                baseSelect: `
            SELECT
                id,
                proposal_id,
                city,
                COALESCE(name, title, proposal_data->>'name', proposal_data->>'title') AS display_name,
                COALESCE(title, name, proposal_data->>'title', proposal_data->>'name') AS display_title,
                COALESCE(author, proposal_data->>'author') AS author,
                COALESCE(type, proposal_data->>'type') AS type,
                -- Goal is an authored DesignGoals key; backend type is too broad to reconstruct it.
                proposal_data->>'goal' AS goal,
                ${EFFECTIVE_STATUS_SQL} AS effective_status,
                created_at,
                expires_at,
                proposal_data->'chainMirror' AS chain_mirror,
                ${PROPOSAL_LIFECYCLE_EVENT_SQL} AS lifecycle_event,
                -- Base ancestry rides along so the claims/dossier surfaces can answer "does this
                -- server proposal touch my parcel" without fetching every proposal in full.
                cadastre_parcel_ids,
                COALESCE(screenshot_url, onchain_data->>'imageUrl') AS screenshot_url,
                onchain_data,
                -- Paid-ness is a fact about the row (a settled x402 payment), not about what the body
                -- said: an agent stamp on a row without a payment id is never served.
                CASE WHEN agent_payment_id IS NOT NULL THEN proposal_data->'agent' END AS agent,
                proposal_data->>'proposalRole' AS proposal_role,
                COUNT(*) OVER() AS total_count
            FROM proposal`,
                includePagination: true
            });

            const result = await pool.query(sql, params);
            const invalid = [];
            const proposals = result.rows.map(row => {
                let proposal;
                try {
                    proposal = serializeProposalRow({
                        ...row,
                        name: row.display_name || row.display_title || null,
                        title: row.display_title || row.display_name || null
                    });
                } catch (err) {
                    if (!isInvalidRecordError(err)) throw err;
                    invalid.push({ id: row.id, proposalId: row.proposal_id, error: err.message, detail: err.detail });
                    return null;
                }
                return {
                    id: proposal.id,
                    proposalId: proposal.proposalId,
                    city: proposal.city || null,
                    name: proposal.name || null,
                    title: proposal.title || null,
                    author: proposal.author || null,
                    type: proposal.type || null,
                    goal: proposalDesignGoals.keyOf({ goal: row.goal }),
                    lifecycleStatus: proposal.lifecycleStatus,
                    lifecycleEvidence: projectProposalLifecycleEvidence({
                        lifecycleStatus: proposal.lifecycleStatus,
                        chainMirror: row.chain_mirror,
                        lifecycleEvent: row.lifecycle_event,
                        expiresAt: row.expires_at
                    }).lifecycleEvidence,
                    createdAt: proposal.createdAt || null,
                    cadastreParcelIds: Array.isArray(row.cadastre_parcel_ids) ? row.cadastre_parcel_ids : null,
                    parcelSet: proposal.parcelSet,
                    screenshotUrl: proposal.screenshotUrl || null,
                    onchain: row.onchain_data && typeof row.onchain_data === 'object' && !Array.isArray(row.onchain_data)
                        ? row.onchain_data
                        : null,
                    agent: row.agent && typeof row.agent === 'object' && !Array.isArray(row.agent)
                        ? row.agent
                        : null,
                    // Only a known role is served; anything else stored before validation is ordinary.
                    proposalRole: PROPOSAL_ROLES.includes(row.proposal_role) ? row.proposal_role : null
                };
            }).filter(Boolean);
            if (invalid.length) console.warn(`GET /proposals/summary: skipped ${invalid.length} non-canonical record(s)`, invalid.map(entry => `${entry.id}: ${entry.detail || entry.error}`));

            const totalCount = result.rows.length > 0 && result.rows[0].total_count !== undefined
                ? parseInt(result.rows[0].total_count, 10)
                : proposals.length;

            res.json({
                proposals,
                count: totalCount,
                limit: filters.limit,
                offset: filters.offset,
                ...(invalid.length ? { invalid } : {})
            });
        } catch (err) {
            console.error('Error in GET /proposals/summary:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    app.head('/proposals/:id', async (req, res) => {
        try {
            const idParam = req.params.id;
            if (!idParam) return res.status(400).end();

            const sql = `
                SELECT id, proposal_id, updated_at, created_at
                FROM proposal
                ${oneProposalByIdentifierClause(idParam)}
            `;

            const result = await pool.query(sql, [idParam]);
            if (result.rows.length === 0) return res.status(404).end();

            const row = result.rows[0];
            const lastModified = row.updated_at || row.created_at;
            if (lastModified) {
                res.setHeader('Last-Modified', new Date(lastModified).toUTCString());
                const weakEtag = `W/"proposal-${row.proposal_id}-${new Date(lastModified).getTime()}"`;
                res.setHeader('ETag', weakEtag);
            }
            res.setHeader('X-Proposal-Row-Id', row.id);
            res.setHeader('X-Proposal-Authored-Id', row.proposal_id);

            return res.status(200).end();
        } catch (err) {
            console.error('Error in HEAD /proposals/:id:', err);
            return res.status(500).end();
        }
    });

    app.post('/proposals/batch', proposalBatchBodyValidator, async (req, res) => {
        try {
            const ids = Array.from(new Set(req.validatedBody.ids.map(String)));
            const { proposalRowIds, authoredProposalIds } = partitionProposalIdentifiers(ids);
            const result = await pool.query(`
                SELECT ${FULL_PROPOSAL_COLUMNS}
                FROM proposal
                WHERE id::text = ANY($1::text[]) OR proposal_id = ANY($2::text[])
            `, [proposalRowIds, authoredProposalIds]);

            const byIdentifier = indexProposalRows(result.rows);
            const items = ids.map(id => {
                const row = byIdentifier.get(id);
                if (!row) return { id, proposal: null };
                try {
                    return { id, proposal: serializeProposalRow(row) };
                } catch (err) {
                    if (!isInvalidRecordError(err)) throw err;
                    console.warn(`POST /proposals/batch: ${id}: ${err.detail || err.message}`);
                    return { id, proposal: null, error: err.message, code: err.code, detail: err.detail };
                }
            });
            await attachProposalFloorModels(pool, items.map(item => item.proposal).filter(Boolean));
            res.json({ items, count: items.filter(item => item.proposal).length });
        } catch (err) {
            console.error('Error in POST /proposals/batch:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    app.get('/proposals/:id', async (req, res) => {
        try {
            const idParam = req.params.id;
            if (!idParam) {
                return res.status(400).json({ error: 'Invalid proposal id. Must be provided.' });
            }

            const sql = `
                SELECT ${FULL_PROPOSAL_COLUMNS}
                FROM proposal
                ${oneProposalByIdentifierClause(idParam)}
            `;

            const result = await pool.query(sql, [idParam]);
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Proposal not found' });
            }

            const [proposal] = await attachProposalFloorModels(pool, [serializeProposalRow(result.rows[0])]);
            res.json(proposal);
        } catch (err) {
            if (isInvalidRecordError(err)) {
                console.warn(`GET /proposals/${req.params.id}: ${err.detail || err.message}`);
                return res.status(422).json({ error: err.message, code: err.code, detail: err.detail });
            }
            console.error('Error in GET /proposals/:id:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    app.get('/proposals', async (req, res) => {
        try {
            const parcelId = req.query.parcel_id;
            const filters = parseFilters(req);
            if (filters.lifecycleError) return res.status(400).json({ error: filters.lifecycleError });
            const city = filters.city;
            const limit = Math.min(filters.limit, MAX_PARCEL_PROPOSALS_LIMIT);
            const offset = filters.offset;

            if (!parcelId) {
                return res.status(400).json({ error: 'parcel_id query parameter is required' });
            }

            const clauses = [];
            const params = [];

            if (city) {
                clauses.push(`city = $${params.length + 1}`);
                params.push(city);
            }

            if (filters.lifecycle) {
                clauses.push(`LOWER(${EFFECTIVE_STATUS_SQL}) = LOWER($${params.length + 1})`);
                params.push(filters.lifecycle);
            }

            clauses.push(`cadastre_parcel_ids @> $${params.length + 1}::jsonb`);
            params.push(JSON.stringify([String(parcelId)]));

            const sql = `
                SELECT
                    id, proposal_id, city, name, title, description, author, type,
                    lifecycle_status, ${EFFECTIVE_STATUS_SQL} AS effective_status,
                    offer, offer_currency, budget, budget_currency,
                    created_at, expires_at, updated_at,
                    cadastre_parcel_ids, ownership_flow,
                    onchain_data, screenshot_url, agent_payment_id, proposal_data
                FROM proposal
                WHERE ${clauses.join(' AND ')}
                ORDER BY created_at DESC
                LIMIT $${params.length + 1} OFFSET $${params.length + 2}
            `;

            params.push(limit, offset);
            const result = await pool.query(sql, params);

            const invalid = [];
            const proposals = result.rows.map(row => {
                try {
                    return serializeProposalRow(row);
                } catch (err) {
                    if (!isInvalidRecordError(err)) throw err;
                    invalid.push({ id: row.id, proposalId: row.proposal_id, error: err.message, detail: err.detail });
                    return null;
                }
            }).filter(Boolean);
            if (invalid.length) console.warn(`GET /proposals?parcel_id: skipped ${invalid.length} non-canonical record(s)`, invalid.map(entry => `${entry.id}: ${entry.detail || entry.error}`));

            await attachProposalFloorModels(pool, proposals);
            res.json({ proposals, count: proposals.length, limit, offset, parcelId, ...(invalid.length ? { invalid } : {}) });
        } catch (err) {
            console.error('Error in GET /proposals?parcel_id:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
}
