(function () {
    const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
    if (!globalScope) {
        return;
    }

    function resolveBackendBase() {
        let base = '';
        try {
            if (typeof window.getBackendBase === 'function') {
                base = window.getBackendBase();
            } else if (typeof window !== 'undefined' && window.location) {
                base = `${window.location.protocol}//${window.location.hostname}${window.location.port ? `:${window.location.port}` : ''}`;
            }
        } catch (_) { }
        if (!base) {
            base = 'http://localhost:3000';
        }
        if (base.endsWith('/')) {
            base = base.slice(0, -1);
        }
        return base;
    }

    async function uploadViaBackend(base, payload) {
        const response = await fetch(`${base}/assets/upload`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            let message = 'Failed to store assets on backend.';
            try {
                const errorBody = await response.json();
                if (errorBody && errorBody.error) {
                    message = errorBody.error;
                }
            } catch (_) { }
            throw new Error(message);
        }

        return response.json();
    }

    async function uploadViaIpfs(base, payload) {
        const response = await fetch(`${base}/ipfs/upload`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            let message = 'Failed to upload assets to IPFS.';
            try {
                const errorBody = await response.json();
                if (errorBody && errorBody.error) {
                    message = errorBody.error;
                }
            } catch (_) { }
            throw new Error(message);
        }

        return response.json();
    }

    async function uploadViaWalrus(base, payload) {
        const response = await fetch(`${base}/walrus/upload`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            let message = 'Failed to upload assets to Walrus.';
            try {
                const errorBody = await response.json();
                if (errorBody && errorBody.error) {
                    message = errorBody.error;
                }
            } catch (_) { }
            throw new Error(message);
        }

        const result = await response.json();
        logWalrusUpload(result);
        return result;
    }

    // Demo aid: print the Walrus blob URIs + clickable aggregator gateway links to the console
    // (we don't surface them in the UI), so an upload can be proven live during a demo.
    function logWalrusUpload(result) {
        if (!result) return;
        const agg = ((typeof globalScope.WALRUS_AGGREGATOR_URL === 'string' && globalScope.WALRUS_AGGREGATOR_URL)
            || 'https://aggregator.walrus-testnet.walrus.space').replace(/\/$/, '');
        const gateway = (uri) => (typeof uri === 'string' && uri.startsWith('walrus://'))
            ? `${agg}/v1/blobs/${uri.slice('walrus://'.length)}`
            : (uri || '');
        try {
            console.log('%c🦭 Stored on Walrus', 'font-weight:bold;color:#1fb6ff;font-size:13px');
            console.log('  metadata:', result.metadataUri, '→', result.metadataGatewayUrl || gateway(result.metadataUri));
            console.log('  image:   ', result.imageUri, '→', result.imageGatewayUrl || gateway(result.imageUri));
            if (result.suiObjectId) console.log('  Sui Blob object:', result.suiObjectId);
            console.log('  (open a gateway link above to view the stored data)');
        } catch (_) { }
    }

    const normalizeChainId = (value) => {
        if (value === null || value === undefined) return null;
        if (typeof value === 'bigint') return value.toString();
        if (typeof value === 'number') return String(Math.trunc(value));
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) return null;
            if (trimmed.startsWith('0x')) {
                try { return BigInt(trimmed).toString(); } catch (_) { return trimmed; }
            }
            return trimmed;
        }
        return String(value);
    };

    const isLocalChainId = (chainId) => {
        const normalized = normalizeChainId(chainId);
        if (!normalized) return false;
        return normalized === '31337' || normalized === '1337';
    };

    // Decide which storage backend to use. Order: explicit target -> configured default
    // (window.STORAGE_PROVIDER) -> legacy chain-id heuristic (remote chain => IPFS, else local).
    const resolveStorageProvider = (target, chainId) => {
        if (target === 'ipfs' || target === 'walrus') {
            return target;
        }
        if (target && target !== 'auto') {
            return 'local';
        }
        const configured = (typeof globalScope.STORAGE_PROVIDER === 'string')
            ? globalScope.STORAGE_PROVIDER.trim().toLowerCase()
            : '';
        if (configured === 'walrus' || configured === 'ipfs' || configured === 'local') {
            return configured;
        }
        const normalizedChainId = normalizeChainId(chainId);
        if (normalizedChainId && !isLocalChainId(normalizedChainId)) {
            return 'ipfs';
        }
        return 'local';
    };

    async function uploadProposalAssets({ imageData, metadata, fileName, chainId = null, target = 'auto' }) {
        if (!imageData || typeof imageData !== 'string') {
            throw new Error('imageData is required for asset upload.');
        }
        if (!metadata || typeof metadata !== 'object') {
            throw new Error('metadata object is required for asset upload.');
        }

        const base = resolveBackendBase();
        const payload = { imageData, metadata, fileName };

        const provider = resolveStorageProvider(target, chainId);

        // Walrus and IPFS are explicit decentralized targets: fail loudly rather than silently
        // storing on a different backend (which would yield an unexpected URI scheme).
        if (provider === 'walrus') {
            return uploadViaWalrus(base, payload);
        }
        if (provider === 'ipfs') {
            return uploadViaIpfs(base, payload);
        }

        // Default/local path: try backend first; if it fails, fall back to IPFS to avoid blocking minting
        try {
            return await uploadViaBackend(base, payload);
        } catch (backendError) {
            console.warn('Backend asset upload failed, attempting IPFS:', backendError);
            return uploadViaIpfs(base, payload);
        }
    }

    async function uploadIPFSOnly(params) {
        const base = resolveBackendBase();
        return uploadViaIpfs(base, params);
    }

    // Human-readable name of the storage backend that would be used, for status messages.
    function providerLabel(provider) {
        if (provider === 'walrus') return 'Walrus';
        if (provider === 'ipfs') return 'IPFS';
        if (provider === 'local') return 'storage';
        return 'decentralized storage';
    }

    function getStorageProviderLabel({ chainId = null, target = 'auto' } = {}) {
        return providerLabel(resolveStorageProvider(target, chainId));
    }

    globalScope.AssetService = {
        uploadProposalAssets,
        getStorageProviderLabel
    };
    globalScope.getStorageProviderLabel = getStorageProviderLabel;

    globalScope.IPFSService = {
        uploadProposalAssets: uploadIPFSOnly
    };
})();

