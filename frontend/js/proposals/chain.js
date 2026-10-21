// proposals/chain.js — extracted from proposals.js (behavior-preserving relocation).

// Minted means a mint record exists (proposals/display-state.js owns the rule). A numeric id is a
// server serial, i.e. Published: reading it as minted badged published proposals "Minted".
function isProposalMinted(proposal) {
    return window.__proposalDisplayState.hasMintRecord(proposal);
}

// Can this design's geometry NEVER be rewritten by us? True for on-chain-minted records AND for
// published designs (`published: { cid }`, proposals/design-sync.js): a published design is content
// addressed and referenced by its CID, so it cannot change; an edit derives a new design. The impact
// resolver keys mutability on THIS, not on isProposalMinted: an immutable design a road runs into can
// only be unapplied, tunnelled under, or the edit rerouted — never cut or reshaped. Only a purely
// local design (never published) is ours to modify.
function isProposalImmutable(proposal) {
    if (!proposal) return false;
    if (isProposalMinted(proposal)) return true;
    return !!(proposal.published && window.Cid.isCid(proposal.published.cid));
}

function buildChainProposalId(chainId, contractAddress, tokenId) {
    if (chainId === undefined || chainId === null || !contractAddress || tokenId === undefined || tokenId === null) {
        return null;
    }
    const normalizedChain = typeof normalizeChainId === 'function'
        ? normalizeChainId(chainId)
        : (chainId && chainId.toString ? chainId.toString() : String(chainId));
    const address = String(contractAddress);
    const addressPart = /^(solana|canton)(-|$)/.test(String(normalizedChain)) ? address : address.toLowerCase();
    const tokenPart = tokenId && tokenId.toString ? tokenId.toString() : String(tokenId);
    if (!normalizedChain || !addressPart || !tokenPart) {
        return null;
    }
    return `${normalizedChain}-${addressPart}-${tokenPart}`;
}

function getProposalMetadataUrl(proposal) {
    if (!proposal || typeof proposal !== 'object') return '';
    const candidates = [
        proposal.onchain && proposal.onchain.metadataUrl,
        proposal.onchain && proposal.onchain.metadataUri,
        proposal.metadataUrl,
        proposal.metadataUri,
        proposal.metadata && proposal.metadata.url,
        proposal.metadata && proposal.metadata.uri,
        proposal.onchain && proposal.onchain.imageURI,
        proposal.imageURI
    ];
    for (const candidate of candidates) {
        const resolved = resolveProposalResourceUrl(candidate);
        if (resolved) return resolved;
    }
    return '';
}

async function fetchProposalMetadataJson(metadataUrl) {
    const resolvedUrl = resolveProposalResourceUrl(metadataUrl);
    if (!resolvedUrl) return null;
    if (proposalMetadataFetchPromises.has(resolvedUrl)) {
        return proposalMetadataFetchPromises.get(resolvedUrl);
    }

    const promise = (async () => {
        try {
            const response = await fetch(resolvedUrl, { method: 'GET' });
            if (!response.ok) return null;
            return await response.json();
        } catch (error) {
            console.warn('Failed to fetch proposal metadata', resolvedUrl, error);
            return null;
        }
    })();

    proposalMetadataFetchPromises.set(resolvedUrl, promise);
    return promise;
}

function getProposalNftInfo(proposal) {
    if (!proposal) return null;
    const nft = proposal.nft || {};
    const onchain = proposal.onchain || {};

    const chain = (nft.chain ?? onchain.chainId ?? proposal.chainId) || null;
    const contract = (nft.contract ?? onchain.contractAddress ?? proposal.contractAddress) || null;
    const tokenId = (nft.tokenId ?? onchain.proposalId ?? proposal.proposalId) || null;

    if (!contract || tokenId === undefined || tokenId === null) return null;

    return {
        chain: chain ? chain.toString() : null,
        contract: contract.toString(),
        tokenId: tokenId.toString()
    };
}

