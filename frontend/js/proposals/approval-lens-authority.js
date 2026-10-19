// Lens-backed owner authority for abstract proposal approval. A member of the proposal's lens attests
// the pinned rights snapshot and which owners the connected wallet may act for; the wallet then signs
// each owner decision itself. Receipts verify from their signatures alone, so they survive reload and
// count in any browser. Registered as the "lens-wallet" provider of ProposalApprovalAuthorities.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalApprovalLensAuthority = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const PROVIDER_ID = 'lens-wallet';
    const approval = () => root.ProposalApproval || (typeof require === 'function' ? require('./approval.js') : null);
    const proof = () => root.ProposalApprovalProof || (typeof require === 'function' ? require('./approval-proof.js') : null);
    const lensClient = () => root.LensServiceClient || (typeof require === 'function' ? require('../lens-service-client.js') : null);

    function failure(code, message, outcome = null) {
        const error = new Error(message || code);
        error.code = code;
        if (outcome) error.outcome = outcome;
        return error;
    }
    const contextInput = proposal => ({
        cadastreParcelIds: proposal?.cadastreParcelIds || [],
        approvalConfig: proposal?.approvalConfig ?? null,
        lens: proposal?.lens || []
    });
    const refusal = outcome => failure(outcome.code || outcome.kind, outcome.message || `The lens member answered ${outcome.status}.`, outcome);

    /**
     * @param {{ wallet: () => ({ address: string, signMessage(text: string): Promise<string> }) | null,
     *   fetchImpl?: Function, now?: () => number }} options
     * `wallet()` is the wallet connected right now, or null; signMessage returns a base58 signature.
     */
    function createLensWalletAuthority({ wallet, fetchImpl, now = () => Date.now() }) {
        if (typeof wallet !== 'function') throw new Error('createLensWalletAuthority: wallet() is required');
        // Verified evidence per approval context and wallet: { rights, authority: Map(ownerId -> fact) }.
        const evidence = new Map();
        const key = (contextHash, address) => `${contextHash}\n${address}`;
        const live = fact => now() <= Date.parse(fact.expiresAt);

        // Everything a member returned is checked before it is kept: signatures, the member, this
        // proposal's context and parcels, the wallet as signer, and parties (owners, leaseholders,
        // required authorities) of this proposal.
        function keep(proposal, memberKey, address, body) {
            const A = approval(), P = proof();
            const contextHash = A.contextHash(proposal);
            const parcelIds = A.contextContent(proposal).cadastreParcelIds;
            const electorate = A.inspect(proposal).partyIds;
            const { rights, authority } = body || {};
            if (!P.verifyAttestation(rights, P.RIGHTS_SCHEMA) || rights.member !== memberKey || rights.contextHash !== contextHash
                || A.stableStringify(rights.parcelIds) !== A.stableStringify(parcelIds) || !live(rights)) {
                throw failure('bad-evidence', 'The lens member returned rights evidence that does not verify for this proposal.');
            }
            if (!Array.isArray(authority) || !authority.length) throw failure('bad-evidence', 'The lens member named no owner.');
            const facts = new Map();
            authority.forEach(fact => {
                if (!P.verifyAttestation(fact, P.AUTHORITY_SCHEMA) || fact.member !== memberKey || fact.contextHash !== contextHash
                    || fact.actorId !== address || !electorate.includes(fact.ownerId) || !live(fact)) {
                    throw failure('bad-evidence', 'The lens member returned authority evidence that does not verify for this wallet.');
                }
                facts.set(fact.ownerId, fact);
            });
            evidence.set(key(contextHash, address), { rights, authority: facts });
            return [...facts.keys()].sort();
        }

        // One wallet signature proves control to one lens member, which answers with its verdict on
        // the rights and the owners this wallet may act for in this proposal's approval context.
        async function verifyOwner(proposal, { memberKey, serviceUrl }) {
            const current = wallet();
            if (!current) throw failure('wallet-required', 'Connect a wallet first.');
            const A = approval();
            if (!A.inspect(proposal).ready) throw failure('ownership-unresolved', 'The proposal has no complete rights snapshot.');
            if (!A.lensKeys(proposal).includes(memberKey)) throw failure('member-not-in-lens', 'That member is not in this proposal\'s lens.');
            const contextHash = A.contextHash(proposal);
            const client = lensClient();
            const challenged = await client.requestApprovalChallenge({ serviceUrl, wallet: current.address, contextHash, fetchImpl });
            if (challenged.outcome.kind !== 'ok') throw refusal(challenged.outcome);
            const { challenge, message, expiresAt } = challenged.body || {};
            const expected = proof().approvalChallengeMessage({ member: memberKey, wallet: current.address, contextHash, challenge, expiresAt });
            if (typeof challenge !== 'string' || !challenge || message !== expected || !(Date.parse(expiresAt) > now())) {
                throw failure('bad-challenge', 'The lens member asked for a signature over something unexpected; nothing was signed.');
            }
            const signature = await current.signMessage(expected);
            const answered = await client.submitApprovalAuthority({
                serviceUrl, wallet: current.address, challenge, signature, context: contextInput(proposal), fetchImpl
            });
            if (answered.outcome.kind !== 'ok') throw refusal(answered.outcome);
            return { wallet: current.address, ownerIds: keep(proposal, memberKey, current.address, answered.body) };
        }

        // Owners the connected wallet may act for in this proposal, from evidence kept this session.
        function ownerIds(proposal) {
            const current = wallet();
            if (!current) return [];
            let contextHash;
            try { contextHash = approval().contextHash(proposal); } catch (_) { return []; }
            const entry = evidence.get(key(contextHash, current.address));
            if (!entry || !live(entry.rights)) return [];
            return [...entry.authority.values()].filter(live).map(fact => fact.ownerId).sort();
        }

        const provider = {
            authorize({ ownerId, contextHash }) {
                const current = wallet();
                const entry = current ? evidence.get(key(contextHash, current.address)) : null;
                const fact = entry?.authority.get(ownerId);
                if (!fact || !live(fact) || !live(entry.rights)) return null;
                return { rights: entry.rights, authority: fact };
            },
            async signDecision({ receipt, statement }) {
                const current = wallet();
                if (!current || current.address !== receipt.actorId) {
                    throw failure('wrong-wallet', 'Connect the wallet that may act for this owner.');
                }
                return { scheme: proof().DECISION_SCHEME, signature: await current.signMessage(proof().decisionMessage(statement)) };
            },
            verifyReceipt({ proposal, receipt, statement }) {
                return proof().verifyReceipt({ receipt, statement, parcelIds: approval().contextContent(proposal).cadastreParcelIds });
            }
        };
        return { provider, verifyOwner, ownerIds, clear: () => evidence.clear() };
    }

    // The connected Solana wallet as a message signer, or null when none is connected.
    function browserWallet() {
        const manager = root.solanaWalletManager;
        const state = manager?.getState?.();
        const provider = manager?.getProvider?.();
        if (!state || state.status !== 'connected' || !state.accounts?.length || typeof provider?.signMessage !== 'function') return null;
        return {
            address: state.accounts[0],
            async signMessage(text) {
                return root.LensCore.signatureToBase58(await provider.signMessage(new TextEncoder().encode(text), 'utf8'));
            }
        };
    }

    async function connectWallet() {
        const manager = root.solanaWalletManager;
        const connectors = manager?.getConnectors?.() || [];
        if (!manager || (!browserWallet() && !connectors.length)) throw failure('no-wallet', 'No Solana wallet found in this browser.');
        if (!browserWallet()) await manager.connect(connectors[0].id);
        const current = browserWallet();
        if (!current) throw failure('no-sign-message', 'This wallet cannot sign messages.');
        return current;
    }

    const api = { PROVIDER_ID, createLensWalletAuthority, browserWallet, connectWallet, instance: null };
    if (typeof window !== 'undefined' && root.ProposalApprovalAuthorities) {
        api.instance = createLensWalletAuthority({ wallet: browserWallet });
        root.ProposalApprovalAuthorities.register(PROVIDER_ID, api.instance.provider);
    }
    return api;
});
