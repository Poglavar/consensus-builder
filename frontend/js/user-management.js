// User-as-agent management system
let currentUsername = null;
let currentUserAgent = null;
let selectedAvatarIndex = 0;
let walletDisconnectCleanup = null;
let userWalletBalanceCache = null;
let userWalletBalanceRequestId = 0;

const MAX_USER_AVATAR_COUNT = 16;

const ATTESTIFY_BASE_URLS = Object.freeze({
    development: 'http://localhost:3000/',
    production: 'https://attestify.network/'
});

function isProposalDeepLinkPath() {
    try {
        const path = (typeof window !== 'undefined' && window.location && window.location.pathname) ? window.location.pathname : '';
        return /^\/proposals\/\d+(?:\/)?$/.test(path);
    } catch (_) {
        return false;
    }
}

function pickAvailableAvatarIndex() {
    const used = (typeof agentStorage !== 'undefined' && agentStorage.getAllAgents)
        ? new Set(agentStorage.getAllAgents().map(agent => agent.avatarIndex))
        : new Set();
    for (let i = 0; i < MAX_USER_AVATAR_COUNT; i++) {
        if (!used.has(i)) return i;
    }
    return 0;
}

function generateGuestAlias(existingAgents) {
    const taken = new Set((existingAgents || []).map(agent => (agent.name || '').toLowerCase()));
    for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = `Guest ${Math.floor(1000 + Math.random() * 9000)}`;
        if (!taken.has(candidate.toLowerCase())) {
            return candidate;
        }
    }
    return `Guest ${Date.now()}`;
}

function ensureGuestUserAgentForDeepLink() {
    if (typeof agentStorage === 'undefined' || typeof createUserAgent !== 'function') {
        return null;
    }

    const existingAgents = agentStorage.getAllAgents ? agentStorage.getAllAgents() : [];
    const guestName = generateGuestAlias(existingAgents);
    const avatarIndex = pickAvailableAvatarIndex();
    const guestAgent = createUserAgent(guestName, avatarIndex, { isGuest: true });
    agentStorage.addAgent(guestAgent);

    currentUserAgent = guestAgent;
    currentUsername = guestAgent.name;
    updateUsernameDisplay();

    window.dispatchEvent(new CustomEvent('welcomeModalComplete'));

    if (typeof showEphemeralMessage === 'function') {
        showEphemeralMessage(`Welcome, ${guestName}! You can personalize your agent from the top right bubble.`);
    }

    return guestAgent;
}

// Create a guest agent silently for first-time users
function ensureGuestUserAgent() {
    if (typeof agentStorage === 'undefined' || typeof createUserAgent !== 'function') {
        return null;
    }

    const existingAgents = agentStorage.getAllAgents ? agentStorage.getAllAgents() : [];
    const guestName = generateGuestAlias(existingAgents);
    const avatarIndex = pickAvailableAvatarIndex();
    const guestAgent = createUserAgent(guestName, avatarIndex, { isGuest: true });
    agentStorage.addAgent(guestAgent);

    currentUserAgent = guestAgent;
    currentUsername = guestAgent.name;
    updateUsernameDisplay();

    // Dispatch welcome complete immediately since we're not showing a modal
    window.dispatchEvent(new CustomEvent('welcomeModalComplete'));

    return guestAgent;
}

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
    '0x539': { label: 'Localhost (Chain 1337)', shortLabel: 'Localhost' },
    '0x7a69': { label: 'Localhost (Chain 31337)', shortLabel: 'Localhost' },
    '0x2105': { label: 'Base', shortLabel: 'Base' },
    '0x14a34': { label: 'Base Sepolia', shortLabel: 'Base Sepolia' },
    'solana-devnet': { label: 'Solana Devnet', shortLabel: 'Solana Devnet' },
    'solana-mainnet-beta': { label: 'Solana Mainnet', shortLabel: 'Solana Mainnet' },
    'canton': { label: 'Canton (DevNet)', shortLabel: 'Canton' }
};

// Canton has no browser wallet — it's a custodial network switch (see canton-mode.js).
function isCantonModeActive() {
    return !!(window.CantonMode && typeof window.CantonMode.isActive === 'function' && window.CantonMode.isActive());
}
const CANTON_CHAIN_OPTION = { chainIdHex: 'canton', chainIdDec: null, label: 'Canton (DevNet)', tooltip: 'Canton DevNet — custodial, no wallet needed', isKnownNetwork: true };

function getNoNetworkChainOption() {
    return {
        chainIdHex: 'none',
        chainIdDec: null,
        label: translateUM('wallet.noNetwork', 'No network'),
        tooltip: translateUM('wallet.noNetworkHint', 'Disconnect wallets and leave the active chain mode.'),
        isKnownNetwork: true
    };
}

function isSolanaWalletActive() {
    const wm = window.solanaWalletManager;
    if (!wm || typeof wm.getState !== 'function') return false;
    const state = wm.getState();
    return state && state.status === 'connected' && Array.isArray(state.accounts) && state.accounts.length > 0;
}

function getSolanaChainId() {
    if (!isSolanaWalletActive()) return null;
    const cluster = window.solanaWalletManager.getCluster
        ? window.solanaWalletManager.getCluster()
        : 'devnet';
    return `solana-${cluster}`;
}

