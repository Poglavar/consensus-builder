// The EVM ParcelAnchor reader (ChainDataLoader): the parcels a wallet anchored, the anchored parcel
// count and ids, and the contract address resolution and provider every EVM read shares. An anchor is
// ownerless (docs/blockchain-flows.md): a wallet only pays for creating it and holds nothing. The
// parcel anchor paths read through it: the anchored-parcels layer (parcels/ui/minted-layer.js), the
// agent profile's wallet parcels (agents.js) and the city token's address (user-management.js).

(function () {
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    if (!globalScope) {
        return;
    }

    // The ParcelAnchor contract (blockchain/contracts/ParcelAnchor.sol); claim.js reuses it.
    const ANCHOR_TUPLE = '(string parcelId, string metadataURI, uint64 anchoredAt, address anchoredBy)';
    const PARCEL_ANCHOR_ABI = [
        'function anchor(string parcelId, string metadataURI) returns (bytes32)',
        'function anchorBatch(string[] parcelIds, string[] metadataURIs) returns (uint256)',
        'function isAnchored(string parcelId) view returns (bool)',
        'function missing(string[] parcelIds) view returns (bool[])',
        `function anchorOf(string parcelId) view returns (${ANCHOR_TUPLE})`,
        'function count() view returns (uint256)',
        `function anchors(uint256 offset, uint256 limit) view returns (${ANCHOR_TUPLE}[])`,
        'function countBy(address creator) view returns (uint256)',
        `function anchoredBy(address creator, uint256 offset, uint256 limit) view returns (${ANCHOR_TUPLE}[])`,
        'function keyOf(string parcelId) pure returns (bytes32)'
    ];
    const ANCHOR_PAGE_SIZE = 200;

    /** The parcel's anchor key as a number, uint256(keccak256(parcelId)) (the claim portal's token id). */
    function anchorKeyOf(parcelId) {
        const { keccak256, toUtf8Bytes } = globalScope.ethers;
        return BigInt(keccak256(toUtf8Bytes(parcelId))).toString();
    }

    /** Reads every page of `readPage(offset, limit)` up to `total` anchors. */
    async function readAnchorPages(total, readPage, onProgress) {
        const rows = [];
        for (let offset = 0; offset < total; offset += ANCHOR_PAGE_SIZE) {
            const page = await readPage(offset, ANCHOR_PAGE_SIZE);
            rows.push(...page);
            if (typeof onProgress === 'function') onProgress(Math.min(offset + ANCHOR_PAGE_SIZE, total), total);
        }
        return rows;
    }

    /**
     * Check if an RPC URL is localhost
     */
    function isLocalRpcUrl(rpcUrl) {
        if (!rpcUrl || typeof rpcUrl !== 'string') return false;
        try {
            const url = new URL(rpcUrl);
            const hostname = url.hostname.toLowerCase();
            return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname.endsWith('.local');
        } catch (_) {
            return false;
        }
    }

    /**
     * Get provider for a given chain
     * @param {string|number|bigint} chainId - The chain ID
     * @returns {Promise<Object>} Ethers provider
     */
    async function getProviderForChain(chainId) {
        if (!globalScope.ethers) {
            throw new Error('Ethers library not available');
        }

        // Try to use wallet provider if connected to the same chain
        if (globalScope.walletManager && typeof globalScope.walletManager.getProvider === 'function') {
            const walletProvider = globalScope.walletManager.getProvider();
            if (walletProvider) {
                try {
                    const browserProvider = new globalScope.ethers.BrowserProvider(walletProvider);
                    const network = await browserProvider.getNetwork();
                    const normalizedChainId = normalizeChainId(chainId);
                    const networkChainId = normalizeChainId(network.chainId);
                    if (normalizedChainId === networkChainId) {
                        return browserProvider;
                    }
                } catch (error) {
                    console.warn('Wallet provider not usable for chain', chainId, error);
                }
            }
        }

        // Fall back to RPC provider
        const rpcUrl = resolveRpcUrlForChain(chainId);
        if (!rpcUrl) {
            throw new Error(`No RPC URL configured for chain ${chainId}`);
        }

        // For local RPC URLs, check cache first to avoid creating providers that will retry
        if (isLocalRpcUrl(rpcUrl)) {
            if (globalScope.isLocalNodeAvailable && typeof globalScope.isLocalNodeAvailable === 'function') {
                const localNodeAvailable = await globalScope.isLocalNodeAvailable();
                if (!localNodeAvailable) {
                    throw new Error(`Local node not available for chain ${chainId}`);
                }
            }
        }

        const { JsonRpcProvider } = globalScope.ethers;
        return new JsonRpcProvider(rpcUrl);
    }

    /**
     * Normalize chain ID to string
     */
    function normalizeChainId(chainId) {
        if (typeof chainId === 'bigint') {
            return chainId.toString();
        }
        if (typeof chainId === 'number') {
            return String(Math.trunc(chainId));
        }
        if (typeof chainId === 'string') {
            const trimmed = chainId.trim();
            if (trimmed.startsWith('0x')) {
                try {
                    return BigInt(trimmed).toString();
                } catch (_) {
                    return trimmed;
                }
            }
            return trimmed;
        }
        return String(chainId);
    }

    /**
     * Resolve RPC URL for a chain (placeholder - should use your existing RPC resolution)
     */
    function resolveRpcUrlForChain(chainId) {
        const normalized = normalizeChainId(chainId);

        if (typeof globalScope.resolveRpcUrlForChain === 'function') {
            try {
                const url = globalScope.resolveRpcUrlForChain(normalized);
                if (url) return url;
            } catch (err) {
                console.warn('resolveRpcUrlForChain(global) failed', err);
            }
        }

        // The configured provider (EVM_RPC_URLS from rpc-config.js), else the public defaults
        // parcels/blockchain.js also falls back to.
        const configured = globalScope.EVM_RPC_URLS && globalScope.EVM_RPC_URLS[normalized];
        if (typeof configured === 'string' && configured.trim()) return configured.trim();
        const rpcMap = {
            '31337': 'http://localhost:8545',
            '11155111': 'https://ethereum-sepolia-rpc.publicnode.com',
            '84532': 'https://sepolia.base.org',
            '8453': 'https://mainnet.base.org'
        };
        return rpcMap[normalized] || null;
    }

    /**
     * Resolve contract address with fallbacks:
     * 1) ContractsLoader (contracts.json)
     * 2) /contracts/addresses.json (new helper)
     * 3) optional globals (CONSENSUS_CONTRACTS)
     */
    async function resolveContractAddress(chainId, contractName) {
        const normalizedChainId = normalizeChainId(chainId);

        // 1) addresses.json override
        try {
            const resp = await fetch('/contracts/addresses.json');
            if (resp && resp.ok) {
                const data = await resp.json();
                if (data && data[normalizedChainId] && data[normalizedChainId][contractName]) {
                    return data[normalizedChainId][contractName];
                }
            }
        } catch (err) {
            console.warn('addresses.json lookup failed', err);
        }

        // 2) ContractsLoader
        if (globalScope.ContractsLoader && typeof globalScope.ContractsLoader.getContractAddress === 'function') {
            try {
                const addr = await globalScope.ContractsLoader.getContractAddress(normalizedChainId, contractName);
                if (addr) return addr;
            } catch (err) {
                console.warn('ContractsLoader lookup failed', err);
            }
        }

        // 3) globals fallback
        const globalContracts =
            (globalScope.CONSENSUS_CONTRACTS && globalScope.CONSENSUS_CONTRACTS[normalizedChainId]) ||
            (globalScope.consensusContracts && globalScope.consensusContracts[normalizedChainId]) ||
            null;
        if (globalContracts && globalContracts[contractName]) {
            return globalContracts[contractName];
        }

        console.warn(`Contract address not found for ${contractName} on chain ${normalizedChainId}`);
        return null;
    }

    function anchorContract(provider, parcelContractAddress) {
        const { Contract, getAddress } = globalScope.ethers;
        return new Contract(getAddress(parcelContractAddress), PARCEL_ANCHOR_ABI, provider);
    }

    /**
     * The parcels a wallet anchored (paid for; an anchor has no owner), in creation order.
     * @param {string} walletAddress - The wallet address
     * @param {string|number|bigint} chainId - The chain ID
     * @param {string} parcelContractAddress - The ParcelAnchor contract address
     * @returns {Promise<Array>} Array of { tokenId, parcelId, metadataURI }; tokenId is the anchor key
     */
    async function getParcelsFromChain(walletAddress, chainId, parcelContractAddress) {
        if (!globalScope.ethers) {
            throw new Error('Ethers library not available');
        }

        if (!walletAddress || !chainId || !parcelContractAddress) {
            throw new Error('Missing required parameters: walletAddress, chainId, or parcelContractAddress');
        }

        const contract = anchorContract(await getProviderForChain(chainId), parcelContractAddress);
        const total = Number(await contract.countBy(walletAddress));
        const anchors = await readAnchorPages(total, (offset, limit) => contract.anchoredBy(walletAddress, offset, limit));
        return anchors.map(anchor => ({
            tokenId: anchorKeyOf(anchor.parcelId),
            parcelId: anchor.parcelId,
            metadataURI: anchor.metadataURI || null
        }));
    }

    async function getTotalMintedParcels(chainId, parcelContractAddress) {
        if (!globalScope.ethers) throw new Error('Ethers library not available');
        const contract = anchorContract(await getProviderForChain(chainId), parcelContractAddress);
        return Number(await contract.count());
    }

    async function getAllMintedParcelIds(chainId, parcelContractAddress, options = {}) {
        if (!globalScope.ethers) throw new Error('Ethers library not available');
        const contract = anchorContract(await getProviderForChain(chainId), parcelContractAddress);
        const total = Number(await contract.count());
        const anchors = await readAnchorPages(total, (offset, limit) => contract.anchors(offset, limit), options.onProgress);
        return anchors.map(anchor => anchor.parcelId).filter(Boolean);
    }

    // Export functions
    globalScope.ChainDataLoader = {
        PARCEL_ANCHOR_ABI,
        getParcelsFromChain,
        getTotalMintedParcels,
        getAllMintedParcelIds,
        resolveContractAddress,
        getProviderForChain
    };
})();
