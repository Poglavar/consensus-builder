// The one mint every publish path uses (proposal-kinds.md M2a): build the NFT metadata, upload it
// with the image, mint on the active chain through the bridge router and record the result, then
// mirror the minted record to the server. mintPlan and mintMetadata are pure; mint and mirror are
// the browser layer around them.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalPublishMint = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const kinds = () => root.ProposalKind || (typeof require === 'function' ? require('./proposal-kind.js') : null);

    // Native funding is only possible in the chain's own currency; anything else mints unfunded.
    function nativeAmountOf(proposal) {
        const offer = Number(proposal && proposal.offer);
        const currency = proposal && proposal.offerCurrency;
        return (currency === 'ETH' || currency === 'SOL') && Number.isFinite(offer) && offer > 0 ? offer : 0;
    }

    /**
     * Which bridge mints, with which arguments. `chain` is 'canton' | 'solana' | 'evm'. A vote (either
     * kind) and an approval setup hold no money and never execute; an owner offer escrows nothing
     * (bids arrive as pledges). Solana commits the site (siteArgs from site-hash.js chainSiteArgs);
     * its verdict may execute only to clear open ground of a binding proposal.
     */
    function mintPlan({ proposal, chain, metadataUri, lensAddresses = [], solanaLensKeys = [], siteArgs = null, approvalSetup = false }) {
        const parcelIds = Array.isArray(proposal.cadastreParcelIds) ? proposal.cadastreParcelIds.slice() : [];
        const nonBinding = kinds().isNonBinding(proposal);
        const isConditional = proposal.isConditional === true;
        const unfunded = nonBinding || approvalSetup || proposal.proposalRole === 'owner-offer';
        if (chain === 'canton') {
            return { bridge: 'canton', options: { parcelIds, price: Number(proposal.offer) || 0, imageURI: metadataUri } };
        }
        if (chain === 'solana') {
            if (!siteArgs) throw new Error('A Solana mint needs the site commitment.');
            return {
                bridge: 'solana',
                options: {
                    parcelIds, isConditional, imageURI: metadataUri, lens: solanaLensKeys.slice(),
                    solAmount: unfunded ? 0 : nativeAmountOf(proposal),
                    approvalSetup,
                    verdictMayExecute: approvalSetup || nonBinding ? false : siteArgs.openGround,
                    siteHash: siteArgs.siteHash,
                    openGround: siteArgs.openGround
                }
            };
        }
        return {
            bridge: 'evm',
            options: {
                parcelIds, isConditional, imageURI: metadataUri, lens: lensAddresses.slice(),
                ethAmount: unfunded ? 0 : nativeAmountOf(proposal),
                tokenAmount: 0n,
                approvalSetup,
                // Both vote kinds mint fund-less via mintVote with a voting deadline.
                isVote: nonBinding,
                expiryDays: nonBinding ? proposal.voteExpiryDays : undefined
            }
        };
    }

    /** The NFT metadata: display attributes plus the full portable record (chain-record.js). */
    function mintMetadata(proposal, { goalLabel, backendType, author, lensAddresses, properties }) {
        const title = proposal.name || proposal.title || `${goalLabel} Proposal`;
        const parcelCount = Array.isArray(proposal.cadastreParcelIds) ? proposal.cadastreParcelIds.length : 0;
        const kind = kinds().kindOf(proposal);
        return {
            name: title,
            title,
            description: proposal.description || '',
            image: '', // filled by the asset upload
            attributes: [
                { trait_type: 'Goal', value: goalLabel },
                ...(kind ? [{ trait_type: 'Kind', value: kind }] : []),
                { trait_type: 'Conditional', value: proposal.isConditional === true ? 'Yes' : 'No' },
                { trait_type: 'Parcel Count', value: parcelCount },
                { trait_type: 'Author', value: author || '' },
                ...(kinds().isNonBinding(proposal) ? [] : [{ trait_type: 'Offer', value: `${Number(proposal.offer) || 0} ${proposal.offerCurrency || ''}`.trim() }]),
                ...(proposal.city ? [{ trait_type: 'City', value: proposal.city }] : [])
            ],
            properties: properties({ ...proposal, type: backendType, author: author || proposal.author, lens: lensAddresses, isConditional: proposal.isConditional === true })
        };
    }

    // ---- browser layer ----

    /**
     * The chain a mint goes to now, or null with no wallet: { chain: 'canton'|'solana'|'evm', chainId }.
     * Canton needs no wallet; Solana wins over EVM when both are connected.
     */
    function connectedChain() {
        if (root.CantonMode?.isActive?.() && root.CantonProposalChainBridge) return { chain: 'canton', chainId: 'canton' };
        const solana = root.solanaWalletManager?.getState?.();
        if (solana?.status === 'connected' && solana.accounts?.length && root.SolanaProposalChainBridge?.isSupported?.()) {
            return { chain: 'solana', chainId: `solana-${root.solanaWalletManager.getCluster?.() || 'devnet'}` };
        }
        const evm = root.walletManager?.getState?.();
        if (evm?.status === 'connected' && evm.accounts?.length) return { chain: 'evm', chainId: evm.chainId || null };
        return null;
    }

    function activeChain() {
        return connectedChain()?.chain || 'evm';
    }

    function chainIdForUpload(chain) {
        if (chain === 'solana') return `solana-${root.solanaWalletManager?.getCluster?.() || 'devnet'}`;
        return root.walletManager?.getState?.()?.chainId || null;
    }

    /**
     * Mint a prepared proposal (its binding adopted from __mintBinding.prepareForMint) and write the
     * chain result onto it and its stored copy. Returns { onchainResult, assetUploadResult, metadataUri }.
     */
    async function mint(proposal, { screenshotDataUrl, lensEntries = [], onStatus = () => {}, onSubmitted } = {}) {
        if (!screenshotDataUrl || !String(screenshotDataUrl).startsWith('data:image/')) {
            throw new Error('Could not capture the proposal image. Minting stopped before signing.');
        }
        if (!root.AssetService?.uploadProposalAssets) throw new Error('Proposal storage is unavailable. Minting stopped before signing.');
        const chain = activeChain();
        const lensAddresses = lensEntries.map(entry => entry && typeof entry.address === 'string' ? entry.address.trim() : '').filter(Boolean);
        const approvalSetup = root.ProposalApprovalRuntime?.uses(proposal) === true;
        let solanaLensKeys = [];
        if (chain === 'solana') {
            const solanaLens = root.LensCore.validateSolanaLens(lensEntries);
            if (!solanaLens.ok) throw new Error('Choose at least one lens member (the lens button) before minting on Solana.');
            solanaLensKeys = solanaLens.keys;
        } else if (chain === 'evm' && !lensAddresses.length && proposal.goal !== 'ownership-transfer-from-me') {
            throw new Error('Cannot mint proposal: lens list is empty. Set your lens before minting.');
        }

        const goalKey = (typeof root.resolveProposalGoalKey === 'function' ? root.resolveProposalGoalKey(proposal, null) : proposal.goal) || 'proposal';
        const author = (typeof root.stampCurrentAuthor === 'function' ? root.stampCurrentAuthor(proposal).author : proposal.author) || '';
        proposal.createdAt = proposal.createdAt || new Date().toISOString();
        const metadata = mintMetadata(proposal, {
            goalLabel: goalKey.replace(/-/g, ' '),
            backendType: (typeof root.mapGoalToBackendType === 'function' && root.mapGoalToBackendType(goalKey)) || 'parcel',
            author,
            lensAddresses,
            properties: record => root.__chainRecord.metadataProperties(record)
        });

        const storageLabel = typeof root.getStorageProviderLabel === 'function' ? root.getStorageProviderLabel() : 'decentralized storage';
        onStatus(`Uploading proposal image to ${storageLabel}...`);
        const assetUploadResult = await root.AssetService.uploadProposalAssets({
            imageData: screenshotDataUrl,
            metadata,
            fileName: `proposal-${Date.now()}`,
            chainId: chainIdForUpload(chain),
            target: 'auto'
        });
        const metadataUri = assetUploadResult?.metadataUri || assetUploadResult?.metadataUrl || '';
        if (!metadataUri) throw new Error('The upload returned no metadata URI. Minting stopped before signing.');

        const siteArgs = chain === 'solana'
            ? await root.__siteHash.chainSiteArgs({ site: proposal.site || null, binding: proposal.binding || null, parcelIds: proposal.cadastreParcelIds || [] })
            : null;
        const plan = mintPlan({ proposal, chain, metadataUri, lensAddresses, solanaLensKeys, siteArgs, approvalSetup });
        onStatus('Waiting for wallet signature...');
        const bridge = plan.bridge === 'canton' ? root.CantonProposalChainBridge
            : plan.bridge === 'solana' ? root.SolanaProposalChainBridge : root.ProposalChainBridge;
        const onchainResult = await bridge.mintProposal({ ...plan.options, ...(onSubmitted ? { onSubmitted } : {}) });

        recordMintResult(proposal, onchainResult, assetUploadResult, metadataUri);
        return { onchainResult, assetUploadResult, metadataUri };
    }

    // The chain result on the proposal and on its stored copy; the permanent image URL replaces
    // the local data URL.
    function recordMintResult(proposal, onchainResult, assetUploadResult, metadataUri) {
        const tokenId = onchainResult.proposalId != null ? String(onchainResult.proposalId) : null;
        const chainProposalId = typeof root.buildChainProposalId === 'function'
            ? root.buildChainProposalId(onchainResult.chainId, onchainResult.contractAddress, onchainResult.proposalId) : null;
        proposal.onchain = {
            ...(proposal.onchain || {}),
            transactionHash: onchainResult.transactionHash || null,
            proposalId: tokenId,
            chainId: onchainResult.chainId || null,
            contractAddress: onchainResult.contractAddress || null,
            metadataUri,
            metadataUrl: assetUploadResult?.metadataGatewayUrl || null,
            imageUri: assetUploadResult?.imageUri || null,
            imageUrl: assetUploadResult?.imageGatewayUrl || null,
            chainProposalId
        };
        proposal.nft = { chain: onchainResult.chainId || null, contract: onchainResult.contractAddress || null, tokenId, chainProposalId };
        proposal.chainProposalId = chainProposalId || proposal.chainProposalId || null;
        proposal.tokenId = proposal.tokenId || tokenId;

        const storage = root.proposalStorage;
        const stored = proposal.proposalId && storage ? storage.getProposal(proposal.proposalId) : null;
        if (!stored) return;
        if (stored !== proposal) {
            stored.onchain = { ...proposal.onchain };
            stored.nft = { ...proposal.nft };
            stored.chainProposalId = stored.chainProposalId || proposal.chainProposalId;
            stored.tokenId = stored.tokenId || proposal.tokenId;
        }
        if (proposal.onchain.imageUrl) {
            stored.screenshotUrl = proposal.onchain.imageUrl;
            delete stored.screenshotDataUrl;
        }
        storage._indexProposal?.(stored);
        storage.save?.();
        if (stored.screenshotUrl) {
            try {
                root.document?.dispatchEvent(new CustomEvent('proposalScreenshotUpdated', {
                    detail: { proposalId: stored.proposalId, screenshotUrl: stored.screenshotUrl }
                }));
            } catch (_) { }
        }
    }

    /** Mirror a minted record to the server for discovery and ENS; throws when the server refuses. */
    async function mirror(proposal) {
        const result = await root.uploadProposalToServer(proposal);
        if (!result || !result.ok) throw new Error((result && result.message) || 'server save failed');
        return result;
    }

    return Object.freeze({ nativeAmountOf, mintPlan, mintMetadata, connectedChain, mint, mirror });
});