function parseOnChainErrorMessage(err) {
    const msg = err?.message || String(err || '');
    const logs = err?.logs || [];
    // Check Anchor error codes in logs
    const anchorLogMatch = logs.length > 0
        ? logs.join('\n').match(/Error Code: (\w+)\. Error Number: (\d+)\. Error Message: (.+?)\./)
        : msg.match(/Error Code: (\w+)\. Error Number: (\d+)\. Error Message: (.+?)\./);
    if (anchorLogMatch) {
        const errorCode = anchorLogMatch[1];
        const knownMessages = {
            AcceptanceClosed: 'This proposal is no longer accepting responses.',
            NotConditional: 'This acceptance cannot be withdrawn because the proposal is not conditional.',
            NotActive: 'This acceptance cannot be withdrawn because the proposal has been executed.',
            ParcelNotInProposal: 'This parcel is not part of the proposal.',
            AlreadyAccepted: 'This parcel has already been accepted.',
            NoParcels: 'The proposal must include at least one parcel.',
            NoLens: 'The proposal must include at least one lens.',
            ZeroAmount: 'The contribution amount must be greater than zero.'
        };
        return knownMessages[errorCode] || anchorLogMatch[3];
    }
    // User rejected in wallet
    if (/user rejected|user denied|cancelled/i.test(msg)) {
        return 'Transaction was cancelled.';
    }
    return 'Transaction failed: ' + (msg.length > 200 ? msg.slice(0, 200) + '...' : msg);
}

async function fetchLensFromChain(proposal) {
    try {
        if (!proposal || !proposal.onchain || !proposal.onchain.proposalId) return [];
        const chainId = proposal.onchain.chainId || (typeof normalizeChainId === 'function' ? normalizeChainId(window?.DEFAULT_CHAIN_ID) : null);
        // Solana proposals carry `lens: Vec<Pubkey>` in the proposal account itself; read it there and
        // never hand a Solana cluster id to the EVM provider.
        const chainKey = String(chainId || '').toLowerCase();
        if (proposal.chainType === 'solana' || proposal.onchain.chainType === 'solana' || chainKey === 'solana' || chainKey.startsWith('solana-')) {
            const loader = window.SolanaChainDataLoader;
            if (typeof window.ensureWalletVendors === 'function') await window.ensureWalletVendors();
            if (!loader || !window.solanaWeb3) return [];
            const cluster = chainKey.replace(/^solana-?/, '') || 'devnet';
            const account = String(proposal.onchain.proposalId);
            const info = await loader.getConnection(cluster).getAccountInfo(new window.solanaWeb3.PublicKey(account));
            const parsed = info && info.data ? loader.parseProposalAccount(info.data, account) : null;
            return normalizeLensEntries(parsed && Array.isArray(parsed.lens) ? parsed.lens : []);
        }
        let contractAddress = proposal.onchain.contractAddress || null;
        if (!contractAddress && typeof window !== 'undefined' && window.ChainDataLoader && typeof window.ChainDataLoader.resolveContractAddress === 'function') {
            contractAddress = await window.ChainDataLoader.resolveContractAddress(chainId, 'ProposalNFT');
        }
        if (!contractAddress || !window.ethers) return [];
        const provider = await window.ChainDataLoader.getProviderForChain(chainId);
        const { Contract, getAddress } = window.ethers;
        const normalizedAddress = getAddress(contractAddress);
        const abi = [
            'function getLens(uint256 proposalId) public view returns (address[] memory)'
        ];
        const contract = new Contract(normalizedAddress, abi, provider);
        const lensResult = await contract.getLens(proposal.onchain.proposalId);
        return normalizeLensEntries(lensResult || []);
    } catch (err) {
        console.warn('fetchLensFromChain failed', err);
        return [];
    }
}

