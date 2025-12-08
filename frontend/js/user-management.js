// User-as-agent management system
let currentUsername = null;
let currentUserAgent = null;
let selectedAvatarIndex = 0;
let walletDisconnectCleanup = null;
let userWalletBalanceCache = null;
let userWalletBalanceRequestId = 0;

const ATTESTIFY_BASE_URLS = Object.freeze({
    development: 'http://localhost:3000/',
    production: 'https://attestify.network/'
});

function resolveAttestifyBaseUrl() {
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    if (!globalScope) {
        return ATTESTIFY_BASE_URLS.production;
    }

    const pickString = (...candidates) => candidates.find(v => typeof v === 'string' && v.trim());

    const explicit = pickString(
        globalScope.AttestifyNetworbaseUrl,
        globalScope.AttestifyNetworkBaseUrl,
        globalScope.ATTESTIFY_BASE_URL,
        globalScope.ATTESTIFY_URL
    );
    if (explicit) {
        return explicit.trim();
    }

    const hostname = (globalScope.location && typeof globalScope.location.hostname === 'string')
        ? globalScope.location.hostname.toLowerCase()
        : '';
    const isLocalHost = hostname === 'localhost'
        || hostname === '127.0.0.1'
        || hostname === '0.0.0.0'
        || hostname.endsWith('.local');
    const env = globalScope.current_environment || (isLocalHost ? 'development' : 'production');

    if (env === 'development') {
        const devOverride = pickString(
            globalScope.AttestifyNetworkDevBaseUrl,
            globalScope.ATTESTIFY_DEV_BASE_URL,
            globalScope.ATTESTIFY_DEV_URL
        );
        if (devOverride) {
            return devOverride.trim();
        }
        return ATTESTIFY_BASE_URLS.development;
    }

    const prodOverride = pickString(
        globalScope.AttestifyNetworkProdBaseUrl,
        globalScope.ATTESTIFY_PROD_BASE_URL,
        globalScope.ATTESTIFY_PROD_URL
    );
    if (prodOverride) {
        return prodOverride.trim();
    }
    return ATTESTIFY_BASE_URLS.production;
}

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

function chainIdToDecimalString(chainId) {
    const normalized = normalizeChainId(chainId);
    if (!normalized) {
        return null;
    }
    if (normalized.startsWith('0x')) {
        try {
            const decimalValue = parseInt(normalized, 16);
            if (Number.isNaN(decimalValue)) {
                return normalized;
            }
            return String(decimalValue);
        } catch (_) {
            return normalized;
        }
    }
    return normalized;
}

function getChainIconMarkup(chainId) {
    const normalized = normalizeChainId(chainId);
    if (!normalized) {
        return '<i class="fas fa-link"></i>';
    }
    if (normalized === '0x1' || normalized === '0x5' || normalized === '0xaa36a7') {
        return '<i class="fab fa-ethereum"></i>';
    }
    if (normalized === '0x2105' || normalized === '0x14a34') {
        return '<i class="fas fa-layer-group"></i>';
    }
    return '<i class="fas fa-link"></i>';
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

function getI18nApiUM() {
    return (typeof window !== 'undefined' && window.i18n) ? window.i18n : null;
}

function formatStringUM(template, params = {}) {
    if (!template) return '';
    return String(template).replace(/\{\{(\w+)\}\}/g, (match, key) => {
        return Object.prototype.hasOwnProperty.call(params, key) ? params[key] : match;
    });
}

function translateUM(key, fallback, params = {}) {
    const api = getI18nApiUM();
    if (api && typeof api.t === 'function') {
        return api.t(key, params);
    }
    return formatStringUM(fallback, params);
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
        return translateUM('wallet.connect', 'Connect Wallet');
    }
    const state = window.walletManager.getState();
    if (state.status === 'connected' && state.accounts && state.accounts.length > 0) {
        const displayAccount = state.accounts[0];
        return `${displayAccount.slice(0, 6)}...${displayAccount.slice(-4)}`;
    }
    return translateUM('wallet.connect', 'Connect Wallet');
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
        modalButton.title = `${translateUM('wallet.connectedTitle', 'Connected wallet: {{account}}', { account: state.accounts[0] })}\n${translateUM('wallet.disconnectHint', 'Click to disconnect.')}`;
    } else {
        modalButton.classList.remove('connected');
        modalButton.title = translateUM('wallet.connectTitle', 'Connect an Ethereum wallet');
    }
}

