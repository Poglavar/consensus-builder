/*
    Agent system for the consensus builder application.
    This file contains functionality for creating, managing, and controlling AI agents
    that can interact with the parcel system and make proposals.
*/

// Agent storage and management
const agentStorage = {
    agents: new Map(), // Key: agentId, Value: agent object

    // Save agents to localStorage
    save() {
        const data = Array.from(this.agents.entries()).map(([id, agent]) => ({
            id,
            ...agent
        }));
        localStorage.setItem('consensus_agents', JSON.stringify(data));
    },

    // Load agents from localStorage
    load() {
        const data = localStorage.getItem('consensus_agents');
        if (data) {
            this.agents.clear();
            JSON.parse(data).forEach(agent => {
                // Ensure id property is present on the agent object
                this.agents.set(agent.id, agent);
            });
        }
    },

    // Add a new agent
    addAgent(agent) {
        this.agents.set(agent.id, agent);
        this.save();
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
            this.save();
        }
    },

    // Delete agent
    deleteAgent(agentId) {
        this.agents.delete(agentId);
        this.save();
    },

    // Clear all agents
    clear() {
        this.agents.clear();
        localStorage.removeItem('consensus_agents');
    }
};

// Maximum number of avatars/agents
const MAX_AGENTS = 16;

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
        avatarIndex: avatarIndex, // 0-15
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
 */
function createUserAgent(name, avatarIndex) {
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
        userControlled: true // Controlled by user
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
    return `avatars/avatar${avatarIndex + 1}.png`;
}

/**
 * Get parcels owned by an agent
 * @param {string} agentId - The agent ID
 * @returns {Array} - Array of parcel IDs owned by the agent
 */
function getAgentOwnedParcels(agentId) {
    const parcels = [];

    // Check localStorage for parcel ownership
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key.startsWith('parcel_') && key.endsWith('_owner')) {
            const ownerId = localStorage.getItem(key);
            if (ownerId === agentId) {
                const parcelId = key.replace('parcel_', '').replace('_owner', '');
                parcels.push(parcelId);
            }
        }
    }

    return parcels;
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
    // Update localStorage
    localStorage.setItem(`parcel_${parcelId}_owner`, toAgentId);

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
 * 1. Explicit flag via localStorage or feature.properties.isRoad
 * 2. Heuristic: bounding-box-area / parcel-area ratio
 */