function normalizeChainIdForBoost(chainIdInput) {
    if (chainIdInput === undefined || chainIdInput === null) return null;
    try {
        if (typeof chainIdInput === 'bigint') return chainIdInput.toString();
        if (typeof chainIdInput === 'number') {
            if (!Number.isFinite(chainIdInput)) return null;
            return Math.trunc(chainIdInput).toString();
        }
        if (typeof chainIdInput === 'string') {
            const trimmed = chainIdInput.trim();
            if (!trimmed) return null;
            if (trimmed.startsWith('0x') || trimmed.startsWith('0X')) {
                return BigInt(trimmed).toString();
            }
            const num = Number(trimmed);
            if (Number.isFinite(num)) {
                return Math.trunc(num).toString();
            }
            return trimmed;
        }
    } catch (_) {
        return null;
    }
    return null;
}

async function checkParcelsHaveNFTsSolana(parcelIds, chainId) {
    if (!parcelIds || parcelIds.length === 0) {
        return { allHaveNFTs: true, missingParcels: [], chainId, chainName: 'Solana' };
    }
    if (typeof window.ensureWalletVendors === 'function') await window.ensureWalletVendors();

    const loader = window.SolanaChainDataLoader;
    const hasBatchStatusLoader = loader && typeof loader.getParcelMintStatuses === 'function';
    const hasSingleStatusLoader = loader && typeof loader.getParcelMintStatus === 'function';
    if (!hasBatchStatusLoader && !hasSingleStatusLoader) {
        return { allHaveNFTs: false, missingParcels: parcelIds, chainId, chainName: 'Solana' };
    }

    // Resolve program address
    let programAddress = null;
    const normalizedSolanaChainId = (() => {
        const raw = typeof chainId === 'string' ? chainId.trim().toLowerCase() : '';
        if (!raw || raw === 'solana' || raw === 'devnet') return 'solana-devnet';
        if (raw === 'mainnet' || raw === 'mainnet-beta' || raw === 'solana-mainnet') return 'solana-mainnet-beta';
        return raw.startsWith('solana-') ? raw : `solana-${raw}`;
    })();
    const allowGenericSolanaFallback = normalizedSolanaChainId === 'solana-devnet';
    try {
        if (loader && typeof loader.resolveProgramAddress === 'function') {
            programAddress = await loader.resolveProgramAddress(normalizedSolanaChainId, 'ParcelNFT');
            if (!programAddress && allowGenericSolanaFallback) {
                programAddress = await loader.resolveProgramAddress('solana', 'ParcelNFT');
            }
        }
        if (!programAddress) {
            const resp = await fetch('/contracts/addresses.json');
            if (resp && resp.ok) {
                const data = await resp.json();
                programAddress = (data[normalizedSolanaChainId] && data[normalizedSolanaChainId].ParcelNFT) || null;
                if (!programAddress && allowGenericSolanaFallback) {
                    programAddress = (data['solana'] && data['solana'].ParcelNFT) || null;
                }
            }
        }
    } catch (_) { }

    if (!programAddress) {
        console.warn('[checkParcelsHaveNFTsSolana] No ParcelNFT program address found for', chainId);
        return { allHaveNFTs: false, missingParcels: parcelIds, chainId, chainName: 'Solana' };
    }

    const cluster = chainId.replace('solana-', '') || 'devnet';
    const normalizedParcelIds = parcelIds.map(parcelId => (parcelId && parcelId.toString ? parcelId.toString() : String(parcelId))).filter(Boolean);
    const missingParcels = [];

    if (hasBatchStatusLoader) {
        try {
            const statuses = await loader.getParcelMintStatuses(normalizedParcelIds, programAddress, cluster, { forceRefresh: true });
            normalizedParcelIds.forEach((parcelId, index) => {
                const status = Array.isArray(statuses) ? statuses[index] : null;
                if (!status || !status.minted) {
                    missingParcels.push(parcelId);
                }
            });
        } catch (err) {
            console.warn('[checkParcelsHaveNFTsSolana] Batched status check failed.', err);
            missingParcels.push(...normalizedParcelIds);
        }
    } else {
        for (const parcelId of normalizedParcelIds) {
            try {
                const status = await loader.getParcelMintStatus(parcelId, programAddress, cluster, { forceRefresh: true });
                if (!status || !status.minted) {
                    missingParcels.push(parcelId);
                }
            } catch (err) {
                console.warn('[checkParcelsHaveNFTsSolana] Error checking parcel', parcelId, err);
                missingParcels.push(parcelId);
            }
        }
    }

    return {
        allHaveNFTs: missingParcels.length === 0,
        missingParcels,
        chainId,
        chainName: `Solana ${cluster}`
    };
}

