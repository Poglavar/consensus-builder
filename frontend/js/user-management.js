// User-as-agent management system
let currentUsername = null;
let currentUserAgent = null;
let selectedAvatarIndex = 0;
let walletDisconnectCleanup = null;

const NETWORK_LABELS = {
    '0x1': { label: 'Ethereum Mainnet', shortLabel: 'Mainnet' },
    '0x5': { label: 'Ethereum Goerli', shortLabel: 'Goerli' },
    '0xaa36a7': { label: 'Ethereum Sepolia', shortLabel: 'Sepolia' },
    '0x539': { label: 'Hardhat (Chain 1337)', shortLabel: 'Hardhat' },
    '0x7a69': { label: 'Hardhat (Chain 31337)', shortLabel: 'Hardhat' },
    '0x2105': { label: 'Base', shortLabel: 'Base' },
    '0x14a34': { label: 'Base Sepolia', shortLabel: 'Base Sepolia' }
};

function normalizeChainId(chainId) {
    if (chainId === null || chainId === undefined) {
        return null;
    }
    if (typeof chainId === 'string') {
        const trimmed = chainId.trim();
        if (!trimmed) {
            return null;
        }
        if (trimmed.startsWith('0x') || trimmed.startsWith('0X')) {
            return `0x${trimmed.slice(2).toLowerCase()}`;
        }
        const decimal = Number(trimmed);
        if (!Number.isNaN(decimal)) {
            return `0x${decimal.toString(16)}`;
        }
        return trimmed.toLowerCase();
    }
    if (typeof chainId === 'number') {
        if (!Number.isFinite(chainId)) {
            return null;
        }
        return `0x${chainId.toString(16)}`;
    }
    if (typeof chainId === 'bigint') {
        return `0x${chainId.toString(16)}`;
    }
    return null;
}

function getNetworkDisplayInfo(chainId, status) {
    const normalized = normalizeChainId(chainId);
    const isConnected = status === 'connected';

    if (!normalized) {
        if (isConnected) {
            return {
                text: 'Unknown network',
                tooltip: 'Wallet connected but did not provide a chain id.',
                isConnected: true,
                isKnownNetwork: false,
                chainId: ''
            };
        }
        return {
            text: 'Not connected',
            tooltip: 'No wallet is currently connected.',
            isConnected: false,
            isKnownNetwork: false,
            chainId: ''
        };
    }

    const mapping = NETWORK_LABELS[normalized];
    if (mapping) {
        return {
            text: mapping.shortLabel || mapping.label,
            tooltip: `${mapping.label} (${normalized})`,
            isConnected,
            isKnownNetwork: true,
            chainId: normalized
        };
    }

    return {
        text: `Chain ${normalized}`,
        tooltip: `Wallet connected to unknown chain id ${normalized}.`,
        isConnected,
        isKnownNetwork: false,
        chainId: normalized
    };
}

// Notification system for tracking unseen proposals
const userNotifications = {
    unseenProposals: new Set(),

    // Add a proposal to unseen list if it affects user's parcels
    addProposalIfRelevant(proposalHash, proposal) {
        const userAgent = getCurrentUserAgent();
        if (!userAgent) return;

        const userParcelIds = getAgentOwnedParcels(userAgent.id);
        const hasUserParcel = proposal.parcelIds.some(parcelId =>
            userParcelIds.includes(parcelId)
        );

        if (hasUserParcel) {
            this.unseenProposals.add(proposalHash);
            this.save();
            updateUsernameDisplay(); // Update badge
        }
    },

    // Mark a proposal as seen
    markProposalAsSeen(proposalHash) {
        if (this.unseenProposals.has(proposalHash)) {
            this.unseenProposals.delete(proposalHash);
            this.save();
            updateUsernameDisplay(); // Update badge
            return true;
        }
        return false;
    },

    // Get unseen proposal count
    getUnseenCount() {
        return this.unseenProposals.size;
    },

    // Get all unseen proposals
    getUnseenProposals() {
        return Array.from(this.unseenProposals);
    },

    // Clear all unseen proposals
    clearAll() {
        this.unseenProposals.clear();
        this.save();
        updateUsernameDisplay();
    },

    // Save to PersistentStorage
    save() {
        PersistentStorage.setItem('user_notifications', JSON.stringify({
            unseenProposals: Array.from(this.unseenProposals)
        }));
    },

    // Load from PersistentStorage
    load() {
        try {
            const data = PersistentStorage.getItem('user_notifications');
            if (data) {
                const parsed = JSON.parse(data);
                this.unseenProposals = new Set(parsed.unseenProposals || []);
            }
        } catch (error) {
            console.error('Error loading user notifications:', error);
            this.unseenProposals = new Set();
        }
    }
};

