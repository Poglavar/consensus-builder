/*
    Agent system for the consensus builder application.
    This file contains functionality for creating, managing, and controlling AI agents
    that can interact with the parcel system and make proposals.
*/

// Detect active chain currency based on connected wallet
function getChainCurrencySymbol() {
    try {
        const wm = window.solanaWalletManager;
        if (wm && typeof wm.getState === 'function') {
            const st = wm.getState();
            if (st && st.status === 'connected' && Array.isArray(st.accounts) && st.accounts.length > 0) {
                return 'SOL';
            }
        }
    } catch (_) {}
    return 'ETH';
}

// Agent storage and management
const agentStorage = {
    agents: new Map(), // Key: agentId, Value: agent object
    _suspendSaveCount: 0,
    _hasPendingSave: false,

    // Save agents to PersistentStorage
    save() {
        const data = Array.from(this.agents.entries()).map(([id, agent]) => ({
            id,
            ...agent
        }));
        PersistentStorage.setItem('consensus_agents', JSON.stringify(data));
    },

    // Load agents from PersistentStorage
    load() {
        const data = PersistentStorage.getItem('consensus_agents');
        if (data) {
            this.agents.clear();
            JSON.parse(data).forEach(agent => {
                // Ensure id property is present on the agent object
                this.agents.set(agent.id, agent);
            });
        }
    },

    beginBatch() {
        this._suspendSaveCount += 1;
    },

    endBatch() {
        if (this._suspendSaveCount > 0) {
            this._suspendSaveCount -= 1;
        }
        if (this._suspendSaveCount === 0 && this._hasPendingSave) {
            this._hasPendingSave = false;
            this.save();
        }
    },

    _saveOrDefer() {
        if (this._suspendSaveCount > 0) {
            this._hasPendingSave = true;
            return;
        }
        this.save();
    },

    // Add a new agent
    addAgent(agent) {
        this.agents.set(agent.id, agent);
        this._saveOrDefer();
        return agent.id;
    },

    // Get agent by ID
    getAgent(agentId) {
        return this.agents.get(agentId);
    },

    // Get all agents
    getAllAgents() {
        return Array.from(this.agents.values());
    },

    // Update agent
    updateAgent(agentId, updates) {
        const agent = this.agents.get(agentId);
        if (agent) {
            Object.assign(agent, updates);
            this._saveOrDefer();
        }
    },

    // Delete agent
    deleteAgent(agentId) {
        this.agents.delete(agentId);
        this._saveOrDefer();
    },

    // Clear all agents
    clear() {
        this.agents.clear();
        if (this._suspendSaveCount > 0) {
            this._hasPendingSave = true;
        } else {
            PersistentStorage.removeItem('consensus_agents');
        }
    }
};

// Maximum number of avatars/agents
const MAX_AGENTS = 17;

// Agent name generation
const CONSONANTS = ['b', 'c', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'w', 'x', 'z'];
const VOWELS = ['a', 'e', 'i', 'o', 'u'];

/**
 * Generate a random agent name with 3-6 syllables of consonant-vowel combinations
 * @returns {string} - Generated name with first letter capitalized
 */
function generateAgentName() {
    const syllableCount = Math.floor(Math.random() * 4) + 3; // 3-6 syllables
    let name = '';

    for (let i = 0; i < syllableCount; i++) {
        const consonant = CONSONANTS[Math.floor(Math.random() * CONSONANTS.length)];
        const vowel = VOWELS[Math.floor(Math.random() * VOWELS.length)];
        name += consonant + vowel;
    }

    // Capitalize first letter
    return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Create a new agent with sequential avatar assignment
 * @returns {Object} - New agent object
 */
function createAgent() {
    // Find the next available avatar index (0-15)
    const usedIndices = new Set(agentStorage.getAllAgents().map(a => a.avatarIndex));
    let avatarIndex = 0;
    while (usedIndices.has(avatarIndex) && avatarIndex < MAX_AGENTS) avatarIndex++;
    if (avatarIndex >= MAX_AGENTS) throw new Error('Maximum number of agents reached');

    const agentId = 'agent_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const agent = {
        id: agentId,
        name: generateAgentName(),
        avatarIndex: avatarIndex,
        ethBalance: 100, // Initial 100 ETH as specified
        walletAddresses: [],
        ownedParcels: [],
        proposalsCreated: [],
        proposalsAccepted: [],
        proposalsExecuted: [],
        createdAt: new Date().toISOString(),
        lastActionAt: null,
        aiControlled: true, // AI controls this agent by default
        userControlled: false // Not controlled by user
    };
    return agent;
}

/**
 * Create a user agent with specified name and avatar
 * @param {string} name - Agent name
 * @param {number} avatarIndex - Avatar index
 * @param {object} options - Optional settings
 * @param {boolean} options.isGuest - Whether this is a guest agent
 */
function createUserAgent(name, avatarIndex, options = {}) {
    const agentId = 'user_agent_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const agent = {
        id: agentId,
        name: name,
        avatarIndex: avatarIndex,
        ethBalance: 100, // Initial 100 ETH
        walletAddresses: [],
        ownedParcels: [],
        proposalsCreated: [],
        proposalsAccepted: [],
        proposalsExecuted: [],
        createdAt: new Date().toISOString(),
        lastActionAt: null,
        aiControlled: false, // Not AI controlled
        userControlled: true, // Controlled by user
        isGuest: options.isGuest === true // Track if user hasn't personalized their profile
    };
    return agent;
}

/**
 * Get the current user agent
 */
function getCurrentUserAgent() {
    const agents = agentStorage.getAllAgents();
    return agents.find(agent => agent.userControlled === true);
}

/**
 * Set agent as user controlled and clear other user controlled agents
 */
function setUserControlledAgent(agentId, isUserControlled = true) {
    const agents = agentStorage.getAllAgents();

    // Clear userControlled flag from all agents first
    agents.forEach(agent => {
        if (agent.userControlled) {
            agentStorage.updateAgent(agent.id, { userControlled: false });
        }
    });

    // Set the specified agent as user controlled
    if (isUserControlled) {
        agentStorage.updateAgent(agentId, { userControlled: true, aiControlled: false });
    }
}

// Helper to get avatar image path
function getAvatarImagePath(avatarIndex) {
    return `avatars/avatar${avatarIndex}.png`;
}

/**
 * Get parcels owned by an agent
 * @param {string} agentId - The agent ID
 * @returns {Array} - Array of parcel IDs owned by the agent
 */
function getAgentOwnedParcels(agentId, { includePersistent = true, includeTransient = true } = {}) {
    const parcels = [];

    if (includePersistent) {
        // Check PersistentStorage for parcel ownership
        for (let i = 0; i < PersistentStorage.length; i++) {
            const key = PersistentStorage.key(i);
            if (key.startsWith('parcel_') && key.endsWith('_owner')) {
                const ownerId = PersistentStorage.getItem(key);
                if (ownerId === agentId) {
                    const parcelId = key.replace('parcel_', '').replace('_owner', '');
                    parcels.push(parcelId);
                }
            }
        }
    }

    if (includeTransient) {
        // Merge in transient ownership fetched from chain during this session
        try {
            if (agentDialogTempOwnership && agentDialogTempOwnership[agentId]) {
                parcels.push(...agentDialogTempOwnership[agentId]);
            }
        } catch (_) { }
    }

    return Array.from(new Set(parcels));
}

function buildAgentOwnedParcelIndex({ includePersistent = true, includeTransient = true } = {}) {
    const ownerToParcels = new Map();

    const addOwnership = (ownerId, parcelId) => {
        if (!ownerId || !parcelId) return;
        const ownerKey = String(ownerId);
        const parcelKey = String(parcelId);
        if (!ownerToParcels.has(ownerKey)) {
            ownerToParcels.set(ownerKey, []);
        }
        ownerToParcels.get(ownerKey).push(parcelKey);
    };

    if (includePersistent) {
        for (let i = 0; i < PersistentStorage.length; i++) {
            const key = PersistentStorage.key(i);
            if (key && key.startsWith('parcel_') && key.endsWith('_owner')) {
                const ownerId = PersistentStorage.getItem(key);
                const parcelId = key.replace('parcel_', '').replace('_owner', '');
                addOwnership(ownerId, parcelId);
            }
        }
    }

    if (includeTransient) {
        try {
            if (agentDialogTempOwnership && typeof agentDialogTempOwnership === 'object') {
                Object.keys(agentDialogTempOwnership).forEach(agentId => {
                    const parcelIds = Array.isArray(agentDialogTempOwnership[agentId])
                        ? agentDialogTempOwnership[agentId]
                        : [];
                    parcelIds.forEach(parcelId => addOwnership(agentId, parcelId));
                });
            }
        } catch (_) { }
    }

    ownerToParcels.forEach((parcelIds, ownerId) => {
        ownerToParcels.set(ownerId, Array.from(new Set(parcelIds)));
    });

    return ownerToParcels;
}

/**
 * Update agent's owned parcels list
 * @param {string} agentId - The agent ID
 */
function updateAgentOwnedParcels(agentId) {
    const ownedParcels = getAgentOwnedParcels(agentId);
    agentStorage.updateAgent(agentId, { ownedParcels });
}

/**
 * Transfer parcel ownership from one agent to another
 * @param {string} parcelId - The parcel ID
 * @param {string} fromAgentId - Current owner agent ID
 * @param {string} toAgentId - New owner agent ID
 */
function transferParcelOwnership(parcelId, fromAgentId, toAgentId) {
    // Update PersistentStorage
    PersistentStorage.setItem(`parcel_${parcelId}_owner`, toAgentId);

    // Update both agents' owned parcels lists
    if (fromAgentId) {
        updateAgentOwnedParcels(fromAgentId);
    }
    if (toAgentId) {
        updateAgentOwnedParcels(toAgentId);
    }

    console.log(`Transferred parcel ${parcelId} from ${fromAgentId || 'nobody'} to ${toAgentId}`);
}

/**
 * Helper function to check if two parcels share a boundary (using HTRS96 with tolerance)
 * Adapted from parcel-blocks.js
 * @param {Object} p1 - First parcel object with layer property
 * @param {Object} p2 - Second parcel object with layer property
 * @returns {boolean} - True if parcels share a boundary
 */
function agentParcelsShareBoundary(p1, p2) {
    // Ensure both parcels have valid features
    if (!p1?.layer?.feature || !p2?.layer?.feature) {
        return false;
    }

    // Get HTRS96 coordinates on-the-fly using existing function
    const coords1 = typeof getHtrsCoordinates === 'function' ? getHtrsCoordinates(p1.layer.feature) : [];
    const coords2 = typeof getHtrsCoordinates === 'function' ? getHtrsCoordinates(p2.layer.feature) : [];

    // Check if we got valid coordinates
    if (!coords1.length || !coords2.length) {
        return false;
    }

    // Define a small tolerance (1cm in meters)
    const epsilon = 0.01;

    for (let i = 0; i < coords1.length; i++) {
        for (let j = 0; j < coords2.length; j++) {
            // Check if points are within the tolerance distance
            if (Math.abs(coords1[i][0] - coords2[j][0]) < epsilon &&
                Math.abs(coords1[i][1] - coords2[j][1]) < epsilon) {
                return true; // Found a shared vertex within tolerance
            }
        }
    }

    return false; // No shared vertices found within tolerance
}

/**
 * Find contiguous parcels for agent proposal creation
 * @param {Array} allParcels - Array of all available parcels with {id, layer, isOwned} structure
 * @param {number} targetSize - Target number of parcels (1-8)
 * @param {string} agentId - Agent ID for ownership checking
 * @returns {Array} - Array of selected parcels
 */
function findContiguousParcels(allParcels, targetSize, agentId) {
    if (allParcels.length === 0) return [];

    // --- Optimization 1: Global neighbor cache ---
    // Build a cache (parcelId -> neighbor array) only once per session.
    // The cache is stored on window (lazy-created). It is invalidated when parcel data is re-loaded.
    if (!window.parcelNeighborCache || window.parcelNeighborCacheVersion !== window.parcelDataVersion) {
        window.parcelNeighborCache = new Map();
        allParcels.forEach(p => window.parcelNeighborCache.set(p.id, []));
    }

    const getNeighbors = (parcel) => {
        // Return cached neighbors if already computed
        const cached = window.parcelNeighborCache.get(parcel.id);
        if (cached && cached.length) return cached;

        const neighbors = [];
        // NOTE:  We deliberately avoid O(n^2) pre-computation by only checking against
        // parcels whose bounds intersect.  We also early-exit once we have more than 8
        // neighbors since we will never need that many for proposal creation.
        for (const other of allParcels) {
            if (other.id === parcel.id) continue;
            if (!parcel.layer.getBounds || !other.layer.getBounds) continue;
            if (!parcel.layer.getBounds().intersects(other.layer.getBounds())) continue;
            if (agentParcelsShareBoundary(parcel, other)) {
                neighbors.push(other);
                if (neighbors.length >= 8) break; // Good enough for our purposes
            }
        }
        window.parcelNeighborCache.set(parcel.id, neighbors);
        return neighbors;
    };

    // --- BFS growth ---
    const startParcel = allParcels[Math.floor(Math.random() * allParcels.length)];
    const selected = [startParcel];
    const queue = [startParcel];
    const visited = new Set([startParcel.id]);

    while (queue.length && selected.length < targetSize) {
        const current = queue.shift();
        const neighbors = getNeighbors(current);
        // Shuffle to add randomness without expensive sort
        for (let i = neighbors.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [neighbors[i], neighbors[j]] = [neighbors[j], neighbors[i]];
        }
        for (const n of neighbors) {
            if (!visited.has(n.id)) {
                selected.push(n);
                visited.add(n.id);
                queue.push(n);
                if (selected.length >= targetSize) break;
            }
        }
    }

    return selected;
}

/**
 * Determine if a parcel should be treated as a road (and thus excluded
 * from agent-generated proposals).
 * 1. Explicit flag via PersistentStorage or feature.properties.isRoad
 * 2. Heuristic: bounding-box-area / parcel-area ratio
 */
function isRoadLikeParcel(layer) {
    if (!layer || !layer.feature) return false;

    const parcelId = (typeof ensureParcelId === 'function') ? ensureParcelId(layer.feature) : (layer.feature.properties?.parcelId || layer.feature.properties?.parcel_id || layer.feature.properties?.id);

    // Explicit road flag (drawn or pre-existing)
    const explicitRoad = (parcelId && typeof window.isRoadParcel === 'function' && window.isRoadParcel(parcelId)) ||
        layer.feature.properties?.isRoad === true;
    if (explicitRoad) return true;

    // Heuristic: bounding-box-area / parcel-area ratio
    const coords = getHtrsCoordinates(layer.feature);
    if (coords.length < 4) return false;

    let minX = coords[0][0], maxX = coords[0][0];
    let minY = coords[0][1], maxY = coords[0][1];
    coords.forEach(c => {
        if (c[0] < minX) minX = c[0];
        if (c[0] > maxX) maxX = c[0];
        if (c[1] < minY) minY = c[1];
        if (c[1] > maxY) maxY = c[1];
    });

    const bboxArea = (maxX - minX) * (maxY - minY); // m²
    const area = layer.feature.properties?.calculatedArea;
    if (!area || area === 0) return false;

    const ratio = bboxArea / area;

    // Empirical threshold: roads often have ratio > 4 (very empty bounding box)
    return ratio > 4;
}

