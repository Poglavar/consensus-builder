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

    async function uploadProposalAssets({ imageData, metadata, fileName }) {
        if (!imageData || typeof imageData !== 'string') {
            throw new Error('imageData is required for asset upload.');
        }
        if (!metadata || typeof metadata !== 'object') {
            throw new Error('metadata object is required for asset upload.');
        }

        const base = resolveBackendBase();
        const payload = { imageData, metadata, fileName };

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

    globalScope.AssetService = {
        uploadProposalAssets
    };

    globalScope.IPFSService = {
        uploadProposalAssets: uploadIPFSOnly
    };
})();