// Check for user agent on page load and show welcome modal if needed
function initializeUser() {
    // Check if user has an existing agent
    const userAgent = getCurrentUserAgent();
    if (userAgent) {
        currentUserAgent = userAgent;
        currentUsername = userAgent.name;
        updateUsernameDisplay();
        // Auto-start game for returning users
        autoStartGame();
        initializeWalletIntegration();
    } else {
        // Check for legacy username storage and clear it
        const legacyUsername = PersistentStorage.getItem('userName');
        if (legacyUsername) {
            PersistentStorage.removeItem('userName');
        }
        showWelcomeModal();
    }
}

// Auto-start game functionality disabled: game starts only when user clicks Play
function autoStartGame() {
    // Intentionally no-op to prevent automatic game start
    return;
}

// Show welcome modal for new users
function showWelcomeModal() {
    const modal = document.getElementById('welcome-modal');
    modal.style.display = 'flex';

    // Initialize avatar selection
    initializeAvatarSelection();

    // Setup event listeners
    setupWelcomeModalEventListeners();

    // Focus on the input field
    setTimeout(() => {
        document.getElementById('username-input').focus();
    }, 100);
}

// Hide welcome modal
function hideWelcomeModal() {
    const modal = document.getElementById('welcome-modal');
    modal.style.display = 'none';

    // Hide takeover section
    const takeoverSection = document.getElementById('takeover-section');
    takeoverSection.style.display = 'none';
}

// Initialize avatar selection UI
function initializeAvatarSelection() {
    const avatarOptions = document.getElementById('avatar-options');
    const usedAvatars = new Set();

    // Get used avatar indices from existing agents
    if (typeof agentStorage !== 'undefined') {
        const agents = agentStorage.getAllAgents();
        agents.forEach(agent => usedAvatars.add(agent.avatarIndex));
    }

    // Clear existing options
    avatarOptions.innerHTML = '';

    // Create avatar options (avatar0.png to avatar15.png)
    for (let i = 0; i < 16; i++) {
        const option = document.createElement('div');
        option.className = 'avatar-option';
        if (usedAvatars.has(i)) {
            option.classList.add('used');
            option.title = 'Avatar already in use';
        } else {
            option.addEventListener('click', () => selectAvatar(i));
        }

        const img = document.createElement('img');
        img.src = `avatars/avatar${i}.png`;
        img.alt = `Avatar ${i}`;
        option.appendChild(img);

        if (i === selectedAvatarIndex) {
            option.classList.add('selected');
        }

        avatarOptions.appendChild(option);
    }

    // Set initial selected avatar display
    updateSelectedAvatarDisplay();
}

// Select an avatar
function selectAvatar(index) {
    selectedAvatarIndex = index;
    updateSelectedAvatarDisplay();

    // Update selection in options
    const options = document.querySelectorAll('.avatar-option');
    options.forEach((option, i) => {
        option.classList.toggle('selected', i === index);
    });

    // Hide avatar options
    document.getElementById('avatar-options').style.display = 'none';
}

// Update selected avatar display
function updateSelectedAvatarDisplay() {
    const img = document.getElementById('selected-avatar-img');
    const hint = document.querySelector('.avatar-selection-hint');

    img.src = `avatars/avatar${selectedAvatarIndex}.png`;
    hint.textContent = `Avatar ${selectedAvatarIndex} selected`;
}

