// Sharing starts with an explicit plan's exact members, or the applied composition by default.
// This pure model keeps row choices across tabs without importing or applying plan members.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ShareSelection = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    function prepare(applied, { members = null, overrides = new Map(), keyOf = proposal => proposal.proposalId } = {}) {
        const proposals = new Map();
        for (const proposal of [...applied, ...(members || [])]) {
            const key = keyOf(proposal);
            if (key) proposals.set(String(key), proposal);
        }
        const selected = members === null ? new Set(proposals.keys())
            : new Set(members.map(keyOf).filter(Boolean).map(String));
        for (const [key, included] of overrides) {
            if (included && proposals.has(key)) selected.add(key);
            else selected.delete(key);
        }
        return { proposals, selected };
    }

    return Object.freeze({ prepare });
});
