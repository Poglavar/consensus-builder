// Profile links distinguish exact browser keys from complete chain locations, including unloaded records.
(function (root, factory) {
    const references = root?.ChainProposalRef || (typeof require === 'function' ? require('./proposals/chain-ref.js') : null);
    const api = factory(references);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.AgentProposalLinks = api;
})(typeof window !== 'undefined' ? window : null, function (references) {
    function local(localProposalId) {
        const value = String(localProposalId ?? '').trim();
        if (!value) throw new Error('A local proposal key is required.');
        return { localProposalId: value };
    }
    function chain(chainId, contractAddress, tokenId) {
        const chainRef = references.chainRefFromProposal({ onchain: { chainId, contractAddress, proposalId: tokenId } });
        if (!references.identityKey(chainRef)) throw new Error('A complete chain proposal reference is required.');
        return { chainRef };
    }
    function validate(link) {
        if (!link || (Object.hasOwn(link, 'localProposalId') === Object.hasOwn(link, 'chainRef'))) {
            throw new Error('A profile link must name one local key or one chain reference.');
        }
        if (Object.hasOwn(link, 'localProposalId')) {
            if (typeof link.localProposalId !== 'string' || !link.localProposalId.trim()) throw new Error('A local proposal key is required.');
        } else if (!references.identityKey(link.chainRef)) throw new Error('A complete chain proposal reference is required.');
        return link;
    }
    function resolve(link, proposals = []) {
        validate(link);
        return link.chainRef ? references.findByReference(proposals, link.chainRef)
            : proposals.find(proposal => proposal && String(proposal.proposalId) === link.localProposalId) || null;
    }
    function key(link, proposals = []) {
        const record = resolve(link, proposals);
        return record ? JSON.stringify(['local', String(record.proposalId)])
            : link.chainRef ? JSON.stringify(['chain', references.identityKey(link.chainRef)])
            : JSON.stringify(['local', link.localProposalId]);
    }
    function merge(links, proposals = []) {
        const seen = new Set();
        return (links || []).filter(link => {
            const identity = key(link, proposals);
            if (seen.has(identity)) return false;
            seen.add(identity);
            return true;
        });
    }
    function locals(ids = []) {
        return ids.map(local);
    }
    return { local, chain, validate, resolve, key, merge, locals };
});