async function checkParcelsHaveNFTs(parcelIds, chainId) {
    if (!parcelIds || parcelIds.length === 0) {
        return { allHaveNFTs: true, missingParcels: [], chainId: null, chainName: null };
    }

    if (typeof window.ensureWalletVendors === 'function') await window.ensureWalletVendors();
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    if (!globalScope || !globalScope.ethers) {
        // If blockchain library is not available, assume parcels don't have NFTs
        return { allHaveNFTs: false, missingParcels: parcelIds, chainId: null, chainName: null };
    }

    // Normalize chainId to string
    let normalizedChainId = chainId;
    if (typeof chainId === 'bigint') {
        normalizedChainId = chainId.toString();
    } else if (typeof chainId === 'number') {
        normalizedChainId = String(Math.trunc(chainId));
    } else if (typeof chainId === 'string' && chainId.startsWith('0x')) {
        try {
            normalizedChainId = BigInt(chainId).toString();
        } catch (_) { }
    }

    try {
        // Resolve ParcelNFT contract address - check addresses.json first
        let contractAddress = null;

        // 1) Try addresses.json directly
        try {
            const resp = await fetch('/contracts/addresses.json');
            if (resp && resp.ok) {
                const data = await resp.json();
                if (data && data[normalizedChainId] && data[normalizedChainId].ParcelNFT) {
                    contractAddress = data[normalizedChainId].ParcelNFT;
                }
            }
        } catch (err) {
            console.warn('Failed to load ParcelNFT from addresses.json:', err);
        }

        // 2) Try ContractsLoader
        if (!contractAddress && globalScope.ContractsLoader && typeof globalScope.ContractsLoader.getContractAddress === 'function') {
            try {
                contractAddress = await globalScope.ContractsLoader.getContractAddress(normalizedChainId, 'ParcelNFT');
            } catch (error) {
                console.warn('Failed to load ParcelNFT address from ContractsLoader:', error);
            }
        }

        // 3) Try global resolveParcelNftAddress
        if (!contractAddress && typeof globalScope.resolveParcelNftAddress === 'function') {
            contractAddress = await globalScope.resolveParcelNftAddress(normalizedChainId);
        }

        if (!contractAddress) {
            // Can't check, assume they don't have NFTs
            console.warn('[checkParcelsHaveNFTs] No ParcelNFT contract address found for chain', normalizedChainId);
            return { allHaveNFTs: false, missingParcels: parcelIds, chainId: normalizedChainId, chainName: null };
        }

        console.debug('[checkParcelsHaveNFTs] Using ParcelNFT contract:', contractAddress, 'on chain', normalizedChainId);

        // Get provider
        let provider = null;
        const walletManager = globalScope.walletManager;
        const walletProvider = walletManager && typeof walletManager.getProvider === 'function' ? walletManager.getProvider() : null;

        if (walletProvider) {
            try {
                provider = new globalScope.ethers.BrowserProvider(walletProvider);
            } catch (error) {
                console.warn('Failed to create browser provider:', error);
            }
        }

        // Fallback to RPC provider
        // Only use RPC provider if wallet is connected, or if it's a non-local RPC URL
        // For local RPC URLs without a wallet, skip to avoid pinging unavailable local nodes
        if (!provider) {
            const rpcUrl = typeof globalScope.resolveRpcUrlForChain === 'function' ? globalScope.resolveRpcUrlForChain(normalizedChainId) : null;
            if (rpcUrl) {
                // Check if it's a local RPC URL
                const isLocal = rpcUrl && (rpcUrl.includes('localhost') || rpcUrl.includes('127.0.0.1'));

                // For local RPC URLs without a wallet, only create provider if isLocalNodeAvailable confirms it's available
                // This prevents JsonRpcProvider from retrying every second when the local node is not running
                if (isLocal) {
                    // Check if local node is available before creating provider
                    if (globalScope.isLocalNodeAvailable && typeof globalScope.isLocalNodeAvailable === 'function') {
                        const localNodeAvailable = await globalScope.isLocalNodeAvailable();
                        if (!localNodeAvailable) {
                            console.warn('Local node not available and no wallet connected, skipping RPC provider creation');
                            // Don't create provider for local RPC when node is unavailable
                        } else {
                            // Local node is available, safe to create provider
                            try {
                                const numericChainId = Number(normalizedChainId);
                                provider = Number.isFinite(numericChainId)
                                    ? new globalScope.ethers.JsonRpcProvider(rpcUrl, numericChainId)
                                    : new globalScope.ethers.JsonRpcProvider(rpcUrl);
                            } catch (error) {
                                console.warn('Failed to create RPC provider:', error);
                            }
                        }
                    } else {
                        // No isLocalNodeAvailable function - skip local RPC to avoid retries when no wallet
                        console.warn('No wallet connected and local RPC URL detected, skipping RPC provider creation to avoid connection retries');
                    }
                } else {
                    // Non-local RPC URL - safe to use even without wallet (read-only operations)
                    try {
                        const numericChainId = Number(normalizedChainId);
                        provider = Number.isFinite(numericChainId)
                            ? new globalScope.ethers.JsonRpcProvider(rpcUrl, numericChainId)
                            : new globalScope.ethers.JsonRpcProvider(rpcUrl);
                    } catch (error) {
                        console.warn('Failed to create RPC provider:', error);
                    }
                }
            }
        }

        if (!provider) {
            console.warn('[checkParcelsHaveNFTs] No provider available for chain', normalizedChainId);
            return { allHaveNFTs: false, missingParcels: parcelIds, chainId: normalizedChainId, chainName: null };
        }

        // Create contract instance
        const PARCEL_NFT_ABI = [
            'function tokenIdForParcelId(string parcelId) public view returns (uint256)'
        ];
        const contract = new globalScope.ethers.Contract(contractAddress, PARCEL_NFT_ABI, provider);

        // Check each parcel
        const missingParcels = [];
        const checkPromises = parcelIds.map(async (parcelId) => {
            try {
                const tokenId = await contract.tokenIdForParcelId(parcelId);
                // If we get a result, the parcel has an NFT
                if (tokenId !== null && tokenId !== undefined) {
                    return { parcelId, hasNFT: true };
                }
                return { parcelId, hasNFT: false };
            } catch (error) {
                // Check if it's a "parcel does not exist" error (expected for unminted parcels)
                if (typeof globalScope.isParcelTokenMissingError === 'function' && globalScope.isParcelTokenMissingError(error)) {
                    return { parcelId, hasNFT: false };
                }

                // Handle RPC errors - MetaMask wraps revert errors in RPC error format
                const errorCode = error?.code || error?.data?.code;
                let errorMessage = error?.message || error?.data?.message || String(error);

                // For RPC errors (code -32603), check the data field for the actual revert reason
                if (errorCode === -32603 && error?.data) {
                    // MetaMask wraps contract reverts in RPC errors
                    // Check if the data contains the actual revert message
                    const dataMessage = error.data?.message || error.data?.originalError?.message ||
                        error.data?.data?.message || error.data?.originalError?.data?.message;
                    if (dataMessage) {
                        errorMessage = dataMessage;
                    }

                    // Check if the wrapped error indicates parcel doesn't exist
                    const dataMessageLower = String(dataMessage || '').toLowerCase();
                    if (dataMessageLower.includes('parcel does not exist')) {
                        return { parcelId, hasNFT: false };
                    }
                }

                // Check if error message indicates parcel doesn't exist
                const errorStr = String(errorMessage).toLowerCase();
                if (errorStr.includes('parcel does not exist') ||
                    errorStr.includes('nonexistent token') ||
                    (errorStr.includes('revert') && !errorStr.includes('internal json-rpc'))) {
                    return { parcelId, hasNFT: false };
                }

                // For RPC errors that don't indicate a missing parcel, log and assume no NFT
                // This is safer than assuming it does have one
                if (errorCode === -32603 || errorCode === -32602 || errorCode === -32000) {
                    console.warn(`RPC error checking parcel ${parcelId} (assuming not minted):`, {
                        code: errorCode,
                        message: errorMessage,
                        data: error?.data
                    });
                    return { parcelId, hasNFT: false, error: 'RPC_ERROR' };
                }

                // For other errors, log and assume no NFT (safer default)
                console.warn(`Unexpected error checking parcel ${parcelId}:`, {
                    code: errorCode,
                    message: errorMessage,
                    error
                });
                return { parcelId, hasNFT: false, error: 'UNKNOWN_ERROR' };
            }
        });

        const results = await Promise.all(checkPromises);
        results.forEach(result => {
            if (!result.hasNFT) {
                missingParcels.push(result.parcelId);
            }
        });

        const chainName = typeof globalScope.resolveChainSlug === 'function' ? globalScope.resolveChainSlug(normalizedChainId) : normalizedChainId;

        console.debug('[checkParcelsHaveNFTs] Result:', { allHaveNFTs: missingParcels.length === 0, missingCount: missingParcels.length, total: parcelIds.length });

        return {
            allHaveNFTs: missingParcels.length === 0,
            missingParcels,
            chainId: normalizedChainId,
            chainName: chainName || normalizedChainId
        };
    } catch (error) {
        console.error('Error checking parcel NFTs:', error);
        // On error, assume parcels don't have NFTs
        return { allHaveNFTs: false, missingParcels: parcelIds, chainId: normalizedChainId, chainName: null };
    }
}

