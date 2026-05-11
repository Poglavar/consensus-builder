/**
 * Solana Blockchain Sync
 * Syncs proposals from Solana program into local storage
 * Mirrors BlockchainSync for EVM
 */
(function (global) {
    'use strict';

    const g = typeof global !== 'undefined' ? global : (typeof window !== 'undefined' ? window : globalThis);

    function isWalletConnected() {
        const wm = g.solanaWalletManager;
        if (!wm) return false;
        const state = wm.getState && wm.getState();
        return state && state.status === 'connected' && Array.isArray(state.accounts) && state.accounts.length > 0;
    }

    function normalizeChainId() {
        return 'solana';
    }

    function buildChainProposalId(cluster, programAddress, proposalAddress) {
        return `solana-${cluster}-${(programAddress || '').toLowerCase()}-${proposalAddress}`;
    }

    function parseContractStatus(statusCode) {
        // Must match ProposalStatus enum in proposal_nft: Active=0, Executed=1, Cancelled=2, Expired=3
        const statusMap = { 0: 'Active', 1: 'Executed', 2: 'Cancelled', 3: 'Expired' };
        return statusMap[statusCode] || 'Unknown';
    }

    function findLocalProposalByParcels(parcelIds) {
        if (!Array.isArray(parcelIds) || parcelIds.length === 0) return null;
        if (!g.proposalStorage || typeof g.proposalStorage.getAllProposals !== 'function') return null;

        const normalizedSearchIds = parcelIds.map(id => String(id)).sort();
        return g.proposalStorage.getAllProposals().find(proposal => {
            const proposalParcelIds = Array.isArray(proposal?.parentParcelIds)
                ? proposal.parentParcelIds.map(id => String(id)).sort()
                : [];
            if (proposalParcelIds.length !== normalizedSearchIds.length) return false;
            return normalizedSearchIds.every((id, index) => proposalParcelIds[index] === id);
        }) || null;
    }

    function createProposalFromChainData({ cluster, programAddress, proposalAddress, onchainData }) {
        const statusStr = parseContractStatus(onchainData.statusCode);
        const proposalId = buildChainProposalId(cluster, programAddress, proposalAddress);

        return {
            proposalId,
            parentParcelIds: onchainData.parentParcelIds || [],
            childParcelIds: [],
            name: `Proposal ${proposalAddress.slice(0, 8)}...`,
            description: 'Minted proposal from Solana',
            author: onchainData.owner || 'Unknown',
            type: 'Purchase',
            proposalMainType: 'Purchase',
            status: statusStr,
            acquisitionStrategy: onchainData.isConditional ? 'conditional' : 'partial',
            isMinted: true,
            nft: {
                chain: `solana-${cluster}`,
                contract: (programAddress || '').toLowerCase(),
                tokenId: proposalAddress
            },
            onchain: {
                chainId: `solana-${cluster}`,
                contractAddress: (programAddress || '').toLowerCase(),
                proposalId: proposalAddress,
                acceptanceCount: onchainData.acceptanceCount || '0',
                solBalance: onchainData.solBalance || onchainData.ethBalance || '0',
                ethBalance: onchainData.solBalance || onchainData.ethBalance || '0',
                tokenBalance: onchainData.tokenBalance || '0',
                expiryTimestamp: onchainData.expiryTimestamp || '0',
                expiringPercentage: onchainData.expiringPercentage || '0',
                imageURI: onchainData.imageURI || null
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
    }

    async function syncSingleProposal(cluster, programAddress, proposalAddress) {
        try {
            if (!isWalletConnected()) return false;
            if (!g.SolanaChainDataLoader) return false;

            const connection = g.SolanaChainDataLoader.getConnection(cluster);
            const accountInfo = await connection.getAccountInfo(new g.solanaWeb3.PublicKey(proposalAddress));
            if (!accountInfo || !accountInfo.data) return false;

            const onchainData = g.SolanaChainDataLoader.parseProposalAccount(accountInfo.data, proposalAddress);
            if (!onchainData) return false;

            const chainProposalId = buildChainProposalId(cluster, programAddress, proposalAddress);
            let localProposal = null;
            if (g.proposalStorage && typeof g.proposalStorage.getProposal === 'function') {
                localProposal = g.proposalStorage.getProposal(chainProposalId);
            }
            if (!localProposal) {
                localProposal = findLocalProposalByParcels(onchainData.parentParcelIds || []);
            }

            if (localProposal && g.proposalStorage && typeof g.proposalStorage.importOnChainProposal === 'function') {
                g.proposalStorage.importOnChainProposal({
                    proposalId: proposalAddress,
                    parentParcelIds: onchainData.parentParcelIds || [],
                    isConditional: onchainData.isConditional === true,
                    imageURI: onchainData.imageURI || '',
                    acceptancePossible: onchainData.acceptancePossible !== false,
                    status: onchainData.status || 'Active',
                    solBalance: onchainData.solBalance || onchainData.ethBalance || '0',
                ethBalance: onchainData.solBalance || onchainData.ethBalance || '0',
                    tokenBalance: onchainData.tokenBalance || '0',
                    acceptanceCount: onchainData.acceptanceCount || '0',
                    expiryTimestamp: onchainData.expiryTimestamp || '0',
                    expiringPercentage: onchainData.expiringPercentage || '0',
                    acceptedParcels: onchainData.acceptedParcels || [],
                    owner: onchainData.owner || null,
                    chainId: `solana-${cluster}`,
                    contractAddress: (programAddress || '').toLowerCase(),
                    onchain: {
                        chainId: `solana-${cluster}`,
                        contractAddress: (programAddress || '').toLowerCase(),
                        proposalId: proposalAddress,
                        acceptanceCount: onchainData.acceptanceCount || '0',
                        solBalance: onchainData.solBalance || onchainData.ethBalance || '0',
                ethBalance: onchainData.solBalance || onchainData.ethBalance || '0',
                        tokenBalance: onchainData.tokenBalance || '0',
                        expiryTimestamp: onchainData.expiryTimestamp || '0',
                        expiringPercentage: onchainData.expiringPercentage || '0',
                        imageURI: onchainData.imageURI || null
                    }
                });
                return true;
            }

            const newProposal = createProposalFromChainData({ cluster, programAddress, proposalAddress, onchainData });

            if (localProposal) {
                Object.assign(localProposal, newProposal);
                localProposal.updatedAt = new Date().toISOString();
                if (g.proposalStorage && typeof g.proposalStorage.save === 'function') {
                    g.proposalStorage.save();
                }
            } else if (g.proposalStorage && typeof g.proposalStorage.addProposal === 'function') {
                g.proposalStorage.addProposal(newProposal);
            }

            return true;
        } catch (err) {
            console.error('Solana sync single proposal failed', err);
            return false;
        }
    }

    async function resolveSolanaContracts() {
        // Try city config first
        const cityConfig = typeof g.getCityConfig === 'function' ? g.getCityConfig() : null;
        const fromConfig = (cityConfig?.blockchain?.solanaProposalContracts) || [];
        if (fromConfig.length > 0) return fromConfig;

        // Fall back to addresses.json
        const wm = g.solanaWalletManager;
        const cluster = wm && wm.getCluster ? wm.getCluster() : 'devnet';
        const loader = g.SolanaChainDataLoader;
        if (loader && typeof loader.resolveProgramAddress === 'function') {
            let programAddress = await loader.resolveProgramAddress(`solana-${cluster}`, 'ProposalNFT');
            if (!programAddress && cluster === 'devnet') {
                programAddress = await loader.resolveProgramAddress('solana', 'ProposalNFT');
            }
            if (programAddress) {
                return [{ cluster, programAddress }];
            }
        }
        return [];
    }

    async function syncBlockchainProposals(options = {}) {
        if (!isWalletConnected()) {
            return { totalSynced: 0, contracts: [], skipped: true, reason: 'no_wallet' };
        }

        const solanaContracts = await resolveSolanaContracts();

        if (solanaContracts.length === 0) {
            return { totalSynced: 0, contracts: [] };
        }

        const results = [];
        for (const { cluster, programAddress } of solanaContracts) {
            try {
                const proposals = await g.SolanaChainDataLoader.getAllProposals(cluster, programAddress);
                let synced = 0;
                for (const p of proposals) {
                    const ok = await syncSingleProposal(cluster, programAddress, p.proposalId);
                    if (ok) synced++;
                }
                results.push({ cluster, programAddress, synced, total: proposals.length });
            } catch (err) {
                console.error('Solana sync failed for', programAddress, err);
                results.push({ cluster, programAddress, error: err.message });
            }
        }

        const totalSynced = results.reduce((s, r) => s + (r.synced || 0), 0);
        if (typeof g.refreshProposalsLayer === 'function') g.refreshProposalsLayer();
        if (typeof g.updateStatus === 'function') {
            g.updateStatus(totalSynced > 0 ? `Synced ${totalSynced} proposal(s) from Solana` : 'No new Solana proposals');
        }

        return { totalSynced, contracts: results };
    }

    g.SolanaBlockchainSync = {
        sync: syncBlockchainProposals,
        syncSingle: syncSingleProposal,
        isWalletConnected
    };
})(typeof window !== 'undefined' ? window : globalThis);