// Show avatar options
function showAvatarOptions() {
    const options = document.getElementById('avatar-options');
    const isVisible = options.style.display !== 'none';
    options.style.display = isVisible ? 'none' : 'block';

    if (!isVisible) {
        initializeAvatarSelection(); // Refresh available avatars
    }
}

// Setup welcome modal event listeners
function setupWelcomeModalEventListeners() {
    const usernameInput = document.getElementById('username-input');
    const takeoverYesBtn = document.getElementById('takeover-yes-btn');
    const takeoverNoBtn = document.getElementById('takeover-no-btn');

    // Check for existing agent when typing
    usernameInput.addEventListener('input', handleUsernameInput);

    // Takeover event listeners
    takeoverYesBtn.addEventListener('click', handleTakeoverYes);
    takeoverNoBtn.addEventListener('click', handleTakeoverNo);
}

// Handle username input changes
function handleUsernameInput(event) {
    const username = event.target.value.trim();
    const takeoverSection = document.getElementById('takeover-section');

    if (username && typeof agentStorage !== 'undefined') {
        const agents = agentStorage.getAllAgents();
        const existingAgent = agents.find(agent => agent.name.toLowerCase() === username.toLowerCase());

        if (existingAgent) {
            // Show takeover section
            const message = document.getElementById('takeover-message');
            message.innerHTML = `Taking over agent <a href="#" onclick="showAgentDialog('${existingAgent.id}')">${existingAgent.name}</a> (Yes/No)`;
            takeoverSection.style.display = 'block';
            takeoverSection.dataset.agentId = existingAgent.id;
        } else {
            takeoverSection.style.display = 'none';
        }
    } else {
        takeoverSection.style.display = 'none';
    }
}

// Handle takeover yes
function handleTakeoverYes() {
    const takeoverSection = document.getElementById('takeover-section');
    const agentId = takeoverSection.dataset.agentId;
    const usernameInput = document.getElementById('username-input');

    if (agentId && typeof setUserControlledAgent === 'function') {
        // Set agent as user controlled
        setUserControlledAgent(agentId, true);

        // Get the agent and set current user
        const agent = agentStorage.getAgent(agentId);
        currentUserAgent = agent;
        currentUsername = agent.name;

        // Update username display
        updateUsernameDisplay();

        // Hide modal
        hideWelcomeModal();

        // Show success message
        if (typeof showEphemeralMessage === 'function') {
            showEphemeralMessage(`Welcome back, ${agent.name}! You've taken control of your agent.`);
        }

        // Add to game log
        if (typeof gameState !== 'undefined') {
            gameState.addLogEntry(`${agent.name} logged in and took control of their agent.`);
        }

        // Auto-start game
        autoStartGame();

        initializeWalletIntegration();
    }
}

// Handle takeover no
function handleTakeoverNo() {
    const usernameInput = document.getElementById('username-input');
    usernameInput.value = '';
    usernameInput.focus();

    const takeoverSection = document.getElementById('takeover-section');
    takeoverSection.style.display = 'none';
}

// Handle username form submission
function submitUsername(event) {
    event.preventDefault();

    const usernameInput = document.getElementById('username-input');
    const username = usernameInput.value.trim();
    const takeoverSection = document.getElementById('takeover-section');

    if (!username) {
        return;
    }

    // Check if in takeover mode
    if (takeoverSection.style.display !== 'none') {
        // User needs to decide on takeover first
        return;
    }

    // Create new user agent
    if (typeof createUserAgent === 'function') {
        const userAgent = createUserAgent(username, selectedAvatarIndex);
        agentStorage.addAgent(userAgent);

        currentUserAgent = userAgent;
        currentUsername = username;

        // Update the username display
        updateUsernameDisplay();

        // Hide the modal
        hideWelcomeModal();

        // Show a welcome message
        if (typeof showEphemeralMessage === 'function') {
            showEphemeralMessage(`Welcome, ${username}! You're now part of the consensus building community.`);
        }

        // Add to game log
        if (typeof gameState !== 'undefined') {
            gameState.addLogEntry(`${username} joined the community as a new agent.`);
        }

        // Auto-start game for new users
        autoStartGame();

        initializeWalletIntegration();
    }
}

