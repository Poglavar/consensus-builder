/**
 * Solana Wallet Adapter
 * Connects to Phantom, Solflare, and other Solana wallets via window.solana
 * Integrates with the unified wallet flow - registers as a "connector" for Solana
 */
(function () {
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    if (!globalScope) return;

    const STORAGE_NAMESPACE = 'consensus-wallet';
    const STORAGE_KEYS = {
        lastSolanaConnector: `${STORAGE_NAMESPACE}:lastSolanaConnector`,
        solanaCluster: `${STORAGE_NAMESPACE}:solanaCluster`
    };

    const CLUSTERS = Object.freeze({
        'mainnet-beta': { rpc: 'https://api.mainnet-beta.solana.com', name: 'Mainnet' },
        devnet: { rpc: 'https://api.devnet.solana.com', name: 'Devnet' },
        testnet: { rpc: 'https://api.testnet.solana.com', name: 'Testnet' }
    });

    const DEFAULT_CLUSTER = 'devnet';

    const state = {
        status: 'idle',
        accounts: [],
        cluster: DEFAULT_CLUSTER,
        connectorId: null,
        connectorName: null,
        error: null,
        isAutoConnected: false
    };

    let activeProvider = null;
    let activeConnectorId = null;
    const eventHub = new EventTarget();

    function cloneState() {
        return {
            status: state.status,
            accounts: [...state.accounts],
            cluster: state.cluster,
            chainId: 'solana',
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

    function persistLastConnector(connectorId) {
        try {
            if (globalScope.PersistentStorage && typeof globalScope.PersistentStorage.setItem === 'function') {
                globalScope.PersistentStorage.setItem(STORAGE_KEYS.lastSolanaConnector, connectorId);
            }
        } catch (_) {}
    }

    function clearPersistedConnector() {
        try {
            if (globalScope.PersistentStorage && typeof globalScope.PersistentStorage.removeItem === 'function') {
                globalScope.PersistentStorage.removeItem(STORAGE_KEYS.lastSolanaConnector);
            }
        } catch (_) {}
    }

    function getSolanaProviders() {
        const providers = [];
        if (globalScope.solana && typeof globalScope.solana === 'object') {
            const name = globalScope.solana.isPhantom ? 'Phantom' :
                globalScope.solana.isSolflare ? 'Solflare' :
                globalScope.solana.isBackpack ? 'Backpack' :
                globalScope.solana.isBraveWallet ? 'Brave Wallet' : 'Solana Wallet';
            providers.push({ id: `solana-${name.toLowerCase().replace(/\s/g, '-')}`, name, provider: globalScope.solana });
        }
        if (globalScope.solflare && globalScope.solflare !== globalScope.solana) {
            providers.push({ id: 'solana-solflare', name: 'Solflare', provider: globalScope.solflare });
        }
        return providers;
    }

    async function connectProvider(entry) {
        const provider = entry.provider;
        if (!provider || typeof provider.connect !== 'function') {
            throw new Error('Solana wallet does not support connect');
        }

        const response = await provider.connect();
        const publicKey = response.publicKey || (response.publicKey?.toString ? response.publicKey : null);
        if (!publicKey) {
            throw new Error('No public key returned from wallet');
        }
        const address = typeof publicKey === 'string' ? publicKey : publicKey.toString();
        return [address];
    }

    async function tryAutoConnect() {
        try {
            if (globalScope.PersistentStorage && globalScope.PersistentStorage.ready) {
                await globalScope.PersistentStorage.ready;
            }
        } catch (_) {}
        const lastId = globalScope.PersistentStorage?.getItem?.(STORAGE_KEYS.lastSolanaConnector);
        if (!lastId) return false;

        const providers = getSolanaProviders();
        const entry = providers.find(p => p.id === lastId);
        if (!entry) return false;

        try {
            const provider = entry.provider;
            if (provider.connect && provider.disconnect) {
                const response = await provider.connect({ onlyIfTrusted: true });
                if (response && response.publicKey) {
                    const address = typeof response.publicKey === 'string' ? response.publicKey : response.publicKey.toString();
                    finalizeConnection(entry, [address], { isAutoConnect: true });
                    return true;
                }
            }
        } catch (_) {}
        return false;
    }

    function finalizeConnection(entry, accounts, options = {}) {
        activeProvider = entry.provider;
        activeConnectorId = entry.id;
        const cluster = state.cluster || DEFAULT_CLUSTER;

        updateState({
            status: 'connected',
            accounts: accounts || [],
            cluster,
            connectorId: entry.id,
            connectorName: entry.name,
            error: null,
            isAutoConnected: Boolean(options.isAutoConnect)
        });

        persistLastConnector(entry.id);
        broadcast('connect', { connector: { id: entry.id, name: entry.name }, isAutoConnect: Boolean(options.isAutoConnect) });
        broadcast('accountsChanged', { accounts: [...(accounts || [])], isAutoConnect: Boolean(options.isAutoConnect) });
    }

    const solanaWalletManager = {
        getState() {
            return cloneState();
        },
        getProvider() {
            return activeProvider;
        },
        getConnection() {
            const cluster = CLUSTERS[state.cluster] || CLUSTERS[DEFAULT_CLUSTER];
            if (!globalScope.solanaWeb3) return null;
            try {
                return new globalScope.solanaWeb3.Connection(cluster.rpc);
            } catch (_) {
                return null;
            }
        },
        getConnectors() {
            return getSolanaProviders().map(p => ({ id: p.id, name: p.name, type: 'solana' }));
        },
        getCluster() {
            return state.cluster || DEFAULT_CLUSTER;
        },
        setCluster(cluster) {
            if (CLUSTERS[cluster]) {
                updateState({ cluster });
                broadcast('chainChanged', { chainId: 'solana', cluster });
            }
        },
        async connect(connectorId) {
            const providers = getSolanaProviders();
            const entry = providers.find(p => p.id === connectorId);
            if (!entry) {
                throw new Error('Solana wallet not found');
            }

            updateState({ status: 'connecting', error: null });
            try {
                const accounts = await connectProvider(entry);
                if (!accounts || accounts.length === 0) {
                    throw new Error('No accounts returned');
                }
                finalizeConnection(entry, accounts, { isAutoConnect: false });
                return cloneState();
            } catch (err) {
                updateState({ status: 'idle', error: err?.message || 'Connection failed', accounts: [], connectorId: null, connectorName: null });
                broadcast('error', { error: err });
                throw err;
            }
        },
        async disconnect() {
            if (activeProvider && typeof activeProvider.disconnect === 'function') {
                try {
                    await activeProvider.disconnect();
                } catch (_) {}
            }
            activeProvider = null;
            activeConnectorId = null;
            clearPersistedConnector();
            updateState({ status: 'idle', accounts: [], cluster: DEFAULT_CLUSTER, connectorId: null, connectorName: null, error: null });
            broadcast('disconnect', {});
        },
        async tryAutoConnect() {
            return tryAutoConnect();
        },
        on(event, handler) {
            if (typeof handler !== 'function') return () => {};
            const listener = evt => handler(evt.detail);
            eventHub.addEventListener(event, listener);
            return () => eventHub.removeEventListener(event, listener);
        }
    };

    globalScope.solanaWalletManager = solanaWalletManager;

    if (document.readyState === 'complete') {
        tryAutoConnect();
    } else {
        globalScope.addEventListener('load', () => tryAutoConnect());
    }
})();
