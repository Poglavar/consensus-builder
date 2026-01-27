/**
 * Chain Data Loader
 * Functions to fetch parcels and proposals from blockchain contracts
 */

(function () {
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    if (!globalScope) {
        return;
    }

    // Contract ABIs for fetching data
    const PARCEL_NFT_ABI = [
        'function getTokensByOwner(address owner) public view returns (uint256[] memory)',
        'function parcelIdForTokenId(uint256 tokenId) public view returns (string memory)',
        'function getParcelByToken(uint256 tokenId) public view returns (tuple(string parcelId, string metadataURI))',
        'function ownerOf(uint256 tokenId) public view returns (address)',
        'function balanceOf(address owner) public view returns (uint256)'
    ];

    const PROPOSAL_NFT_ABI = [
        'function totalSupply() public view returns (uint256)',
        'function tokenByIndex(uint256 index) public view returns (uint256)',
        'function getTokensByOwner(address owner) public view returns (uint256[] memory)',
        'function getProposal(uint256 proposalId) public view returns (string[] memory parcelIds, bool isConditional, string memory imageURI, bool acceptancePossible, uint8 status, uint256 ethBalance, uint256 tokenBalance, uint256 acceptanceCount, uint256 expiryTimestamp, uint256 expiringPercentage)',
        'function getProposalsForParcel(string memory parcelId) public view returns (uint256[] memory)',
        'function getProposalsForParcelWithStatus(string memory parcelId) public view returns (uint256[] memory proposalIds, bool[] memory acceptanceStatus)',
        'function getProposalsBatch(uint256[] memory proposalIds) public view returns (string[][] memory parcelIdsArray, bool[] memory isConditionalArray, string[] memory imageURIArray, bool[] memory acceptancePossibleArray, uint8[] memory statusArray, uint256[] memory ethBalanceArray, uint256[] memory tokenBalanceArray, uint256[] memory acceptanceCountArray, uint256[] memory expiryTimestampArray, uint256[] memory expiringPercentageArray)',
        'function hasAccepted(uint256 proposalId, string memory parcelId) public view returns (bool)',
        'function getLens(uint256 proposalId) public view returns (address[] memory)',
        'function ownerOf(uint256 tokenId) public view returns (address)'
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

        // Simple fallback map
        const rpcMap = {
            '31337': 'http://localhost:8545',
            '11155111': 'https://rpc.sepolia.org',
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

    /**
     * Get all proposals created by a wallet address from chain
     * @param {string} walletAddress - The wallet address
     * @param {string|number|bigint} chainId - The chain ID
     * @param {string} proposalContractAddress - The ProposalNFT contract address
     * @returns {Promise<Array>} Array of proposal objects
     */
    async function getProposalsFromChain(walletAddress, chainId, proposalContractAddress, opts = {}) {
        if (!globalScope.ethers) {
            throw new Error('Ethers library not available');
        }

        if (!walletAddress || !chainId || !proposalContractAddress) {
            throw new Error('Missing required parameters: walletAddress, chainId, or proposalContractAddress');
        }

        const provider = await getProviderForChain(chainId);
        const { Contract, getAddress } = globalScope.ethers;
        const normalizedAddress = getAddress(proposalContractAddress);
        const contract = new Contract(normalizedAddress, PROPOSAL_NFT_ABI, provider);

        try {
            const tokenIds = Array.isArray(opts.tokenIds) && opts.tokenIds.length > 0
                ? opts.tokenIds
                : await contract.getTokensByOwner(walletAddress);

            if (!tokenIds || tokenIds.length === 0) {
                return [];
            }

            const statusNames = ['Active', 'Executed', 'Cancelled', 'Expired'];
            let proposals;

            try {
                const tokenIdsBigInt = tokenIds.map(id => BigInt(id));
                const batchResult = await contract.getProposalsBatch(tokenIdsBigInt);
                const [
                    parcelIdsArray,
                    isConditionalArray,
                    imageURIArray,
                    acceptancePossibleArray,
                    statusArray,
                    ethBalanceArray,
                    tokenBalanceArray,
                    acceptanceCountArray,
                    expiryTimestampArray,
                    expiringPercentageArray
                ] = batchResult;

                const lensArrays = await Promise.all(tokenIds.map(async (tokenId) => {
                    try {
                        const lensResult = await contract.getLens(tokenId);
                        return Array.isArray(lensResult) ? lensResult.map(addr => addr.toString()) : [];
                    } catch (err) {
                        console.warn('Failed to fetch lens for proposal', tokenId.toString(), err);
                        return [];
                    }
                }));

                proposals = await Promise.all(tokenIds.map(async (tokenId, index) => {
                    let owner = null;
                    try {
                        owner = await contract.ownerOf(tokenId);
                    } catch (_) { /* ignore */ }
                    return {
                        proposalId: tokenId.toString(),
                        parentParcelIds: parcelIdsArray[index],
                        isConditional: isConditionalArray[index],
                        imageURI: imageURIArray[index],
                        acceptancePossible: acceptancePossibleArray[index],
                        status: statusNames[Number(statusArray[index])] || 'Unknown',
                        statusCode: Number(statusArray[index]),
                        ethBalance: ethBalanceArray[index].toString(),
                        tokenBalance: tokenBalanceArray[index].toString(),
                        acceptanceCount: acceptanceCountArray[index].toString(),
                        expiryTimestamp: expiryTimestampArray[index].toString(),
                        expiringPercentage: expiringPercentageArray[index].toString(),
                        owner,
                        lens: lensArrays[index] || []
                    };
                }));
            } catch (batchError) {
                console.warn('Batch function not available, using individual calls:', batchError);
                proposals = await Promise.all(
                    tokenIds.map(async (tokenId) => {
                        try {
                            const proposal = await contract.getProposal(tokenId);
                            const [
                                parcelIds,
                                isConditional,
                                imageURI,
                                acceptancePossible,
                                status,
                                ethBalance,
                                tokenBalance,
                                acceptanceCount,
                                expiryTimestamp,
                                expiringPercentage
                            ] = proposal;

                            let lens = [];
                            try {
                                const lensResult = await contract.getLens(tokenId);
                                lens = Array.isArray(lensResult) ? lensResult.map(addr => addr.toString()) : [];
                            } catch (err) {
                                console.warn('Failed to fetch lens for proposal', tokenId.toString(), err);
                            }

                            let owner = null;
                            try {
                                owner = await contract.ownerOf(tokenId);
                            } catch (_) { /* ignore */ }

                            return {
                                proposalId: tokenId.toString(),
                                parentParcelIds: parcelIds,
                                isConditional,
                                imageURI,
                                acceptancePossible,
                                status: statusNames[Number(status)] || 'Unknown',
                                statusCode: Number(status),
                                ethBalance: ethBalance.toString(),
                                tokenBalance: tokenBalance.toString(),
                                acceptanceCount: acceptanceCount.toString(),
                                expiryTimestamp: expiryTimestamp.toString(),
                                expiringPercentage: expiringPercentage.toString(),
                                owner,
                                lens
                            };
                        } catch (err) {
                            console.warn('Failed to fetch proposal', tokenId.toString(), err);
                            return null;
                        }
                    })
                );
                proposals = proposals.filter(p => p !== null);
            }

            return proposals.filter(p => !p.error);
        } catch (error) {
            console.error('Error fetching proposals from chain:', error);
            throw error;
        }
    }

    /**
     * Get all proposal token IDs on chain (one call per proposal via tokenByIndex).
     * Returns an array of string IDs.
     */
    async function getAllProposalIds(chainId, proposalContractAddress) {
        const provider = await getProviderForChain(chainId);
        const { Contract, getAddress } = globalScope.ethers;
        const normalizedAddress = getAddress(proposalContractAddress);
        const contract = new Contract(normalizedAddress, PROPOSAL_NFT_ABI, provider);

        const total = await contract.totalSupply();
        const totalNum = Number(total);
        if (!Number.isFinite(totalNum) || totalNum <= 0) {
            return [];
        }

        const ids = await Promise.all(
            Array.from({ length: totalNum }).map((_, idx) => contract.tokenByIndex(idx))
        );
        return ids.map(id => id.toString());
    }

    async function getProposalTokenIdsForOwner(walletAddress, chainId, proposalContractAddress) {
        if (!globalScope.ethers) {
            throw new Error('Ethers library not available');
        }
        if (!walletAddress || !chainId || !proposalContractAddress) {
            throw new Error('Missing required parameters');
        }
        const provider = await getProviderForChain(chainId);
        const { Contract, getAddress } = globalScope.ethers;
        const normalizedAddress = getAddress(proposalContractAddress);
        const contract = new Contract(normalizedAddress, PROPOSAL_NFT_ABI, provider);
        const tokenIds = await contract.getTokensByOwner(walletAddress);
        return Array.isArray(tokenIds) ? tokenIds.map(id => id.toString()) : [];
    }

    /**
     * Fetch proposals in batches by IDs and return simplified objects.
     */
    async function getProposalsByIds(chainId, proposalContractAddress, proposalIds) {
        if (!proposalIds || !proposalIds.length) return [];

        const provider = await getProviderForChain(chainId);
        const { Contract, getAddress } = globalScope.ethers;
        const normalizedAddress = getAddress(proposalContractAddress);
        const contract = new Contract(normalizedAddress, PROPOSAL_NFT_ABI, provider);

        const statusNames = ['Active', 'Executed', 'Cancelled', 'Expired'];
        const results = [];
        const BATCH_SIZE = 40;

        for (let i = 0; i < proposalIds.length; i += BATCH_SIZE) {
            const slice = proposalIds.slice(i, i + BATCH_SIZE);
            const idsBigInt = slice.map(id => BigInt(id));
            const batch = await contract.getProposalsBatch(idsBigInt);
            const [
                parcelIdsArray,
                isConditionalArray,
                imageURIArray,
                acceptancePossibleArray,
                statusArray,
                ethBalanceArray,
                tokenBalanceArray,
                acceptanceCountArray,
                expiryTimestampArray,
                expiringPercentageArray
            ] = batch;

            const lensArrays = await Promise.all(slice.map(async (pid) => {
                try {
                    const lensResult = await contract.getLens(pid);
                    return Array.isArray(lensResult) ? lensResult.map(addr => addr.toString()) : [];
                } catch (err) {
                    console.warn('Failed to fetch lens for proposal', pid, err);
                    return [];
                }
            }));

            slice.forEach((pid, index) => {
                results.push({
                    proposalId: pid.toString(),
                    parentParcelIds: parcelIdsArray[index],
                    isConditional: isConditionalArray[index],
                    imageURI: imageURIArray[index],
                    acceptancePossible: acceptancePossibleArray[index],
                    status: statusNames[Number(statusArray[index])] || 'Unknown',
                    statusCode: Number(statusArray[index]),
                    ethBalance: ethBalanceArray[index].toString(),
                    tokenBalance: tokenBalanceArray[index].toString(),
                    acceptanceCount: acceptanceCountArray[index].toString(),
                    expiryTimestamp: expiryTimestampArray[index].toString(),
                    expiringPercentage: expiringPercentageArray[index].toString(),
                    lens: lensArrays[index] || []
                });
            });
        }

        return results;
    }

    /**
     * Find proposals that include any of the supplied parcelIds (proposal-centric).
     * Returns { pending: [], accepted: [] } arrays of proposal IDs.
     */
    async function getProposalsAffectingParcels(chainId, proposalContractAddress, parcelIds) {
        if (!parcelIds || parcelIds.length === 0) {
            return { pending: [], accepted: [], acceptanceByProposal: {} };
        }

        const ownedSet = new Set(parcelIds.filter(Boolean));
        if (ownedSet.size === 0) {
            return { pending: [], accepted: [], acceptanceByProposal: {} };
        }

        const provider = await getProviderForChain(chainId);
        const { Contract, getAddress } = globalScope.ethers;
        const normalizedAddress = getAddress(proposalContractAddress);
        const contract = new Contract(normalizedAddress, PROPOSAL_NFT_ABI, provider);

        // Gather all proposals on-chain (one call per proposalId)
        const allIds = await getAllProposalIds(chainId, proposalContractAddress);
        if (!allIds.length) {
            return { pending: [], accepted: [], acceptanceByProposal: {} };
        }

        // Fetch proposal metadata in batches
        const proposals = await getProposalsByIds(chainId, proposalContractAddress, allIds);

        const pending = [];
        const accepted = [];
        const acceptanceByProposal = {};

        for (const proposal of proposals) {
            const intersection = (proposal.parentParcelIds || []).filter(pid => ownedSet.has(pid));
            if (!intersection.length) continue;

            // For any of the user's parcels, check acceptance on-chain
            const acceptanceChecks = await Promise.all(
                intersection.map(async parcelId => {
                    try {
                        return await contract.hasAccepted(BigInt(proposal.proposalId), parcelId);
                    } catch (err) {
                        console.warn('hasAccepted check failed', proposal.proposalId, parcelId, err);
                        return false;
                    }
                })
            );

            const hasAccepted = acceptanceChecks.some(Boolean);
            const acceptedParcels = intersection.filter((_, idx) => acceptanceChecks[idx]);
            acceptanceByProposal[proposal.proposalId] = {
                parentParcelIds: proposal.parentParcelIds || [],
                acceptedParcels
            };

            if (hasAccepted) {
                accepted.push(proposal.proposalId);
            } else {
                pending.push(proposal.proposalId);
            }
        }

        return { pending, accepted, acceptanceByProposal };
    }

    /**
     * Get all proposals that include a specific parcel
     * @param {string|number|bigint} chainId - The chain ID
     * @param {string} proposalContractAddress - The ProposalNFT contract address
     * @param {string} parcelId - The parcel ID
     * @returns {Promise<Array>} Array of proposal IDs
     */
    async function getProposalsByParcelFromChain(chainId, proposalContractAddress, parcelId) {
        if (!globalScope.ethers) {
            throw new Error('Ethers library not available');
        }

        if (!chainId || !proposalContractAddress || !parcelId) {
            throw new Error('Missing required parameters: chainId, proposalContractAddress, or parcelId');
        }

        const provider = await getProviderForChain(chainId);
        const { Contract, getAddress } = globalScope.ethers;
        const normalizedAddress = getAddress(proposalContractAddress);
        const contract = new Contract(normalizedAddress, PROPOSAL_NFT_ABI, provider);

        try {
            const proposalIds = await contract.getProposalsForParcel(parcelId);
            return proposalIds.map(id => id.toString());
        } catch (error) {
            console.error('Error fetching proposals for parcel:', error);
            throw error;
        }
    }

    /**
     * Check if a parcel has accepted a specific proposal
     * @param {string|number|bigint} chainId - The chain ID
     * @param {string} proposalContractAddress - The ProposalNFT contract address
     * @param {string} proposalId - The proposal ID
     * @param {string} parcelId - The parcel ID
     * @returns {Promise<boolean>} True if parcel has accepted the proposal
     */
    async function hasParcelAcceptedProposal(chainId, proposalContractAddress, proposalId, parcelId) {
        if (!globalScope.ethers) {
            throw new Error('Ethers library not available');
        }

        const provider = await getProviderForChain(chainId);
        const { Contract, getAddress } = globalScope.ethers;
        const normalizedAddress = getAddress(proposalContractAddress);
        const contract = new Contract(normalizedAddress, PROPOSAL_NFT_ABI, provider);

        try {
            return await contract.hasAccepted(proposalId, parcelId);
        } catch (error) {
            console.error('Error checking proposal acceptance:', error);
            return false;
        }
    }

    /**
     * Get all proposals for a parcel with acceptance status (optimized version using batch call)
     * @param {string|number|bigint} chainId - The chain ID
     * @param {string} proposalContractAddress - The ProposalNFT contract address
     * @param {string} parcelId - The parcel ID
     * @returns {Promise<Array>} Array of { proposalId, hasAccepted }
     */
    async function getProposalsWithAcceptanceStatus(chainId, proposalContractAddress, parcelId) {
        const provider = await getProviderForChain(chainId);
        const { Contract, getAddress } = globalScope.ethers;
        const normalizedAddress = getAddress(proposalContractAddress);
        const contract = new Contract(normalizedAddress, PROPOSAL_NFT_ABI, provider);

        try {
            // Use the optimized batch function if available
            const [proposalIds, acceptanceStatus] = await contract.getProposalsForParcelWithStatus(parcelId);

            return proposalIds.map((proposalId, index) => ({
                proposalId: proposalId.toString(),
                hasAccepted: acceptanceStatus[index]
            }));
        } catch (error) {
            // Fallback to individual calls if batch function not available
            console.warn('Batch function not available, falling back to individual calls:', error);
            const proposalIds = await getProposalsByParcelFromChain(chainId, proposalContractAddress, parcelId);

            const proposalsWithStatus = await Promise.all(
                proposalIds.map(async (proposalId) => {
                    const hasAccepted = await hasParcelAcceptedProposal(chainId, proposalContractAddress, proposalId, parcelId);
                    return {
                        proposalId,
                        hasAccepted
                    };
                })
            );

            return proposalsWithStatus;
        }
    }

    /**
     * Get multiple proposals in a single batch call (more efficient)
     * @param {string|number|bigint} chainId - The chain ID
     * @param {string} proposalContractAddress - The ProposalNFT contract address
     * @param {Array<string>} proposalIds - Array of proposal IDs to fetch
     * @returns {Promise<Array>} Array of proposal objects
     */
    async function getProposalsBatch(chainId, proposalContractAddress, proposalIds) {
        if (!globalScope.ethers) {
            throw new Error('Ethers library not available');
        }

        if (!chainId || !proposalContractAddress || !proposalIds || proposalIds.length === 0) {
            throw new Error('Missing required parameters');
        }

        const provider = await getProviderForChain(chainId);
        const { Contract, getAddress } = globalScope.ethers;
        const normalizedAddress = getAddress(proposalContractAddress);
        const contract = new Contract(normalizedAddress, PROPOSAL_NFT_ABI, provider);

        try {
            const proposalIdsBigInt = proposalIds.map(id => BigInt(id));

            const result = await contract.getProposalsBatch(proposalIdsBigInt);
            const [
                parcelIdsArray,
                isConditionalArray,
                imageURIArray,
                acceptancePossibleArray,
                statusArray,
                ethBalanceArray,
                tokenBalanceArray,
                acceptanceCountArray,
                expiryTimestampArray,
                expiringPercentageArray
            ] = result;

            const statusNames = ['Active', 'Executed', 'Cancelled', 'Expired'];
            const lensArrays = await Promise.all(proposalIds.map(async (proposalId) => {
                try {
                    const lensResult = await contract.getLens(proposalId);
                    return Array.isArray(lensResult) ? lensResult.map(addr => addr.toString()) : [];
                } catch (err) {
                    console.warn('Failed to fetch lens for proposal', proposalId, err);
                    return [];
                }
            }));

            return await Promise.all(proposalIds.map(async (proposalId, index) => {
                let owner = null;
                try {
                    owner = await contract.ownerOf(proposalId);
                } catch (_) { /* ignore errors; owner remains null */ }

                return {
                    proposalId: proposalId,
                    parentParcelIds: parcelIdsArray[index],
                    isConditional: isConditionalArray[index],
                    imageURI: imageURIArray[index],
                    acceptancePossible: acceptancePossibleArray[index],
                    status: statusNames[Number(statusArray[index])] || 'Unknown',
                    statusCode: Number(statusArray[index]),
                    ethBalance: ethBalanceArray[index].toString(),
                    tokenBalance: tokenBalanceArray[index].toString(),
                    acceptanceCount: acceptanceCountArray[index].toString(),
                    expiryTimestamp: expiryTimestampArray[index].toString(),
                    expiringPercentage: expiringPercentageArray[index].toString(),
                    owner,
                    lens: lensArrays[index] || []
                };
            }));
        } catch (error) {
            console.error('Error fetching proposals batch:', error);
            throw error;
        }
    }

    // Export functions
    globalScope.ChainDataLoader = {
        getParcelsFromChain,
        getProposalsFromChain,
        getAllProposalIds,
        getProposalsByIds,
        getProposalsAffectingParcels,
        getProposalsByParcelFromChain,
        hasParcelAcceptedProposal,
        getProposalsWithAcceptanceStatus,
        getProposalsBatch,
        getProposalTokenIdsForOwner,
        resolveContractAddress,
        getProviderForChain
    };
})();

