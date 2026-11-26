// Links to a wallet's page on tokenizario.app, the one Tokenizario page this app links to. The live
// site serves Solana devnet only, so a link exists only for a Solana key on devnet; no link otherwise.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.TokenizarioLinks = api;
})(typeof window === 'undefined' ? null : window, function () {
    const SITE = 'https://tokenizario.app';
    // A Solana public key in base58 (32 bytes encode to 32–44 characters of this alphabet).
    const SOLANA_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

    function isSolanaKey(address) {
        return typeof address === 'string' && SOLANA_KEY.test(address.trim());
    }

    /**
     * The wallet's page (its self-described profile, standing and signed statements), or null when
     * the live site has no page for it: another chain's address, or a cluster the site does not serve.
     */
    function walletPageUrl(address, cluster) {
        if (cluster !== 'devnet' || !isSolanaKey(address)) return null;
        return `${SITE}/address/${address.trim()}?chain=devnet`;
    }

    return { isSolanaKey, walletPageUrl };
});
