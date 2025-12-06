/*
    Game logic and state management for the consensus builder application.
    This file contains the main game loop, state management, and coordination
    between agents, proposals, and the world state.
*/

// Game state management
const gameState = {
    isInitialized: false,
    isRunning: false,
    currentDateTime: new Date('2024-01-01T00:00:00Z'), // Start date for the game world
    currentTurn: 0,
    gameLog: [],
    gameLoopInterval: null,
    progressUpdateInterval: null,
    turnIntervalSeconds: 10, // Default 10 seconds between turns
    turnStartTime: null,

    // Save game state to PersistentStorage
    save() {
        const data = {
            isInitialized: this.isInitialized,
            isRunning: this.isRunning,
            currentDateTime: this.currentDateTime.toISOString(),
            currentTurn: this.currentTurn,
            gameLog: this.gameLog.slice(-500), // Keep only last 500 entries
            turnIntervalSeconds: this.turnIntervalSeconds
        };
        PersistentStorage.setItem('consensus_game_state', JSON.stringify(data));
    },

    // Load game state from PersistentStorage
    load() {
        const data = PersistentStorage.getItem('consensus_game_state');
        if (data) {
            const parsed = JSON.parse(data);
            this.isInitialized = parsed.isInitialized || false;
            this.isRunning = false; // Never auto-start the game loop
            this.currentDateTime = new Date(parsed.currentDateTime || '2024-01-01T00:00:00Z');
            this.currentTurn = parsed.currentTurn || 0;
            this.gameLog = parsed.gameLog || [];
            this.turnIntervalSeconds = parsed.turnIntervalSeconds || 30;
        }
        // Update UI after loading
        if (this.updateGameUI) {
            this.updateGameUI();
        }
        // Update agents button after loading
        if (typeof updateAgentsButton === 'function') {
            updateAgentsButton();
        }
    },

    // Add entry to game log
    addLogEntry(message, isUserAction = false) {
        const timestamp = this.currentDateTime.toISOString().slice(0, 19).replace('T', ' ');
        const logEntry = `[Turn ${this.currentTurn}] [${timestamp}] ${message}`;
        const logEntryObj = {
            text: logEntry,
            isUserAction: isUserAction
        };
        this.gameLog.push(logEntryObj);

        // Keep only last 500 entries
        if (this.gameLog.length > 500) {
            this.gameLog = this.gameLog.slice(-500);
        }

        this.save();
        this.updateGameUI();
        // console.log('Game Log:', logEntry);
    },

    // Clear all game data
    reset(autoReinit = false) {
        this.isInitialized = false;
        this.isRunning = false;
        this.currentDateTime = new Date('2024-01-01T00:00:00Z');
        this.currentTurn = 0;
        this.gameLog = [];

        if (this.gameLoopInterval) {
            clearInterval(this.gameLoopInterval);
            this.gameLoopInterval = null;
        }

        if (this.progressUpdateInterval) {
            clearInterval(this.progressUpdateInterval);
            this.progressUpdateInterval = null;
        }

        // Clear agents (including user agent)
        if (typeof agentStorage !== 'undefined') {
            agentStorage.clear();
        }

        // Clear user session if exists
        if (typeof getCurrentUserAgent === 'function') {
            const userAgent = getCurrentUserAgent();
            if (userAgent) {
                // Clear user management state
                if (typeof currentUserAgent !== 'undefined') {
                    currentUserAgent = null;
                }
                if (typeof currentUsername !== 'undefined') {
                    currentUsername = null;
                }
            }
        }

        // Clear parcel ownership
        const keysToDelete = [];
        for (let i = 0; i < PersistentStorage.length; i++) {
            const key = PersistentStorage.key(i);
            if (key.startsWith('parcel_') && key.endsWith('_owner')) {
                keysToDelete.push(key);
            }
        }
        keysToDelete.forEach(key => PersistentStorage.removeItem(key));

        // Clear game state from storage
        PersistentStorage.removeItem('consensus_game_state');

        this.addLogEntry('Game state has been reset.');
        this.updateGameUI();
        updateAgentsButton();

        // Automatically re-initialise the game state if requested
        if (autoReinit) {
            // Give the reset a moment to fully clear any async UI/state before re-initialising
            setTimeout(() => {
                if (typeof initializeGame === 'function') {
                    initializeGame();
                }
            }, 100);
        }
    }
};

/**
 * Initialize the game state by creating agents and assigning parcel ownership
 */