// Update the username display in the top right corner
function updateUsernameDisplay() {
    const usernameDisplay = document.getElementById('username-display');
    if (usernameDisplay && currentUserAgent) {
        const unseenCount = userNotifications.getUnseenCount();
        const badgeHtml = unseenCount > 0 ?
            `<span class="notification-badge">${unseenCount}</span>` : '';

        // Get wallet status for icon
        const walletState = window.walletManager ? window.walletManager.getState() : null;
        const isConnected = walletState && walletState.status === 'connected';
        const statusIcon = isConnected 
            ? '<span class="wallet-status-icon connected" title="Wallet connected">🔗</span>'
            : '<span class="wallet-status-icon disconnected" title="Wallet disconnected">⛓️‍💥</span>';

        // Replace content with avatar, name, and status icon
        usernameDisplay.innerHTML = `
            <img src="${getAvatarImagePath(currentUserAgent.avatarIndex)}" alt="Avatar" class="user-avatar">
            <span id="username-text">${currentUserAgent.name}</span>
            ${statusIcon}
            ${badgeHtml}
        `;

        // Add click handler to show agent dialog
        usernameDisplay.onclick = () => {
            if (typeof showAgentDialog === 'function') {
                showAgentDialog(currentUserAgent.id);
            }
        };

        // No longer need network indicator or wallet button in bubble
    }
}

// Show logout modal
function showLogoutModal() {
    const modal = document.getElementById('logout-modal');
    modal.style.display = 'flex';

    // Setup event listeners
    setupLogoutModalEventListeners();
}

// Hide logout modal
function hideLogoutModal() {
    const modal = document.getElementById('logout-modal');
    modal.style.display = 'none';
}

// Setup logout modal event listeners
function setupLogoutModalEventListeners() {
    const aiBtn = document.getElementById('logout-ai-btn');
    const inactiveBtn = document.getElementById('logout-inactive-btn');
    const cancelBtn = document.getElementById('logout-cancel-btn');

    aiBtn.onclick = () => handleLogout(true);
    inactiveBtn.onclick = () => handleLogout(false);
    cancelBtn.onclick = hideLogoutModal;
}

// Handle logout with choice
function handleLogout(letAIRun) {
    if (currentUserAgent && typeof agentStorage !== 'undefined') {
        // Update agent flags
        agentStorage.updateAgent(currentUserAgent.id, {
            userControlled: false,
            aiControlled: letAIRun
        });

        // Add to game log
        if (typeof gameState !== 'undefined') {
            const action = letAIRun ? 'AI will now control the agent' : 'agent is now inactive';
            gameState.addLogEntry(`${currentUserAgent.name} logged out - ${action}.`);
        }

        detachWalletFromUserAgent();
        if (window.walletManager) {
            window.walletManager.disconnect({ triggeredByProvider: false });
        }
        if (walletDisconnectCleanup) {
            walletDisconnectCleanup();
            walletDisconnectCleanup = null;
        }

        // Clear current user
        currentUserAgent = null;
        currentUsername = null;

        // Hide logout modal
        hideLogoutModal();

        // Close agent dialog if it's open (since user is no longer viewing their own agent)
        if (typeof closeAgentDialog === 'function') {
            closeAgentDialog();
        }

        // Show welcome modal again
        showWelcomeModal();

        // Show message
        if (typeof showEphemeralMessage === 'function') {
            const message = letAIRun ? 'Logged out. AI will control your agent.' : 'Logged out. Agent is now inactive.';
            showEphemeralMessage(message);
        }
    }
}

// Get current username (for use in other parts of the app)
function getCurrentUsername() {
    return currentUsername || '';
}

