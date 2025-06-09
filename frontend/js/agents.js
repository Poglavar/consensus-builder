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
        lastActionAt: null
    };
    return agent;
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
            // Create a proposal for 1-10 adjacent parcels starting with a random owned parcel
            if (ownedParcels.length === 0) {
                return { type: 'nothing' };
            }

            const startParcel = ownedParcels[Math.floor(Math.random() * ownedParcels.length)];
            const parcelCount = Math.floor(Math.random() * 10) + 1; // 1-10 parcels

            // For now, just use the starting parcel (adjacency detection is complex)
            const proposalParcels = [startParcel];

            const proposalTypes = ['Road', 'Park', 'Square', 'Residences', 'Commercial', 'Mixed'];
            const randomType = proposalTypes[Math.floor(Math.random() * proposalTypes.length)];

            const maxBudget = Math.floor(agent.ethBalance * 0.05 * 100) / 100; // Max 5% of ETH, rounded to 2 decimals
            const budget = Math.max(0.01, Math.random() * maxBudget);

            return {
                type: 'create',
                parcelIds: proposalParcels,
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
                acceptProposal(action.proposalHash, action.parcelId);
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
                return `<a href="#" data-agent-id="${agent.id}" class="agent-link agent-link-clickable">${agent.name}</a> accepted proposal <a href="#" data-proposal-hash="${action.proposalHash.substring(0, 8)}" class="proposal-link proposal-link-clickable">${action.proposalHash.substring(0, 8)}</a> for parcel <a href="#" data-parcel-id="${action.parcelId}" class="parcel-link parcel-link-clickable">${parcelNumber}</a>.`;
            }
            return `<a href="#" data-agent-id="${agent.id}" class="agent-link agent-link-clickable">${agent.name}</a> tried to accept a proposal but failed.`;

        case 'create':
            if (typeof proposalStorage !== 'undefined') {
                const proposal = {
                    author: agent.name,
                    title: action.title,
                    description: action.description,
                    offer: action.budget, // This is the budget that will be paid out
                    budget: action.budget, // Add budget field as specified
                    parcelIds: action.parcelIds,
                    type: 'parcel',
                    acceptedParcelIds: []
                };

                const proposalHash = proposalStorage.addProposal(proposal);

                // Update agent's created proposals list
                if (!agent.proposalsCreated.includes(proposalHash)) {
                    agent.proposalsCreated.push(proposalHash);
                    agentStorage.updateAgent(agent.id, { proposalsCreated: agent.proposalsCreated });
                }

                // Deduct budget from agent's balance
                agent.ethBalance -= action.budget;
                agentStorage.updateAgent(agent.id, { ethBalance: agent.ethBalance });

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
    const ownedParcels = getAgentOwnedParcels(agentId);
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
                        <h2>${agent.name}</h2>
                        <div class="agent-id">ID: ${agent.id}</div>
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
                    <div class="parcels-list">
                        ${ownedParcels.length === 0 ?
            '<div class="empty-list">No parcels owned</div>' :
            ownedParcels.slice(0, 10).map(parcelId =>
                `<div class="parcel-item" onclick="focusOnParcel('${parcelId}')">Parcel ${parcelId}</div>`
            ).join('') +
            (ownedParcels.length > 10 ? `<div class="more-items">... and ${ownedParcels.length - 10} more</div>` : '')
        }
                    </div>
                </div>
                <div class="info-section">
                    <h4>Proposals Created (${createdProposals.length})</h4>
                    <div class="proposals-list">
                        ${createdProposals.length === 0 ?
            '<div class="empty-list">No proposals created</div>' :
            createdProposals.slice(0, 5).map(proposalHash => {
                const proposal = typeof proposalStorage !== 'undefined' ? proposalStorage.getProposal(proposalHash) : null;
                return proposal ?
                    `<div class="proposal-item" onclick="focusOnProposal('${proposalHash}')">${proposal.title} (${proposalHash.substring(0, 8)})</div>` :
                    `<div class="proposal-item">${proposalHash.substring(0, 8)} (deleted)</div>`;
            }).join('') +
            (createdProposals.length > 5 ? `<div class="more-items">... and ${createdProposals.length - 5} more</div>` : '')
        }
                    </div>
                </div>
                <div class="info-section">
                    <h4>Proposals Accepted (${acceptedProposals.length})</h4>
                    <div class="proposals-list">
                        ${acceptedProposals.length === 0 ?
            '<div class="empty-list">No proposals accepted</div>' :
            acceptedProposals.slice(0, 5).map(proposalHash => {
                const proposal = typeof proposalStorage !== 'undefined' ? proposalStorage.getProposal(proposalHash) : null;
                return proposal ?
                    `<div class="proposal-item" onclick="focusOnProposal('${proposalHash}')">${proposal.title} (${proposalHash.substring(0, 8)})</div>` :
                    `<div class="proposal-item">${proposalHash.substring(0, 8)} (deleted)</div>`;
            }).join('') +
            (acceptedProposals.length > 5 ? `<div class="more-items">... and ${acceptedProposals.length - 5} more</div>` : '')
        }
                    </div>
                </div>
            </div>
            <div class="agent-dialog-modal-footer">
                <button class="btn btn-secondary" onclick="closeAgentDialog()">Close</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
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
    if (typeof showParcelInfo === 'function') {
        showParcelInfo(parcelId);
        closeAgentDialog();
    }
}

/**
 * Focus map on a specific proposal
 * @param {string} proposalHash - The proposal hash to focus on
 */
function focusOnProposal(proposalHash) {
    if (typeof centerOnProposal === 'function') {
        centerOnProposal(proposalHash);
        closeAgentDialog();
    }
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