function initializeGame() {
    if (gameState.isInitialized) {
        console.log('Game already initialized');
        updateStatus('Game already initialized');
        return;
    }

    updateStatus('Initializing game state...');
    gameState.addLogEntry('Initializing game...');

    // Get existing user agent or create 10 AI agents
    const agents = [];

    // Check if there's a user agent and include it
    const userAgent = getCurrentUserAgent();
    if (userAgent) {
        agents.push(userAgent);
        gameState.addLogEntry(`User agent joined: <a href="#" data-agent-id="${userAgent.id}" class="agent-link agent-link-clickable">${userAgent.name}</a>`);
    }

    // Create AI agents to total 10 agents (including user if present)
    const aiAgentsToCreate = 10 - agents.length;
    for (let i = 0; i < aiAgentsToCreate; i++) {
        const agent = createAgent();
        agentStorage.addAgent(agent);
        agents.push(agent);
        gameState.addLogEntry(`Created agent: <a href="#" data-agent-id="${agent.id}" class="agent-link agent-link-clickable">${agent.name}</a>`);
    }

    // Assign each parcel a random owner
    let assignedParcels = 0;
    if (typeof parcelLayer !== 'undefined' && parcelLayer) {
        parcelLayer.eachLayer(layer => {
            if (layer.feature && layer.feature.properties && layer.feature.properties.CESTICA_ID) {
                const parcelId = layer.feature.properties.CESTICA_ID.toString();
                const randomAgent = agents[Math.floor(Math.random() * agents.length)];

                PersistentStorage.setItem(`parcel_${parcelId}_owner`, randomAgent.id);
                assignedParcels++;
            }
        });
    }

    // Update all agents' owned parcels lists
    agents.forEach(agent => {
        updateAgentOwnedParcels(agent.id);
    });

    gameState.isInitialized = true;
    gameState.save();
    gameState.addLogEntry(`Game initialized with ${agents.length} agents and ${assignedParcels} parcels assigned.`);
    gameState.updateGameUI();
    updateAgentsButton();

    updateStatus(`Game initialized: ${agents.length} agents created, ${assignedParcels} parcels assigned`);
    console.log(`Game initialized: ${agents.length} agents created, ${assignedParcels} parcels assigned`);
}

/**
 * Start the game loop
 */
function startGameLoop() {
    if (!gameState.isInitialized) {
        alert('Please initialize the game state first.');
        return;
    }
    if (gameState.isRunning) {
        console.log('Game loop already running');
        return;
    }
    gameState.isRunning = true;
    gameState.turnStartTime = Date.now();
    gameState.addLogEntry('Game started.');

    // Set up interval based on slider value
    const intervalMs = gameState.turnIntervalSeconds * 1000;

    // Skip if interval is 0 (effectively paused)
    if (intervalMs > 0) {
        gameState.gameLoopInterval = setInterval(() => {
            executeGameTurn();
        }, intervalMs);

        // Set up progress bar update interval (update every 100ms)
        gameState.progressUpdateInterval = setInterval(() => {
            updateProgressBar();
        }, 100);
    }

    // Update game section title
    updateGameSectionTitle();

    gameState.updateGameUI();
    console.log(`Game loop started - agents will act every ${gameState.turnIntervalSeconds} seconds`);
}

/**
 * Stop the game loop
 */
function stopGameLoop() {
    if (!gameState.isRunning) {
        console.log('Game loop not running');
        return;
    }

    gameState.isRunning = false;
    gameState.addLogEntry('Game paused.');

    if (gameState.gameLoopInterval) {
        clearInterval(gameState.gameLoopInterval);
        gameState.gameLoopInterval = null;
    }

    if (gameState.progressUpdateInterval) {
        clearInterval(gameState.progressUpdateInterval);
        gameState.progressUpdateInterval = null;
    }

    // Reset progress bar
    updateProgressBar(0);

    // Update game section title if section is collapsed
    updateGameSectionTitle();

    gameState.updateGameUI();
    console.log('Game loop stopped');
}

/**
 * Execute one game turn - have all agents decide and act
 */