function normalizeChainId(chainId) {
    if (chainId === null || chainId === undefined) {
        return null;
    }
    if (typeof chainId === 'string') {
        const trimmed = chainId.trim();
        if (!trimmed) {
            return null;
        }
        if (trimmed.startsWith('solana')) {
            return trimmed.toLowerCase();
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
    // If Solana wallet is active and no EVM chainId, use Solana chain
    const solanaActive = isSolanaWalletActive();
    const effectiveChainId = chainId || (solanaActive ? getSolanaChainId() : null);
    const effectiveStatus = status || (solanaActive ? 'connected' : 'idle');

    const normalized = normalizeChainId(effectiveChainId);
    const isConnected = effectiveStatus === 'connected';

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
    if (normalized === 'none') {
        return '<i class="fas fa-unlink"></i>';
    }
    if (typeof normalized === 'string' && normalized.startsWith('solana')) {
        return '<svg width="16" height="16" viewBox="0 0 128 128" style="vertical-align:middle;display:inline-block"><defs><linearGradient id="sol-g" x1="0" y1="0" x2="128" y2="128" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#9945FF"/><stop offset="100%" stop-color="#14F195"/></linearGradient></defs><rect width="128" height="128" rx="24" fill="url(#sol-g)"/><path d="M36 82h42l14-14H50L36 82zm0-22h56l14-14H50L36 60zm56 30H50L36 106h56l14-14z" fill="#fff"/></svg>';
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
    addProposalIfRelevant(proposalId, proposal) {
        const userAgent = getCurrentUserAgent();
        if (!userAgent) return;

        const userParcelIds = getAgentOwnedParcels(userAgent.id);
        const proposalParcels = Array.isArray(proposal.parentParcelIds)
            ? proposal.parentParcelIds
            : (Array.isArray(proposal.childParcelIds) ? proposal.childParcelIds : []);
        const hasUserParcel = proposalParcels.some(parcelId =>
            userParcelIds.includes(parcelId)
        );

        if (hasUserParcel) {
            this.unseenProposals.add(proposalId);
            this.save();
            updateUsernameDisplay(); // Update badge
        }
    },

    // Mark a proposal as seen
    markProposalAsSeen(proposalId) {
        if (this.unseenProposals.has(proposalId)) {
            this.unseenProposals.delete(proposalId);
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

// Check for user agent on page load - always start as guest, no welcome modal on load
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
        return;
    }

    // Check for legacy username storage and clear it
    const legacyUsername = PersistentStorage.getItem('userName');
    if (legacyUsername) {
        PersistentStorage.removeItem('userName');
    }

    // Create a guest agent silently - user can personalize later via the user bubble
    const guest = ensureGuestUserAgent();
    if (guest) {
        initializeWalletIntegration();
    }
}

// Auto-start game functionality disabled: game starts only when user clicks Play
function autoStartGame() {
    // Intentionally no-op to prevent automatic game start
    return;
}

// Show welcome modal for new users or guests personalizing their profile
function showWelcomeModal() {
    const modal = document.getElementById('welcome-modal');
    modal.style.display = 'flex';

    // If guest is personalizing, pre-fill with their current avatar
    if (currentUserAgent && currentUserAgent.isGuest) {
        selectedAvatarIndex = currentUserAgent.avatarIndex;
    }

    // Initialize avatar selection
    initializeAvatarSelection();

    // Setup language picker
    setupWelcomeModalLanguagePicker();

    // Setup event listeners
    setupWelcomeModalEventListeners();

    // Clear username input (don't pre-fill guest name since it's auto-generated)
    const usernameInput = document.getElementById('username-input');
    usernameInput.value = '';

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
function setupWelcomeModalLanguagePicker() {
    const modal = document.getElementById('welcome-modal');
    if (!modal) return;

    const switcher = modal.querySelector('[data-language-switcher]');
    if (!switcher) return;

    const toggle = switcher.querySelector('[data-language-toggle]');
    const menu = switcher.querySelector('[data-language-menu]');
    if (!toggle || !menu) return;

    const i18nApi = typeof window !== 'undefined' && window.i18n ? window.i18n : null;
    const flagByLang = { en: '🌐', es: '🇪🇸', sr: '🇷🇸', hr: '🇭🇷' };
    const getFlag = (lang) => flagByLang[lang] || '🌐';

    // Determine initial language: user's stored language or city's default
    let initialLang = 'en';

    // First, check if user has a stored language preference
    const LANGUAGE_STORAGE_KEY = 'cb_language';
    let storedLang = null;
    try {
        if (typeof PersistentStorage !== 'undefined' && PersistentStorage && typeof PersistentStorage.getItem === 'function') {
            storedLang = PersistentStorage.getItem(LANGUAGE_STORAGE_KEY);
        }
    } catch (_) { /* ignore */ }

    if (storedLang) {
        // User has a stored language preference, use it
        initialLang = storedLang;
    } else {
        // No stored language, use city's default
        try {
            const cityManager = typeof window !== 'undefined' && window.CityConfigManager ? window.CityConfigManager : null;
            if (cityManager && typeof cityManager.getCurrentCityConfig === 'function') {
                const cityConfig = cityManager.getCurrentCityConfig();
                if (cityConfig && cityConfig.language && cityConfig.language.default) {
                    initialLang = cityConfig.language.default;
                }
            }
        } catch (_) { /* ignore */ }
    }

    // Get current language from i18n API to see what's actually set
    const currentLang = (i18nApi && typeof i18nApi.getLanguage === 'function') ? i18nApi.getLanguage() : 'en';

    // If we determined a different language than what's currently set, update it
    if (initialLang !== currentLang && i18nApi && typeof i18nApi.setLanguage === 'function') {
        try {
            i18nApi.setLanguage(initialLang);
        } catch (_) { /* ignore */ }
    } else {
        // Use current language if no change needed
        initialLang = currentLang;
    }

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

    setActive(initialLang);

    if (i18nApi && typeof i18nApi.applyTranslations === 'function') {
        i18nApi.applyTranslations(switcher);
    }

    // Store cleanup function
    modal.__welcomeLanguagePickerCleanup = () => {
        toggle.removeEventListener('click', handleToggle);
        menu.removeEventListener('click', handleOptionClick);
        document.removeEventListener('click', handleOutsideClick);
        document.removeEventListener('keydown', handleKeydown);
        if (typeof unsubscribe === 'function') {
            try { unsubscribe(); } catch (_) { }
        }
    };
}

function setupWelcomeModalEventListeners() {
    const usernameInput = document.getElementById('username-input');
    const takeoverYesBtn = document.getElementById('takeover-yes-btn');
    const takeoverNoBtn = document.getElementById('takeover-no-btn');
    const closeBtn = document.getElementById('welcome-close-btn');

    // Check for existing agent when typing
    usernameInput.addEventListener('input', handleUsernameInput);

    if (closeBtn) {
        closeBtn.onclick = hideWelcomeModal;
    }

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
            message.innerHTML = getLocalizedTakeoverMessage(existingAgent.id, existingAgent.name);
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

        // Dispatch event that welcome modal is complete
        window.dispatchEvent(new CustomEvent('welcomeModalComplete'));

        // Show success message
        if (typeof showEphemeralMessage === 'function') {
            const message = translateUM(
                'ephemeral.messages.welcome_back_user',
                'Welcome back, {{name}}! You\'ve taken control of your agent.',
                { name: agent.name }
            );
            showEphemeralMessage(message);
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

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getLocalizedTakeoverMessage(agentId, agentName) {
    const i18nApi = typeof window !== 'undefined' ? window.i18n : null;
    const safeName = escapeHtml(agentName || '');
    const agentLink = `<a href="#" onclick="openTakeoverAgentDialog(${JSON.stringify(agentId)}); return false;">${safeName}</a>`;

    if (i18nApi && typeof i18nApi.t === 'function') {
        return i18nApi.t('modal.welcome.takeoverMessage', { agentLink });
    }

    return `Taking over agent ${agentLink} (Yes/No)`;
}

function openTakeoverAgentDialog(agentId) {
    const focusWelcomeContext = () => {
        const modal = document.getElementById('welcome-modal');
        if (modal) {
            modal.style.display = 'flex';
        }
        const input = document.getElementById('username-input');
        if (input) {
            const length = input.value.length;
            input.focus();
            try {
                input.setSelectionRange(length, length);
            } catch (_) { }
        }
    };

    if (typeof showAgentDialog === 'function') {
        showAgentDialog(agentId, {
            readOnly: true,
            elevated: true,
            onClose: focusWelcomeContext
        });
    }
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

    // If current user is a guest, update their profile instead of creating new agent
    if (currentUserAgent && currentUserAgent.isGuest) {
        // Update the guest agent to a full user
        agentStorage.updateAgent(currentUserAgent.id, {
            name: username,
            avatarIndex: selectedAvatarIndex,
            isGuest: false
        });

        // Update local state
        currentUserAgent.name = username;
        currentUserAgent.avatarIndex = selectedAvatarIndex;
        currentUserAgent.isGuest = false;
        currentUsername = username;

        // Update display
        updateUsernameDisplay();

        // Hide the modal
        hideWelcomeModal();

        // Dispatch event that welcome modal is complete
        window.dispatchEvent(new CustomEvent('welcomeModalComplete'));

        // Show a welcome message
        if (typeof showEphemeralMessage === 'function') {
            const message = translateUM(
                'ephemeral.messages.profile_personalized',
                'Great, {{name}}! Your profile is now personalized.',
                { name: username }
            );
            showEphemeralMessage(message);
        }

        // Add to game log
        if (typeof gameState !== 'undefined') {
            gameState.addLogEntry(`Guest personalized their profile as ${username}.`);
        }

        initializeWalletIntegration();
        return;
    }

    // Create new user agent (for non-guest flow, e.g., after logout)
    if (typeof createUserAgent === 'function') {
        const userAgent = createUserAgent(username, selectedAvatarIndex);
        agentStorage.addAgent(userAgent);

        currentUserAgent = userAgent;
        currentUsername = username;

        // Update the username display
        updateUsernameDisplay();

        // Hide the modal
        hideWelcomeModal();

        // Dispatch event that welcome modal is complete
        window.dispatchEvent(new CustomEvent('welcomeModalComplete'));

        // Show a welcome message
        if (typeof showEphemeralMessage === 'function') {
            const message = translateUM(
                'ephemeral.messages.welcome_new_user',
                'Welcome, {{name}}! You\'re now part of the consensus building community.',
                { name: username }
            );
            showEphemeralMessage(message);
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

        // Add click handler - show welcome modal for guests to personalize, otherwise show agent dialog
        usernameDisplay.onclick = () => {
            if (currentUserAgent && currentUserAgent.isGuest) {
                // Guest user clicking bubble for first time - show welcome modal to personalize
                showWelcomeModal();
            } else if (typeof showAgentDialog === 'function') {
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

        // Create a new guest agent silently (user can personalize via user bubble)
        ensureGuestUserAgent();

        // Show message
        if (typeof showEphemeralMessage === 'function') {
            const message = translateUM(
                letAIRun ? 'ephemeral.messages.logged_out_ai_controls' : 'ephemeral.messages.logged_out_agent_inactive',
                letAIRun ? 'Logged out. AI will control your agent.' : 'Logged out. Agent is now inactive.'
            );
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
    const evmState = window.walletManager ? window.walletManager.getState() : null;
    const evmConnected = evmState && evmState.status === 'connected';
    const solanaConnected = isSolanaWalletActive();

    if (evmConnected || solanaConnected) {
        showWalletDisconnectConfirmation();
    } else if (window.walletManager) {
        window.walletManager.openConnectorModal();
    } else {
        console.warn('Wallet manager is not available.');
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
    // Check Solana wallet first
    if (isSolanaWalletActive()) {
        const solState = window.solanaWalletManager.getState();
        const displayAccount = solState.accounts[0];
        return `${displayAccount.slice(0, 4)}...${displayAccount.slice(-4)}`;
    }
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

    if (isSolanaWalletActive()) {
        const solState = window.solanaWalletManager.getState();
        modalButton.classList.add('connected');
        modalButton.title = `Connected Solana wallet: ${solState.accounts[0]}\nClick to disconnect.`;
        return;
    }

    const state = window.walletManager ? window.walletManager.getState() : null;
    if (state && state.status === 'connected' && state.accounts && state.accounts.length > 0) {
        modalButton.classList.add('connected');
        modalButton.title = `${translateUM('wallet.connectedTitle', 'Connected wallet: {{account}}', { account: state.accounts[0] })}\n${translateUM('wallet.disconnectHint', 'Click to disconnect.')}`;
    } else {
        modalButton.classList.remove('connected');
        modalButton.title = translateUM('wallet.connectTitle', 'Connect a wallet');
    }
}

const CITY_TOKEN_FALLBACK_ABI = [
    'function registerAsCitizen()',
    'function availableBalance(address account) public view returns (uint256)',
    'function balanceOf(address account) public view returns (uint256)',
    'function citizens(address account) public view returns (uint256 registeredAt, uint256 balanceWithdrawn)',
    'function withdraw(uint256 amount)',
    'function decimals() public view returns (uint8)'
];

const CITY_TOKEN_REQUIRED_METHODS = new Set([
    'registerAsCitizen',
    'availableBalance',
    'balanceOf',
    'citizens',
    'withdraw',
    'decimals'
]);

function ensureCityTokenAbiHasRequiredMethods(rawAbi) {
    const abi = Array.isArray(rawAbi) ? rawAbi.slice() : [];

    const extractName = (entry) => {
        if (!entry) return null;
        if (typeof entry === 'string') {
            const match = entry.match(/function\s+([^(\s]+)/i);
            return match ? match[1] : null;
        }
        if (typeof entry === 'object' && entry.name) {
            return entry.name;
        }
        return null;
    };

    const present = new Set();
    abi.forEach(item => {
        const name = extractName(item);
        if (name) {
            present.add(name);
        }
    });

    CITY_TOKEN_FALLBACK_ABI.forEach(fallbackEntry => {
        const name = extractName(fallbackEntry);
        if (name && !present.has(name)) {
            abi.push(fallbackEntry);
            present.add(name);
        }
    });

    return abi;
}

const cityTokenModalState = {
    overlay: null,
    statusNode: null,
    balanceNode: null,
    allotmentNode: null,
    registerButton: null,
    claimButton: null,
    tokenLinkNode: null,
    availableRaw: 0n,
    decimals: 18,
    registered: false,
    chainId: null,
    contractAddress: null,
    account: null,
    refreshPromise: null
};

function getCityTokenExplorerBase(chainId) {
    const decimalId = chainIdToDecimalString(chainId);
    switch (decimalId) {
        case '1':
            return 'https://etherscan.io';
        case '11155111':
            return 'https://sepolia.etherscan.io';
        case '8453':
            return 'https://basescan.org';
        case '84532':
            return 'https://sepolia.basescan.org';
        case '31337':
            return null; // local dev
        default:
            return null;
    }
}

function buildCityTokenTxUrl(chainId, txHash) {
    const base = getCityTokenExplorerBase(chainId);
    if (!base || !txHash) return null;
    return `${base}/tx/${txHash}`;
}

function buildCityTokenContractUrl(chainId, contractAddress) {
    const base = getCityTokenExplorerBase(chainId);
    if (!base || !contractAddress) return null;
    return `${base}/token/${contractAddress}`;
}

function formatCityTokenAmount(raw, decimals) {
    try {
        const formatted = window.ethers ? window.ethers.formatUnits(raw, decimals) : String(raw);
        const asNumber = Number(formatted);
        if (Number.isFinite(asNumber)) {
            return asNumber >= 1 ? asNumber.toFixed(2) : asNumber.toFixed(4);
        }
        return formatted;
    } catch (_) {
        return raw && raw.toString ? raw.toString() : '0';
    }
}

async function resolveCityTokenContract(options = {}) {
    const requireSigner = options.requireSigner === true;
    if (!window.walletManager) {
        throw new Error('Wallet not ready');
    }
    const state = window.walletManager.getState();
    if (!state || state.status !== 'connected' || !state.accounts || state.accounts.length === 0) {
        throw new Error('Wallet not connected');
    }
    if (!window.ethers) {
        throw new Error('Ethers not available');
    }

    const account = state.accounts[0];
    const chainId = state.chainId;
    const provider = window.walletManager.getProvider();
    if (!provider) {
        throw new Error('Wallet provider unavailable');
    }

    const browserProvider = new window.ethers.BrowserProvider(provider);
    const signer = requireSigner ? await browserProvider.getSigner() : null;

    let contractAddress = null;
    try {
        if (window.ChainDataLoader && typeof window.ChainDataLoader.resolveContractAddress === 'function') {
            contractAddress = await window.ChainDataLoader.resolveContractAddress(chainId, 'CityMemeToken');
        }
    } catch (err) {
        console.warn('City token address lookup via ChainDataLoader failed', err);
    }
    if (!contractAddress && window.ContractsLoader && typeof window.ContractsLoader.getContractAddress === 'function') {
        try {
            contractAddress = await window.ContractsLoader.getContractAddress(chainId, 'CityMemeToken');
        } catch (err) {
            console.warn('City token address lookup via ContractsLoader failed', err);
        }
    }
    if (!contractAddress) {
        throw new Error('City token contract not configured for this network.');
    }

    let abi = CITY_TOKEN_FALLBACK_ABI;
    if (window.ContractsLoader && typeof window.ContractsLoader.getContractABI === 'function') {
        try {
            const loadedAbi = await window.ContractsLoader.getContractABI(chainId, 'CityMemeToken');
            if (loadedAbi && Array.isArray(loadedAbi)) {
                abi = ensureCityTokenAbiHasRequiredMethods(loadedAbi);
            } else {
                abi = ensureCityTokenAbiHasRequiredMethods(abi);
            }
        } catch (err) {
            console.warn('City token ABI lookup failed, using fallback', err);
            abi = ensureCityTokenAbiHasRequiredMethods(abi);
        }
    } else {
        abi = ensureCityTokenAbiHasRequiredMethods(abi);
    }

    const contract = new window.ethers.Contract(contractAddress, abi, requireSigner ? signer : browserProvider);

    // Ensure contract exists on this network to avoid wallet RPC reverts on nonexistent code
    try {
        const code = await browserProvider.getCode(contractAddress);
        if (!code || code === '0x') {
            throw new Error('City token not deployed on this network.');
        }
    } catch (err) {
        throw new Error(err && err.message ? err.message : 'City token not available on this network.');
    }

    let decimals = 18;
    try {
        const rawDecimals = await contract.decimals();
        const asNumber = Number(rawDecimals);
        if (Number.isFinite(asNumber)) {
            decimals = asNumber;
        }
    } catch (err) {
        console.warn('City token decimals fetch failed, defaulting to 18', err);
    }

    return { contract, browserProvider, signer, chainId, account, decimals, contractAddress };
}

function setCityTokenStatus(message, isError = false, linkHref = null, linkLabel = null) {
    const node = cityTokenModalState.statusNode;
    if (!node) return;
    node.textContent = '';
    node.classList.toggle('is-error', Boolean(isError));
    if (message) {
        const textSpan = document.createElement('span');
        textSpan.textContent = message;
        node.appendChild(textSpan);
    }
    if (linkHref) {
        const link = document.createElement('a');
        link.href = linkHref;
        link.target = '_blank';
        link.rel = 'noreferrer noopener';
        link.textContent = linkLabel || translateUM('cityToken.statusTxLink', 'View transaction');
        node.appendChild(document.createTextNode(' '));
        node.appendChild(link);
    }
}

function disableCityTokenActions(message) {
    if (cityTokenModalState.registerButton) {
        cityTokenModalState.registerButton.disabled = true;
    }
    if (cityTokenModalState.claimButton) {
        cityTokenModalState.claimButton.disabled = true;
    }
    setCityTokenStatus(message, true);
}

function closeCityTokenModal() {
    if (cityTokenModalState.overlay && cityTokenModalState.overlay.parentElement) {
        cityTokenModalState.overlay.parentElement.removeChild(cityTokenModalState.overlay);
    }
    cityTokenModalState.overlay = null;
    cityTokenModalState.statusNode = null;
    cityTokenModalState.balanceNode = null;
    cityTokenModalState.allotmentNode = null;
    cityTokenModalState.registerButton = null;
    cityTokenModalState.claimButton = null;
    cityTokenModalState.tokenLinkNode = null;
    cityTokenModalState.availableRaw = 0n;
    cityTokenModalState.decimals = 18;
    cityTokenModalState.registered = false;
    cityTokenModalState.chainId = null;
    cityTokenModalState.contractAddress = null;
    cityTokenModalState.account = null;
    cityTokenModalState.refreshPromise = null;
}

async function refreshCityTokenModalData() {
    if (cityTokenModalState.refreshPromise) {
        return cityTokenModalState.refreshPromise;
    }

    const loadingMessage = translateUM('cityToken.statusLoading', 'Loading city token data…');
    setCityTokenStatus(loadingMessage, false);

    cityTokenModalState.refreshPromise = (async () => {
        try {
            const { contract, chainId, account, decimals, contractAddress } = await resolveCityTokenContract({ requireSigner: false });
            const [balanceRaw, allotmentRaw, citizenInfo] = await Promise.all([
                contract.balanceOf(account),
                contract.availableBalance(account),
                contract.citizens(account).catch(() => null)
            ]);

            const registeredAt = citizenInfo && (citizenInfo.registeredAt || citizenInfo[0]) ? citizenInfo.registeredAt || citizenInfo[0] : 0n;
            const registered = (typeof registeredAt === 'bigint' ? registeredAt > 0n : Number(registeredAt) > 0);

            const balanceDisplay = formatCityTokenAmount(balanceRaw || 0n, decimals);
            const allotmentDisplay = formatCityTokenAmount(allotmentRaw || 0n, decimals);

            cityTokenModalState.availableRaw = typeof allotmentRaw === 'bigint' ? allotmentRaw : BigInt(allotmentRaw || 0);
            cityTokenModalState.decimals = decimals;
            cityTokenModalState.registered = registered;
            cityTokenModalState.chainId = chainId;
            cityTokenModalState.contractAddress = contractAddress;
            cityTokenModalState.account = account;

            if (cityTokenModalState.tokenLinkNode) {
                const tokenUrl = buildCityTokenContractUrl(chainId, contractAddress);
                if (tokenUrl) {
                    cityTokenModalState.tokenLinkNode.href = tokenUrl;
                    cityTokenModalState.tokenLinkNode.target = '_blank';
                    cityTokenModalState.tokenLinkNode.rel = 'noreferrer noopener';
                    cityTokenModalState.tokenLinkNode.removeAttribute('aria-disabled');
                } else {
                    cityTokenModalState.tokenLinkNode.href = '#';
                    cityTokenModalState.tokenLinkNode.setAttribute('aria-disabled', 'true');
                }
            }

            if (cityTokenModalState.balanceNode) {
                cityTokenModalState.balanceNode.textContent = `${balanceDisplay} CTY`;
            }
            if (cityTokenModalState.allotmentNode) {
                cityTokenModalState.allotmentNode.textContent = `${allotmentDisplay} CTY`;
            }

            if (cityTokenModalState.registerButton) {
                const registeredLabel = translateUM('cityToken.registeredLabel', '🏅 Registered');
                cityTokenModalState.registerButton.textContent = registered ? registeredLabel : translateUM('cityToken.register', 'Register');
                cityTokenModalState.registerButton.classList.toggle('city-token-registered-label', registered);
                cityTokenModalState.registerButton.disabled = false;
            }
            if (cityTokenModalState.claimButton) {
                const hasClaim = cityTokenModalState.availableRaw > 0n;
                cityTokenModalState.claimButton.disabled = !registered || !hasClaim;
            }

            if (!registered) {
                setCityTokenStatus(translateUM('cityToken.statusNotRegistered', 'Not registered yet.'), false);
            } else if (cityTokenModalState.availableRaw <= 0n) {
                setCityTokenStatus(translateUM('cityToken.statusNothingToClaim', 'Nothing to claim yet, come back a bit later.'), false);
            } else {
                setCityTokenStatus('', false);
            }
        } catch (err) {
            console.warn('Failed to refresh city token data', err);
            disableCityTokenActions(err && err.message ? err.message : translateUM('cityToken.statusError', 'Something went wrong. Please try again.'));
        }
    })();

    try {
        await cityTokenModalState.refreshPromise;
    } finally {
        cityTokenModalState.refreshPromise = null;
    }
}

async function handleCityTokenRegister() {
    if (cityTokenModalState.registered) {
        return;
    }
    const busyMessage = translateUM('cityToken.statusRegistering', 'Registering…');
    setCityTokenStatus(busyMessage, false);
    if (cityTokenModalState.registerButton) {
        cityTokenModalState.registerButton.disabled = true;
    }
    if (cityTokenModalState.claimButton) {
        cityTokenModalState.claimButton.disabled = true;
    }

    try {
        const { contract, chainId } = await resolveCityTokenContract({ requireSigner: true });
        const tx = await contract.registerAsCitizen();
        const receipt = await tx.wait();
        const successMessage = translateUM('cityToken.statusRegistered', 'Success! You are now a registered citizen.');
        const txUrl = buildCityTokenTxUrl(chainId, receipt && receipt.hash ? receipt.hash : tx && tx.hash);
        setCityTokenStatus(successMessage, false, txUrl, translateUM('cityToken.statusTxLink', 'View transaction'));
    } catch (err) {
        console.warn('City token registration failed', err);
        setCityTokenStatus(err && err.message ? err.message : translateUM('cityToken.statusError', 'Something went wrong. Please try again.'), true);
    } finally {
        await refreshCityTokenModalData();
    }
}

async function handleCityTokenClaim() {
    const hasClaim = cityTokenModalState.availableRaw > 0n;
    if (!cityTokenModalState.registered) {
        setCityTokenStatus(translateUM('cityToken.statusNotRegistered', 'Not registered yet.'), true);
        return;
    }
    if (!hasClaim) {
        setCityTokenStatus(translateUM('cityToken.statusNothingToClaim', 'No tokens available to claim yet.'), true);
        return;
    }

    if (cityTokenModalState.registerButton) {
        cityTokenModalState.registerButton.disabled = true;
    }
    if (cityTokenModalState.claimButton) {
        cityTokenModalState.claimButton.disabled = true;
    }
    setCityTokenStatus(translateUM('cityToken.statusClaiming', 'Claiming tokens from the contract...'), false);

    try {
        const { contract, chainId } = await resolveCityTokenContract({ requireSigner: true });
        const amount = cityTokenModalState.availableRaw;
        const tx = await contract.withdraw(amount);
        const receipt = await tx.wait();
        const successMessage = translateUM('cityToken.statusClaimedDone', 'Tokens claimed!');
        const txUrl = buildCityTokenTxUrl(chainId, receipt && receipt.hash ? receipt.hash : tx && tx.hash);
        setCityTokenStatus(successMessage, false, txUrl, translateUM('cityToken.statusTxLink', 'View transaction'));
    } catch (err) {
        console.warn('City token claim failed', err);
        setCityTokenStatus(err && err.message ? err.message : translateUM('cityToken.statusError', 'Something went wrong. Please try again.'), true);
    } finally {
        await refreshCityTokenModalData();
    }
}

function renderCityTokenModal() {
    const title = translateUM('cityToken.title', 'City token');
    const closeLabel = translateUM('cityToken.close', 'Close city token modal');
    const balanceLabel = translateUM('cityToken.currentBalance', 'Current balance');
    const allotmentLabel = translateUM('cityToken.currentAllotment', 'Current allotment');
    const registerLabel = translateUM('cityToken.register', 'Register');
    const claimLabel = translateUM('cityToken.claim', 'Claim');
    const introPrefix = translateUM('cityToken.explainerIntroPrefix', 'The city has');
    const introTokenText = translateUM('cityToken.explainerIntroToken', 'its own token');
    const introSuffix = translateUM('cityToken.explainerIntroSuffix', 'of course.');
    const body = translateUM('cityToken.explainerBody', 'Every registered citizen address has a right to 1 token per hour ⌛️, forever. You can use these tokens to Boost proposals. Think of it as a form of voting for those you like.');

    const overlay = document.createElement('div');
    overlay.className = 'city-token-overlay';
    overlay.innerHTML = `
        <div class="city-token-modal">
            <div class="city-token-header">
                <div>
                    <h2 data-i18n-key="cityToken.title">${title}</h2>
                </div>
                <button type="button" class="city-token-close close-circle-btn close-circle-btn--lg" aria-label="${closeLabel}" title="${closeLabel}" data-readonly-allow="true">&times;</button>
            </div>
            <div class="city-token-body">
                <p class="city-token-explainer"><em data-city-token-intro></em> ${body}</p>
                <div class="city-token-metrics">
                    <div class="city-token-row">
                        <span class="city-token-label" data-i18n-key="cityToken.currentBalance">${balanceLabel}</span>
                        <span class="city-token-value" data-city-token-balance>-</span>
                    </div>
                    <div class="city-token-row">
                        <span class="city-token-label" data-i18n-key="cityToken.currentAllotment">${allotmentLabel}</span>
                        <span class="city-token-value" data-city-token-allotment>-</span>
                    </div>
                </div>
                <div class="city-token-actions">
                    <button type="button" class="btn btn-secondary" data-city-token-register>${registerLabel}</button>
                    <button type="button" class="btn btn-primary" data-city-token-claim>${claimLabel}</button>
                </div>
                <div class="city-token-status" data-city-token-status></div>
            </div>
        </div>
    `;

    const statusNode = overlay.querySelector('[data-city-token-status]');
    const balanceNode = overlay.querySelector('[data-city-token-balance]');
    const allotmentNode = overlay.querySelector('[data-city-token-allotment]');
    const registerButton = overlay.querySelector('[data-city-token-register]');
    const claimButton = overlay.querySelector('[data-city-token-claim]');
    const closeButton = overlay.querySelector('.city-token-close');
    const introNode = overlay.querySelector('[data-city-token-intro]');

    if (introNode) {
        const tokenLink = document.createElement('a');
        tokenLink.dataset.cityTokenLink = 'true';
        tokenLink.href = '#';
        tokenLink.textContent = introTokenText;
        tokenLink.rel = 'noreferrer noopener';
        tokenLink.target = '_blank';
        tokenLink.setAttribute('aria-disabled', 'true');

        introNode.textContent = '';
        introNode.append(document.createTextNode(`${introPrefix} `));
        introNode.append(tokenLink);
        introNode.append(document.createTextNode(`, ${introSuffix}`));

        cityTokenModalState.tokenLinkNode = tokenLink;
    }

    cityTokenModalState.overlay = overlay;
    cityTokenModalState.statusNode = statusNode;
    cityTokenModalState.balanceNode = balanceNode;
    cityTokenModalState.allotmentNode = allotmentNode;
    cityTokenModalState.registerButton = registerButton;
    cityTokenModalState.claimButton = claimButton;

    registerButton.addEventListener('click', handleCityTokenRegister);
    claimButton.addEventListener('click', handleCityTokenClaim);
    closeButton.addEventListener('click', closeCityTokenModal);

    return overlay;
}

async function openCityTokenModal() {
    if (!window.walletManager) {
        setCityTokenStatus(translateUM('cityToken.statusNoWallet', 'Connect a wallet to view your city tokens.'), true);
        return;
    }
    const walletState = window.walletManager.getState();
    if (!walletState || walletState.status !== 'connected') {
        setCityTokenStatus(translateUM('cityToken.statusNoWallet', 'Connect a wallet to view your city tokens.'), true);
        handleWalletButtonClick();
        return;
    }

    if (!cityTokenModalState.overlay) {
        renderCityTokenModal();
        document.body.appendChild(cityTokenModalState.overlay);
        if (window.i18n && typeof window.i18n.applyTranslations === 'function') {
            try {
                window.i18n.applyTranslations(cityTokenModalState.overlay);
            } catch (_) { }
        }
    }

    await refreshCityTokenModalData();
}

function updateAgentDialogChainInfo() {
    const chainInfoContainer = document.querySelector('.wallet-chain-info');
    if (!chainInfoContainer) {
        return;
    }
    const chainInfoParent = chainInfoContainer.parentElement;
    const existingAttestLink = chainInfoParent ? chainInfoParent.querySelector('.wallet-attest-link') : null;
    const existingCityTokenButton = chainInfoParent ? chainInfoParent.querySelector('.wallet-city-token-button') : null;

    // Canton takes precedence — custodial, no wallet. The pill shows the acting
    // party and opens the identity picker (the wallet stand-in).
    if (isCantonModeActive()) {
        if (existingAttestLink && chainInfoParent) chainInfoParent.removeChild(existingAttestLink);
        if (existingCityTokenButton && chainInfoParent) chainInfoParent.removeChild(existingCityTokenButton);
        const party = window.CantonMode.getParty && window.CantonMode.getParty();
        const who = party ? (window.CantonMode.hint ? window.CantonMode.hint(party) : party) : 'pick identity';
        chainInfoContainer.innerHTML = `
            <div class="wallet-chain-label">
                <span>🌐 Canton · ${who}</span>
                <i class="fas fa-chevron-down wallet-chain-caret" aria-hidden="true"></i>
            </div>`;
        chainInfoContainer.title = 'Canton (DevNet) — click to choose identity or switch network';
        chainInfoContainer.style.display = 'flex';
        chainInfoContainer.setAttribute('role', 'button');
        chainInfoContainer.setAttribute('tabindex', '0');
        chainInfoContainer.dataset.chainId = 'canton';
        chainInfoContainer.onclick = () => window.CantonMode.openIdentityPicker();
        chainInfoContainer.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); window.CantonMode.openIdentityPicker(); } };
        return;
    }

    const solanaActive = isSolanaWalletActive();
    const evmState = window.walletManager ? window.walletManager.getState() : null;
    const evmConnected = evmState && evmState.status === 'connected';
    const isConnected = solanaActive || evmConnected;

    if (isConnected) {
        const chainId = solanaActive ? getSolanaChainId() : evmState.chainId;
        const networkInfo = getNetworkDisplayInfo(chainId, 'connected');
        const chainIcon = getChainIconMarkup(chainId);
        const displayName = (currentUserAgent && currentUserAgent.name) || getCurrentUsername() || 'User';
        const accountAddress = solanaActive
            ? (window.solanaWalletManager.getState().accounts[0] || '')
            : ((evmState.accounts && evmState.accounts[0]) || '');
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
            attestLink.href = '#';
            attestLink.textContent = '📝';
            attestLink.title = attestTitle;
            attestLink.setAttribute('aria-label', attestTitle);
            attestLink.onclick = (event) => {
                event.preventDefault();
                openAttestifyExplainer(attestUrl, attestTitle);
            };
        } else if (existingAttestLink && chainInfoParent) {
            chainInfoParent.removeChild(existingAttestLink);
        }

        let cityTokenButton = existingCityTokenButton;
        if (!cityTokenButton && chainInfoParent) {
            cityTokenButton = document.createElement('button');
            cityTokenButton.type = 'button';
            cityTokenButton.className = 'wallet-city-token-button';
            chainInfoParent.appendChild(cityTokenButton);
        }
        if (cityTokenButton) {
            const cityTokenTitle = translateUM('cityToken.title', 'City token');
            cityTokenButton.textContent = '🪙';
            cityTokenButton.title = cityTokenTitle;
            cityTokenButton.setAttribute('aria-label', cityTokenTitle);
            cityTokenButton.onclick = () => openCityTokenModal();
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
        // No wallet connected — still offer a network selector so Canton (which
        // needs no wallet) is reachable from the same place.
        if (existingAttestLink && chainInfoParent) chainInfoParent.removeChild(existingAttestLink);
        if (existingCityTokenButton && chainInfoParent) chainInfoParent.removeChild(existingCityTokenButton);
        chainInfoContainer.innerHTML = `
            <div class="wallet-chain-label">
                <span>${translateUM('wallet.selectNetwork', 'Select network')}</span>
                <i class="fas fa-chevron-down wallet-chain-caret" aria-hidden="true"></i>
            </div>`;
        chainInfoContainer.title = translateUM('wallet.selectNetwork', 'Select network');
        chainInfoContainer.style.display = 'flex';
        chainInfoContainer.setAttribute('role', 'button');
        chainInfoContainer.setAttribute('tabindex', '0');
        chainInfoContainer.dataset.chainId = '';
        chainInfoContainer.onclick = openChainSelectionModal;
        chainInfoContainer.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openChainSelectionModal(); } };
    }
}

function openAttestifyExplainer(attestUrl, attestTitle) {
    if (!attestUrl) return;
    if (cityTokenModalState.attestOverlay && cityTokenModalState.attestOverlay.parentElement) {
        cityTokenModalState.attestOverlay.parentElement.removeChild(cityTokenModalState.attestOverlay);
        cityTokenModalState.attestOverlay = null;
    }

    const title = translateUM('attestify.title', 'Register nickname');
    const body = translateUM(
        'attestify.body',
        'Optionally, you can connect your nickname with your address on chain. This additional metadata makes advanced attestations easier. You do not have to do it, everything works without it, but you can at any time. If you wish to do it now proceed to Attestify.Network.'
    );
    const proceedLabel = translateUM('attestify.proceed', 'Proceed to Attestify.Network');
    const closeLabel = translateUM('attestify.close', 'Close');

    const overlay = document.createElement('div');
    overlay.className = 'attestify-overlay';
    overlay.innerHTML = `
        <div class="attestify-modal">
            <div class="attestify-header">
                <h2>${title}</h2>
                <button type="button" class="attestify-close close-circle-btn close-circle-btn--lg" aria-label="${closeLabel}" title="${closeLabel}" data-readonly-allow="true">&times;</button>
            </div>
            <div class="attestify-body">
                <p>${body}</p>
                <div class="attestify-actions">
                    <button type="button" class="btn btn-primary" data-attest-proceed>${proceedLabel}</button>
                </div>
            </div>
        </div>
    `;

    const closeBtn = overlay.querySelector('.attestify-close');
    const proceedBtn = overlay.querySelector('[data-attest-proceed]');

    const closeOverlay = () => {
        if (overlay.parentElement) {
            overlay.parentElement.removeChild(overlay);
        }
        if (cityTokenModalState) {
            cityTokenModalState.attestOverlay = null;
        }
    };

    closeBtn.onclick = closeOverlay;
    overlay.onclick = (evt) => {
        if (evt.target === overlay) closeOverlay();
    };
    proceedBtn.onclick = () => {
        window.open(attestUrl, '_blank', 'noopener');
        closeOverlay();
    };

    document.body.appendChild(overlay);
    if (cityTokenModalState) {
        cityTokenModalState.attestOverlay = overlay;
    }
    if (window.i18n && typeof window.i18n.applyTranslations === 'function') {
        try {
            window.i18n.applyTranslations(overlay);
        } catch (_) { }
    }
}

async function getAvailableChainOptions() {
    // If Solana wallet is active, show Solana cluster options only
    if (isSolanaWalletActive()) {
        const currentCluster = getSolanaChainId();
        const solanaOptions = [
            { chainIdHex: 'solana-devnet', chainIdDec: null, label: 'Solana Devnet', tooltip: 'Solana Devnet', isKnownNetwork: true },
            { chainIdHex: 'solana-mainnet-beta', chainIdDec: null, label: 'Solana Mainnet', tooltip: 'Solana Mainnet', isKnownNetwork: true }
        ];
        return [getNoNetworkChainOption(), ...solanaOptions, CANTON_CHAIN_OPTION];
    }

    const options = new Map();
    const addChain = (chainId) => {
        // Skip Solana keys when building EVM chain list
        if (typeof chainId === 'string' && chainId.startsWith('solana')) return;
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

    const sorted = Array.from(options.values()).sort((a, b) => a.label.localeCompare(b.label));
    sorted.unshift(getNoNetworkChainOption()); // Leaving every network must always be possible.
    sorted.push(CANTON_CHAIN_OPTION); // Canton is always available (no wallet needed)
    return sorted;
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
        errorNode.textContent = chainIdHex === 'none'
            ? translateUM('wallet.disconnectingNetworks', 'Disconnecting from networks...')
            : 'Requesting network change...';
        errorNode.classList.add('visible');
        errorNode.classList.remove('error');
    }

    // "No network" is app-level escape from every connector. It never asks an EVM wallet to switch,
    // so it also works while Canton is active and there is no browser wallet/provider at all.
    if (chainIdHex === 'none') {
        if (window.CantonMode && window.CantonMode.isActive()) window.CantonMode.deactivate();
        const disconnects = [];
        if (window.solanaWalletManager && typeof window.solanaWalletManager.disconnect === 'function') {
            disconnects.push(Promise.resolve().then(() => window.solanaWalletManager.disconnect()));
        }
        if (window.walletManager && typeof window.walletManager.disconnect === 'function') {
            disconnects.push(Promise.resolve().then(() => window.walletManager.disconnect()));
        }
        await Promise.allSettled(disconnects);
        closeChainSelectionModal();
        updateWalletButtonDisplay();
        updateUsernameDisplay();
        return;
    }

    // Canton: a custodial network switch — no wallet, just flip the mode and pick
    // an acting party. Checked first.
    if (chainIdHex === 'canton') {
        if (window.CantonMode) window.CantonMode.activate();
        closeChainSelectionModal();
        updateWalletButtonDisplay();
        if (window.CantonMode) window.CantonMode.openIdentityPicker();
        return;
    }
    // Any other (real) network deactivates Canton mode.
    if (window.CantonMode && window.CantonMode.isActive()) window.CantonMode.deactivate();

    // Handle Solana cluster switching
    if (typeof chainIdHex === 'string' && chainIdHex.startsWith('solana-')) {
        const cluster = chainIdHex.replace('solana-', '');
        if (window.solanaWalletManager && typeof window.solanaWalletManager.setCluster === 'function') {
            window.solanaWalletManager.setCluster(cluster);
            closeChainSelectionModal();
            updateWalletButtonDisplay();
        } else {
            if (errorNode) {
                errorNode.textContent = 'Solana wallet not available.';
                errorNode.classList.add('error');
            }
        }
        buttons.forEach(btn => { btn.disabled = false; });
        return;
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
    const hasEvmWallet = window.walletManager && typeof window.walletManager.getState === 'function';
    const hasSolanaWallet = isSolanaWalletActive();
    // No wallet guard: Canton needs none, and it's always an option below.

    const chainOptions = await getAvailableChainOptions();
    if (!chainOptions.length) {
        if (window.showStyledAlert) {
            window.showStyledAlert('No chains are configured for this app.');
        }
        return;
    }

    closeChainSelectionModal();

    const currentChainHex = isCantonModeActive()
        ? 'canton'
        : (hasSolanaWallet
            ? getSolanaChainId()
            : (normalizeChainId(hasEvmWallet ? window.walletManager.getState().chainId : null) || 'none'));

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
        const isCurrent = option.chainIdHex === 'none'
            ? currentChainHex === 'none'
            : (currentChainHex && normalizeChainId(option.chainIdHex) === currentChainHex);
        const isSolana = typeof option.chainIdHex === 'string' && option.chainIdHex.startsWith('solana');
        const subtitle = option.chainIdHex === 'none'
            ? option.tooltip
            : (isSolana ? 'Solana' : (option.chainIdDec ? `Chain ID: ${option.chainIdDec}` : `Chain ID: ${option.chainIdHex}`));
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
    if (isSolanaWalletActive() && window.solanaWalletManager.disconnect) {
        window.solanaWalletManager.disconnect();
    }
    if (window.walletManager) {
        window.walletManager.disconnect();
    }
}

function initializeWalletIntegration() {
    if (walletDisconnectCleanup) {
        walletDisconnectCleanup();
        walletDisconnectCleanup = null;
    }

    const disposers = [];

    // EVM wallet events
    if (window.walletManager) {
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
    }

    // Solana wallet events
    if (window.solanaWalletManager && typeof window.solanaWalletManager.on === 'function') {
        disposers.push(window.solanaWalletManager.on('stateChanged', () => {
            updateWalletButtonDisplay();
            updateUsernameDisplay();
        }));
    }

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

    // Prefer Solana wallet if active
    let chainId, status;
    if (isSolanaWalletActive()) {
        chainId = getSolanaChainId();
        status = 'connected';
    } else {
        const state = walletState || (window.walletManager ? window.walletManager.getState() : null);
        chainId = state ? state.chainId : null;
        status = state ? state.status : 'idle';
    }
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
window.openTakeoverAgentDialog = openTakeoverAgentDialog;
window.isProposalDeepLink = isProposalDeepLinkPath;
window.ensureGuestUserAgentForDeepLink = ensureGuestUserAgentForDeepLink;
window.shouldSkipWelcomeForProposalLink = isProposalDeepLinkPath;
// Where a proposal created right now would be minted.
//
// createProposal() decides this implicitly, from three independent globals checked in a fixed order
// (Canton mode, then a Solana wallet, then an EVM wallet). Nothing told the user, so a proposal could
// go to a chain they had forgotten they selected. This is that same decision, named once, so the create
// dialog and the mint dispatch cannot disagree — keep the order in step with createProposal().
function getActiveMintTarget() {
    try {
        if (window.CantonMode && typeof window.CantonMode.isActive === 'function' && window.CantonMode.isActive()) {
            const party = (typeof window.CantonMode.getParty === 'function') ? window.CantonMode.getParty() : '';
            return { chain: 'canton', label: 'Canton (DevNet)', onchain: true, identity: party || null };
        }
    } catch (_) { }

    try {
        const solana = window.solanaWalletManager;
        const state = solana && typeof solana.getState === 'function' ? solana.getState() : null;
        if (state && state.status === 'connected' && Array.isArray(state.accounts) && state.accounts.length) {
            const cluster = (typeof window.getSolanaChainId === 'function') ? window.getSolanaChainId() : 'solana';
            const info = NETWORK_LABELS[cluster];
            return { chain: cluster, label: (info && info.label) || 'Solana', onchain: true, identity: state.accounts[0] };
        }
    } catch (_) { }

    try {
        const wallet = window.walletManager;
        const state = wallet && typeof wallet.getState === 'function' ? wallet.getState() : null;
        if (state && state.status === 'connected' && state.chainId) {
            const info = getNetworkDisplayInfo(state.chainId, state.status);
            return { chain: info.chainId, label: info.text, onchain: true, identity: (state.accounts && state.accounts[0]) || null };
        }
    } catch (_) { }

    return { chain: null, label: 'Off-chain (this browser only)', onchain: false, identity: null };
}

window.getActiveMintTarget = getActiveMintTarget;
