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
        { const translated = api.t(key, params); if (translated !== key) return translated; }
    }
    return formatGameText(fallback, params);
}

function showGameAlert(key, fallback, params = {}) {
    const message = translateGameText(`alerts.messages.${key}`, fallback, params);
    window.CbDialog.alert(message);
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
            // Saved games from before the activity envelope held plain strings; they cannot be attributed.
            this.gameLog = (parsed.gameLog || []).filter(entry => entry?.actor && entry?.action);
            this.turnIntervalSeconds = parsed.turnIntervalSeconds || 30;
        }
        // Update UI after loading
        if (this.updateGameUI) {
            this.updateGameUI();
        }
    },

    // Add a structured activity; actor/action/source let the Activity panel filter simulation,
    // live, human, algorithmic and LLM activity through one envelope.
    addActivityEvent(activity, options = {}) {
        const skipPersist = options && options.skipPersist === true;
        const skipUiUpdate = options && options.skipUiUpdate === true;
        const logEntryObj = {
            ...(activity || {}),
            source: activity?.source || 'simulation',
            occurredAt: activity?.occurredAt || this.currentDateTime.toISOString(),
            recordedAt: activity?.recordedAt || new Date().toISOString(),
            turn: activity?.turn ?? this.currentTurn
        };
        if (logEntryObj.source === 'simulation' && !logEntryObj.cityId) {
            const cityId = window.CityConfigManager?.getCurrentCityId?.();
            if (cityId) logEntryObj.cityId = cityId;
        }
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
        if (!skipUiUpdate) {
            if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('activity:updated'));
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
            messageHtml: message
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
        updateStatus(translateGameText('status.messages.game_already_initialized', 'Game already initialized'));
        return;
    }

    updateStatus(translateGameText('status.messages.initializing_game_state', 'Initializing game state...'));
    gameState.addLogEntry('Initializing game...');

    // Get existing user agent or create 10 AI agents
    const agents = [];

    // Check if there's a user agent and include it
    const userAgent = getCurrentUserAgent();
    if (userAgent) {
        agents.push(userAgent);
        gameState.addLogEntry(`User agent joined: <button type="button" data-agent-id="${userAgent.id}" class="cb-link agent-link-clickable">${userAgent.name}</button>`);
    }

    // Create AI agents to total 10 agents (including user if present)
    const aiAgentsToCreate = 10 - agents.length;
    for (let i = 0; i < aiAgentsToCreate; i++) {
        const agent = createAgent();
        agentStorage.addAgent(agent);
        agents.push(agent);
        gameState.addLogEntry(`Created agent: <button type="button" data-agent-id="${agent.id}" class="cb-link agent-link-clickable">${agent.name}</button>`);
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

    updateStatus(translateGameText('status.messages.game_initialized_summary', 'Game initialized: {{agents}} agents created, {{parcels}} parcels assigned', { agents: agents.length, parcels: assignedParcels }));
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
    // A running game is game mode. Play works with the simulation settings folded away, and a game
    // left running with "Enable game mode" off had its own interval and New game controls greyed.
    // Ticking the box the way a click does also runs its change handlers (section gating, title).
    const gameCheckbox = document.getElementById('gameCheckbox');
    if (gameCheckbox && !gameCheckbox.checked) {
        gameCheckbox.checked = true;
        gameCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
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
        // agent create re-serialised the entire proposal store
        // (~10ms per call with a few hundred proposals) — the main culprit
        // behind choppy flyTo / sluggish frames during agent turns.
        if (typeof proposalStorage !== 'undefined' && typeof proposalStorage.beginBatch === 'function') {
            proposalStorage.beginBatch();
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

        window.refreshActivityPanel?.();

        console.log(`Turn ${gameState.currentTurn} completed. ${agents.length} agents acted.`);
    } finally {
        if (agentStorage && typeof agentStorage.endBatch === 'function') {
            agentStorage.endBatch();
        }
        if (typeof proposalStorage !== 'undefined' && typeof proposalStorage.endBatch === 'function') {
            proposalStorage.endBatch();
        }
        // Agents create proposals every turn; the Proposals button's count (and the list button it
        // mirrors) otherwise stayed at its old value until a reload.
        if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton();

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
    window.refreshActivityPanel?.();
    return result;
}

/**
 * Update the Simulation section title (in the Activity sheet) based on current state
 */
function updateGameSectionTitle() {
    const gameCheckbox = document.getElementById('gameCheckbox');
    const gameLabel = document.querySelector('.accordion-section[data-section="game"] [data-section-title="game"]');
    if (!gameLabel) return;

    const i18nApi = (typeof window !== 'undefined') ? window.i18n : null;
    const key = (gameCheckbox && !gameCheckbox.checked && !gameState.isRunning)
        ? 'mapShell.simulation.titlePaused'
        : 'mapShell.simulation.title';

    gameLabel.setAttribute('data-i18n-key', key);
    if (i18nApi && typeof i18nApi.applyTranslations === 'function') {
        i18nApi.applyTranslations(gameLabel);
    } else if (key === 'mapShell.simulation.titlePaused') {
        gameLabel.textContent = 'Simulation (paused)';
    } else {
        gameLabel.textContent = 'Simulation';
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
        // The game calendar is kept in UTC; show that day in the UI language.
        gameTimeElement.textContent = CbFormat.formatDate(this.currentDateTime, { timeZone: 'UTC' });
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

        // Running is the pressed state of the btn toggle (css/primitives.css).
        playPauseBtn.setAttribute('aria-pressed', this.isRunning ? 'true' : 'false');
    }

    // The running dot on the Activity button (js/ui/simulation-indicator.js).
    if (typeof window !== 'undefined' && window.SimulationIndicator) {
        window.SimulationIndicator.sync(document, this);
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

// Activity data adapters for the Activity panel. The panel owns presentation and filter state;
// this module owns source loading, cache metadata, and actions attached to shared activity rows.
let liveAgentActivity = null; // unscoped feed; null = not fetched yet; Refresh clears it
let liveAgentActivityMetadata = null;
const scopedLiveActivityMetadata = new Map();
function activityApiBase() {
    return String(window.getBackendBase()).replace(/\/+$/, '');
}
const scopedLiveActivity = new Map(); // server-filtered feeds keyed by query string
const liveActivityRequests = new Map(); // one in-flight fetch per query, shared by concurrent renders

// A scoped activity query asks the API to filter (it scans a wider window than the 250-event feed),
// so an old agreement's activity is not lost behind newer events.
function liveActivityQuery(filter = {}) {
    const params = new URLSearchParams({ limit: '250' });
    if (filter.actorId) params.set('actor', filter.actorId);
    if (filter.agreementCid) params.set('agreement', filter.agreementCid);
    if (filter.runId) params.set('run', filter.runId);
    if (filter.cityId) params.set('city', filter.cityId);
    return params.toString();
}

async function fetchLiveAgentActivity(filter = {}) {
    const query = liveActivityQuery(filter);
    const unscoped = query === 'limit=250';
    const cached = unscoped ? liveAgentActivity : scopedLiveActivity.get(query);
    if (cached) return cached;
    if (!liveActivityRequests.has(query)) {
        liveActivityRequests.set(query, (async () => {
            const response = await fetch(`${activityApiBase()}/agent/activity?${query}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            const events = Array.isArray(payload.events) ? payload.events : [];
            const metadata = {
                limit: payload.limit ?? 250,
                scanWindow: payload.scanWindow ?? null,
                filters: payload.filters ?? null,
                loadedCount: payload.count ?? events.length
            };
            if (unscoped) {
                liveAgentActivity = events;
                liveAgentActivityMetadata = metadata;
            } else {
                scopedLiveActivity.set(query, events);
                scopedLiveActivityMetadata.set(query, metadata);
            }
            return events;
        })().finally(() => liveActivityRequests.delete(query)));
    }
    return liveActivityRequests.get(query);
}

const activitySource = window.AgentActionEngine.createActivitySource({
    simulation: () => gameState.gameLog,
    live: fetchLiveAgentActivity
});

function clearLiveActivityCache() {
    liveAgentActivity = null;
    liveAgentActivityMetadata = null;
    scopedLiveActivity.clear();
    scopedLiveActivityMetadata.clear();
}

// The Activity panel and inline feed share source loading, cache metadata, and row actions.
window.ActivityData = {
    async load({ filter = {}, refresh = false } = {}) {
        if (refresh) clearLiveActivityCache();
        const normalizedFilter = { ...window.AgentActionEngine.EMPTY_ACTIVITY_FILTER, ...filter };
        const { events, failures } = await activitySource.load(normalizedFilter.source, normalizedFilter);
        const query = liveActivityQuery(normalizedFilter);
        const metadata = normalizedFilter.source === 'simulation'
            ? null
            : query === 'limit=250'
                ? liveAgentActivityMetadata
                : scopedLiveActivityMetadata.get(query) || null;
        return { events, failures, metadata, simulationCount: gameState.gameLog.length };
    },
    bindRowActions() { setupGameLogClickListeners(); },
    openEntity: openActivityEntity,
    apiBase: activityApiBase
};

/** Everything known right now, without fetching; the per-agent log reads this synchronously. */
function allActivityEvents() {
    return window.AgentActionEngine.mergeActivities(
        gameState.gameLog,
        liveAgentActivity || [],
        ...Array.from(scopedLiveActivity.values())
    );
}

// An activity row's agreement or design (ActorExplorer: an .activity-entity-link button, or the
// Actors view's openEntity): an agreement opens in its panel (this device's copy, else read from its
// link's route), a design like a design from the proposal list.
async function openActivityEntity({ type, id } = {}) {
    if (!id) return;
    window.closeActivityPanel?.();
    if (document.querySelector('.agent-dialog-modal') && typeof closeAgentDialog === 'function') closeAgentDialog();
    try {
        if (type === 'agreement') {
            const local = window.AgreementSync.localCopyOf(id);
            if (local) await window.AgreementPanel.open(local.id);
            else await window.AgreementSync.handleAgreementRoute(id);
        } else if (type === 'design') {
            const local = window.DesignSync.localCopyOf(id);
            if (local) showProposalFromLog(local.proposalId);
            else await openServerProposalFromLog(id);
        }
    } catch (error) {
        console.error(`[${new Date().toISOString()}] [activity] the ${type} ${id} could not be opened`, error);
    }
}

// Works wherever a shared row is rendered (the Activity panel or an agent dialog's log).
document.addEventListener('click', event => {
    const button = event.target.closest?.('.activity-entity-link');
    if (!button) return;
    event.preventDefault();
    openActivityEntity({ type: button.dataset.entityType, id: button.dataset.entityId });
});

// Row drill-downs work wherever a shared row is rendered and open the Activity panel with that scope.
document.addEventListener('click', event => {
    const button = event.target.closest?.('[data-activity-scope]');
    if (!button) return;
    event.preventDefault();
    if (button.closest('.agent-dialog-modal') && typeof closeAgentDialog === 'function') closeAgentDialog();
    window.openActivityPanel?.({ filter: { [button.dataset.activityScope]: button.dataset.activityValue } });
});

// `?activity=agreement:<cid>` (or actor:/run:) opens the Activity panel with that scope.
// Wait for translations before opening so the panel can render translated controls.
function openActivityFromUrl() {
    const scope = window.AgentActionEngine.parseActivityLink(new URLSearchParams(window.location.search).get('activity'));
    if (!scope) return;
    const open = () => window.openActivityPanel?.({ filter: scope });
    const probe = 'gameDialogs.log.viewEvents';
    if (typeof window.i18n?.t === 'function' && window.i18n.t(probe) !== probe) open();
    else window.addEventListener('i18n:translationsLoaded', open, { once: true });
}
if (document.readyState === 'complete') openActivityFromUrl();
else window.addEventListener('load', openActivityFromUrl, { once: true });

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

            const inProposalModal = this.closest('.proposal-info-modal');
            if (inProposalModal && typeof closeProposalInfoDialog === 'function') {
                closeProposalInfoDialog();
                // Allow the proposal dialog to close before opening the agent dialog
                setTimeout(() => {
                    showAgentDialog(agentId);
                }, 50);
                return;
            }

            const proposalDetailsPanel = document.getElementById('proposal-details-panel');
            if (proposalDetailsPanel && proposalDetailsPanel.contains(this) && typeof hideProposalDetailsPanel === 'function') {
                hideProposalDetailsPanel();
                setTimeout(() => {
                    showAgentDialog(agentId);
                }, 50);
                return;
            }

            // Activity is a persistent sheet; keep the agent dialog above it when opening a row.
            showAgentDialog(agentId, { elevated: !!this.closest('#activity-sheet') });
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
        openServerProposalFromLog(lookup);
        return;
    }

    // Close overlapping dialogs to surface the proposal details panel
    window.closeActivityPanel?.();
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

// Live activity names proposals that live on the server (agent runs, other people's uploads); they are
// not in this browser until downloaded, so "Open proposal" on them always said "not found". Download
// after the same confirm the search box asks, then open; one the server lacks too is reported.
async function openServerProposalFromLog(lookup) {
    if (!(await showProposalDownloadConfirm())) return;
    let proposal;
    try {
        proposal = await importServerProposal(lookup);
    } catch (error) {
        if (error?.code === 'proposal-in-other-city') {
            // Download consent did not disclose the destination city or the reload.
            await openProposalInItsCity(lookup, error.cityId, { ask: true });
            return;
        }
        console.warn(`[${new Date().toISOString()}] [activity] could not download proposal ${lookup}`, error);
        showGameAlert('proposal_with_id_not_found', 'Proposal with ID {{id}} not found.', { id: lookup });
        return;
    }
    window.closeActivityPanel?.();
    if (document.querySelector('.agent-dialog-modal') && typeof closeAgentDialog === 'function') closeAgentDialog();
    openProposalFromList(getProposalKey(proposal) || lookup, { proposal, closeSheets: true });
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
    // Close the Activity panel to allow better visibility of the parcel.
    window.closeActivityPanel?.();

    // Fold away an open sheet so the parcel is in view
    if (window.MapShell) window.MapShell.closeSheets();
    const isMobile = window.innerWidth < 768;

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
window.dispatchAgentAction = dispatchAgentAction;
window.setupGameLogClickListeners = setupGameLogClickListeners;
window.showProposalFromLog = showProposalFromLog;
window.showProposalInfoDialog = showProposalInfoDialog;
window.closeProposalInfoDialog = closeProposalInfoDialog;
window.showParcelFromLog = showParcelFromLog;
window.updateTurnIntervalDisplay = updateTurnIntervalDisplay;
window.updateTurnInterval = updateTurnInterval;
window.updateProgressBar = updateProgressBar;
window.updateGameSectionTitle = updateGameSectionTitle;

/**
 * Reset the entire game state. If autoReinit is true the game will be initialised again automatically.
 * @param {boolean} autoReinit - Whether to run initializeGame() right after the reset completes.
 */
async function resetGameState(autoReinit = false) {
    const message = autoReinit
        ? translateGameText('gameDialogs.newGameConfirm', 'Are you sure you want to start a NEW game? This will delete all agents, game progress, and parcel ownership data.')
        : translateGameText('gameDialogs.resetConfirm', 'Are you sure you want to reset the game state? This will delete all agents, game progress, and parcel ownership data.');

    // The app's own dialog (js/ui/dialogs.js), never the browser's.
    const confirmed = await window.CbDialog.confirm(message);
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
