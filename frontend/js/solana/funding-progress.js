// Funding progress of developer crowdfunding rounds (rule.electorate 'investors'), read from Solana:
// the agreement account, its proposal_pledge DonationEscrow and its apartment listings, many
// agreements in one batched getMultipleAccountsInfo. The server index is never asked for progress.
// Shared by Compare plans (plan-stats.js), Compare agreements' terms, Lists → Agreements and MCP
// ugt_compare (backend/agents/mcp-compare.js). Pure apart from the connection passed in.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && root.document) root.FundingProgress = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    // getMultipleAccountsInfo answers at most 100 accounts per request.
    const BATCH = 100;
    const finite = value => typeof value === 'number' && Number.isFinite(value);

    // The agreement/v1 content of an index row ({ content }), a stored agreement or the content itself.
    function contentOf(agreement) {
        if (!agreement || typeof agreement !== 'object') return null;
        return agreement.content && typeof agreement.content === 'object' && agreement.content.rule ? agreement.content : agreement;
    }
    function isCrowdfunding(agreement) {
        return contentOf(agreement)?.rule?.electorate === 'investors';
    }
    // The minted account an index row or stored agreement names, or null (unminted).
    function chainRefOf(agreement) {
        const onchain = agreement?.onchain;
        if (!onchain || onchain.chain !== 'solana' || typeof onchain.account !== 'string' || !onchain.account) return null;
        return { cluster: onchain.cluster || 'devnet', account: onchain.account };
    }
    const cidOf = agreement => agreement?.cid || agreement?.published?.cid || null;

    /**
     * The figures of one round from what the chain holds: escrow (decoded DonationEscrow, null before
     * the first contribution, which is a known zero), units (apartment inventory rows, [] when the
     * round offers none) and its target. Amounts in USDC atomic units as BigInt.
     */
    function progressOf({ escrow = null, units = [], targetUsdcAtomic = null } = {}) {
        const donated = escrow ? BigInt(escrow.totalDonated) : 0n;
        const refunded = escrow ? BigInt(escrow.totalRefunded) : 0n;
        const raised = donated > refunded ? donated - refunded : 0n;
        let target = null;
        try { target = targetUsdcAtomic === null || targetUsdcAtomic === undefined ? null : BigInt(targetUsdcAtomic); } catch (_) { target = null; }
        return {
            raisedUsdcAtomic: raised,
            targetUsdcAtomic: target,
            // Share of the target raised, 0–1+, null without a target.
            share: target && target > 0n ? Number(raised * 10000n / target) / 10000 : null,
            contributors: escrow ? Number(escrow.donorCount) : 0,
            apartmentsOffered: Array.isArray(units) && units.length ? units.length : null,
            apartmentsReserved: Array.isArray(units) && units.length ? units.filter(unit => unit.status === 'reserved').length : null,
            released: !!escrow?.released
        };
    }

    async function readBatched(connection, addresses, commitment) {
        const infos = [];
        for (let index = 0; index < addresses.length; index += BATCH) {
            const chunk = addresses.slice(index, index + BATCH);
            const answer = await connection.getMultipleAccountsInfo(chunk, commitment);
            if (!Array.isArray(answer) || answer.length !== chunk.length) throw new Error('The Solana RPC did not return every account asked for.');
            infos.push(...answer);
        }
        return infos;
    }
    const ownerOf = info => info?.owner?.toBase58?.() || (info?.owner ? String(info.owner) : null);
    const reasonOf = error => (error && error.message ? error.message : String(error));

    /**
     * Each agreement's progress by CID: { state: 'unminted' } | { state: 'read', chainStatus, decision,
     * fundingMet, lensConfirmed, ...progressOf } | { state: 'failed', reason }. Every minted agreement's
     * accounts are read together in batches of 100 (plus one batch for the deposits of reserved
     * apartments). `connectionFor(cluster)` gives a web3 Connection; the clients are
     * js/solana/agreement-client.js and pledge-client.js configured with web3, `record` agreement-record.js.
     * A failed read stays failed, never a 0.
     */
    async function readProgress(agreements, { connectionFor, agreementClient, pledgeClient, record, web3, commitment = 'confirmed' } = {}) {
        const out = new Map();
        const plans = [];
        for (const agreement of Array.isArray(agreements) ? agreements : []) {
            const cid = cidOf(agreement);
            if (!cid || out.has(cid)) continue;
            const ref = chainRefOf(agreement);
            if (!ref) { out.set(cid, { state: 'unminted' }); continue; }
            const content = contentOf(agreement);
            try {
                const sponsor = content?.sponsor;
                if (sponsor && agreementClient.getAgreementPda(cid, sponsor)[0].toBase58() !== ref.account) {
                    throw new Error('The indexed account is not the sponsor’s agreement account for this CID.');
                }
                const escrow = pledgeClient.getDonationEscrowPda(ref.account)[0].toBase58();
                const offers = content?.funding?.apartments && sponsor ? pledgeClient.apartmentOffers(content.funding, sponsor, record) : [];
                plans.push({ cid, ref, content, sponsor, escrow, offers });
            } catch (error) { out.set(cid, { state: 'failed', reason: reasonOf(error) }); }
        }
        const byCluster = new Map();
        plans.forEach(plan => { if (!byCluster.has(plan.ref.cluster)) byCluster.set(plan.ref.cluster, []); byCluster.get(plan.ref.cluster).push(plan); });
        const key = address => new web3.PublicKey(address);
        for (const [cluster, group] of byCluster) {
            let connection, infos;
            const addresses = group.flatMap(plan => [plan.ref.account, plan.escrow, ...plan.offers.map(offer => offer.account)]);
            try {
                connection = await connectionFor(cluster);
                infos = await readBatched(connection, addresses.map(key), commitment);
            } catch (error) {
                group.forEach(plan => out.set(plan.cid, { state: 'failed', reason: reasonOf(error) }));
                continue;
            }
            let at = 0;
            const held = [];
            for (const plan of group) {
                const agreementInfo = infos[at++], escrowInfo = infos[at++];
                const unitInfos = infos.slice(at, at + plan.offers.length); at += plan.offers.length;
                try {
                    if (!agreementInfo?.data) throw new Error(`The agreement account is not on Solana ${cluster}.`);
                    if (ownerOf(agreementInfo) !== agreementClient.constants.AGREEMENT_PROGRAM_ID) throw new Error('The agreement account belongs to another program.');
                    const account = agreementClient.readAgreement(new Uint8Array(agreementInfo.data), plan.ref.account);
                    if (!account || account.cid !== plan.cid || (plan.sponsor && account.authority !== plan.sponsor)) throw new Error('The agreement account holds another agreement.');
                    let escrow = null;
                    if (escrowInfo?.data) {
                        if (ownerOf(escrowInfo) !== pledgeClient.constants.PROGRAM_ID) throw new Error('The donation escrow belongs to another program.');
                        escrow = pledgeClient.decodeDonationEscrow(new Uint8Array(escrowInfo.data));
                        if (escrow.proposal !== plan.ref.account || escrow.mint !== pledgeClient.constants.USDC_DEVNET_MINT) throw new Error('The donation escrow is not this agreement’s USDC escrow.');
                    }
                    const units = plan.offers.length ? pledgeClient.apartmentInventoryRows(plan.offers, unitInfos, plan.ref.account, plan.sponsor) : [];
                    units.filter(unit => unit.position).forEach(unit => held.push({ plan, unit }));
                    out.set(plan.cid, { state: 'read', cluster, account: plan.ref.account, chainStatus: account.status, decision: account.decision,
                        fundingMet: account.fundingMet, lensConfirmed: account.lensConfirmed.length, units,
                        ...progressOf({ escrow, units, targetUsdcAtomic: plan.content?.funding?.targetUsdcAtomic ?? (account.requiredFunding > 0n ? account.requiredFunding : null) }) });
                } catch (error) { out.set(plan.cid, { state: 'failed', reason: reasonOf(error) }); }
            }
            // A reserved apartment whose deposit was refunded is free again (readApartmentInventory's rule).
            if (held.length) {
                try {
                    const positions = await readBatched(connection, held.map(({ unit }) => key(unit.position)), commitment);
                    held.forEach(({ plan, unit }, index) => {
                        const info = positions[index];
                        if (!info?.data || ownerOf(info) !== pledgeClient.constants.PROGRAM_ID) throw new Error('An apartment deposit could not be verified.');
                        const paid = pledgeClient.decodeDonationPosition(new Uint8Array(info.data));
                        if (paid.refunded) unit.status = 'unlisted';
                        const row = out.get(plan.cid);
                        if (row?.state === 'read') Object.assign(row, { apartmentsReserved: row.units.filter(item => item.status === 'reserved').length });
                    });
                } catch (error) {
                    held.forEach(({ plan }) => out.set(plan.cid, { state: 'failed', reason: reasonOf(error) }));
                }
            }
        }
        out.forEach(row => { delete row.units; });
        return out;
    }

    /**
     * One line for a round's progress: "1,000 of 2,500 USDC raised · 3 contributors · 1 of 4
     * apartments reserved", "not minted", or why it could not be read. t(key, fallback, params)
     * translates; formatUsdc and formatInteger format.
     */
    function progressText(progress, { t, formatUsdc, formatInteger }) {
        if (!progress) return t('planCompare.backing.notRead', 'Not read');
        if (progress.state === 'unminted') return t('planCompare.backing.notMinted', 'Not minted');
        if (progress.state === 'failed') return t('planCompare.backing.chainFailed', 'Chain not read: {{reason}}', { reason: progress.reason });
        if (progress.state === 'loading') return t('planCompare.backing.chainReading', 'Reading the chain…');
        const raised = progress.targetUsdcAtomic !== null
            ? t('planCompare.backing.raisedOf', '{{raised}} of {{target}} USDC raised', { raised: formatUsdc(progress.raisedUsdcAtomic), target: formatUsdc(progress.targetUsdcAtomic) })
            : t('planCompare.backing.raised', '{{raised}} USDC raised', { raised: formatUsdc(progress.raisedUsdcAtomic) });
        const parts = [raised, t('planCompare.backing.contributors', '{{count}} contributors', { count: formatInteger(progress.contributors) })];
        if (finite(progress.apartmentsOffered)) parts.push(t('planCompare.backing.apartments', '{{reserved}} of {{offered}} apartments reserved',
            { reserved: formatInteger(progress.apartmentsReserved), offered: formatInteger(progress.apartmentsOffered) }));
        return parts.join(' · ');
    }

    const model = { BATCH, contentOf, isCrowdfunding, chainRefOf, progressOf, readProgress, progressText };
    if (!root || !root.document) return model;

    // ---- browser: the page's clients and devnet connection, results kept a minute per CID ----------
    const cache = new Map();
    const FRESH_MS = 60 * 1000;
    async function clients() {
        if (!root.solanaWeb3?.PublicKey && typeof root.ensureWalletVendors === 'function') await root.ensureWalletVendors();
        if (!root.SolanaPledgeClient && typeof root.ensureOptionalTool === 'function') await root.ensureOptionalTool('fundingProgress');
        if (!root.solanaWeb3?.PublicKey || !root.SolanaPledgeClient || !root.AgreementClient || !root.SolanaChainDataLoader) {
            throw new Error('The Solana library could not be loaded.');
        }
        return { web3: root.solanaWeb3, pledgeClient: root.SolanaPledgeClient, agreementClient: root.AgreementClient, record: root.AgreementRecord };
    }
    /** Progress by CID for these agreements, the chain read once per minute per CID. */
    async function read(agreements, { force = false } = {}) {
        const list = (Array.isArray(agreements) ? agreements : []).filter(agreement => cidOf(agreement));
        const now = Date.now();
        const stale = list.filter(agreement => force || !cache.has(cidOf(agreement)) || now - cache.get(cidOf(agreement)).at > FRESH_MS);
        if (stale.length) {
            const pending = (async () => {
                try {
                    const deps = await clients();
                    return await readProgress(stale, { ...deps, connectionFor: cluster => root.SolanaChainDataLoader.getConnection(cluster) });
                } catch (error) {
                    console.error(`[${new Date().toISOString()}] [FundingProgress] the chain could not be read`, error);
                    return new Map(stale.map(agreement => [cidOf(agreement), chainRefOf(agreement) ? { state: 'failed', reason: reasonOf(error) } : { state: 'unminted' }]));
                }
            })();
            stale.forEach(agreement => cache.set(cidOf(agreement), { at: now, value: pending.then(map => map.get(cidOf(agreement))) }));
        }
        const rows = await Promise.all(list.map(async agreement => [cidOf(agreement), await cache.get(cidOf(agreement)).value]));
        rows.filter(([, value]) => value?.state === 'failed').forEach(([cid]) => cache.delete(cid));
        return new Map(rows);
    }
    // The line in the page's language and number format.
    function textOf(progress) {
        const t = (key, fallback, params = {}) => {
            const value = root.i18n?.t ? root.i18n.t(key, params) : key;
            return value && value !== key ? value : String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (name in params ? params[name] : match));
        };
        return progressText(progress, { t, formatUsdc: atomic => root.AgreementRecord.formatUsdc(atomic),
            formatInteger: value => (root.CbFormat ? root.CbFormat.formatInteger(value) : String(value)) });
    }
    return { ...model, read, textOf };
});
