// proposals/chain.js — extracted from proposals.js (behavior-preserving relocation).

function isProposalMinted(proposal) {
    if (!proposal) return false;
    const flaggedMinted = proposal.isMinted === true;
    const hasOnchainTx = !!(proposal.onchain && proposal.onchain.transactionHash);
    const hasNft = !!getProposalNftInfo(proposal);
    const hasNumericNonLocalId = proposal.proposalId
        && !isLocalProposalId(proposal.proposalId)
        && /^[0-9]+$/.test(String(proposal.proposalId));
    return flaggedMinted || hasOnchainTx || hasNumericNonLocalId || hasNft;
}

// Can this proposal's geometry NEVER be rewritten by us? True for on-chain-minted proposals AND for
// server-uploaded ones: the server upload is a publication/commitment act — it stands in for the
// blockchain for people who don't mint, and once uploaded the record is shared and referenced, so we
// can't resync or change its data. The impact resolver keys mutability on THIS, not on isProposalMinted:
// an immutable proposal a road runs into can only be set aside (unapplied), tunnelled under, or the edit
// rerouted — never cut or reshaped. Only a purely local proposal (never uploaded) is ours to modify.
function isProposalImmutable(proposal) {
    if (!proposal) return false;
    if (isProposalMinted(proposal)) return true;
    return !!proposal.serverProposalId;
}

function buildChainProposalId(chainId, contractAddress, tokenId) {
    if (chainId === undefined || chainId === null || !contractAddress || tokenId === undefined || tokenId === null) {
        return null;
    }
    const normalizedChain = typeof normalizeChainId === 'function'
        ? normalizeChainId(chainId)
        : (chainId && chainId.toString ? chainId.toString() : String(chainId));
    const addressPart = contractAddress && contractAddress.toString ? contractAddress.toString().toLowerCase() : String(contractAddress).toLowerCase();
    const tokenPart = tokenId && tokenId.toString ? tokenId.toString() : String(tokenId);
    if (!normalizedChain || !addressPart || !tokenPart) {
        return null;
    }
    return `${normalizedChain}-${addressPart}-${tokenPart}`;
}