function isRoadLikeParcel(layer) {
    if (!layer || !layer.feature) return false;

    const parcelId = layer.feature.properties?.CESTICA_ID;

    // Explicit road flag (drawn or pre-existing)
    const explicitRoad = localStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true' ||
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

/**
 * Agent decision-making: decide what action to take
 * @param {Object} agent - The agent object
 * @returns {Object} - Action object with type and details
 */
function agentDecideAction(agent) {
    const actions = ['nothing', 'accept', 'create', 'donate'];
    const actionType = actions[Math.floor(Math.random() * actions.length)];

    const ownedParcels = getAgentOwnedParcels(agent.id);

    switch (actionType) {
        case 'nothing':
            return { type: 'nothing' };

        case 'accept':
            // Find proposals that affect agent's parcels and aren't already accepted
            const acceptableProposals = [];
            if (typeof proposalStorage !== 'undefined') {
                const allProposals = proposalStorage.getAllProposals();
                for (const proposal of allProposals) {
                    if (proposal.status !== 'Executed') {
                        for (const parcelId of proposal.parcelIds) {
                            if (ownedParcels.includes(parcelId.toString()) &&
                                !proposal.acceptedParcelIds.includes(parcelId.toString())) {
                                acceptableProposals.push({ proposal, parcelId });
                            }
                        }
                    }
                }
            }

            if (acceptableProposals.length > 0) {
                const randomChoice = acceptableProposals[Math.floor(Math.random() * acceptableProposals.length)];
                return {
                    type: 'accept',
                    proposalHash: randomChoice.proposal.proposalHash,
                    parcelId: randomChoice.parcelId
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

            const allParcels = [];
            parcelLayer.eachLayer(layer => {
                if (layer && layer.feature && layer.feature.properties && layer.feature.properties.CESTICA_ID) {
                    const parcelId = layer.feature.properties.CESTICA_ID.toString();

                    // Exclude explicit or heuristic road-like parcels
                    if (isRoadLikeParcel(layer)) return;

                    // Exclude overly large parcels (> 15,000 m²) for AI agents
                    const area = layer.feature.properties.calculatedArea || 0;
                    if (area > 15000) return;

                    allParcels.push({
                        id: parcelId,
                        layer: layer,
                        isOwned: ownedParcels.includes(parcelId)
                    });
                }
            });

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

            const proposalTypes = ['Road', 'Park', 'Square', 'Residences', 'Commercial', 'Mixed'];
            const randomType = proposalTypes[Math.floor(Math.random() * proposalTypes.length)];

            const maxBudget = Math.floor(agent.ethBalance * 0.05 * 100) / 100; // Max 5% of ETH, rounded to 2 decimals
            const budget = Math.max(0.01, Math.random() * maxBudget);

            return {
                type: 'create',
                parcelIds: proposalParcels.map(p => p.id),
                proposalType: randomType,
                title: randomType,
                description: `${randomType} development proposed by ${agent.name}`,
                budget: Math.round(budget * 100) / 100 // Round to 2 decimal places
            };

        case 'donate':
            // Find other agents' proposals to donate to
            const donatableProposals = [];
            if (typeof proposalStorage !== 'undefined') {
                const allProposals = proposalStorage.getAllProposals();
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

                return {
                    type: 'donate',
                    proposalHash: randomProposal.proposalHash,
                    amount: Math.round(donation * 100) / 100
                };
            }
            return { type: 'nothing' };

        default:
            return { type: 'nothing' };
    }
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
                const result = acceptProposal(action.proposalHash, action.parcelId);
                if (result === 'All accepted') {
                    agent.proposalsExecuted.push(action.proposalHash);
                    agentStorage.updateAgent(agent.id, { proposalsExecuted: agent.proposalsExecuted });
                    showEphemeralMessage(`Proposal ${action.proposalHash.substring(0, 8)} executed! 🎉`);
                }
                // Update agent's accepted proposals list
                if (!agent.proposalsAccepted.includes(action.proposalHash)) {
                    agent.proposalsAccepted.push(action.proposalHash);
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
                    const proposalPosition = window.agentBubbleManager.getProposalPosition(action.proposalHash);
                    if (proposalPosition) {
                        window.agentBubbleManager.addBubble({
                            agentId: agent.id,
                            agentName: agent.name,
                            avatarIndex: agent.avatarIndex,
                            objectType: 'proposal',
                            objectId: action.proposalHash,
                            objectPosition: proposalPosition,
                            action: `accepted proposal ${action.proposalHash.substring(0, 6)}`
                        });
                    }
                }

                return `<a href="#" data-agent-id="${agent.id}" class="agent-link agent-link-clickable">${agent.name}</a> accepted proposal <a href="#" data-proposal-hash="${action.proposalHash.substring(0, 8)}" class="proposal-link proposal-link-clickable">${action.proposalHash.substring(0, 8)}</a> for parcel <a href="#" data-parcel-id="${action.parcelId}" class="parcel-link parcel-link-clickable">${parcelNumber}</a>.`;
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
                    type: 'parcel',
                    acceptedParcelIds: [],
                    bounds: bounds, // Store bounds for reliable positioning
                    createdAt: new Date().toISOString() // Add creation timestamp
                };

                const proposalHash = proposalStorage.addProposal(proposal);
                if (proposalHash === null) {
                    // console.log('Attempt failed:This exact proposal already exists');
                    return `<a href="#" data-agent-id="${agent.id}" class="agent-link agent-link-clickable">${agent.name}</a>`
                        + ` failed to create a proposal because it already exists.`;
                }

                // Update agent's created proposals list
                if (!agent.proposalsCreated.includes(proposalHash)) {
                    agent.proposalsCreated.push(proposalHash);
                    agentStorage.updateAgent(agent.id, { proposalsCreated: agent.proposalsCreated });
                }

                // Deduct budget from agent's balance
                agent.ethBalance -= action.budget;
                agentStorage.updateAgent(agent.id, { ethBalance: agent.ethBalance });

                // Show agent bubble for this interaction
                if (typeof window.agentBubbleManager !== 'undefined') {
                    const proposalPosition = window.agentBubbleManager.getProposalPosition(proposalHash);
                    if (proposalPosition) {
                        window.agentBubbleManager.addBubble({
                            agentId: agent.id,
                            agentName: agent.name,
                            avatarIndex: agent.avatarIndex,
                            objectType: 'proposal',
                            objectId: proposalHash,
                            objectPosition: proposalPosition,
                            action: `created ${action.proposalType} proposal`
                        });
                    }
                }

                return `<a href="#" data-agent-id="${agent.id}" class="agent-link agent-link-clickable">${agent.name}</a> created a ${action.proposalType} proposal (<a href="#" data-proposal-hash="${proposalHash.substring(0, 8)}" class="proposal-link proposal-link-clickable">${proposalHash.substring(0, 8)}</a>) for ${action.parcelIds.length} parcel(s) with budget ${action.budget} ETH.`;
            }
            return `<a href="#" data-agent-id="${agent.id}" class="agent-link agent-link-clickable">${agent.name}</a> tried to create a proposal but failed.`;

        case 'donate':
            // For now, just add to the proposal's budget and deduct from agent
            if (typeof proposalStorage !== 'undefined') {
                const proposal = proposalStorage.getProposal(action.proposalHash);
                if (proposal && agent.ethBalance >= action.amount) {
                    proposal.budget = (proposal.budget || proposal.offer || 0) + action.amount;
                    proposal.offer = proposal.budget; // Keep offer in sync with budget
                    proposalStorage.proposals.set(action.proposalHash, proposal);
                    proposalStorage.save();

                    agent.ethBalance -= action.amount;
                    agentStorage.updateAgent(agent.id, { ethBalance: agent.ethBalance });

                    // Show agent bubble for this interaction
                    if (typeof window.agentBubbleManager !== 'undefined') {
                        const proposalPosition = window.agentBubbleManager.getProposalPosition(action.proposalHash);
                        if (proposalPosition) {
                            window.agentBubbleManager.addBubble({
                                agentId: agent.id,
                                agentName: agent.name,
                                avatarIndex: agent.avatarIndex,
                                objectType: 'proposal',
                                objectId: action.proposalHash,
                                objectPosition: proposalPosition,
                                action: `donated ${action.amount} ETH to proposal`
                            });
                        }
                    }

                    return `<a href="#" data-agent-id="${agent.id}" class="agent-link agent-link-clickable">${agent.name}</a> donated ${action.amount} ETH to proposal <a href="#" data-proposal-hash="${action.proposalHash.substring(0, 8)}" class="proposal-link proposal-link-clickable">${action.proposalHash.substring(0, 8)}</a>.`;
                }
            }
            return `<a href="#" data-agent-id="${agent.id}" class="agent-link agent-link-clickable">${agent.name}</a> tried to donate to a proposal but failed.`;

        default:
            return `<a href="#" data-agent-id="${agent.id}" class="agent-link agent-link-clickable">${agent.name}</a> performed an unknown action.`;
    }
}