// Asked over the create dialog (js/ui/dialogs.js confirm): resolves true to create in memory.
async function showWalletNotConnectedModal() {
    const t = getProposalI18nHelper();
    setProposalModalDimmed(true);
    const introMessage = t(
        'modal.createProposal.walletNotConnected.message',
        'You are not connected with a wallet, so you can\'t mint proposals on chain.'
    );
    const proceedPrompt = t(
        'modal.createProposal.walletNotConnected.proceedQuestion',
        'Proceed to create an in-memory proposal?'
    );
    try {
        return await window.CbDialog.confirm(`${introMessage}\n\n${proceedPrompt}`, {
            okText: t('modal.createProposal.walletNotConnected.confirm', 'Create'),
            cancelText: t('modal.createProposal.walletNotConnected.cancel', 'Cancel')
        });
    } finally {
        setProposalModalDimmed(false);
    }
}

async function handleBlockchainSyncClick(event) {
    event.preventDefault();
    event.stopPropagation();

    const runtimeGlobal = typeof globalThis !== 'undefined'
        ? globalThis
        : ((typeof window !== 'undefined') ? window : {});

    console.debug('[ProposalListModal] blockchain sync requested', {
        hasBlockchainSync: !!runtimeGlobal.BlockchainSync,
        hasWalletManager: !!runtimeGlobal.walletManager
    });

    const hasEvmSync = runtimeGlobal.BlockchainSync && typeof runtimeGlobal.BlockchainSync.sync === 'function';
    const hasSolanaSync = runtimeGlobal.SolanaBlockchainSync && typeof runtimeGlobal.SolanaBlockchainSync.sync === 'function'
        && runtimeGlobal.SolanaBlockchainSync.isWalletConnected();

    if (!hasEvmSync && !hasSolanaSync) {
        console.warn('BlockchainSync not available');
        return;
    }

    if (hasEvmSync) {
        const status = runtimeGlobal.BlockchainSync.getStatus();
        if (status.isSyncing) {
            console.log('Sync already in progress');
            return;
        }
    }

    try {
        // Refresh the modal to show spinning icon
        renderProposalListModal();

        // Run EVM sync if available
        if (hasEvmSync) {
            const result = await runtimeGlobal.BlockchainSync.sync({ incrementalOnly: true });
            console.log('Blockchain sync completed', result);
        }

        // Run Solana sync if wallet is connected
        if (hasSolanaSync) {
            const solResult = await runtimeGlobal.SolanaBlockchainSync.sync();
            console.log('Solana blockchain sync completed', solResult);
        }

        // Refresh the modal to show updated proposals
        renderProposalListModal();

    } catch (error) {
        console.error('Blockchain sync failed', error);

        // Refresh modal to remove spinner
        renderProposalListModal();
    }
}