function executeGameTurn() {
    gameState.currentTurn++;
    gameState.currentDateTime = new Date(gameState.currentDateTime.getTime() + (7 * 24 * 60 * 60 * 1000)); // Add 1 week
    gameState.turnStartTime = Date.now(); // Reset turn timer

    gameState.addLogEntry(`=== Turn ${gameState.currentTurn} begins ===`);

    // Clear any existing agent bubbles at the start of a new turn
    if (typeof window.agentBubbleManager !== 'undefined' && window.agentBubbleManager.onGameStateUpdate) {
        window.agentBubbleManager.onGameStateUpdate();
    }

    const agents = agentStorage.getAllAgents();
    const actionResults = [];

    // Have each AI-controlled agent decide and act
    agents.forEach(agent => {
        // Skip agents that are not AI controlled
        if (!agent.aiControlled) {
            return;
        }

        const action = agentDecideAction(agent);
        const result = executeAgentAction(agent, action);
        actionResults.push(result);
        gameState.addLogEntry(result);

        // Update agent's last action timestamp
        agentStorage.updateAgent(agent.id, { lastActionAt: new Date().toISOString() });
    });

    // Update proposal layer if visible, but preserve active highlights
    if (typeof updateProposalLayer === 'function') {
        const showProposalsCheckbox = document.getElementById('showProposalsCheckbox');
        if (showProposalsCheckbox && showProposalsCheckbox.checked) {
            // Only update if there's no currently highlighted proposal to avoid flicker
            if (!window.currentlyHighlightedProposal) {
                updateProposalLayer();
            } else {
                // Just refresh the proposal data without rebuilding the visual layer
                if (typeof refreshProposalData === 'function') {
                    refreshProposalData();
                }
            }
        }
    }

    gameState.save();
    gameState.updateGameUI();

    // Update Game Log dialog if it's currently open
    updateGameLogDialogIfOpen();

    console.log(`Turn ${gameState.currentTurn} completed. ${agents.length} agents acted.`);
}

/**
 * Update the agents button with count
 */
function updateAgentsButton() {
    const agentsBtn = document.getElementById('show-agents-btn');
    if (agentsBtn && typeof agentStorage !== 'undefined') {
        const agents = agentStorage.getAllAgents();
        if (agents.length > 0) {
            agentsBtn.textContent = `Show Agents (${agents.length})`;
        } else {
            agentsBtn.textContent = 'Show Agents';
        }
    }
}

/**
 * Update the Game section title based on current state
 */
function updateGameSectionTitle() {
    const gameCheckbox = document.getElementById('gameCheckbox');
    const gameLabel = document.querySelector('label[for="gameCheckbox"] span');

    if (!gameLabel) return;

    // If game section is collapsed and game is not running, show (paused)
    if (gameCheckbox && !gameCheckbox.checked && !gameState.isRunning) {
        gameLabel.innerHTML = '<i class="fas fa-gamepad"></i> Game (paused)';
    } else {
        // Otherwise show normal title
        gameLabel.innerHTML = '<i class="fas fa-gamepad"></i> Game';
    }
}

/**
 * Update the game UI elements
 */
gameState.updateGameUI = function () {
    // Update game datetime display
    const gameTimeElement = document.getElementById('game-datetime');
    if (gameTimeElement) {
        const dateStr = this.currentDateTime.toISOString().slice(0, 10);
        gameTimeElement.textContent = dateStr;
    }

    // Update turns played display
    const turnsElement = document.getElementById('game-turns');
    if (turnsElement) {
        turnsElement.textContent = this.currentTurn.toString();
    }

    // Update turn interval slider
    const sliderElement = document.getElementById('turn-interval-slider');
    const valueElement = document.getElementById('turn-interval-value');
    if (sliderElement && valueElement) {
        sliderElement.value = this.turnIntervalSeconds;
        valueElement.textContent = this.turnIntervalSeconds;
    }

    // Update play/pause button
    const playPauseBtn = document.getElementById('game-play-pause-btn');
    if (playPauseBtn) {
        if (this.isRunning) {
            playPauseBtn.innerHTML = '<i class="fas fa-pause"></i> Pause';
            playPauseBtn.classList.remove('btn-success');
            playPauseBtn.classList.add('btn-warning');
        } else {
            playPauseBtn.innerHTML = '<i class="fas fa-play"></i> Play';
            playPauseBtn.classList.remove('btn-warning');
            playPauseBtn.classList.add('btn-success');
        }
    }

    // Update game log button with count
    const gameLogBtn = document.getElementById('show-game-log-btn');
    if (gameLogBtn) {
        if (this.gameLog.length > 0) {
            gameLogBtn.textContent = `Show Game Log (${this.gameLog.length})`;
        } else {
            gameLogBtn.textContent = 'Show Game Log';
        }
    }
};

/**
 * Toggle game play/pause state
 */
function toggleGamePlayPause() {
    if (gameState.isRunning) {
        stopGameLoop();
    } else {
        startGameLoop();
        // Clear (paused) from Game section title when starting
        const gameLabel = document.querySelector('label[for="gameCheckbox"] span');
        if (gameLabel && gameLabel.innerHTML.includes('(paused)')) {
            gameLabel.innerHTML = '<i class="fas fa-gamepad"></i> Game';
        }
    }
}

/**
 * Show the game log dialog
 */
