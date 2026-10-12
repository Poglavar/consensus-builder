// Pluggable rights imports and trusted-runtime authority resolvers. Uploaded JSON never installs
// an authority resolver; providers verify their evidence before returning it to the consent layer.
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
        resolve(proposal, ownerId, actor) {
            if (!actor?.id) return null;
            const contextHash = root.ProposalApproval.contextHash(proposal);
            for (const [providerId, provider] of authorities) {
                const evidence = provider.authorize({ proposal, ownerId, actor, contextHash });
                if (evidence?.then) throw new Error('Authority resolvers must use already verified evidence; load it before accepting.');
                const actorId = evidence?.authority?.actorId;
                if (root.ProposalApproval.evidenceAllows(proposal, ownerId, actorId, evidence)) return { providerId, evidence, actorId };
            }
            return null;
        },
        async signDecision(proposal, receipt, actor) {
            const provider = authorities.get(receipt.providerId);
            const current = actor?.id ? provider?.authorize({ proposal, ownerId: receipt.ownerId, actor,
                contextHash: root.ProposalApproval.contextHash(proposal) }) : null;
            if (!current || current.authority?.actorId !== receipt.actorId) throw new Error('No signer is available for this owner decision.');
            return provider.signDecision({ proposal, actor, receipt, statement: root.ProposalApproval.decisionContent(proposal, receipt) });
        },
        verifyReceipt(proposal, receipt) {
            const provider = authorities.get(receipt?.providerId);
            return !!provider && provider.verifyReceipt({ proposal, receipt,
                statement: root.ProposalApproval.decisionContent(proposal, receipt) }) === true;
        }
    };
    root.ProposalApprovalSources = sourceApi;
    root.ProposalApprovalAuthorities = authorityApi;
})(typeof window !== 'undefined' ? window : globalThis);