async function ensureProposalMetadataLoaded(proposal) {
    if (!proposal || typeof proposal !== 'object') return null;

    const existingMetadata = proposal.metadata || (proposal.onchain && proposal.onchain.metadata);
    if (existingMetadata && typeof existingMetadata === 'object' && Object.keys(existingMetadata).length > 0) {
        return null;
    }

    const metadataUrl = getProposalMetadataUrl(proposal);
    if (!metadataUrl) return null;

    const metadata = await fetchProposalMetadataJson(metadataUrl);
    if (!metadata || typeof metadata !== 'object') return null;

    const nativeProposalId = proposal.onchain?.proposalId || proposal.tokenId || proposal.nft?.tokenId || proposal.proposalId || null;
    const chainId = proposal.chainId || proposal.onchain?.chainId || proposal.nft?.chain || null;
    const contractAddress = proposal.onchain?.contractAddress || proposal.nft?.contract || null;

    if (typeof proposalStorage !== 'undefined' && typeof proposalStorage.importOnChainProposal === 'function') {
        return proposalStorage.importOnChainProposal({
            proposalId: nativeProposalId,
            cadastreParcelIds: Array.isArray(proposal.cadastreParcelIds) ? proposal.cadastreParcelIds : [],
            isConditional: proposal.isConditional === true,
            imageURI: proposal.imageURI || proposal.onchain?.imageURI || metadataUrl,
            acceptancePossible: proposal.acceptancePossible !== false,
            lifecycleStatus: getLifecycleStatus(proposal),
            ethBalance: proposal.ethBalance || proposal.onchain?.ethBalance || '0',
            tokenBalance: proposal.tokenBalance || proposal.onchain?.tokenBalance || '0',
            acceptanceCount: proposal.acceptanceCount || proposal.onchain?.acceptanceCount || '0',
            expiryTimestamp: proposal.expiryTimestamp || proposal.onchain?.expiryTimestamp || '0',
            expiringPercentage: proposal.expiringPercentage || proposal.onchain?.expiringPercentage || '0',
            acceptedParcels: Array.isArray(proposal.acceptedParcels) ? proposal.acceptedParcels : [],
            title: proposal.title || null,
            name: proposal.name || null,
            description: proposal.description || '',
            goal: proposal.goal || null,
            author: proposal.author || null,
            owner: proposal.author || null,
            chainId,
            contractAddress,
            metadata,
            onchain: {
                ...(proposal.onchain || {}),
                metadata,
                metadataUri: proposal.onchain?.metadataUri || metadataUrl,
                metadataUrl: proposal.onchain?.metadataUrl || metadataUrl
            }
        });
    }

    proposal.metadata = metadata;
    proposal.onchain = {
        ...(proposal.onchain || {}),
        metadata,
        metadataUri: proposal.onchain?.metadataUri || metadataUrl,
        metadataUrl: proposal.onchain?.metadataUrl || metadataUrl
    };
    return proposal;
}

