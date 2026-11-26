// chain-reader.js — the chain and IPFS as a source of published agreements, plans and designs
// (docs/blockchain-flows.md, Flow 1): agreements listed from the agreement program's accounts on
// Solana devnet, their agreement, plan and design objects read from public IPFS gateways and checked
// against their CIDs (ipfs-read.js), and each agreement's chain state read from its account. Nothing
// here asks our server, so a minted agreement opens while the backend is down. The loaders that ask
// the server's index first (AgreementSync, NamedPlans, DesignSync) fall back to these reads.
// window.ChainReader; the pure helpers are exported for node.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root.document !== 'undefined') {
        const { browser, ...pure } = api;
        root.ChainReader = Object.freeze({ ...pure, ...browser(root) });
    }
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    // The agreement program is deployed on devnet only (solana/agreement-client.js constants), and its
    // reads go through the genesis-checked devnet connection, as funding and market reads do.
    const CLUSTER = 'devnet';

    const log = message => console.info(`[${new Date().toISOString()}] [ChainReader] ${message}`);
    const warn = (message, extra) => console.warn(`[${new Date().toISOString()}] [ChainReader] ${message}`, ...(extra === undefined ? [] : [extra]));
    const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code }, extra);
    const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

    /**
     * The server's answer, or, when it fails (unreachable, or it does not hold the object), the
     * chain/IPFS one. When both fail, the server's error is thrown with the fallback's attached as
     * `fallbackError`, so the person sees the familiar message and the log has both.
     */
    async function withFallback(label, primary, fallback) {
        try {
            return await primary();
        } catch (error) {
            log(`${label}: the server did not answer (${(error && error.message) || error}); reading IPFS`);
            try {
                return await fallback();
            } catch (fallbackError) {
                warn(`${label}: IPFS did not answer either`, fallbackError);
                if (error && typeof error === 'object') error.fallbackError = fallbackError;
                throw error;
            }
        }
    }

    /**
     * A decoded Agreement account (AgreementClient.readAgreement) as the agreement's `onchain`: where
     * it is minted, its sponsor, and its status and decision in the index's lower-case spelling of the
     * codec's names ('active', 'satisfied'). `observedAt` is the reader's clock when it read the
     * account: an observation time, never an event time. The agreement panel reads the rest of the
     * account itself from `cluster` and `account`.
     */
    function onchainOf(account, { cluster = CLUSTER, programId, observedAt }) {
        return {
            chain: 'solana',
            cluster,
            programId,
            account: account.address,
            sponsor: account.authority,
            status: String(account.status).toLowerCase(),
            decision: String(account.decision).toLowerCase(),
            observedAt
        };
    }

    // A list row for an agreement account: its CID, when the chain says it was created (the
    // account's own created_at), and its `onchain`. Titles are the content's, read when it is opened.
    function chainRowOf(account, options) {
        return {
            cid: account.cid,
            createdAt: account.createdAt ? new Date(account.createdAt * 1000).toISOString() : null,
            onchain: onchainOf(account, options),
            source: 'chain'
        };
    }

    // An agreement/v1 object read from IPFS must name its plan by CID, as the index requires.
    function agreementContentError(content, cidApi) {
        if (!isObject(content)) return 'is not an object';
        if (!cidApi.isCid(content.planCid)) return 'names no plan CID';
        if (Object.hasOwn(content, 'designs') || Object.hasOwn(content, 'designCids')) return 'lists designs instead of a plan';
        return null;
    }

    function browser(win) {
        const ipfs = () => {
            if (!win.IpfsRead) throw new Error('IpfsRead (js/chain/ipfs-read.js) is not loaded.');
            return win.IpfsRead;
        };
        // This window's fetch and configured gateways (IPFS_READ_GATEWAYS, else the defaults).
        const reading = schema => ({ schema, gateways: ipfs().gateways(win.IPFS_READ_GATEWAYS), fetchImpl: (url, init) => win.fetch(url, init) });
        const client = () => {
            if (!win.AgreementClient) throw new Error('AgreementClient (js/solana/agreement-client.js) is not loaded.');
            return win.AgreementClient;
        };
        const programId = () => client().constants.AGREEMENT_PROGRAM_ID;
        const cluster = () => CLUSTER;

        async function connection() {
            if (!win.solanaWeb3?.Connection && typeof win.ensureWalletVendors === 'function') await win.ensureWalletVendors();
            if (!win.solanaWeb3?.Connection || !win.SolanaChainDataLoader?.getVerifiedConnection) {
                throw failure('web3-unavailable', 'The Solana library could not be loaded.');
            }
            return win.SolanaChainDataLoader.getVerifiedConnection(CLUSTER);
        }

        // Every agreement account of the program, newest first, as list rows (chainRowOf).
        async function listAgreements() {
            const started = Date.now();
            const accounts = await client().listAgreements(await connection(), { programId: programId() });
            const observedAt = new Date().toISOString();
            log(`${accounts.length} agreement account(s) on ${CLUSTER} in ${Date.now() - started} ms`);
            return accounts.map(account => chainRowOf(account, { programId: programId(), observedAt }));
        }

        // The `onchain` of the agreement `cid` sponsored by `sponsor`, or null when it is not minted.
        async function agreementOnchain(cid, sponsor) {
            if (!sponsor) return null;
            const account = await client().fetchAgreement(await connection(), { cid, authority: sponsor, programId: programId() });
            return account ? onchainOf(account, { programId: programId(), observedAt: new Date().toISOString() }) : null;
        }

        // A plan/v1 object from IPFS, in the shape GET /plans/:cid answers ({ cid, content }).
        async function fetchPlan(cid) {
            const { content, gateway } = await ipfs().fetchObject(cid, reading(win.PlanRecord.SCHEMA));
            const error = win.PlanRecord.validate(content);
            if (error) throw failure('invalid-plan', `Plan ${cid} is not a valid plan: ${error}`);
            log(`plan ${cid} read from ${gateway}`);
            return { cid, content, source: 'ipfs', gateway };
        }

        /**
         * An agreement/v1 object from IPFS with its plan, in the shape AgreementSync.fetchAgreement
         * answers. Its `onchain` is read from the account its sponsor and CID derive; a chain that
         * cannot be read leaves it null rather than failing the content.
         */
        async function fetchAgreement(cid) {
            const { content, gateway } = await ipfs().fetchObject(cid, reading(win.AgreementRecord.PUBLISHED_SCHEMA));
            const problem = agreementContentError(content, win.Cid);
            if (problem) throw failure('invalid-agreement-record', `Agreement ${cid} ${problem}.`);
            log(`agreement ${cid} read from ${gateway}`);
            const plan = await fetchPlan(content.planCid);
            let onchain = null;
            try { onchain = await agreementOnchain(cid, content.sponsor); } catch (error) {
                warn(`the chain state of ${cid} could not be read`, error);
            }
            // Its status is the account's once minted; the index's other statuses are its own bookkeeping.
            return { cid, content, createdAt: null, status: onchain ? onchain.status : null, onchain, plan,
                designCids: plan.content.designCids, source: 'ipfs', gateway };
        }

        // design/v1 objects from IPFS as index rows ({ cid, content }, with no binding: handleSharedDesignRoute
        // derives it where a design is applied). Resolves { rows: Map, missing: [cid] }.
        async function fetchDesigns(cids) {
            const { rows, missing } = await ipfs().fetchObjects(cids, reading(win.DesignRecord.SCHEMA));
            const designs = new Map([...rows].map(([cid, row]) => [cid, { cid, content: row.content, source: 'ipfs', gateway: row.gateway }]));
            if (designs.size) log(`${designs.size} design(s) read from IPFS`);
            return { rows: designs, missing: missing.map(entry => entry.cid) };
        }

        /**
         * The rows with the bindings the index would have given them, derived in this browser: a
         * design read from IPFS comes without one. Each is bound over the parcel source its place names
         * by the binder a private plan's designs use (PlanAnalysis.bindPrivateRows), whose parcel
         * worker runs the server's own computeSourceBindings over site-binding.js bindingFromParcels; a
         * source only our API holds is asked of the API, so it binds only while the API answers. With
         * the map continuing without parcels, or at a place with no cadastre, the whole site is open
         * ground, as the server binds a site with no source selected. A design with no site of its own
         * (a parcel act) and a row that already has a binding are returned as they are.
         * Resolves Map(cid → row); throws when a parcel source cannot be read.
         */
        async function withDerivedBindings(rows) {
            const siting = win.__siteBinding;
            const derived = new Map(), toBind = [];
            for (const row of rows) {
                const site = row.binding || !isObject(row.content) ? null : siting.siteOf(row.content, { turf: win.turf });
                if (!site) { derived.set(row.cid, row); continue; }
                const sourceId = win.DesignSync.parcelSourceIdOf(row.content.city, site);
                if (win.ParcelGroundFallback?.isWithoutParcels?.() || !sourceId || sourceId === 'none') {
                    derived.set(row.cid, { ...row, binding: siting.bindingFromParcels(site, [], { turf: win.turf,
                        toleranceM: row.content.toleranceM, regionHasCadastre: false, source: 'browser:none' }) });
                } else toBind.push(row);
            }
            if (toBind.length) {
                const bound = await win.PlanAnalysis.bindPrivateRows(toBind.map(row => ({ cid: row.cid, content: row.content, source: null })));
                for (const row of toBind) {
                    const binding = bound.get(row.cid)?.binding;
                    if (!isObject(binding)) throw failure('binding-unavailable', `The parcels under design ${row.cid} could not be read.`);
                    derived.set(row.cid, { ...row, binding });
                    log(`derived the binding of ${row.cid} here: ${binding.parcels.length} parcel(s), coverage ${binding.coverage}`);
                }
            }
            return derived;
        }

        return { cluster, listAgreements, agreementOnchain, fetchAgreement, fetchPlan, fetchDesigns, withDerivedBindings };
    }

    return { CLUSTER, withFallback, onchainOf, chainRowOf, agreementContentError, browser };
});
