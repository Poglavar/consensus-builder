(function (global) {
    'use strict';

    const PARCEL_CLAIM_RPC_FALLBACKS = {
        '1': null,
        '5': null,
        '11155111': null,
        '84532': null,
        '8453': null,
        // Provide a dev default for local hardhat/anvil
        '31337': 'http://127.0.0.1:8545'
    };

    const SOLANA_RPC_FALLBACKS = {
        'mainnet-beta': 'https://api.mainnet-beta.solana.com',
        devnet: 'https://api.devnet.solana.com',
        testnet: 'https://api.testnet.solana.com'
    };
    const PARCEL_CLAIM_PORTAL_URLS = {
        production: 'https://claim.consensus.land/',
        staging: 'https://staging-claim.consensus.land/',
        development: 'http://localhost:3001/'
    };

    function isLocalHostname(hostname) {
        if (!hostname || typeof hostname !== 'string') return false;
        const lower = hostname.toLowerCase();
        return lower === 'localhost' || lower === '127.0.0.1' || lower === '0.0.0.0' || lower.endsWith('.local');
    }

    function isLocalRpcUrl(rpcUrl) {
        try {
            const url = new URL(rpcUrl);
            return isLocalHostname(url.hostname);
        } catch (_) {
            return false;
        }
    }

    function isRunningOnLocalhost(globalScope) {
        const host = globalScope && globalScope.location && typeof globalScope.location.hostname === 'string'
            ? globalScope.location.hostname
            : '';
        return isLocalHostname(host);
    }

    function normalizeChainIdValue(chainIdInput) {
        if (chainIdInput === undefined || chainIdInput === null) return null;
        if (typeof chainIdInput === 'bigint') {
            return chainIdInput.toString();
        }
        if (typeof chainIdInput === 'number') {
            if (!Number.isFinite(chainIdInput)) return null;
            return String(Math.trunc(chainIdInput));
        }
        if (typeof chainIdInput === 'string') {
            const trimmed = chainIdInput.trim();
            if (!trimmed) return null;
            const lower = trimmed.toLowerCase();
            const named = {
                'ethereum': '1',
                'mainnet': '1',
                'goerli': '5',
                'sepolia': '11155111',
                'base-sepolia': '84532',
                'base': '8453',
                'hardhat': '31337',
                'anvil': '31337',
                'localhost': '31337',
                'default': null
            };
            if (Object.prototype.hasOwnProperty.call(named, lower) && named[lower]) {
                return named[lower];
            }
            if (trimmed.startsWith('0x') || trimmed.startsWith('0X')) {
                try {
                    return BigInt(trimmed).toString();
                } catch (_) {
                    return trimmed.toLowerCase();
                }
            }
            const numeric = Number(trimmed);
            if (Number.isFinite(numeric)) {
                return String(Math.trunc(numeric));
            }
            return trimmed;
        }
        return String(chainIdInput);
    }

    function chainKeyVariants(chainIdInput) {
        const normalized = normalizeChainIdValue(chainIdInput);
        const variants = new Set();
        if (normalized) {
            variants.add(normalized);
            const numeric = Number(normalized);
            if (Number.isFinite(numeric)) {
                const hex = '0x' + numeric.toString(16);
                variants.add(hex);
                variants.add(hex.toLowerCase());
                variants.add(hex.toUpperCase());
            }
        }
        if (typeof chainIdInput === 'string') {
            const trimmed = chainIdInput.trim();
            if (trimmed) {
                variants.add(trimmed);
                variants.add(trimmed.toLowerCase());
            }
        }
        switch (normalized) {
            case '1':
                variants.add('ethereum');
                break;
            case '5':
                variants.add('goerli');
                break;
            case '11155111':
                variants.add('sepolia');
                break;
            case '84532':
                variants.add('base-sepolia');
                break;
            case '8453':
                variants.add('base');
                break;
            case '31337':
                variants.add('hardhat');
                variants.add('anvil');
                variants.add('localhost');
                break;
            default:
                break;
        }
        variants.add('default');
        return Array.from(variants).filter(Boolean).map(value => value.toLowerCase());
    }

    function resolveChainSlug(chainIdInput) {
        const normalized = normalizeChainIdValue(chainIdInput);
        if (!normalized) return 'ethereum';
        const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
        const overrides = (globalScope && typeof globalScope.CLAIM_CHAIN_SLUGS === 'object' && globalScope.CLAIM_CHAIN_SLUGS) || null;
        if (overrides && overrides[normalized]) {
            const override = String(overrides[normalized]).trim();
            if (override) {
                return override;
            }
        }
        switch (normalized) {
            case '1':
                return 'ethereum';
            case '5':
                return 'goerli';
            case '11155111':
                return 'sepolia';
            case '84532':
                return 'base-sepolia';
            case '8453':
                return 'base';
            case '31337':
                return 'localhost';
            case 'solana':
                return 'solana-devnet';
            default:
                if (normalized && normalized.startsWith('solana-')) {
                    return normalized;
                }
                return overrides && typeof overrides.default === 'string' && overrides.default.trim()
                    ? overrides.default.trim()
                    : 'ethereum';
        }
    }

    function resolveRpcUrlForChain(chainIdInput) {
        const normalized = normalizeChainIdValue(chainIdInput);
        if (!normalized) return null;
        const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
        if (globalScope) {
            if (typeof globalScope.CLAIM_RPC_URL === 'string' && globalScope.CLAIM_RPC_URL.trim()) {
                return globalScope.CLAIM_RPC_URL.trim();
            }
            if (globalScope.CLAIM_RPC_URLS && typeof globalScope.CLAIM_RPC_URLS === 'object') {
                const custom = globalScope.CLAIM_RPC_URLS[normalized];
                if (typeof custom === 'string' && custom.trim()) {
                    return custom.trim();
                }
            }
            if (typeof globalScope.PARCEL_NFT_RPC_URL === 'string' && globalScope.PARCEL_NFT_RPC_URL.trim()) {
                return globalScope.PARCEL_NFT_RPC_URL.trim();
            }
            if (globalScope.PARCEL_NFT_RPC_URLS && typeof globalScope.PARCEL_NFT_RPC_URLS === 'object') {
                const customParcel = globalScope.PARCEL_NFT_RPC_URLS[normalized];
                if (typeof customParcel === 'string' && customParcel.trim()) {
                    return customParcel.trim();
                }
            }
        }
        return PARCEL_CLAIM_RPC_FALLBACKS[normalized] || null;
    }

    async function probeRpcEndpoint(rpcUrl) {
        if (!rpcUrl || typeof rpcUrl !== 'string') return false;
        try {
            const response = await fetch(rpcUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'eth_chainId',
                    params: []
                }),
                cache: 'no-store'
            });
            return response.ok;
        } catch (error) {
            const message = error && error.message ? error.message : error;
            console.warn('RPC probe failed for parcel claim resolution:', message);
            return false;
        }
    }

    function normalizeContractAddress(address, ethersLib) {
        if (typeof address !== 'string') return null;
        const trimmed = address.trim();
        if (!trimmed) return null;
        if (ethersLib && typeof ethersLib.getAddress === 'function') {
            try {
                return ethersLib.getAddress(trimmed);
            } catch (error) {
                console.warn('Invalid ParcelNFT address encountered:', trimmed, error);
                return null;
            }
        }
        return trimmed;
    }

    function deriveParcelIdentifier(feature) {
        if (!feature || typeof feature !== 'object') return null;
        const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
        if (globalScope && globalScope.ProposalChainBridge && typeof globalScope.ProposalChainBridge.deriveParcelIdFromFeature === 'function') {
            try {
                const derived = globalScope.ProposalChainBridge.deriveParcelIdFromFeature(feature);
                if (derived) {
                    return derived;
                }
            } catch (error) {
                console.warn('Failed to derive parcel id using ProposalChainBridge', error);
            }
        }
        const props = feature.properties || {};
        const brojCestice = props.BROJ_CESTICE ?? props.broj_cestice ?? props.parcel_number ?? props.parcelNumber;
        const maticniBrojKo = props.MATICNI_BROJ_KO ?? props.maticni_broj_ko ?? (props.cadastralMunicipality && props.cadastralMunicipality.id);
        if (brojCestice !== undefined && brojCestice !== null && maticniBrojKo !== undefined && maticniBrojKo !== null) {
            const numberStr = String(brojCestice).trim();
            const municipalityStr = String(maticniBrojKo).trim();
            if (numberStr && municipalityStr) {
                return `HR-${municipalityStr}-${numberStr}`;
            }
        }
        const fallbacks = [
            props.parcelId,
        ];
        for (const value of fallbacks) {
            if (value === undefined || value === null) continue;
            const str = String(value).trim();
            if (str) return str;
        }
        return null;
    }

    function deriveParcelDisplayName(props, fallbackName) {
        if (!props || typeof props !== 'object') {
            return fallbackName;
        }
        const preferredFields = [
            props.name,
            props.NAME,
            props.naziv,
            props.NAZIV,
            props.parcel_name,
            props.PARCEL_NAME,
            props.title
        ];
        for (const value of preferredFields) {
            if (value === undefined || value === null) continue;
            const str = String(value).trim();
            if (str) return str;
        }
        const brojCestice = props.BROJ_CESTICE ?? props.broj_cestice ?? props.parcel_number ?? props.parcelNumber;
        if (brojCestice !== undefined && brojCestice !== null) {
            const numberStr = String(brojCestice).trim();
            if (numberStr) return `Parcel ${numberStr}`;
        }
        return fallbackName;
    }

    async function resolveParcelNftAddressSolana(cluster) {
        const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
        if (!globalScope) return null;
        try {
            const resp = await fetch('/contracts/addresses.json');
            if (resp && resp.ok) {
                const data = await resp.json();
                const solana = data.solana || data['solana-devnet'] || data['solana-mainnet'];
                if (solana && solana.ParcelNFT) return solana.ParcelNFT;
            }
        } catch (err) {
            console.warn('Failed to resolve Solana ParcelNFT from addresses.json:', err);
        }
        if (globalScope.SolanaChainDataLoader && typeof globalScope.SolanaChainDataLoader.resolveProgramAddress === 'function') {
            try {
                return await globalScope.SolanaChainDataLoader.resolveProgramAddress(cluster, 'ParcelNFT');
            } catch (_) {}
        }
        return null;
    }

    async function resolveParcelNftAddress(chainIdInput) {
        const normalized = normalizeChainIdValue(chainIdInput);
        if (!normalized) return null;
        const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
        if (!globalScope) return null;
        try {
            const resp = await fetch('/contracts/addresses.json');
            if (resp && resp.ok) {
                const data = await resp.json();
                const address = data && data[normalized] && data[normalized].ParcelNFT;
                if (typeof address === 'string' && address.trim()) {
                    return address.trim();
                }
            }
        } catch (err) {
            console.warn('Failed to resolve ParcelNFT from addresses.json:', err);
        }
        if (globalScope.ContractsLoader && typeof globalScope.ContractsLoader.getContractAddress === 'function') {
            try {
                const loaderAddress = await globalScope.ContractsLoader.getContractAddress(normalized, 'ParcelNFT');
                if (loaderAddress) {
                    return loaderAddress;
                }
            } catch (error) {
                console.warn('Failed to load ParcelNFT address from ContractsLoader:', error);
            }
        }
        const directSources = [
            globalScope.PARCEL_NFT_ADDRESS,
            globalScope.parcelNftAddress,
            globalScope.envParcelNftAddress,
            globalScope.CONSENSUS_PARCEL_NFT_ADDRESS
        ];
        for (const source of directSources) {
            if (typeof source === 'string' && source.trim()) {
                return source.trim();
            }
        }
        const variants = chainKeyVariants(normalized);
        const objectSources = [
            globalScope.CONSENSUS_CONTRACTS && globalScope.CONSENSUS_CONTRACTS.parcelNFT,
            globalScope.consensusContracts && globalScope.consensusContracts.parcelNFT
        ];
        for (const candidate of objectSources) {
            if (!candidate) continue;
            if (typeof candidate === 'string' && candidate.trim()) {
                return candidate.trim();
            }
            if (typeof candidate === 'object') {
                for (const key of variants) {
                    const value = candidate[key];
                    if (typeof value === 'string' && value.trim()) {
                        return value.trim();
                    }
                }
            }
        }
        try {
            if (globalScope.PersistentStorage && typeof globalScope.PersistentStorage.getItem === 'function') {
                const storageKeys = ['parcel_nft_address', 'parcelNFTAddress', 'parcelNftAddress'];
                for (const key of storageKeys) {
                    const stored = globalScope.PersistentStorage.getItem(key);
                    if (typeof stored === 'string' && stored.trim()) {
                        return stored.trim();
                    }
                }
            }
        } catch (error) {
            console.warn('Failed to load ParcelNFT address from persistent storage', error);
        }
        return null;
    }

    async function resolveParcelClaimContext() {
        const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
        if (!globalScope) {
            throw new Error('Global scope not available.');
        }

        // Check Solana wallet first
        const solanaWalletManager = globalScope.solanaWalletManager;
        const solanaState = solanaWalletManager && typeof solanaWalletManager.getState === 'function' ? solanaWalletManager.getState() : null;
        if (solanaState && solanaState.status === 'connected' && Array.isArray(solanaState.accounts) && solanaState.accounts.length > 0) {
            const parcelProgramId = await resolveParcelNftAddressSolana(solanaState.cluster || 'devnet');
            if (parcelProgramId && globalScope.SolanaChainDataLoader) {
                const connection = globalScope.SolanaChainDataLoader.getConnection(solanaState.cluster || 'devnet');
                return {
                    chainId: 'solana',
                    chainSlug: `solana-${solanaState.cluster || 'devnet'}`,
                    contractAddress: parcelProgramId,
                    provider: connection,
                    chainType: 'solana'
                };
            }
        }

        if (!globalScope.ethers) {
            throw new Error('Blockchain library is not available.');
        }
        const walletManager = globalScope.walletManager;
        const walletState = walletManager && typeof walletManager.getState === 'function' ? walletManager.getState() : null;
        const walletProvider = walletManager && typeof walletManager.getProvider === 'function' ? walletManager.getProvider() : null;

        const candidates = [];
        if (walletState && walletState.chainId !== undefined && walletState.chainId !== null) {
            const normalized = normalizeChainIdValue(walletState.chainId);
            if (normalized) {
                candidates.push({ chainId: normalized, source: 'wallet', provider: walletProvider });
            }
        }

        if (Array.isArray(globalScope.CLAIM_CHAIN_ID_PRIORITY)) {
            globalScope.CLAIM_CHAIN_ID_PRIORITY.forEach(idValue => {
                const normalized = normalizeChainIdValue(idValue);
                if (normalized && !candidates.some(entry => entry.chainId === normalized)) {
                    candidates.push({ chainId: normalized, source: 'priority' });
                }
            });
        }

        const defaultChainId = normalizeChainIdValue((function () {
            if (globalScope.DEFAULT_CHAIN_ID !== undefined && globalScope.DEFAULT_CHAIN_ID !== null) {
                return globalScope.DEFAULT_CHAIN_ID;
            }
            const env = globalScope.current_environment || 'production';
            if (env === 'development') return '31337';
            return '84532';
        })());
        if (defaultChainId && !candidates.some(entry => entry.chainId === defaultChainId)) {
            candidates.push({ chainId: defaultChainId, source: 'default' });
        }

        if (candidates.length === 0) {
            throw new Error('No chain candidates available for parcel claims.');
        }

        for (const candidate of candidates) {
            const resolvedAddress = await resolveParcelNftAddress(candidate.chainId);
            if (!resolvedAddress) {
                continue;
            }

            if (candidate.source === 'wallet' && candidate.provider) {
                try {
                    const browserProvider = new globalScope.ethers.BrowserProvider(candidate.provider);
                    const network = await browserProvider.getNetwork();
                    const networkChainId = network && network.chainId ? normalizeChainIdValue(network.chainId) : candidate.chainId;
                    const addressForNetwork = await resolveParcelNftAddress(networkChainId);
                    const normalizedAddress = normalizeContractAddress(addressForNetwork || resolvedAddress, globalScope.ethers);
                    if (!normalizedAddress) {
                        continue;
                    }
                    return {
                        chainId: networkChainId,
                        chainSlug: resolveChainSlug(networkChainId),
                        contractAddress: normalizedAddress,
                        provider: browserProvider
                    };
                } catch (error) {
                    console.warn('Wallet provider unusable for parcel claim context', error);
                }
            }

            const rpcUrl = resolveRpcUrlForChain(candidate.chainId);
            if (!rpcUrl) {
                console.warn('No RPC endpoint configured for chain', candidate.chainId);
                continue;
            }

            const rpcIsLocal = isLocalRpcUrl(rpcUrl);
            const appIsLocal = isRunningOnLocalhost(globalScope);
            if (rpcIsLocal && !appIsLocal) {
                console.warn('Skipping localhost RPC for parcel claim resolution because app is not running locally', {
                    chainId: candidate.chainId,
                    rpcUrl
                });
                continue;
            }

            const rpcReachable = await probeRpcEndpoint(rpcUrl);
            if (!rpcReachable) {
                console.warn('RPC endpoint unreachable for parcel claim resolution', {
                    chainId: candidate.chainId,
                    rpcUrl
                });
                continue;
            }

            const normalizedAddress = normalizeContractAddress(resolvedAddress, globalScope.ethers);
            if (!normalizedAddress) {
                continue;
            }

            const numericChainId = Number(candidate.chainId);
            let provider;
            try {
                provider = Number.isFinite(numericChainId)
                    ? new globalScope.ethers.JsonRpcProvider(rpcUrl, numericChainId)
                    : new globalScope.ethers.JsonRpcProvider(rpcUrl);
            } catch (error) {
                const message = error && error.message ? error.message : error;
                console.warn('Unable to initialize RPC provider for parcel claim resolution:', {
                    chainId: candidate.chainId,
                    rpcUrl,
                    message
                });
                continue;
            }

            return {
                chainId: candidate.chainId,
                chainSlug: resolveChainSlug(candidate.chainId),
                contractAddress: normalizedAddress,
                provider
            };
        }

        throw new Error('ParcelNFT contract configuration or RPC connectivity is unavailable for parcel claims.');
    }

    function isParcelTokenMissingError(error) {
        if (!error) return false;
        const candidates = [
            typeof error.shortMessage === 'string' ? error.shortMessage : null,
            typeof error.message === 'string' ? error.message : null,
            typeof error.reason === 'string' ? error.reason : null,
            typeof error.data === 'string' ? error.data : null,
            typeof error.data?.message === 'string' ? error.data.message : null,
            typeof error?.info?.error?.message === 'string' ? error.info.error.message : null,
            typeof error?.info?.error?.data?.message === 'string' ? error.info.error.data.message : null,
            typeof error?.error?.message === 'string' ? error.error.message : null,
            typeof error?.error?.data?.message === 'string' ? error.error.data.message : null,
            typeof error?.data?.originalError?.message === 'string' ? error.data.originalError.message : null,
            typeof error?.error?.data?.originalError?.message === 'string' ? error.error.data.originalError.message : null,
            typeof error?.data?.originalError?.data === 'string' ? error.data.originalError.data : null,
            typeof error?.error?.data?.originalError?.data === 'string' ? error.error.data.originalError.data : null
        ].filter(Boolean);
        if (candidates.length === 0) return false;
        return candidates.some(msg => msg.toLowerCase().includes('parcel does not exist'));
    }

    function buildClaimUrl({ baseUrl, chainSlug, contractAddress, tokenId, parcelName }) {
        const url = new URL(baseUrl || PARCEL_CLAIM_PORTAL_URLS.production);
        url.searchParams.set('attest', 'ownership');
        if (chainSlug) {
            url.searchParams.set('chain', chainSlug);
        }
        if (contractAddress) {
            url.searchParams.set('contract', contractAddress);
        }
        if (tokenId !== undefined && tokenId !== null) {
            url.searchParams.set('tokenId', tokenId.toString());
        }
        if (parcelName) {
            url.searchParams.set('parcel', parcelName);
        }
        return url.toString();
    }

    global.resolveParcelNftAddressSolana = resolveParcelNftAddressSolana;
    global.normalizeChainIdValue = normalizeChainIdValue;
    global.chainKeyVariants = chainKeyVariants;
    global.resolveChainSlug = resolveChainSlug;
    global.resolveRpcUrlForChain = resolveRpcUrlForChain;
    global.normalizeContractAddress = normalizeContractAddress;
    global.deriveParcelIdentifier = deriveParcelIdentifier;
    global.deriveParcelDisplayName = deriveParcelDisplayName;
    global.resolveParcelNftAddress = resolveParcelNftAddress;
    global.resolveParcelClaimContext = resolveParcelClaimContext;
    global.isParcelTokenMissingError = isParcelTokenMissingError;
    global.buildClaimUrl = buildClaimUrl;
})(typeof window !== 'undefined' ? window : globalThis);

