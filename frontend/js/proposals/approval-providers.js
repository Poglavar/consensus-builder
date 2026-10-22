// Pluggable rights imports and trusted-runtime authority resolvers. Uploaded JSON never installs
// an authority resolver; providers verify their evidence before returning it to the consent layer.
// Authorities act on an agreement: the agreement-like object ProposalApproval's decision functions
// take ({ agreementCid, cadastreParcelIds, approvalConfig, lens, ownerApprovals? }), passed to each
// provider as `agreement`.
(function (root) {
    'use strict';
    const sources = new Map();
    const authorities = new Map();
    function registerSource(provider) {
        if (!provider?.id || typeof provider.load !== 'function') throw new Error('A rights provider needs an ID and load function.');
        if (sources.has(provider.id)) throw new Error(`Rights provider ${provider.id} is already registered.`);
        sources.set(provider.id, provider);
        return () => sources.delete(provider.id);
    }
    const sourceApi = {
        register: registerSource,
        list: () => Array.from(sources.values(), provider => ({ id: provider.id, label: provider.label || provider.id })),
        async load(id, input, options) {
            const provider = sources.get(id);
            if (!provider) throw new Error('Unknown rights provider.');
            const result = root.ProposalApproval.normalizeRights(await provider.load(input, options));
            if (result.source.provider !== id) throw new Error('The rights snapshot names a different provider.');
            return result;
        }
    };
    registerSource({ id: 'upload', label: 'JSON upload', load: input => {
        if (typeof input !== 'string' || new TextEncoder().encode(input).length > 1024 * 1024) throw new Error('Upload a JSON rights file no larger than 1 MB.');
        return JSON.parse(input);
    } });
    // M2: the browser flow (the agreement panel) passes { ...AgreementRecord.approvalSubject(agreement),
    // agreementCid: the published CID, ownerApprovals, ownerApprovalHistory } as `agreement`.
    const authorityApi = {
        register(id, provider) {
            if (!id || authorities.has(id) || !['authorize', 'signDecision', 'verifyReceipt'].every(key => typeof provider?.[key] === 'function')) {
                throw new Error('An authority provider needs a unique ID, authorize, signDecision and verifyReceipt.');
            }
            authorities.set(id, provider);
            return () => authorities.delete(id);
        },
        // A provider authenticates its own signer for the current profile (the profile itself, or a
        // wallet it controls); the evidence names that signer, and the receipt records it.
        resolve(agreement, ownerId, actor) {
            if (!actor?.id) return null;
            const contextHash = root.ProposalApproval.contextHash(agreement);
            for (const [providerId, provider] of authorities) {
                const evidence = provider.authorize({ agreement, ownerId, actor, contextHash });
                if (evidence?.then) throw new Error('Authority resolvers must use already verified evidence; load it before accepting.');
                const actorId = evidence?.authority?.actorId;
                if (root.ProposalApproval.evidenceAllows(agreement, ownerId, actorId, evidence)) return { providerId, evidence, actorId };
            }
            return null;
        },
        // The statement signed names the agreement's CID; an agreement without one cannot be decided.
        async signDecision(agreement, receipt, actor) {
            const provider = authorities.get(receipt.providerId);
            const current = actor?.id ? provider?.authorize({ agreement, ownerId: receipt.ownerId, actor,
                contextHash: root.ProposalApproval.contextHash(agreement) }) : null;
            if (!current || current.authority?.actorId !== receipt.actorId) throw new Error('No signer is available for this owner decision.');
            return provider.signDecision({ agreement, actor, receipt, statement: root.ProposalApproval.decisionContent(agreement, receipt) });
        },
        verifyReceipt(agreement, receipt) {
            const provider = authorities.get(receipt?.providerId);
            return !!provider && provider.verifyReceipt({ agreement, receipt,
                statement: root.ProposalApproval.decisionContent(agreement, receipt) }) === true;
        }
    };
    root.ProposalApprovalSources = sourceApi;
    root.ProposalApprovalAuthorities = authorityApi;
})(typeof window !== 'undefined' ? window : globalThis);
