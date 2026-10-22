// Profile links name exact browser keys ({ localProposalId }), including keys whose record is not
// loaded here. Designs are not minted, so a profile names no chain records (plan-design-agreement.md, M3).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.AgentProposalLinks = api;
})(typeof window !== 'undefined' ? window : null, function () {
    function local(localProposalId) {
        const value = String(localProposalId ?? '').trim();
        if (!value) throw new Error('A local proposal key is required.');
        return { localProposalId: value };
    }
    function validate(link) {
        if (!link || typeof link.localProposalId !== 'string' || !link.localProposalId.trim()) {
            throw new Error('A profile link must name one local proposal key.');
        }
        return link;
    }
    function resolve(link, proposals = []) {
        validate(link);
        return proposals.find(proposal => proposal && String(proposal.proposalId) === link.localProposalId) || null;
    }
    function key(link) {
        return validate(link).localProposalId;
    }
    function merge(links) {
        const seen = new Set();
        return (links || []).filter(link => {
            const identity = key(link);
            if (seen.has(identity)) return false;
            seen.add(identity);
            return true;
        });
    }
    function locals(ids = []) {
        return ids.map(local);
    }
    return { local, validate, resolve, key, merge, locals };
});
