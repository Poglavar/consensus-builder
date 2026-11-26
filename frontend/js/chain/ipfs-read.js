// ipfs-read.js — reads a published design, plan or agreement by its CID from public IPFS gateways,
// never trusting a gateway: the bytes must hash back to the CID (js/cid.js, CIDv1 raw or UnixFS
// dag-pb, as the pins are made). Our server is not among the gateways, so a reader works with our
// backend down (docs/blockchain-flows.md, Flow 1). window.IpfsRead; the same functions in node, with
// fetch injected.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root.document !== 'undefined') root.IpfsRead = Object.freeze(api);
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    // Tried in this order, one at a time. Filebase serves what the server's courier pins (Filebase is
    // its pinning provider) without a lookup in the public network; Pinata's gateway serves what a
    // sponsor pinned with their own Pinata key; the last two are the public network's. A deployment
    // may set window.IPFS_READ_GATEWAYS (an array of base URLs ending in /ipfs/) before this runs.
    const DEFAULT_GATEWAYS = Object.freeze([
        'https://ipfs.filebase.io/ipfs/',
        'https://gateway.pinata.cloud/ipfs/',
        'https://dweb.link/ipfs/',
        'https://ipfs.io/ipfs/'
    ]);
    // Per gateway. Filebase answered a pinned agreement in under a second and Pinata's public gateway
    // in about seven, while both held a request for a CID nobody pins for over 40 s and the public
    // two refused this host with HTTP 429 at once (measured 2026-11-26). So a CID held nowhere costs
    // up to one timeout per gateway before it is reported missing.
    const DEFAULT_TIMEOUT_MS = 10000;

    const cidApi = () => {
        const api = root.Cid || (typeof require === 'function' ? require('../cid.js') : null);
        if (!api) throw new Error('Cid (js/cid.js) is not loaded.');
        return api;
    };
    const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code }, extra);
    const warn = (message, extra) => console.warn(`[${new Date().toISOString()}] [IpfsRead] ${message}`, ...(extra === undefined ? [] : [extra]));

    // The gateways to try: the configured list when it names any, else the defaults; each ends in '/'.
    function gateways(configured = root && root.IPFS_READ_GATEWAYS) {
        const list = Array.isArray(configured) && configured.length ? configured : DEFAULT_GATEWAYS;
        return list.map(base => String(base).replace(/\/*$/, '/'));
    }

    /**
     * The bytes `cid` names, from the first gateway whose answer hashes to it.
     * Resolves { bytes, gateway }. Throws code 'invalid-cid', or 'ipfs-unavailable' with `attempts`
     * ([{ gateway, error }]) when no gateway returned them. A gateway that returned other bytes is
     * recorded as 'cid-mismatch' (with the CID its bytes have) and the next one is asked.
     */
    async function fetchBytes(cid, { gateways: list = gateways(), fetchImpl = root.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
        if (!cidApi().isCid(cid)) throw failure('invalid-cid', `Not a CID: ${cid}`);
        if (typeof fetchImpl !== 'function') throw failure('ipfs-unavailable', 'There is no fetch to read IPFS with.');
        const attempts = [];
        for (const gateway of list) {
            try {
                const response = await fetchImpl(`${gateway}${cid}`, { cache: 'force-cache', signal: AbortSignal.timeout(timeoutMs) });
                if (!response.ok) { attempts.push({ gateway, error: `HTTP ${response.status}` }); continue; }
                const bytes = new Uint8Array(await response.arrayBuffer());
                let computed;
                try { computed = cidApi().cidOf(bytes); } catch (error) { computed = `unhashable (${error.message})`; }
                if (computed !== cid) {
                    warn(`${gateway} answered ${cid} with bytes that are ${computed}`);
                    attempts.push({ gateway, error: 'cid-mismatch', computed });
                    continue;
                }
                return { bytes, gateway };
            } catch (error) {
                attempts.push({ gateway, error: (error && error.message) || String(error) });
            }
        }
        warn(`${cid} could not be read from any gateway`, attempts);
        throw failure('ipfs-unavailable', `${cid} could not be read from IPFS (${attempts.map(a => `${a.gateway}: ${a.error}`).join('; ')}).`, { attempts });
    }

    /**
     * The JSON object `cid` names, of `schema` when one is given. Resolves { cid, content, gateway }.
     * Throws code 'invalid-object' for bytes (already checked against the CID) that are not a JSON
     * object of that schema.
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
     * Several objects, `concurrency` at a time. Resolves { rows: Map(cid → { cid, content, gateway }),
     * missing: [{ cid, error }] }: one unreadable object does not fail the others.
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

    return { DEFAULT_GATEWAYS, DEFAULT_TIMEOUT_MS, gateways, fetchBytes, fetchObject, fetchObjects };
});