function getExplorerBaseUrlForChain(chainId) {
    const id = chainId ? chainId.toString() : '';
    if (id.startsWith('solana')) {
        const cluster = id.replace('solana-', '');
        if (cluster === 'mainnet-beta') return 'https://explorer.solana.com';
        return `https://explorer.solana.com`;
    }
    switch (id) {
        case '1':
            return 'https://etherscan.io';
        case '11155111':
            return 'https://sepolia.etherscan.io';
        case '8453':
            return 'https://basescan.org';
        case '84532':
        case '0x14a34':
            return 'https://sepolia.basescan.org';
        default:
            return null; // No explorer known (e.g., hardhat)
    }
}

function buildProposalNftExplorerUrl(proposal) {
    const info = getProposalNftInfo(proposal);
    if (!info) return null;
    const base = getExplorerBaseUrlForChain(info.chain);
    if (!base || !info.contract || !info.tokenId) return null;
    const chainStr = info.chain ? info.chain.toString() : '';
    if (chainStr.startsWith('solana')) {
        // Solana: tokenId is the PDA address, link to account view
        const cluster = chainStr.replace('solana-', '') || 'devnet';
        const suffix = cluster !== 'mainnet-beta' ? `?cluster=${cluster}` : '';
        return `${base}/address/${encodeURIComponent(info.tokenId)}${suffix}`;
    }
    return `${base}/token/${encodeURIComponent(info.contract)}?a=${encodeURIComponent(info.tokenId)}`;
}

