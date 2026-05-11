(function () {
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    if (!globalScope) {
        return;
    }

    const PROPOSAL_ABI = [
        'function mintAndFund(address to, string[] parcelIds, bool isConditional, string imageURI, uint256 ethAmount, uint256 tokenAmount, address[] lens) payable returns (uint256)',
        'function contributeFunds(uint256 proposalId, address tokenAddress, uint256 amount) payable',
        'function acceptProposal(uint256 proposalId, string parcelId, bytes32 ownerListUid, bytes32 claimUid, bytes32 endorsementUid)',
        'function withdrawAcceptance(uint256 proposalId, string parcelId, bytes32 ownerListUid, bytes32 claimUid, bytes32 endorsementUid)',
        'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
    ];

    const CITY_TOKEN_ABI = [
        'function decimals() public view returns (uint8)',
        'function allowance(address owner, address spender) public view returns (uint256)',
        'function approve(address spender, uint256 amount) public returns (bool)'
    ];

    const DEFAULT_ADDRESSES = {
        '84532': '0x6c3AdE19a8947bC4CC75B2AE3F2E25F4cBb23709',
        '0x14a34': '0x6c3AdE19a8947bC4CC75B2AE3F2E25F4cBb23709',
        'base-sepolia': '0x6c3AdE19a8947bC4CC75B2AE3F2E25F4cBb23709'
    };

    const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

    function haveEthers() {
        return Boolean(globalScope.ethers && globalScope.ethers.BrowserProvider && globalScope.ethers.Contract);
    }

    function keyVariants(chainIdInput) {
        const variants = new Set();
        if (typeof chainIdInput === 'bigint') {
            variants.add(chainIdInput.toString());
            const hexStr = chainIdInput.toString(16);
            variants.add('0x' + hexStr);
            variants.add('0x' + hexStr.toLowerCase());
            variants.add('0x' + hexStr.toUpperCase());
        } else if (typeof chainIdInput === 'number') {
            if (Number.isFinite(chainIdInput)) {
                const truncated = Math.trunc(chainIdInput);
                variants.add(String(truncated));
                const hexStr = truncated.toString(16);
                variants.add('0x' + hexStr);
                variants.add('0x' + hexStr.toLowerCase());
                variants.add('0x' + hexStr.toUpperCase());
            }
        } else if (typeof chainIdInput === 'string') {
            const trimmed = chainIdInput.trim();
            if (trimmed) {
                variants.add(trimmed);
                if (trimmed.startsWith('0x')) {
                    try {
                        const bigIntVal = BigInt(trimmed);
                        variants.add(bigIntVal.toString());
                        const hexStr = bigIntVal.toString(16);
                        variants.add('0x' + hexStr);
                        variants.add('0x' + hexStr.toLowerCase());
                        variants.add('0x' + hexStr.toUpperCase());
                    } catch (_) { }
                } else {
                    const parsed = Number(trimmed);
                    if (Number.isFinite(parsed)) {
                        const truncated = Math.trunc(parsed);
                        variants.add(String(truncated));
                        const hexStr = truncated.toString(16);
                        variants.add('0x' + hexStr);
                        variants.add('0x' + hexStr.toLowerCase());
                        variants.add('0x' + hexStr.toUpperCase());
                    }
                }
            }
        }
        variants.add('default');
        return Array.from(variants).map(value => value.toLowerCase()).filter(Boolean);
    }

    function normalizeChainIdValue(chainIdInput) {
        if (chainIdInput === undefined || chainIdInput === null) return null;
        try {
            if (typeof chainIdInput === 'bigint') {
                return chainIdInput.toString();
            }
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
                const asNumber = Number(trimmed);
                if (Number.isFinite(asNumber)) {
                    return Math.trunc(asNumber).toString();
                }
                return trimmed;
            }
        } catch (_) {
            return null;
        }
        return null;
    }

    function buildExplorerTxUrl(chainId, txHash) {
        if (!txHash) return null;
        const normalized = normalizeChainIdValue(chainId);
        let base = null;
        switch (normalized) {
            case '1':
                base = 'https://etherscan.io';
                break;
            case '11155111':
                base = 'https://sepolia.etherscan.io';
                break;
            case '8453':
                base = 'https://basescan.org';
                break;
            case '84532':
                base = 'https://sepolia.basescan.org';
                break;
            case '31337':
                base = null;
                break;
            default:
                base = null;
        }
        if (!base) return null;
        return `${base}/tx/${txHash}`;
    }

    async function resolveCityTokenAddress(chainId) {
        const normalized = normalizeChainIdValue(chainId);

        if (globalScope.ChainDataLoader && typeof globalScope.ChainDataLoader.resolveContractAddress === 'function') {
            try {
                const fromLoader = await globalScope.ChainDataLoader.resolveContractAddress(normalized, 'CityMemeToken');
                if (fromLoader) return fromLoader;
            } catch (err) {
                console.warn('ChainDataLoader city token lookup failed', err);
            }
        }

        if (globalScope.ContractsLoader && typeof globalScope.ContractsLoader.getContractAddress === 'function') {
            try {
                const fromContracts = await globalScope.ContractsLoader.getContractAddress(normalized, 'CityMemeToken');
                if (fromContracts) return fromContracts;
            } catch (err) {
                console.warn('ContractsLoader city token lookup failed', err);
            }
        }

        // Try addresses.json directly
        try {
            const resp = await fetch('/contracts/addresses.json');
            if (resp && resp.ok) {
                const data = await resp.json();
                if (data && data[normalized] && data[normalized].CityMemeToken) {
                    return data[normalized].CityMemeToken;
                }
            }
        } catch (err) {
            console.warn('addresses.json city token lookup failed', err);
        }

        return null;
    }

    const ZERO_BYTES32 = (globalScope.ethers && globalScope.ethers.ZeroHash)
        ? globalScope.ethers.ZeroHash
        : '0x0000000000000000000000000000000000000000000000000000000000000000';

    let addressesJsonCache = null;

    async function resolveAddressFromJson(chainId) {
        if (!addressesJsonCache) {
            try {
                const resp = await fetch('/contracts/addresses.json');
                if (resp && resp.ok) {
                    addressesJsonCache = await resp.json();
                }
            } catch (err) {
                console.warn('addresses.json lookup failed', err);
                addressesJsonCache = null;
            }
        }
        if (!addressesJsonCache || typeof addressesJsonCache !== 'object') return null;
        const variants = keyVariants(chainId);
        for (const key of variants) {
            const entry = addressesJsonCache[key];
            if (entry && entry.ProposalNFT) {
                return entry.ProposalNFT;
            }
        }
        return null;
    }

    async function resolveConfiguredAddress(chainId) {
        const variants = keyVariants(chainId);

        // 1) addresses.json override
        const jsonAddress = await resolveAddressFromJson(chainId);
        if (jsonAddress) {
            return jsonAddress;
        }

        // 2) ContractsLoader (contracts.json)
        if (globalScope.ContractsLoader && typeof globalScope.ContractsLoader.getContractAddress === 'function') {
            try {
                const address = await globalScope.ContractsLoader.getContractAddress(chainId, 'ProposalNFT');
                if (address) {
                    return address;
                }
            } catch (error) {
                console.warn('Failed to load contract address from ContractsLoader:', error);
            }
        }

        const directSources = [
            globalScope.PROPOSAL_NFT_ADDRESS,
            globalScope.proposalNftAddress,
            globalScope.envProposalNftAddress,
            globalScope.CONSENSUS_PROPOSAL_NFT_ADDRESS
        ].filter(value => typeof value === 'string' && value.trim().length > 0);
        if (directSources.length > 0) {
            return directSources[0];
        }

        const objectSources = [
            globalScope.CONSENSUS_CONTRACTS && globalScope.CONSENSUS_CONTRACTS.proposalNFT,
            globalScope.consensusContracts && globalScope.consensusContracts.proposalNFT
        ];
        for (const source of objectSources) {
            if (!source) continue;
            if (typeof source === 'string' && source.trim().length > 0) {
                return source;
            }
            if (typeof source === 'object') {
                for (const key of variants) {
                    if (source[key]) {
                        return source[key];
                    }
                }
            }
        }

        try {
            if (globalScope.PersistentStorage && typeof globalScope.PersistentStorage.getItem === 'function') {
                const stored = globalScope.PersistentStorage.getItem('proposal_nft_address')
                    || globalScope.PersistentStorage.getItem('proposalNFTAddress');
                if (stored) {
                    return stored;
                }
            }
        } catch (_) { }

        for (const key of variants) {
            if (DEFAULT_ADDRESSES[key]) {
                return DEFAULT_ADDRESSES[key];
            }
        }

        return null;
    }

    function formatParcelId(maticniBrojKo, brojCestice) {
        const municipality = maticniBrojKo !== undefined && maticniBrojKo !== null ? String(maticniBrojKo).trim() : '';
        const parcelNumber = brojCestice !== undefined && brojCestice !== null ? String(brojCestice).trim() : '';
        if (municipality && parcelNumber) {
            return `HR-${municipality}-${parcelNumber}`;
        }
        return null;
    }

    function deriveParcelIdFromFeature(feature) {
        if (!feature || !feature.properties) {
            return null;
        }
        const props = feature.properties;
        const direct = formatParcelId(props.MATICNI_BROJ_KO ?? props.maticni_broj_ko, props.BROJ_CESTICE ?? props.broj_cestice);
        if (direct) {
            return direct;
        }
        const fallbacks = [props.parcelId];
        for (const value of fallbacks) {
            if (value !== undefined && value !== null) {
                const str = String(value).trim();
                if (str.length > 0) {
                    return str;
                }
            }
        }
        return null;
    }

    function normalizeLensAddresses(rawLens = []) {
        try {
            const { getAddress } = globalScope.ethers || {};
            const cleaned = [];
            const seen = new Set();
            (rawLens || []).forEach(entry => {
                const addr = typeof entry === 'string'
                    ? entry
                    : (entry && (entry.address || entry.addr || entry.wallet || entry.value));
                if (!addr) return;
                try {
                    const checksummed = getAddress ? getAddress(addr) : addr;
                    const lower = checksummed.toLowerCase();
                    if (!seen.has(lower)) {
                        seen.add(lower);
                        cleaned.push(checksummed);
                    }
                } catch (_) {
                    // skip invalid address
                }
            });
            return cleaned;
        } catch (_) {
            return [];
        }
    }

    async function mintProposal(options = {}) {
        if (!haveEthers()) {
            throw new Error('Blockchain library is not available.');
        }
        if (!globalScope.walletManager || typeof globalScope.walletManager.getProvider !== 'function') {
            throw new Error('Wallet manager is not ready.');
        }

        const parcelIds = Array.isArray(options.parcelIds) ? options.parcelIds : [];
        const uniqueParcelIds = Array.from(new Set(parcelIds.map(id => (id !== undefined && id !== null) ? String(id).trim() : '').filter(Boolean)));
        if (uniqueParcelIds.length === 0) {
            throw new Error('No parcel identifiers provided for on-chain proposal.');
        }

        const provider = globalScope.walletManager.getProvider();
        if (!provider) {
            throw new Error('Connect a wallet to submit on-chain proposals.');
        }

        const { BrowserProvider, Contract, getAddress } = globalScope.ethers;
        const browserProvider = new BrowserProvider(provider);
        const signer = await browserProvider.getSigner();
        const network = await browserProvider.getNetwork();
        const chainId = network.chainId;
        const resolvedAddress = await resolveConfiguredAddress(chainId);
        if (!resolvedAddress) {
            const chainIdStr = typeof chainId === 'bigint' ? chainId.toString() : String(chainId);
            const chainIdHex = typeof chainId === 'bigint' ? '0x' + chainId.toString(16) : (typeof chainId === 'number' ? '0x' + chainId.toString(16) : chainId);
            const variants = keyVariants(chainId);
            console.warn('ProposalNFT address resolution failed:', {
                chainId: chainIdStr,
                chainIdHex: chainIdHex,
                chainIdType: typeof chainId,
                attemptedVariants: variants,
                availableDefaultAddresses: Object.keys(DEFAULT_ADDRESSES)
            });
            throw new Error(`ProposalNFT contract address is not configured for the current network (Chain ID: ${chainIdStr} / ${chainIdHex}). Please configure the contract address for this network or switch to a supported network.`);
        }

        let contractAddress;
        try {
            contractAddress = getAddress(resolvedAddress);
        } catch (_) {
            throw new Error('Configured ProposalNFT address is invalid.');
        }

        const deployedCode = await browserProvider.getCode(contractAddress);
        if (!deployedCode || deployedCode === '0x') {
            throw new Error('ProposalNFT contract not found on the connected network.');
        }

        const isConditional = Boolean(options.isConditional);
        const imageURI = typeof options.imageURI === 'string' ? options.imageURI : '';
        let ethAmountWei = 0n;
        if (options.ethAmountWei !== undefined && options.ethAmountWei !== null) {
            ethAmountWei = BigInt(options.ethAmountWei);
        } else if (options.ethAmount !== undefined && options.ethAmount !== null) {
            try {
                ethAmountWei = globalScope.ethers.parseEther(String(options.ethAmount));
            } catch (_) {
                throw new Error('Invalid ETH amount provided for proposal mint.');
            }
        }
        const tokenAmount = options.tokenAmount !== undefined && options.tokenAmount !== null ? BigInt(options.tokenAmount) : 0n;

        const contract = new Contract(contractAddress, PROPOSAL_ABI, signer);
        const recipient = await signer.getAddress();
        const lensAddresses = normalizeLensAddresses(options.lens);
        if (!lensAddresses.length) {
            throw new Error('Lens list is required for minting proposals on-chain.');
        }
        const args = [
            recipient,
            uniqueParcelIds,
            isConditional,
            imageURI,
            ethAmountWei,
            tokenAmount,
            lensAddresses
        ];

        // Pre-flight simulation to surface revert reasons (helps when estimateGas returns "missing revert data")
        try {
            await contract.mintAndFund.staticCall(...args, { value: ethAmountWei });
        } catch (error) {
            const friendlyReason = error?.reason || error?.shortMessage || error?.message;
            throw new Error(friendlyReason
                ? `On-chain mint simulation failed: ${friendlyReason}`
                : 'On-chain mint simulation failed: the ProposalNFT contract reverted. Check contract address, lens list, and funding amount.');
        }

        let tx;
        try {
            tx = await contract.mintAndFund(
                ...args,
                { value: ethAmountWei }
            );
            if (typeof options.onSubmitted === 'function') {
                try {
                    options.onSubmitted(tx);
                } catch (_) {
                    // Non-fatal; continue to wait for receipt
                }
            }
        } catch (error) {
            if (error && (error.code === 4001 || error.code === 'ACTION_REJECTED')) {
                throw new Error('Transaction rejected in wallet.');
            }
            const friendlyReason = error?.reason || error?.shortMessage || error?.message;
            if (!friendlyReason || /missing revert data/i.test(friendlyReason)) {
                throw new Error('On-chain mint failed: the configured ProposalNFT contract likely does not support minting on this network. Verify the contract address and that lens addresses and funding amounts are valid.');
            }
            throw new Error(friendlyReason);
        }

        const receipt = await tx.wait();
        const logs = Array.isArray(receipt?.logs) ? receipt.logs : [];
        const mintedLog = logs.find(log => {
            if (!log || !log.address || !Array.isArray(log.topics) || log.topics.length === 0) {
                return false;
            }
            if (log.address.toLowerCase() !== contractAddress.toLowerCase()) {
                return false;
            }
            return log.topics[0] && log.topics[0].toLowerCase() === TRANSFER_TOPIC;
        });

        let proposalId = null;
        if (mintedLog && mintedLog.topics && mintedLog.topics.length >= 4) {
            try {
                proposalId = BigInt(mintedLog.topics[3]).toString();
            } catch (_) {
                proposalId = null;
            }
        }

        return {
            transactionHash: receipt && receipt.hash ? receipt.hash : tx.hash,
            proposalId,
            chainId: network.chainId ? network.chainId.toString() : null,
            contractAddress,
            account: recipient,
            blockNumber: receipt ? receipt.blockNumber : null
        };
    }

    async function contributeToProposal(options = {}) {
        if (!haveEthers()) {
            throw new Error('Blockchain library is not available.');
        }
        if (!globalScope.walletManager || typeof globalScope.walletManager.getProvider !== 'function') {
            const err = new Error('Wallet manager is not ready.');
            err.code = 'WALLET_NOT_READY';
            throw err;
        }

        const provider = globalScope.walletManager.getProvider();
        if (!provider) {
            const err = new Error('Connect a wallet to boost proposals.');
            err.code = 'WALLET_NOT_CONNECTED';
            throw err;
        }

        const { BrowserProvider, Contract, ZeroAddress, getAddress, parseEther, parseUnits } = globalScope.ethers;
        const zeroAddress = ZeroAddress || '0x0000000000000000000000000000000000000000';
        const browserProvider = new BrowserProvider(provider);
        const signer = await browserProvider.getSigner();
        const network = await browserProvider.getNetwork();
        const walletChainId = normalizeChainIdValue(network.chainId);
        const targetChainId = normalizeChainIdValue(options.chainId || walletChainId);

        if (!targetChainId) {
            const err = new Error('Target network for boosting is missing.');
            err.code = 'CHAIN_ID_MISSING';
            throw err;
        }

        if (walletChainId && walletChainId !== targetChainId) {
            const err = new Error(`Wrong network. Switch to chain ${targetChainId}.`);
            err.code = 'WRONG_NETWORK';
            err.expectedChainId = targetChainId;
            err.walletChainId = walletChainId;
            throw err;
        }

        const resolvedAddress = options.contractAddress || await resolveConfiguredAddress(targetChainId);
        if (!resolvedAddress) {
            const err = new Error('ProposalNFT contract address is not configured for this network.');
            err.code = 'CONTRACT_MISSING';
            throw err;
        }

        let contractAddress;
        try {
            contractAddress = getAddress(resolvedAddress);
        } catch (_) {
            const err = new Error('Configured ProposalNFT address is invalid.');
            err.code = 'CONTRACT_INVALID';
            throw err;
        }

        const deployedCode = await browserProvider.getCode(contractAddress);
        if (!deployedCode || deployedCode === '0x') {
            const err = new Error('ProposalNFT contract not found on the connected network.');
            err.code = 'CONTRACT_NOT_FOUND';
            throw err;
        }

        if (options.proposalId === undefined || options.proposalId === null) {
            const err = new Error('Proposal id is required to boost on-chain.');
            err.code = 'PROPOSAL_ID_MISSING';
            throw err;
        }

        const currency = (options.currency || 'ETH').toUpperCase();
        const onStatus = (typeof options.onStatus === 'function') ? options.onStatus : null;
        const amountInput = options.amount;
        if (amountInput === undefined || amountInput === null) {
            const err = new Error('Boost amount is missing.');
            err.code = 'AMOUNT_MISSING';
            throw err;
        }

        let proposalIdArg;
        try {
            proposalIdArg = BigInt(options.proposalId);
        } catch (_) {
            proposalIdArg = options.proposalId;
        }

        const contract = new Contract(contractAddress, PROPOSAL_ABI, signer);
        let tx;
        let txHash = null;

        try {
            if (currency === 'ETH') {
                const amountWei = parseEther(String(amountInput));
                if (amountWei <= 0n) {
                    throw new Error('Amount must be greater than zero.');
                }
                if (onStatus) onStatus('transfer');
                tx = await contract.contributeFunds(proposalIdArg, zeroAddress, amountWei, { value: amountWei });
            } else if (currency === 'CITY') {
                const cityTokenAddress = options.cityTokenAddress || await resolveCityTokenAddress(targetChainId);
                if (!cityTokenAddress) {
                    const err = new Error('City token address not configured for this network.');
                    err.code = 'CITY_TOKEN_MISSING';
                    throw err;
                }

                const cityToken = new Contract(getAddress(cityTokenAddress), CITY_TOKEN_ABI, signer);
                let decimals = 18;
                try {
                    const rawDecimals = await cityToken.decimals();
                    const num = Number(rawDecimals);
                    if (Number.isFinite(num)) {
                        decimals = num;
                    }
                } catch (_) { /* default 18 */ }

                const amountUnits = parseUnits(String(amountInput), decimals);
                if (amountUnits <= 0n) {
                    throw new Error('Amount must be greater than zero.');
                }

                const contributor = await signer.getAddress();
                let allowance = 0n;
                try {
                    allowance = await cityToken.allowance(contributor, contractAddress);
                } catch (_) {
                    allowance = 0n;
                }
                if (allowance < amountUnits) {
                    if (onStatus) onStatus('approve');
                    const approveTx = await cityToken.approve(contractAddress, amountUnits);
                    try {
                        const approveReceipt = await approveTx.wait();
                        txHash = approveReceipt && approveReceipt.hash ? approveReceipt.hash : approveTx.hash;
                    } catch (approveErr) {
                        if (approveErr && (approveErr.code === 4001 || approveErr.code === 'ACTION_REJECTED')) {
                            const err = new Error('Approval rejected in wallet.');
                            err.code = 'USER_REJECTED';
                            throw err;
                        }
                        throw approveErr;
                    }
                }

                if (onStatus) onStatus('transfer');
                tx = await contract.contributeFunds(proposalIdArg, getAddress(cityTokenAddress), amountUnits);
            } else {
                const err = new Error(`Unsupported boost currency: ${currency}`);
                err.code = 'UNSUPPORTED_CURRENCY';
                throw err;
            }
        } catch (error) {
            if (error && (error.code === 4001 || error.code === 'ACTION_REJECTED')) {
                const err = new Error('Transaction rejected in wallet.');
                err.code = 'USER_REJECTED';
                throw err;
            }
            throw error;
        }

        const receipt = await tx.wait();
        const finalHash = receipt && receipt.hash ? receipt.hash : (tx && tx.hash ? tx.hash : txHash);

        return {
            transactionHash: finalHash,
            chainId: targetChainId,
            contractAddress,
            explorerUrl: buildExplorerTxUrl(targetChainId, finalHash)
        };
    }

    async function acceptProposalOnChain(options = {}) {
        if (!haveEthers()) {
            throw new Error('Blockchain library is not available.');
        }
        if (!globalScope.walletManager || typeof globalScope.walletManager.getProvider !== 'function') {
            const err = new Error('Wallet manager is not ready.');
            err.code = 'WALLET_NOT_READY';
            throw err;
        }

        const provider = globalScope.walletManager.getProvider();
        if (!provider) {
            const err = new Error('Connect a wallet to accept proposals on-chain.');
            err.code = 'WALLET_NOT_CONNECTED';
            throw err;
        }

        const { BrowserProvider, Contract, getAddress } = globalScope.ethers;
        const browserProvider = new BrowserProvider(provider);
        const signer = await browserProvider.getSigner();
        const network = await browserProvider.getNetwork();
        const walletChainId = normalizeChainIdValue(network.chainId);
        const targetChainId = normalizeChainIdValue(options.chainId || walletChainId);

        if (!targetChainId) {
            const err = new Error('Target network is missing for acceptance.');
            err.code = 'CHAIN_ID_MISSING';
            throw err;
        }

        if (walletChainId && targetChainId && walletChainId !== targetChainId) {
            const err = new Error(`Wrong network. Switch to chain ${targetChainId}.`);
            err.code = 'WRONG_NETWORK';
            err.expectedChainId = targetChainId;
            err.walletChainId = walletChainId;
            throw err;
        }

        const resolvedAddress = options.contractAddress || await resolveConfiguredAddress(targetChainId);
        if (!resolvedAddress) {
            const err = new Error('ProposalNFT contract address is not configured for this network.');
            err.code = 'CONTRACT_MISSING';
            throw err;
        }

        let contractAddress;
        try {
            contractAddress = getAddress(resolvedAddress);
        } catch (_) {
            const err = new Error('Configured ProposalNFT address is invalid.');
            err.code = 'CONTRACT_INVALID';
            throw err;
        }

        const deployedCode = await browserProvider.getCode(contractAddress);
        if (!deployedCode || deployedCode === '0x') {
            const err = new Error('ProposalNFT contract not found on the connected network.');
            err.code = 'CONTRACT_NOT_FOUND';
            throw err;
        }

        const parcelId = options.parcelId ? String(options.parcelId).trim() : '';
        if (!parcelId) {
            const err = new Error('Parcel id is required to accept on-chain.');
            err.code = 'PARCEL_ID_MISSING';
            throw err;
        }

        if (options.proposalId === undefined || options.proposalId === null) {
            const err = new Error('Proposal id is required to accept on-chain.');
            err.code = 'PROPOSAL_ID_MISSING';
            throw err;
        }

        let proposalIdArg;
        try {
            proposalIdArg = BigInt(options.proposalId);
        } catch (_) {
            proposalIdArg = options.proposalId;
        }

        const ownerListUid = options.ownerListUid || ZERO_BYTES32;
        const claimUid = options.claimUid || ZERO_BYTES32;
        const endorsementUid = options.endorsementUid || ZERO_BYTES32;

        const contract = new Contract(contractAddress, PROPOSAL_ABI, signer);
        let tx;
        try {
            tx = await contract.acceptProposal(proposalIdArg, parcelId, ownerListUid, claimUid, endorsementUid);
        } catch (error) {
            if (error && (error.code === 4001 || error.code === 'ACTION_REJECTED')) {
                const err = new Error('Transaction rejected in wallet.');
                err.code = 'USER_REJECTED';
                throw err;
            }
            throw error;
        }

        const receipt = await tx.wait();
        const finalHash = receipt && receipt.hash ? receipt.hash : (tx && tx.hash ? tx.hash : null);

        return {
            transactionHash: finalHash,
            chainId: targetChainId,
            contractAddress,
            explorerUrl: buildExplorerTxUrl(targetChainId, finalHash)
        };
    }

    async function withdrawAcceptanceOnChain(options = {}) {
        if (!haveEthers()) {
            throw new Error('Blockchain library is not available.');
        }
        if (!globalScope.walletManager || typeof globalScope.walletManager.getProvider !== 'function') {
            const err = new Error('Wallet manager is not ready.');
            err.code = 'WALLET_NOT_READY';
            throw err;
        }

        const provider = globalScope.walletManager.getProvider();
        if (!provider) {
            const err = new Error('Connect a wallet to undo on-chain acceptances.');
            err.code = 'WALLET_NOT_CONNECTED';
            throw err;
        }

        const { BrowserProvider, Contract, getAddress } = globalScope.ethers;
        const browserProvider = new BrowserProvider(provider);
        const signer = await browserProvider.getSigner();
        const network = await browserProvider.getNetwork();
        const walletChainId = normalizeChainIdValue(network.chainId);
        const targetChainId = normalizeChainIdValue(options.chainId || walletChainId);

        if (!targetChainId) {
            const err = new Error('Target network is missing for undo.');
            err.code = 'CHAIN_ID_MISSING';
            throw err;
        }

        if (walletChainId && targetChainId && walletChainId !== targetChainId) {
            const err = new Error(`Wrong network. Switch to chain ${targetChainId}.`);
            err.code = 'WRONG_NETWORK';
            err.expectedChainId = targetChainId;
            err.walletChainId = walletChainId;
            throw err;
        }

        const resolvedAddress = options.contractAddress || await resolveConfiguredAddress(targetChainId);
        if (!resolvedAddress) {
            const err = new Error('ProposalNFT contract address is not configured for this network.');
            err.code = 'CONTRACT_MISSING';
            throw err;
        }

        let contractAddress;
        try {
            contractAddress = getAddress(resolvedAddress);
        } catch (_) {
            const err = new Error('Configured ProposalNFT address is invalid.');
            err.code = 'CONTRACT_INVALID';
            throw err;
        }

        const deployedCode = await browserProvider.getCode(contractAddress);
        if (!deployedCode || deployedCode === '0x') {
            const err = new Error('ProposalNFT contract not found on the connected network.');
            err.code = 'CONTRACT_NOT_FOUND';
            throw err;
        }

        const parcelId = options.parcelId ? String(options.parcelId).trim() : '';
        if (!parcelId) {
            const err = new Error('Parcel id is required to undo on-chain.');
            err.code = 'PARCEL_ID_MISSING';
            throw err;
        }

        if (options.proposalId === undefined || options.proposalId === null) {
            const err = new Error('Proposal id is required to undo on-chain.');
            err.code = 'PROPOSAL_ID_MISSING';
            throw err;
        }

        let proposalIdArg;
        try {
            proposalIdArg = BigInt(options.proposalId);
        } catch (_) {
            proposalIdArg = options.proposalId;
        }

        const ownerListUid = options.ownerListUid || ZERO_BYTES32;
        const claimUid = options.claimUid || ZERO_BYTES32;
        const endorsementUid = options.endorsementUid || ZERO_BYTES32;

        const contract = new Contract(contractAddress, PROPOSAL_ABI, signer);
        let tx;
        try {
            tx = await contract.withdrawAcceptance(proposalIdArg, parcelId, ownerListUid, claimUid, endorsementUid);
        } catch (error) {
            if (error && (error.code === 4001 || error.code === 'ACTION_REJECTED')) {
                const err = new Error('Transaction rejected in wallet.');
                err.code = 'USER_REJECTED';
                throw err;
            }
            throw error;
        }

        const receipt = await tx.wait();
        const finalHash = receipt && receipt.hash ? receipt.hash : (tx && tx.hash ? tx.hash : null);

        return {
            transactionHash: finalHash,
            chainId: targetChainId,
            contractAddress,
            explorerUrl: buildExplorerTxUrl(targetChainId, finalHash)
        };
    }

    function isSolanaWalletConnected() {
        const wm = globalScope.solanaWalletManager;
        if (!wm || !wm.getState) return false;
        const s = wm.getState();
        return s && s.status === 'connected' && Array.isArray(s.accounts) && s.accounts.length > 0;
    }

    async function mintProposalWithRouting(options = {}) {
        if (isSolanaWalletConnected() && globalScope.SolanaProposalChainBridge && globalScope.SolanaProposalChainBridge.isSupported()) {
            return globalScope.SolanaProposalChainBridge.mintProposal(options);
        }
        return mintProposal(options);
    }

    async function contributeToProposalWithRouting(options = {}) {
        if (isSolanaWalletConnected() && globalScope.SolanaProposalChainBridge && globalScope.SolanaProposalChainBridge.isSupported()) {
            return globalScope.SolanaProposalChainBridge.contributeToProposal(options);
        }
        return contributeToProposal(options);
    }

    async function acceptProposalWithRouting(options = {}) {
        if (isSolanaWalletConnected() && globalScope.SolanaProposalChainBridge && globalScope.SolanaProposalChainBridge.isSupported()) {
            return globalScope.SolanaProposalChainBridge.acceptProposal(options);
        }
        return acceptProposalOnChain(options);
    }

    async function withdrawAcceptanceWithRouting(options = {}) {
        if (isSolanaWalletConnected() && globalScope.SolanaProposalChainBridge && globalScope.SolanaProposalChainBridge.isSupported()) {
            return globalScope.SolanaProposalChainBridge.withdrawAcceptance(options);
        }
        return withdrawAcceptanceOnChain(options);
    }

    async function distributeFundsWithRouting(options = {}) {
        if (isSolanaWalletConnected() && globalScope.SolanaProposalChainBridge && globalScope.SolanaProposalChainBridge.isSupported() && typeof globalScope.SolanaProposalChainBridge.distributeFunds === 'function') {
            return globalScope.SolanaProposalChainBridge.distributeFunds(options);
        }
        throw new Error('Proposal fund distribution is not supported for the connected EVM contract.');
    }

    async function cancelAndRefundWithRouting(options = {}) {
        if (isSolanaWalletConnected() && globalScope.SolanaProposalChainBridge && globalScope.SolanaProposalChainBridge.isSupported() && typeof globalScope.SolanaProposalChainBridge.cancelAndRefund === 'function') {
            return globalScope.SolanaProposalChainBridge.cancelAndRefund(options);
        }
        throw new Error('Proposal cancellation is not supported for the connected EVM contract.');
    }

    globalScope.ProposalChainBridge = {
        isSupported() {
            return haveEthers() || (globalScope.SolanaProposalChainBridge && globalScope.SolanaProposalChainBridge.isSupported());
        },
        async resolveContractAddress(chainId) {
            if (chainId === 'solana' && globalScope.SolanaProposalChainBridge) {
                return globalScope.SolanaProposalChainBridge.resolveProposalProgramId();
            }
            return await resolveConfiguredAddress(chainId);
        },
        formatParcelId,
        deriveParcelIdFromFeature,
        mintProposal: mintProposalWithRouting,
        contributeToProposal: contributeToProposalWithRouting,
        acceptProposal: acceptProposalWithRouting,
        withdrawAcceptance: withdrawAcceptanceWithRouting,
        distributeFunds: distributeFundsWithRouting,
        cancelAndRefund: cancelAndRefundWithRouting
    };
})();
