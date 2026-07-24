// Proposals API endpoints
// POST /proposals - Store a proposal and get back an id
// GET /proposals/:id - Get a proposal by proposal_id (unique globally)

import { createJsonBodyValidator, validators } from '../utils/request-validation.js';
import { generateAndStoreProposalThumbnail } from '../thumbnails/proposal-thumbnail.js';
import { canonicalizeLifecycleStatus, resolveIncomingLifecycleStatus } from '../proposals/lifecycle.js';
import { serializeProposalRow, stripLocalProposalState } from '../proposals/serializer.js';
import { recomputeCorridorStats } from './road-corridor.js';
import { validateReparcellizationShares } from './reparcellization.js';

// Rendering a thumbnail means fetching ~10-40 basemap tiles. That is normally under a second, but it
// is a third party on the request path, so it gets a hard deadline: an upload must never hang on it.
const THUMBNAIL_DEADLINE_MS = 20000;

const MAX_PROPOSAL_ID_LENGTH = 255;
const MAX_CITY_LENGTH = 100;
const MAX_TITLE_LENGTH = 500;
const MAX_AUTHOR_LENGTH = 255;
const MAX_TYPE_LENGTH = 50;
const MAX_STATUS_LENGTH = 50;
const MAX_CURRENCY_LENGTH = 10;
const MAX_DISBURSEMENT_MODE_LENGTH = 50;

// The frontend sends short city codes (frontend/js/city-config.js CITY_QUERY_MAP) but proposals are
// stored under the full city id. Every code the frontend can produce must map, or that city's
// proposals become invisible: `?city=ny` used to fall through unmapped and never match `new_york`.
const CITY_CODE_TO_ID = {
    zg: 'zagreb',
    zgb: 'zagreb',
    bg: 'belgrade',
    ba: 'buenos_aires',
    caba: 'buenos_aires',
    'ar-ba': 'buenos_aires',
    lj: 'ljubljana',
    co: 'colorado',
    ny: 'new_york'
};

export function normalizeCityCode(code) {
    const raw = (code || '').toString().trim().toLowerCase();
    if (!raw) return null;
    // Already a full city id (or an unknown value) — pass it through unchanged.
    return CITY_CODE_TO_ID[raw] || raw;
}

// The stored thumbnail URL has to be absolute. In production the API sits behind a proxy on a fixed
// origin (PUBLIC_API_BASE_URL); otherwise fall back to the origin the request came in on.
function resolveThumbnailBaseUrl(req) {
    if (process.env.PUBLIC_API_BASE_URL) {
        return process.env.PUBLIC_API_BASE_URL.replace(/\/$/, '');
    }
    return `${req.protocol}://${req.get('host')}`;
}