function showMintedShareModal(proposal, mintedExplorerUrl) {
    const tShare = getShareI18nHelper();
    const tProposal = getProposalI18nHelper();
    const explorerUrl = mintedExplorerUrl || buildProposalNftExplorerUrl(proposal);
    const fallbackText = explorerUrl || tShare('noExplorer', 'Explorer link not available for this chain.');

    // Laid out by css/modals.css (.minted-share-*); the input and buttons are the shared controls.
    const body = document.createElement('div');
    body.className = 'minted-share-body';

    const infoText = document.createElement('p');
    infoText.textContent = tProposal('panel.proposal.lifecycle.minted', 'Minted');
    body.appendChild(infoText);

    const linkRow = document.createElement('div');
    linkRow.className = 'minted-share-link-row';

    const linkDisplay = document.createElement('input');
    linkDisplay.type = 'text';
    linkDisplay.readOnly = true;
    linkDisplay.value = fallbackText;
    linkDisplay.className = 'minted-share-link';
    linkDisplay.setAttribute('aria-label', tShare('copyUrlButton', 'Copy URL'));
    linkRow.appendChild(linkDisplay);

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'btn';
    copyButton.textContent = tShare('copyUrlButton', 'Copy URL');
    copyButton.addEventListener('click', async () => {
        const value = linkDisplay.value;
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(value);
            } else {
                linkDisplay.focus();
                linkDisplay.select();
                document.execCommand('copy');
            }
            copyButton.textContent = tShare('copySuccess', 'Copied!');
            setTimeout(() => {
                copyButton.textContent = tShare('copyUrlButton', 'Copy URL');
            }, 1200);
        } catch (err) {
            console.warn('Copy failed', err);
            linkDisplay.focus();
            linkDisplay.select();
        }
    });
    linkRow.appendChild(copyButton);

    if (explorerUrl) {
        const openButton = document.createElement('button');
        openButton.type = 'button';
        openButton.className = 'btn btn-primary';
        openButton.textContent = tShare('viewOnExplorer', 'View on Etherscan');
        openButton.addEventListener('click', () => {
            window.open(explorerUrl, '_blank', 'noopener,noreferrer');
        });
        linkRow.appendChild(openButton);
    }

    body.appendChild(linkRow);

    showSimpleShareModal({
        title: tShare('shareModalTitle', 'Share one proposal'),
        body
    });
}
