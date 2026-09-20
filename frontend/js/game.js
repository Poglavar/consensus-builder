/*
    Game logic and state management for the consensus builder application.
    This file contains the main game loop, state management, and coordination
    between agents, proposals, and the world state.
*/

function formatGameText(template, params = {}) {
    if (!template) return '';
    return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
        return Object.prototype.hasOwnProperty.call(params, key) ? params[key] : match;
    });
}

function translateGameText(key, fallback, params = {}) {
    const api = (typeof window !== 'undefined' && window.i18n) ? window.i18n : null;
    if (api && typeof api.t === 'function') {
        return api.t(key, params);
    }
    return formatGameText(fallback, params);
}

function showGameAlert(key, fallback, params = {}) {
    const message = translateGameText(`alerts.messages.${key}`, fallback, params);
    const alertFn = (typeof window !== 'undefined' && typeof window.showStyledAlert === 'function')
        ? window.showStyledAlert
        : window.alert;
    if (typeof alertFn === 'function') {
        alertFn(message);
    }
    return message;
}

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
    isTurnExecuting: false,
    queuedTurnRequested: false,

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

    // Add a structured activity. `text` stays for old dialogs/storage readers, while actor/action/
    // source let the unified explorer filter simulation, live, human, algorithmic and LLM activity.
    addActivityEvent(activity, options = {}) {
        const skipPersist = options && options.skipPersist === true;
        const skipUiUpdate = options && options.skipUiUpdate === true;
        const eventTime = activity?.occurredAt ? new Date(activity.occurredAt) : this.currentDateTime;
        const timestamp = (Number.isNaN(eventTime.getTime()) ? this.currentDateTime : eventTime).toISOString().slice(0, 19).replace('T', ' ');
        const message = activity?.messageHtml || activity?.message || '';
        const logEntry = `[Turn ${this.currentTurn}] [${timestamp}] ${message}`;
        const logEntryObj = {
            ...(activity || {}),
            text: logEntry,
            isUserAction: activity?.actor?.kind === 'human' || activity?.isUserAction === true,
            source: activity?.source || 'simulation',
            occurredAt: activity?.occurredAt || this.currentDateTime.toISOString(),
            recordedAt: activity?.recordedAt || new Date().toISOString(),
            turn: activity?.turn ?? this.currentTurn
        };
        this.gameLog.push(logEntryObj);

        // Keep only last 500 entries
        if (this.gameLog.length > 500) {
            this.gameLog = this.gameLog.slice(-500);
        }

        if (!skipPersist) {
            this.save();
        }
        if (!skipUiUpdate) {
            this.updateGameUI();
        }
        // console.log('Game Log:', logEntry);
    },

    // Backwards-compatible entrypoint for the older human/system call sites.
    addLogEntry(message, isUserAction = false, options = {}) {
        const currentUser = isUserAction && typeof getCurrentUserAgent === 'function' ? getCurrentUserAgent() : null;
        this.addActivityEvent({
            id: `local:${Date.now()}:${this.gameLog.length + 1}`,
            source: 'simulation',
            actor: currentUser
                ? { id: currentUser.id, name: currentUser.name, kind: 'human', controller: 'human', avatarIndex: currentUser.avatarIndex }
                : { id: 'system', name: 'System', kind: 'system', controller: 'system' },
            action: options.action || { type: 'log' },
            messageHtml: message,
            isUserAction
        }, options);
    },

    // Clear all game data
    reset(autoReinit = false) {
        this.isInitialized = false;
        this.isRunning = false;
        this.currentDateTime = new Date('2024-01-01T00:00:00Z');
        this.currentTurn = 0;
        this.gameLog = [];
        this.isTurnExecuting = false;
        this.queuedTurnRequested = false;

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
    const fabric = (typeof window !== 'undefined') ? window.LiveParcelFabric : null;
    if (fabric && typeof fabric.list === 'function' && typeof fabric.featureId === 'function') {
        fabric.list().forEach(feature => {
            const parcelId = fabric.featureId(feature);
            if (!parcelId) return;
            const randomAgent = agents[Math.floor(Math.random() * agents.length)];
            PersistentStorage.setItem(`parcel_${parcelId}_owner`, randomAgent.id);
            assignedParcels++;
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
        try {
            if (typeof initializeGame === 'function') {
                initializeGame();
            }
        } catch (e) {
            console.warn('Failed to auto-initialize game state before starting loop:', e);
        }
        if (!gameState.isInitialized) {
            showGameAlert('please_initialize_the_game_state_first', 'Please initialize the game state first.');
            return;
        }
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
            if (gameState.isTurnExecuting) {
                gameState.queuedTurnRequested = true;
                return;
            }
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
    gameState.queuedTurnRequested = false;
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
function yieldToMainThread() {
    return new Promise(resolve => {
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(() => resolve());
            return;
        }
        setTimeout(resolve, 0);
    });
}

async function executeGameTurn() {
    if (gameState.isTurnExecuting) {
        gameState.queuedTurnRequested = true;
        return;
    }

    gameState.isTurnExecuting = true;

    try {
        gameState.currentTurn++;
        gameState.currentDateTime = new Date(gameState.currentDateTime.getTime() + (7 * 24 * 60 * 60 * 1000)); // Add 1 week
        gameState.turnStartTime = Date.now(); // Reset turn timer

        gameState.addLogEntry(`=== Turn ${gameState.currentTurn} begins ===`, false, { skipPersist: true, skipUiUpdate: true });

        // Clear any existing agent bubbles at the start of a new turn
        if (typeof window.agentBubbleManager !== 'undefined' && window.agentBubbleManager.onGameStateUpdate) {
            window.agentBubbleManager.onGameStateUpdate();
        }

        const agents = agentStorage.getAllAgents();
        const allActiveProposals = (typeof proposalStorage !== 'undefined' && typeof proposalStorage.getAllProposals === 'function')
            ? proposalStorage.getAllProposals()
            : [];
        // Restrict agent awareness to proposals in the current city — otherwise
        // agents can accept/donate to proposals belonging to a different city,
        // which surfaces as map bubbles/shapes outside the visible viewport.
        const currentCityId = (typeof window !== 'undefined' && window.CityConfigManager
                && typeof window.CityConfigManager.getCurrentCityId === 'function')
            ? window.CityConfigManager.getCurrentCityId()
            : null;
        const activeProposals = (currentCityId && typeof isInCity === 'function')
            ? allActiveProposals.filter(p => {
                const ids = Array.isArray(p.cadastreParcelIds) ? p.cadastreParcelIds : [];
                if (!ids.length) return true;
                return ids.some(id => isInCity(id, currentCityId));
            })
            : allActiveProposals;
        const ownedParcelsByAgent = (typeof buildAgentOwnedParcelIndex === 'function')
            ? buildAgentOwnedParcelIndex()
            : null;
        const turnParcelPool = (typeof buildTurnParcelPool === 'function')
            ? buildTurnParcelPool()
            : [];
        // Precompute adjacency once per turn so every agent sees the same map
        // and we don't redo the edge-index scan inside each agent decision.
        const neighborMap = (typeof buildAgentNeighborMap === 'function' && turnParcelPool.length > 0)
            ? buildAgentNeighborMap(turnParcelPool)
            : null;

        if (agentStorage && typeof agentStorage.beginBatch === 'function') {
            agentStorage.beginBatch();
        }
        // Batch every proposalStorage mutation in the turn into a single
        // end-of-turn JSON.stringify + IndexedDB write. Without this, each
        // agent create/accept/donate re-serialised the entire proposal store
        // (~10ms per call with a few hundred proposals) — the main culprit
        // behind choppy flyTo / sluggish frames during agent turns.
        if (typeof proposalStorage !== 'undefined' && typeof proposalStorage.beginBatch === 'function') {
            proposalStorage.beginBatch();
        }

        // Reconcile support against lifecycle before agents act. Donations return to their donors
        // when a proposal is Cancelled/Expired; soft pledges are voided without touching balances.
        if (window.AgentSupportSimulation) {
            for (const proposal of allActiveProposals) {
                const status = typeof getLifecycleStatus === 'function' ? getLifecycleStatus(proposal) : proposal.lifecycleStatus;
                if (status !== 'Cancelled' && status !== 'Expired') continue;
                const outcome = window.AgentSupportSimulation.refund(proposal, id => agentStorage.getAgent(id));
                if (!outcome.refunded && !outcome.voided) continue;
                if (typeof proposalStorage._indexProposal === 'function') proposalStorage._indexProposal(proposal);
                proposalStorage.save();
                for (const participant of agents) agentStorage.updateAgent(participant.id, { ethBalance: participant.ethBalance });
            }
        }

        const actionEngine = getUnifiedAgentActionEngine();
        // Have each AI-controlled agent decide and act through the same action contract. A local
        // agent can switch controller from "algorithm" to "llm" without changing execution or UI.
        for (let index = 0; index < agents.length; index++) {
            const agent = agents[index];
            // Skip agents that are not AI controlled
            if (!agent.aiControlled) {
                continue;
            }

            const turnContext = {
                activeProposals,
                ownedParcelsByAgent,
                turnParcelPool,
                neighborMap,
                source: 'simulation',
                turn: gameState.currentTurn,
                occurredAt: gameState.currentDateTime.toISOString(),
                skipPersist: true,
                skipUiUpdate: true
            };
            try {
                await actionEngine.run(agent, turnContext);
            } catch (error) {
                gameState.addActivityEvent({
                    id: `simulation:${agent.id}:error:${Date.now()}`,
                    source: 'simulation',
                    actor: window.AgentActionEngine.normalizeActor(agent),
                    action: { type: 'error' }, ok: false,
                    message: `${agent.name} could not act: ${error.message}`
                }, { skipPersist: true, skipUiUpdate: true });
            }

            // Update agent's last action timestamp
            agentStorage.updateAgent(agent.id, { lastActionAt: new Date().toISOString() });

            if ((index + 1) % 2 === 0) {
                await yieldToMainThread();
            }
        }

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
    } finally {
        if (agentStorage && typeof agentStorage.endBatch === 'function') {
            agentStorage.endBatch();
        }
        if (typeof proposalStorage !== 'undefined' && typeof proposalStorage.endBatch === 'function') {
            proposalStorage.endBatch();
        }

        gameState.isTurnExecuting = false;

        if (gameState.isRunning && gameState.queuedTurnRequested) {
            gameState.queuedTurnRequested = false;
            executeGameTurn();
        }
    }
}

let unifiedAgentActionEngine = null;

function getUnifiedAgentActionEngine() {
    if (unifiedAgentActionEngine) return unifiedAgentActionEngine;
    if (!window.AgentActionEngine) throw new Error('AgentActionEngine is unavailable');
    unifiedAgentActionEngine = window.AgentActionEngine.createEngine({
        decisionProviders: {
            algorithm: (agent, context) => agentDecideAction(agent, context),
            human: (_actor, context) => context.action,
            llm: async (agent, context) => {
                if (typeof window.agentLlmDecisionProvider !== 'function') {
                    throw new Error('No LLM decision provider is configured');
                }
                return window.agentLlmDecisionProvider(agent, context);
            }
        },
        actionHandlers: {
            '*': (agent, action, context) => Object.prototype.hasOwnProperty.call(context, 'outcome')
                ? context.outcome
                : executeAgentAction(agent, action)
        },
        onActivity: (activity, context) => gameState.addActivityEvent(activity, {
            skipPersist: context.skipPersist === true,
            skipUiUpdate: context.skipUiUpdate === true
        })
    });
    return unifiedAgentActionEngine;
}

// UI and wallet flows use this adapter after their deterministic side effect has completed. Human,
// algorithmic and LLM controllers therefore enter the same action engine and emit the same event
// shape; the browser never needs a second "human activity" implementation.
async function dispatchAgentAction(actor, action, context = {}) {
    const result = await getUnifiedAgentActionEngine().run(actor, {
        ...context,
        action,
        source: context.source || 'live',
        occurredAt: context.occurredAt || new Date().toISOString()
    });
    updateGameLogDialogIfOpen();
    return result;
}

/**
 * Update the agents button with count
 */
function updateAgentsButton() {
    const agentsBtn = document.getElementById('show-agents-btn');
    if (!agentsBtn || typeof agentStorage === 'undefined') return;

    const agents = agentStorage.getAllAgents();
    const hasAgents = agents.length > 0;
    const key = hasAgents ? 'sidebar.game.showAgentsCount' : 'sidebar.game.showAgents';
    const i18nApi = (typeof window !== 'undefined') ? window.i18n : null;

    agentsBtn.setAttribute('data-i18n-key', key);
    if (hasAgents) {
        agentsBtn.setAttribute('data-i18n-params', JSON.stringify({ count: agents.length }));
    } else {
        agentsBtn.removeAttribute('data-i18n-params');
    }

    if (i18nApi && typeof i18nApi.t === 'function') {
        agentsBtn.textContent = i18nApi.t(key, { count: agents.length });
    } else {
        agentsBtn.textContent = hasAgents ? `Show Agents (${agents.length})` : 'Show Agents';
    }
}

/**
 * Update the Game section title based on current state
 */
function updateGameSectionTitle() {
    const gameCheckbox = document.getElementById('gameCheckbox');
    const gameLabel = document.querySelector('.accordion-section[data-section="game"] [data-section-title="game"]');
    if (!gameLabel) return;

    const i18nApi = (typeof window !== 'undefined') ? window.i18n : null;
    const key = (gameCheckbox && !gameCheckbox.checked && !gameState.isRunning)
        ? 'sidebar.game.titlePaused'
        : 'sidebar.game.title';

    gameLabel.setAttribute('data-i18n-key', key);
    if (i18nApi && typeof i18nApi.applyTranslations === 'function') {
        i18nApi.applyTranslations(gameLabel);
    } else if (key === 'sidebar.game.titlePaused') {
        gameLabel.textContent = 'Game (paused)';
    } else {
        gameLabel.textContent = 'Game';
    }
}

/**
 * Update the game UI elements
 */
gameState.updateGameUI = function () {
    const i18nApi = (typeof window !== 'undefined') ? window.i18n : null;

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
        const playPauseIcon = playPauseBtn.querySelector('i');
        const playPauseLabel = playPauseBtn.querySelector('span[data-i18n-key]');
        const labelKey = this.isRunning ? 'sidebar.game.pause' : 'sidebar.game.play';

        if (playPauseIcon) {
            playPauseIcon.classList.remove('fa-play', 'fa-pause');
            playPauseIcon.classList.add(this.isRunning ? 'fa-pause' : 'fa-play');
        }
        if (playPauseLabel) {
            playPauseLabel.setAttribute('data-i18n-key', labelKey);
            if (i18nApi && typeof i18nApi.applyTranslations === 'function') {
                i18nApi.applyTranslations(playPauseLabel);
            } else {
                playPauseLabel.textContent = this.isRunning ? 'Pause' : 'Play';
            }
        }

        if (this.isRunning) {
            playPauseBtn.classList.remove('btn-success');
            playPauseBtn.classList.add('btn-warning');
        } else {
            playPauseBtn.classList.remove('btn-warning');
            playPauseBtn.classList.add('btn-success');
        }
    }

    // Update game log button with count
    const gameLogBtn = document.getElementById('show-game-log-btn');
    if (gameLogBtn) {
        const hasLogs = this.gameLog.length > 0;
        const logKey = hasLogs ? 'sidebar.game.showGameLogCount' : 'sidebar.game.showGameLog';
        gameLogBtn.setAttribute('data-i18n-key', logKey);
        if (hasLogs) {
            gameLogBtn.setAttribute('data-i18n-params', JSON.stringify({ count: this.gameLog.length }));
        } else {
            gameLogBtn.removeAttribute('data-i18n-params');
        }

        if (i18nApi && typeof i18nApi.t === 'function') {
            gameLogBtn.textContent = i18nApi.t(logKey, { count: this.gameLog.length });
        } else {
            gameLogBtn.textContent = hasLogs
                ? `Show Game Log (${this.gameLog.length})`
                : 'Show Game Log';
        }
    }

    try { updateGameSectionTitle(); } catch (_) { }
};

/**
 * Toggle game play/pause state
 */
function toggleGamePlayPause() {
    if (gameState.isRunning) {
        stopGameLoop();
    } else {
        startGameLoop();
        try { updateGameSectionTitle(); } catch (_) { }
    }
}

let liveAgentActivity = [];
let selectedActivityFilters = { source: 'all', actor: 'all', action: 'all', status: 'all', query: '' };

function escapeActivityHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
}

function normalizeStoredActivity(entry, index) {
    if (entry && typeof entry === 'object' && entry.actor && entry.action) return entry;
    const text = typeof entry === 'string' ? entry : (entry?.text || '');
    return {
        id: `legacy:${index}:${text.slice(0, 24)}`, source: 'simulation',
        actor: { id: entry?.isUserAction ? 'human' : 'system', name: entry?.isUserAction ? 'Human' : 'System', kind: entry?.isUserAction ? 'human' : 'system', controller: entry?.isUserAction ? 'human' : 'system' },
        action: { type: 'log' }, text, messageHtml: text, isUserAction: entry?.isUserAction === true,
        recordedAt: entry?.recordedAt || null
    };
}

function allActivityEvents() {
    const local = gameState.gameLog.map(normalizeStoredActivity);
    if (window.AgentActionEngine?.mergeActivities) {
        return window.AgentActionEngine.mergeActivities(local, liveAgentActivity);
    }
    return [...local, ...liveAgentActivity];
}

function activityEntryHtml(event) {
    const isLocalHtml = event.source === 'simulation' && (event.text || event.messageHtml);
    const body = isLocalHtml
        ? (event.text || event.messageHtml)
        : escapeActivityHtml(event.message || event.text || `${event.actor?.name || 'Someone'} ${event.action?.type || 'acted'}.`);
    const timestamp = event.source === 'live' && event.occurredAt
        ? `<time datetime="${escapeActivityHtml(event.occurredAt)}">${escapeActivityHtml(new Date(event.occurredAt).toLocaleString())}</time>`
        : '';
    const proposalLink = event.entity?.type === 'proposal' && event.entity.id
        ? `<a href="#" data-proposal-id="${escapeActivityHtml(event.entity.id)}" class="proposal-link proposal-link-clickable">Open proposal</a>`
        : '';
    const transactionLink = event.transaction
        ? `<a href="https://explorer.solana.com/tx/${escapeActivityHtml(event.transaction)}?cluster=devnet" target="_blank" rel="noopener">Transaction ↗</a>`
        : '';
    const details = [
        `Source: ${event.source || 'unknown'}`,
        `Controller: ${event.actor?.controller || 'unknown'}`,
        `Action: ${event.action?.type || 'unknown'}`,
        `Result: ${event.ok === false ? 'failed' : 'success'}`
    ].map(escapeActivityHtml).join(' · ');
    const actorDetails = [event.actor?.name, event.actor?.wallet, event.actor?.id]
        .filter(Boolean).map(escapeActivityHtml).join(' · ');
    const entityDetails = event.entity?.id ? `<span>${escapeActivityHtml(event.entity.type || 'entity')}: ${escapeActivityHtml(event.entity.id)}</span>` : '';
    const modelDetails = event.model
        ? `<span>Model: ${escapeActivityHtml(event.model)}${event.modelCostUsd !== null && event.modelCostUsd !== undefined ? ` · $${escapeActivityHtml(Number(event.modelCostUsd).toFixed(4))}` : ''}</span>`
        : '';
    return `<article class="log-entry activity-entry${event.isUserAction ? ' user-action' : ''}${event.ok === false ? ' is-failed' : ''}" data-source="${escapeActivityHtml(event.source)}" data-actor-kind="${escapeActivityHtml(event.actor?.kind)}">
        <div class="activity-entry-main">${body}</div>
        <div class="activity-entry-links">${timestamp}${proposalLink}${transactionLink}</div>
        <details class="activity-entry-meta"><summary>Details</summary><span>${details}</span><span>Actor: ${actorDetails}</span>${entityDetails}${modelDetails}${event.runId ? `<span>Run ${escapeActivityHtml(event.runId)}</span>` : ''}${event.batchId ? `<span>Batch ${escapeActivityHtml(event.batchId)}</span>` : ''}</details>
    </article>`;
}

function renderActivityExplorer() {
    const content = document.getElementById('game-log-content');
    if (!content) return;
    const events = allActivityEvents().filter(event => window.AgentActionEngine?.matchesActivity
        ? window.AgentActionEngine.matchesActivity(event, selectedActivityFilters)
        : true).reverse();
    content.innerHTML = events.length
        ? events.map(activityEntryHtml).join('')
        : '<p class="no-logs">No matching activity yet.</p>';
    content.setAttribute('data-rendered-count', String(events.length));
    document.querySelectorAll('[data-activity-filter-field]').forEach(field => {
        const key = field.dataset.activityFilterField;
        const expected = selectedActivityFilters[key] ?? '';
        if (field.value !== expected) field.value = expected;
    });
    setupGameLogClickListeners();
}

function setActivityFilter(dimension, value) {
    if (value === undefined) {
        selectedActivityFilters = { source: 'all', actor: 'all', action: 'all', status: 'all', query: '' };
        if (dimension && dimension !== 'all') {
            if (dimension === 'live' || dimension === 'simulation') selectedActivityFilters.source = dimension;
            else if (dimension === 'human' || dimension === 'agent' || dimension === 'algorithm' || dimension === 'llm') selectedActivityFilters.actor = dimension;
            else selectedActivityFilters.action = dimension;
        }
    } else {
        selectedActivityFilters = { ...selectedActivityFilters, [dimension]: value || 'all' };
    }
    renderActivityExplorer();
}

async function loadLiveAgentActivity() {
    const base = typeof window.getBackendBase === 'function'
        ? window.getBackendBase().replace(/\/$/, '')
        : 'https://api.urbangametheory.xyz';
    const status = document.querySelector('[data-activity-live-status]');
    if (status) status.textContent = 'Loading live activity…';
    try {
        const response = await fetch(`${base}/agent/activity?limit=100`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        liveAgentActivity = Array.isArray(payload.events) ? payload.events : [];
        if (status) status.textContent = `${liveAgentActivity.length} live events`;
    } catch (error) {
        console.warn('Could not load live agent activity', error);
        if (status) status.textContent = 'Live activity unavailable';
    }
    renderActivityExplorer();
}

/** Show one activity explorer for simulation, human, algorithmic and live LLM actions. */
function showGameLogDialog() {
    if (document.querySelector('.game-log-modal')) return;
    const modal = document.createElement('div');
    modal.className = 'game-log-modal';
    modal.innerHTML = `
        <div class="game-log-modal-content">
            <div class="game-log-modal-header">
                <div><h2>Activity</h2><div class="activity-live-status" data-activity-live-status>Local activity</div></div>
                <button type="button" class="game-log-modal-close close-circle-btn close-circle-btn--lg"
                    data-i18n-key="gameDialogs.log.closeAria" data-i18n-attr="aria-label"
                    aria-label="${translateGameText('gameDialogs.log.closeAria', 'Close activity')}"
                    onclick="closeGameLogDialog()">&times;</button>
            </div>
            <div class="game-log-modal-body">
                <nav class="activity-filters" aria-label="Filter activity">
                    <input type="search" data-activity-filter-field="query" aria-label="Search activity" placeholder="Actor, proposal or transaction" oninput="setActivityFilter('query', this.value)">
                    <select data-activity-filter-field="source" aria-label="Activity source" onchange="setActivityFilter('source', this.value)">
                        <option value="all">All sources</option><option value="live">Live</option><option value="simulation">Simulation</option>
                    </select>
                    <select data-activity-filter-field="actor" aria-label="Activity actor" onchange="setActivityFilter('actor', this.value)">
                        <option value="all">Everyone</option><option value="human">People</option><option value="algorithm">Algorithmic agents</option><option value="llm">LLM agents</option><option value="system">System</option>
                    </select>
                    <select data-activity-filter-field="action" aria-label="Activity action" onchange="setActivityFilter('action', this.value)">
                        <option value="all">All actions</option><option value="create">Create</option><option value="publish">Publish</option><option value="accept">Accept</option><option value="donate">Donate</option><option value="pledge">Pledge</option><option value="stake">Stake</option><option value="revokePledge">Revoke pledge</option><option value="refundMyDonations">Refund donation</option><option value="fulfillPledge">Fulfil pledge</option><option value="releaseDonations">Release donations</option>
                    </select>
                    <select data-activity-filter-field="status" aria-label="Activity result" onchange="setActivityFilter('status', this.value)">
                        <option value="all">Any result</option><option value="success">Succeeded</option><option value="failed">Failed</option>
                    </select>
                    <button type="button" onclick="setActivityFilter('all')">Clear</button>
                    <button type="button" class="activity-refresh" onclick="loadLiveAgentActivity()">Refresh</button>
                </nav>
                <div id="game-log-content" class="game-log-content"></div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    if (window.i18n && typeof window.i18n.applyTranslations === 'function') {
        try { window.i18n.applyTranslations(modal); } catch (_) { /* ignore */ }
    }

    renderActivityExplorer();
    loadLiveAgentActivity();
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
        showGameAlert('no_agents_exist_yet_start_the_game_to_create_agents', 'No agents exist yet. Start the game to create agents.');
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
                return isApplied(proposal);
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
                <h2 data-i18n-key="gameDialogs.agents.title">${translateGameText('gameDialogs.agents.title', 'Agent Statistics')}</h2>
                <button type="button" class="agents-stats-modal-close close-circle-btn close-circle-btn--lg"
                    data-i18n-key="gameDialogs.agents.closeAria" data-i18n-attr="aria-label"
                    aria-label="${translateGameText('gameDialogs.agents.closeAria', 'Close agent statistics')}"
                    onclick="closeAgentsStatistics()">&times;</button>
            </div>
            <div class="agents-stats-modal-body">
                <div class="agents-stats-table-container">
                    <table class="agents-stats-table">
                        <thead>
                            <tr>
                                <th data-i18n-key="gameDialogs.agents.avatar">${translateGameText('gameDialogs.agents.avatar', 'Avatar')}</th>
                                <th data-i18n-key="gameDialogs.agents.name">${translateGameText('gameDialogs.agents.name', 'Name')}</th>
                                <th data-i18n-key="gameDialogs.agents.ethBalance">${translateGameText('gameDialogs.agents.ethBalance', (typeof getChainCurrencySymbol === 'function' ? getChainCurrencySymbol() : 'ETH') + ' Balance')}</th>
                                <th data-i18n-key="gameDialogs.agents.parcelsOwned">${translateGameText('gameDialogs.agents.parcelsOwned', 'Parcels Owned')}</th>
                                <th data-i18n-key="gameDialogs.agents.proposalsCreated">${translateGameText('gameDialogs.agents.proposalsCreated', 'Proposals Created')}</th>
                                <th data-i18n-key="gameDialogs.agents.proposalsAccepted">${translateGameText('gameDialogs.agents.proposalsAccepted', 'Proposals Accepted')}</th>
                                <th data-i18n-key="gameDialogs.agents.proposalsApplied">${translateGameText('gameDialogs.agents.proposalsApplied', 'Proposals Applied')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${agentStats.map(agent => {
        const isUserAgent = agent.userControlled === true;
        const rowClass = isUserAgent ? 'user-agent-row' : '';
        const ethBalanceDisplay = isUserAgent ? '-' : `${agent.ethBalance.toFixed(2)} ${typeof getChainCurrencySymbol === 'function' ? getChainCurrencySymbol() : 'ETH'}`;
        return `
                                <tr class="${rowClass}">
                                    <td>
                                        <img src="${getAvatarImagePath(agent.avatarIndex)}" class="agent-avatar" style="width: 40px; height: 40px; border-radius: 50%; cursor: pointer;" onclick="showAgentDialog('${agent.id}')">
                                    </td>
                                    <td>
                                        <a href="#" onclick="showAgentDialog('${agent.id}'); return false;" class="agent-link">
                                            ${agent.name}
                                        </a>
                                        ${isUserAgent ? `<div class="user-agent-indicator" data-i18n-key="gameDialogs.agents.you">${translateGameText('gameDialogs.agents.you', '(You)')}</div>` : ''}
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
    if (window.i18n && typeof window.i18n.applyTranslations === 'function') {
        try { window.i18n.applyTranslations(modal); } catch (_) { /* ignore */ }
    }
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

    const scrollTop = logContentElement.scrollTop;
    renderActivityExplorer();
    logContentElement.scrollTop = scrollTop;
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
        if (link.dataset.gameLogBound === '1') {
            return;
        }
        link.dataset.gameLogBound = '1';
        link.addEventListener('click', function (e) {
            e.preventDefault();
            const agentId = this.getAttribute('data-agent-id');
            if (!agentId) {
                return;
            }

            const sidebar = document.getElementById('sidebar');
            const sidebarWasCollapsed = sidebar ? sidebar.classList.contains('collapsed') : false;

            const inProposalModal = this.closest('.proposal-info-modal');
            if (inProposalModal && typeof closeProposalInfoDialog === 'function') {
                closeProposalInfoDialog();
                // Allow the proposal dialog to close before opening the agent dialog
                setTimeout(() => {
                    if (sidebarWasCollapsed && sidebar && !sidebar.classList.contains('collapsed') && typeof toggleSidebar === 'function') {
                        toggleSidebar();
                    }
                    showAgentDialog(agentId);
                }, 50);
                return;
            }

            const proposalDetailsPanel = document.getElementById('proposal-details-panel');
            if (proposalDetailsPanel && proposalDetailsPanel.contains(this) && typeof hideProposalDetailsPanel === 'function') {
                hideProposalDetailsPanel();
                setTimeout(() => {
                    if (sidebarWasCollapsed && sidebar && !sidebar.classList.contains('collapsed') && typeof toggleSidebar === 'function') {
                        toggleSidebar();
                    }
                    showAgentDialog(agentId);
                }, 50);
                return;
            }

            showAgentDialog(agentId);
        });
    });

    // Handle proposal links
    document.querySelectorAll('.proposal-link-clickable').forEach(link => {
        if (link.dataset.gameLogBound === '1') {
            return;
        }
        link.dataset.gameLogBound = '1';
        link.addEventListener('click', function (e) {
            e.preventDefault();
            const proposalId = this.getAttribute('data-proposal-id');
            if (proposalId) {
                showProposalFromLog(proposalId);
            }
        });
    });

    // Handle parcel links
    document.querySelectorAll('.parcel-link-clickable').forEach(link => {
        if (link.dataset.gameLogBound === '1') {
            return;
        }
        link.dataset.gameLogBound = '1';
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
 * Show proposal details from game/agent log entries using proposal id
 */
function showProposalFromLog(proposalId) {
    const lookup = proposalId !== undefined && proposalId !== null
        ? proposalId.toString().trim()
        : '';
    if (!lookup) {
        return;
    }

    let proposal = null;
    if (typeof proposalStorage !== 'undefined') {
        if (typeof proposalStorage.getProposal === 'function') {
            proposal = proposalStorage.getProposal(lookup);
        }

        if (!proposal && typeof proposalStorage.getAllProposals === 'function') {
            const proposals = proposalStorage.getAllProposals();
            proposal = proposals.find(p => {
                if (!p) return false;
                const proposalId = p.proposalId !== undefined && p.proposalId !== null ? String(p.proposalId) : null;
                if (proposalId && proposalId === lookup) return true;
                return proposalId && proposalId.startsWith(lookup);
            });
        }
    }

    if (!proposal) {
        showGameAlert('proposal_with_id_not_found', 'Proposal with ID {{id}} not found.', { id: lookup });
        return;
    }

    // Close overlapping dialogs to surface the proposal details panel
    if (typeof closeGameLogDialog === 'function') {
        closeGameLogDialog();
    }
    if (document.querySelector('.agent-dialog-modal') && typeof closeAgentDialog === 'function') {
        closeAgentDialog();
    }

    const focusParcelId = Array.isArray(proposal.cadastreParcelIds) && proposal.cadastreParcelIds.length > 0
        ? proposal.cadastreParcelIds[0]
        : null;
    const proposalKey = proposal
        ? (proposal.proposalId !== undefined && proposal.proposalId !== null
            ? proposal.proposalId
            : proposal.tokenId)
        : null;

    if (typeof selectAndHighlightProposal === 'function') {
        selectAndHighlightProposal(proposalKey, focusParcelId, true, true);
    } else if (typeof showProposalInfo === 'function') {
        showProposalInfo(proposal, focusParcelId);
    } else {
        showGameAlert('unable_to_open_proposal_details', 'Unable to open proposal details.');
    }
}

/**
 * Legacy shim: previously opened the Proposal Information dialog; now routes to the Proposal Details panel
 */
function showProposalInfoDialog(proposal) {
    const lookup = proposal
        ? (proposal.proposalId !== undefined && proposal.proposalId !== null ? proposal.proposalId : proposal.tokenId)
        : null;
    if (lookup) {
        showProposalFromLog(lookup);
    }
}

/**
 * Legacy shim to close proposal details when the old dialog is referenced
 */
function closeProposalInfoDialog() {
    if (typeof hideProposalDetailsPanel === 'function') {
        hideProposalDetailsPanel();
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
        showGameAlert('unable_to_show_parcel', 'Unable to show parcel {{id}}. Parcel selection functionality not available.', { id: parcelId });
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
window.dispatchAgentAction = dispatchAgentAction;
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
            controller: 'human',
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
