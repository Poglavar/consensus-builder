// Proposals API endpoints
// POST /proposals - Store a proposal and get back an id
// GET /proposals/:id - Get a proposal by proposal_id (unique globally)

export function setupProposalsRoute(app, pool) {
    const DEFAULT_LIMIT = 100;
    const MAX_LIMIT = 1000;

    const normalizeCityCode = (code) => {
        const raw = (code || '').toString().trim().toLowerCase();
        if (!raw) return null;
        if (raw === 'zg' || raw === 'zgb') return 'zagreb';
        if (raw === 'bg') return 'belgrade';
        if (raw === 'ba' || raw === 'caba' || raw === 'ar-ba') return 'buenos_aires';
        return raw;
    };

    const validatePagination = (reqLimit, reqOffset) => {
        const limit = parseInt(reqLimit, 10);
        const offset = parseInt(reqOffset, 10);

        return {
            limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT,
            offset: Number.isFinite(offset) && offset >= 0 ? offset : 0
        };
    };

    const parseFilters = (req) => {
        const city = normalizeCityCode(req.query.city);
        const status = req.query.status;
        const type = req.query.type;
        const author = req.query.author;
        const { limit, offset } = validatePagination(req.query.limit, req.query.offset);

        return {
            city,
            status,
            type,
            author,
            limit,
            offset
        };
    };

    const buildFilterQuery = ({
        city,
        status,
        type,
        author,
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

        if (status) {
            clauses.push(`status = $${params.length + 1}`);
            params.push(status);
        }

        if (type) {
            clauses.push(`type = $${params.length + 1}`);
            params.push(type);
        }

        if (author) {
            clauses.push(`author = $${params.length + 1}`);
            params.push(author);
        }

        if (clauses.length) {
            sql += `\n            WHERE ${clauses.join(' AND ')}`;
        }

        if (includePagination) {
            sql += `\n            ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
            params.push(limit, offset);
        }

        return { sql, params };
    };

    app.post('/proposals', async (req, res) => {
        try {
            const proposal = req.body;
            if (!proposal || typeof proposal !== 'object') {
                return res.status(400).json({ error: 'Invalid proposal data. Expected a JSON object.' });
            }

            const city = normalizeCityCode(proposal.city) || null;
            const proposalId = proposal.proposalId || proposal.id || proposal.proposal_id || `local-${Date.now()}`;
            const name = proposal.name || null;
            const title = proposal.title || proposal.name || null;
            const description = proposal.description || null;
            const author = proposal.author || null;
            const type = proposal.type || null;
            const status = proposal.status || null;
            const offer = proposal.offer !== undefined && proposal.offer !== null ? parseFloat(proposal.offer) : null;
            const offerCurrency = proposal.offerCurrency || proposal.offer_currency || null;
            const budget = proposal.budget !== undefined && proposal.budget !== null ? parseFloat(proposal.budget) : null;
            const budgetCurrency = proposal.budgetCurrency || proposal.budget_currency || null;
            const createdAt = proposal.createdAt ? new Date(proposal.createdAt) : new Date();
            const expiresAt = proposal.expiresAt ? new Date(proposal.expiresAt) : null;
            const decayEnabled = !!proposal.decayEnabled;
            const decayPercent = proposal.decayPercent || null;
            const decayDurationMs = proposal.decayDurationMs || null;
            const depositEnabled = !!proposal.depositEnabled;
            const depositPercent = proposal.depositPercent || null;
            const isConditional = !!proposal.isConditional;
            const disbursementMode = proposal.disbursementMode || null;

            const parentParcelIds = Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds : [];
            const childParcelIds = Array.isArray(proposal.childParcelIds) ? proposal.childParcelIds : [];
            const acceptedParcelIds = Array.isArray(proposal.acceptedParcelIds) ? proposal.acceptedParcelIds : [];
            const ownerAcceptances = proposal.ownerAcceptances && typeof proposal.ownerAcceptances === 'object' ? proposal.ownerAcceptances : {};

            const roadProposal = proposal.roadProposal || null;
            const buildingProposal = proposal.buildingProposal || null;
            const structureProposal = proposal.structureProposal || null;
            const reparcellization = proposal.reparcellization || null;

            const parentFeatures = null;
            const childFeatures = null;

            const parentProposalIds = Array.isArray(proposal.parentProposals)
                ? proposal.parentProposals
                : proposal.parentProposals instanceof Set ? Array.from(proposal.parentProposals) : [];
            const childProposalIds = Array.isArray(proposal.childProposals)
                ? proposal.childProposals
                : proposal.childProposals instanceof Set ? Array.from(proposal.childProposals) : [];

            const lens = Array.isArray(proposal.lens) ? proposal.lens : null;
            const bounds = Array.isArray(proposal.bounds) ? proposal.bounds : null;
            const onchainData = proposal.onchain || proposal.onchainData || null;

            const proposalData = { ...proposal };

            const sql = `
                INSERT INTO proposal (
                    proposal_id, city, name, title, description, author, type, status,
                    offer, offer_currency, budget, budget_currency,
                    created_at, expires_at,
                    decay_enabled, decay_percent, decay_duration_ms,
                    deposit_enabled, deposit_percent,
                    is_conditional, disbursement_mode,
                    ancestor_parcel_ids, descendant_parcel_ids, accepted_parcel_ids, owner_acceptances,
                    road_proposal, building_proposal, structure_proposal, reparcellization,
                    parent_features, child_features,
                    parent_proposal_ids, child_proposal_ids,
                    lens, bounds, onchain_data, proposal_data
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8,
                    $9, $10, $11, $12,
                    $13, $14,
                    $15, $16, $17,
                    $18, $19,
                    $20, $21,
                    $22, $23, $24, $25,
                    $26, $27, $28, $29,
                    $30, $31,
                    $32, $33,
                    $34, $35, $36, $37
                )
                RETURNING id, proposal_id, created_at
            `;

            const params = [
                proposalId, city, name, title, description, author, type, status,
                offer, offerCurrency, budget, budgetCurrency,
                createdAt, expiresAt,
                decayEnabled, decayPercent, decayDurationMs,
                depositEnabled, depositPercent,
                isConditional, disbursementMode,
                parentParcelIds.length ? JSON.stringify(parentParcelIds) : null,
                childParcelIds.length ? JSON.stringify(childParcelIds) : null,
                acceptedParcelIds.length ? JSON.stringify(acceptedParcelIds) : null,
                Object.keys(ownerAcceptances).length ? JSON.stringify(ownerAcceptances) : null,
                roadProposal ? JSON.stringify(roadProposal) : null,
                buildingProposal ? JSON.stringify(buildingProposal) : null,
                structureProposal ? JSON.stringify(structureProposal) : null,
                reparcellization ? JSON.stringify(reparcellization) : null,
                parentFeatures,
                childFeatures,
                parentProposalIds.length ? JSON.stringify(parentProposalIds) : null,
                childProposalIds.length ? JSON.stringify(childProposalIds) : null,
                lens ? JSON.stringify(lens) : null,
                bounds ? JSON.stringify(bounds) : null,
                onchainData ? JSON.stringify(onchainData) : null,
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

            res.status(201).json({
                id: dbId,
                proposalId: inserted.proposal_id,
                createdAt: inserted.created_at
            });
        } catch (err) {
            console.error('Error in POST /proposals:', err);

            if (err.code === '23505') {
                const requestBody = req.body || {};
                let conflictingProposalId = requestBody.proposalId || requestBody.id || requestBody.proposal_id;

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

            res.status(500).json({ error: 'Internal server error', details: err.message });
        }
    });

    app.get('/proposals/count', async (req, res) => {
        try {
            const filters = parseFilters(req);
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
                status: filters.status || null,
                type: filters.type || null,
                author: filters.author || null
            });
        } catch (err) {
            console.error('Error in GET /proposals/count:', err);
            res.status(500).json({ error: 'Internal server error', details: err.message });
        }
    });

    app.get('/proposals/summary', async (req, res) => {
        try {
            const filters = parseFilters(req);

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
                status,
                created_at,
                COUNT(*) OVER() AS total_count
            FROM proposal`,
                includePagination: true
            });

            const result = await pool.query(sql, params);
            const proposals = result.rows.map(row => ({
                id: row.id,
                proposalId: row.proposal_id,
                city: row.city,
                name: row.display_name || row.display_title || null,
                title: row.display_title || row.display_name || null,
                author: row.author || null,
                type: row.type || null,
                status: row.status || null,
                createdAt: row.created_at ? row.created_at.toISOString() : null
            }));

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
            res.status(500).json({ error: 'Internal server error', details: err.message });
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
                    id, proposal_id, city, name, title, description, author, type, status,
                    offer, offer_currency, budget, budget_currency,
                    created_at, expires_at, updated_at,
                    decay_enabled, decay_percent, decay_duration_ms,
                    deposit_enabled, deposit_percent,
                    is_conditional, disbursement_mode,
                    ancestor_parcel_ids, descendant_parcel_ids, accepted_parcel_ids, owner_acceptances,
                    road_proposal, building_proposal, structure_proposal, reparcellization,
                    parent_features, child_features,
                    parent_proposal_ids, child_proposal_ids,
                    lens, bounds, onchain_data, proposal_data
                FROM proposal
                WHERE proposal_id = $1 OR id::text = $1
            `;

            const result = await pool.query(sql, [idParam]);
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Proposal not found' });
            }

            const row = result.rows[0];
            const proposal = row.proposal_data ? { ...row.proposal_data } : {};

            proposal.id = row.id;
            proposal.proposalId = row.proposal_id;
            proposal.city = row.city;
            proposal.name = row.name || proposal.name;
            proposal.title = row.title || proposal.title;
            proposal.description = row.description || proposal.description;
            proposal.author = row.author || proposal.author;
            proposal.type = row.type || proposal.type;
            proposal.status = row.status || proposal.status;
            proposal.offer = row.offer !== null ? parseFloat(row.offer) : proposal.offer;
            proposal.offerCurrency = row.offer_currency || proposal.offerCurrency;
            proposal.budget = row.budget !== null ? parseFloat(row.budget) : proposal.budget;
            proposal.budgetCurrency = row.budget_currency || proposal.budgetCurrency;
            proposal.createdAt = row.created_at ? row.created_at.toISOString() : proposal.createdAt;
            proposal.expiresAt = row.expires_at ? row.expires_at.toISOString() : proposal.expiresAt;
            proposal.updatedAt = row.updated_at ? row.updated_at.toISOString() : proposal.updatedAt;
            proposal.decayEnabled = row.decay_enabled || proposal.decayEnabled;
            proposal.decayPercent = row.decay_percent || proposal.decayPercent;
            proposal.decayDurationMs = row.decay_duration_ms || proposal.decayDurationMs;
            proposal.depositEnabled = row.deposit_enabled || proposal.depositEnabled;
            proposal.depositPercent = row.deposit_percent || proposal.depositPercent;
            proposal.isConditional = row.is_conditional || proposal.isConditional;
            proposal.disbursementMode = row.disbursement_mode || proposal.disbursementMode;
            proposal.parentParcelIds = row.ancestor_parcel_ids || proposal.parentParcelIds;
            proposal.childParcelIds = row.descendant_parcel_ids ?? proposal.childParcelIds;
            proposal.acceptedParcelIds = row.accepted_parcel_ids || proposal.acceptedParcelIds;
            proposal.ownerAcceptances = row.owner_acceptances || proposal.ownerAcceptances;
            proposal.roadProposal = row.road_proposal || proposal.roadProposal;
            proposal.buildingProposal = row.building_proposal || proposal.buildingProposal;
            proposal.structureProposal = row.structure_proposal || proposal.structureProposal;
            proposal.reparcellization = row.reparcellization || proposal.reparcellization;
            proposal.parentFeatures = null;
            proposal.childFeatures = null;
            proposal.parentProposals = row.parent_proposal_ids || proposal.parentProposals;
            proposal.childProposals = row.child_proposal_ids || proposal.childProposals;
            proposal.lens = row.lens || proposal.lens;
            proposal.bounds = row.bounds || proposal.bounds;
            proposal.onchain = row.onchain_data || proposal.onchain;
            proposal.onchainData = row.onchain_data || proposal.onchainData;

            res.json(proposal);
        } catch (err) {
            console.error('Error in GET /proposals/:id:', err);
            res.status(500).json({ error: 'Internal server error', details: err.message });
        }
    });

    app.get('/proposals', async (req, res) => {
        try {
            const parcelId = req.query.parcel_id;
            const city = normalizeCityCode(req.query.city);
            const { limit, offset } = validatePagination(req.query.limit, req.query.offset);

            if (!parcelId) {
                return res.status(400).json({ error: 'parcel_id query parameter is required' });
            }

            const clauses = [];
            const params = [];

            if (city) {
                clauses.push(`city = $${params.length + 1}`);
                params.push(city);
            }

            clauses.push(`(ancestor_parcel_ids @> $${params.length + 1}::jsonb OR descendant_parcel_ids @> $${params.length + 1}::jsonb)`);
            params.push(JSON.stringify([String(parcelId)]));

            const sql = `
                SELECT 
                    id, proposal_id, city, name, title, description, author, type, status,
                    offer, offer_currency, budget, budget_currency,
                    created_at, expires_at, updated_at,
                    ancestor_parcel_ids, descendant_parcel_ids,
                    proposal_data
                FROM proposal
                WHERE ${clauses.join(' AND ')}
                ORDER BY created_at DESC
                LIMIT $${params.length + 1} OFFSET $${params.length + 2}
            `;

            params.push(limit, offset);
            const result = await pool.query(sql, params);

            const proposals = result.rows.map(row => {
                if (row.proposal_data) {
                    const p = { ...row.proposal_data };
                    p.childParcelIds = row.descendant_parcel_ids ?? p.childParcelIds ?? null;
                    p.parentParcelIds = row.ancestor_parcel_ids ?? p.parentParcelIds ?? null;
                    return p;
                }

                return {
                    id: row.id,
                    proposalId: row.proposal_id,
                    city: row.city,
                    name: row.name,
                    title: row.title,
                    description: row.description,
                    author: row.author,
                    type: row.type,
                    status: row.status,
                    offer: row.offer !== null ? parseFloat(row.offer) : null,
                    offerCurrency: row.offer_currency,
                    budget: row.budget !== null ? parseFloat(row.budget) : null,
                    budgetCurrency: row.budget_currency,
                    createdAt: row.created_at ? row.created_at.toISOString() : null,
                    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
                    updatedAt: row.updated_at ? row.updated_at.toISOString() : null,
                    parentParcelIds: row.ancestor_parcel_ids,
                    childParcelIds: row.descendant_parcel_ids
                };
            });

            res.json({ proposals, count: proposals.length, limit, offset, parcelId });
        } catch (err) {
            console.error('Error in GET /proposals?parcel_id:', err);
            res.status(500).json({ error: 'Internal server error', details: err.message });
        }
    });
}