function updateAgentDialogChainInfo() {
    const chainInfoContainer = document.querySelector('.wallet-chain-info');
    if (!chainInfoContainer) {
        return;
    }
    const chainInfoParent = chainInfoContainer.parentElement;
    const existingAttestLink = chainInfoParent ? chainInfoParent.querySelector('.wallet-attest-link') : null;

    const state = window.walletManager ? window.walletManager.getState() : null;
    const isConnected = state && state.status === 'connected';
    if (isConnected) {
        const chainId = state.chainId;
        const networkInfo = getNetworkDisplayInfo(chainId, state.status);
        const chainIcon = getChainIconMarkup(chainId);
        const displayName = (currentUserAgent && currentUserAgent.name) || getCurrentUsername() || 'User';
        const accountAddress = (state.accounts && state.accounts[0]) || '';
        const attestBase = resolveAttestifyBaseUrl();
        const hasAccount = Boolean(accountAddress);
        let attestUrl = null;
        if (hasAccount) {
            try {
                const urlObj = new URL(attestBase, typeof window !== 'undefined' && window.location ? window.location.origin : undefined);
                urlObj.searchParams.append('attest', '');
                urlObj.searchParams.set('schemaUid', '0xc5dd5682a31d774cfac30a8f827be296cf0f1fd5d920dea7adb08d6d75ccbfaa');
                urlObj.searchParams.set('targetType', 'address');
                urlObj.searchParams.set('existingOrNew', 'existing');
                urlObj.searchParams.set('eoaAddress', accountAddress);
                urlObj.searchParams.set('MY_NAME_IS', displayName);
                const builtUrl = urlObj.toString();
                attestUrl = builtUrl.replace('attest=', 'attest');
            } catch (err) {
                console.warn('Failed to build Attestify URL', err);
            }
        }
        const attestTitle = `Attest ${displayName} is connected to the address`;

        chainInfoContainer.innerHTML = `
            <div class="wallet-chain-label">
                ${chainIcon}
                <span>${networkInfo.text}</span>
                <i class="fas fa-chevron-down wallet-chain-caret" aria-hidden="true"></i>
            </div>
        `;
        let attestLink = existingAttestLink;
        if (!attestLink && chainInfoParent && attestUrl) {
            attestLink = document.createElement('a');
            attestLink.className = 'wallet-attest-link';
            chainInfoParent.insertBefore(attestLink, chainInfoContainer.nextSibling);
        }
        if (attestLink && attestUrl) {
            attestLink.href = attestUrl;
            attestLink.target = '_blank';
            attestLink.rel = 'noopener noreferrer';
            attestLink.textContent = '📝';
            attestLink.title = attestTitle;
            attestLink.setAttribute('aria-label', attestTitle);
        } else if (existingAttestLink && chainInfoParent) {
            chainInfoParent.removeChild(existingAttestLink);
        }

        chainInfoContainer.title = `${networkInfo.tooltip}\nClick to switch network`;
        chainInfoContainer.style.display = 'flex';
        chainInfoContainer.setAttribute('role', 'button');
        chainInfoContainer.setAttribute('tabindex', '0');
        chainInfoContainer.dataset.chainId = normalizeChainId(chainId) || '';
        chainInfoContainer.onclick = openChainSelectionModal;
        chainInfoContainer.onkeydown = (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openChainSelectionModal();
            }
        };
    } else {
        chainInfoContainer.innerHTML = '';
        chainInfoContainer.style.display = 'none';
        chainInfoContainer.removeAttribute('role');
        chainInfoContainer.removeAttribute('tabindex');
        chainInfoContainer.onclick = null;
        chainInfoContainer.onkeydown = null;
        if (existingAttestLink && chainInfoParent) {
            chainInfoParent.removeChild(existingAttestLink);
        }
    }
}

