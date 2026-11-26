// read-source.js — where this browser reads published agreements, plans and designs from: our
// server's publication index ('server', the default), the chain ('chain': the agreement program's
// accounts on Solana devnet and public IPFS gateways, chain/chain-reader.js), or both ('both'). One
// explicit app-wide choice, kept in this browser (Settings → Read published records from, and the
// same choice above the Lists); a link's ?readFrom= applies to the page it opens without changing
// the kept choice. Nothing falls back from one source to the other: an error from a chosen source is
// reported as that source's. Publishing always goes to our server (docs/blockchain-flows.md, Flow 1).
// window.ReadSource; the pure helpers are exported for node.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root.document !== 'undefined') {
        const { browser, ...pure } = api;
        root.ReadSource = Object.freeze({ ...pure, ...browser(root) });
    }
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const SOURCES = Object.freeze(['server', 'chain', 'both']);
    const DEFAULT_SOURCE = 'server';
    const PARAM = 'readFrom';
    const STORAGE_KEY = 'cb.readFrom';

    const parse = value => (SOURCES.includes(value) ? value : null);
    const messageOf = error => (error && error.message) || String(error);

    // The choice in effect: a link's parameter, else the kept choice, else our server.
    function initial({ param = null, stored = null } = {}) {
        const linked = parse(param);
        return { source: linked || parse(stored) || DEFAULT_SOURCE, fromLink: !!linked };
    }

    // Whether the choice `source` reads `which` ('server' or 'chain').
    const readsFrom = (source, which) => source === which || source === 'both';

    // Both chosen sources failed: one error that names each one's reason (code 'read-failed').
    function bothFailed(serverError, chainError, labels = { server: 'Our server', chain: 'Chain' }) {
        return Object.assign(new Error(`${labels.server}: ${messageOf(serverError)} · ${labels.chain}: ${messageOf(chainError)}`),
            { code: 'read-failed', errors: { server: serverError, chain: chainError } });
    }

    /**
     * One object from the chosen source(s), marked `readFrom`. 'server' and 'chain' ask that source
     * alone and throw its own error unchanged. 'both' asks both at once and takes our server's answer
     * when it has one (it carries the index's binding and observations; equal CIDs are equal bytes),
     * else the chain's, keeping the server's failure as `readErrors.server` so it can be shown; when
     * both fail it throws bothFailed.
     * @param read { server: () => Promise<row>, chain: () => Promise<row> }
     */
    async function readOne(source, read, labels) {
        if (!parse(source)) throw new Error(`Unknown read source: ${source}`);
        if (source !== 'both') return { ...(await read[source]()), readFrom: source };
        const fromChain = Promise.resolve().then(read.chain);
        fromChain.catch(() => { /* not lost: awaited below when the server has no answer, and its error then reported */ });
        let serverError;
        try { return { ...(await read.server()), readFrom: 'server' }; } catch (error) { serverError = error; }
        try { return { ...(await fromChain), readFrom: 'chain', readErrors: { server: messageOf(serverError) } }; }
        catch (chainError) { throw bothFailed(serverError, chainError, labels); }
    }

    /**
     * The rows of several list feeds as one list, each record once with `heldBy`: the sources that
     * hold it. A record both hold is our server's (it carries the content) with the chain's account
     * state over the server's observation of it. A record held by one source keeps its identity, and
     * `memo` (a Map kept with the page) keeps a merged one's, so unchanged cards are not redrawn.
     * @param feeds [{ readFrom: 'server' | 'chain', rows: [{ cid, … }] }]
     * @returns [{ record, heldBy: ['server' | 'chain'] }]
     */
    function unionRows(feeds, memo = new Map()) {
        const byCid = new Map();
        for (const feed of feeds) {
            for (const record of feed.rows) {
                const entry = byCid.get(record.cid) || { records: {}, heldBy: [] };
                if (!entry.heldBy.includes(feed.readFrom)) entry.heldBy.push(feed.readFrom);
                entry.records[feed.readFrom] = entry.records[feed.readFrom] || record;
                byCid.set(record.cid, entry);
            }
        }
        return [...byCid.entries()].map(([cid, { records, heldBy }]) => {
            const { server, chain } = records;
            if (!server || !chain) return { record: server || chain, heldBy };
            const known = memo.get(cid);
            if (known && known.server === server && known.chain === chain) return { record: known.merged, heldBy };
            const onchain = chain.onchain ? { ...(server.onchain || {}), ...chain.onchain } : server.onchain ?? null;
            const merged = { ...chain, ...server, onchain };
            memo.set(cid, { server, chain, merged });
            return { record: merged, heldBy };
        });
    }

    function browser(win) {
        const log = message => console.info(`[${new Date().toISOString()}] [ReadSource] ${message}`);
        const warn = (message, extra) => console.warn(`[${new Date().toISOString()}] [ReadSource] ${message}`, ...(extra === undefined ? [] : [extra]));
        const t = (key, fallback, params = {}) => {
            const text = win.i18n && typeof win.i18n.t === 'function' ? win.i18n.t(key, params) : null;
            return text && text !== key ? text : fallback;
        };
        let stored = null, param = null;
        try { stored = win.localStorage.getItem(STORAGE_KEY); } catch (error) { warn('the kept choice could not be read; reading from our server', error); }
        try { param = new URLSearchParams(win.location.search).get(PARAM); } catch (_) { param = null; }
        let state = initial({ param, stored });
        if (param && !state.fromLink) warn(`?${PARAM}=${param} is not one of ${SOURCES.join(', ')}; it is ignored`);
        log(`reading published records from ${state.source}${state.fromLink ? ' (this link)' : ''}`);
        const listeners = new Set();

        const get = () => state.source;
        // The choice made here is kept in this browser and replaces a link's for this page. Listeners
        // hear of a new source, and of a link's choice becoming the kept one.
        function set(next) {
            const source = parse(next);
            if (!source) throw new Error(`Unknown read source: ${next}`);
            try { win.localStorage.setItem(STORAGE_KEY, source); } catch (error) { warn('the choice could not be kept in this browser; it holds for this page', error); }
            if (state.fromLink) {
                try {
                    const url = new URL(win.location.href);
                    url.searchParams.delete(PARAM);
                    win.history.replaceState(win.history.state, '', url.href);
                } catch (error) { warn('the link parameter could not be removed from the address', error); }
            }
            const changed = source !== state.source || state.fromLink;
            state = { source, fromLink: false };
            if (changed) {
                log(`now reading published records from ${source}, kept in this browser`);
                listeners.forEach(listener => {
                    try { listener(source); } catch (error) { console.error(`[${new Date().toISOString()}] [ReadSource] a listener failed`, error); }
                });
            }
            return source;
        }
        function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
        // The source's name as the person reads it: Our server, Chain, Both.
        const label = (source = state.source) => t(`readSource.${source}`, { server: 'Our server', chain: 'Chain', both: 'Both' }[source] || source);
        const read = request => readOne(state.source, request, { server: label('server'), chain: label('chain') });

        return { get, set, subscribe, label, read, fromLink: () => state.fromLink, reads: which => readsFrom(state.source, which),
            bothFailed: (serverError, chainError) => bothFailed(serverError, chainError, { server: label('server'), chain: label('chain') }) };
    }

    return { SOURCES, DEFAULT_SOURCE, PARAM, STORAGE_KEY, parse, initial, readsFrom, readOne, unionRows, browser };
});