// Get current user agent
function getCurrentUserAgent() {
    if (typeof agentStorage !== 'undefined') {
        const agents = agentStorage.getAllAgents();
        return agents.find(agent => agent.userControlled === true);
    }
    return null;
}

// Add user action to game log
function addUserActionToGameLog(message) {
    if (typeof gameState !== 'undefined') {
        gameState.addLogEntry(message, true); // true indicates user action
    }
}

// Removed ensureWalletButton - button is now only in the dialog

// Removed ensureNetworkIndicator - network info is now only in the dialog

function handleWalletButtonClick() {
    if (!window.walletManager) {
        console.warn('Wallet manager is not available.');
        return;
    }
    const state = window.walletManager.getState();
    if (state.status === 'connected') {
        showWalletDisconnectConfirmation();
    } else {
        window.walletManager.openConnectorModal();
    }
}

function updateWalletButtonDisplay() {
    // Update the bubble status icon
    updateUsernameDisplay();
    // Update the dialog button and chain info
    updateAgentDialogWalletButton();
    updateAgentDialogChainInfo();
}

function renderWalletButtonLabel() {
    if (!window.walletManager) {
        return 'Connect Wallet';
    }
    const state = window.walletManager.getState();
    if (state.status === 'connected' && state.accounts && state.accounts.length > 0) {
        const displayAccount = state.accounts[0];
        return `${displayAccount.slice(0, 6)}...${displayAccount.slice(-4)}`;
    }
    return 'Connect Wallet';
}

function updateAgentDialogWalletButton() {
    const modalButton = document.querySelector('.wallet-connect-button');
    if (!modalButton) {
        return;
    }
    modalButton.textContent = renderWalletButtonLabel();
    const state = window.walletManager ? window.walletManager.getState() : null;
    if (state && state.status === 'connected' && state.accounts && state.accounts.length > 0) {
        modalButton.classList.add('connected');
        modalButton.title = `Connected wallet: ${state.accounts[0]}\nClick to disconnect.`;
    } else {
        modalButton.classList.remove('connected');
        modalButton.title = 'Connect an Ethereum wallet';
    }
}

function updateAgentDialogChainInfo() {
    const chainInfoContainer = document.querySelector('.wallet-chain-info');
    if (!chainInfoContainer) {
        return;
    }

    const state = window.walletManager ? window.walletManager.getState() : null;
    if (state && state.status === 'connected') {
        const chainId = state.chainId;
        const networkInfo = getNetworkDisplayInfo(chainId, state.status);
        
        // Get chain icon (using Font Awesome or simple emoji)
        let chainIcon = '<i class="fas fa-link"></i>';
        if (networkInfo.isKnownNetwork) {
            // Use different icons for different networks
            const normalized = normalizeChainId(chainId);
            if (normalized === '0x1' || normalized === '0x5' || normalized === '0xaa36a7') {
                chainIcon = '<i class="fab fa-ethereum"></i>';
            } else if (normalized === '0x2105' || normalized === '0x14a34') {
                chainIcon = '<i class="fas fa-layer-group"></i>';
            }
        }

        chainInfoContainer.innerHTML = `
            <div class="wallet-chain-label">
                ${chainIcon}
                <span>${networkInfo.text}</span>
            </div>
        `;
        chainInfoContainer.title = networkInfo.tooltip;
        chainInfoContainer.style.display = 'flex';
    } else {
        chainInfoContainer.style.display = 'none';
    }
}

function showWalletDisconnectConfirmation() {
    const confirmDisconnect = window.confirm('Disconnect the current wallet?');
    if (!confirmDisconnect) {
        return;
    }
    if (!window.walletManager) return;
    window.walletManager.disconnect();
}