function showGameLogDialog() {
    // Create modal dialog
    const modal = document.createElement('div');
    modal.className = 'game-log-modal';
    modal.innerHTML = `
        <div class="game-log-modal-content">
            <div class="game-log-modal-header">
                <h2>Game Log</h2>
                <button type="button" class="game-log-modal-close close-circle-btn close-circle-btn--lg" aria-label="Close game log" onclick="closeGameLogDialog()">&times;</button>
            </div>
            <div class="game-log-modal-body">
                <div id="game-log-content" class="game-log-content">
                    ${gameState.gameLog.length === 0 ?
            '<p class="no-logs">No game events yet. Start the game to see agent activities.</p>' :
            gameState.gameLog.map(entry => {
                // Handle both old string format and new object format
                const entryText = typeof entry === 'string' ? entry : entry.text;
                const isUserAction = typeof entry === 'object' && entry.isUserAction;
                const cssClass = isUserAction ? 'log-entry user-action' : 'log-entry';
                return `<div class="${cssClass}">${entryText}</div>`;
            }).join('')
        }
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // Auto-scroll to bottom
    const logContent = document.getElementById('game-log-content');
    if (logContent) {
        logContent.scrollTop = logContent.scrollHeight;
    }

    // Set up event listeners for clickable links
    setupGameLogClickListeners();
}

/**
 * Close the game log dialog
 */
function closeGameLogDialog() {
    const modal = document.querySelector('.game-log-modal');
    if (modal) {
        document.body.removeChild(modal);
    }
}

/**
 * Show agents statistics dialog
 */
async function showAgentsStatistics() {
    const agents = agentStorage.getAllAgents();

    if (agents.length === 0) {
        alert('No agents exist yet. Start the game to create agents.');
        return;
    }

    // Calculate statistics for each agent
    const agentStats = await Promise.all(agents.map(async agent => {
        const ownedParcels = getAgentOwnedParcels(agent.id);
        let portfolioValue = 0;
        if (typeof calculatePortfolioValue === 'function') {
            try {
                portfolioValue = await calculatePortfolioValue(ownedParcels);
            } catch (error) {
                console.warn('Failed to calculate portfolio value for agent', agent.id, error);
            }
        }

        // Count executed proposals authored by this agent
        let proposalsAppliedCount = 0;
        if (typeof proposalStorage !== 'undefined') {
            const allProposals = proposalStorage.getAllProposals();
            proposalsAppliedCount = allProposals.filter(proposal => {
                if (proposal.author !== agent.name) return false;
                if (typeof isProposalApplied === 'function') {
                    return isProposalApplied(proposal);
                }
                return (proposal.status || '').toLowerCase() === 'applied';
            }).length;
        }

        return {
            ...agent,
            currentParcels: ownedParcels,
            portfolioValue: portfolioValue,
            totalWealth: agent.ethBalance + portfolioValue,
            proposalsAppliedCount
        };
    }));

    // Sort by total wealth descending
    agentStats.sort((a, b) => b.totalWealth - a.totalWealth);

    // Create modal dialog
    const modal = document.createElement('div');
    modal.className = 'agents-stats-modal';
    modal.innerHTML = `
        <div class="agents-stats-modal-content">
            <div class="agents-stats-modal-header">
                <h2>Agent Statistics</h2>
                <button type="button" class="agents-stats-modal-close close-circle-btn close-circle-btn--lg" aria-label="Close agent statistics" onclick="closeAgentsStatistics()">&times;</button>
            </div>
            <div class="agents-stats-modal-body">
                <div class="agents-stats-table-container">
                    <table class="agents-stats-table">
                        <thead>
                            <tr>
                                <th>Avatar</th>
                                <th>Name</th>
                                <th>ETH Balance</th>
                                <th>Parcels Owned</th>
                                <th>Proposals Created</th>
                                <th>Proposals Accepted</th>
                                <th>Proposals Applied</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${agentStats.map(agent => {
        const isUserAgent = agent.userControlled === true;
        const rowClass = isUserAgent ? 'user-agent-row' : '';
        const ethBalanceDisplay = isUserAgent ? '-' : `${agent.ethBalance.toFixed(2)} ETH`;
        return `
                                <tr class="${rowClass}">
                                    <td>
                                        <img src="${getAvatarImagePath(agent.avatarIndex)}" class="agent-avatar" style="width: 40px; height: 40px; border-radius: 50%; cursor: pointer;" onclick="showAgentDialog('${agent.id}')">
                                    </td>
                                    <td>
                                        <a href="#" onclick="showAgentDialog('${agent.id}'); return false;" class="agent-link">
                                            ${agent.name}
                                        </a>
                                        ${isUserAgent ? '<div class="user-agent-indicator">(You)</div>' : ''}
                                    </td>
                                    <td ${isUserAgent ? 'data-user-eth-balance-table' : ''}>${ethBalanceDisplay}</td>
                                    <td>${agent.currentParcels.length}</td>
                                    <td>${agent.proposalsCreated ? agent.proposalsCreated.length : 0}</td>
                                    <td>${agent.proposalsAccepted ? agent.proposalsAccepted.length : 0}</td>
                                    <td>${agent.proposalsAppliedCount || 0}</td>
                                </tr>
                                `;
    }).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    if (typeof window.refreshUserEthBalanceDisplay === 'function') {
        window.refreshUserEthBalanceDisplay();
    }
}

/**
 * Update the Game Log dialog content if it's currently open
 */
function updateGameLogDialogIfOpen() {
    const gameLogModal = document.querySelector('.game-log-modal');
    if (!gameLogModal) {
        // Game Log dialog is not open
        return;
    }

    const logContentElement = document.getElementById('game-log-content');
    if (!logContentElement) {
        // Game Log content element not found
        return;
    }

    // Store current scroll position to determine if user was at bottom
    const wasAtBottom = logContentElement.scrollTop >= (logContentElement.scrollHeight - logContentElement.clientHeight - 10);

    // Update the content with new log entries
    logContentElement.innerHTML = gameState.gameLog.length === 0 ?
        '<p class="no-logs">No game events yet. Start the game to see agent activities.</p>' :
        gameState.gameLog.map(entry => {
            // Handle both old string format and new object format
            const entryText = typeof entry === 'string' ? entry : entry.text;
            const isUserAction = typeof entry === 'object' && entry.isUserAction;
            const cssClass = isUserAction ? 'log-entry user-action' : 'log-entry';
            return `<div class="${cssClass}">${entryText}</div>`;
        }).join('');

    // Re-setup click listeners for new content
    setupGameLogClickListeners();

    // If user was at bottom before update, keep them at bottom
    // Otherwise, maintain their current scroll position
    if (wasAtBottom) {
        logContentElement.scrollTop = logContentElement.scrollHeight;
    }
}

/**
 * Close agents statistics dialog
 */
function closeAgentsStatistics() {
    const modal = document.querySelector('.agents-stats-modal');
    if (modal) {
        document.body.removeChild(modal);
    }
}

/**
 * Setup click listeners for clickable links in game log and proposal dialogs
 */
function setupGameLogClickListeners() {
    // Handle agent links
    document.querySelectorAll('.agent-link-clickable').forEach(link => {
        link.addEventListener('click', function (e) {
            e.preventDefault();
            const agentId = this.getAttribute('data-agent-id');
            if (agentId) {
                showAgentDialog(agentId);
            }
        });
    });

    // Handle proposal links
    document.querySelectorAll('.proposal-link-clickable').forEach(link => {
        link.addEventListener('click', function (e) {
            e.preventDefault();
            const proposalHash = this.getAttribute('data-proposal-hash');
            if (proposalHash) {
                showProposalFromLog(proposalHash);
            }
        });
    });

    // Handle parcel links
    document.querySelectorAll('.parcel-link-clickable').forEach(link => {
        link.addEventListener('click', function (e) {
            e.preventDefault();
            const parcelId = this.getAttribute('data-parcel-id');
            if (parcelId) {
                focusAndSelectParcelFromLog(parcelId);
            }
        });
    });
}

/**
 * Show proposal info from game log
 */
function showProposalFromLog(proposalHashFragment) {
    // Find the full proposal hash
    if (typeof proposalStorage !== 'undefined') {
        const proposals = proposalStorage.getAllProposals();
        const proposal = proposals.find(p => p.proposalHash.startsWith(proposalHashFragment));

        if (proposal) {
            // Show dedicated proposal info dialog
            showProposalInfoDialog(proposal);
        } else {
            alert(`Proposal with ID ${proposalHashFragment} not found.`);
        }
    }
}

/**
 * Show a dedicated proposal info dialog (similar to proposal details but without accept buttons)
 */
function showProposalInfoDialog(proposal) {
    // Calculate proposal statistics
    const parcels = proposal.parcelIds.map(id => {
        if (typeof multiParcelSelection !== 'undefined' && typeof multiParcelSelection.findParcelById === 'function') {
            return multiParcelSelection.findParcelById(id);
        }
        return null;
    }).filter(p => p);

    const totalArea = parcels.reduce((sum, parcel) => {
        if (parcel && parcel.feature && parcel.feature.properties) {
            return sum + (parcel.feature.properties.calculatedArea || 0);
        }
        return sum;
    }, 0);

    // Create modal dialog
    const modal = document.createElement('div');
    modal.className = 'proposal-info-modal';
    modal.innerHTML = `
        <div class="proposal-info-modal-content">
            <div class="proposal-info-modal-header">
                <h2>Proposal Information</h2>
                <button type="button" class="proposal-info-modal-close close-circle-btn close-circle-btn--lg" aria-label="Close proposal info" onclick="closeProposalInfoDialog()">&times;</button>
            </div>
            <div class="proposal-info-modal-body">
                <div class="proposal-header">
                    <h3>${proposal.title}</h3>
                    <div class="proposal-hash">ID: ${proposal.proposalHash}</div>
                </div>
                
                <div class="proposal-acceptance-status">
                    <div class="acceptance-label">Parcel Acceptance Status:</div>
                    <div class="acceptance-circles">
                        ${(() => {
            const total = proposal.parcelIds.length;
            const accepted = proposal.acceptedParcelIds ? proposal.acceptedParcelIds.length : 0;
            let html = '';
            // Add green circles for accepted parcels
            for (let i = 0; i < accepted; i++) {
                html += '<div class="acceptance-circle accepted" title="Accepted"></div>';
            }
            // Add grey circles for pending parcels
            for (let i = 0; i < total - accepted; i++) {
                html += '<div class="acceptance-circle pending" title="Pending"></div>';
            }
            return html;
        })()}
                    </div>
                </div>

                <div class="proposal-details">
                    <div class="metric-group">
                        <div class="metric-label">Author:</div>
                        <div class="metric-value author-with-avatar">
                            ${(() => {
            // Find the agent with matching name
            const agents = agentStorage.getAllAgents();
            const agent = agents.find(a => a.name === proposal.author);
            if (agent) {
                return `
                                    <img src="${getAvatarImagePath(agent.avatarIndex)}" class="author-avatar" style="width: 24px; height: 24px; border-radius: 50%; border: 2px solid #007bff; margin-right: 8px; vertical-align: middle;">
                                    <a href="#" data-agent-id="${agent.id}" class="agent-link agent-link-clickable" style="text-decoration: none; color: #007bff; font-weight: 500;">${proposal.author}</a>
                                `;
            } else {
                return proposal.author;
            }
        })()}
                        </div>
                    </div>
                    <div class="metric-group">
                        <div class="metric-label">Description:</div>
                        <div class="metric-value">${proposal.description}</div>
                    </div>
                    <div class="metric-group">
                        <div class="metric-label">Budget/Offer:</div>
                        <div class="metric-value">${(proposal.budget || proposal.offer || 0).toFixed(2)} ETH</div>
                    </div>
                    <div class="metric-group">
                        <div class="metric-label">Parcels in Proposal:</div>
                        <div class="metric-value">${proposal.parcelIds.length}</div>
                    </div>
                    <div class="metric-group">
                        <div class="metric-label">Total Area:</div>
                        <div class="metric-value">${Math.round(totalArea).toLocaleString()} m²</div>
                    </div>
                    <div class="metric-group">
                        <div class="metric-label">Created:</div>
                        <div class="metric-value">${new Date(proposal.createdAt).toLocaleDateString()}</div>
                    </div>
                </div>

                ${proposal.parcelIds.length > 0 ? `
                    <div class="proposal-parcels">
                        <h4>Parcels in this Proposal:</h4>
                        <div class="proposal-parcels-list">
                            ${proposal.parcelIds.map(parcelId => {
            const parcel = parcels.find(p => p && p.feature && p.feature.properties &&
                p.feature.properties.CESTICA_ID.toString() === parcelId.toString());
            if (parcel) {
                const area = parcel.feature.properties.calculatedArea || 0;
                const parcelNumber = parcel.feature.properties.BROJ_CESTICE || parcelId;
                const isAccepted = proposal.acceptedParcelIds && proposal.acceptedParcelIds.includes(parcelId);

                // Get parcel owner information
                const ownerId = PersistentStorage.getItem(`parcel_${parcelId}_owner`);
                let ownerAvatarHtml = '';

                if (ownerId && typeof agentStorage !== 'undefined') {
                    const owner = agentStorage.getAgent(ownerId);
                    if (owner && typeof getAvatarImagePath === 'function') {
                        ownerAvatarHtml = `<img src="${getAvatarImagePath(owner.avatarIndex)}" class="parcel-owner-avatar" style="width: 24px; height: 24px; border-radius: 50%; border: 2px solid #007bff; margin-right: 8px;" title="Owner: ${owner.name}">`;
                    }
                }

                return `
                                        <div class="proposal-parcel-item ${isAccepted ? 'accepted' : 'pending'}" style="display: flex; align-items: center;">
                                            ${ownerAvatarHtml}
                                            <div style="flex: 1;">
                                                <span class="parcel-number">
                                                    <a href="#" onclick="showParcelFromLog('${parcelId}'); closeProposalInfoDialog(); return false;" class="parcel-link">
                                                        Parcel ${parcelNumber}
                                                    </a>
                                                </span>
                                                <span class="parcel-details">
                                                    ${Math.round(area).toLocaleString()} m²
                                                    ${isAccepted ? '<span class="status-accepted">✓ Accepted</span>' : '<span class="status-pending">⏳ Pending</span>'}
                                                </span>
                                            </div>
                                        </div>
                                    `;
            } else {
                // Get parcel owner information even if parcel data is not found
                const ownerId = PersistentStorage.getItem(`parcel_${parcelId}_owner`);
                let ownerAvatarHtml = '';

                if (ownerId && typeof agentStorage !== 'undefined') {
                    const owner = agentStorage.getAgent(ownerId);
                    if (owner && typeof getAvatarImagePath === 'function') {
                        ownerAvatarHtml = `<img src="${getAvatarImagePath(owner.avatarIndex)}" class="parcel-owner-avatar" style="width: 24px; height: 24px; border-radius: 50%; border: 2px solid #007bff; margin-right: 8px;" title="Owner: ${owner.name}">`;
                    }
                }

                return `
                                        <div class="proposal-parcel-item pending" style="display: flex; align-items: center;">
                                            ${ownerAvatarHtml}
                                            <div style="flex: 1;">
                                                <span class="parcel-number">Parcel ${parcelId}</span>
                                                <span class="parcel-details">Area unknown</span>
                                            </div>
                                        </div>
                                    `;
            }
        }).join('')}
                        </div>
                    </div>
                ` : ''}
            </div>
            <div class="proposal-info-modal-footer">
                <button class="btn btn-secondary" onclick="closeProposalInfoDialog()">Close</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // Setup click listeners for any clickable links in the proposal info
    setupGameLogClickListeners();
}

/**
 * Close the proposal info dialog
 */
function closeProposalInfoDialog() {
    const modal = document.querySelector('.proposal-info-modal');
    if (modal) {
        document.body.removeChild(modal);
    }
}

/**
 * Show parcel info from game log
 */
function showParcelFromLog(parcelId) {
    // Close Game Log dialog if open to allow better visibility of the parcel
    closeGameLogDialog();

    // On mobile, also collapse sidebar if open
    const isMobile = window.innerWidth <= 768;
    if (isMobile) {
        const sidebar = document.getElementById('sidebar');
        if (sidebar && !sidebar.classList.contains('collapsed')) {
            if (typeof toggleSidebar === 'function') {
                toggleSidebar();
            }
        }
    }

    // Use the existing parcel selection functionality with mobile-aware behavior
    if (typeof selectParcel === 'function') {
        selectParcel(parcelId, !isMobile); // Pass showPanel parameter: false for mobile, true for desktop
    } else {
        alert(`Unable to show parcel ${parcelId}. Parcel selection functionality not available.`);
    }
}

/**
 * Update the turn interval display (called when slider moves)
 */
function updateTurnIntervalDisplay(seconds) {
    const valueElement = document.getElementById('turn-interval-value');
    if (valueElement) {
        valueElement.textContent = seconds;
    }
}

/**
 * Update the turn interval setting (called when slider changes)
 */
function updateTurnInterval(seconds) {
    gameState.turnIntervalSeconds = parseInt(seconds);
    gameState.save();

    // If game is running, restart with new interval
    if (gameState.isRunning) {
        stopGameLoop();
        startGameLoop();
    }

    console.log(`Turn interval updated to ${seconds} seconds`);
}

/**
 * Update the progress bar based on time elapsed
 */
function updateProgressBar(overrideProgress = null) {
    const progressFill = document.getElementById('turn-progress-fill');
    const progressTime = document.getElementById('turn-progress-time');

    if (!progressFill || !progressTime) return;

    if (overrideProgress !== null) {
        // Set specific progress (e.g., when stopped)
        progressFill.style.width = `${overrideProgress}%`;
        progressTime.textContent = '--';
        return;
    }

    if (!gameState.isRunning || !gameState.turnStartTime || gameState.turnIntervalSeconds === 0) {
        progressFill.style.width = '0%';
        progressTime.textContent = '--';
        return;
    }

    const now = Date.now();
    const elapsed = now - gameState.turnStartTime;
    const totalMs = gameState.turnIntervalSeconds * 1000;
    const remaining = Math.max(0, totalMs - elapsed);
    const progress = Math.min(100, Math.max(0, 100 - (remaining / totalMs * 100)));

    progressFill.style.width = `${progress}%`;

    const remainingSeconds = Math.ceil(remaining / 1000);
    progressTime.textContent = `${remainingSeconds}s`;
}

/**
 * Focus and select parcel from game log
 */
function focusAndSelectParcelFromLog(parcelId) {
    if (typeof multiParcelSelection !== 'undefined' && typeof multiParcelSelection.findParcelById === 'function') {
        const parcelLayer = multiParcelSelection.findParcelById(parcelId);
        if (parcelLayer && typeof map !== 'undefined') {
            // Highlight/select the parcel
            if (typeof multiParcelSelection.addParcelHighlight === 'function') {
                multiParcelSelection.addParcelHighlight(parcelLayer);
            }
            // Center/focus map on the parcel
            if (parcelLayer.getBounds) {
                map.fitBounds(parcelLayer.getBounds(), { maxZoom: 18 });
            } else if (parcelLayer.getLatLng) {
                map.setView(parcelLayer.getLatLng(), 18);
            }
            // Optionally, select the parcel in the UI (set selectedParcelId, etc.)
            window.selectedParcelId = parcelId;
        }
    }
}

function initialiseGameState() {
    gameState.load();
}

if (typeof PersistentStorage !== 'undefined' && PersistentStorage.ensureReady) {
    PersistentStorage.ensureReady(initialiseGameState);
} else {
    initialiseGameState();
}

// Make functions available globally
window.gameState = gameState;
window.initializeGame = initializeGame;
window.startGameLoop = startGameLoop;
window.stopGameLoop = stopGameLoop;
window.executeGameTurn = executeGameTurn;
window.toggleGamePlayPause = toggleGamePlayPause;
window.resetGameState = resetGameState;
window.showGameLogDialog = showGameLogDialog;
window.closeGameLogDialog = closeGameLogDialog;
window.updateGameLogDialogIfOpen = updateGameLogDialogIfOpen;
window.showAgentsStatistics = showAgentsStatistics;
window.closeAgentsStatistics = closeAgentsStatistics;
window.setupGameLogClickListeners = setupGameLogClickListeners;
window.showProposalFromLog = showProposalFromLog;
window.showProposalInfoDialog = showProposalInfoDialog;
window.closeProposalInfoDialog = closeProposalInfoDialog;
window.showParcelFromLog = showParcelFromLog;
window.updateTurnIntervalDisplay = updateTurnIntervalDisplay;
window.updateTurnInterval = updateTurnInterval;
window.updateProgressBar = updateProgressBar;
window.updateAgentsButton = updateAgentsButton;
window.updateGameSectionTitle = updateGameSectionTitle;

/**
 * Reset the entire game state. If autoReinit is true the game will be initialised again automatically.
 * @param {boolean} autoReinit - Whether to run initializeGame() right after the reset completes.
 */
function resetGameState(autoReinit = false) {
    const message = autoReinit ?
        'Are you sure you want to start a NEW game? This will delete all agents, game progress, and parcel ownership data.' :
        'Are you sure you want to reset the game state? This will delete all agents, game progress, and parcel ownership data.';

    const confirmed = confirm(message);
    if (!confirmed) return;

    // Preserve the current user-controlled agent (if any) so the player keeps their identity.
    const userAgent = typeof getCurrentUserAgent === 'function' ? getCurrentUserAgent() : null;
    let preservedUserData = null;
    if (userAgent) {
        preservedUserData = {
            name: userAgent.name,
            avatarIndex: userAgent.avatarIndex,
            id: userAgent.id
        };
    }

    // Stop any running loops first.
    if (typeof stopGameLoop === 'function') {
        stopGameLoop();
    }

    // Reset everything (the gameState.reset implementation now supports autoReinit).
    gameState.reset(autoReinit);

    // Recreate the user agent (fresh balance etc.) if we preserved it.
    if (preservedUserData) {
        const newUserAgent = {
            id: preservedUserData.id,
            name: preservedUserData.name,
            avatarIndex: preservedUserData.avatarIndex,
            ethBalance: 100,
            walletAddresses: [],
            ownedParcels: [],
            proposalsCreated: [],
            proposalsAccepted: [],
            proposalsExecuted: [],
            createdAt: new Date().toISOString(),
            lastActionAt: null,
            aiControlled: false,
            userControlled: true
        };

        agentStorage.addAgent(newUserAgent);
        console.log('User agent preserved and reset with fresh data');
    }

    // Clear all proposal data
    if (typeof proposalStorage !== 'undefined' && proposalStorage.clear) {
        proposalStorage.clear();
    }
    if (typeof clearProposalHighlights === 'function') {
        clearProposalHighlights();
    }
    if (typeof updateProposalLayer === 'function') {
        updateProposalLayer();
    }
    if (typeof updateShowProposalsButton === 'function') {
        updateShowProposalsButton();
    }

    // Clear all agent bubbles
    if (typeof window.agentBubbleManager !== 'undefined' && window.agentBubbleManager.clearAllBubbles) {
        window.agentBubbleManager.clearAllBubbles();
    }

    // Inform the player
    if (typeof updateStatus === 'function') {
        const statusMessage = preservedUserData ?
            'Game state has been reset. Your agent has been preserved with fresh data.' :
            'Game state has been reset. All agents and progress deleted.';
        updateStatus(statusMessage);
    }
} 