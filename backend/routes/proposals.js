// Proposals API endpoints
// POST /proposals/ - Store a proposal and get back an id
// GET /proposals/:id - Get a proposal by database id (for sharing)
// GET /proposals/city/:proposal-id - Get a proposal by proposal_id
// GET /proposals/city/ - Get all proposals for a city

export function setupProposalsRoute(app, pool) {
    // POST /proposals/ - Store a proposal and get back an id
    app.post('/proposals/', async (req, res) => {
        try {
            const proposal = req.body;

            if (!proposal || typeof proposal !== 'object') {
                return res.status(400).json({ error: 'Invalid proposal data. Expected a JSON object.' });
            }

            // Extract proposalId or generate one
            // If the proposalId starts with 'local-', ignore it - we'll use the database SERIAL id instead
            let proposalId = proposal.proposalId || proposal.id;
            const isLocalId = !proposalId || String(proposalId).startsWith('local-');
            // For local IDs, we'll use a temporary placeholder and update it to the database id after insert
            if (isLocalId) {
                proposalId = `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            }
            const city = proposal.city || 'city';

            // Extract basic fields
            const name = proposal.name || proposal.title || proposal.proposalName || null;
            const title = proposal.title || proposal.name || proposal.proposalName || null;
            const description = proposal.description || null;
            const author = proposal.author || 'User';
            const type = proposal.type || 'parcel';
            const status = proposal.status || 'unapplied';

            // Extract financial fields
            const offer = proposal.offer !== undefined ? parseFloat(proposal.offer) : null;
            const offerCurrency = proposal.offerCurrency || 'USD';
            const budget = proposal.budget !== undefined ? parseFloat(proposal.budget) : null;
            const budgetCurrency = proposal.budgetCurrency || 'USD';

            // Extract timestamps
            const createdAt = proposal.createdAt ? new Date(proposal.createdAt) : new Date();
            const expiresAt = proposal.expiresAt ? new Date(proposal.expiresAt) : null;

            // Extract decay and deposit settings
            const decayEnabled = proposal.decayEnabled === true;
            const decayPercent = proposal.decayPercent !== undefined ? parseInt(proposal.decayPercent) : null;
            const decayDurationMs = proposal.decayDurationMs !== undefined ? parseInt(proposal.decayDurationMs) : null;
            const depositEnabled = proposal.depositEnabled === true;
            const depositPercent = proposal.depositPercent !== undefined ? parseInt(proposal.depositPercent) : null;

            // Extract conditional settings
            const isConditional = proposal.isConditional === true;
            const disbursementMode = proposal.disbursementMode || (isConditional ? 'conditional' : 'partial');

            // Extract parcel relationships
            const parentParcelIds = Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds : [];
            const childParcelIds = Array.isArray(proposal.childParcelIds) ? proposal.childParcelIds : [];
            const acceptedParcelIds = Array.isArray(proposal.acceptedParcelIds) ? proposal.acceptedParcelIds : [];
            const ownerAcceptances = proposal.ownerAcceptances && typeof proposal.ownerAcceptances === 'object'
                ? proposal.ownerAcceptances : {};

            // Extract type-specific proposals
            const roadProposal = proposal.roadProposal || null;
            const buildingProposal = proposal.buildingProposal || null;
            const structureProposal = proposal.structureProposal || null;
            const reparcellization = proposal.reparcellization || null;

            // Extract feature collections
            // Note: We no longer store parentFeatures or childFeatures (parcel geometries) - only IDs
            // Parcel geometries (ancestor and descendant) are fetched on load from the parcel service
            const parentFeatures = null; // Not stored - ancestor parcels fetched on load
            const childFeatures = null; // Not stored - descendant parcels fetched on load by ID

            // Extract dependency tracking
            const parentProposalIds = Array.isArray(proposal.parentProposals) ? proposal.parentProposals :
                (proposal.parentProposals instanceof Set ? Array.from(proposal.parentProposals) : []);
            const childProposalIds = Array.isArray(proposal.childProposals) ? proposal.childProposals :
                (proposal.childProposals instanceof Set ? Array.from(proposal.childProposals) : []);

            // Extract additional metadata
            const lens = Array.isArray(proposal.lens) ? proposal.lens : null;
            const bounds = Array.isArray(proposal.bounds) ? proposal.bounds : null;
            const onchainData = proposal.onchain || proposal.onchainData || null;

            // Store the complete proposal data for reconstruction
            // We'll update proposalId in proposal_data after we know the database id
            // Remove parentFeatures and childFeatures from proposal_data to avoid data duplication
            // Parcel geometries are fetched by ID when needed, not stored
            const proposalData = { ...proposal };

            // Insert into database
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
                parentParcelIds.length > 0 ? JSON.stringify(parentParcelIds) : null,
                childParcelIds.length > 0 ? JSON.stringify(childParcelIds) : null,
                acceptedParcelIds.length > 0 ? JSON.stringify(acceptedParcelIds) : null,
                Object.keys(ownerAcceptances).length > 0 ? JSON.stringify(ownerAcceptances) : null,
                roadProposal ? JSON.stringify(roadProposal) : null,
                buildingProposal ? JSON.stringify(buildingProposal) : null,
                structureProposal ? JSON.stringify(structureProposal) : null,
                reparcellization ? JSON.stringify(reparcellization) : null,
                null, // parentFeatures - no longer stored, fetched by ID on load
                null, // childFeatures - no longer stored, fetched by ID on load
                parentProposalIds.length > 0 ? JSON.stringify(parentProposalIds) : null,
                childProposalIds.length > 0 ? JSON.stringify(childProposalIds) : null,
                lens ? JSON.stringify(lens) : null,
                bounds ? JSON.stringify(bounds) : null,
                onchainData ? JSON.stringify(onchainData) : null,
                JSON.stringify(proposalData)
            ];

            const result = await pool.query(sql, params);
            const inserted = result.rows[0];
            const dbId = inserted.id;

            // If this was a local ID, update proposal_id to match the database SERIAL id
            if (isLocalId) {
                const updateSql = `
                    UPDATE proposal
                    SET proposal_id = $1::text,
                        proposal_data = jsonb_set(
                            proposal_data,
                            '{proposalId}',
                            to_jsonb($1::text)
                        ) || jsonb_set(
                            proposal_data,
                            '{proposal_id}',
                            to_jsonb($1::text)
                        ) || jsonb_set(
                            proposal_data,
                            '{id}',
                            to_jsonb($1::text)
                        )
                    WHERE id = $1
                    RETURNING proposal_id
                `;
                await pool.query(updateSql, [dbId]);
            } else {
                // For non-local IDs, update proposal_data to ensure consistency
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
            }

            // Return the database id (integer) as proposalId for local proposals, or the original proposal_id for others
            const returnedProposalId = isLocalId ? dbId : inserted.proposal_id;

            res.status(201).json({
                id: dbId,
                proposalId: returnedProposalId,
                createdAt: inserted.created_at
            });
        } catch (err) {
            console.error('Error in POST /proposals/:', err);

            // Handle unique constraint violation
            if (err.code === '23505') {
                // Find the existing proposal to return its database id
                // Extract proposalId from the request body, or from error detail as fallback
                const requestBody = req.body || {};
                let conflictingProposalId = requestBody.proposalId || requestBody.id;

                // If not found in request body, try to extract from error detail
                // Format: "Key (proposal_id)=(value) already exists."
                if (!conflictingProposalId && err.detail) {
                    const match = err.detail.match(/\(proposal_id\)=\(([^)]+)\)/);
                    if (match && match[1]) {
                        conflictingProposalId = match[1];
                    }
                }

                if (conflictingProposalId) {
                    try {
                        const existingSql = `
                            SELECT id, proposal_id, city
                            FROM proposal
                            WHERE proposal_id = $1
                            LIMIT 1
                        `;
                        const existingResult = await pool.query(existingSql, [conflictingProposalId]);

                        if (existingResult.rows.length > 0) {
                            console.log('Found existing proposal:', existingResult.rows[0].id, 'for proposal_id:', conflictingProposalId);
                            return res.status(409).json({
                                error: 'Proposal with this ID already exists',
                                id: existingResult.rows[0].id,
                                proposalId: existingResult.rows[0].proposal_id
                            });
                        } else {
                            console.warn('Unique constraint violation but proposal not found in lookup for proposal_id:', conflictingProposalId);
                        }
                    } catch (lookupErr) {
                        console.error('Error looking up existing proposal:', lookupErr);
                        // Try one more time with city if available
                        const requestCity = requestBody.city || 'city';
                        try {
                            const existingSqlWithCity = `
                                SELECT id, proposal_id, city
                                FROM proposal
                                WHERE proposal_id = $1 AND city = $2
                                LIMIT 1
                            `;
                            const existingResult = await pool.query(existingSqlWithCity, [conflictingProposalId, requestCity]);
                            if (existingResult.rows.length > 0) {
                                return res.status(409).json({
                                    error: 'Proposal with this ID already exists',
                                    id: existingResult.rows[0].id,
                                    proposalId: existingResult.rows[0].proposal_id
                                });
                            }
                        } catch (lookupErr2) {
                            console.error('Error in second lookup attempt:', lookupErr2);
                        }
                    }
                } else {
                    console.warn('Unique constraint violation but could not determine proposal_id from request');
                }

                // If we couldn't find the existing proposal, still return 409 but without id
                // This should be rare, but we handle it gracefully
                return res.status(409).json({ error: 'Proposal with this ID already exists' });
            }

            res.status(500).json({ error: 'Internal server error', details: err.message });
        }
    });

    // HEAD /proposals/:id - Check existence without returning the payload
    app.head('/proposals/:id', async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);

            if (!Number.isInteger(id) || id <= 0) {
                return res.status(400).end();
            }

            const sql = `
                SELECT id, proposal_id, updated_at, created_at
                FROM proposal
                WHERE id = $1
            `;

            const result = await pool.query(sql, [id]);

            if (result.rows.length === 0) {
                return res.status(404).end();
            }

            const row = result.rows[0];
            const lastModified = row.updated_at || row.created_at;
            if (lastModified) {
                res.setHeader('Last-Modified', new Date(lastModified).toUTCString());
                const weakEtag = `W/"proposal-${row.id}-${new Date(lastModified).getTime()}"`;
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

    // GET /proposals/:id - Get a proposal by database id (for sharing)
    app.get('/proposals/:id', async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);

            if (!Number.isInteger(id) || id <= 0) {
                return res.status(400).json({ error: 'Invalid proposal id. Must be a positive integer.' });
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
                WHERE id = $1
            `;

            const result = await pool.query(sql, [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Proposal not found' });
            }

            const row = result.rows[0];

            // Reconstruct the proposal object from stored data
            // Use proposal_data if available, otherwise reconstruct from individual fields
            let proposal = row.proposal_data ? row.proposal_data : {};

            // Override with individual fields if proposal_data is incomplete
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
            // parentFeatures and childFeatures no longer returned - fetched on load by ID
            // proposal.parentFeatures = row.parent_features || proposal.parentFeatures;
            proposal.parentFeatures = null; // Explicitly set to null - geometries fetched by ID
            // proposal.childFeatures = row.child_features || proposal.childFeatures;
            proposal.childFeatures = null; // Explicitly set to null - geometries fetched by ID
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

    // GET /proposals/city/:proposal-id - Get a proposal by id
    app.get('/proposals/city/:proposalId', async (req, res) => {
        try {
            const proposalId = req.params.proposalId;
            const city = req.query.city || 'city';

            if (!proposalId) {
                return res.status(400).json({ error: 'proposalId is required' });
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
                WHERE proposal_id = $1 AND city = $2
            `;

            const result = await pool.query(sql, [proposalId, city]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Proposal not found' });
            }

            const row = result.rows[0];

            // Reconstruct the proposal object from stored data
            // Use proposal_data if available, otherwise reconstruct from individual fields
            let proposal = row.proposal_data ? row.proposal_data : {};

            // Override with individual fields if proposal_data is incomplete
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
            // parentFeatures and childFeatures no longer returned - fetched on load by ID
            // proposal.parentFeatures = row.parent_features || proposal.parentFeatures;
            proposal.parentFeatures = null; // Explicitly set to null - geometries fetched by ID
            // proposal.childFeatures = row.child_features || proposal.childFeatures;
            proposal.childFeatures = null; // Explicitly set to null - geometries fetched by ID
            proposal.parentProposals = row.parent_proposal_ids || proposal.parentProposals;
            proposal.childProposals = row.child_proposal_ids || proposal.childProposals;
            proposal.lens = row.lens || proposal.lens;
            proposal.bounds = row.bounds || proposal.bounds;
            proposal.onchain = row.onchain_data || proposal.onchain;
            proposal.onchainData = row.onchain_data || proposal.onchainData;

            res.json(proposal);
        } catch (err) {
            console.error('Error in GET /proposals/city/:proposalId:', err);
            res.status(500).json({ error: 'Internal server error', details: err.message });
        }
    });

    // GET /proposals/city/ - Get all proposals for a city
    app.get('/proposals/city/', async (req, res) => {
        try {
            const city = req.query.city || 'city';
            const status = req.query.status;
            const type = req.query.type;
            const author = req.query.author;
            const limit = parseInt(req.query.limit) || 100;
            const offset = parseInt(req.query.offset) || 0;

            let sql = `
                SELECT 
                    id, proposal_id, city, name, title, description, author, type, status,
                    offer, offer_currency, budget, budget_currency,
                    created_at, expires_at, updated_at,
                    ancestor_parcel_ids, descendant_parcel_ids,
                    proposal_data
                FROM proposal
                WHERE city = $1
            `;

            const params = [city];
            let paramIndex = 2;

            if (status) {
                sql += ` AND status = $${paramIndex}`;
                params.push(status);
                paramIndex++;
            }

            if (type) {
                sql += ` AND type = $${paramIndex}`;
                params.push(type);
                paramIndex++;
            }

            if (author) {
                sql += ` AND author = $${paramIndex}`;
                params.push(author);
                paramIndex++;
            }

            sql += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(limit, offset);

            const result = await pool.query(sql, params);

            const proposals = result.rows.map(row => {
                // Return proposal_data if available, otherwise return summary
                if (row.proposal_data) {
                    const proposal = { ...row.proposal_data };
                    proposal.childParcelIds = row.descendant_parcel_ids ?? proposal.childParcelIds ?? null;
                    proposal.parentParcelIds = row.ancestor_parcel_ids ?? proposal.parentParcelIds ?? null;
                    return proposal;
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

            res.json({
                proposals,
                count: proposals.length,
                limit,
                offset
            });
        } catch (err) {
            console.error('Error in GET /proposals/city/:', err);
            res.status(500).json({ error: 'Internal server error', details: err.message });
        }
    });

    // PATCH /proposals/city/:proposal-id - Update a proposal
    app.patch('/proposals/city/:proposalId', async (req, res) => {
        try {
            const proposalId = req.params.proposalId;
            const city = req.query.city || 'city';
            const updates = req.body;

            if (!proposalId) {
                return res.status(400).json({ error: 'proposalId is required' });
            }

            if (!updates || typeof updates !== 'object') {
                return res.status(400).json({ error: 'Invalid update data. Expected a JSON object.' });
            }

            // Build dynamic update query
            const updateFields = [];
            const params = [];
            let paramIndex = 1;

            // List of allowed fields to update
            const allowedFields = {
                name: 'name',
                title: 'title',
                description: 'description',
                author: 'author',
                type: 'type',
                status: 'status',
                offer: 'offer',
                offerCurrency: 'offer_currency',
                budget: 'budget',
                budgetCurrency: 'budget_currency',
                expiresAt: 'expires_at',
                decayEnabled: 'decay_enabled',
                decayPercent: 'decay_percent',
                decayDurationMs: 'decay_duration_ms',
                depositEnabled: 'deposit_enabled',
                depositPercent: 'deposit_percent',
                isConditional: 'is_conditional',
                disbursementMode: 'disbursement_mode',
                parentParcelIds: 'ancestor_parcel_ids',
                childParcelIds: 'descendant_parcel_ids',
                acceptedParcelIds: 'accepted_parcel_ids',
                ownerAcceptances: 'owner_acceptances',
                roadProposal: 'road_proposal',
                buildingProposal: 'building_proposal',
                structureProposal: 'structure_proposal',
                reparcellization: 'reparcellization',
                parentFeatures: 'parent_features',
                childFeatures: 'child_features',
                parentProposalIds: 'parent_proposal_ids',
                childProposalIds: 'child_proposal_ids',
                lens: 'lens',
                bounds: 'bounds',
                onchainData: 'onchain_data',
                proposalData: 'proposal_data'
            };

            // Handle special field mappings
            if (updates.expiresAt !== undefined) {
                updateFields.push(`expires_at = $${paramIndex}`);
                params.push(updates.expiresAt ? new Date(updates.expiresAt) : null);
                paramIndex++;
            }

            if (updates.offer !== undefined) {
                updateFields.push(`offer = $${paramIndex}`);
                params.push(updates.offer !== null ? parseFloat(updates.offer) : null);
                paramIndex++;
            }

            if (updates.budget !== undefined) {
                updateFields.push(`budget = $${paramIndex}`);
                params.push(updates.budget !== null ? parseFloat(updates.budget) : null);
                paramIndex++;
            }

            // Handle JSONB fields
            const jsonbFields = [
                'parentParcelIds', 'childParcelIds', 'acceptedParcelIds', 'ownerAcceptances',
                'roadProposal', 'buildingProposal', 'structureProposal', 'reparcellization',
                'parentFeatures', 'childFeatures', 'parentProposalIds', 'childProposalIds',
                'lens', 'bounds', 'onchainData', 'proposalData'
            ];

            for (const [key, dbField] of Object.entries(allowedFields)) {
                if (updates[key] !== undefined && !jsonbFields.includes(key) && key !== 'expiresAt' && key !== 'offer' && key !== 'budget') {
                    updateFields.push(`${dbField} = $${paramIndex}`);
                    params.push(updates[key]);
                    paramIndex++;
                } else if (jsonbFields.includes(key) && updates[key] !== undefined) {
                    updateFields.push(`${dbField} = $${paramIndex}`);
                    params.push(JSON.stringify(updates[key]));
                    paramIndex++;
                }
            }

            if (updateFields.length === 0) {
                return res.status(400).json({ error: 'No valid fields to update' });
            }

            // Always update proposal_data if any field changes
            if (updates.proposalData === undefined) {
                // Fetch current proposal_data and merge updates
                const currentResult = await pool.query(
                    'SELECT proposal_data FROM proposal WHERE proposal_id = $1 AND city = $2',
                    [proposalId, city]
                );

                if (currentResult.rows.length === 0) {
                    return res.status(404).json({ error: 'Proposal not found' });
                }

                const currentData = currentResult.rows[0].proposal_data || {};
                const mergedData = { ...currentData, ...updates };
                updateFields.push(`proposal_data = $${paramIndex}`);
                params.push(JSON.stringify(mergedData));
                paramIndex++;
            }

            params.push(proposalId, city);

            const sql = `
                UPDATE proposal
                SET ${updateFields.join(', ')}
                WHERE proposal_id = $${paramIndex} AND city = $${paramIndex + 1}
                RETURNING id, proposal_id, updated_at
            `;

            const result = await pool.query(sql, params);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Proposal not found' });
            }

            res.json({
                id: result.rows[0].id,
                proposalId: result.rows[0].proposal_id,
                updatedAt: result.rows[0].updated_at.toISOString()
            });
        } catch (err) {
            console.error('Error in PATCH /proposals/city/:proposalId:', err);
            res.status(500).json({ error: 'Internal server error', details: err.message });
        }
    });

    // DELETE /proposals/city/:proposal-id - Delete a proposal
    app.delete('/proposals/city/:proposalId', async (req, res) => {
        try {
            const proposalId = req.params.proposalId;
            const city = req.query.city || 'city';

            if (!proposalId) {
                return res.status(400).json({ error: 'proposalId is required' });
            }

            const sql = `
                DELETE FROM proposal
                WHERE proposal_id = $1 AND city = $2
                RETURNING id, proposal_id
            `;

            const result = await pool.query(sql, [proposalId, city]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Proposal not found' });
            }

            res.json({
                message: 'Proposal deleted successfully',
                id: result.rows[0].id,
                proposalId: result.rows[0].proposal_id
            });
        } catch (err) {
            console.error('Error in DELETE /proposals/city/:proposalId:', err);
            res.status(500).json({ error: 'Internal server error', details: err.message });
        }
    });

    // GET /proposals?parcel_id=... - Get proposals affecting a specific parcel
    app.get('/proposals', async (req, res) => {
        try {
            const parcelId = req.query.parcel_id;
            const city = req.query.city || 'city';
            const limit = parseInt(req.query.limit) || 100;
            const offset = parseInt(req.query.offset) || 0;

            if (!parcelId) {
                return res.status(400).json({ error: 'parcel_id query parameter is required' });
            }

            // Search in both ancestor_parcel_ids and descendant_parcel_ids
            const sql = `
                SELECT 
                    id, proposal_id, city, name, title, description, author, type, status,
                    offer, offer_currency, budget, budget_currency,
                    created_at, expires_at, updated_at,
                    ancestor_parcel_ids, descendant_parcel_ids,
                    proposal_data
                FROM proposal
                WHERE city = $1
                AND (
                    ancestor_parcel_ids @> $2::jsonb
                    OR descendant_parcel_ids @> $2::jsonb
                )
                ORDER BY created_at DESC
                LIMIT $3 OFFSET $4
            `;

            const parcelIdArray = JSON.stringify([String(parcelId)]);
            const result = await pool.query(sql, [city, parcelIdArray, limit, offset]);

            const proposals = result.rows.map(row => {
                if (row.proposal_data) {
                    const proposal = { ...row.proposal_data };
                    proposal.childParcelIds = row.descendant_parcel_ids ?? proposal.childParcelIds ?? null;
                    proposal.parentParcelIds = row.ancestor_parcel_ids ?? proposal.parentParcelIds ?? null;
                    return proposal;
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

            res.json({
                proposals,
                count: proposals.length,
                limit,
                offset,
                parcelId
            });
        } catch (err) {
            console.error('Error in GET /proposals?parcel_id:', err);
            res.status(500).json({ error: 'Internal server error', details: err.message });
        }
    });
}

