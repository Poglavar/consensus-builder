// chain-reader.js — the chain and IPFS as a source of published agreements, plans and designs
// (docs/blockchain-flows.md, Flow 1): agreements listed from the agreement program's accounts on
// Solana devnet, their agreement, plan and design objects read from public IPFS gateways and checked
// against their CIDs (ipfs-read.js), and each agreement's chain state read from its account. Designs
// and plans have no accounts: the chain lists the plans its agreements name and the designs those
// plans name (catalog), read from IPFS once per page. Nothing
// here asks our server, so a minted agreement opens while the backend is down. The agreement, plan
// and design loaders (AgreementSync, NamedPlans, DesignSync) use these reads when the person chose
// the chain, or both, as where to read from (chain/read-source.js), never as a fallback.
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
            readFrom: 'chain'
        };
    }

    // An agreement/v1 object read from IPFS must name its plan by CID, as the index requires.
    function agreementContentError(content, cidApi) {
        if (!isObject(content)) return 'is not an object';
        if (!cidApi.isCid(content.planCid)) return 'names no plan CID';
        if (Object.hasOwn(content, 'designs') || Object.hasOwn(content, 'designCids')) return 'lists designs instead of a plan';
        return null;
    }

    const messageOf = error => (error && error.message) || String(error);

    /**
     * The plans behind minted agreements, as the chain alone names them: for each agreement account
     * (newest first), its agreement object from IPFS, then the plan that object names, read only when
     * the account's plan_cid_hash is the hash of that plan's CID. One object is read at a time
     * (`read(kind, cid)` resolves { content, gateway } of a checked object, cached by CID in the
     * browser). An agreement or plan that cannot be read, and an account whose hash disagrees with its
     * content, is left out and reported in `skipped`; it never stops the rest.
     * `onProgress({ stage: 'plans', done, total })` follows each agreement.
     * Resolves { agreements: n, plans: [{ cid, content, gateway, agreementCids }], skipped }, with
     * skipped [{ kind: 'agreement' | 'plan', cid, code, reason }].
     */
    async function plansBehind(accounts, { read, planCidHash, onProgress = () => {} }) {
        const plans = new Map(), failed = new Set(), skipped = [];
        const total = accounts.length;
        onProgress({ stage: 'plans', done: 0, total });
        for (const [index, account] of accounts.entries()) {
            try {
                const { content } = await read('agreement', account.cid);
                if (planCidHash(content.planCid) !== account.planCidHash) {
                    skipped.push({ kind: 'agreement', cid: account.cid, code: 'plan-hash-mismatch',
                        reason: `its account names another plan than ${content.planCid}` });
                } else if (plans.has(content.planCid)) {
                    plans.get(content.planCid).agreementCids.push(account.cid);
                } else if (!failed.has(content.planCid)) {
                    try {
                        const plan = await read('plan', content.planCid);
                        plans.set(content.planCid, { cid: content.planCid, content: plan.content, gateway: plan.gateway, agreementCids: [account.cid] });
                    } catch (error) {
                        failed.add(content.planCid);
                        skipped.push({ kind: 'plan', cid: content.planCid, code: error.code || 'unreadable', reason: messageOf(error) });
                    }
                }
            } catch (error) {
                skipped.push({ kind: 'agreement', cid: account.cid, code: error.code || 'unreadable', reason: messageOf(error) });
            }
            onProgress({ stage: 'plans', done: index + 1, total });
        }
        return { agreements: total, plans: [...plans.values()], skipped };
    }

    /**
     * The designs those plans name, each read once (one at a time, `read` as plansBehind's), with the
     * plans that name it. A design that cannot be read is reported in `skipped`, the rest still listed.
     * `onProgress({ stage: 'designs', done, total })` follows each design.
     * Resolves { designs: [{ cid, content, gateway, planCids }], skipped: [{ kind: 'design', … }] }.
     */
    async function designsOf(plans, { read, onProgress = () => {} }) {
        const planCids = new Map();
        for (const plan of plans) {
            for (const cid of plan.content.designCids) planCids.set(cid, [...(planCids.get(cid) || []), plan.cid]);
        }
        const designs = [], skipped = [], total = planCids.size;
        let done = 0;
        onProgress({ stage: 'designs', done, total });
        for (const [cid, named] of planCids) {
            try {
                const { content, gateway } = await read('design', cid);
                designs.push({ cid, content, gateway, planCids: named });
            } catch (error) {
                skipped.push({ kind: 'design', cid, code: error.code || 'unreadable', reason: messageOf(error) });
            }
            onProgress({ stage: 'designs', done: ++done, total });
        }
        return { designs, skipped };
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
            await win.ensureWalletVendors?.('solana');
            if (!win.solanaWeb3?.Connection || !win.SolanaChainDataLoader?.getVerifiedConnection) {
                throw failure('web3-unavailable', 'The Solana library could not be loaded.');
            }
            return win.SolanaChainDataLoader.getVerifiedConnection(CLUSTER);
        }

        // Every agreement account of the program, newest first, decoded (AgreementClient.readAgreement).
        async function listAccounts() {
            const started = Date.now();
            const accounts = await client().listAgreements(await connection(), { programId: programId() });
            log(`${accounts.length} agreement account(s) on ${CLUSTER} in ${Date.now() - started} ms`);
            return accounts;
        }

        // Every agreement account of the program, newest first, as list rows (chainRowOf).
        async function listAgreements() {
            const accounts = await listAccounts();
            const observedAt = new Date().toISOString();
            return accounts.map(account => chainRowOf(account, { programId: programId(), observedAt }));
        }

        // One checked object from IPFS, read once per CID for this page: equal CIDs are equal bytes.
        // A failed read is forgotten, so the next asks the gateways again.
        const objects = new Map();
        const OBJECT_READS = {
            agreement: async cid => {
                const read = await ipfs().fetchObject(cid, reading(win.AgreementRecord.PUBLISHED_SCHEMA));
                const problem = agreementContentError(read.content, win.Cid);
                if (problem) throw failure('invalid-agreement-record', `Agreement ${cid} ${problem}.`);
                return read;
            },
            plan: async cid => {
                const read = await ipfs().fetchObject(cid, reading(win.PlanRecord.SCHEMA));
                const error = win.PlanRecord.validate(read.content);
                if (error) throw failure('invalid-plan', `Plan ${cid} is not a valid plan: ${error}`);
                return read;
            },
            design: cid => ipfs().fetchObject(cid, reading(win.DesignRecord.SCHEMA))
        };
        function readObject(kind, cid) {
            const key = `${kind}:${cid}`;
            if (!objects.has(key)) {
                const pending = OBJECT_READS[kind](cid).then(read => {
                    log(`${kind} ${cid} read from ${read.gateway}`);
                    return { content: read.content, gateway: read.gateway };
                });
                pending.catch(() => { if (objects.get(key) === pending) objects.delete(key); });
                objects.set(key, pending);
            }
            return objects.get(key);
        }

        /**
         * The plans behind the program's agreements (plansBehind), and with `designs` also the designs
         * they name (designsOf), read once per page and shared by every caller: the Lists' Plans and
         * Designs tabs and a design's "plans it is in". `force` lists the accounts again (Refresh); the
         * objects stay cached by CID. `onProgress` hears this read's progress, from its last step on.
         * Resolves { agreements, plans, designs?, skipped }.
         */
        let catalogRun = null;
        function catalog({ designs = false, force = false, onProgress = null } = {}) {
            if (!catalogRun || force) {
                const run = { listeners: new Set(), last: null, designs: null };
                run.emit = progress => {
                    run.last = progress;
                    run.listeners.forEach(listener => {
                        try { listener(progress); } catch (error) { warn('a progress listener failed', error); }
                    });
                };
                run.plans = (async () => {
                    run.emit({ stage: 'accounts', done: 0, total: null });
                    const accounts = await listAccounts();
                    const started = Date.now();
                    const result = await plansBehind(accounts, { read: readObject, planCidHash: client().planCidHash, onProgress: run.emit });
                    log(`${result.plans.length} plan(s) behind ${accounts.length} agreement(s) in ${Date.now() - started} ms; ${result.skipped.length} left out`);
                    if (result.skipped.length) warn('left out of the chain catalog', result.skipped);
                    return result;
                })();
                run.plans.catch(() => { if (catalogRun === run) catalogRun = null; });
                catalogRun = run;
            }
            const run = catalogRun;
            if (onProgress) {
                run.listeners.add(onProgress);
                if (run.last) onProgress(run.last);
            }
            let result = run.plans;
            if (designs) {
                run.designs = run.designs || run.plans.then(async plans => {
                    const started = Date.now();
                    const read = await designsOf(plans.plans, { read: readObject, onProgress: run.emit });
                    log(`${read.designs.length} design(s) of ${plans.plans.length} plan(s) in ${Date.now() - started} ms; ${read.skipped.length} left out`);
                    if (read.skipped.length) warn('designs left out of the chain catalog', read.skipped);
                    return { ...plans, designs: read.designs, skipped: [...plans.skipped, ...read.skipped] };
                });
                run.designs.catch(() => { if (catalogRun === run) run.designs = null; });
                result = run.designs;
            }
            return onProgress ? result.finally(() => run.listeners.delete(onProgress)) : result;
        }

        /**
         * The agreements on one plan from the chain alone: the accounts whose plan_cid_hash is that
         * plan's (AgreementClient.fetchAgreementsForPlan, a memcmp), each kept only when its agreement
         * object on IPFS names the plan, as the hash is only its sponsor's claim. Oldest first, as
         * { cid, title, planCid, createdAt, onchain, readFrom: 'chain' }; resolves { rows, skipped }.
         */
        async function agreementsOfPlan(planCid) {
            const accounts = await client().fetchAgreementsForPlan(await connection(), planCid, { programId: programId() });
            const observedAt = new Date().toISOString();
            const rows = [], skipped = [];
            for (const account of accounts) {
                try {
                    const { content } = await readObject('agreement', account.cid);
                    if (content.planCid !== planCid) {
                        skipped.push({ kind: 'agreement', cid: account.cid, code: 'plan-hash-mismatch', reason: `its object names plan ${content.planCid}` });
                        continue;
                    }
                    rows.push({ ...chainRowOf(account, { programId: programId(), observedAt }), title: content.title, planCid });
                } catch (error) {
                    skipped.push({ kind: 'agreement', cid: account.cid, code: error.code || 'unreadable', reason: messageOf(error) });
                }
            }
            log(`${rows.length} agreement(s) on plan ${planCid} from ${CLUSTER}; ${skipped.length} left out`);
            if (skipped.length) warn(`agreements on plan ${planCid} left out`, skipped);
            return { rows, skipped };
        }

        // The `onchain` of the agreement `cid` sponsored by `sponsor`, or null when it is not minted.
        async function agreementOnchain(cid, sponsor) {
            if (!sponsor) return null;
            const account = await client().fetchAgreement(await connection(), { cid, authority: sponsor, programId: programId() });
            return account ? onchainOf(account, { programId: programId(), observedAt: new Date().toISOString() }) : null;
        }

        // A plan/v1 object from IPFS, in the shape GET /plans/:cid answers ({ cid, content }).
        async function fetchPlan(cid) {
            const { content, gateway } = await readObject('plan', cid);
            return { cid, content, readFrom: 'chain', gateway };
        }

        /**
         * An agreement/v1 object from IPFS with its plan, in the shape AgreementSync.fetchAgreement
         * answers. Its `onchain` is read from the account its sponsor and CID derive; a chain that
         * cannot be read leaves it null rather than failing the content.
         */
        async function fetchAgreement(cid) {
            const { content, gateway } = await readObject('agreement', cid);
            const plan = await fetchPlan(content.planCid);
            let onchain = null;
            try { onchain = await agreementOnchain(cid, content.sponsor); } catch (error) {
                warn(`the chain state of ${cid} could not be read`, error);
            }
            // Its status is the account's once minted; the index's other statuses are its own bookkeeping.
            return { cid, content, createdAt: null, status: onchain ? onchain.status : null, onchain, plan,
                designCids: plan.content.designCids, readFrom: 'chain', gateway };
        }

        // A design/v1 object from IPFS as an index row ({ cid, content }, with no binding:
        // handleSharedDesignRoute derives it where a design is applied). Throws IpfsRead's error.
        async function fetchDesign(cid) {
            const { content, gateway } = await readObject('design', cid);
            return { cid, content, readFrom: 'chain', gateway };
        }

        // Several designs as fetchDesign reads one. Resolves { rows: Map, missing: [cid] }; one
        // unreadable design does not fail the others.
        async function fetchDesigns(cids) {
            const { rows, missing } = await ipfs().fetchObjects(cids, reading(win.DesignRecord.SCHEMA));
            const designs = new Map([...rows].map(([cid, row]) => [cid, { cid, content: row.content, readFrom: 'chain', gateway: row.gateway }]));
            if (designs.size) log(`${designs.size} design(s) read from IPFS`);
            if (missing.length) warn(`${missing.length} design(s) could not be read from IPFS`, missing);
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

        return { cluster, listAgreements, catalog, agreementsOfPlan, agreementOnchain, fetchAgreement, fetchPlan, fetchDesign, fetchDesigns, withDerivedBindings };
    }

    return { CLUSTER, onchainOf, chainRowOf, agreementContentError, plansBehind, designsOf, browser };
});
