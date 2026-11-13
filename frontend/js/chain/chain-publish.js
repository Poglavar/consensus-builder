// chain-publish.js — Flow 4 (blockchain-flows.md): with a wallet connected to a chain this app has
// contracts or programs on (an EVM wallet, a Solana wallet, or both), Share offers "Publish on
// <chain>" for each before "Publish through the server". The chain
// path runs the mint checklist (content to IPFS, record minted by the wallet) and then mirrors the
// object to the index as a courtesy; a server that does not answer never fails the publication,
// because the share link names content, not where it was published. window.ChainPublish.
(function (win) {
    'use strict';

    const t = (key, vars) => win.i18n.t(key, vars);
    const log = message => console.info(`[${new Date().toISOString()}] [ChainPublish] ${message}`);

    // The signing adapters of the connected wallets (chain/evm-adapter.js, chain/solana-adapter.js),
    // EVM first; empty when no wallet is on a chain this app can publish on.
    async function adapters() {
        const found = [];
        for (const source of [win.EvmAdapter, win.SolanaAdapter]) {
            if (!source) continue;
            try {
                const chain = await source.connected();
                if (chain) found.push(chain);
            } catch (error) {
                console.warn(`[${new Date().toISOString()}] [ChainPublish] a chain adapter is unavailable`, error);
            }
        }
        return found;
    }

    // Where to publish: one of `chains` (an adapter), 'server', or null (cancelled).
    async function choose(chains) {
        const choice = await win.CbDialog.choice(t('proposals.share.where.chainHint'), [
            ...chains.map((chain, index) => ({ value: `chain:${index}`, label: t('mint.actions.start', { chain: chain.name }), primary: index === 0 })),
            { value: 'server', label: t('proposals.share.where.server') },
            { value: 'cancel', label: t('modal.common.cancel') }
        ], { title: t('proposals.share.where.title') });
        if (choice === 'server') return 'server';
        const match = /^chain:(\d+)$/.exec(String(choice || ''));
        return match ? chains[Number(match[1])] : null;
    }

    const chainRef = (chain, result) => ({ family: chain.family, chainId: chain.chainId, minter: result.record.minter, createdAt: result.record.createdAt, txHash: result.txHash });

    /**
     * Publishes a local design on `chain`. Resolves { cid, link, chain, mirrored } or null when the
     * checklist was closed; throws what DesignSync.prepareForPublication throws.
     */
    async function design(localDesign, chain) {
        const { content, cid, bytes } = win.DesignSync.prepareForPublication(localDesign);
        const link = win.DesignSync.designLink([cid], { city: content.city });
        const result = await win.MintChecklist.open({
            kind: 'design', objects: [{ cid, bytes, label: content.title || cid }], subject: cid, adapter: chain, apiBase: win.DesignSync.apiBase(),
            tokenUri: win.EvmAdapter.tokenUriOf({ name: content.title || cid, description: t('proposals.share.publishedAs', { cid }), externalUrl: link })
        });
        if (!result) return null;
        let mirrored = false;
        try { await win.DesignSync.indexDesign({ cid, content }); mirrored = true; } catch (error) {
            log(`${cid} minted; the index did not take the mirror (${error.message})`);
        }
        win.DesignSync.markPublished(localDesign, { cid, publishedAt: result.record.createdAt, apiBase: mirrored ? win.DesignSync.apiBase() : null, chain: chainRef(chain, result) });
        log(`design ${cid} published on ${chain.name}${mirrored ? ' and mirrored' : ''}`);
        return { cid, link, chain: chainRef(chain, result), mirrored };
    }

    /**
     * Publishes a resolved plan row (PlanWorkspace.resolve: content, designs with their content) on
     * `chain`: every member retrievable, then the plan, then its record. Resolves { cid, link, chain,
     * mirrored } or null.
     */
    async function plan(row, chain) {
        for (const record of win.PlanComposition.localRecords(row, { apiBase: win.DesignSync.apiBase() })) {
            const refusal = win.ProposalPublishTerms.publishRefusal(record);
            if (refusal) throw new Error(refusal.message);
        }
        const blocked = win.guestPolicyBlocks('publish');
        if (blocked) throw new Error(blocked);
        const objects = [
            // The server pins an object only as its own kind (routes/pins.js): members are designs.
            ...row.designs.map(member => ({ kind: 'design', cid: member.cid, bytes: win.Cid.canonicalBytes(member.content), label: member.content.title || member.cid })),
            { cid: row.cid, bytes: win.Cid.canonicalBytes(row.content), label: row.content.title }
        ];
        const link = win.NamedPlans.link(row.cid);
        const result = await win.MintChecklist.open({
            kind: 'plan', objects, subject: row.cid, adapter: chain, apiBase: win.DesignSync.apiBase(),
            tokenUri: win.EvmAdapter.tokenUriOf({ name: row.content.title, description: t('agreement.list.designs', { count: row.content.designCids.length }), externalUrl: link })
        });
        if (!result) return null;
        let mirrored = false;
        try { await win.PlanWorkspace.publish(row); mirrored = true; } catch (error) {
            log(`plan ${row.cid} minted; the index did not take the mirror (${error.message})`);
            win.PlanWorkspace.save({ ...row, published: true });
        }
        log(`plan ${row.cid} published on ${chain.name}${mirrored ? ' and mirrored' : ''}`);
        return { cid: row.cid, link, chain: chainRef(chain, result), mirrored };
    }

    win.ChainPublish = Object.freeze({ adapters, choose, design, plan });
})(window);