function initializeWalletIntegration() {
    if (!window.walletManager) {
        return;
    }

    if (walletDisconnectCleanup) {
        walletDisconnectCleanup();
        walletDisconnectCleanup = null;
    }

    const disposers = [];

    disposers.push(window.walletManager.on('stateChanged', () => {
        updateWalletButtonDisplay();
        updateUsernameDisplay();
    }));

    disposers.push(window.walletManager.on('connect', ({ state }) => {
        updateWalletButtonDisplay();
        updateUsernameDisplay();
        attachWalletToUserAgent(state);
    }));

    disposers.push(window.walletManager.on('disconnect', () => {
        updateWalletButtonDisplay();
        updateUsernameDisplay();
        detachWalletFromUserAgent();
    }));

    disposers.push(window.walletManager.on('accountsChanged', ({ accounts }) => {
        updateWalletButtonDisplay();
        updateUsernameDisplay();
        if (accounts && accounts.length) {
            attachWalletToUserAgent(window.walletManager.getState());
        } else {
            detachWalletFromUserAgent();
        }
    }));

    walletDisconnectCleanup = () => {
        disposers.forEach(dispose => {
            try {
                dispose();
            } catch (err) {
                console.warn('Wallet listener cleanup failed', err);
            }
        });
    };

    updateWalletButtonDisplay();
    updateUsernameDisplay();
}

function updateNetworkIndicator(walletState) {
    const indicator = document.getElementById('wallet-network-indicator');
    if (!indicator) {
        return;
    }

    const state = walletState || (window.walletManager ? window.walletManager.getState() : null);
    const chainId = state ? state.chainId : null;
    const status = state ? state.status : 'idle';
    const info = getNetworkDisplayInfo(chainId, status);

    indicator.textContent = info.text;
    indicator.title = info.tooltip;
    indicator.dataset.chainId = info.chainId || '';

    indicator.classList.remove('connected', 'disconnected', 'unknown-network');
    if (info.isConnected) {
        indicator.classList.add(info.isKnownNetwork ? 'connected' : 'unknown-network');
    } else {
        indicator.classList.add('disconnected');
    }
}

function attachWalletToUserAgent(walletState) {
    if (!currentUserAgent || !walletState || !walletState.accounts || walletState.accounts.length === 0) {
        return;
    }

    const account = walletState.accounts[0];
    const agent = agentStorage.getAgent(currentUserAgent.id);
    if (!agent) {
        return;
    }

    const existing = new Set(agent.walletAddresses || []);
    if (!existing.has(account)) {
        existing.add(account);
        agentStorage.updateAgent(agent.id, {
            walletAddresses: Array.from(existing)
        });
        currentUserAgent.walletAddresses = Array.from(existing);
    }
}

function detachWalletFromUserAgent() {
    if (!currentUserAgent) {
        return;
    }

    const agent = agentStorage.getAgent(currentUserAgent.id);
    if (!agent) {
        return;
    }

    agentStorage.updateAgent(agent.id, {
        walletAddresses: []
    });
    currentUserAgent.walletAddresses = [];
}

// Initialize user notifications on page load
function initializeNotifications() {
    userNotifications.load();
    updateUsernameDisplay(); // Update display with any existing badges
}

// Make functions globally available
window.initializeUser = initializeUser;
window.autoStartGame = autoStartGame;
window.showWelcomeModal = showWelcomeModal;
window.hideWelcomeModal = hideWelcomeModal;
window.submitUsername = submitUsername;
window.updateUsernameDisplay = updateUsernameDisplay;
window.getCurrentUsername = getCurrentUsername;
window.getCurrentUserAgent = getCurrentUserAgent;
window.showAvatarOptions = showAvatarOptions;
window.showLogoutModal = showLogoutModal;
window.hideLogoutModal = hideLogoutModal;
window.addUserActionToGameLog = addUserActionToGameLog;
window.userNotifications = userNotifications;
window.initializeNotifications = initializeNotifications;
window.handleWalletButtonClick = handleWalletButtonClick;
window.renderWalletButtonLabel = renderWalletButtonLabel;
window.updateAgentDialogWalletButton = updateAgentDialogWalletButton;
window.updateAgentDialogChainInfo = updateAgentDialogChainInfo;