function walrusAggregatorBase() {
    const configured = (typeof window !== 'undefined' && typeof window.WALRUS_AGGREGATOR_URL === 'string')
        ? window.WALRUS_AGGREGATOR_URL.trim()
        : '';
    return (configured || 'https://aggregator.walrus-testnet.walrus.space').replace(/\/$/, '');
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

function buildGeometryMetadataPayload(sourceProposal) {
    if (!sourceProposal || typeof sourceProposal !== 'object') return null;
    const safeClone = (value) => {
        try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
    };

    const payload = {};
    const baseGeometry = safeClone(sourceProposal.geometry);
    if (baseGeometry && Object.keys(baseGeometry).length > 0) {
        payload.geometry = baseGeometry;
    }

    const childFeatures = safeClone(sourceProposal.childFeatures);
    if (Array.isArray(childFeatures) && childFeatures.length > 0) {
        payload.childFeatures = childFeatures;
    }

    const roadChildFeatures = safeClone(sourceProposal.roadProposal && sourceProposal.roadProposal.childFeatures);
    if (Array.isArray(roadChildFeatures) && roadChildFeatures.length > 0) {
        payload.roadChildFeatures = roadChildFeatures;
    }

    if (!Object.keys(payload).length) {
        return null;
    }

    try {
        payload.hash = hashStringDeterministic(JSON.stringify(payload));
    } catch (_) { /* best-effort */ }

    return payload;
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

function clearProposalBalanceWatcher() {
    if (typeof teardownProposalBalanceWatcher === 'function') {
        try { teardownProposalBalanceWatcher(); } catch (_) { }
    }
    teardownProposalBalanceWatcher = null;
    proposalBalanceRequestSeq++;
}

function getProposalBalanceChainContext() {
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    const walletManager = globalScope && globalScope.walletManager;
    const walletState = walletManager && typeof walletManager.getState === 'function' ? walletManager.getState() : null;
    let chainId = (walletState && walletState.chainId !== undefined && walletState.chainId !== null)
        ? walletState.chainId
        : null;
    if (!chainId && globalScope) {
        if (globalScope.DEFAULT_CHAIN_ID !== undefined && globalScope.DEFAULT_CHAIN_ID !== null) {
            chainId = globalScope.DEFAULT_CHAIN_ID;
        } else {
            const env = globalScope.current_environment || 'production';
            chainId = env === 'development' ? '31337' : '84532';
        }
    }
    const normalizedChainId = typeof normalizeChainIdValue === 'function'
        ? normalizeChainIdValue(chainId)
        : (chainId !== undefined && chainId !== null ? String(chainId) : null);
    const chainSlug = typeof resolveChainSlug === 'function'
        ? resolveChainSlug(normalizedChainId)
        : null;

    return { chainId: normalizedChainId, chainSlug, walletState, walletManager };
}

async function resolveErc20AddressForCurrency(currency, options = {}) {
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    const code = currency ? currency.toString().trim().toUpperCase() : '';
    if (!globalScope || !code) return null;

    const chainIdRaw = options.chainId || (options.walletState && options.walletState.chainId);
    const normalizedChainId = typeof normalizeChainIdValue === 'function'
        ? normalizeChainIdValue(chainIdRaw)
        : (chainIdRaw !== undefined && chainIdRaw !== null ? String(chainIdRaw) : null);
    const chainSlug = options.chainSlug || (typeof resolveChainSlug === 'function' ? resolveChainSlug(normalizedChainId) : null);
    const variants = new Set();

    const addVariant = (value) => {
        if (!value && value !== 0) return;
        const str = String(value).trim();
        if (str) {
            variants.add(str);
            variants.add(str.replace(/[^a-zA-Z0-9]/g, '_'));
        }
    };

    addVariant(chainSlug);
    if (normalizedChainId !== undefined && normalizedChainId !== null) {
        addVariant(normalizedChainId);
        const numeric = Number(normalizedChainId);
        if (Number.isFinite(numeric)) {
            const hex = '0x' + Math.trunc(numeric).toString(16);
            addVariant(hex);
            addVariant(hex.toUpperCase());
        }
    }

    // 1) ContractsLoader (contracts.json) if available
    if (globalScope.ContractsLoader && typeof globalScope.ContractsLoader.getContractAddress === 'function') {
        try {
            const addr = await globalScope.ContractsLoader.getContractAddress(normalizedChainId, code);
            if (addr) return addr;
        } catch (err) {
            console.warn('ContractsLoader token lookup failed', err);
        }
    }

    // 2) addresses.json fallback (same file used for other settings)
    try {
        const data = await loadAddressesJson();
        if (data && normalizedChainId && data[normalizedChainId] && data[normalizedChainId][code]) {
            return data[normalizedChainId][code];
        }
    } catch (err) {
        console.warn('addresses.json token lookup failed', err);
    }

    // 3) environment-like variables
    const keys = [];
    Array.from(variants).forEach(variant => {
        const cleaned = String(variant).replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
        if (cleaned) {
            keys.push(`${code}_ERC20_ADDRESS_${cleaned}`);
        }
    });

    for (const key of keys) {
        const value = readEnvLikeValue(key);
        if (value) return value;
    }

    // 4) global maps
    const maps = [
        globalScope.ERC20_ADDRESSES,
        globalScope.erc20Addresses,
        globalScope.tokenAddresses,
        globalScope.TOKEN_ADDRESSES
    ];
    for (const map of maps) {
        if (!map || typeof map !== 'object') continue;
        const entry = map[code] || map[code.toLowerCase()] || map[code.toUpperCase()];
        if (!entry) continue;
        if (typeof entry === 'string' && entry.trim()) {
            return entry.trim();
        }
        if (typeof entry === 'object') {
            for (const variant of variants) {
                const candidates = [
                    entry[variant],
                    entry[String(variant).toLowerCase()],
                    entry[String(variant).toUpperCase()],
                    entry[String(variant).replace(/[^a-zA-Z0-9]/g, '_')],
                    entry[String(variant).replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()]
                ];
                const found = candidates.find(value => typeof value === 'string' && value.trim());
                if (found) return found.trim();
            }
        }
    }

    return null;
}

function formatProposalBalanceText(key, params = {}) {
    const t = getProposalI18nHelper();
    const valueMap = {
        placeholder: t('modal.createProposal.balance.placeholder', '--'),
        notOnChain: t('modal.createProposal.balance.notOnChain', 'not on-chain'),
        connectWallet: t('modal.createProposal.balance.connectWallet', 'Connect wallet'),
        unavailable: t('modal.createProposal.balance.unavailable', 'unavailable'),
        missingTokenAddress: t('modal.createProposal.balance.missingTokenAddress', 'token address missing')
    };

    let value;
    if (key === 'value') {
        const amount = params.amount !== undefined && params.amount !== null ? String(params.amount) : '--';
        const currency = params.currency ? String(params.currency) : '';
        value = t('modal.createProposal.balance.value', '{{amount}} {{currency}}', { amount, currency: currency.trim() });
    } else {
        value = valueMap[key] || params.custom || valueMap.placeholder;
    }

    return t('modal.createProposal.balance.label', 'Balance: {{value}}', { value });
}

function ensureProposalOfferBalanceElement() {
    let hint = document.getElementById('proposalOfferBalanceHint');
    if (hint) return hint;
    const offerInput = document.getElementById('proposalOffer');
    const formGroup = offerInput ? offerInput.closest('.form-group') : null;
    if (!formGroup) return null;
    hint = document.createElement('div');
    hint.id = 'proposalOfferBalanceHint';
    hint.className = 'proposal-offer-balance';
    hint.textContent = formatProposalBalanceText('placeholder');
    formGroup.appendChild(hint);
    return hint;
}

async function refreshProposalBalanceDisplay() {
    const balanceEl = ensureProposalOfferBalanceElement();
    const currencySelect = document.getElementById('proposalCurrency');
    const currency = currencySelect && currencySelect.value ? currencySelect.value.toUpperCase() : 'USDT';
    if (!balanceEl) return;
    const requestId = ++proposalBalanceRequestSeq;
    const tBalance = (statusKey, valueParams = {}) => formatProposalBalanceText(statusKey, valueParams);
    const setText = (text) => {
        if (requestId === proposalBalanceRequestSeq && balanceEl) {
            balanceEl.textContent = text;
        }
    };

    if (!currency) {
        setText(tBalance('placeholder'));
        return;
    }

    if (['EUR', 'USD', 'ARS'].includes(currency)) {
        setText(tBalance('notOnChain'));
        return;
    }

    // Handle SOL balance via Solana wallet
    if (currency === 'SOL') {
        const solWmBal = window.solanaWalletManager;
        const solStateBal = solWmBal && typeof solWmBal.getState === 'function' ? solWmBal.getState() : null;
        const solAccount = solStateBal && Array.isArray(solStateBal.accounts) && solStateBal.accounts.length > 0
            ? solStateBal.accounts[0] : null;
        if (!solAccount || !window.solanaWeb3) {
            setText(tBalance('connectWallet'));
            return;
        }
        try {
            const cluster = solWmBal.getCluster ? solWmBal.getCluster() : 'devnet';
            const connection = window.SolanaChainDataLoader
                ? window.SolanaChainDataLoader.getConnection(cluster)
                : new window.solanaWeb3.Connection('https://api.devnet.solana.com', 'confirmed');
            const lamports = await connection.getBalance(new window.solanaWeb3.PublicKey(solAccount));
            const solAmount = lamports / 1e9;
            const valueText = solAmount.toLocaleString(undefined, { maximumFractionDigits: 4 });
            setText(tBalance('value', { amount: valueText, currency: 'SOL' }));
        } catch (solErr) {
            console.warn('Failed to fetch SOL balance', solErr);
            setText(tBalance('unavailable'));
        }
        return;
    }

    const { chainId, chainSlug, walletState, walletManager } = getProposalBalanceChainContext();
    const account = walletState && Array.isArray(walletState.accounts) && walletState.accounts.length > 0
        ? walletState.accounts[0]
        : null;

    if (!walletManager || !account || typeof walletManager.getProvider !== 'function') {
        setText(tBalance('connectWallet'));
        return;
    }
    const provider = walletManager.getProvider();
    if (!provider || !window.ethers || !window.ethers.BrowserProvider || !window.ethers.Contract) {
        setText(tBalance('unavailable'));
        return;
    }

    try {
        const browserProvider = new window.ethers.BrowserProvider(provider);

        if (currency === 'ETH') {
            const wei = await browserProvider.getBalance(account);
            const ethAmount = Number(window.ethers.formatEther(wei));
            const valueText = Number.isFinite(ethAmount)
                ? ethAmount.toLocaleString(undefined, { maximumFractionDigits: 4 })
                : window.ethers.formatEther(wei);
            setText(tBalance('value', { amount: valueText, currency: 'ETH' }));
            return;
        }

        const tokenAddress = await resolveErc20AddressForCurrency(currency, { chainId, chainSlug, walletState });
        if (!tokenAddress) {
            setText(tBalance('missingTokenAddress'));
            return;
        }

        const abi = [
            'function balanceOf(address) view returns (uint256)',
            'function decimals() view returns (uint8)'
        ];
        const contract = new window.ethers.Contract(tokenAddress, abi, browserProvider);
        const [rawBalance, decimals] = await Promise.all([
            contract.balanceOf(account),
            typeof contract.decimals === 'function' ? contract.decimals().catch(() => null) : Promise.resolve(null)
        ]);
        const decimalsNum = Number(decimals);
        const appliedDecimals = Number.isFinite(decimalsNum) && decimalsNum >= 0 ? decimalsNum : 18;
        const formatted = window.ethers.formatUnits(rawBalance, appliedDecimals);
        const numeric = Number(formatted);
        const pretty = Number.isFinite(numeric)
            ? numeric.toLocaleString(undefined, { maximumFractionDigits: 4 })
            : formatted;
        setText(tBalance('value', { amount: pretty, currency }));
    } catch (error) {
        console.warn('Failed to fetch proposal currency balance', { currency, error });
        setText(tBalance('unavailable'));
    }
}

function attachProposalCurrencyHandlers() {
    const currencySelect = document.getElementById('proposalCurrency');
    if (!currencySelect) {
        clearProposalBalanceWatcher();
        return;
    }

    clearProposalBalanceWatcher();

    // Adapt currency options for Solana: replace ETH with SOL
    const solWmCurr = window.solanaWalletManager;
    const solStateCurr = solWmCurr && typeof solWmCurr.getState === 'function' ? solWmCurr.getState() : null;
    const isSolanaCurr = solStateCurr && solStateCurr.status === 'connected'
        && Array.isArray(solStateCurr.accounts) && solStateCurr.accounts.length > 0;
    if (isSolanaCurr) {
        // Replace ETH option with SOL
        const ethOption = Array.from(currencySelect.options).find(opt => opt.value === 'ETH');
        if (ethOption) {
            ethOption.value = 'SOL';
            ethOption.textContent = 'SOL';
        } else {
            // Add SOL if ETH wasn't there
            const hasSol = Array.from(currencySelect.options).some(opt => opt.value === 'SOL');
            if (!hasSol) {
                const solOpt = document.createElement('option');
                solOpt.value = 'SOL';
                solOpt.textContent = 'SOL';
                currencySelect.insertBefore(solOpt, currencySelect.options[0]);
            }
        }
    }

    const hasUsdtOption = Array.from(currencySelect.options || []).some(opt => opt && opt.value === 'USDT');
    if (hasUsdtOption) {
        currencySelect.value = 'USDT';
    }

    const balanceEl = ensureProposalOfferBalanceElement();
    if (!balanceEl) return;

    const refreshBalance = () => refreshProposalBalanceDisplay();
    currencySelect.addEventListener('change', refreshBalance);

    const { walletManager } = getProposalBalanceChainContext();
    let detachWalletListeners = null;
    if (walletManager && typeof walletManager.on === 'function') {
        const offState = walletManager.on('stateChanged', refreshBalance);
        const offConnect = walletManager.on('connect', refreshBalance);
        const offDisconnect = walletManager.on('disconnect', refreshBalance);
        const offChain = walletManager.on('chainChanged', refreshBalance);
        const offAccounts = walletManager.on('accountsChanged', refreshBalance);
        detachWalletListeners = () => {
            offState && offState();
            offConnect && offConnect();
            offDisconnect && offDisconnect();
            offChain && offChain();
            offAccounts && offAccounts();
        };
    }

    teardownProposalBalanceWatcher = () => {
        currencySelect.removeEventListener('change', refreshBalance);
        if (typeof detachWalletListeners === 'function') {
            detachWalletListeners();
        }
        teardownProposalBalanceWatcher = null;
    };

    refreshBalance();
}

async function checkParcelsHaveNFTsSolana(parcelIds, chainId) {
    if (!parcelIds || parcelIds.length === 0) {
        return { allHaveNFTs: true, missingParcels: [], chainId, chainName: 'Solana' };
    }

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

async function showWalletNotConnectedModal() {
    return new Promise((resolve) => {
        const t = getProposalI18nHelper();
        setProposalModalDimmed(true);
        const overlay = document.createElement('div');
        overlay.className = 'cb-confirm-overlay';
        // Ensure this modal sits above the create proposal modal
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.zIndex = '30000';

        const dialog = document.createElement('div');
        dialog.className = 'cb-confirm-dialog';
        dialog.style.maxWidth = '600px';
        dialog.style.zIndex = '30001';

        const message = document.createElement('div');
        message.className = 'cb-confirm-message';
        message.style.marginBottom = '20px';

        const introMessage = t(
            'modal.createProposal.walletNotConnected.message',
            'You are not connected with a wallet, so you can\'t mint proposals on chain.'
        );
        const proceedPrompt = t(
            'modal.createProposal.walletNotConnected.proceedQuestion',
            'Proceed to create an in-memory proposal?'
        );

        message.innerHTML = `
            <p style="margin-bottom: 12px;">${introMessage}</p>
            <p style="margin-top: 12px;">${proceedPrompt}</p>
        `;

        const buttons = document.createElement('div');
        buttons.className = 'cb-confirm-buttons';
        buttons.style.display = 'flex';
        buttons.style.gap = '10px';
        buttons.style.justifyContent = 'flex-end';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn btn-secondary';
        cancelBtn.textContent = t('modal.createProposal.walletNotConnected.cancel', 'Cancel');

        const createBtn = document.createElement('button');
        createBtn.type = 'button';
        createBtn.className = 'btn btn-action';
        createBtn.textContent = t('modal.createProposal.walletNotConnected.confirm', 'Create');

        function cleanup(result) {
            if (overlay && overlay.parentNode) {
                overlay.parentNode.removeChild(overlay);
            }
            setProposalModalDimmed(false);
            resolve(result);
        }

        cancelBtn.addEventListener('click', () => cleanup(false));
        createBtn.addEventListener('click', () => cleanup(true));
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                cleanup(false);
            }
        });

        buttons.appendChild(cancelBtn);
        buttons.appendChild(createBtn);
        dialog.appendChild(message);
        dialog.appendChild(buttons);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    });
}

