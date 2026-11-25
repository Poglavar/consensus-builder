// Pinning with the sponsor's own provider key (docs/blockchain-flows.md Flow 2, courier 2), used when
// our server cannot pin an agreement's content before its mint. The key is a Pinata JWT the person
// scopes to pinning; it is sent only to Pinata and, if they choose, remembered in this browser only.
// Each object is pinned as one file with CIDv1 (the app's fixed UnixFS profile) and counts only when
// Pinata answers exactly the CID the object hashes to. Shared by the browser and agents (Node).
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.IpfsOwnKey = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const PINATA_PIN_FILE = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
    const STORAGE_KEY = 'cb_own_pinata_jwt';
    const PIN_TIMEOUT_MS = 60000;

    const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

    /**
     * Pins each object's canonical bytes with the given Pinata JWT, in order.
     * @param {{ objects: {kind: string, cid: string, bytes: Uint8Array}[], jwt: string, fetchImpl?: Function,
     *   onProgress?: (progress: { pinned: number, total: number }) => void }} options
     * @returns {Promise<{ pinned: {kind, cid}[] }>}
     */
    async function pinWithPinata({ objects, jwt, fetchImpl = root.fetch, onProgress = () => {} }) {
        const key = typeof jwt === 'string' ? jwt.trim() : '';
        if (!key) throw failure('own-key-missing', 'A Pinata key is required.');
        const pinned = [];
        for (const object of objects) {
            const body = new FormData();
            body.append('file', new Blob([object.bytes], { type: 'application/json' }), `${object.kind}-${object.cid}.json`);
            body.append('pinataMetadata', JSON.stringify({ name: `${object.kind}-${object.cid}` }));
            body.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));
            let response;
            try {
                const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(PIN_TIMEOUT_MS) : undefined;
                response = await fetchImpl(PINATA_PIN_FILE, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body, ...(signal ? { signal } : {}) });
            } catch (error) {
                throw failure('own-key-unreachable', `Pinata could not be reached: ${error.message}`);
            }
            if (response.status === 401 || response.status === 403) {
                throw failure('own-key-refused', `Pinata refused the key (HTTP ${response.status}).`, { status: response.status });
            }
            if (!response.ok) throw failure('own-key-pin-failed', `Pinata answered HTTP ${response.status}.`, { status: response.status });
            let result = null;
            try { result = await response.json(); } catch (_) { result = null; }
            if (result?.IpfsHash !== object.cid) {
                throw failure('cid-mismatch', `Pinata pinned ${object.kind} ${object.cid} as ${result?.IpfsHash ?? 'nothing'}.`, { cid: object.cid, pinnedCid: result?.IpfsHash ?? null });
            }
            pinned.push({ kind: object.kind, cid: object.cid });
            onProgress({ pinned: pinned.length, total: objects.length });
        }
        return { pinned };
    }

    // The remembered key of this browser, or null; storage failures (private windows) read as none.
    function rememberedKey(storage = root.localStorage) {
        try { return storage?.getItem(STORAGE_KEY) || null; } catch (_) { return null; }
    }

    // Remembers the key in this browser, or forgets it with null.
    function rememberKey(jwt, storage = root.localStorage) {
        try {
            if (jwt) storage?.setItem(STORAGE_KEY, jwt);
            else storage?.removeItem(STORAGE_KEY);
        } catch (_) { /* nothing is remembered where storage is unavailable */ }
    }

    return Object.freeze({ PINATA_PIN_FILE, STORAGE_KEY, pinWithPinata, rememberedKey, rememberKey });
});
