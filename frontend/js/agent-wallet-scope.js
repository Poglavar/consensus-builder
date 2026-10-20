// Scope wallet observations and cached profile data without treating local model assignments as chain evidence.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.AgentWalletScope = api;
})(typeof window !== 'undefined' ? window : null, function () {
    function normalize(scope) {
        if (!scope || typeof scope.walletAddress !== 'string' || !scope.walletAddress.trim()) return null;
        const rawChain = String(scope.chainId ?? '').trim();
        if (rawChain.startsWith('solana-') && rawChain.length > 7) {
            return { chainId: rawChain, walletAddress: scope.walletAddress.trim() };
        }
        if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(rawChain)) return null;
        const chainNumber = BigInt(rawChain);
        if (chainNumber <= 0n) return null;
        return { chainId: `0x${chainNumber.toString(16)}`, walletAddress: scope.walletAddress.trim().toLowerCase() };
    }
    function connected({ evm, solana, solanaCluster } = {}) {
        const hasAccount = state => state?.status === 'connected' && Array.isArray(state.accounts) && state.accounts.length > 0;
        if (hasAccount(solana)) {
            return solanaCluster ? normalize({ chainId: `solana-${solanaCluster}`, walletAddress: solana.accounts[0] }) : null;
        }
        return hasAccount(evm) ? normalize({ chainId: evm.chainId, walletAddress: evm.accounts[0] }) : null;
    }
    function key(scope) {
        const normalized = normalize(scope);
        return normalized ? JSON.stringify([normalized.chainId, normalized.walletAddress]) : '';
    }
    function matches(left, right) {
        const leftKey = key(left);
        return !!leftKey && leftKey === key(right);
    }
    function parcelIds(observation, scope) {
        if (!matches(observation?.scope, scope) || typeof observation.contractAddress !== 'string' || !observation.contractAddress.trim()) return [];
        return Array.isArray(observation.parcelIds)
            ? [...new Set(observation.parcelIds.filter(id => typeof id === 'string' && id.trim()))]
            : [];
    }
    function fresh(cache, scope, now, ttl) {
        return matches(cache?.scope, scope) && Number.isFinite(cache.lastFetchedAt)
            && cache.lastFetchedAt <= now && now - cache.lastFetchedAt < ttl;
    }
    return { normalize, connected, key, matches, parcelIds, fresh };
});
