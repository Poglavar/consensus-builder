/**
 * Blockchain Sync Module
 * Handles periodic syncing of minted proposals from blockchain contracts
 * Uses a hybrid approach: event listeners + periodic polling + manual refresh
 */

(function (global) {
    'use strict';

    // Configuration
    const BLOCKCHAIN_SYNC_INTERVAL = 15 * 60 * 1000; // 15 minutes (fallback polling)
    const LAST_SYNC_KEY = 'blockchain_last_sync';
    const SYNC_STATE_KEY = 'blockchain_sync_state';

    // State
    let syncTimer = null;
    let eventListeners = new Map(); // chainId-contract -> listener cleanup function
    let isSyncing = false;
    let lastSyncError = null;

    // Proposal NFT ABI (minimal for sync operations)
    const PROPOSAL_NFT_ABI = [
        'function totalSupply() public view returns (uint256)',
        'function tokenByIndex(uint256 index) public view returns (uint256)',
        'function getProposal(uint256 proposalId) public view returns (string[] memory parcelIds, bool isConditional, string memory imageURI, bool acceptancePossible, uint8 status, uint256 ethBalance, uint256 tokenBalance, uint256 acceptanceCount, uint256 expiryTimestamp, uint256 expiringPercentage)',
        'function getProposalsBatch(uint256[] memory proposalIds) public view returns (string[][] memory parcelIdsArray, bool[] memory isConditionalArray, string[] memory imageURIArray, bool[] memory acceptancePossibleArray, uint8[] memory statusArray, uint256[] memory ethBalanceArray, uint256[] memory tokenBalanceArray, uint256[] memory acceptanceCountArray, uint256[] memory expiryTimestampArray, uint256[] memory expiringPercentageArray)',
        'function ownerOf(uint256 tokenId) public view returns (address)',
        'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
        'event ProposalCreated(uint256 indexed proposalId, address indexed creator)',
        'event ProposalStatusChanged(uint256 indexed proposalId, uint8 newStatus)'
    ];

    /**
     * Get last synced token ID for a chain/contract
     */
    function getLastSyncedTokenId(chainId, contractAddress) {
        try {
            const data = JSON.parse(localStorage.getItem(LAST_SYNC_KEY) || '{}');
            const key = `${chainId}-${contractAddress.toLowerCase()}`;
            return data[key] || 0;
        } catch (error) {
            console.warn('Failed to read last sync position', error);
            return 0;
        }
    }

    /**
     * Set last synced token ID for a chain/contract
     */
    function setLastSyncedTokenId(chainId, contractAddress, tokenId) {
        try {
            const data = JSON.parse(localStorage.getItem(LAST_SYNC_KEY) || '{}');
            const key = `${chainId}-${contractAddress.toLowerCase()}`;
            data[key] = tokenId;
            localStorage.setItem(LAST_SYNC_KEY, JSON.stringify(data));
        } catch (error) {
            console.warn('Failed to save last sync position', error);
        }
    }

    /**
     * Get sync state (last sync time, counts, etc.)
     */
    function getSyncState() {
        try {
            const data = localStorage.getItem(SYNC_STATE_KEY);
            return data ? JSON.parse(data) : {};
        } catch (error) {
            return {};
        }
    }

    /**
     * Update sync state
     */
    function updateSyncState(updates) {
        try {
            const state = getSyncState();
            Object.assign(state, updates);
            localStorage.setItem(SYNC_STATE_KEY, JSON.stringify(state));
        } catch (error) {
            console.warn('Failed to update sync state', error);
        }
    }

    /**
     * Normalize chain ID to string
     */
    function normalizeChainId(chainId) {
        if (typeof chainId === 'bigint') {
            return chainId.toString();
        }
        if (chainId && typeof chainId.toString === 'function') {
            return chainId.toString();
        }
        return String(chainId);
    }

    /**
     * Build chain proposal ID
     */
    function buildChainProposalId(chainId, contractAddress, tokenId) {
        const chain = normalizeChainId(chainId);
        const address = contractAddress.toLowerCase();
        const token = tokenId.toString();
        return `${chain}-${address}-${token}`;
    }

    /**
     * Find local proposal by parent parcel IDs
     */
    function findLocalProposalByParcels(parcelIds) {
        if (!parcelIds || !Array.isArray(parcelIds) || parcelIds.length === 0) {
            return null;
        }

        if (typeof global.proposalStorage === 'undefined' ||
            typeof global.proposalStorage.getAllProposals !== 'function') {
            return null;
        }

        const allProposals = global.proposalStorage.getAllProposals();
        const normalizedSearchIds = parcelIds.map(id =>
            typeof global.normalizeParcelId === 'function'
                ? global.normalizeParcelId(id)
                : id.toString()
        );

        return allProposals.find(proposal => {
            const proposalParcelIds = Array.isArray(proposal.parentParcelIds)
                ? proposal.parentParcelIds
                : [];

            if (proposalParcelIds.length !== normalizedSearchIds.length) {
                return false;
            }

            const normalizedProposalIds = proposalParcelIds.map(id =>
                typeof global.normalizeParcelId === 'function'
                    ? global.normalizeParcelId(id)
                    : id.toString()
            );

            return normalizedSearchIds.every(id => normalizedProposalIds.includes(id));
        });
    }

    /**
     * Parse contract status to string
     */
    function parseContractStatus(statusCode) {
        const statusMap = {
            0: 'Pending',
            1: 'Active',
            2: 'Accepted',
            3: 'Executed',
            4: 'Rejected',
            5: 'Expired',
            6: 'Cancelled'
        };
        return statusMap[statusCode] || 'Unknown';
    }

    /**
     * Create proposal from chain data
     */
    function createProposalFromChainData({ chainId, contractAddress, tokenId, onchainData, owner }) {
        const [parcelIds, isConditional, imageURI, acceptancePossible, status,
               ethBalance, tokenBalance, acceptanceCount, expiryTimestamp, expiringPercentage] = onchainData;

        const proposalId = buildChainProposalId(chainId, contractAddress, tokenId);
        const statusStr = parseContractStatus(status);

        return {
            proposalId,
            parentParcelIds: Array.isArray(parcelIds) ? parcelIds : [],
            childParcelIds: [],
            name: `Proposal #${tokenId}`,
            description: `Minted proposal from blockchain`,
            author: owner || 'Unknown',
            type: 'Purchase',
            proposalMainType: 'Purchase',
            status: statusStr,
            acquisitionStrategy: isConditional ? 'conditional' : 'partial',
            isMinted: true,
            nft: {
                chain: normalizeChainId(chainId),
                contract: contractAddress.toLowerCase(),
                tokenId: tokenId.toString()
            },
            onchain: {
                chainId: normalizeChainId(chainId),
                contractAddress: contractAddress.toLowerCase(),
                proposalId: tokenId.toString(),
                acceptanceCount: acceptanceCount.toString(),
                ethBalance: ethBalance.toString(),
                tokenBalance: tokenBalance.toString(),
                expiryTimestamp: expiryTimestamp.toString(),
                expiringPercentage: expiringPercentage.toString(),
                imageURI: imageURI || null
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
    }

    /**
     * Update existing proposal with chain data
     */
    function updateProposalWithChainData(proposal, { chainId, contractAddress, tokenId, onchainData, owner }) {
        const [parcelIds, isConditional, imageURI, acceptancePossible, status,
               ethBalance, tokenBalance, acceptanceCount, expiryTimestamp, expiringPercentage] = onchainData;

        const statusStr = parseContractStatus(status);

        // Update minting status
        proposal.isMinted = true;

        // Update NFT info
        proposal.nft = {
            chain: normalizeChainId(chainId),
            contract: contractAddress.toLowerCase(),
            tokenId: tokenId.toString()
        };

        // Update onchain data
        proposal.onchain = {
            chainId: normalizeChainId(chainId),
            contractAddress: contractAddress.toLowerCase(),
            proposalId: tokenId.toString(),
            acceptanceCount: acceptanceCount.toString(),
            ethBalance: ethBalance.toString(),
            tokenBalance: tokenBalance.toString(),
            expiryTimestamp: expiryTimestamp.toString(),
            expiringPercentage: expiringPercentage.toString(),
            imageURI: imageURI || proposal.imageUrl || null
        };

        // Update status if changed
        if (statusStr !== 'Unknown' && proposal.status !== statusStr) {
            proposal.status = statusStr;
        }

        // Update acquisition strategy
        if (proposal.acquisitionStrategy !== (isConditional ? 'conditional' : 'partial')) {
            proposal.acquisitionStrategy = isConditional ? 'conditional' : 'partial';
        }

        // Update owner if provided
        if (owner && !proposal.author) {
            proposal.author = owner;
        }

        proposal.updatedAt = new Date().toISOString();

        return proposal;
    }

    /**
     * Check if wallet is connected
     */
    function isWalletConnected() {
        if (!global.walletManager) {
            return false;
        }

        // Check if wallet manager has a connected state
        if (typeof global.walletManager.isConnected === 'function') {
            return global.walletManager.isConnected();
        }

        // Check for provider
        if (typeof global.walletManager.getProvider === 'function') {
            const provider = global.walletManager.getProvider();
            return !!provider;
        }

        // Check for account
        if (typeof global.walletManager.getAccount === 'function') {
            const account = global.walletManager.getAccount();
            return !!account;
        }

        return false;
    }

    /**
     * Get wallet provider for blockchain operations
     */
    async function getWalletProvider() {
        if (!global.ethers) {
            throw new Error('Ethers library not available');
        }

        if (!global.walletManager || typeof global.walletManager.getProvider !== 'function') {
            throw new Error('Wallet manager not available');
        }

        const provider = global.walletManager.getProvider();
        if (!provider) {
            throw new Error('Wallet not connected');
        }

        try {
            return new global.ethers.BrowserProvider(provider);
        } catch (error) {
            throw new Error('Failed to create browser provider: ' + error.message);
        }
    }

    /**
     * Sync a single proposal from blockchain
     */
    async function syncSingleProposal(chainId, contractAddress, tokenId) {
        try {
            // Check wallet connection first
            if (!isWalletConnected()) {
                throw new Error('Wallet not connected - cannot sync blockchain data');
            }

            if (!global.ethers) {
                throw new Error('Ethers library not available');
            }

            // Get wallet provider
            const provider = await getWalletProvider();
            if (!provider) {
                throw new Error(`No provider available`);
            }

            // Create contract instance
            const contract = new global.ethers.Contract(
                contractAddress,
                PROPOSAL_NFT_ABI,
                provider
            );

            // Fetch proposal data
            const onchainData = await contract.getProposal(tokenId);
            let owner = null;

            try {
                owner = await contract.ownerOf(tokenId);
            } catch (error) {
                console.warn(`Failed to get owner for token ${tokenId}`, error);
            }

            const chainProposalId = buildChainProposalId(chainId, contractAddress, tokenId);

            // Check if we have this proposal locally
            let localProposal = null;
            if (global.proposalStorage && typeof global.proposalStorage.getProposal === 'function') {
                localProposal = global.proposalStorage.getProposal(chainProposalId);
            }

            // If not found by chain ID, try to find by parent parcel IDs
            if (!localProposal && onchainData && onchainData[0]) {
                localProposal = findLocalProposalByParcels(onchainData[0]);
            }

            if (localProposal) {
                // Update existing proposal
                updateProposalWithChainData(localProposal, {
                    chainId,
                    contractAddress,
                    tokenId,
                    onchainData,
                    owner
                });

                // Save updated proposal
                if (global.proposalStorage && typeof global.proposalStorage.save === 'function') {
                    global.proposalStorage.save();
                }

                console.log(`Updated proposal ${chainProposalId} from blockchain`);
            } else {
                // Create new proposal from blockchain data
                const newProposal = createProposalFromChainData({
                    chainId,
                    contractAddress,
                    tokenId,
                    onchainData,
                    owner
                });

                // Add to storage
                if (global.proposalStorage && typeof global.proposalStorage.addProposal === 'function') {
                    global.proposalStorage.addProposal(newProposal);
                    console.log(`Created new proposal ${chainProposalId} from blockchain`);
                }
            }

            return true;
        } catch (error) {
            console.error(`Failed to sync proposal ${tokenId} from chain ${chainId}`, error);
            return false;
        }
    }

    /**
     * Sync all proposals from a specific chain/contract
     */
    async function syncContract(chainId, contractAddress, options = {}) {
        const { incrementalOnly = true, batchSize = 10 } = options;

        try {
            // Check wallet connection first
            if (!isWalletConnected()) {
                throw new Error('Wallet not connected - cannot sync blockchain data');
            }

            if (!global.ethers) {
                throw new Error('Ethers library not available');
            }

            // Get wallet provider
            const provider = await getWalletProvider();
            if (!provider) {
                throw new Error(`No provider available`);
            }

            // Create contract instance
            const contract = new global.ethers.Contract(
                contractAddress,
                PROPOSAL_NFT_ABI,
                provider
            );

            // Get total supply
            const totalSupply = await contract.totalSupply();
            const totalNum = Number(totalSupply);

            if (totalNum === 0) {
                console.log(`No proposals on chain ${chainId} contract ${contractAddress}`);
                return { synced: 0, total: 0 };
            }

            // Get starting position for incremental sync
            const startIndex = incrementalOnly
                ? getLastSyncedTokenId(chainId, contractAddress)
                : 0;

            if (startIndex >= totalNum) {
                console.log(`Already synced all ${totalNum} proposals from chain ${chainId}`);
                return { synced: 0, total: totalNum };
            }

            const toSync = totalNum - startIndex;
            console.log(`Syncing ${toSync} proposals from chain ${chainId} (${startIndex} to ${totalNum})`);

            let syncedCount = 0;
            let failedCount = 0;

            // Sync in batches
            for (let i = startIndex; i < totalNum; i += batchSize) {
                const batchEnd = Math.min(i + batchSize, totalNum);
                const batchIndices = Array.from({ length: batchEnd - i }, (_, idx) => i + idx);

                try {
                    // Get token IDs for this batch
                    const tokenIds = await Promise.all(
                        batchIndices.map(idx => contract.tokenByIndex(idx))
                    );

                    // Try batch fetch if available
                    if (typeof contract.getProposalsBatch === 'function' && tokenIds.length > 1) {
                        try {
                            const batchData = await contract.getProposalsBatch(tokenIds);

                            // Process batch results
                            for (let j = 0; j < tokenIds.length; j++) {
                                const tokenId = tokenIds[j];
                                const onchainData = [
                                    batchData[0][j], // parcelIds
                                    batchData[1][j], // isConditional
                                    batchData[2][j], // imageURI
                                    batchData[3][j], // acceptancePossible
                                    batchData[4][j], // status
                                    batchData[5][j], // ethBalance
                                    batchData[6][j], // tokenBalance
                                    batchData[7][j], // acceptanceCount
                                    batchData[8][j], // expiryTimestamp
                                    batchData[9][j]  // expiringPercentage
                                ];

                                const success = await syncSingleProposal(chainId, contractAddress, tokenId);
                                if (success) {
                                    syncedCount++;
                                } else {
                                    failedCount++;
                                }
                            }
                        } catch (batchError) {
                            console.warn('Batch fetch failed, falling back to individual fetches', batchError);

                            // Fallback to individual fetches
                            for (const tokenId of tokenIds) {
                                const success = await syncSingleProposal(chainId, contractAddress, tokenId);
                                if (success) {
                                    syncedCount++;
                                } else {
                                    failedCount++;
                                }
                            }
                        }
                    } else {
                        // Individual fetches
                        for (const tokenId of tokenIds) {
                            const success = await syncSingleProposal(chainId, contractAddress, tokenId);
                            if (success) {
                                syncedCount++;
                            } else {
                                failedCount++;
                            }
                        }
                    }

                    // Update progress
                    setLastSyncedTokenId(chainId, contractAddress, batchEnd);

                    // Update status if available
                    if (typeof global.updateStatus === 'function') {
                        global.updateStatus(`Synced ${syncedCount}/${toSync} proposals from blockchain...`);
                    }

                } catch (batchError) {
                    console.error(`Failed to sync batch ${i}-${batchEnd}`, batchError);
                    failedCount += (batchEnd - i);
                }
            }

            console.log(`Sync complete: ${syncedCount} synced, ${failedCount} failed`);

            return { synced: syncedCount, failed: failedCount, total: totalNum };

        } catch (error) {
            console.error(`Failed to sync contract ${contractAddress} on chain ${chainId}`, error);
            throw error;
        }
    }

    /**
     * Sync all configured proposal contracts
     */
    async function syncBlockchainProposals(options = {}) {
        if (isSyncing) {
            console.log('Sync already in progress');
            return;
        }

        // Check wallet connection first
        if (!isWalletConnected()) {
            const message = 'Wallet not connected - skipping blockchain sync';
            console.log(message);
            if (typeof global.updateStatus === 'function') {
                global.updateStatus(message);
            }
            return { totalSynced: 0, contracts: [], skipped: true, reason: 'no_wallet' };
        }

        isSyncing = true;
        lastSyncError = null;

        try {
            // Update status
            if (typeof global.updateStatus === 'function') {
                global.updateStatus('Syncing proposals from blockchain...');
            }

            // Get city config
            const cityConfig = typeof global.getCityConfig === 'function'
                ? global.getCityConfig()
                : null;

            // Per-city contracts if configured, else the global Base Sepolia fallback (so sync works
            // everywhere). Wallet-gated by the isWalletConnected() check upstream.
            const contracts = (global.ProposalContracts && typeof global.ProposalContracts.resolveProposalContracts === 'function')
                ? global.ProposalContracts.resolveProposalContracts(cityConfig)
                : (cityConfig && cityConfig.blockchain && cityConfig.blockchain.proposalContracts) || [];
            if (!contracts.length) {
                console.log('No blockchain proposal contracts resolved for current city');
                return { totalSynced: 0, contracts: [] };
            }

            const results = [];

            for (const { chainId, contractAddress } of contracts) {
                try {
                    const result = await syncContract(chainId, contractAddress, options);
                    results.push({
                        chainId,
                        contractAddress,
                        ...result
                    });
                } catch (error) {
                    console.error(`Failed to sync contract ${contractAddress} on chain ${chainId}`, error);
                    results.push({
                        chainId,
                        contractAddress,
                        error: error.message
                    });
                }
            }

            const totalSynced = results.reduce((sum, r) => sum + (r.synced || 0), 0);

            // Update sync state
            updateSyncState({
                lastSyncTime: Date.now(),
                lastSyncResults: results,
                totalProposalsSynced: totalSynced
            });

            // Refresh UI
            if (typeof global.refreshProposalsLayer === 'function') {
                global.refreshProposalsLayer();
            }
            if (typeof global.updateShowProposalsButton === 'function') {
                global.updateShowProposalsButton();
            }

            // Update status
            if (typeof global.updateStatus === 'function') {
                if (totalSynced > 0) {
                    global.updateStatus(`Synced ${totalSynced} proposal${totalSynced !== 1 ? 's' : ''} from blockchain`);
                } else {
                    global.updateStatus('No new proposals found on blockchain');
                }
            }

            return { totalSynced, contracts: results };

        } catch (error) {
            console.error('Blockchain sync failed', error);
            lastSyncError = error.message;

            if (typeof global.updateStatus === 'function') {
                global.updateStatus(`Blockchain sync failed: ${error.message}`);
            }

            throw error;
        } finally {
            isSyncing = false;
        }
    }

    /**
     * Setup event listeners for a contract
     */
    async function setupContractEventListeners(chainId, contractAddress) {
        try {
            // Check wallet connection first
            if (!isWalletConnected()) {
                console.log('Wallet not connected - skipping event listener setup');
                return;
            }

            if (!global.ethers) {
                throw new Error('Ethers library not available');
            }

            const key = `${chainId}-${contractAddress.toLowerCase()}`;

            // Clean up existing listener
            if (eventListeners.has(key)) {
                const cleanup = eventListeners.get(key);
                if (typeof cleanup === 'function') {
                    cleanup();
                }
            }

            // Get wallet provider
            const provider = await getWalletProvider();
            if (!provider) {
                console.warn(`No provider available, skipping event listeners`);
                return;
            }

            // Create contract instance
            const contract = new global.ethers.Contract(
                contractAddress,
                PROPOSAL_NFT_ABI,
                provider
            );

            // Listen for new mints (Transfer from 0x0)
            const onTransfer = async (from, to, tokenId, event) => {
                if (from === global.ethers.ZeroAddress || from === '0x0000000000000000000000000000000000000000') {
                    console.log(`New proposal minted: token ${tokenId} on chain ${chainId}`);
                    await syncSingleProposal(chainId, contractAddress, tokenId);

                    // Refresh UI
                    if (typeof global.refreshProposalsLayer === 'function') {
                        global.refreshProposalsLayer();
                    }
                }
            };

            contract.on('Transfer', onTransfer);

            // Cleanup function
            const cleanup = () => {
                contract.off('Transfer', onTransfer);
            };

            eventListeners.set(key, cleanup);
            console.log(`Event listeners setup for contract ${contractAddress} on chain ${chainId}`);

        } catch (error) {
            console.error(`Failed to setup event listeners for ${contractAddress} on chain ${chainId}`, error);
        }
    }

    /**
     * Start event listeners for all configured contracts
     */
    async function startEventListeners() {
        try {
            const cityConfig = typeof global.getCityConfig === 'function'
                ? global.getCityConfig()
                : null;

            const contracts = (global.ProposalContracts && typeof global.ProposalContracts.resolveProposalContracts === 'function')
                ? global.ProposalContracts.resolveProposalContracts(cityConfig)
                : (cityConfig && cityConfig.blockchain && cityConfig.blockchain.proposalContracts) || [];
            if (!contracts.length) {
                return;
            }

            for (const { chainId, contractAddress } of contracts) {
                await setupContractEventListeners(chainId, contractAddress);
            }

        } catch (error) {
            console.error('Failed to start event listeners', error);
        }
    }

    /**
     * Stop all event listeners
     */
    function stopEventListeners() {
        for (const [key, cleanup] of eventListeners.entries()) {
            if (typeof cleanup === 'function') {
                try {
                    cleanup();
                } catch (error) {
                    console.warn(`Failed to cleanup listener for ${key}`, error);
                }
            }
        }
        eventListeners.clear();
    }

    /**
     * Start periodic sync
     */
    function startPeriodicSync() {
        if (syncTimer) {
            return;
        }

        // Only do initial sync if wallet is connected
        if (isWalletConnected()) {
            syncBlockchainProposals({ incrementalOnly: true }).catch(error => {
                console.error('Initial blockchain sync failed', error);
            });
        } else {
            console.log('Wallet not connected - skipping initial blockchain sync');
        }

        // Periodic sync (fallback) - will check wallet connection each time
        syncTimer = setInterval(() => {
            if (isWalletConnected()) {
                syncBlockchainProposals({ incrementalOnly: true }).catch(error => {
                    console.error('Periodic blockchain sync failed', error);
                });
            } else {
                console.log('Wallet not connected - skipping periodic blockchain sync');
            }
        }, BLOCKCHAIN_SYNC_INTERVAL);

        console.log('Blockchain periodic sync timer started');
    }

    /**
     * Stop periodic sync
     */
    function stopPeriodicSync() {
        if (syncTimer) {
            clearInterval(syncTimer);
            syncTimer = null;
            console.log('Blockchain periodic sync stopped');
        }
    }

    /**
     * Initialize blockchain sync
     */
    function initBlockchainSync() {
        // Start event listeners
        startEventListeners().catch(error => {
            console.warn('Failed to start event listeners', error);
        });

        // Start periodic sync
        startPeriodicSync();

        // Sync when wallet connects/changes
        if (global.walletManager) {
            const wm = global.walletManager;

            if (typeof wm.on === 'function') {
                wm.on('accountsChanged', () => {
                    console.log('Wallet account changed, syncing blockchain proposals');
                    syncBlockchainProposals({ incrementalOnly: true }).catch(console.error);
                });

                wm.on('chainChanged', () => {
                    console.log('Wallet chain changed, restarting sync');
                    stopEventListeners();
                    startEventListeners().catch(console.error);
                    syncBlockchainProposals({ incrementalOnly: true }).catch(console.error);
                });
            }
        }

        console.log('Blockchain sync initialized');
    }

    /**
     * Shutdown blockchain sync
     */
    function shutdownBlockchainSync() {
        stopPeriodicSync();
        stopEventListeners();
        console.log('Blockchain sync shutdown');
    }

    /**
     * Get sync status
     */
    function getSyncStatus() {
        const state = getSyncState();
        return {
            isSyncing,
            lastSyncTime: state.lastSyncTime || null,
            lastSyncResults: state.lastSyncResults || [],
            lastSyncError,
            hasEventListeners: eventListeners.size > 0,
            hasPeriodicSync: !!syncTimer
        };
    }

    // Export functions
    global.BlockchainSync = {
        init: initBlockchainSync,
        shutdown: shutdownBlockchainSync,
        sync: syncBlockchainProposals,
        syncSingle: syncSingleProposal,
        startEventListeners,
        stopEventListeners,
        startPeriodicSync,
        stopPeriodicSync,
        getStatus: getSyncStatus,
        getSyncState
    };

    // Backward compatibility
    global.syncBlockchainProposals = syncBlockchainProposals;
    global.initBlockchainSync = initBlockchainSync;

})(typeof window !== 'undefined' ? window : globalThis);