async function showOnchainMintFailedModal(reason) {
    return new Promise((resolve) => {
        const t = getProposalI18nHelper();
        setProposalModalDimmed(true);

        const overlay = document.createElement('div');
        overlay.className = 'cb-confirm-overlay';
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.zIndex = '50010';
        overlay.style.background = 'rgba(15, 23, 42, 0.45)';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';

        const dialog = document.createElement('div');
        dialog.className = 'cb-confirm-dialog';
        dialog.style.maxWidth = '620px';
        dialog.style.position = 'relative';
        dialog.style.zIndex = '50011';

        const message = document.createElement('div');
        message.className = 'cb-confirm-message';
        message.style.marginBottom = '16px';
        message.textContent = t('modal.createProposal.onchainMintFailed.message', 'On-chain mint failed for reason:');

        const reasonBox = document.createElement('div');
        reasonBox.style.background = '#fff7ed';
        reasonBox.style.border = '1px solid #fdba74';
        reasonBox.style.color = '#7c2d12';
        reasonBox.style.padding = '12px';
        reasonBox.style.borderRadius = '6px';
        reasonBox.style.fontFamily = 'monospace';
        reasonBox.style.fontSize = '12px';
        reasonBox.style.marginBottom = '18px';
        reasonBox.textContent = reason && reason.toString ? reason.toString() : t('modal.createProposal.onchainMintFailed.unknown', 'Unknown error');

        const buttons = document.createElement('div');
        buttons.className = 'cb-confirm-buttons';
        buttons.style.display = 'flex';
        buttons.style.gap = '10px';
        buttons.style.justifyContent = 'flex-end';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn btn-secondary';
        cancelBtn.textContent = t('modal.createProposal.onchainMintFailed.cancel', 'Cancel');

        const createInMemoryBtn = document.createElement('button');
        createInMemoryBtn.type = 'button';
        createInMemoryBtn.className = 'btn btn-action';
        createInMemoryBtn.textContent = t('modal.createProposal.onchainMintFailed.createInMemory', 'Create in memory');

        function cleanup(result) {
            if (overlay && overlay.parentNode) {
                overlay.parentNode.removeChild(overlay);
            }
            setProposalModalDimmed(false);
            resolve(result);
        }

        cancelBtn.addEventListener('click', () => cleanup('cancel'));
        createInMemoryBtn.addEventListener('click', () => cleanup('memory'));
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                cleanup('cancel');
            }
        });

        buttons.appendChild(cancelBtn);
        buttons.appendChild(createInMemoryBtn);
        dialog.appendChild(message);
        dialog.appendChild(reasonBox);
        dialog.appendChild(buttons);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    });
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
            parentParcelIds: Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds : [],
            isConditional: proposal.isConditional === true,
            imageURI: proposal.imageURI || proposal.onchain?.imageURI || metadataUrl,
            acceptancePossible: proposal.acceptancePossible !== false,
            status: proposal.status || 'Active',
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