async function generateProposalThumbnailForRequest(pool, proposal, { city, proposalId, req }) {
    const render = generateAndStoreProposalThumbnail(pool, proposal, {
        city,
        proposalId,
        baseUrl: resolveThumbnailBaseUrl(req)
    });

    let timer = null;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`Thumbnail render exceeded ${THUMBNAIL_DEADLINE_MS}ms`)),
            THUMBNAIL_DEADLINE_MS
        );
        if (typeof timer.unref === 'function') timer.unref();
    });

    try {
        return await Promise.race([render, deadline]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

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

function stringArrayValidator(fieldLabel) {
    return validators.arrayOf(
        validators.string({
            label: fieldLabel,
            minLength: 1,
            disallowControlChars: true,
            minLengthMessage: `${fieldLabel} must not contain empty values.`,
            controlCharsMessage: `${fieldLabel} contains invalid control characters.`
        }),
        { label: fieldLabel }
    );
}

// The frontend stores bounds as either an `[minX, minY, maxX, maxY]` array (legacy / direct
// lat-lng) or a `{north, south, east, west, ...}` object (current `calculateProposalBounds`).
// The DB column is JSONB so we accept and pass through either shape after a sanity check.
function boundsValidator(value) {
    if (value === null || value === undefined) return { ok: true, value: null };

    if (Array.isArray(value)) {
        if (value.length !== 4) return { ok: false, error: 'bounds array must have 4 numbers.' };
        for (let i = 0; i < 4; i++) {
            if (!Number.isFinite(value[i])) return { ok: false, error: `bounds[${i}] must be a finite number.` };
        }
        return { ok: true, value };
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const numericKeys = ['north', 'south', 'east', 'west', 'minX', 'minY', 'maxX', 'maxY', 'minLng', 'minLat', 'maxLng', 'maxLat'];
        for (const key of numericKeys) {
            if (key in value && !Number.isFinite(Number(value[key]))) {
                return { ok: false, error: `bounds.${key} must be a finite number.` };
            }
        }
        return { ok: true, value };
    }

    return { ok: false, error: 'bounds must be an array or an object.' };
}

// The frontend stores lens as `[{address, name}, ...]`, but older callers and on-chain reads
// produce plain string arrays. Accept both shapes; preserve the input value as-is for JSONB storage.
function lensArrayValidator(value) {
    if (value === null || value === undefined) return { ok: true, value: null };
    if (!Array.isArray(value)) return { ok: false, error: 'lens must be an array.' };
    for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (typeof item === 'string') {
            if (!item.trim()) {
                return { ok: false, error: 'lens must not contain empty values.' };
            }
            continue;
        }
        if (item && typeof item === 'object' && !Array.isArray(item)) {
            const address = typeof item.address === 'string' ? item.address.trim() : '';
            const name = typeof item.name === 'string' ? item.name.trim() : '';
            if (!address && !name) {
                return { ok: false, error: `lens entry at index ${i} must have an address or name.` };
            }
            continue;
        }
        return { ok: false, error: `lens entry at index ${i} must be a string or an object with an address.` };
    }
    return { ok: true, value };
}

const proposalCreateBodyValidator = createJsonBodyValidator({
    allowUnknownFields: true,
    schema: {
        proposalId: { required: false, validate: validateIdentifierField('proposalId') },
        id: { required: false, validate: validateIdentifierField('id') },
        proposal_id: { required: false, validate: validateIdentifierField('proposal_id') },
        city: { required: false, validate: validators.string({ maxLength: MAX_CITY_LENGTH, label: 'city', disallowControlChars: true }) },
        name: { required: false, validate: validators.optional(validators.string({ maxLength: MAX_TITLE_LENGTH, label: 'name', disallowControlChars: true })) },
        title: { required: false, validate: validators.optional(validators.string({ maxLength: MAX_TITLE_LENGTH, label: 'title', disallowControlChars: true })) },
        description: { required: false, validate: validators.optional(validators.string({ label: 'description', disallowControlChars: true })) },
        author: { required: false, validate: validators.optional(validators.string({ maxLength: MAX_AUTHOR_LENGTH, label: 'author', disallowControlChars: true })) },
        type: { required: false, validate: validators.optional(validators.string({ maxLength: MAX_TYPE_LENGTH, label: 'type', disallowControlChars: true })) },
        status: { required: false, validate: validators.optional(validators.string({ maxLength: MAX_STATUS_LENGTH, label: 'status', disallowControlChars: true })) },
        lifecycleStatus: { required: false, validate: validators.optional(validators.string({ maxLength: MAX_STATUS_LENGTH, label: 'lifecycleStatus', disallowControlChars: true })) },
        applied: { required: false, validate: validators.optional(validators.boolean({ label: 'applied' })) },
        offer: { required: false, validate: validators.optional(validators.finiteNumber({ label: 'offer' })) },
        offerCurrency: { required: false, validate: validators.optional(validators.string({ maxLength: MAX_CURRENCY_LENGTH, label: 'offerCurrency', disallowControlChars: true })) },
        offer_currency: { required: false, validate: validators.optional(validators.string({ maxLength: MAX_CURRENCY_LENGTH, label: 'offer_currency', disallowControlChars: true })) },
        budget: { required: false, validate: validators.optional(validators.finiteNumber({ label: 'budget' })) },
        budgetCurrency: { required: false, validate: validators.optional(validators.string({ maxLength: MAX_CURRENCY_LENGTH, label: 'budgetCurrency', disallowControlChars: true })) },
        budget_currency: { required: false, validate: validators.optional(validators.string({ maxLength: MAX_CURRENCY_LENGTH, label: 'budget_currency', disallowControlChars: true })) },
        createdAt: { required: false, validate: validators.optional(validators.date({ label: 'createdAt' })) },
        expiresAt: { required: false, validate: validators.optional(validators.date({ label: 'expiresAt' })) },
        decayEnabled: { required: false, validate: validators.optional(validators.boolean({ label: 'decayEnabled' }), { nullValue: false }) },
        decayPercent: { required: false, validate: validators.optional(validators.finiteNumber({ label: 'decayPercent', integer: true })) },
        decayDurationMs: { required: false, validate: validators.optional(validators.finiteNumber({ label: 'decayDurationMs', integer: true })) },
        depositEnabled: { required: false, validate: validators.optional(validators.boolean({ label: 'depositEnabled' }), { nullValue: false }) },
        depositPercent: { required: false, validate: validators.optional(validators.finiteNumber({ label: 'depositPercent', integer: true })) },
        isConditional: { required: false, validate: validators.optional(validators.boolean({ label: 'isConditional' }), { nullValue: false }) },
        disbursementMode: { required: false, validate: validators.optional(validators.string({ maxLength: MAX_DISBURSEMENT_MODE_LENGTH, label: 'disbursementMode', disallowControlChars: true })) },
        parentParcelIds: { required: false, validate: validators.optional(stringArrayValidator('parentParcelIds'), { nullValue: [] }) },
        // Cadastral (base) parcels the geometry covers — stable across machines, unlike the derived
        // ids parentParcelIds may hold. Additive: nothing reads it yet. See rethink-proposals.md.
        cadastreParcelIds: { required: false, validate: validators.optional(stringArrayValidator('cadastreParcelIds'), { nullValue: [] }) },
        childParcelIds: { required: false, validate: validators.optional(stringArrayValidator('childParcelIds'), { nullValue: [] }) },
        acceptedParcelIds: { required: false, validate: validators.optional(stringArrayValidator('acceptedParcelIds'), { nullValue: [] }) },
        ownerAcceptances: { required: false, validate: validators.optional(validators.plainObject({ label: 'ownerAcceptances' }), { nullValue: {} }) },
        roadProposal: { required: false, validate: validators.optional(validators.plainObject({ label: 'roadProposal' })) },
        buildingProposal: { required: false, validate: validators.optional(validators.plainObject({ label: 'buildingProposal' })) },
        structureProposal: { required: false, validate: validators.optional(validators.plainObject({ label: 'structureProposal' })) },
        reparcellization: { required: false, validate: validators.optional(validators.plainObject({ label: 'reparcellization' })) },
        parentProposals: { required: false, validate: validators.optional(stringArrayValidator('parentProposals'), { nullValue: [] }) },
        childProposals: { required: false, validate: validators.optional(stringArrayValidator('childProposals'), { nullValue: [] }) },
        lens: { required: false, validate: lensArrayValidator },
        bounds: { required: false, validate: boundsValidator },
        onchain: { required: false, validate: validators.optional(validators.plainObject({ label: 'onchain' })) },
        onchainData: { required: false, validate: validators.optional(validators.plainObject({ label: 'onchainData' })) },
        screenshotUrl: { required: false, validate: validators.optional(validators.string({ maxLength: 2000, label: 'screenshotUrl', disallowControlChars: true })) },
        screenshot_url: { required: false, validate: validators.optional(validators.string({ maxLength: 2000, label: 'screenshot_url', disallowControlChars: true })) }
    }
});

const proposalScreenshotPatchValidator = createJsonBodyValidator({
    schema: {
        screenshotUrl: {
            required: true,
            missingMessage: 'screenshotUrl is required.',
            validate: validators.string({ maxLength: 2000, label: 'screenshotUrl', disallowControlChars: true, minLength: 1, minLengthMessage: 'screenshotUrl is required.' })
        }
    }
});

export function setupProposalsRoute(app, pool) {
    // The marketplace/on-chain LIFECYCLE status, past-expiry-aware. A proposal past expires_at reads
    // as 'Expired' even if the stored value is stale. This one expression is used both for the
    // returned lifecycleStatus and for the ?lifecycle= FILTER, so filtering and display agree
    // (case-insensitive — the DB may carry both 'Executed' and 'executed').
    const EFFECTIVE_STATUS_SQL = `
        CASE
            WHEN LOWER(COALESCE(lifecycle_status, '')) NOT IN ('executed', 'cancelled', 'expired')
                AND expires_at IS NOT NULL AND expires_at <= now()
            THEN 'Expired'
            WHEN LOWER(COALESCE(lifecycle_status, '')) = 'executed' THEN 'Executed'
            WHEN LOWER(COALESCE(lifecycle_status, '')) = 'cancelled' THEN 'Cancelled'
            WHEN LOWER(COALESCE(lifecycle_status, '')) = 'expired' THEN 'Expired'
            WHEN LOWER(COALESCE(lifecycle_status, '')) = 'draft' THEN 'draft'
            ELSE 'Active'
        END`;

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
        // The lifecycle-phase filter (Active/Executed/Cancelled/Expired). Named `?lifecycle=`.
        const lifecycleRaw = typeof req.query.lifecycle === 'string' && req.query.lifecycle.trim()
            ? req.query.lifecycle.trim()
            : null;
        const lifecycle = lifecycleRaw ? canonicalizeLifecycleStatus(lifecycleRaw) : null;
        const type = req.query.type;
        const author = req.query.author;
        const goal = typeof req.query.goal === 'string' && req.query.goal.trim() ? req.query.goal.trim() : null;
        const q = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : null;
        const sort = Object.prototype.hasOwnProperty.call(SORT_ORDER_BY, req.query.sort) ? req.query.sort : null;
        const limit = parseInt(req.query.limit, 10);
        const offset = parseInt(req.query.offset, 10);

        return {
            city,
            lifecycle,
            lifecycleError: lifecycleRaw && !lifecycle
                ? 'lifecycle must be one of: Active, Executed, Cancelled, Expired, draft.'
                : null,
            type,
            author,
            goal,
            q,
            sort,
            limit: Number.isFinite(limit) && limit > 0 ? limit : 100,
            offset: Number.isFinite(offset) && offset >= 0 ? offset : 0
        };
    };

    const buildFilterQuery = ({
        city,
        lifecycle,
        type,
        author,
        goal,
        q,
        sort,
        baseSelect,
        includePagination = true,
        limit,
        offset
    }) => {
        let sql = baseSelect || '';
        const params = [];
        const clauses = [];

        if (city) {
            clauses.push(`city = $${params.length + 1}`);
            params.push(city);
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
            clauses.push(`COALESCE(proposal_data->>'goal', type) = $${params.length + 1}`);
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

    app.post('/proposals', proposalCreateBodyValidator, async (req, res) => {
        try {
            const proposal = req.body;
            const validated = req.validatedBody;

            const city = normalizeCityCode(validated.city) || null;
            const proposalId = validated.proposalId ?? validated.id ?? validated.proposal_id ?? `local-${Date.now()}`;
            const name = validated.name ?? null;
            const title = validated.title ?? validated.name ?? null;
            const description = validated.description ?? null;
            const author = validated.author ?? null;
            const type = validated.type ?? null;
            const lifecycleResult = resolveIncomingLifecycleStatus(validated);
            if (!lifecycleResult.ok) {
                return res.status(400).json({ error: lifecycleResult.error });
            }
            const lifecycleStatus = lifecycleResult.value;
            const offer = validated.offer ?? null;
            const offerCurrency = validated.offerCurrency ?? validated.offer_currency ?? null;
            const budget = validated.budget ?? null;
            const budgetCurrency = validated.budgetCurrency ?? validated.budget_currency ?? null;
            const createdAt = validated.createdAt || new Date();
            const expiresAt = validated.expiresAt ?? null;
            const decayEnabled = validated.decayEnabled ?? false;
            const decayPercent = validated.decayPercent ?? null;
            const decayDurationMs = validated.decayDurationMs ?? null;
            const depositEnabled = validated.depositEnabled ?? false;
            const depositPercent = validated.depositPercent ?? null;
            const isConditional = validated.isConditional ?? false;
            const disbursementMode = validated.disbursementMode ?? null;

            const parentParcelIds = validated.parentParcelIds ?? [];
            const cadastreParcelIds = validated.cadastreParcelIds ?? [];
            const childParcelIds = validated.childParcelIds ?? [];
            const acceptedParcelIds = validated.acceptedParcelIds ?? [];
            const ownerAcceptances = validated.ownerAcceptances ?? {};

            const roadProposal = validated.roadProposal ?? null;
            const buildingProposal = validated.buildingProposal ?? null;
            const structureProposal = validated.structureProposal ?? null;
            let reparcellization = validated.reparcellization ?? null;

            const parentFeatures = null;
            const childFeatures = null;

            const parentProposalIds = validated.parentProposals ?? [];
            const childProposalIds = validated.childProposals ?? [];

            const lens = validated.lens ?? null;
            const bounds = validated.bounds ?? null;
            const onchainData = validated.onchain ?? validated.onchainData ?? null;
            const screenshotUrl = validated.screenshotUrl ?? validated.screenshot_url ?? null;

            // Corridor acquisition stats were scraped from the client's DOM and trusted. Recompute
            // them from PostGIS and overwrite the client copy (best-effort + Zagreb-only inside;
            // returns null on any failure, so a bad recompute never blocks proposal creation).
            if (roadProposal) {
                const serverStats = await recomputeCorridorStats(pool, proposal);
                if (serverStats) {
                    proposal.ownershipAndAcquisitionStats = serverStats;
                    if (roadProposal.definition && typeof roadProposal.definition === 'object') {
                        roadProposal.definition.metadata = roadProposal.definition.metadata || {};
                        roadProposal.definition.metadata.ownershipAndAcquisitionStats = serverStats;
                    }
                }
            }

            // Reparcellization land shares are recomputed from the stored child geometry (percents
            // must match the polygons, sum to ~100). The geometry-truth overwrites the client numbers
            // and validated:false flags a mismatch. Soft: a bad plan is still stored, just marked.
            if (reparcellization) {
                const validatedReparcellization = validateReparcellizationShares(reparcellization);
                if (validatedReparcellization) {
                    reparcellization = validatedReparcellization;
                    proposal.reparcellization = validatedReparcellization;
                }
            }

            const proposalData = stripLocalProposalState({ ...proposal, lifecycleStatus, reparcellization });
            const storedRoadProposal = proposalData.roadProposal ?? null;
            const storedBuildingProposal = proposalData.buildingProposal ?? null;
            const storedStructureProposal = proposalData.structureProposal ?? null;
            const storedReparcellization = proposalData.reparcellization ?? null;

            const sql = `
                INSERT INTO proposal (
                    proposal_id, city, name, title, description, author, type,
                    lifecycle_status,
                    offer, offer_currency, budget, budget_currency,
                    created_at, expires_at,
                    decay_enabled, decay_percent, decay_duration_ms,
                    deposit_enabled, deposit_percent,
                    is_conditional, disbursement_mode,
                    ancestor_parcel_ids, cadastre_parcel_ids, descendant_parcel_ids, accepted_parcel_ids, owner_acceptances,
                    road_proposal, building_proposal, structure_proposal, reparcellization,
                    parent_features, child_features,
                    parent_proposal_ids, child_proposal_ids,
                    lens, bounds, onchain_data, screenshot_url, proposal_data
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7,
                    $8,
                    $9, $10, $11, $12,
                    $13, $14,
                    $15, $16, $17,
                    $18, $19,
                    $20, $21,
                    $22, $23, $24, $25, $26,
                    $27, $28, $29, $30,
                    $31, $32,
                    $33, $34,
                    $35, $36, $37, $38, $39
                )
                RETURNING id, proposal_id, created_at
            `;

            const params = [
                proposalId, city, name, title, description, author, type,
                lifecycleStatus,
                offer, offerCurrency, budget, budgetCurrency,
                createdAt, expiresAt,
                decayEnabled, decayPercent, decayDurationMs,
                depositEnabled, depositPercent,
                isConditional, disbursementMode,
                parentParcelIds.length ? JSON.stringify(parentParcelIds) : null,
                cadastreParcelIds.length ? JSON.stringify(cadastreParcelIds) : null,
                childParcelIds.length ? JSON.stringify(childParcelIds) : null,
                acceptedParcelIds.length ? JSON.stringify(acceptedParcelIds) : null,
                Object.keys(ownerAcceptances).length ? JSON.stringify(ownerAcceptances) : null,
                storedRoadProposal ? JSON.stringify(storedRoadProposal) : null,
                storedBuildingProposal ? JSON.stringify(storedBuildingProposal) : null,
                storedStructureProposal ? JSON.stringify(storedStructureProposal) : null,
                storedReparcellization ? JSON.stringify(storedReparcellization) : null,
                parentFeatures,
                childFeatures,
                parentProposalIds.length ? JSON.stringify(parentProposalIds) : null,
                childProposalIds.length ? JSON.stringify(childProposalIds) : null,
                lens ? JSON.stringify(lens) : null,
                bounds ? JSON.stringify(bounds) : null,
                onchainData ? JSON.stringify(onchainData) : null,
                screenshotUrl,
                JSON.stringify(proposalData)
            ];

            const result = await pool.query(sql, params);
            const inserted = result.rows[0];
            const dbId = inserted.id;

            const updateSql = `
                UPDATE proposal
                SET proposal_data = jsonb_set(
                        proposal_data,
                        '{proposalId}',
                        to_jsonb(proposal_id)
                    ) || jsonb_set(
                        proposal_data,
                        '{proposal_id}',
                        to_jsonb(proposal_id)
                    ) || jsonb_set(
                        proposal_data,
                        '{id}',
                        to_jsonb(id::text)
                    )
                WHERE id = $1
            `;
            await pool.query(updateSql, [dbId]);

            // Thumbnails are rendered here, on the server, so that every uploaded proposal has one —
            // the old client-side capture only ran for whoever happened to have the proposal open in
            // the right city with tiles loaded, which is why almost nothing had a thumbnail.
            //
            // This runs AFTER the insert has committed and can never fail the upload: a proposal
            // whose picture cannot be drawn is still a proposal. On failure we log loudly and return
            // the proposal without a screenshotUrl; the backfill script can pick it up later.
            let generatedScreenshotUrl = null;
            if (!screenshotUrl) {
                try {
                    const result = await generateProposalThumbnailForRequest(pool, proposalData, {
                        city,
                        proposalId: dbId,
                        req
                    });
                    if (result) {
                        await pool.query(
                            `UPDATE proposal SET screenshot_url = $1 WHERE id = $2 AND screenshot_url IS NULL`,
                            [result.url, dbId]
                        );
                        generatedScreenshotUrl = result.url;
                        console.log(`[proposal ${dbId}] thumbnail rendered: ${result.url} ` +
                            `(zoom ${result.frame.zoom}, ${result.tiles.loaded}/${result.tiles.total} tiles, ${result.bytes} bytes)`);
                    }
                } catch (thumbErr) {
                    console.error(`[proposal ${dbId}] THUMBNAIL GENERATION FAILED (proposal was still created):`, thumbErr);
                }
            }

            res.status(201).json({
                id: dbId,
                proposalId: inserted.proposal_id,
                createdAt: inserted.created_at,
                screenshotUrl: screenshotUrl || generatedScreenshotUrl || null
            });
        } catch (err) {
            console.error('Error in POST /proposals:', err);

            if (err.code === '23505') {
                const requestBody = req.validatedBody || req.body || {};
                let conflictingProposalId = requestBody.proposalId ?? requestBody.id ?? requestBody.proposal_id;

                if (!conflictingProposalId && err.detail) {
                    const match = err.detail.match(/\(proposal_id\)=\(([^)]+)\)/);
                    if (match && match[1]) conflictingProposalId = match[1];
                }

                if (conflictingProposalId) {
                    try {
                        const existingSql = `
                            SELECT id, proposal_id
                            FROM proposal
                            WHERE proposal_id = $1
                            LIMIT 1
                        `;
                        const existingResult = await pool.query(existingSql, [conflictingProposalId]);
                        if (existingResult.rows.length > 0) {
                            return res.status(409).json({
                                error: 'Proposal with this ID already exists',
                                id: existingResult.rows[0].id,
                                proposalId: existingResult.rows[0].proposal_id
                            });
                        }
                    } catch (lookupErr) {
                        console.error('Error looking up existing proposal:', lookupErr);
                    }
                }

                return res.status(409).json({ error: 'Proposal with this ID already exists' });
            }

            res.status(500).json({ error: 'Internal server error' });
        }
    });

    app.get('/proposals/count', async (req, res) => {
        try {
            const filters = parseFilters(req);
            if (filters.lifecycleError) return res.status(400).json({ error: filters.lifecycleError });
            const { sql, params } = buildFilterQuery({
                ...filters,
                baseSelect: '\n            SELECT COUNT(*) AS count FROM proposal',
                includePagination: false
            });

            const result = await pool.query(sql, params);
            const count = result.rows.length > 0 ? parseInt(result.rows[0].count, 10) : 0;

            res.json({
                count,
                city: filters.city || null,
                lifecycle: filters.lifecycle || null,
                type: filters.type || null,
                author: filters.author || null
            });
        } catch (err) {
            console.error('Error in GET /proposals/count:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // Per-parcel proposal counts for the map badges. The client passes the parcel ids it can see
    // (?parcel_ids=a,b,c) and gets { counts: { a: 2, c: 1 } } back — one query over the ancestor +
    // descendant id arrays, so every user sees the same badge instead of a count of only what their
    // browser happens to have downloaded. Ids with no proposals are simply absent (treat as 0).
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

            // Pre-filter with ?| (GIN-indexed) so only proposals touching a requested id are scanned,
            // then unnest each proposal's ancestor+descendant ids and count per requested id.
            const sql = `
                SELECT ids.pid AS parcel_id, COUNT(DISTINCT p.id)::int AS n
                FROM proposal p
                CROSS JOIN LATERAL (
                    SELECT DISTINCT e AS pid
                    FROM jsonb_array_elements_text(
                        COALESCE(p.ancestor_parcel_ids, '[]'::jsonb) || COALESCE(p.descendant_parcel_ids, '[]'::jsonb)
                    ) AS e
                ) ids
                WHERE (p.ancestor_parcel_ids ?| $1::text[] OR p.descendant_parcel_ids ?| $1::text[])
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

            const { sql, params } = buildFilterQuery({
                ...filters,
                baseSelect: `
            SELECT
                id,
                proposal_id,
                city,
                COALESCE(name, title, proposal_data->>'name', proposal_data->>'title') AS display_name,
                COALESCE(title, name, proposal_data->>'title', proposal_data->>'name') AS display_title,
                COALESCE(author, proposal_data->>'author') AS author,
                COALESCE(type, proposal_data->>'type') AS type,
                -- The goal is the specific proposal kind (building / structure / reparcellization /
                -- road / ...); type is the lossy backend column. Serving goal here stops the client
                -- re-deriving it from type and mis-badging building/structure/parcel rows.
                COALESCE(proposal_data->>'goal', type) AS goal,
                ${EFFECTIVE_STATUS_SQL} AS effective_status,
                created_at,
                COALESCE(screenshot_url, onchain_data->>'imageUrl') AS screenshot_url,
                COUNT(*) OVER() AS total_count
            FROM proposal`,
                includePagination: true
            });

            const result = await pool.query(sql, params);
            const proposals = result.rows.map(row => {
                const proposal = serializeProposalRow({
                    ...row,
                    name: row.display_name || row.display_title || null,
                    title: row.display_title || row.display_name || null
                });
                return {
                    id: proposal.id,
                    proposalId: proposal.proposalId,
                    city: proposal.city || null,
                    name: proposal.name || null,
                    title: proposal.title || null,
                    author: proposal.author || null,
                    type: proposal.type || null,
                    goal: row.goal || null,
                    lifecycleStatus: proposal.lifecycleStatus,
                    createdAt: proposal.createdAt || null,
                    screenshotUrl: proposal.screenshotUrl || null
                };
            });

            const totalCount = result.rows.length > 0 && result.rows[0].total_count !== undefined
                ? parseInt(result.rows[0].total_count, 10)
                : proposals.length;

            res.json({
                proposals,
                count: totalCount,
                limit: filters.limit,
                offset: filters.offset
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
                WHERE proposal_id = $1 OR id::text = $1
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
            res.setHeader('X-Proposal-Id', row.id);
            res.setHeader('X-Proposal-ProposalId', row.proposal_id);

            return res.status(200).end();
        } catch (err) {
            console.error('Error in HEAD /proposals/:id:', err);
            return res.status(500).end();
        }
    });

    app.get('/proposals/:id', async (req, res) => {
        try {
            const idParam = req.params.id;
            if (!idParam) {
                return res.status(400).json({ error: 'Invalid proposal id. Must be provided.' });
            }

            const sql = `
                SELECT
                    id, proposal_id, city, name, title, description, author, type,
                    lifecycle_status, ${EFFECTIVE_STATUS_SQL} AS effective_status,
                    offer, offer_currency, budget, budget_currency,
                    created_at, expires_at, updated_at,
                    decay_enabled, decay_percent, decay_duration_ms,
                    deposit_enabled, deposit_percent,
                    is_conditional, disbursement_mode,
                    ancestor_parcel_ids, cadastre_parcel_ids, descendant_parcel_ids, accepted_parcel_ids, owner_acceptances,
                    road_proposal, building_proposal, structure_proposal, reparcellization,
                    parent_features, child_features,
                    parent_proposal_ids, child_proposal_ids,
                    lens, bounds, onchain_data, screenshot_url, proposal_data
                FROM proposal
                WHERE proposal_id = $1 OR id::text = $1
            `;

            const result = await pool.query(sql, [idParam]);
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Proposal not found' });
            }

            res.json(serializeProposalRow(result.rows[0]));
        } catch (err) {
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
            const limit = filters.limit;
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

            clauses.push(`(ancestor_parcel_ids @> $${params.length + 1}::jsonb OR descendant_parcel_ids @> $${params.length + 1}::jsonb)`);
            params.push(JSON.stringify([String(parcelId)]));

            const sql = `
                SELECT
                    id, proposal_id, city, name, title, description, author, type,
                    lifecycle_status, ${EFFECTIVE_STATUS_SQL} AS effective_status,
                    offer, offer_currency, budget, budget_currency,
                    created_at, expires_at, updated_at,
                    ancestor_parcel_ids, descendant_parcel_ids,
                    onchain_data, screenshot_url, proposal_data
                FROM proposal
                WHERE ${clauses.join(' AND ')}
                ORDER BY created_at DESC
                LIMIT $${params.length + 1} OFFSET $${params.length + 2}
            `;

            params.push(limit, offset);
            const result = await pool.query(sql, params);

            const proposals = result.rows.map(row => serializeProposalRow(row));

            res.json({ proposals, count: proposals.length, limit, offset, parcelId });
        } catch (err) {
            console.error('Error in GET /proposals?parcel_id:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    app.patch('/proposals/:id/screenshot', proposalScreenshotPatchValidator, async (req, res) => {
        try {
            const idParam = req.params.id;
            if (!idParam) {
                return res.status(400).json({ error: 'Invalid proposal id. Must be provided.' });
            }
            const { screenshotUrl } = req.validatedBody;

            const sql = `
                UPDATE proposal
                SET screenshot_url = $1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE proposal_id = $2 OR id::text = $2
                RETURNING id, proposal_id, screenshot_url
            `;
            const result = await pool.query(sql, [screenshotUrl, idParam]);
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Proposal not found' });
            }
            const row = result.rows[0];
            res.json({
                id: row.id,
                proposalId: row.proposal_id,
                screenshotUrl: row.screenshot_url
            });
        } catch (err) {
            console.error('Error in PATCH /proposals/:id/screenshot:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
}