async function getAvailableChainOptions() {
    const options = new Map();
    const addChain = (chainId) => {
        const normalizedHex = normalizeChainId(chainId);
        if (!normalizedHex || options.has(normalizedHex)) {
            return;
        }
        const networkInfo = getNetworkDisplayInfo(normalizedHex, 'connected');
        options.set(normalizedHex, {
            chainIdHex: normalizedHex,
            chainIdDec: chainIdToDecimalString(normalizedHex),
            label: networkInfo.text,
            tooltip: networkInfo.tooltip,
            isKnownNetwork: networkInfo.isKnownNetwork
        });
    };

    const state = window.walletManager && typeof window.walletManager.getState === 'function'
        ? window.walletManager.getState()
        : null;

    if (window.ContractsLoader && typeof window.ContractsLoader.loadContracts === 'function') {
        try {
            const contracts = await window.ContractsLoader.loadContracts();
            Object.keys(contracts || {}).forEach(addChain);
        } catch (err) {
            console.warn('Failed to load contracts for chain selection', err);
        }
    }

    if (options.size === 0) {
        try {
            const resp = await fetch('/contracts/addresses.json');
            if (resp && resp.ok) {
                const data = await resp.json();
                Object.keys(data || {}).forEach(addChain);
            }
        } catch (err) {
            console.warn('addresses.json chain discovery failed', err);
        }
    }

    if (window.DEFAULT_CHAIN_ID !== undefined && window.DEFAULT_CHAIN_ID !== null) {
        addChain(window.DEFAULT_CHAIN_ID);
    }

    if (state && state.chainId) {
        addChain(state.chainId);
    }

    if (options.size === 0 && NETWORK_LABELS) {
        Object.keys(NETWORK_LABELS).forEach(addChain);
    }

    return Array.from(options.values()).sort((a, b) => a.label.localeCompare(b.label));
}

function closeChainSelectionModal() {
    const overlay = document.querySelector('.chain-modal-overlay');
    if (overlay && overlay.parentElement) {
        overlay.parentElement.removeChild(overlay);
    }
}

async function requestChainSwitch(chainIdHex, overlay) {
    const errorNode = overlay ? overlay.querySelector('[data-chain-modal-error]') : null;
    const buttons = overlay ? overlay.querySelectorAll('[data-chain-id]') : [];
    buttons.forEach(btn => { btn.disabled = true; });
    if (errorNode) {
        errorNode.textContent = 'Requesting network change...';
        errorNode.classList.add('visible');
        errorNode.classList.remove('error');
    }

    if (!window.walletManager || typeof window.walletManager.switchChain !== 'function') {
        if (errorNode) {
            errorNode.textContent = 'Connect a wallet to switch networks.';
            errorNode.classList.add('error');
        } else if (window.showStyledAlert) {
            window.showStyledAlert('Connect a wallet to switch networks.');
        }
        buttons.forEach(btn => { btn.disabled = false; });
        return;
    }

    try {
        await window.walletManager.switchChain(chainIdHex);
        closeChainSelectionModal();
    } catch (err) {
        const message = err && err.message ? err.message : 'Failed to switch network.';
        if (errorNode) {
            errorNode.textContent = message;
            errorNode.classList.add('visible');
            errorNode.classList.add('error');
        } else if (window.showStyledAlert) {
            window.showStyledAlert(message);
        }
    } finally {
        buttons.forEach(btn => { btn.disabled = false; });
    }
}

