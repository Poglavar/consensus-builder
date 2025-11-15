(function () {
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    if (!globalScope) {
        return;
    }

    let contractsData = null;
    let loadPromise = null;

    /**
     * Loads contract addresses and ABIs from the exported contracts.json file
     * @returns {Promise<Object>} Object with structure: { chainId: { contractName: { address, abi } } }
     */
    async function loadContracts() {
        if (contractsData) {
            return contractsData;
        }

        if (loadPromise) {
            return loadPromise;
        }

        loadPromise = (async () => {
            try {
                const response = await fetch('/contracts/contracts.json');
                if (!response.ok) {
                    throw new Error(`Failed to load contracts.json: ${response.status} ${response.statusText}`);
                }
                contractsData = await response.json();
                return contractsData;
            } catch (error) {
                console.warn('Failed to load contracts.json, falling back to defaults:', error);
                // Return empty object as fallback
                return {};
            }
        })();

        return loadPromise;
    }

    /**
     * Gets the contract address for a given chainId and contract name
     * @param {string|number|bigint} chainId - The chain ID
     * @param {string} contractName - The contract name (e.g., 'ProposalNFT', 'ParcelNFT', 'CityMemeToken')
     * @returns {Promise<string|null>} The contract address or null if not found
     */
    async function getContractAddress(chainId, contractName) {
        const contracts = await loadContracts();
        const chainIdStr = normalizeChainId(chainId);
        
        if (!contracts[chainIdStr]) {
            return null;
        }

        const contract = contracts[chainIdStr][contractName];
        return contract ? contract.address : null;
    }

    /**
     * Gets the contract ABI for a given chainId and contract name
     * @param {string|number|bigint} chainId - The chain ID
     * @param {string} contractName - The contract name
     * @returns {Promise<Array|null>} The contract ABI or null if not found
     */
    async function getContractABI(chainId, contractName) {
        const contracts = await loadContracts();
        const chainIdStr = normalizeChainId(chainId);
        
        if (!contracts[chainIdStr]) {
            return null;
        }

        const contract = contracts[chainIdStr][contractName];
        return contract ? contract.abi : null;
    }

    /**
     * Gets all contract data for a given chainId
     * @param {string|number|bigint} chainId - The chain ID
     * @returns {Promise<Object|null>} Object with contractName -> { address, abi } or null if chain not found
     */
    async function getContractsForChain(chainId) {
        const contracts = await loadContracts();
        const chainIdStr = normalizeChainId(chainId);
        return contracts[chainIdStr] || null;
    }

    /**
     * Normalizes chainId to string format (decimal)
     * @param {string|number|bigint} chainId - The chain ID in any format
     * @returns {string} Normalized chain ID as decimal string
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
     * Preloads contracts data (useful for eager loading)
     */
    function preloadContracts() {
        return loadContracts();
    }

    globalScope.ContractsLoader = {
        loadContracts,
        getContractAddress,
        getContractABI,
        getContractsForChain,
        preloadContracts
    };
})();






