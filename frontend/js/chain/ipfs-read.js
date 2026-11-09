// ipfs-read.js — reads a published design, plan or agreement by its CID from public IPFS gateways,
// never trusting the gateway: the bytes must hash back to the CID (blockchain-flows.md, Flow 1).
// The server is not one of the candidates, so a reader works with our backend down.
// window.IpfsRead; the same functions in node (fetch injected).
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root.document !== 'undefined') root.IpfsRead = Object.freeze(api);
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    // Tried in order. Filebase serves what our courier pins without a lookup in the public DHT; the
    // other two are the public network's. A deployment overrides them with IPFS_READ_GATEWAYS
    // (rpc-config.js), an array of base URLs ending in /ipfs/.
    const DEFAULT_GATEWAYS = Object.freeze(['https://ipfs.filebase.io/ipfs/', 'https://dweb.link/ipfs/', 'https://ipfs.io/ipfs/']);
    const DEFAULT_TIMEOUT_MS = 20000;

    const cidApi = () => {
        const api = root.Cid || (typeof require === 'function' ? require('../cid.js') : null);
        if (!api) throw new Error('Cid (js/cid.js) is not loaded.');
        return api;
    };
    const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code }, extra);

    function gateways(configured = root && root.IPFS_READ_GATEWAYS) {
        const list = Array.isArray(configured) && configured.length ? configured : DEFAULT_GATEWAYS;
        return list.map(base => String(base).replace(/\/*$/, '/'));
    }

    /**
     * The bytes `cid` names, from the first gateway that returns bytes hashing to it.
     * Resolves { bytes, gateway }. Throws code 'invalid-cid', or 'ipfs-unavailable' with `attempts`
     * ([{ gateway, error }]) when no gateway returned them; a gateway that returned other bytes is
     * recorded as 'cid-mismatch' and the next one is asked.
     */
    async function fetchBytes(cid, { gateways: list = gateways(), fetchImpl = root.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
        if (!cidApi().isCid(cid)) throw failure('invalid-cid', `Not a CID: ${cid}`);
        if (typeof fetchImpl !== 'function') throw failure('ipfs-unavailable', 'There is no fetch to read IPFS with.');
        const attempts = [];
        for (const gateway of list) {
            try {
                const response = await fetchImpl(`${gateway}${cid}`, { signal: AbortSignal.timeout(timeoutMs) });
                if (!response.ok) { attempts.push({ gateway, error: `HTTP ${response.status}` }); continue; }
                const bytes = new Uint8Array(await response.arrayBuffer());
                const computed = cidApi().cidOf(bytes);
                if (computed !== cid) {
                    console.warn(`[${new Date().toISOString()}] [IpfsRead] ${gateway} answered ${cid} with ${computed}`);
                    attempts.push({ gateway, error: 'cid-mismatch', computed });
                    continue;
                }
                return { bytes, gateway };
            } catch (error) {
                attempts.push({ gateway, error: (error && error.message) || String(error) });
            }
        }
        console.warn(`[${new Date().toISOString()}] [IpfsRead] ${cid} not retrievable`, attempts);
        throw failure('ipfs-unavailable', `${cid} could not be read from IPFS (${attempts.map(a => `${a.gateway}: ${a.error}`).join('; ')}).`, { attempts });
    }

    /**
     * The JSON object `cid` names, checked to be canonical and of `schema` when given.
     * Resolves { cid, content, gateway }. Throws code 'invalid-object' for bytes that are not the
     * canonical JSON of an object of that schema.
     */
    async function fetchObject(cid, { schema = null, ...options } = {}) {
        const { bytes, gateway } = await fetchBytes(cid, options);
        let content;
        try {
            content = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        } catch (_) {
            throw failure('invalid-object', `${cid} is not UTF-8 JSON.`);
        }
        if (!content || typeof content !== 'object' || Array.isArray(content)) throw failure('invalid-object', `${cid} is not a JSON object.`);
        if (schema && content.schema !== schema) throw failure('invalid-object', `${cid} is a ${content.schema || 'schemaless'} object, not ${schema}.`);
        return { cid, content, gateway };
    }

    /**
     * Several objects at once, `concurrency` at a time. Resolves { rows: Map(cid → { cid, content,
     * gateway }), missing: [{ cid, error }] }; one unreadable object does not fail the others.
     */
    async function fetchObjects(cids, { concurrency = 4, ...options } = {}) {
        const queue = Array.from(new Set(cids));
        const rows = new Map();
        const missing = [];
        async function worker() {
            while (queue.length) {
                const cid = queue.shift();
                try { rows.set(cid, await fetchObject(cid, options)); } catch (error) { missing.push({ cid, error }); }
            }
        }
        await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
        return { rows, missing };
    }

    return { DEFAULT_GATEWAYS, gateways, fetchBytes, fetchObject, fetchObjects };
});