function buildTurnParcelPool(maxParcels = 600) {
    if (typeof parcelLayer === 'undefined' || !parcelLayer) {
        return [];
    }

    const parcels = [];
    parcelLayer.eachLayer(layer => {
        if (!layer || !layer.feature || !layer.feature.properties) return;

        const parcelId = (typeof ensureParcelId === 'function')
            ? ensureParcelId(layer.feature)
            : (layer.feature.properties.parcelId || layer.feature.properties.parcel_id || layer.feature.properties.id);
        if (!parcelId) return;

        if (isRoadLikeParcel(layer)) return;

        const area = layer.feature.properties.calculatedArea || 0;
        if (area > 15000) return;

        parcels.push({
            id: parcelId,
            layer: layer
        });
    });

    if (!Number.isFinite(maxParcels) || maxParcels <= 0 || parcels.length <= maxParcels) {
        return parcels;
    }

    const sampled = parcels.slice();
    for (let i = sampled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [sampled[i], sampled[j]] = [sampled[j], sampled[i]];
    }
    return sampled.slice(0, maxParcels);
}

/**
 * Agent decision-making: decide what action to take
 * @param {Object} agent - The agent object
 * @returns {Object} - Action object with type and details
 */
function agentDecideAction(agent, turnContext = null) {
    const safeTurnContext = turnContext && typeof turnContext === 'object' ? turnContext : {};
    const preloadedProposals = Array.isArray(safeTurnContext.activeProposals)
        ? safeTurnContext.activeProposals
        : null;
    const sharedTurnParcelPool = Array.isArray(safeTurnContext.turnParcelPool)
        ? safeTurnContext.turnParcelPool
        : null;

    const actions = ['nothing', 'accept', 'create', 'donate'];
    const actionType = actions[Math.floor(Math.random() * actions.length)];

    const indexedOwnedParcels = safeTurnContext.ownedParcelsByAgent && typeof safeTurnContext.ownedParcelsByAgent.get === 'function'
        ? safeTurnContext.ownedParcelsByAgent.get(agent.id)
        : null;
    const ownedParcels = Array.isArray(indexedOwnedParcels)
        ? indexedOwnedParcels
        : getAgentOwnedParcels(agent.id);

    switch (actionType) {
        case 'nothing':
            return { type: 'nothing' };

        case 'accept':
            // Find proposals that affect agent's parcels and aren't already accepted
            const acceptableProposals = [];
            if (typeof proposalStorage !== 'undefined') {
                const allProposals = preloadedProposals || proposalStorage.getAllProposals();
                for (const proposal of allProposals) {
                    if (proposal.status !== 'Executed') {
                        const parcelIds = Array.isArray(proposal.parentParcelIds)
                            ? proposal.parentParcelIds
                            : (Array.isArray(proposal.childParcelIds) ? proposal.childParcelIds : []);
                        for (const parcelId of parcelIds) {
                            const parcelIdStr = parcelId.toString();
                            const ownerState = (typeof getProposalOwnerAcceptanceState === 'function')
                                ? getProposalOwnerAcceptanceState(proposal, parcelIdStr)
                                : null;

                            let ownerStateHandled = false;
                            if (ownerState && Array.isArray(ownerState.entries) && ownerState.entries.length > 0) {
                                ownerState.entries.forEach(entry => {
                                    if (!entry.accepted && entry.slotType === 'agent' && entry.agentId === agent.id) {
                                        acceptableProposals.push({ proposal, parcelId: parcelIdStr, ownerKey: entry.key });
                                        ownerStateHandled = true;
                                    }
                                });
                            }

                            if (!ownerStateHandled && ownedParcels.includes(parcelIdStr)) {
                                const parcelAccepted = Array.isArray(proposal.acceptedParcelIds)
                                    ? proposal.acceptedParcelIds.includes(parcelIdStr)
                                    : false;
                                if (!parcelAccepted) {
                                    acceptableProposals.push({ proposal, parcelId: parcelIdStr, ownerKey: null });
                                }
                            }
                        }
                    }
                }
            }

            if (acceptableProposals.length > 0) {
                const randomChoice = acceptableProposals[Math.floor(Math.random() * acceptableProposals.length)];
                const proposalId = randomChoice.proposal.proposalId
                    || randomChoice.proposal.tokenId;
                return {
                    type: 'accept',
                    proposalId,
                    parcelId: randomChoice.parcelId,
                    ownerKey: randomChoice.ownerKey || null
                };
            }
            return { type: 'nothing' };

        case 'create':
            // Create a proposal for 1-8 contiguous parcels from any available parcels
            // Must include at least one parcel not owned by the agent

            // Get all available parcels from parcelLayer
            if (typeof parcelLayer === 'undefined' || !parcelLayer) {
                return { type: 'nothing' };
            }

            const ownedParcelSet = new Set((ownedParcels || []).map(id => id != null ? id.toString() : id));
            const allParcelsBase = (sharedTurnParcelPool && sharedTurnParcelPool.length > 0)
                ? sharedTurnParcelPool
                : buildTurnParcelPool(600);
            const allParcels = allParcelsBase.map(parcel => ({
                id: parcel.id,
                layer: parcel.layer,
                isOwned: ownedParcelSet.has(parcel.id != null ? parcel.id.toString() : parcel.id)
            }));

            if (allParcels.length === 0) {
                return { type: 'nothing' };
            }

            // Try to create a contiguous proposal with 1-8 parcels
            const targetSize = Math.floor(Math.random() * 8) + 1; // 1-8 parcels
            const proposalParcels = findContiguousParcels(allParcels, targetSize, agent.id);

            if (proposalParcels.length === 0) {
                return { type: 'nothing' };
            }

            // Ensure at least one parcel is not owned by the agent
            const hasUnownedParcel = proposalParcels.some(p => !p.isOwned);
            if (!hasUnownedParcel) {
                return { type: 'nothing' };
            }

            const proposalTypes = ['road-track', 'park', 'square', 'buildings'];
            const randomType = proposalTypes[Math.floor(Math.random() * proposalTypes.length)];

            const maxBudget = Math.floor(agent.ethBalance * 0.05 * 100) / 100; // Max 5% of ETH, rounded to 2 decimals
            const budget = Math.max(0.01, Math.random() * maxBudget);

            return {
                type: 'create',
                parcelIds: proposalParcels.map(p => p.id),
                goal: randomType,
                proposalType: randomType, // legacy logging only; remove once consumers migrated
                title: randomType,
                description: `${randomType} development proposed by ${agent.name}`,
                budget: Math.round(budget * 100) / 100 // Round to 2 decimal places
            };

        case 'donate':
            // Find other agents' proposals to donate to
            const donatableProposals = [];
            if (typeof proposalStorage !== 'undefined') {
                const allProposals = preloadedProposals || proposalStorage.getAllProposals();
                for (const proposal of allProposals) {
                    if (proposal.status !== 'Executed' && proposal.author !== agent.name) {
                        donatableProposals.push(proposal);
                    }
                }
            }

            if (donatableProposals.length > 0 && agent.ethBalance > 0.01) {
                const randomProposal = donatableProposals[Math.floor(Math.random() * donatableProposals.length)];
                const maxDonation = Math.floor(agent.ethBalance * 0.05 * 100) / 100; // Max 5% of ETH
                const donation = Math.max(0.01, Math.random() * maxDonation);

                const proposalId = randomProposal.proposalId
                    || randomProposal.id
                    || randomProposal.tokenId;

                return {
                    type: 'donate',
                    proposalId,
                    amount: Math.round(donation * 100) / 100
                };
            }
            return { type: 'nothing' };

        default:
            return { type: 'nothing' };
    }
}

/**
 * Build a consistent proposal link for agent/game log entries using proposal ids.
 */
function buildProposalLogLinkAgent(proposalIdOrHash, proposalOverride = null) {
    const proposal = proposalOverride
        || (typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function'
            ? proposalStorage.getProposal(proposalIdOrHash)
            : null);
    const hasProposalId = proposal && proposal.proposalId !== undefined && proposal.proposalId !== null;
    const dataId = hasProposalId
        ? String(proposal.proposalId)
        : (proposalIdOrHash || '');
    const displayId = hasProposalId
        ? dataId
        : (proposalIdOrHash ? String(proposalIdOrHash).substring(0, 8) : 'unknown');
    const hashAttr = proposalIdOrHash ? ` data-proposal-hash="${proposalIdOrHash}"` : '';
    return `<a href="#" data-proposal-id="${dataId}"${hashAttr} class="proposal-link proposal-link-clickable">${displayId}</a>`;
}

/**
 * Execute an agent's action
 * @param {Object} agent - The agent object
 * @param {Object} action - The action to execute
 * @returns {string} - Log message describing the action
 */
