(function () {
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    if (!globalScope) {
        return;
    }

    const PROPOSAL_ABI = [
        'function mintAndFund(address to, string[] parcelIds, bool isConditional, string imageURI, uint256 ethAmount, uint256 tokenAmount, address[] lens) payable returns (uint256)',
        'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
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

    async function resolveConfiguredAddress(chainId) {
        const variants = keyVariants(chainId);

        // First, try to load from the exported contracts.json file
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

    async function mintRoadProposal(options = {}) {
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

    globalScope.ProposalChainBridge = {
        isSupported() {
            return haveEthers();
        },
        async resolveContractAddress(chainId) {
            return await resolveConfiguredAddress(chainId);
        },
        formatParcelId,
        deriveParcelIdFromFeature,
        mintRoadProposal
    };
})();
