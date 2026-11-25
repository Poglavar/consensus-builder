// The retrievability gate before a mint (docs/blockchain-flows.md Flow 2): nothing is minted until a
// public IPFS gateway, not our backend, serves bytes that hash to each CID the mint will reference.
// Shared by the browser's agreement mint and the agents' mint (Node); fetching and waiting are
// injected, so the rounds are testable without a network or a clock.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ContentGate = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    // Public gateways, tried in order: Filebase (where the server pins) first, then two others.
    const IPFS_GATEWAYS = Object.freeze(['https://ipfs.filebase.io/ipfs/', 'https://gateway.pinata.cloud/ipfs/', 'https://ipfs.io/ipfs/']);
    // A pin is served by its provider's gateway at once; the other gateways can take a while to find it.
    const DEFAULT_ROUNDS = 24;
    const DEFAULT_INTERVAL_MS = 5000;
    const FETCH_TIMEOUT_MS = 15000;

    const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

    // Browser and Node 18+: bytes of a gateway answer, or null for any failure (the next gateway is tried).
    async function fetchBytes(url, fetchImpl = root.fetch) {
        try {
            const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined;
            const response = await fetchImpl(url, { cache: 'no-store', ...(signal ? { signal } : {}) });
            if (!response.ok) return null;
            return new Uint8Array(await response.arrayBuffer());
        } catch (_) {
            return null;
        }
    }

    /**
     * Resolves when every CID is served by some gateway with bytes that hash to it; throws
     * `content-not-retrievable` (with `missing`) after the last round. There is no "mint anyway".
     * @param {{ objects: {kind: string, cid: string}[], cidOf: (bytes: Uint8Array) => string,
     *   fetchBytes?: (url: string) => Promise<Uint8Array|null>, wait?: (ms: number) => Promise<void>,
     *   gateways?: string[], rounds?: number, intervalMs?: number,
     *   onProgress?: (progress: { confirmed: number, total: number, round: number, rounds: number }) => void }} options
     * @returns {Promise<{ confirmed: {kind, cid, gateway}[], rounds: number }>}
     */
    async function waitRetrievable({ objects, cidOf, fetchBytes: fetchOne = url => fetchBytes(url), wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
        gateways = IPFS_GATEWAYS, rounds = DEFAULT_ROUNDS, intervalMs = DEFAULT_INTERVAL_MS, onProgress = () => {} } = {}) {
        if (!Array.isArray(objects) || typeof cidOf !== 'function') throw new TypeError('waitRetrievable needs objects and cidOf');
        const pending = new Map(objects.map(object => [object.cid, object]));
        const confirmed = [];
        const total = pending.size;
        for (let round = 1; round <= rounds; round += 1) {
            for (const object of [...pending.values()]) {
                for (const gateway of gateways) {
                    const bytes = await fetchOne(gateway + object.cid);
                    let matches = false;
                    try { matches = !!bytes && cidOf(bytes) === object.cid; } catch (_) { matches = false; }
                    if (!matches) continue;
                    pending.delete(object.cid);
                    confirmed.push({ kind: object.kind, cid: object.cid, gateway });
                    break;
                }
            }
            onProgress({ confirmed: confirmed.length, total, round, rounds });
            if (!pending.size) return { confirmed, rounds: round };
            if (round < rounds) await wait(intervalMs);
        }
        const missing = [...pending.values()].map(({ kind, cid }) => ({ kind, cid }));
        throw failure('content-not-retrievable',
            `${missing.length} of ${total} object(s) are not yet served by a public IPFS gateway: ${missing.slice(0, 3).map(item => `${item.kind} ${item.cid}`).join(', ')}`,
            { missing });
    }

    return Object.freeze({ IPFS_GATEWAYS, DEFAULT_ROUNDS, DEFAULT_INTERVAL_MS, fetchBytes, waitRetrievable });
});