/**
 * Show the agent dialog with detailed information
 * @param {string} agentId - The agent ID
 */
function showAgentDialog(agentId) {
    const agent = agentStorage.getAgent(agentId);
    if (!agent) {
        alert('Agent not found.');
        return;
    }

    // Check if this is the current user's agent
    const isUserAgent = agent.userControlled === true;

    const ownedParcels = getAgentOwnedParcels(agentId);
    const parcelDetails = getAgentParcelDetails(agentId);
    const portfolioValue = typeof calculatePortfolioValue === 'function' ? calculatePortfolioValue(ownedParcels) : 0;
    const createdProposals = agent.proposalsCreated || [];
    const acceptedProposals = agent.proposalsAccepted || [];
    const executedProposals = agent.proposalsExecuted || [];
    const modal = document.createElement('div');
    modal.className = 'agent-dialog-modal';
    modal.innerHTML = `
        <div class="agent-dialog-modal-content">
            <div class="agent-dialog-modal-header">
                <div class="agent-header-info">
                    <img src="${getAvatarImagePath(agent.avatarIndex)}" class="agent-avatar-large" style="width: 60px; height: 60px; border-radius: 50%; border: 3px solid #007bff; margin-right: 15px; object-fit: cover;" alt="Agent Avatar">
                    <div class="agent-details">
                        <h2>${agent.name}${isUserAgent ? ' <span class="user-label">(You)</span>' : ''}</h2>
                        ${isUserAgent ? '<div class="agent-header-user-info"><button class="logout-button" onclick="showLogoutModal()">Log Out</button></div>' : ''}
                    </div>
                </div>
                <button class="agent-dialog-modal-close" onclick="closeAgentDialog()">&times;</button>
            </div>
            <div class="agent-dialog-modal-body">
                <div class="agent-stats-grid">
                    <div class="stat-item">
                        <div class="stat-label">ETH Balance</div>
                        <div class="stat-value">${agent.ethBalance.toFixed(2)} ETH</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-label">Portfolio Value</div>
                        <div class="stat-value">${portfolioValue.toFixed(2)} ETH</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-label">Total Wealth</div>
                        <div class="stat-value">${(agent.ethBalance + portfolioValue).toFixed(2)} ETH</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-label">Parcels Owned</div>
                        <div class="stat-value">${ownedParcels.length}</div>
                    </div>
                </div>
                ${agent.walletAddresses && agent.walletAddresses.length > 0 ? `
                    <div class="info-section">
                        <h4>Wallet Addresses</h4>
                        <div class="wallet-list">
                            ${agent.walletAddresses.map(addr => `<div class="wallet-address">${addr}</div>`).join('')}
                        </div>
                    </div>
                ` : ''}
                <div class="info-section">
                    <h4>Owned Parcels (${ownedParcels.length})</h4>
                    <div class="parcels-list" data-list-type="parcels">
                        ${parcelDetails.length === 0 ? '<div class="empty-list">No parcels owned</div>' : ''}
                    </div>
                </div>
                <div class="info-section">
                    <h4>Proposals Created (${createdProposals.length})</h4>
                    <div class="proposals-list" data-list-type="created">
                        ${createdProposals.length === 0 ? '<div class="empty-list">No proposals created</div>' : ''}
                    </div>
                </div>
                <div class="info-section">
                    <h4>Proposals Accepted (${acceptedProposals.length})</h4>
                    <div class="proposals-list" data-list-type="accepted">
                        ${acceptedProposals.length === 0 ? '<div class="empty-list">No proposals accepted</div>' : ''}
                    </div>
                </div>
                <div class="info-section">
                    <h4>Agent Log</h4>
                    <div class="agent-log-container">
                        ${getAgentLogEntries(agent.id)}
                    </div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    // Set up lazy loading for lists
    setupAgentDialogLazyLoading(agentId, parcelDetails, createdProposals, acceptedProposals);

    // Set up click listeners for agent log links (similar to game log)
    setupAgentLogClickListeners();
}

/**
 * Set up lazy loading for agent dialog lists
 */
function setupAgentDialogLazyLoading(agentId, parcelDetails, createdProposals, acceptedProposals) {
    // Store data and current positions for each list
    const listData = {
        parcels: { data: parcelDetails, loaded: 0, pageSize: 20 },
        created: { data: createdProposals, loaded: 0, pageSize: 20 },
        accepted: { data: acceptedProposals, loaded: 0, pageSize: 20 }
    };

    // Load initial items for each list
    Object.keys(listData).forEach(listType => {
        loadMoreItems(listType, listData[listType]);
    });

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

    // Clear empty list message if present
    const emptyList = listContainer.querySelector('.empty-list');
    if (emptyList) return; // Don't load if list is actually empty

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
    return `<div class="parcel-item" onclick="focusOnParcelFromAgent('${parcel.id}')">
        Parcel ${parcel.number}${parcel.proposalCount > 0 ? ` <span class="parcel-proposal-count">(${parcel.proposalCount} proposal${parcel.proposalCount > 1 ? 's' : ''})</span>` : ''}
    </div>`;
}

/**
 * Render a proposal item
 */
function renderProposalItem(proposalHash) {
    const proposal = typeof proposalStorage !== 'undefined' ? proposalStorage.getProposal(proposalHash) : null;
    if (proposal) {
        const proposalColor = typeof getProposalColor === 'function' ? getProposalColor(proposalHash) : null;
        const colorStyle = proposalColor ? `style="--proposal-color: ${proposalColor}"` : '';
        const colorClass = proposalColor ? 'has-color' : '';
        return `<div class="proposal-item ${colorClass}" ${colorStyle} onclick="focusOnProposal('${proposalHash}')">${proposal.title} (${proposalHash.substring(0, 8)})</div>`;
    } else {
        return `<div class="proposal-item">${proposalHash.substring(0, 8)} (deleted)</div>`;
    }
}

/**
 * Close the agent dialog
 */
function closeAgentDialog() {
    const modal = document.querySelector('.agent-dialog-modal');
    if (modal) {
        document.body.removeChild(modal);
    }
}

/**
 * Focus map on a specific parcel
 * @param {string} parcelId - The parcel ID to focus on
 */
function focusOnParcel(parcelId) {
    if (typeof selectParcel === 'function') {
        selectParcel(parcelId);
        closeAgentDialog();
    }
}

/**
 * Focus map on a specific proposal
 * @param {string} proposalHash - The proposal hash to focus on
 */
function focusOnProposal(proposalHash) {
    closeAgentDialog();

    if (typeof selectAndHighlightProposal === 'function' && typeof proposalStorage !== 'undefined') {
        const proposal = proposalStorage.getProposal(proposalHash);
        if (proposal && proposal.parcelIds && proposal.parcelIds.length > 0) {
            selectAndHighlightProposal(proposalHash, proposal.parcelIds[0], true);
        }
    } else if (typeof centerOnProposal === 'function') {
        // Fallback to old function
        centerOnProposal(proposalHash);
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
            const proposalHash = this.getAttribute('data-proposal-hash');
            if (proposalHash && typeof showProposalFromLog === 'function') {
                showProposalFromLog(proposalHash);
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

    const proposals = proposalStorage.getProposalsForParcel(parcelId);
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
function focusOnParcelFromAgent(parcelId) {
    // Close the agent dialog first
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
                        return layer.feature && layer.feature.properties &&
                            layer.feature.properties.CESTICA_ID.toString() === parcelId.toString();
                    }) : null;

                if (selectedLayer && typeof selectedParcelStyle !== 'undefined') {
                    selectedLayer.setStyle(selectedParcelStyle);
                    selectedLayer.bringToFront();
                }
            }, 10);
        }
    }, 100);
}

// Load agents from localStorage on script load
agentStorage.load();

// Make functions available globally
window.agentStorage = agentStorage;
window.createAgent = createAgent;
window.generateAgentName = generateAgentName;
window.getAvatarImagePath = getAvatarImagePath;
window.getAgentOwnedParcels = getAgentOwnedParcels;
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
window.isRoadLikeParcel = isRoadLikeParcel; 