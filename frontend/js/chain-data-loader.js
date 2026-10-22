// The EVM ParcelNFT reader (ChainDataLoader): the parcels a wallet holds, the minted parcel count and
// ids, and the contract address resolution and provider every EVM read shares. The parcel NFT paths
// read through it: the minted-parcels layer (parcels/ui/minted-layer.js), the agent profile's wallet
// parcels (agents.js) and the city token's address (user-management.js). There is no EVM proposal
// reader: designs are not minted, and EVM returns later on agreements (plan-design-agreement.md, M3).

(function () {
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    if (!globalScope) {
        return;
    }

    // The ParcelNFT functions the reads below call.
    const PARCEL_NFT_ABI = [
        'function getTokensByOwner(address owner) public view returns (uint256[] memory)',
        'function parcelIdForTokenId(uint256 tokenId) public view returns (string memory)',
        'function getParcelByToken(uint256 tokenId) public view returns (tuple(string parcelId, string metadataURI))',
        'function ownerOf(uint256 tokenId) public view returns (address)',
        'function balanceOf(address owner) public view returns (uint256)',
        'function totalSupply() public view returns (uint256)',
        'function tokenByIndex(uint256 index) public view returns (uint256)'
    ];

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

    /**
     * Get all parcels owned by a wallet address from chain
     * @param {string} walletAddress - The wallet address
     * @param {string|number|bigint} chainId - The chain ID
     * @param {string} parcelContractAddress - The ParcelNFT contract address
     * @returns {Promise<Array>} Array of parcel objects with { tokenId, parcelId, metadataURI }
     */
    async function getParcelsFromChain(walletAddress, chainId, parcelContractAddress) {
        if (!globalScope.ethers) {
            throw new Error('Ethers library not available');
        }

        if (!walletAddress || !chainId || !parcelContractAddress) {
            throw new Error('Missing required parameters: walletAddress, chainId, or parcelContractAddress');
        }

        const provider = await getProviderForChain(chainId);
        const { Contract, getAddress } = globalScope.ethers;
        const normalizedAddress = getAddress(parcelContractAddress);
        const contract = new Contract(normalizedAddress, PARCEL_NFT_ABI, provider);

        try {
            // Get all token IDs owned by the address
            const tokenIds = await contract.getTokensByOwner(walletAddress);

            if (!tokenIds || tokenIds.length === 0) {
                return [];
            }

            // Fetch parcel details for each token
            const parcels = await Promise.all(
                tokenIds.map(async (tokenId) => {
                    try {
                        const parcel = await contract.getParcelByToken(tokenId);
                        return {
                            tokenId: tokenId.toString(),
                            parcelId: parcel.parcelId,
                            metadataURI: parcel.metadataURI
                        };
                    } catch (error) {
                        console.warn(`Failed to fetch parcel details for token ${tokenId}:`, error);
                        // Fallback: try to get parcelId directly
                        try {
                            const parcelId = await contract.parcelIdForTokenId(tokenId);
                            return {
                                tokenId: tokenId.toString(),
                                parcelId: parcelId,
                                metadataURI: null
                            };
                        } catch (err) {
                            return {
                                tokenId: tokenId.toString(),
                                parcelId: null,
                                metadataURI: null,
                                error: err.message
                            };
                        }
                    }
                })
            );

            return parcels.filter(p => p.parcelId); // Filter out any that failed
        } catch (error) {
            console.error('Error fetching parcels from chain:', error);
            throw error;
        }
    }

    async function getTotalMintedParcels(chainId, parcelContractAddress) {
        if (!globalScope.ethers) throw new Error('Ethers library not available');
        const provider = await getProviderForChain(chainId);
        const { Contract, getAddress } = globalScope.ethers;
        const contract = new Contract(getAddress(parcelContractAddress), PARCEL_NFT_ABI, provider);
        const total = await contract.totalSupply();
        return Number(total);
    }

    async function getAllMintedParcelIds(chainId, parcelContractAddress, options = {}) {
        if (!globalScope.ethers) throw new Error('Ethers library not available');
        const provider = await getProviderForChain(chainId);
        const { Contract, getAddress } = globalScope.ethers;
        const contract = new Contract(getAddress(parcelContractAddress), PARCEL_NFT_ABI, provider);
        const total = Number(await contract.totalSupply());
        if (total === 0) return [];

        const batchSize = options.batchSize || 20;
        const parcelIds = [];
        for (let i = 0; i < total; i += batchSize) {
            const end = Math.min(i + batchSize, total);
            const batch = [];
            for (let j = i; j < end; j++) {
                batch.push(
                    contract.tokenByIndex(j)
                        .then(tokenId => contract.parcelIdForTokenId(tokenId))
                        .catch(() => null)
                );
            }
            const results = await Promise.all(batch);
            results.forEach(id => { if (id) parcelIds.push(id); });
            if (typeof options.onProgress === 'function') {
                options.onProgress(Math.min(end, total), total);
            }
        }
        return parcelIds;
    }

    // Export functions
    globalScope.ChainDataLoader = {
        getParcelsFromChain,
        getTotalMintedParcels,
        getAllMintedParcelIds,
        resolveContractAddress,
        getProviderForChain
    };
})();
