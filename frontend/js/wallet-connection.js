(function () {
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    if (!globalScope) {
        return;
    }

    const providerRegistry = new Map();
    const providerRefs = new WeakSet();
    const eventHub = new EventTarget();
    let activeProvider = null;
    let activeConnectorId = null;
    let providerCleanup = null;
    let autoConnectAttempted = false;
    let connectorModal = null;

    const STORAGE_NAMESPACE = 'consensus-wallet';
    const STORAGE_KEYS = {
        lastConnector: `${STORAGE_NAMESPACE}:lastConnector`
    };

    const state = {
        status: 'idle',
        accounts: [],
        chainId: null,
        connectorId: null,
        connectorName: null,
        error: null,
        isAutoConnected: false
    };

    function cloneState() {
        return {
            status: state.status,
            accounts: [...state.accounts],
            chainId: state.chainId,
            connectorId: state.connectorId,
            connectorName: state.connectorName,
            error: state.error,
            isAutoConnected: state.isAutoConnected
        };
    }

    function broadcast(type, extra = {}) {
        eventHub.dispatchEvent(new CustomEvent(type, { detail: { state: cloneState(), ...extra } }));
    }

    function updateState(patch) {
        Object.assign(state, patch);
        broadcast('stateChanged');
    }

    function safePersistentCall(action, key, value) {
        const storage = globalScope.PersistentStorage;
        if (!storage || typeof storage[action] !== 'function') {
            return;
        }
        try {
            storage[action](key, value);
        } catch (err) {
            console.warn(`Wallet persistence ${action} failed for ${key}`, err);
        }
    }

    function persistLastConnector(connectorId) {
        safePersistentCall('setItem', STORAGE_KEYS.lastConnector, connectorId);
    }

    function clearPersistedConnector() {
        safePersistentCall('removeItem', STORAGE_KEYS.lastConnector);
    }

    function normalizeAccounts(accounts) {
        if (!Array.isArray(accounts)) return [];
        const deduped = new Set();
        accounts.forEach(account => {
            if (!account && account !== 0) return;
            const str = String(account).trim();
            if (str) {
                deduped.add(str);
            }
        });
        return Array.from(deduped);
    }

    function inferConnectorName(provider) {
        if (!provider) return 'Browser Wallet';
        if (provider.isMetaMask) return 'MetaMask';
        if (provider.isBraveWallet) return 'Brave Wallet';
        if (provider.isCoinbaseWallet) return 'Coinbase Wallet';
        if (provider.isFrame) return 'Frame';
        if (provider.isExodus) return 'Exodus';
        if (provider.isTokenPocket) return 'TokenPocket';
        if (provider.isMathWallet) return 'MathWallet';
        return 'Browser Wallet';
    }

    function slugifyName(name) {
        return (name || 'wallet').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'wallet';
    }

    function mapConnector(entry) {
        return {
            id: entry.id,
            name: entry.name,
            icon: entry.icon || null,
            type: entry.type,
            origin: entry.origin || null
        };
    }

    function registerProvider(provider, metadata = {}) {
        if (!provider || providerRefs.has(provider)) {
            return;
        }

        providerRefs.add(provider);

        const { id: requestedId, name: requestedName, icon, rdns, origin, type } = metadata;
        const inferredName = requestedName || inferConnectorName(provider);
        const baseId = requestedId || `connector-${slugifyName(inferredName)}`;
        let uniqueId = baseId;
        let suffix = 1;
        while (providerRegistry.has(uniqueId)) {
            uniqueId = `${baseId}-${++suffix}`;
        }

        providerRegistry.set(uniqueId, {
            id: uniqueId,
            name: inferredName,
            icon: icon || null,
            origin: origin || rdns || null,
            type: type || 'injected',
            provider
        });

        broadcast('providersChanged', { connectors: walletManager.getConnectors() });
        scheduleAutoConnectAttempt();
    }

    function detectEip6963Providers() {
        globalScope.addEventListener('eip6963:announceProvider', event => {
            if (!event || !event.detail) return;
            const { info, provider } = event.detail;
            if (!info || !provider) return;
            registerProvider(provider, {
                id: info.uuid,
                name: info.name,
                icon: info.icon,
                rdns: info.rdns,
                type: 'eip6963'
            });
        });

        try {
            globalScope.dispatchEvent(new Event('eip6963:requestProvider'));
        } catch (_) {
            // Ignore dispatch failures in older browsers
        }
    }

    function detectLegacyProviders() {
        const { ethereum } = globalScope;
        if (!ethereum) {
            return;
        }

        if (Array.isArray(ethereum.providers) && ethereum.providers.length) {
            ethereum.providers.forEach((provider, index) => {
                registerProvider(provider, {
                    id: provider.id || provider.uuid || `injected-${index + 1}`,
                    name: inferConnectorName(provider),
                    type: 'injected'
                });
            });
            return;
        }

        registerProvider(ethereum, {
            id: ethereum.id || ethereum.uuid || undefined,
            name: inferConnectorName(ethereum),
            type: 'injected'
        });
    }

    function describeError(error) {
        if (!error) return 'Unknown error occurred.';
        if (typeof error === 'string') return error;
        if (error.code === 4001) return 'Connection request was cancelled.';
        if (error.message) return error.message;
        return 'Failed to connect to the wallet.';
    }

    function detachProviderListeners() {
        if (providerCleanup) {
            try {
                providerCleanup();
            } catch (err) {
                console.warn('Failed to remove wallet listeners', err);
            }
            providerCleanup = null;
        }
    }

    function attachProviderListeners(provider) {
        if (!provider || typeof provider.on !== 'function') {
            providerCleanup = null;
            return;
        }

        const handleAccountsChanged = (accounts) => {
            const normalized = normalizeAccounts(accounts);
            if (normalized.length === 0) {
                walletManager.disconnect({ triggeredByProvider: true });
                return;
            }
            updateState({ accounts: normalized });
            broadcast('accountsChanged', { accounts: [...normalized], triggeredByProvider: true });
        };

        const handleChainChanged = (chainId) => {
            updateState({ chainId });
            broadcast('chainChanged', { chainId, triggeredByProvider: true });
        };

        const handleDisconnect = (payload) => {
            walletManager.disconnect({ triggeredByProvider: true, error: payload && payload.error ? payload.error : null });
        };

        provider.on('accountsChanged', handleAccountsChanged);
        provider.on('chainChanged', handleChainChanged);
        if (typeof provider.on === 'function') {
            provider.on('disconnect', handleDisconnect);
        }

        providerCleanup = () => {
            const off = provider.removeListener || provider.off;
            if (typeof off === 'function') {
                try { off.call(provider, 'accountsChanged', handleAccountsChanged); } catch (_) { }
                try { off.call(provider, 'chainChanged', handleChainChanged); } catch (_) { }
                try { off.call(provider, 'disconnect', handleDisconnect); } catch (_) { }
            }
        };
    }

    function finalizeConnection(entry, accounts, chainId, options = {}) {
        detachProviderListeners();

        const normalizedAccounts = normalizeAccounts(accounts);
        activeProvider = entry.provider;
        activeConnectorId = entry.id;
        attachProviderListeners(activeProvider);

        updateState({
            status: 'connected',
            accounts: normalizedAccounts,
            chainId: chainId || null,
            connectorId: entry.id,
            connectorName: entry.name,
            error: null,
            isAutoConnected: Boolean(options.isAutoConnect)
        });

        persistLastConnector(entry.id);

        broadcast('connect', {
            connector: mapConnector(entry),
            isAutoConnect: Boolean(options.isAutoConnect)
        });
        broadcast('accountsChanged', {
            accounts: [...normalizedAccounts],
            isAutoConnect: Boolean(options.isAutoConnect)
        });
        if (chainId !== undefined && chainId !== null) {
            broadcast('chainChanged', { chainId, isAutoConnect: Boolean(options.isAutoConnect) });
        }
    }

    async function readChainId(provider) {
        if (!provider || typeof provider.request !== 'function') return null;
        try {
            const chainId = await provider.request({ method: 'eth_chainId' });
            return chainId;
        } catch (err) {
            return null;
        }
    }

    async function tryAutoConnect(lastConnectorId) {
        if (!lastConnectorId) return false;
        const entry = providerRegistry.get(lastConnectorId);
        if (!entry) return false;

        const provider = entry.provider;
        if (!provider || typeof provider.request !== 'function') return false;

        try {
            const accounts = await provider.request({ method: 'eth_accounts' });
            const normalized = normalizeAccounts(accounts);
            if (normalized.length === 0) return false;
            const chainId = await readChainId(provider);
            finalizeConnection(entry, normalized, chainId, { isAutoConnect: true });
            return true;
        } catch (err) {
            console.warn('Wallet auto-connect failed', err);
            return false;
        }
    }

    async function scheduleAutoConnectAttempt(attempt = 0) {
        if (autoConnectAttempted) return;
        if (providerRegistry.size === 0) {
            if (attempt > 6) {
                autoConnectAttempted = true;
                return;
            }
            setTimeout(() => scheduleAutoConnectAttempt(attempt + 1), 250);
            return;
        }

        autoConnectAttempted = true;
        const storage = globalScope.PersistentStorage;
        if (!storage) return;
        try {
            if (storage.ready && typeof storage.ready.then === 'function') {
                await storage.ready;
            }
        } catch (_) {
            // Ignore readiness errors and keep going
        }
        const lastConnectorId = storage.getItem ? storage.getItem(STORAGE_KEYS.lastConnector) : null;
        if (lastConnectorId) {
            await tryAutoConnect(lastConnectorId);
        }
    }

    function ensureConnectorModal() {
        if (connectorModal) {
            return connectorModal;
        }

        const overlay = document.createElement('div');
        overlay.className = 'wallet-modal-overlay';
        overlay.setAttribute('tabindex', '-1');
        overlay.innerHTML = `
            <div class="wallet-modal" role="dialog" aria-modal="true">
                <div class="wallet-modal-header">
                    <h2>Connect a Wallet</h2>
                    <button type="button" class="wallet-modal-close" data-wallet-modal-close>&times;</button>
                </div>
                <div class="wallet-modal-body">
                    <div class="wallet-modal-description">Select one of the detected wallets to continue.</div>
                    <div class="wallet-options" data-wallet-options></div>
                    <div class="wallet-modal-error" data-wallet-modal-error></div>
                </div>
            </div>
        `;

        const detachProvidersListener = walletManager.on('providersChanged', () => {
            renderConnectorOptions();
        });

        const handleKeydown = (event) => {
            if (event.key === 'Escape') {
                walletManager.closeConnectorModal();
            }
        };

        overlay.addEventListener('click', event => {
            if (event.target === overlay) {
                walletManager.closeConnectorModal();
            }
        });

        overlay.querySelector('[data-wallet-modal-close]').addEventListener('click', () => {
            walletManager.closeConnectorModal();
        });

        overlay.addEventListener('keydown', handleKeydown);

        overlay.addEventListener('click', event => {
            const button = event.target.closest('[data-wallet-connector]');
            if (!button) {
                return;
            }
            const connectorId = button.getAttribute('data-wallet-connector');
            if (!connectorId) return;
            handleConnectorSelection(connectorId, button);
        });

        connectorModal = {
            overlay,
            detachProvidersListener,
            handleKeydown
        };

        return connectorModal;
    }

    function renderConnectorOptions() {
        if (!connectorModal) return;
        const { overlay } = connectorModal;
        const list = overlay.querySelector('[data-wallet-options]');
        const errorNode = overlay.querySelector('[data-wallet-modal-error]');
        if (errorNode) {
            errorNode.textContent = '';
        }
        if (!list) return;

        const connectors = walletManager.getConnectors();
        if (!connectors.length) {
            list.innerHTML = '<div class="wallet-modal-empty">No wallets were detected. Install MetaMask or another compatible wallet extension and reload the page.</div>';
            return;
        }

        list.innerHTML = connectors.map(connector => {
            const iconHtml = connector.icon ? `<img src="${connector.icon}" alt="${connector.name}" class="wallet-option-icon">` : '<div class="wallet-option-placeholder" aria-hidden="true"></div>';
            const originLabel = connector.origin ? connector.origin : (connector.type === 'eip6963' ? 'EIP-6963 Provider' : 'Injected Provider');
            return `
                <button type="button" class="wallet-option" data-wallet-connector="${connector.id}">
                    ${iconHtml}
                    <div class="wallet-option-meta">
                        <div class="wallet-option-name">${connector.name}</div>
                        <div class="wallet-option-origin">${originLabel}</div>
                    </div>
                </button>
            `;
        }).join('');
    }

    function setModalState({ message, isError, disableAll }) {
        if (!connectorModal) return;
        const { overlay } = connectorModal;
        const errorNode = overlay.querySelector('[data-wallet-modal-error]');
        if (errorNode) {
            errorNode.textContent = message || '';
            errorNode.classList.toggle('visible', Boolean(message));
            errorNode.classList.toggle('error', Boolean(isError));
        }
        const buttons = overlay.querySelectorAll('[data-wallet-connector]');
        buttons.forEach(button => {
            button.disabled = Boolean(disableAll);
        });
    }

    async function handleConnectorSelection(connectorId, buttonNode) {
        const connectors = walletManager.getConnectors();
        const entry = connectors.find(conn => conn.id === connectorId);
        if (!entry) {
            setModalState({ message: 'Selected wallet is no longer available.', isError: true });
            return;
        }

        setModalState({ message: `Connecting to ${entry.name}...`, disableAll: true, isError: false });

        try {
            await walletManager.connect(connectorId);
            walletManager.closeConnectorModal();
        } catch (err) {
            setModalState({ message: describeError(err), disableAll: false, isError: true });
        }
    }

    function destroyConnectorModal() {
        if (!connectorModal) return;
        const { overlay, detachProvidersListener, handleKeydown } = connectorModal;
        if (detachProvidersListener) {
            detachProvidersListener();
        }
        if (overlay) {
            overlay.removeEventListener('keydown', handleKeydown);
            if (overlay.parentElement) {
                overlay.parentElement.removeChild(overlay);
            }
        }
        connectorModal = null;
    }

    const walletManager = {
        getState() {
            return cloneState();
        },
        getProvider() {
            return activeProvider;
        },
        getConnectors() {
            const connectors = Array.from(providerRegistry.values()).map(mapConnector);
            const priorityOrder = {
                'MetaMask': 0,
                'Coinbase Wallet': 1,
                'Brave Wallet': 2
            };
            return connectors.sort((a, b) => {
                const weightA = priorityOrder[a.name] !== undefined ? priorityOrder[a.name] : 10;
                const weightB = priorityOrder[b.name] !== undefined ? priorityOrder[b.name] : 10;
                if (weightA !== weightB) return weightA - weightB;
                return a.name.localeCompare(b.name);
            });
        },
        async connect(connectorId) {
            const entry = providerRegistry.get(connectorId);
            if (!entry) {
                const error = new Error('Selected wallet is no longer available.');
                updateState({ error: error.message });
                broadcast('error', { error });
                throw error;
            }
            if (!entry.provider || typeof entry.provider.request !== 'function') {
                const error = new Error('The selected wallet cannot be used in this browser session.');
                updateState({ error: error.message });
                broadcast('error', { error });
                throw error;
            }

            updateState({ status: 'connecting', error: null });
            try {
                const accounts = await entry.provider.request({ method: 'eth_requestAccounts' });
                const normalized = normalizeAccounts(accounts);
                if (normalized.length === 0) {
                    throw new Error('No accounts were returned by the wallet.');
                }
                const chainId = await readChainId(entry.provider);
                finalizeConnection(entry, normalized, chainId, { isAutoConnect: false });
                return cloneState();
            } catch (err) {
                console.warn('Wallet connect error', err);
                const message = describeError(err);
                updateState({ status: 'idle', error: message, connectorId: null, connectorName: null, accounts: [], chainId: null, isAutoConnected: false });
                broadcast('error', { error: err });
                throw err;
            }
        },
        async disconnect(options = {}) {
            if (!state.connectorId && !activeProvider) {
                updateState({ status: 'idle', accounts: [], chainId: null, connectorId: null, connectorName: null, error: null, isAutoConnected: false });
                return;
            }

            const provider = activeProvider;
            detachProviderListeners();
            activeProvider = null;
            const previousConnectorId = activeConnectorId;
            activeConnectorId = null;

            if (provider && typeof provider.disconnect === 'function' && !options.triggeredByProvider) {
                try {
                    await provider.disconnect();
                } catch (err) {
                    console.warn('Wallet disconnect request failed', err);
                }
            }

            clearPersistedConnector();
            updateState({ status: 'idle', accounts: [], chainId: null, connectorId: null, connectorName: null, error: null, isAutoConnected: false });
            broadcast('disconnect', {
                previousConnectorId: previousConnectorId,
                triggeredByProvider: Boolean(options.triggeredByProvider),
                error: options.error || null
            });
        },
        async tryAutoConnect() {
            autoConnectAttempted = true;
            const storage = globalScope.PersistentStorage;
            if (!storage) return false;
            try {
                if (storage.ready && typeof storage.ready.then === 'function') {
                    await storage.ready;
                }
            } catch (_) {
                // ignore readiness failure
            }
            const lastConnectorId = storage.getItem ? storage.getItem(STORAGE_KEYS.lastConnector) : null;
            return tryAutoConnect(lastConnectorId);
        },
        on(event, handler) {
            if (typeof handler !== 'function') {
                return () => { };
            }
            const listener = evt => handler(evt.detail);
            eventHub.addEventListener(event, listener);
            return () => eventHub.removeEventListener(event, listener);
        },
        off(event, handler) {
            if (typeof handler !== 'function') return;
            eventHub.removeEventListener(event, handler);
        },
        openConnectorModal() {
            const modal = ensureConnectorModal();
            if (!modal) return;
            renderConnectorOptions();
            document.body.appendChild(modal.overlay);
            modal.overlay.focus({ preventScroll: true });
        },
        closeConnectorModal() {
            destroyConnectorModal();
        }
    };

    function initialize() {
        detectEip6963Providers();
        detectLegacyProviders();

        if (document && document.readyState !== 'complete') {
            globalScope.addEventListener('load', () => detectLegacyProviders());
        } else {
            setTimeout(detectLegacyProviders, 0);
        }

        // Fallback detection for browsers that inject providers after a delay
        setTimeout(detectLegacyProviders, 500);
        setTimeout(detectLegacyProviders, 1500);

        scheduleAutoConnectAttempt();
    }

    globalScope.walletManager = walletManager;
    initialize();
})();