function executeAgentAction(agent, action) {
    switch (action.type) {
        case 'nothing':
            return `<a href="#" data-agent-id="${agent.id}" class="agent-link agent-link-clickable">${agent.name}</a> did nothing this turn.`;

        case 'accept':
            if (typeof acceptProposal === 'function') {
                const result = acceptProposal(action.proposalId, action.parcelId, action.ownerKey || null, {
                    acceptedByAgentId: agent.id,
                    acceptedByName: agent.name,
                    suppressAlerts: true
                });
                if (!result) {
                    return `<a href="#" data-agent-id="${agent.id}" class="agent-link agent-link-clickable">${agent.name}</a> tried to accept proposal ${String(action.proposalId).substring(0, 8)} but could not resolve owner acceptance.`;
                }
                if (result && result.proposalExecuted) {
                    agent.proposalsExecuted.push(action.proposalId);
                    agentStorage.updateAgent(agent.id, { proposalsExecuted: agent.proposalsExecuted });
                }
                // Update agent's accepted proposals list
                if (!agent.proposalsAccepted.includes(action.proposalId)) {
                    agent.proposalsAccepted.push(action.proposalId);
                    agentStorage.updateAgent(agent.id, { proposalsAccepted: agent.proposalsAccepted });
                }
                // Look up parcel number (BROJ_CESTICE)
                let parcelNumber = action.parcelId;
                if (typeof multiParcelSelection !== 'undefined' && typeof multiParcelSelection.findParcelById === 'function') {
                    const parcelLayer = multiParcelSelection.findParcelById(action.parcelId);
                    if (parcelLayer && parcelLayer.feature && parcelLayer.feature.properties && parcelLayer.feature.properties.BROJ_CESTICE) {
                        parcelNumber = parcelLayer.feature.properties.BROJ_CESTICE;
                    }
                }

                // Show agent bubble for this interaction
                if (typeof window.agentBubbleManager !== 'undefined') {
                    const proposalPosition = window.agentBubbleManager.getProposalPosition(action.proposalId);
                    if (proposalPosition) {
                        window.agentBubbleManager.addBubble({
                            agentId: agent.id,
                            agentName: agent.name,
                            avatarIndex: agent.avatarIndex,
                            objectType: 'proposal',
                            objectId: action.proposalId,
                            objectPosition: proposalPosition,
                            action: `accepted proposal ${String(action.proposalId).substring(0, 6)}`
                        });
                    }
                }

                const proposal = (typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function')
                    ? proposalStorage.getProposal(action.proposalId)
                    : null;
                const proposalLink = buildProposalLogLinkAgent(action.proposalId, proposal);

                return `<a href="#" data-agent-id="${agent.id}" class="agent-link agent-link-clickable">${agent.name}</a> accepted proposal ${proposalLink} for parcel <a href="#" data-parcel-id="${action.parcelId}" class="parcel-link parcel-link-clickable">${parcelNumber}</a>.`;
            }
            return `<a href="#" data-agent-id="${agent.id}" class="agent-link agent-link-clickable">${agent.name}</a> tried to accept a proposal but failed.`;

        case 'create':
            if (typeof proposalStorage !== 'undefined') {
                // Calculate bounds for the proposal (for reliable positioning)
                let bounds = null;
                if (typeof calculateProposalBounds === 'function') {
                    bounds = calculateProposalBounds(action.parcelIds);
                }

                const proposal = {
                    author: agent.name,
                    title: action.title,
                    description: action.description,
                    offer: action.budget, // This is the budget that will be paid out
                    budget: action.budget, // Add budget field as specified
                    parcelIds: action.parcelIds,
                    goal: 'parcel',
                    acceptedParcelIds: [],
                    bounds: bounds, // Store bounds for reliable positioning
                    createdAt: new Date().toISOString() // Add creation timestamp
                };

                const proposalId = proposalStorage.addProposal(proposal);
                if (proposalId === null) {
                    // console.log('Attempt failed:This exact proposal already exists');
                    return `<a href="#" data-agent-id="${agent.id}" class="agent-link agent-link-clickable">${agent.name}</a>`
                        + ` failed to create a proposal because it already exists.`;
                }

                // Update agent's created proposals list
                if (!agent.proposalsCreated.includes(proposalId)) {
                    agent.proposalsCreated.push(proposalId);
                    agentStorage.updateAgent(agent.id, { proposalsCreated: agent.proposalsCreated });
                }

                // Deduct budget from agent's balance
                agent.ethBalance -= action.budget;
                agentStorage.updateAgent(agent.id, { ethBalance: agent.ethBalance });

                // Show agent bubble for this interaction
                if (typeof window.agentBubbleManager !== 'undefined') {
                    const proposalPosition = window.agentBubbleManager.getProposalPosition(proposalId);
                    if (proposalPosition) {
                        window.agentBubbleManager.addBubble({
                            agentId: agent.id,
                            agentName: agent.name,
                            avatarIndex: agent.avatarIndex,
                            objectType: 'proposal',
                            objectId: proposalId,
                            objectPosition: proposalPosition,
                            action: `created ${action.goal || action.proposalType || 'proposal'} proposal`
                        });
                    }
                }

                const storedProposal = (typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function')
                    ? proposalStorage.getProposal(proposalId)
                    : null;
                const proposalLink = buildProposalLogLinkAgent(proposalId, storedProposal);

                return `<a href="#" data-agent-id="${agent.id}" class="agent-link agent-link-clickable">${agent.name}</a> created a ${(action.goal || action.proposalType || 'proposal')} proposal (${proposalLink}) for ${action.parcelIds.length} parcel(s) with budget ${action.budget} ${getChainCurrencySymbol()}.`;
            }
            return `<a href="#" data-agent-id="${agent.id}" class="agent-link agent-link-clickable">${agent.name}</a> tried to create a proposal but failed.`;

        case 'donate':
            // For now, just add to the proposal's budget and deduct from agent
            if (typeof proposalStorage !== 'undefined') {
                const proposal = proposalStorage.getProposal(action.proposalId);
                if (proposal && agent.ethBalance >= action.amount) {
                    proposal.budget = (proposal.budget || proposal.offer || 0) + action.amount;
                    proposal.offer = proposal.budget; // Keep offer in sync with budget
                    proposal.proposalId = proposal.proposalId || proposal.tokenId || action.proposalId;
                    if (typeof proposalStorage._indexProposal === 'function') {
                        proposalStorage._indexProposal(proposal);
                    } else {
                        proposalStorage.proposals.set(proposal.proposalId, proposal);
                    }
                    proposalStorage.save();

                    agent.ethBalance -= action.amount;
                    agentStorage.updateAgent(agent.id, { ethBalance: agent.ethBalance });

                    // Show agent bubble for this interaction
                    if (typeof window.agentBubbleManager !== 'undefined') {
                        const proposalPosition = window.agentBubbleManager.getProposalPosition(action.proposalId);
                        if (proposalPosition) {
                            window.agentBubbleManager.addBubble({
                                agentId: agent.id,
                                agentName: agent.name,
                                avatarIndex: agent.avatarIndex,
                                objectType: 'proposal',
                                objectId: action.proposalId,
                                objectPosition: proposalPosition,
                                action: `donated ${action.amount} ${getChainCurrencySymbol()} to proposal`
                            });
                        }
                    }

                    const proposalLink = buildProposalLogLinkAgent(action.proposalId, proposal);
                    return `<a href="#" data-agent-id="${agent.id}" class="agent-link agent-link-clickable">${agent.name}</a> donated ${action.amount} ${getChainCurrencySymbol()} to proposal ${proposalLink}.`;
                }
            }
            return `<a href="#" data-agent-id="${agent.id}" class="agent-link agent-link-clickable">${agent.name}</a> tried to donate to a proposal but failed.`;

        default:
            return `<a href="#" data-agent-id="${agent.id}" class="agent-link agent-link-clickable">${agent.name}</a> performed an unknown action.`;
    }
}

let agentDialogLastChainId = null;

function normalizeChainIdSafe(chainId) {
    if (typeof normalizeChainId === 'function') {
        return normalizeChainId(chainId);
    }
    return chainId !== undefined && chainId !== null ? String(chainId) : null;
}

function getCurrentWalletChainId() {
    // Check Solana wallet first
    const solWm = window.solanaWalletManager;
    if (solWm && typeof solWm.getState === 'function') {
        const solState = solWm.getState();
        if (solState && solState.status === 'connected' && Array.isArray(solState.accounts) && solState.accounts.length > 0) {
            const cluster = solWm.getCluster ? solWm.getCluster() : 'devnet';
            return `solana-${cluster}`;
        }
    }
    const walletState = window.walletManager && typeof window.walletManager.getState === 'function'
        ? window.walletManager.getState()
        : null;
    if (!walletState || !walletState.chainId) return null;
    return normalizeChainIdSafe(walletState.chainId);
}

function filterProposalIdsForChain(proposalIds = [], chainId) {
    const normalizedChain = normalizeChainIdSafe(chainId);
    if (!Array.isArray(proposalIds)) return [];

    return proposalIds.filter(id => {
        if (!proposalStorage || typeof proposalStorage.getProposal !== 'function') {
            return true; // best effort if storage unavailable
        }
        const proposal = proposalStorage.getProposal(id) ||
            (proposalStorage.findProposalByIdOrHash ? proposalStorage.findProposalByIdOrHash(id) : null);
        if (!proposal) return true; // keep placeholder entries (renders as deleted)

        if (proposal.isMinted) {
            const proposalChain = normalizeChainIdSafe(proposal.chainId || (proposal.onchain && proposal.onchain.chainId));
            if (!normalizedChain) {
                // Without an active chain, skip minted proposals to avoid cross-chain mixing
                return false;
            }
            return proposalChain === normalizedChain;
        }
        // Local/unminted proposals are chain-agnostic
        return true;
    });
}

function clearAgentDialogCaches() {
    if (agentDialogListData) {
        agentDialogListData = null;
    }
    if (agentDialogFetchPromises && typeof agentDialogFetchPromises.clear === 'function') {
        agentDialogFetchPromises.clear();
    }
    if (agentDialogCache) {
        Object.keys(agentDialogCache).forEach(key => delete agentDialogCache[key]);
    }
    if (typeof window !== 'undefined') {
        window.agentDialogCache = agentDialogCache;
        window.agentDialogListData = agentDialogListData;
    }
}

function pruneAgentDialogListDataForChain(chainId) {
    if (!agentDialogListData) return;
    const filterFn = arr => filterProposalIdsForChain(arr, chainId);

    ['created', 'accepted', 'pending'].forEach(type => {
        if (agentDialogListData[type]) {
            const data = filterFn(agentDialogListData[type].data || []);
            agentDialogListData[type].data = data;
            if (agentDialogListData[type].loaded > data.length) {
                agentDialogListData[type].loaded = data.length;
            }
        }
    });
}

function handleAgentDialogChainChange(chainId) {
    const normalizedChain = normalizeChainIdSafe(chainId);
    if (agentDialogLastChainId && normalizedChain && agentDialogLastChainId !== normalizedChain) {
        // Remove minted proposals from other chains and clear cached UI data
        if (typeof proposalStorage !== 'undefined' && typeof proposalStorage.purgeMintedProposalsNotOnChain === 'function') {
            proposalStorage.purgeMintedProposalsNotOnChain(normalizedChain);
        }
        clearAgentDialogCaches();
    }
    if (normalizedChain) {
        agentDialogLastChainId = normalizedChain;
    }
}

function escapeAttribute(value) {
    return String(value == null ? '' : value).replace(/"/g, '&quot;');
}

function getI18nApi() {
    return (typeof window !== 'undefined' && window.i18n) ? window.i18n : null;
}

function formatString(template, params = {}) {
    if (!template) return '';
    return String(template).replace(/\{\{(\w+)\}\}/g, (match, key) => {
        return Object.prototype.hasOwnProperty.call(params, key) ? params[key] : match;
    });
}

function translateText(key, fallback, params = {}) {
    const api = getI18nApi();
    if (api && typeof api.t === 'function') {
        return api.t(key, params);
    }
    return formatString(fallback, params);
}

function renderAgentLanguageSwitcher() {
    const i18nApi = getI18nApi();
    const currentLang = i18nApi && typeof i18nApi.getLanguage === 'function'
        ? i18nApi.getLanguage()
        : 'en';
    const switcherLabel = escapeAttribute(
        (i18nApi && typeof i18nApi.t === 'function'
            ? (i18nApi.t('language.switcher.aria') || i18nApi.t('language.switcher.label'))
            : null) || 'Language'
    );
    const englishLabel = escapeAttribute(
        (i18nApi && typeof i18nApi.t === 'function'
            ? i18nApi.t('language.switcher.to_en')
            : null) || 'Switch to English'
    );
    const spanishLabel = escapeAttribute(
        (i18nApi && typeof i18nApi.t === 'function'
            ? i18nApi.t('language.switcher.to_es')
            : null) || 'Switch to Spanish'
    );
    const serbianLabel = escapeAttribute(
        (i18nApi && typeof i18nApi.t === 'function'
            ? i18nApi.t('language.switcher.to_sr')
            : null) || 'Switch to Serbian'
    );
    const croatianLabel = escapeAttribute(
        (i18nApi && typeof i18nApi.t === 'function'
            ? i18nApi.t('language.switcher.to_hr')
            : null) || 'Switch to Croatian'
    );

    const flagByLang = { en: '🌐', es: '🇪🇸', sr: '🇷🇸', hr: '🇭🇷' };
    const activeFlag = escapeHtml(flagByLang[currentLang] || '🌐');

    return `
        <div class="agent-language-switcher" data-language-switcher role="group" aria-label="${switcherLabel}" data-i18n-key="language.switcher.aria" data-i18n-attr="aria-label">
            <button type="button" class="language-toggle" data-language-toggle aria-haspopup="true" aria-expanded="false" title="${switcherLabel}" aria-label="${switcherLabel}">
                <span aria-hidden="true">${activeFlag}</span>
            </button>
            <div class="language-menu" data-language-menu role="menu">
                <button type="button" class="language-option ${currentLang === 'en' ? 'is-active' : ''}" data-language="en" role="menuitem" title="${englishLabel}" aria-label="${englishLabel}" data-i18n-key="language.switcher.to_en" data-i18n-attr="title,aria-label">
                    <span aria-hidden="true">🇬🇧</span>
                </button>
                <button type="button" class="language-option ${currentLang === 'es' ? 'is-active' : ''}" data-language="es" role="menuitem" title="${spanishLabel}" aria-label="${spanishLabel}" data-i18n-key="language.switcher.to_es" data-i18n-attr="title,aria-label">
                    <span aria-hidden="true">🇪🇸</span>
                </button>
                <button type="button" class="language-option ${currentLang === 'sr' ? 'is-active' : ''}" data-language="sr" role="menuitem" title="${serbianLabel}" aria-label="${serbianLabel}" data-i18n-key="language.switcher.to_sr" data-i18n-attr="title,aria-label">
                    <span aria-hidden="true">🇷🇸</span>
                </button>
                <button type="button" class="language-option ${currentLang === 'hr' ? 'is-active' : ''}" data-language="hr" role="menuitem" title="${croatianLabel}" aria-label="${croatianLabel}" data-i18n-key="language.switcher.to_hr" data-i18n-attr="title,aria-label">
                    <span aria-hidden="true">🇭🇷</span>
                </button>
            </div>
        </div>
    `;
}

/**
 * Show the agent dialog with detailed information
 * @param {string} agentId - The agent ID
 */
async function showAgentDialog(agentId, options = {}) {
    const safeOptions = options && typeof options === 'object' ? options : {};
    const readOnly = !!safeOptions.readOnly;
    const elevated = !!safeOptions.elevated;
    const onClose = typeof safeOptions.onClose === 'function' ? safeOptions.onClose : null;
    const agent = agentStorage.getAgent(agentId);
    if (!agent) {
        alert(translateText('agentDialog.agentNotFound', 'Agent not found.'));
        return;
    }

    // Check if this is the current user's agent
    const isUserAgent = agent.userControlled === true;

    const currentChainId = getCurrentWalletChainId();
    const walletState = window.walletManager ? window.walletManager.getState() : null;
    const walletConnected = walletState && walletState.status === 'connected' && walletState.accounts && walletState.accounts.length > 0;
    const walletAccounts = walletConnected ? (walletState.accounts || []) : [];
    const ownedParcels = getAgentOwnedParcels(agentId, { includePersistent: walletConnected, includeTransient: true });
    const parcelDetails = getAgentParcelDetails(agentId);
    const cachedLists = getAgentDialogCache(agentId);
    let portfolioValue = null;
    const createdProposals = agent.proposalsCreated || [];
    const acceptedProposals = agent.proposalsAccepted || [];
    const executedProposals = agent.proposalsExecuted || [];
    const pendingProposals = isUserAgent ? getUserPendingProposals(agentId, currentChainId) : [];
    const walletAddressesForDisplay = isUserAgent
        ? walletAccounts
        : (agent.walletAddresses || []);

    const currencySymbol = getChainCurrencySymbol();
    const initialEthBalanceDisplay = isUserAgent
        ? '-'
        : `${agent.ethBalance.toFixed(2)} ${currencySymbol}`;
    const initialTotalWealthDisplay = '-';

    // Prefer cached on-chain data when available so lists don't rebuild on every open
    const cacheMatchesChain = cachedLists && cachedLists.chainId && cachedLists.chainId === currentChainId;
    const usableCache = cacheMatchesChain ? cachedLists : null;

    const initialParcels = usableCache && Array.isArray(usableCache.parcels) && usableCache.parcels.length
        ? cachedLists.parcels
        : parcelDetails;
    const initialCreatedRaw = usableCache && Array.isArray(usableCache.created) && usableCache.created.length
        ? cachedLists.created
        : createdProposals;
    const initialAcceptedRaw = usableCache && Array.isArray(usableCache.accepted) && usableCache.accepted.length
        ? cachedLists.accepted
        : acceptedProposals;
    const initialPending = isUserAgent
        ? (usableCache && Array.isArray(usableCache.pending) && usableCache.pending.length
            ? usableCache.pending
            : pendingProposals)
        : [];
    const filteredCreated = filterProposalIdsForChain(initialCreatedRaw, currentChainId);
    const filteredAccepted = filterProposalIdsForChain(initialAcceptedRaw, currentChainId);
    const filteredPending = filterProposalIdsForChain(initialPending, currentChainId);
    const languageSwitcherHtml = renderAgentLanguageSwitcher();
    const initialPendingAmountDisplay = isUserAgent
        ? summarizePendingProposalAmounts(filteredPending)
        : '-';

    const lensButtonTitle = translateText('modal.lens.triggerDescription', 'Lens for viewing the world');
    const lensIconLabel = translateText('modal.lens.iconLabel', 'Lens icon');
    const labelEthBalance = translateText('agentDialog.ethBalance', `${currencySymbol} Balance`);
    const labelPortfolioValue = translateText('agentDialog.portfolioValue', 'Portfolio Value');
    const labelTotalWealth = translateText('agentDialog.totalWealth', 'Total Wealth');
    const labelPendingAmount = translateText('agentDialog.pendingAmount', 'Pending Amount');
    const labelProposalsPending = translateText('agentDialog.proposalsPending', 'Proposals Pending ({{count}})', { count: filteredPending.length });
    const labelProposalsCreated = translateText('agentDialog.proposalsCreated', 'Proposals Created ({{count}})', { count: filteredCreated.length });
    const labelProposalsAccepted = translateText('agentDialog.proposalsAccepted', 'Proposals Accepted ({{count}})', { count: filteredAccepted.length });
    const labelOwnedParcels = translateText('agentDialog.ownedParcels', 'Owned Parcels ({{count}})', { count: initialParcels.length });
    const labelAgentLog = translateText('agentDialog.agentLog', 'Agent Log');
    const labelUser = translateText('agentDialog.userLabel', 'You');
    const labelLogout = translateText('agentDialog.logoutButton', 'Log Out');

    const modal = document.createElement('div');
    modal.className = 'agent-dialog-modal';
    if (elevated) {
        modal.classList.add('agent-dialog-elevated');
    }
    if (readOnly) {
        modal.classList.add('agent-dialog-readonly');
    }
    if (onClose) {
        modal.__onClose = onClose;
    }
    modal.innerHTML = `
        <div class="agent-dialog-modal-content">
            <div class="agent-dialog-modal-header">
                <div class="agent-header-main">
                    <div class="agent-dialog-header-actions">
                        ${languageSwitcherHtml}
                        <button type="button" class="agent-dialog-modal-close" aria-label="Close agent dialog" onclick="closeAgentDialog()" data-readonly-allow="true">&times;</button>
                    </div>
                    <div class="agent-header-top">
                        <div class="agent-avatar-stack">
                            <img src="${getAvatarImagePath(agent.avatarIndex)}" class="agent-avatar-large" alt="Agent Avatar">
                            ${isUserAgent ? `<span class="user-label user-label-overlay" data-i18n-key="agentDialog.userLabel">${labelUser}</span>` : ''}
                        </div>
                        <div class="agent-header-details">
                            <div class="agent-name-row">
                                <div class="agent-name-group">
                                    <h2>${agent.name}</h2>
                                </div>
                            </div>
                            ${isUserAgent ? `
                                <div class="agent-user-identity">
                                    <button class="logout-button" type="button" onclick="showLogoutModal()" data-i18n-key="agentDialog.logoutButton">${labelLogout}</button>
                                </div>
                            ` : ''}
                        </div>
                    </div>
                    ${isUserAgent ? `
                        <div class="agent-header-bottom">
                            <button type="button" class="lens-pattern-button agent-lens-button" data-lens-pattern onclick="showLensModal()" title="${lensButtonTitle}" aria-label="${lensButtonTitle}" data-i18n-key="modal.lens.triggerDescription" data-i18n-attr="title,aria-label">
                                <span role="img" aria-label="${lensIconLabel}" data-i18n-key="modal.lens.iconLabel" data-i18n-attr="aria-label">👓</span>
                            </button>
                            <div class="agent-wallet-actions">
                                <button class="wallet-connect-button btn" type="button" onclick="handleWalletButtonClick()">${renderWalletButtonLabel()}</button>
                                <div class="wallet-chain-info" style="display: none;"></div>
                            </div>
                        </div>
                    ` : ''}
                </div>
            </div>
            <div class="agent-dialog-modal-body">
                <div class="agent-stats-grid">
                    <div class="stat-item">
                            <div class="stat-label" data-i18n-key="agentDialog.ethBalance">${labelEthBalance}</div>
                        <div class="stat-value" ${isUserAgent ? 'data-user-eth-balance' : ''}>${initialEthBalanceDisplay}</div>
                    </div>
                    <div class="stat-item">
                            <div class="stat-label" data-i18n-key="agentDialog.portfolioValue">${labelPortfolioValue}</div>
                        <div class="stat-value" data-agent-portfolio-value>-</div>
                    </div>
                    <div class="stat-item">
                            <div class="stat-label" data-i18n-key="agentDialog.totalWealth">${labelTotalWealth}</div>
                        <div class="stat-value" ${isUserAgent ? 'data-user-total-wealth' : ''} data-agent-total-wealth>${initialTotalWealthDisplay}</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-label" data-i18n-key="agentDialog.pendingAmount">${labelPendingAmount}</div>
                        <div class="stat-value" data-agent-pending-amount>${initialPendingAmountDisplay}</div>
                    </div>
                </div>
                ${isUserAgent ? `
                    <div class="info-section">
                        <h4 data-i18n-key="agentDialog.proposalsPending" data-i18n-params='${JSON.stringify({ count: filteredPending.length })}'>${labelProposalsPending}</h4>
                        <div class="parcels-list" data-list-type="pending"></div>
                    </div>
                ` : ''}
                <div class="info-section">
                    <h4 data-i18n-key="agentDialog.proposalsCreated" data-i18n-params='${JSON.stringify({ count: filteredCreated.length })}'>${labelProposalsCreated}</h4>
                    <div class="parcels-list" data-list-type="created"></div>
                </div>
                <div class="info-section">
                        <h4 data-i18n-key="agentDialog.proposalsAccepted" data-i18n-params='${JSON.stringify({ count: filteredAccepted.length })}'>${labelProposalsAccepted}</h4>
                    <div class="parcels-list" data-list-type="accepted"></div>
                </div>
                <div class="info-section">
                        <h4 data-i18n-key="agentDialog.ownedParcels" data-i18n-params='${JSON.stringify({ count: initialParcels.length })}'>${labelOwnedParcels}</h4>
                    <div class="parcels-list" data-list-type="parcels"></div>
                </div>
                <div class="info-section">
                        <h4 data-i18n-key="agentDialog.agentLog">${labelAgentLog}</h4>
                    <div class="agent-log-container">
                        ${getAgentLogEntries(agent.id)}
                    </div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    if (readOnly) {
        applyAgentDialogReadOnlyState(modal);
    }
    setupAgentDialogLanguageSwitcher(modal);
    if (window.i18n && typeof window.i18n.applyTranslations === 'function') {
        window.i18n.applyTranslations(modal);
    }
    if (typeof refreshLensPatternPreviews === 'function') {
        refreshLensPatternPreviews();
    }
    if (typeof updateAgentDialogWalletButton === 'function') {
        updateAgentDialogWalletButton();
    }
    if (typeof updateAgentDialogChainInfo === 'function') {
        updateAgentDialogChainInfo();
    }

    // Kick off async portfolio calculation and update displays when ready
    if (typeof calculatePortfolioValue === 'function' && ownedParcels.length > 0) {
        (async () => {
            try {
                const value = await calculatePortfolioValue(ownedParcels, { forceRefresh: true });
                console.log('[AgentDialog] Portfolio calculation result:', value);
                portfolioValue = Number.isFinite(value) ? value : NaN;

                const portfolioNode = modal.querySelector('[data-agent-portfolio-value]');
                if (portfolioNode) {
                    portfolioNode.textContent = Number.isFinite(portfolioValue) ? `${portfolioValue.toFixed(2)} ${getChainCurrencySymbol()}` : '-';
                }

                const totalWealthNode = modal.querySelector('[data-agent-total-wealth]');
                if (totalWealthNode) {
                    totalWealthNode.setAttribute('data-portfolio-value', Number.isFinite(portfolioValue) ? portfolioValue : '');
                    if (isUserAgent) {
                        // Let wallet refresh logic combine with latest portfolio
                        if (typeof refreshUserEthBalanceDisplay === 'function') {
                            refreshUserEthBalanceDisplay();
                        } else if (typeof setUserTotalWealthDisplay === 'function') {
                            setUserTotalWealthDisplay(NaN);
                        }
                    } else {
                        const totalWealth = (agent.ethBalance || 0) + (portfolioValue || 0);
                        totalWealthNode.textContent = `${totalWealth.toFixed(2)} ${getChainCurrencySymbol()}`;
                    }
                }
            } catch (error) {
                console.warn('Failed to calculate portfolio value', error);
            }
        })();
    } else {
        console.log('[AgentDialog] Skipping initial portfolio calculation (no parcels yet)');
    }

    if (isUserAgent && typeof window.refreshUserEthBalanceDisplay === 'function') {
        window.refreshUserEthBalanceDisplay();
    }

    // Set up lazy loading for lists
    setupAgentDialogLazyLoading(agentId, initialParcels, filteredCreated, filteredAccepted, filteredPending);

    // Trigger chain-backed loads (async) with spinners
    // Also re-run when wallet state changes so a later connect populates data
    loadAgentChainData(agent, isUserAgent);
    const cleanupFns = [];
    const reloadFn = () => {
        try {
            const evmState = window.walletManager && typeof window.walletManager.getState === 'function'
                ? window.walletManager.getState()
                : null;
            const solanaState = window.solanaWalletManager && typeof window.solanaWalletManager.getState === 'function'
                ? window.solanaWalletManager.getState()
                : null;
            const hasEvmAccounts = evmState && Array.isArray(evmState.accounts) && evmState.accounts.length > 0;
            const hasSolanaAccounts = solanaState && Array.isArray(solanaState.accounts) && solanaState.accounts.length > 0;
            const hasConnectedWallet =
                (evmState && evmState.status === 'connected' && hasEvmAccounts) ||
                (solanaState && solanaState.status === 'connected' && hasSolanaAccounts);
            if (!hasConnectedWallet) {
                return; // ignore interim events until a wallet is connected
            }
            loadAgentChainData(agent, isUserAgent);
        } catch (err) {
            console.warn('[AgentDialog] wallet state listener failed', err);
        }
    };
    if (window.walletManager && typeof window.walletManager.on === 'function') {
        cleanupFns.push(window.walletManager.on('stateChanged', reloadFn));
    }
    if (window.solanaWalletManager && typeof window.solanaWalletManager.on === 'function') {
        cleanupFns.push(window.solanaWalletManager.on('stateChanged', reloadFn));
    }
    if (cleanupFns.length > 0) {
        // Clean up when modal closes
        const cleanup = () => {
            cleanupFns.forEach(dispose => {
                try { dispose(); } catch (_) { }
            });
            document.removeEventListener('agentDialogClosed', cleanup);
        };
        document.addEventListener('agentDialogClosed', cleanup);
    }

    // Set up click listeners for agent log links (similar to game log)
    setupAgentLogClickListeners();
}

function applyAgentDialogReadOnlyState(modal) {
    if (!modal) return;

    const interactiveSelectors = [
        'button',
        '[role="button"]',
        'a[href]',
        'input',
        'select',
        'textarea',
        '[onclick]',
        '[tabindex]'
    ];

    const interactive = modal.querySelectorAll(interactiveSelectors.join(','));
    interactive.forEach(element => {
        const allow = element.getAttribute && element.getAttribute('data-readonly-allow') === 'true';
        if (allow) {
            return; // keep close button active
        }

        if (['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION'].includes(element.tagName)) {
            element.disabled = true;
        }

        if (element.tagName === 'A') {
            element.setAttribute('aria-disabled', 'true');
            element.tabIndex = -1;
        } else if (!element.hasAttribute('tabindex')) {
            element.tabIndex = -1;
        }

        element.classList.add('is-readonly-disabled');
        element.style.pointerEvents = 'none';
    });
}

function setupAgentDialogLanguageSwitcher(modal) {
    if (!modal) return;
    const switcher = modal.querySelector('[data-language-switcher]');
    if (!switcher) return;
    const toggle = switcher.querySelector('[data-language-toggle]');
    const menu = switcher.querySelector('[data-language-menu]');
    if (!toggle || !menu) return;

    const i18nApi = getI18nApi();
    const flagByLang = { en: '🌐', es: '🇪🇸', sr: '🇷🇸', hr: '🇭🇷' };
    const getFlag = (lang) => flagByLang[lang] || '🌐';

    const setExpanded = (expanded) => {
        switcher.classList.toggle('is-open', expanded);
        toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        if (!expanded) {
            menu.scrollTop = 0;
        }
    };

    const setActive = (lang) => {
        const targetLang = lang || (i18nApi && typeof i18nApi.getLanguage === 'function' ? i18nApi.getLanguage() : 'en');
        switcher.querySelectorAll('[data-language]').forEach(button => {
            const isActive = button.getAttribute('data-language') === targetLang;
            button.classList.toggle('is-active', isActive);
            button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
        const flagEl = toggle.querySelector('span');
        if (flagEl) {
            flagEl.textContent = getFlag(targetLang);
        }
        if (typeof updateAgentDialogWalletButton === 'function') {
            try { updateAgentDialogWalletButton(); } catch (_) { }
        }
        if (typeof updateAgentDialogChainInfo === 'function') {
            try { updateAgentDialogChainInfo(); } catch (_) { }
        }
    };

    const handleOptionClick = (event) => {
        const targetButton = event.target.closest ? event.target.closest('[data-language]') : null;
        if (!targetButton || !menu.contains(targetButton)) return;
        const selectedLang = targetButton.getAttribute('data-language');
        if (!selectedLang) return;

        if (i18nApi && typeof i18nApi.setLanguage === 'function') {
            i18nApi.setLanguage(selectedLang);
        }
        setActive(selectedLang);
        setExpanded(false);
    };

    const handleToggle = () => {
        const expanded = toggle.getAttribute('aria-expanded') === 'true';
        setExpanded(!expanded);
    };

    const handleOutsideClick = (event) => {
        if (!switcher.contains(event.target)) {
            setExpanded(false);
        }
    };

    const handleKeydown = (event) => {
        if (event.key === 'Escape') {
            setExpanded(false);
        }
    };

    toggle.addEventListener('click', handleToggle);
    menu.addEventListener('click', handleOptionClick);
    document.addEventListener('click', handleOutsideClick);
    document.addEventListener('keydown', handleKeydown);

    let unsubscribe = null;
    if (i18nApi && typeof i18nApi.onChange === 'function') {
        unsubscribe = i18nApi.onChange(setActive);
    }

    setActive();

    if (i18nApi && typeof i18nApi.applyTranslations === 'function') {
        i18nApi.applyTranslations(switcher);
    }

    modal.__i18nCleanup = () => {
        toggle.removeEventListener('click', handleToggle);
        menu.removeEventListener('click', handleOptionClick);
        document.removeEventListener('click', handleOutsideClick);
        document.removeEventListener('keydown', handleKeydown);
        if (typeof unsubscribe === 'function') {
            try { unsubscribe(); } catch (_) { }
        }
    };
}

/**
 * Show a loader spinner inside a list container
 */
function setListLoading(listType, message = 'Loading from chain...') {
    const listContainer = document.querySelector(`[data-list-type="${listType}"]`);
    if (listContainer) {
        listContainer.innerHTML = `
            <div class="loader-spinner" role="status" aria-live="polite">
                <div class="spinner-circle" aria-hidden="true"></div>
                <span class="loader-text">${message}</span>
            </div>
        `;
    }
}

function setListError(listType, message = 'Could not connect to chain') {
    const listContainer = document.querySelector(`[data-list-type="${listType}"]`);
    if (listContainer) {
        listContainer.innerHTML = `<div class="loader-spinner" style="color:#c0392b;font-weight:600;">${message}</div>`;
    }
}

function resetList(listType) {
    const listContainer = document.querySelector(`[data-list-type="${listType}"]`);
    if (listContainer) {
        listContainer.innerHTML = '';
    }
}

/**
 * Append items to a list container
 */
function appendListItems(listType, itemsHtml) {
    const listContainer = document.querySelector(`[data-list-type="${listType}"]`);
    if (listContainer) {
        // Remove empty-state if present
        const empty = listContainer.querySelector('.empty-list');
        if (empty) empty.remove();
        const loader = listContainer.querySelector('.loader-spinner');
        if (loader) loader.remove();
        listContainer.insertAdjacentHTML('beforeend', itemsHtml);
    }
}

/**
 * Render helpers
 */
function renderParcelListItem(parcelId) {
    return renderParcelItem({ id: parcelId, number: parcelId, proposalCount: 0 });
}

/**
 * Get a human-readable chain label for a proposal
 */
function getProposalChainLabel(proposal) {
    if (!proposal) return null;
    const chainId = proposal.chainId || (proposal.onchain && proposal.onchain.chainId);
    if (!chainId) return null;

    if (typeof getNetworkDisplayInfo === 'function') {
        const info = getNetworkDisplayInfo(chainId);
        if (info && info.text) return info.text;
    }

    if (typeof normalizeChainId === 'function') {
        const normalized = normalizeChainId(chainId);
        if (normalized) return normalized;
    }

    return String(chainId);
}

function isLocalProposalIdAgent(value) {
    if (value === undefined || value === null) return false;
    const str = String(value);
    return str.startsWith('local-') || str.startsWith('local_prop') || str.startsWith('local-prop');
}

/**
 * Compute display metadata for a proposal, normalising local IDs to the `local-<n>` form.
 */
function getProposalDisplayMeta(proposal, fallbackId = '') {
    const proposalIdRaw = proposal ? (proposal.proposalId || null) : null;
    const fallbackRaw = fallbackId !== undefined && fallbackId !== null ? String(fallbackId) : '';

    const proposalId = proposalIdRaw !== null && proposalIdRaw !== undefined ? String(proposalIdRaw) : '';

    let minted = (proposal && (
        proposal.isMinted === true
        || !!(proposal.onchain && proposal.onchain.transactionHash)
        || (proposalId && !isLocalProposalIdAgent(proposalId))
    )) || false;

    // If we have no proposal object (e.g., cached id only), treat numeric ids as minted
    if (!minted && !proposal && fallbackRaw) {
        const numericFallback = Number.isFinite(parseInt(fallbackRaw, 10));
        minted = numericFallback && !isLocalProposalIdAgent(fallbackRaw);
    }

    let displayId;
    if (minted) {
        displayId = proposalId || fallbackRaw || 'unknown';
    } else {
        const baseLocalId = proposalId || fallbackRaw || '';
        const numericLocal = Number.isFinite(parseInt(baseLocalId, 10)) ? parseInt(baseLocalId, 10) : null;
        displayId = `local-${numericLocal !== null ? numericLocal : (baseLocalId || 'unknown')}`;
    }

    return {
        minted,
        displayId,
        chainLabel: getProposalChainLabel(proposal) || ''
    };
}

function getAgentProposalTypeLabel(proposal) {
    const defaultType = 'parcel';
    const typeKeyRaw = proposal
        ? (typeof getProposalDisplayType === 'function'
            ? getProposalDisplayType(proposal)
            : ((typeof normalizeProposalGoalKey === 'function' ? normalizeProposalGoalKey(proposal.goal) : (proposal.goal || defaultType))))
        : defaultType;
    const typeKey = typeof typeKeyRaw === 'string' ? typeKeyRaw.toLowerCase() : defaultType;

    // Prefer localized labels from i18n if available
    const typeKeyToI18n = {
        road: 'modal.roadWidth.proposalList.typeLabels.road',
        building: 'modal.roadWidth.proposalList.typeLabels.building',
        park: 'modal.roadWidth.proposalList.typeLabels.park',
        square: 'modal.roadWidth.proposalList.typeLabels.square',
        structure: 'modal.roadWidth.proposalList.typeLabels.structure',
        reparcellization: 'modal.roadWidth.proposalList.typeLabels.reparcellization',
        parcel: 'modal.roadWidth.proposalList.typeLabels.parcel',
        other: 'modal.roadWidth.proposalList.typeLabels.other'
    };
    const i18nKey = typeKeyToI18n[typeKey];
    if (i18nKey) {
        const translated = translateText(i18nKey, '');
        if (translated && translated !== i18nKey) {
            return translated;
        }
    }

    if (typeof formatProposalTypeLabel === 'function') {
        return formatProposalTypeLabel(typeKey);
    }

    if (typeof PROPOSAL_TYPE_LABELS !== 'undefined' && PROPOSAL_TYPE_LABELS && PROPOSAL_TYPE_LABELS[typeKey]) {
        return PROPOSAL_TYPE_LABELS[typeKey];
    }

    return typeKey ? typeKey.charAt(0).toUpperCase() + typeKey.slice(1) : '';
}

function getAgentProposalOfferDisplay(proposal) {
    const rawOfferValue = proposal
        ? (Number.isFinite(Number(proposal.offer))
            ? Number(proposal.offer)
            : (Number.isFinite(Number(proposal.budget)) ? Number(proposal.budget) : null))
        : null;

    const amountLabel = rawOfferValue !== null
        ? Number(rawOfferValue).toLocaleString(undefined, { maximumFractionDigits: 2 })
        : '-';

    const currencyRaw = proposal
        ? (proposal.offerCurrency || proposal.budgetCurrency || proposal.currency || getChainCurrencySymbol())
        : '';
    const currencyLabel = currencyRaw ? String(currencyRaw).toUpperCase() : '';

    return { amountLabel, currencyLabel };
}

function getAgentProposalTitle(proposal, fallbackId = '') {
    const fallbackTitle = fallbackId ? `Proposal ${fallbackId}` : 'Proposal';
    const candidates = [
        proposal && typeof proposal.title === 'string' ? proposal.title : null,
        proposal && typeof proposal.name === 'string' ? proposal.name : null,
        proposal && typeof proposal.blockName === 'string' ? proposal.blockName : null,
        proposal && proposal.structureProposal && typeof proposal.structureProposal.blockName === 'string' ? proposal.structureProposal.blockName : null,
        proposal && proposal.roadProposal && typeof proposal.roadProposal.name === 'string' ? proposal.roadProposal.name : null,
        proposal && proposal.metadata && typeof proposal.metadata.name === 'string' ? proposal.metadata.name : null,
        proposal && proposal.metadata && typeof proposal.metadata.title === 'string' ? proposal.metadata.title : null,
        proposal && proposal.onchain && proposal.onchain.metadata && typeof proposal.onchain.metadata.name === 'string' ? proposal.onchain.metadata.name : null,
        proposal && proposal.onchain && proposal.onchain.metadata && typeof proposal.onchain.metadata.title === 'string' ? proposal.onchain.metadata.title : null,
        proposal && typeof proposal.description === 'string' ? proposal.description : null
    ];

    const typeLabels = (typeof PROPOSAL_TYPE_LABELS !== 'undefined' && PROPOSAL_TYPE_LABELS)
        ? Object.values(PROPOSAL_TYPE_LABELS).map(v => String(v).toLowerCase())
        : ['road', 'building', 'park', 'square', 'structure', 'reparcellization', 'parcel', 'other'];

    let best = '';
    let bestScore = -Infinity;
    const seen = new Set();
    candidates.forEach(candidate => {
        const trimmed = candidate && String(candidate).trim();
        if (!trimmed || seen.has(trimmed)) return;
        seen.add(trimmed);
        const lower = trimmed.toLowerCase();
        let score = trimmed.length;
        if (typeLabels.includes(lower)) {
            score -= 100; // heavily de-prioritise pure type labels
        }
        if (score > bestScore) {
            bestScore = score;
            best = trimmed;
        }
    });

    if (best) {
        return best;
    }

    return fallbackTitle;
}

function renderProposalListItem(proposalId) {
    const fallbackId = proposalId !== undefined && proposalId !== null ? proposalId : '';
    let { minted, displayId, chainLabel } = getProposalDisplayMeta(null, fallbackId);
    let displayTitle = getAgentProposalTitle(null, displayId || fallbackId);
    let typeLabel = '';
    let offerAmountLabel = '-';
    let offerCurrencyLabel = '';
    const mintedLabel = translateText('agentDialog.proposalStatus.minted', 'Minted');
    const localLabel = translateText('agentDialog.proposalStatus.local', 'Local');
    if (typeof proposalStorage !== 'undefined') {
        const p = proposalStorage.findProposalByIdOrHash ? proposalStorage.findProposalByIdOrHash(proposalId) : proposalStorage.getProposal && proposalStorage.getProposal(proposalId);
        if (p) {
            const meta = getProposalDisplayMeta(p, fallbackId);
            minted = meta.minted;
            displayId = meta.displayId;
            chainLabel = meta.chainLabel;
            displayTitle = getAgentProposalTitle(p, displayId || fallbackId);
            typeLabel = getAgentProposalTypeLabel(p);
            const offerInfo = getAgentProposalOfferDisplay(p);
            offerAmountLabel = offerInfo.amountLabel;
            offerCurrencyLabel = offerInfo.currencyLabel;
        }
    }
    const badge = minted
        ? `<span class="proposal-status is-minted">${mintedLabel}</span>`
        : `<span class="proposal-status is-local">${localLabel}</span>`;
    const chainBadge = chainLabel ? `<span class="proposal-chain-label">[${chainLabel}]</span>` : '';
    const typeBadge = typeLabel ? `<span class="proposal-type-pill">${typeLabel}</span>` : '';
    const offerAmount = `<span class="proposal-offer-amount">${offerAmountLabel}</span>`;
    const offerCurrency = offerCurrencyLabel ? `<span class="proposal-offer-currency">${offerCurrencyLabel}</span>` : '';
    return `<div class="proposal-list-item proposal-clickable" data-proposal-id="${proposalId}" onclick="focusOnProposal('${proposalId}')">${displayTitle} (${displayId}) ${typeBadge} ${badge} ${chainBadge} ${offerAmount} ${offerCurrency}</div>`;
}

/**
 * Click handler for parcel items: close modal and select parcel
 */
function handleParcelClick(parcelId) {
    if (typeof focusOnParcel === 'function') {
        focusOnParcel(parcelId);
    } else if (typeof selectParcel === 'function') {
        selectParcel(parcelId);
    } else {
        console.warn('No parcel focus function available');
    }
}

/**
 * Update section header counts
 */
function setSectionCount(sectionType, count, fallbackLabel = '') {
    const listContainer = document.querySelector(`[data-list-type="${sectionType}"]`);
    if (!listContainer) return;

    const section = listContainer.closest('.info-section');
    if (!section) return;

    const header = section.querySelector('h4');
    if (!header) return;

    // Remember the base label (without the count) so we can rebuild it reliably
    const baseLabel = header.getAttribute('data-base-label')
        || fallbackLabel
        || (header.textContent || '').replace(/\s*\(.*?\)\s*$/, '').trim();
    if (!header.getAttribute('data-base-label') && baseLabel) {
        header.setAttribute('data-base-label', baseLabel);
    }

    // Keep i18n params in sync so future translations reuse the updated count
    let params = {};
    const paramsRaw = header.getAttribute('data-i18n-params');
    if (paramsRaw) {
        try {
            params = JSON.parse(paramsRaw) || {};
        } catch (_) {
            params = {};
        }
    }
    params.count = count;
    header.setAttribute('data-i18n-params', JSON.stringify(params));

    const i18nKey = header.getAttribute('data-i18n-key');
    const fallbackText = baseLabel ? `${baseLabel} (${count})` : `${count}`;

    let newText = fallbackText;
    if (typeof translateText === 'function' && i18nKey) {
        try {
            newText = translateText(i18nKey, fallbackText, params) || fallbackText;
        } catch (_) {
            newText = fallbackText;
        }
    }

    header.textContent = newText;
}

/**
 * Load on-chain data for agent modal and merge into UI
 */
async function loadAgentChainData(agent, isUserAgent) {
    const solanaWalletManager = window.solanaWalletManager;
    const solanaState = solanaWalletManager && typeof solanaWalletManager.getState === 'function'
        ? solanaWalletManager.getState()
        : null;
    const solanaConnected = !!(solanaState && solanaState.status === 'connected' && Array.isArray(solanaState.accounts) && solanaState.accounts.length > 0);
    const solanaCluster = solanaConnected
        ? (solanaWalletManager && typeof solanaWalletManager.getCluster === 'function'
            ? solanaWalletManager.getCluster()
            : (solanaState.cluster || 'devnet'))
        : null;

    const walletState = window.walletManager && window.walletManager.getState && window.walletManager.getState();
    const walletProvider = window.walletManager && window.walletManager.getProvider && window.walletManager.getProvider();
    const evmConnected = !!(walletState && walletProvider && Array.isArray(walletState.accounts) && walletState.accounts.length > 0);

    const useSolana = solanaConnected;
    if (useSolana) {
        if (!window.SolanaChainDataLoader || !window.solanaWeb3) {
            console.warn('Solana chain data loader not ready');
            return;
        }
    } else if (!window.ChainDataLoader || !window.ContractsLoader || !window.ethers || !window.walletManager) {
        console.warn('Chain data loader not ready');
        return;
    }

    if (!useSolana && !evmConnected) {
        console.debug('No connected wallet; skipping chain load');
        return;
    }

    const walletAddress = useSolana ? solanaState.accounts[0] : walletState.accounts[0];
    const chainId = useSolana ? `solana-${solanaCluster}` : walletState.chainId;
    const normalizedChainId = typeof normalizeChainId === 'function' ? normalizeChainId(chainId) : chainId;
    console.log('[AgentDialog] Loading chain data', { walletAddress, chainId, useSolana });

    handleAgentDialogChainChange(normalizedChainId);
    pruneAgentDialogListDataForChain(normalizedChainId);

    const cache = getAgentDialogCache(agent.id);
    const cacheFresh = cache
        && cache.chainId === normalizedChainId
        && cache.walletAddress === walletAddress
        && cache.lastFetchedAt
        && (Date.now() - cache.lastFetchedAt) < AGENT_DIALOG_CACHE_TTL_MS;

    const cacheKey = `${agent.id}:${normalizedChainId}:${walletAddress}`;
    const existingFetch = agentDialogFetchPromises.get(cacheKey);
    if (existingFetch) {
        console.log('[AgentDialog] Reusing in-flight chain fetch', { cacheKey });
        return existingFetch;
    }
    if (cacheFresh) {
        console.log('[AgentDialog] Cache still fresh; skipping chain refetch', { cacheKey });
        return;
    }

    // Resolve contract/program addresses (with fallbacks)
    let parcelAddress = null;
    let proposalAddress = null;
    try {
        if (useSolana) {
            const solanaChainKey = `solana-${solanaCluster}`;
            if (window.SolanaChainDataLoader && typeof window.SolanaChainDataLoader.resolveProgramAddress === 'function') {
                const [resolvedParcel, resolvedProposal] = await Promise.all([
                    window.SolanaChainDataLoader.resolveProgramAddress(solanaChainKey, 'ParcelNFT'),
                    window.SolanaChainDataLoader.resolveProgramAddress(solanaChainKey, 'ProposalNFT')
                ]);
                parcelAddress = resolvedParcel
                    || await window.SolanaChainDataLoader.resolveProgramAddress('solana', 'ParcelNFT');
                proposalAddress = resolvedProposal
                    || await window.SolanaChainDataLoader.resolveProgramAddress('solana', 'ProposalNFT');
            }
        } else if (window.ChainDataLoader && typeof window.ChainDataLoader.resolveContractAddress === 'function') {
            parcelAddress = await window.ChainDataLoader.resolveContractAddress(chainId, 'ParcelNFT');
            proposalAddress = await window.ChainDataLoader.resolveContractAddress(chainId, 'ProposalNFT');
        } else if (window.ContractsLoader && typeof window.ContractsLoader.getContractAddress === 'function') {
            parcelAddress = await window.ContractsLoader.getContractAddress(chainId, 'ParcelNFT');
            proposalAddress = await window.ContractsLoader.getContractAddress(chainId, 'ProposalNFT');
        }
    } catch (err) {
        console.warn('Failed to resolve contract addresses', err);
    }
    if (!parcelAddress && !proposalAddress) {
        console.warn('Missing contract addresses for chain', chainId);
        return;
    }
    console.log('[AgentDialog] Resolved addresses', { parcelAddress, proposalAddress, useSolana });

    if (!agentDialogListData) {
        ensureAgentDialogListState(agent.id, [], [], [], []);
    }

    const hasExistingListData = agentDialogListData && (
        (agentDialogListData.parcels && agentDialogListData.parcels.data.length) ||
        (agentDialogListData.created && agentDialogListData.created.data.length) ||
        (agentDialogListData.accepted && agentDialogListData.accepted.data.length) ||
        (agentDialogListData.pending && agentDialogListData.pending.data.length)
    );

    if (!hasExistingListData) {
        // Only show loaders when we don't already have something to show
        setListLoading('parcels');
        setListLoading('created');
        setListLoading('accepted');
        if (isUserAgent) {
            setListLoading('pending');
        }
    }

    const fetchPromise = (async () => {
        try {
            const activeChainLabel = useSolana ? solanaCluster : chainId;
            let parcels = [];
            let createdProposals = [];
            let solanaAllProposals = null;

            if (useSolana) {
                const [loadedParcels, loadedAllProposals] = await Promise.all([
                    parcelAddress
                        ? window.SolanaChainDataLoader.getParcelsFromChain(walletAddress, solanaCluster, parcelAddress)
                        : Promise.resolve([]),
                    proposalAddress
                        ? window.SolanaChainDataLoader.getAllProposals(solanaCluster, proposalAddress)
                        : Promise.resolve([])
                ]);
                parcels = loadedParcels;
                solanaAllProposals = Array.isArray(loadedAllProposals) ? loadedAllProposals : [];
                createdProposals = solanaAllProposals.filter(proposal => proposal && proposal.owner === walletAddress);
            } else {
                [parcels, createdProposals] = await Promise.all([
                    parcelAddress
                        ? window.ChainDataLoader.getParcelsFromChain(walletAddress, chainId, parcelAddress)
                        : Promise.resolve([]),
                    proposalAddress
                        ? window.ChainDataLoader.getProposalsFromChain(walletAddress, chainId, proposalAddress)
                        : Promise.resolve([])
                ]);
            }

            const pendingProposals = [];
            const acceptedProposals = [];
            const proposalAcceptanceMap = new Map(); // proposalId -> {parentParcelIds:Set, acceptedParcels:Set}

            const uniq = arr => Array.from(new Set(arr));
            const existingParcels = agentDialogListData && agentDialogListData.parcels ? agentDialogListData.parcels.data : [];
            const existingCreated = agentDialogListData && agentDialogListData.created ? agentDialogListData.created.data : [];
            const existingAccepted = agentDialogListData && agentDialogListData.accepted ? agentDialogListData.accepted.data : [];
            const existingPending = agentDialogListData && agentDialogListData.pending ? agentDialogListData.pending.data : [];

            const uniqParcels = uniq([...existingParcels.map(p => (p.id || p)), ...parcels.map(p => p.parcelId)]);
            const uniqCreated = uniq([
                ...existingCreated,
                ...createdProposals.map(p => p.proposalId)
            ]);

            // Hydrate created proposals immediately so list rendering has metadata while status scan runs
            if (typeof proposalStorage !== 'undefined'
                && typeof proposalStorage.importOnChainProposal === 'function'
                && Array.isArray(createdProposals)
                && createdProposals.length > 0) {
                createdProposals.forEach(p => {
                    try {
                        proposalStorage.importOnChainProposal({
                            proposalId: p.proposalId,
                            parentParcelIds: Array.isArray(p.parentParcelIds) ? p.parentParcelIds : [],
                            acceptedParcels: [],
                            isConditional: p.isConditional,
                            imageURI: p.imageURI,
                            acceptancePossible: p.acceptancePossible,
                            status: p.status,
                            ethBalance: p.ethBalance,
                            tokenBalance: p.tokenBalance,
                            acceptanceCount: p.acceptanceCount,
                            expiryTimestamp: p.expiryTimestamp,
                            expiringPercentage: p.expiringPercentage,
                            author: p.owner,
                            chainId: normalizedChainId,
                            isMinted: true
                        });
                    } catch (err) {
                        console.warn('Failed to hydrate created proposal early', p, err);
                    }
                });
            }

            // Merge the data we already have so the UI updates immediately
            const parcelsAdded = mergeAgentDialogListData('parcels', uniqParcels);
            const createdAdded = mergeAgentDialogListData('created', uniqCreated);
            let acceptedAdded = false;
            let pendingAdded = false;

            // Record ownership temporarily for this session (do not persist across reloads)
            if (isUserAgent && Array.isArray(uniqParcels) && uniqParcels.length) {
                agentDialogTempOwnership[agent.id] = uniqParcels.slice();
                if (typeof window !== 'undefined') {
                    window.agentDialogTempOwnership = agentDialogTempOwnership;
                }
            }

            // Render early (and clear loaders) for lists that already have data
            renderFirstPageForList('parcels');
            renderFirstPageForList('created');
            if (agentDialogListData && agentDialogListData.parcels) {
                setSectionCount('parcels', agentDialogListData.parcels.data.length, 'Owned Parcels');
            }
            if (agentDialogListData && agentDialogListData.created) {
                setSectionCount('created', agentDialogListData.created.data.length, 'Proposals Created');
            }

            // Recompute portfolio value now that on-chain parcels are known (do not wait for proposal scan)
            if (isUserAgent && typeof calculatePortfolioValue === 'function') {
                try {
                    const ownedNow = getAgentOwnedParcels(agent.id);
                    const value = await calculatePortfolioValue(ownedNow, { forceRefresh: true });
                    const modal = document.querySelector('.agent-dialog-modal');
                    if (modal) {
                        const portfolioNode = modal.querySelector('[data-agent-portfolio-value]');
                        const totalWealthNode = modal.querySelector('[data-agent-total-wealth]');
                        const portfolioValue = Number.isFinite(value) ? value : NaN;
                        if (portfolioNode) {
                            portfolioNode.textContent = Number.isFinite(portfolioValue) ? `${portfolioValue.toFixed(2)} ${getChainCurrencySymbol()}` : '-';
                        }
                        if (totalWealthNode) {
                            totalWealthNode.setAttribute('data-portfolio-value', Number.isFinite(portfolioValue) ? portfolioValue : '');
                            if (Number.isFinite(portfolioValue)) {
                                const totalWealth = (agent.ethBalance || 0) + portfolioValue;
                                totalWealthNode.textContent = `${totalWealth.toFixed(2)} ${getChainCurrencySymbol()}`;
                            }
                        }
                        if (typeof refreshUserEthBalanceDisplay === 'function') {
                            refreshUserEthBalanceDisplay();
                        }
                    }
                } catch (err) {
                    console.warn('Failed to recompute portfolio after chain load', err);
                }
            }

            const ownedParcelIds = parcels.map(p => p.parcelId);
            const addAcceptanceInfo = (proposalId, parentParcelIds = [], acceptedParcels = []) => {
                let entry = proposalAcceptanceMap.get(proposalId);
                if (!entry) {
                    entry = { parentParcelIds: new Set(), acceptedParcels: new Set() };
                    proposalAcceptanceMap.set(proposalId, entry);
                }
                (parentParcelIds || []).forEach(pid => entry.parentParcelIds.add(pid));
                (acceptedParcels || []).forEach(pid => entry.acceptedParcels.add(pid));
            };

            const scanPerParcel = async () => {
                const hasOnChainProposals = useSolana
                    ? Array.isArray(solanaAllProposals) && solanaAllProposals.length > 0
                    : Array.isArray(createdProposals) && createdProposals.length > 0;
                if (ownedParcelIds.length > 0 && proposalAddress && hasOnChainProposals) {
                    for (const parcel of parcels) {
                        const proposalsWithStatus = useSolana
                            ? (solanaAllProposals || [])
                                .filter(proposal => Array.isArray(proposal.parentParcelIds) && proposal.parentParcelIds.includes(parcel.parcelId))
                                .map(proposal => ({
                                    proposalId: proposal.proposalId,
                                    hasAccepted: Array.isArray(proposal.acceptedParcels) && proposal.acceptedParcels.includes(parcel.parcelId)
                                }))
                            : await window.ChainDataLoader.getProposalsWithAcceptanceStatus(
                                chainId,
                                proposalAddress,
                                parcel.parcelId
                            );
                        proposalsWithStatus.forEach(p => {
                            addAcceptanceInfo(p.proposalId, [parcel.parcelId], p.hasAccepted ? [parcel.parcelId] : []);
                            if (p.hasAccepted) {
                                acceptedProposals.push(p.proposalId);
                            } else {
                                pendingProposals.push(p.proposalId);
                            }
                        });
                    }
                } else {
                    console.log('[AgentDialog] Skipping parcel proposal status scan', {
                        chainId,
                        parcelCount: parcels.length,
                        createdProposalCount: createdProposals.length
                    });
                }
            };

            let usedProposalCentric = false;
            if (!useSolana && proposalAddress && window.ChainDataLoader && typeof window.ChainDataLoader.getProposalsAffectingParcels === 'function') {
                try {
                    const status = await window.ChainDataLoader.getProposalsAffectingParcels(
                        chainId,
                        proposalAddress,
                        ownedParcelIds
                    );
                    const acceptanceByProposal = status && status.acceptanceByProposal ? status.acceptanceByProposal : {};
                    Object.keys(acceptanceByProposal).forEach(pid => {
                        const info = acceptanceByProposal[pid] || {};
                        addAcceptanceInfo(pid, info.parentParcelIds || [], info.acceptedParcels || []);
                    });
                    if (status && Array.isArray(status.pending)) {
                        pendingProposals.push(...status.pending);
                    }
                    if (status && Array.isArray(status.accepted)) {
                        acceptedProposals.push(...status.accepted);
                    }
                    usedProposalCentric = true;
                } catch (err) {
                    console.warn('[AgentDialog] Proposal-centric scan failed, falling back to per-parcel', err);
                }
            }

            if (!usedProposalCentric) {
                await scanPerParcel();
            }

            const uniqPending = uniq([...existingPending, ...pendingProposals]);
            const uniqAccepted = uniq([...existingAccepted, ...acceptedProposals]);

            // Hydrate on-chain proposals (all encountered) into proposalStorage with tokenId as proposalId
            if (proposalAddress && typeof proposalStorage !== 'undefined' && typeof proposalStorage.importOnChainProposal === 'function') {
                const allProposalIds = uniq([
                    ...createdProposals.map(p => p.proposalId),
                    ...Array.from(proposalAcceptanceMap.keys())
                ]);

                const importHydratedProposal = (proposalId, proposalData = {}, acceptanceInfo = null) => {
                    proposalStorage.importOnChainProposal({
                        proposalId: proposalId,
                        parentParcelIds: Array.isArray(proposalData.parentParcelIds)
                            ? proposalData.parentParcelIds
                            : (acceptanceInfo ? Array.from(acceptanceInfo.parentParcelIds) : []),
                        acceptedParcels: acceptanceInfo ? Array.from(acceptanceInfo.acceptedParcels) : [],
                        isConditional: proposalData.isConditional,
                        imageURI: proposalData.imageURI,
                        acceptancePossible: proposalData.acceptancePossible,
                        status: proposalData.status,
                        ethBalance: proposalData.ethBalance,
                        tokenBalance: proposalData.tokenBalance,
                        acceptanceCount: proposalData.acceptanceCount,
                        expiryTimestamp: proposalData.expiryTimestamp,
                        expiringPercentage: proposalData.expiringPercentage,
                        author: proposalData.owner,
                        chainId: normalizedChainId,
                        isMinted: true
                    });
                };

                if (allProposalIds.length > 0 && useSolana && Array.isArray(solanaAllProposals)) {
                    try {
                        const byId = new Map(solanaAllProposals.map(p => [String(p.proposalId), p]));
                        allProposalIds.forEach(pid => {
                            const acceptanceInfo = proposalAcceptanceMap.get(pid);
                            importHydratedProposal(pid, byId.get(String(pid)) || {}, acceptanceInfo);
                        });
                    } catch (err) {
                        console.warn('Failed Solana hydrate of proposals', err);
                        createdProposals.forEach(p => {
                            const acceptanceInfo = proposalAcceptanceMap.get(p.proposalId);
                            importHydratedProposal(p.proposalId, p, acceptanceInfo);
                        });
                    }
                } else if (allProposalIds.length > 0 && window.ChainDataLoader && typeof window.ChainDataLoader.getProposalsBatch === 'function') {
                    try {
                        const batch = await window.ChainDataLoader.getProposalsBatch(chainId, proposalAddress, allProposalIds);
                        const byId = new Map(batch.map(p => [String(p.proposalId), p]));
                        allProposalIds.forEach(pid => {
                            const acceptanceInfo = proposalAcceptanceMap.get(pid);
                            importHydratedProposal(pid, byId.get(String(pid)) || {}, acceptanceInfo);
                        });
                    } catch (err) {
                        console.warn('Failed batch hydrate of proposals', err);
                        // Fallback: hydrate only createdProposals
                        createdProposals.forEach(p => {
                            const acceptanceInfo = proposalAcceptanceMap.get(p.proposalId);
                            importHydratedProposal(p.proposalId, p, acceptanceInfo);
                        });
                    }
                }
            }

            acceptedAdded = mergeAgentDialogListData('accepted', uniqAccepted);
            pendingAdded = isUserAgent ? mergeAgentDialogListData('pending', uniqPending) : false;

            renderFirstPageForList('accepted');
            if (isUserAgent) {
                renderFirstPageForList('pending');
                updatePendingAmountDisplay(agentDialogListData && agentDialogListData.pending ? agentDialogListData.pending.data : uniqPending);
            }

            // Update header counts
            if (agentDialogListData && agentDialogListData.parcels) {
                setSectionCount('parcels', agentDialogListData.parcels.data.length, 'Owned Parcels');
            }
            if (agentDialogListData && agentDialogListData.created) {
                setSectionCount('created', agentDialogListData.created.data.length, 'Proposals Created');
            }
            if (agentDialogListData && agentDialogListData.accepted) {
                setSectionCount('accepted', agentDialogListData.accepted.data.length, 'Proposals Accepted');
            }
            if (isUserAgent) {
                updatePendingProposalsCount(agentDialogListData && agentDialogListData.pending ? agentDialogListData.pending.data.length : 0);
            }

            // Persist latest snapshot for reuse
            setAgentDialogCache(agent.id, {
                chainId: normalizedChainId,
                walletAddress,
                parcels: agentDialogListData && agentDialogListData.parcels ? agentDialogListData.parcels.data.slice() : [],
                created: agentDialogListData && agentDialogListData.created ? agentDialogListData.created.data.slice() : [],
                accepted: agentDialogListData && agentDialogListData.accepted ? agentDialogListData.accepted.data.slice() : [],
                pending: agentDialogListData && agentDialogListData.pending ? agentDialogListData.pending.data.slice() : [],
                lastFetchedAt: Date.now()
            });

            const addedAnything = parcelsAdded || createdAdded || acceptedAdded || pendingAdded;
            if (!addedAnything) {
                console.log('[AgentDialog] Chain data unchanged; no list updates applied', { chainId: activeChainLabel });
            }
        } catch (err) {
            console.warn('[AgentDialog] Failed to load on-chain data', err);
            const errMsg = 'Could not connect to chain';
            setListError('parcels', errMsg);
            setListError('created', errMsg);
            setListError('accepted', errMsg);
            if (isUserAgent) {
                setListError('pending', errMsg);
            }
            throw err;
        }
    })();

    agentDialogFetchPromises.set(cacheKey, fetchPromise);
    try {
        await fetchPromise;
    } catch (error) {
        console.warn('Failed to load chain data for agent modal', error);
    } finally {
        agentDialogFetchPromises.delete(cacheKey);
    }
}

/**
 * Get pending proposals for the user's parcels filtered to the active chain (minted) plus locals
 */
function getUserPendingProposals(agentId, chainId = null) {
    if (typeof proposalStorage === 'undefined') return [];

    const userParcelIds = getAgentOwnedParcels(agentId);
    const allProposals = proposalStorage.getAllProposals();
    const normalizedChain = normalizeChainIdSafe(chainId);

    // Get proposals that affect user's parcels, sorted by creation date (newest first)
    const relevantProposals = allProposals
        .filter(proposal =>
            proposal.status === 'Active' &&
            (Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds : (Array.isArray(proposal.childParcelIds) ? proposal.childParcelIds : [])).some(parcelId => userParcelIds.includes(parcelId)) &&
            (
                proposal.isMinted !== true ||
                (normalizedChain &&
                    normalizeChainIdSafe(proposal.chainId || (proposal.onchain && proposal.onchain.chainId)) === normalizedChain)
            )
        )
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .map(proposal => proposal.proposalId || proposal.tokenId)
        .filter(Boolean);

    return relevantProposals;
}

function getProposalOfferAmount(proposal) {
    const candidates = [
        proposal && proposal.offer,
        proposal && proposal.budget,
        proposal && proposal.ethBalance,
        proposal && proposal.tokenBalance
    ];
    for (const value of candidates) {
        const num = Number(value);
        if (Number.isFinite(num) && num > 0) {
            return num;
        }
    }
    return NaN;
}

function summarizePendingProposalAmounts(proposalIds = []) {
    if (!Array.isArray(proposalIds) || proposalIds.length === 0) return '-';
    if (typeof proposalStorage === 'undefined' || (!proposalStorage.getProposal && !proposalStorage.findProposalByIdOrHash)) {
        return '-';
    }

    let currency = null;
    let mixedCurrency = false;
    let total = 0;

    proposalIds.forEach(id => {
        const proposal =
            (proposalStorage.findProposalByIdOrHash ? proposalStorage.findProposalByIdOrHash(id) : null)
            || (proposalStorage.getProposal ? proposalStorage.getProposal(id) : null)
            || null;
        if (!proposal) return;

        const amount = getProposalOfferAmount(proposal);
        if (!Number.isFinite(amount) || amount <= 0) return;

        const proposalCurrency = (proposal.offerCurrency || proposal.budgetCurrency || proposal.currency || getChainCurrencySymbol()).toString().toUpperCase();
        if (!currency) {
            currency = proposalCurrency;
        } else if (currency !== proposalCurrency) {
            mixedCurrency = true;
        }
        if (!mixedCurrency) {
            total += amount;
        }
    });

    if (!currency || mixedCurrency) {
        return '-';
    }

    const formatted = total >= 1 ? total.toFixed(2) : total.toFixed(4);
    return `${formatted} ${currency}`;
}

function updatePendingAmountDisplay(pendingProposalIds = null) {
    const node = document.querySelector('[data-agent-pending-amount]');
    if (!node) return;

    const ids = Array.isArray(pendingProposalIds)
        ? pendingProposalIds
        : (agentDialogListData && agentDialogListData.pending && agentDialogListData.pending.data) || [];

    node.textContent = summarizePendingProposalAmounts(ids);
}

/**
 * Set up lazy loading for agent dialog lists
 */
const AGENT_DIALOG_PAGE_SIZES = {
    parcels: 50, // avoid loading hundreds of parcels at once
    created: 20,
    accepted: 20,
    pending: 20
};

// Cache and in-memory state for agent dialog lists (persists while page is open)
const agentDialogCache = (typeof window !== 'undefined' && window.agentDialogCache) || {};
const AGENT_DIALOG_CACHE_TTL_MS = 60 * 1000; // reuse data for a short period before refetching
const agentDialogFetchPromises = new Map();
const agentDialogTempOwnership = (typeof window !== 'undefined' && window.agentDialogTempOwnership) || {};
if (typeof window !== 'undefined') {
    window.agentDialogCache = agentDialogCache;
    window.agentDialogTempOwnership = agentDialogTempOwnership;
}
let agentDialogListData = null;

function getAgentDialogCache(agentId) {
    if (!agentId) return null;
    return agentDialogCache[agentId] || null;
}

function setAgentDialogCache(agentId, data) {
    if (!agentId || !data) return;
    agentDialogCache[agentId] = data;
    if (typeof window !== 'undefined') {
        window.agentDialogCache = agentDialogCache;
    }
}

function normalizeParcelEntries(entries = []) {
    return entries
        .map(entry => {
            if (!entry) return null;
            if (typeof entry === 'string') {
                return { id: entry, number: entry, proposalCount: entry.proposalCount || 0 };
            }
            const id = entry.id || entry.parcelId || entry.parcel_id;
            if (!id) return null;
            return {
                id: id,
                number: entry.number || entry.parcelNumber || id,
                proposalCount: typeof entry.proposalCount === 'number' ? entry.proposalCount : 0
            };
        })
        .filter(Boolean);
}

function ensureAgentDialogListState(agentId, parcelDetails, createdProposals, acceptedProposals, pendingProposals = []) {
    agentDialogListData = {
        parcels: { data: normalizeParcelEntries(parcelDetails), loaded: 0, pageSize: AGENT_DIALOG_PAGE_SIZES.parcels },
        created: { data: createdProposals || [], loaded: 0, pageSize: AGENT_DIALOG_PAGE_SIZES.created },
        accepted: { data: acceptedProposals || [], loaded: 0, pageSize: AGENT_DIALOG_PAGE_SIZES.accepted },
        pending: { data: pendingProposals || [], loaded: 0, pageSize: AGENT_DIALOG_PAGE_SIZES.pending }
    };
    if (typeof window !== 'undefined') {
        window.agentDialogListData = agentDialogListData;
    }
    // Persist initial snapshot for reuse on reopen
    setAgentDialogCache(agentId, {
        ...(getAgentDialogCache(agentId) || {}),
        parcels: agentDialogListData.parcels.data.slice(),
        created: agentDialogListData.created.data.slice(),
        accepted: agentDialogListData.accepted.data.slice(),
        pending: agentDialogListData.pending.data.slice(),
        lastFetchedAt: Date.now()
    });
    return agentDialogListData;
}

function mergeAgentDialogListData(listType, newItems) {
    if (!agentDialogListData || !agentDialogListData[listType]) return false;
    const info = agentDialogListData[listType];
    const existingKeys = new Set(
        info.data.map(item => (typeof item === 'string' ? item : item.id || item.parcelId || item.parcel_id || item))
    );
    const normalized =
        listType === 'parcels'
            ? normalizeParcelEntries(newItems)
            : (newItems || []).filter(Boolean);

    let added = false;
    normalized.forEach(item => {
        const key = typeof item === 'string' ? item : item.id || item.parcelId || item.parcel_id || item;
        if (!key || existingKeys.has(key)) {
            return;
        }
        existingKeys.add(key);
        info.data.push(item);
        added = true;
    });

    return added;
}

function renderFirstPageForList(listType) {
    if (!agentDialogListData || !agentDialogListData[listType]) return;
    const info = agentDialogListData[listType];
    const listContainer = document.querySelector(`[data-list-type="${listType}"]`);
    if (listContainer) {
        const loader = listContainer.querySelector('.loader-spinner');
        if (loader) {
            loader.remove();
        }
    }
    if (info.loaded === 0 && info.data.length > 0) {
        loadMoreItems(listType, info);
    }
}

function setupAgentDialogLazyLoading(agentId, parcelDetails, createdProposals, acceptedProposals, pendingProposals = []) {
    const listData = ensureAgentDialogListState(agentId, parcelDetails, createdProposals, acceptedProposals, pendingProposals);

    // Make sure section headers reflect the initial data sizes
    Object.keys(listData).forEach(listType => {
        setSectionCount(listType, listData[listType].data.length);
        renderFirstPageForList(listType);
    });
    if (listData.pending && listData.pending.data) {
        updatePendingAmountDisplay(listData.pending.data);
    }

    // Set up scroll listeners for the modal body
    const modalBody = document.querySelector('.agent-dialog-modal-body');
    if (modalBody) {
        modalBody.addEventListener('scroll', () => {
            // Check each list to see if we need to load more items
            Object.keys(listData).forEach(listType => {
                const listContainer = document.querySelector(`[data-list-type="${listType}"]`);
                if (listContainer && shouldLoadMore(modalBody, listContainer)) {
                    const listInfo = listData[listType];
                    if (listInfo.loaded < listInfo.data.length) {
                        loadMoreItems(listType, listInfo);
                    }
                }
            });
        });
    }
}

/**
 * Check if we should load more items for a list
 */
function shouldLoadMore(scrollContainer, listContainer) {
    const containerRect = scrollContainer.getBoundingClientRect();
    const listRect = listContainer.getBoundingClientRect();

    // Load more when the bottom of the list is within 200px of the visible area
    const threshold = 200;
    return (listRect.bottom - containerRect.bottom) < threshold;
}

/**
 * Load more items for a specific list
 */
function loadMoreItems(listType, listInfo) {
    const listContainer = document.querySelector(`[data-list-type="${listType}"]`);
    if (!listContainer || listInfo.data.length === 0) return;

    const startIndex = listInfo.loaded;
    const endIndex = Math.min(startIndex + listInfo.pageSize, listInfo.data.length);
    const items = listInfo.data.slice(startIndex, endIndex);

    // Render items based on list type
    let itemsHtml = '';
    items.forEach(item => {
        if (listType === 'parcels') {
            itemsHtml += renderParcelItem(item);
        } else if (listType === 'created' || listType === 'accepted') {
            itemsHtml += renderProposalItem(item);
        } else if (listType === 'pending') {
            itemsHtml += renderPendingProposalItem(item);
        }
    });

    // Append new items to the list
    listContainer.insertAdjacentHTML('beforeend', itemsHtml);

    // Update loaded count
    listInfo.loaded = endIndex;
}

/**
 * Render a parcel item
 */
function renderParcelItem(parcel) {
    const parcelLabel = translateText('agentDialog.parcelLabel', 'Parcel {{number}}', { number: parcel.number });
    const countKey = parcel.proposalCount === 1 ? 'agentDialog.proposalCount.one' : 'agentDialog.proposalCount.other';
    const countLabel = translateText(countKey, parcel.proposalCount === 1 ? '{{count}} proposal' : '{{count}} proposals', { count: parcel.proposalCount });
    const proposalBadge = parcel.proposalCount > 0
        ? `<span class="proposal-status is-minted">${countLabel}</span>`
        : '';
    return `<div class="proposal-item parcel-item" onclick="focusOnParcelFromAgent('${parcel.id}')">
        ${parcelLabel} ${proposalBadge}
    </div>`;
}

/**
 * Render a proposal item
 */
function renderProposalItem(proposalId) {
    const fallbackKey = proposalId === undefined || proposalId === null ? '' : String(proposalId);
    const proposal = typeof proposalStorage !== 'undefined'
        ? (proposalStorage.getProposal(fallbackKey)
            || (proposalStorage.findProposalByIdOrHash ? proposalStorage.findProposalByIdOrHash(fallbackKey) : null))
        : null;
    const resolvedId = proposal && (proposal.proposalId || proposal.tokenId)
        ? String(proposal.proposalId || proposal.tokenId)
        : fallbackKey;
    const mintedLabel = translateText('agentDialog.proposalStatus.minted', 'Minted');
    const localLabel = translateText('agentDialog.proposalStatus.local', 'Local');
    if (proposal) {
        const proposalColor = typeof getProposalColor === 'function' ? getProposalColor(resolvedId) : null;
        const colorStyle = proposalColor ? `style="--proposal-color: ${proposalColor}"` : '';
        const colorClass = proposalColor ? 'has-color' : '';
        const { minted, displayId, chainLabel } = getProposalDisplayMeta(proposal, resolvedId);
        const badge = minted
            ? `<span class="proposal-status is-minted">${mintedLabel}</span>`
            : `<span class="proposal-status is-local">${localLabel}</span>`;
        const displayTitle = getAgentProposalTitle(proposal, displayId || resolvedId);
        const chainBadge = chainLabel ? `<span class="proposal-chain-label">[${chainLabel}]</span>` : '';
        const typeLabel = getAgentProposalTypeLabel(proposal);
        const typeBadge = typeLabel ? `<span class="proposal-type-pill">${typeLabel}</span>` : '';
        const offerInfo = getAgentProposalOfferDisplay(proposal);
        const offerAmount = `<span class="proposal-offer-amount">${offerInfo.amountLabel}</span>`;
        const offerCurrency = offerInfo.currencyLabel ? `<span class="proposal-offer-currency">${offerInfo.currencyLabel}</span>` : '';
        return `<div class="proposal-item agent-dialog-proposal-item ${colorClass}" ${colorStyle} onclick="focusOnProposal('${resolvedId}')">
            <span class="agent-dialog-proposal-primary">${displayTitle} (${displayId})</span>
            <span class="agent-dialog-proposal-meta">
                ${typeBadge}
                ${badge}
                ${chainBadge}
                ${offerAmount}
                ${offerCurrency}
            </span>
        </div>`;
    } else {
        return `<div class="proposal-item">${fallbackKey.substring(0, 8)} (deleted)</div>`;
    }
}

/**
 * Render a pending proposal item with unseen indicator
 */
function renderPendingProposalItem(proposalId) {
    const fallbackKey = proposalId === undefined || proposalId === null ? '' : String(proposalId);
    const proposal = typeof proposalStorage !== 'undefined'
        ? (proposalStorage.getProposal(fallbackKey)
            || (proposalStorage.findProposalByIdOrHash ? proposalStorage.findProposalByIdOrHash(fallbackKey) : null))
        : null;
    const resolvedId = proposal && (proposal.proposalId || proposal.tokenId)
        ? String(proposal.proposalId || proposal.tokenId)
        : fallbackKey;
    const mintedLabel = translateText('agentDialog.proposalStatus.minted', 'Minted');
    const localLabel = translateText('agentDialog.proposalStatus.local', 'Local');
    if (proposal) {
        const proposalColor = typeof getProposalColor === 'function' ? getProposalColor(resolvedId) : null;
        const colorStyle = proposalColor ? `style="--proposal-color: ${proposalColor}"` : '';
        const colorClass = proposalColor ? 'has-color' : '';

        // Check if proposal is unseen
        const isUnseen = typeof userNotifications !== 'undefined' &&
            userNotifications.unseenProposals.has(resolvedId);
        const unseenClass = isUnseen ? 'unseen-proposal' : '';
        const unseenIndicator = isUnseen ? '<span class="unseen-indicator">●</span>' : '';

        const { minted, displayId, chainLabel } = getProposalDisplayMeta(proposal, resolvedId);
        const badge = minted
            ? `<span class="proposal-status is-minted">${mintedLabel}</span>`
            : `<span class="proposal-status is-local">${localLabel}</span>`;
        const displayTitle = getAgentProposalTitle(proposal, displayId || resolvedId);
        const chainBadge = chainLabel ? `<span class="proposal-chain-label">[${chainLabel}]</span>` : '';
        const typeLabel = getAgentProposalTypeLabel(proposal);
        const typeBadge = typeLabel ? `<span class="proposal-type-pill">${typeLabel}</span>` : '';
        const offerInfo = getAgentProposalOfferDisplay(proposal);
        const offerAmount = `<span class="proposal-offer-amount">${offerInfo.amountLabel}</span>`;
        const offerCurrency = offerInfo.currencyLabel ? `<span class="proposal-offer-currency">${offerInfo.currencyLabel}</span>` : '';

        return `<div class="proposal-item agent-dialog-proposal-item ${colorClass} ${unseenClass}" ${colorStyle} onclick="viewPendingProposal('${resolvedId}')">
            <span class="agent-dialog-proposal-primary">${unseenIndicator}${displayTitle} (${displayId})</span>
            <span class="agent-dialog-proposal-meta">
                ${typeBadge}
                ${badge}
                ${chainBadge}
                ${offerAmount}
                ${offerCurrency}
            </span>
        </div>`;
    } else {
        return `<div class="proposal-item">${fallbackKey.substring(0, 8)} (deleted)</div>`;
    }
}

/**
 * Update the pending proposals count display
 */
function updatePendingProposalsCount(count) {
    setSectionCount('pending', count);
}

/**
 * When the user accepts a proposal, sync the Agent Details lists/counts in place.
 */
function updateAgentDialogAfterAcceptance(proposalId) {
    if (!proposalId) return;

    const modal = document.querySelector('.agent-dialog-modal');
    if (!modal || !agentDialogListData) return;

    const listData = agentDialogListData;
    const hasPending = listData.pending && Array.isArray(listData.pending.data);
    const hasAccepted = listData.accepted && Array.isArray(listData.accepted.data);

    let pendingChanged = false;
    if (hasPending) {
        const before = listData.pending.data.length;
        listData.pending.data = listData.pending.data.filter(id => id !== proposalId);
        if (listData.pending.loaded > listData.pending.data.length) {
            listData.pending.loaded = listData.pending.data.length;
        }
        pendingChanged = before !== listData.pending.data.length;
    }

    let acceptedChanged = false;
    if (hasAccepted) {
        if (!listData.accepted.data.includes(proposalId)) {
            listData.accepted.data.unshift(proposalId);
            acceptedChanged = true;
        }
        // Reset paging so the rebuilt list shows the newly added item
        listData.accepted.loaded = 0;
    }

    if (pendingChanged) {
        updatePendingProposalsCount(listData.pending.data.length);
        const pendingList = modal.querySelector('[data-list-type="pending"]');
        if (pendingList) {
            pendingList.innerHTML = '';
            renderFirstPageForList('pending');
        }
    }

    if (acceptedChanged) {
        const acceptedList = modal.querySelector('[data-list-type="accepted"]');
        if (acceptedList) {
            acceptedList.innerHTML = '';
            renderFirstPageForList('accepted');
        }
        setSectionCount('accepted', listData.accepted.data.length, 'Proposals Accepted');
    }

    // Keep cache aligned so reopen preserves the updated lists
    const currentAgent = typeof getCurrentUserAgent === 'function' ? getCurrentUserAgent() : null;
    if (currentAgent && typeof setAgentDialogCache === 'function') {
        const existingCache = getAgentDialogCache(currentAgent.id) || {};
        setAgentDialogCache(currentAgent.id, {
            ...existingCache,
            accepted: hasAccepted ? listData.accepted.data.slice() : [],
            pending: hasPending ? listData.pending.data.slice() : [],
            lastFetchedAt: Date.now()
        });
    }
}

if (typeof window !== 'undefined') {
    window.updateAgentDialogAfterAcceptance = updateAgentDialogAfterAcceptance;
}

/**
 * Handle clicking on a pending proposal
 */
function viewPendingProposal(proposalId) {
    // Mark proposal as seen
    if (typeof userNotifications !== 'undefined') {
        userNotifications.markProposalAsSeen(proposalId);
    }

    // Close agent dialog
    closeAgentDialog();

    // Focus and highlight the proposal but don't show details modal
    if (typeof selectAndHighlightProposal === 'function' && typeof proposalStorage !== 'undefined') {
        const proposal = proposalStorage.getProposal(proposalId);
        const parcels = Array.isArray(proposal?.parentParcelIds)
            ? proposal.parentParcelIds
            : (Array.isArray(proposal?.childParcelIds) ? proposal.childParcelIds : []);
        if (proposal && parcels.length > 0) {
            selectAndHighlightProposal(proposalId, parcels[0], true);
        }
    }
}

/**
 * Close the agent dialog
 */
function closeAgentDialog() {
    const modal = document.querySelector('.agent-dialog-modal');
    if (modal) {
        const onClose = typeof modal.__onClose === 'function' ? modal.__onClose : null;
        if (typeof modal.__i18nCleanup === 'function') {
            try { modal.__i18nCleanup(); } catch (_) { }
        }
        document.body.removeChild(modal);
        if (onClose) {
            try {
                onClose();
            } catch (err) {
                console.warn('[AgentDialog] onClose handler failed', err);
            }
        }
    }
    // Notify listeners (e.g., to remove wallet event handlers)
    const evt = new CustomEvent('agentDialogClosed');
    document.dispatchEvent(evt);
}

/**
 * Focus map on a specific parcel
 * @param {string} parcelId - The parcel ID to focus on
 */
async function ensureParcelLoaded(parcelId) {
    const targetId = parcelId && parcelId.toString();
    if (!targetId) return false;

    const hasMultiSelection = typeof multiParcelSelection !== 'undefined' && multiParcelSelection && typeof multiParcelSelection.findParcelById === 'function';
    if (hasMultiSelection) {
        const existing = multiParcelSelection.findParcelById(targetId);
        if (existing) return true;
    }

    if (typeof resolveParcelLayerById === 'function') {
        const layer = resolveParcelLayerById(targetId);
        if (layer) return true;
    }

    if (typeof fetchSingleParcelById === 'function') {
        try {
            const layer = await fetchSingleParcelById(targetId, { forceRefresh: false });
            return !!layer;
        } catch (error) {
            console.warn('Failed to fetch parcel before focusing', targetId, error);
        }
    }
    return false;
}

async function focusOnParcel(parcelId) {
    const loaded = await ensureParcelLoaded(parcelId);
    if (!loaded) {
        console.warn('Parcel could not be loaded for focus', parcelId);
        return;
    }
    if (typeof selectParcel === 'function') {
        selectParcel(parcelId);
        closeAgentDialog();
    }
}

/**
 * Focus map on a specific proposal
 * @param {string} proposalId - The proposal id to focus on
 */
function focusOnProposal(proposalId) {
    closeAgentDialog();

    if (typeof selectAndHighlightProposal === 'function' && typeof proposalStorage !== 'undefined') {
        const proposal = proposalStorage.getProposal(proposalId);
        const parcels = Array.isArray(proposal?.parentParcelIds)
            ? proposal.parentParcelIds
            : (Array.isArray(proposal?.childParcelIds) ? proposal.childParcelIds : []);
        if (proposal && parcels.length > 0) {
            selectAndHighlightProposal(proposalId, parcels[0], true);
        }
    } else if (typeof centerOnProposal === 'function') {
        // Fallback to old function
        centerOnProposal(proposalId);
    }
}

/**
 * Get filtered game log entries for a specific agent
 * @param {string} agentId - The agent ID to filter for
 * @returns {string} HTML string of filtered log entries
 */
function getAgentLogEntries(agentId) {
    // Check if gameState and gameLog are available
    if (typeof gameState === 'undefined' || !gameState.gameLog || gameState.gameLog.length === 0) {
        return '<div class="empty-log">No log entries yet. Start the game to see this agent\'s activities.</div>';
    }

    // Get the agent name for filtering
    const agent = agentStorage.getAgent(agentId);
    if (!agent) {
        return '<div class="empty-log">Agent not found.</div>';
    }

    // Filter log entries that mention this specific agent
    // Look for entries that contain the agent's name or ID
    const agentLogEntries = gameState.gameLog.filter(entry => {
        // Handle both old string format and new object format
        const entryText = typeof entry === 'string' ? entry : entry.text;

        // Check if the entry contains the agent's name or ID
        return entryText.includes(`data-agent-id="${agentId}"`) ||
            entryText.includes(agent.name) ||
            entryText.includes(`Agent ${agentId}`);
    });

    if (agentLogEntries.length === 0) {
        return '<div class="empty-log">No activities recorded for this agent yet.</div>';
    }

    // Return the last 20 entries (most recent first)
    const recentEntries = agentLogEntries.slice(-20).reverse();

    return `
        <div class="agent-log-content">
            ${recentEntries.map(entry => {
        // Handle both old string format and new object format
        const entryText = typeof entry === 'string' ? entry : entry.text;
        const isUserAction = typeof entry === 'object' && entry.isUserAction;
        const cssClass = isUserAction ? 'agent-log-entry user-action' : 'agent-log-entry';
        return `<div class="${cssClass}">${entryText}</div>`;
    }).join('')}
            ${agentLogEntries.length > 20 ?
            `<div class="agent-log-more">... and ${agentLogEntries.length - 20} older entries</div>` :
            ''
        }
        </div>
    `;
}

/**
 * Setup click listeners for clickable links in agent log
 */
function setupAgentLogClickListeners() {
    // Handle agent links in agent log
    document.querySelectorAll('.agent-log-entry .agent-link-clickable').forEach(link => {
        link.addEventListener('click', function (e) {
            e.preventDefault();
            const agentId = this.getAttribute('data-agent-id');
            if (agentId) {
                // Close current dialog first, then open new one
                closeAgentDialog();
                setTimeout(() => showAgentDialog(agentId), 100);
            }
        });
    });

    // Handle proposal links in agent log
    document.querySelectorAll('.agent-log-entry .proposal-link-clickable').forEach(link => {
        link.addEventListener('click', function (e) {
            e.preventDefault();
            const proposalIdOrHash = this.getAttribute('data-proposal-id') || this.getAttribute('data-proposal-hash');
            if (proposalIdOrHash && typeof showProposalFromLog === 'function') {
                showProposalFromLog(proposalIdOrHash);
            }
        });
    });

    // Handle parcel links in agent log
    document.querySelectorAll('.agent-log-entry .parcel-link-clickable').forEach(link => {
        link.addEventListener('click', function (e) {
            e.preventDefault();
            const parcelId = this.getAttribute('data-parcel-id');
            if (parcelId && typeof showParcelFromLog === 'function') {
                showParcelFromLog(parcelId);
            }
        });
    });
}

/**
 * Get the number of proposals affecting a specific parcel
 * @param {string} parcelId - The parcel ID
 * @returns {number} - Number of proposals affecting this parcel
 */
function getParcelProposalCount(parcelId) {
    if (typeof proposalStorage === 'undefined') {
        return 0;
    }

    const proposals = proposalStorage.getProposalsForParcel(parcelId, { hydrateRoadAssets: false });
    return proposals.length;
}

/**
 * Get parcel details with proposal counts for an agent
 * @param {string} agentId - The agent ID
 * @returns {Array} - Array of parcel objects with proposal counts
 */
function getAgentParcelDetails(agentId) {
    const ownedParcels = getAgentOwnedParcels(agentId);

    const parcelDetails = ownedParcels.map(parcelId => {
        const proposalCount = getParcelProposalCount(parcelId);

        // Try to get parcel number from the parcel layer
        let parcelNumber = parcelId;
        const parcel = multiParcelSelection.findParcelById(parcelId);
        if (parcel && parcel.feature && parcel.feature.properties && parcel.feature.properties.BROJ_CESTICE) {
            parcelNumber = parcel.feature.properties.BROJ_CESTICE;
        }

        return {
            id: parcelId,
            number: parcelNumber,
            proposalCount: proposalCount
        };
    });

    // Sort by proposal count descending, then by parcel number ascending
    parcelDetails.sort((a, b) => {
        if (b.proposalCount !== a.proposalCount) {
            return b.proposalCount - a.proposalCount;
        }
        return a.number - b.number;
    });

    return parcelDetails;
}

/**
 * Handle clicking on a parcel in the Agent Details dialog
 * @param {string} parcelId - The parcel ID to focus on
 */
async function focusOnParcelFromAgent(parcelId) {
    // Close the agent dialog first
    // Wait to close until we've confirmed the parcel is available
    const loaded = await ensureParcelLoaded(parcelId);
    if (!loaded) {
        console.warn('Parcel not available for focusing from agent dialog', parcelId);
        return;
    }
    closeAgentDialog();

    // Exit show proposals mode to allow normal parcel selection
    const showProposalsCheckbox = document.getElementById('showProposalsCheckbox');
    if (showProposalsCheckbox && showProposalsCheckbox.checked) {
        showProposalsCheckbox.checked = false;
        // Trigger the change event to update the proposal layer
        if (typeof updateProposalLayer === 'function') {
            updateProposalLayer();
        }
    }

    // Always call selectParcel with a small delay to ensure any cleanup is complete
    setTimeout(() => {
        if (typeof selectParcel === 'function') {
            selectParcel(parcelId);

            // Force re-apply selection style in case it was cleared by proposal layer updates
            setTimeout(() => {
                const selectedLayer = typeof parcelLayer !== 'undefined' && parcelLayer ?
                    parcelLayer.getLayers().find(layer => {
                        if (!layer?.feature) return false;
                        const candidateId = (typeof ensureParcelId === 'function') ? ensureParcelId(layer.feature) : (layer.feature.properties?.parcelId || layer.feature.properties?.parcel_id || layer.feature.properties?.id);
                        return candidateId && candidateId.toString() === parcelId.toString();
                    }) : null;

                if (selectedLayer && typeof selectedParcelStyle !== 'undefined') {
                    selectedLayer.setStyle(selectedParcelStyle);
                    selectedLayer.bringToFront();
                }
            }, 10);
        }
    }, 100);
}

function initialiseAgentStorage() {
    agentStorage.load();
}

if (typeof PersistentStorage !== 'undefined' && PersistentStorage.ensureReady) {
    PersistentStorage.ensureReady(initialiseAgentStorage);
} else {
    initialiseAgentStorage();
}

// Make functions available globally
window.agentStorage = agentStorage;
window.createAgent = createAgent;
window.generateAgentName = generateAgentName;
window.getAvatarImagePath = getAvatarImagePath;
window.getAgentOwnedParcels = getAgentOwnedParcels;
window.buildAgentOwnedParcelIndex = buildAgentOwnedParcelIndex;
window.updateAgentOwnedParcels = updateAgentOwnedParcels;
window.transferParcelOwnership = transferParcelOwnership;
window.agentDecideAction = agentDecideAction;
window.executeAgentAction = executeAgentAction;
window.showAgentDialog = showAgentDialog;
window.closeAgentDialog = closeAgentDialog;
window.focusOnParcel = focusOnParcel;
window.focusOnProposal = focusOnProposal;
window.getAgentLogEntries = getAgentLogEntries;
window.setupAgentLogClickListeners = setupAgentLogClickListeners;
window.getParcelProposalCount = getParcelProposalCount;
window.getAgentParcelDetails = getAgentParcelDetails;
window.focusOnParcelFromAgent = focusOnParcelFromAgent;
window.agentParcelsShareBoundary = agentParcelsShareBoundary;
window.findContiguousParcels = findContiguousParcels;
window.buildTurnParcelPool = buildTurnParcelPool;
window.isRoadLikeParcel = isRoadLikeParcel;
window.getUserPendingProposals = getUserPendingProposals;
window.viewPendingProposal = viewPendingProposal; 