function formatCurrencyMetric(value) {
    if (!Number.isFinite(value) || value <= 0) {
        return '—';
    }
    return `€${Math.round(value).toLocaleString('hr-HR')}`;
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

function showProposalMintSuccessModal({ proposalId, txHash, chainId, onClose }) {
    try {
        const existing = document.getElementById('proposal-mint-success-modal');
        if (existing && existing.parentNode) {
            existing.parentNode.removeChild(existing);
        }

        const overlay = document.createElement('div');
        overlay.id = 'proposal-mint-success-modal';
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.background = 'rgba(0,0,0,0.45)';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.zIndex = '12000';

        const card = document.createElement('div');
        card.style.background = '#fff';
        card.style.borderRadius = '12px';
        card.style.padding = '20px 24px';
        card.style.maxWidth = '340px';
        card.style.width = '90%';
        card.style.boxShadow = '0 10px 30px rgba(0,0,0,0.2)';
        card.style.fontFamily = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

        const title = document.createElement('h3');
        title.textContent = 'Success!';
        title.style.margin = '0 0 8px 0';
        title.style.fontSize = '20px';
        title.style.fontWeight = '700';
        card.appendChild(title);

        const body = document.createElement('p');
        const label = proposalId ? `Proposal ${proposalId}` : 'Proposal';
        body.textContent = `${label} has been minted!`;
        body.style.margin = '0 0 12px 0';
        body.style.fontSize = '14px';
        card.appendChild(body);

        const buttons = document.createElement('div');
        buttons.style.display = 'flex';
        buttons.style.flexDirection = 'column';
        buttons.style.gap = '10px';
        buttons.style.marginTop = '12px';

        const explorerBase = getExplorerBaseUrlForChain(chainId);
        const hasExplorer = explorerBase && txHash;
        const isSolana = typeof chainId === 'string' && chainId.startsWith('solana');
        const viewBtn = document.createElement('button');
        viewBtn.textContent = hasExplorer ? (isSolana ? 'View on Solana Explorer' : 'View on Etherscan') : 'View transaction';
        viewBtn.style.padding = '10px 12px';
        viewBtn.style.border = '1px solid #0d3b66';
        viewBtn.style.borderRadius = '8px';
        viewBtn.style.background = hasExplorer ? '#0d3b66' : '#cbd5e0';
        viewBtn.style.color = '#fff';
        viewBtn.style.cursor = hasExplorer ? 'pointer' : 'not-allowed';
        viewBtn.disabled = !hasExplorer;
        viewBtn.style.width = '100%';
        if (hasExplorer) {
            viewBtn.addEventListener('click', () => {
                let url;
                if (isSolana) {
                    const cluster = chainId.replace('solana-', '');
                    url = cluster === 'mainnet-beta'
                        ? `${explorerBase}/tx/${txHash}`
                        : `${explorerBase}/tx/${txHash}?cluster=${cluster}`;
                } else {
                    url = `${explorerBase}/tx/${txHash}`;
                }
                window.open(url, '_blank', 'noopener,noreferrer');
            });
        }

        const okBtn = document.createElement('button');
        okBtn.textContent = 'OK';
        okBtn.style.padding = '10px 12px';
        okBtn.style.border = 'none';
        okBtn.style.borderRadius = '8px';
        okBtn.style.background = '#0d3b66';
        okBtn.style.color = '#fff';
        okBtn.style.cursor = 'pointer';
        okBtn.style.width = '100%';
        okBtn.addEventListener('click', () => {
            if (overlay.parentNode) {
                overlay.parentNode.removeChild(overlay);
            }
            if (typeof onClose === 'function') {
                try {
                    onClose();
                } catch (_) { }
            } else if (proposalId && typeof showProposalDetailsModal === 'function') {
                try {
                    showProposalDetailsModal(proposalId);
                } catch (_) { }
            }
        });

        buttons.appendChild(viewBtn);
        buttons.appendChild(okBtn);
        card.appendChild(buttons);
        overlay.appendChild(card);
        document.body.appendChild(overlay);
    } catch (err) {
        console.warn('Failed to show proposal mint success modal:', err);
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

    const body = document.createElement('div');
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    body.style.gap = '12px';

    const infoText = document.createElement('p');
    infoText.textContent = tProposal('panel.proposal.lifecycle.minted', 'Minted');
    infoText.style.margin = '0';
    body.appendChild(infoText);

    const linkRow = document.createElement('div');
    linkRow.style.display = 'flex';
    linkRow.style.gap = '8px';
    linkRow.style.alignItems = 'center';

    const linkDisplay = document.createElement('input');
    linkDisplay.type = 'text';
    linkDisplay.readOnly = true;
    linkDisplay.value = fallbackText;
    linkDisplay.style.flex = '1';
    linkDisplay.style.padding = '8px 10px';
    linkDisplay.style.border = '1px solid #d8ddf0';
    linkDisplay.style.borderRadius = '8px';
    linkDisplay.style.fontSize = '13px';
    linkDisplay.style.background = '#f7f8fb';
    linkDisplay.style.color = '#212744';
    linkRow.appendChild(linkDisplay);

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'btn share-modal-secondary';
    copyButton.textContent = tShare('copyUrlButton', 'Copy URL');
    copyButton.style.whiteSpace = 'nowrap';
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
        openButton.className = 'btn share-modal-primary';
        openButton.textContent = tShare('viewOnExplorer', 'View on Etherscan');
        openButton.style.whiteSpace = 'nowrap';
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
