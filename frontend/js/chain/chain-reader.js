// chain-reader.js — the From chain source (blockchain-flows.md, Flow 1): agreements listed from the
// connected Solana cluster, their agreement, plan and design objects read from IPFS and checked
// against their CIDs (ipfs-read.js), and the chain state of each agreement from its account. Nothing
// here asks our server, so a published agreement opens while the backend is down. The loaders that
// ask the server first (AgreementSync, NamedPlans, DesignSync) fall back to these reads.
// window.ChainReader; `withFallback` is exported for node.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root.document !== 'undefined') {
        const { browser, ...pure } = api;
        root.ChainReader = Object.freeze({ ...pure, ...browser(root) });
    }
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const log = (message, extra) => {
        const line = `[${new Date().toISOString()}] [ChainReader] ${message}`;
        if (extra === undefined) console.info(line); else console.info(line, extra);
    };

    /**
     * The server's answer, or, when it fails, the chain/IPFS one. When both fail the server's error is
     * thrown with the fallback's attached as `fallbackError`, so the message the person sees is the
     * familiar one and the log has both.
     */
    async function withFallback(label, primary, fallback) {
        try {
            return await primary();
        } catch (error) {
            log(`${label}: the server did not answer (${(error && error.message) || error}); reading IPFS`);
            try {
                return await fallback();
            } catch (fallbackError) {
                console.warn(`[${new Date().toISOString()}] [ChainReader] ${label}: IPFS did not answer either`, fallbackError);
                if (error && typeof error === 'object') error.fallbackError = fallbackError;
                throw error;
            }
        }
    }

    function browser(win) {
        const ipfs = () => win.IpfsRead;
        const client = () => win.AgreementClient;
        const cluster = () => (typeof win.solanaWalletManager?.getCluster === 'function' ? win.solanaWalletManager.getCluster() : 'devnet');

        async function connection() {
            if (!win.solanaWeb3?.Connection && typeof win.ensureWalletVendors === 'function') await win.ensureWalletVendors();
            if (!win.solanaWeb3?.Connection || !win.SolanaChainDataLoader?.getConnection) throw Object.assign(new Error('The Solana library could not be loaded.'), { code: 'web3-unavailable' });
            return win.SolanaChainDataLoader.getConnection(cluster());
        }

        // Every agreement account on the connected cluster, as list rows: the CID, when the chain says
        // it was created, and its `onchain` state. Titles are the content's, read when it is opened.
        async function listAgreements() {
            const name = cluster();
            const accounts = await client().listAgreements(await connection());
            const observedAt = new Date().toISOString();
            log(`${accounts.length} agreement account(s) on ${name}`);
            return accounts.map(account => ({
                cid: account.cid,
                createdAt: new Date(account.createdAt * 1000).toISOString(),
                onchain: client().onchainOf(account, { cluster: name, observedAt }),
                source: 'chain'
            }));
        }

        // The `onchain` state of the agreement `cid` sponsored by `sponsor`, or null when it is not minted.
        async function agreementOnchain(cid, sponsor) {
            if (!sponsor) return null;
            const name = cluster();
            const account = await client().fetchAgreement(await connection(), { cid, authority: sponsor });
            return account ? client().onchainOf(account, { cluster: name, observedAt: new Date().toISOString() }) : null;
        }

        // A plan/v1 object from IPFS, in the shape GET /plans/:cid answers ({ cid, content }).
        async function fetchPlan(cid) {
            const { content, gateway } = await ipfs().fetchObject(cid, { schema: win.PlanRecord.SCHEMA });
            const error = win.PlanRecord.validate(content);
            if (error) throw Object.assign(new Error(`Plan ${cid} is not a valid plan: ${error}`), { code: 'invalid-plan' });
            log(`plan ${cid} read from ${gateway}`);
            return { cid, content, source: 'ipfs' };
        }

        /**
         * An agreement/v1 object from IPFS with its plan, in the shape AgreementSync.fetchAgreement
         * answers. `onchain` is read from the account its sponsor and CID derive; a chain that cannot
         * be read leaves it null rather than failing the content.
         */
        async function fetchAgreement(cid) {
            const { content, gateway } = await ipfs().fetchObject(cid, { schema: win.AgreementRecord.PUBLISHED_SCHEMA });
            if (!win.Cid.isCid(content.planCid) || Object.hasOwn(content, 'designs')) {
                throw Object.assign(new Error(`Agreement ${cid} has no valid plan reference.`), { code: 'invalid-agreement-record' });
            }
            log(`agreement ${cid} read from ${gateway}`);
            const plan = await fetchPlan(content.planCid);
            let onchain = null;
            try { onchain = await agreementOnchain(cid, content.sponsor); } catch (error) {
                console.warn(`[${new Date().toISOString()}] [ChainReader] the chain state of ${cid} could not be read`, error);
            }
            // The status is the account's once minted; the index's other statuses are its own bookkeeping.
            return { cid, content, createdAt: null, status: onchain ? onchain.status : null, onchain, plan, designCids: plan.content.designCids, source: 'ipfs' };
        }

        // design/v1 objects from IPFS as index rows ({ cid, content }, no binding: the browser derives
        // it where the design is applied). Resolves { rows: Map, missing: [cid] }.
        async function fetchDesigns(cids) {
            const { rows, missing } = await ipfs().fetchObjects(cids, { schema: win.DesignRecord.SCHEMA });
            const designs = new Map([...rows].map(([cid, row]) => [cid, { cid, content: row.content, source: 'ipfs', gateway: row.gateway }]));
            if (designs.size) log(`${designs.size} design(s) read from IPFS`);
            return { rows: designs, missing: missing.map(entry => entry.cid) };
        }

        return { cluster, listAgreements, agreementOnchain, fetchAgreement, fetchPlan, fetchDesigns };
    }

    return { withFallback, browser };
});