async function openChainSelectionModal() {
    if (!window.walletManager || typeof window.walletManager.getState !== 'function') {
        if (window.showStyledAlert) {
            window.showStyledAlert('Connect a wallet to select a network.');
        }
        return;
    }

    const chainOptions = await getAvailableChainOptions();
    if (!chainOptions.length) {
        if (window.showStyledAlert) {
            window.showStyledAlert('No chains are configured for this app.');
        }
        return;
    }

    closeChainSelectionModal();

    const state = window.walletManager.getState();
    const currentChainHex = normalizeChainId(state ? state.chainId : null);

    const overlay = document.createElement('div');
    overlay.className = 'wallet-modal-overlay chain-modal-overlay';
    overlay.setAttribute('tabindex', '-1');
    overlay.innerHTML = `
        <div class="wallet-modal chain-modal" role="dialog" aria-modal="true">
            <div class="wallet-modal-header">
                <h2>Select Chain</h2>
                <button type="button" class="wallet-modal-close close-circle-btn close-circle-btn--lg" aria-label="Close chain selection" data-chain-modal-close>&times;</button>
            </div>
            <div class="wallet-modal-body">
                <div class="wallet-modal-description">Choose a network and we will ask your wallet to switch.</div>
                <div class="wallet-options chain-options-list">
                    ${chainOptions.map(option => {
        const isCurrent = currentChainHex && normalizeChainId(option.chainIdHex) === currentChainHex;
        const subtitle = option.chainIdDec ? `Chain ID: ${option.chainIdDec}` : `Chain ID: ${option.chainIdHex}`;
        return `
                            <button type="button" class="wallet-option chain-option${isCurrent ? ' chain-option--current' : ''}" data-chain-id="${option.chainIdHex}">
                                <div class="wallet-option-placeholder chain-option-icon">${getChainIconMarkup(option.chainIdHex)}</div>
                                <div class="wallet-option-meta">
                                    <div class="wallet-option-name">
                                        ${option.label}
                                        ${isCurrent ? '<span class="chain-current-badge">Current</span>' : ''}
                                    </div>
                                    <div class="wallet-option-origin">${subtitle}</div>
                                </div>
                            </button>
                        `;
    }).join('')}
                </div>
                <div class="wallet-modal-error chain-modal-error" data-chain-modal-error></div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    overlay.focus({ preventScroll: true });

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
            closeChainSelectionModal();
        }
    });

    const closeButton = overlay.querySelector('[data-chain-modal-close]');
    if (closeButton) {
        closeButton.addEventListener('click', closeChainSelectionModal);
    }

    overlay.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            closeChainSelectionModal();
        }
    });

    overlay.addEventListener('click', event => {
        const button = event.target.closest('[data-chain-id]');
        if (!button) {
            return;
        }
        const targetChainId = button.getAttribute('data-chain-id');
        if (!targetChainId) {
            return;
        }
        requestChainSwitch(targetChainId, overlay);
    });
}

async function showWalletDisconnectConfirmation() {
    const confirmDisconnect = await window.showStyledConfirm('Disconnect the current wallet?');
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
        refreshUserEthBalanceDisplay();
    }));

    disposers.push(window.walletManager.on('connect', ({ state }) => {
        updateWalletButtonDisplay();
        updateUsernameDisplay();
        refreshUserEthBalanceDisplay();
        attachWalletToUserAgent(state);
    }));

    disposers.push(window.walletManager.on('disconnect', () => {
        updateWalletButtonDisplay();
        updateUsernameDisplay();
        refreshUserEthBalanceDisplay();
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
        refreshUserEthBalanceDisplay();
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
    refreshUserEthBalanceDisplay();
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

function formatEthBalanceForDisplay(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '-';
    if (num === 0) return '0';
    if (num >= 1) return num.toFixed(2);
    return num.toFixed(4);
}

function setUserEthBalanceDisplay(displayText) {
    const balanceNodes = document.querySelectorAll('[data-user-eth-balance], [data-user-eth-balance-table]');
    balanceNodes.forEach(node => {
        node.textContent = displayText;
    });
}

function setUserTotalWealthDisplay(balanceEth) {
    const totalNode = document.querySelector('[data-user-total-wealth]');
    if (!totalNode) {
        return;
    }
    if (!Number.isFinite(balanceEth)) {
        totalNode.textContent = '-';
        return;
    }
    const portfolioAttr = totalNode.getAttribute('data-portfolio-value');
    const hasPortfolio = portfolioAttr !== null && portfolioAttr !== '';
    const portfolioValue = hasPortfolio ? Number(portfolioAttr) : NaN;
    const total = (Number.isFinite(portfolioValue) ? portfolioValue : 0) + balanceEth;
    totalNode.textContent = `${total.toFixed(2)} ETH`;
}

async function readConnectedWalletEthBalance(walletState) {
    const state = walletState || (window.walletManager ? window.walletManager.getState() : null);
    if (!state || state.status !== 'connected' || !state.accounts || state.accounts.length === 0) {
        throw new Error('Wallet is not connected.');
    }
    if (!window.walletManager || typeof window.walletManager.getProvider !== 'function') {
        throw new Error('No wallet provider available.');
    }
    const walletProvider = window.walletManager.getProvider();
    if (!walletProvider) {
        throw new Error('No wallet provider available.');
    }
    if (!window.ethers || !window.ethers.BrowserProvider || !window.ethers.formatEther) {
        throw new Error('Blockchain library not available.');
    }
    const provider = new window.ethers.BrowserProvider(walletProvider);
    const balanceWei = await provider.getBalance(state.accounts[0]);
    const balanceEth = Number(window.ethers.formatEther(balanceWei));
    return balanceEth;
}

async function refreshUserEthBalanceDisplay() {
    const hasTargets = document.querySelector('[data-user-eth-balance]') ||
        document.querySelector('[data-user-eth-balance-table]') ||
        document.querySelector('[data-user-total-wealth]');
    if (!hasTargets) {
        return;
    }

    const state = window.walletManager ? window.walletManager.getState() : null;
    const isConnected = state && state.status === 'connected' && state.accounts && state.accounts.length > 0;
    if (!isConnected) {
        userWalletBalanceCache = null;
        setUserEthBalanceDisplay('-');
        setUserTotalWealthDisplay(NaN);
        return;
    }

    const requestId = ++userWalletBalanceRequestId;
    try {
        const balanceEth = await readConnectedWalletEthBalance(state);
        if (requestId !== userWalletBalanceRequestId) {
            return;
        }
        userWalletBalanceCache = balanceEth;
        const formatted = formatEthBalanceForDisplay(balanceEth);
        const displayText = formatted === '-' ? '-' : `${formatted} ETH`;
        setUserEthBalanceDisplay(displayText);
        setUserTotalWealthDisplay(balanceEth);
    } catch (err) {
        if (requestId !== userWalletBalanceRequestId) {
            return;
        }
        console.warn('Failed to refresh wallet balance', err);
        userWalletBalanceCache = null;
        setUserEthBalanceDisplay('-');
        setUserTotalWealthDisplay(NaN);
    }
}

function attachWalletToUserAgent(walletState) {
    if (!currentUserAgent || !walletState || !walletState.accounts || walletState.accounts.length === 0) {
        return;
    }

    // We no longer track wallet addresses on the agent; header shows the active wallet
}

function detachWalletFromUserAgent() {
    if (!currentUserAgent) {
        return;
    }

    const agent = agentStorage.getAgent(currentUserAgent.id);
    if (!agent) {
        return;
    }

    // No address tracking to clear; just reset cached balance
    userWalletBalanceCache = null;
    refreshUserEthBalanceDisplay();
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
window.refreshUserEthBalanceDisplay = refreshUserEthBalanceDisplay;