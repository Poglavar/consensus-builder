// The wallet connectors use the injected provider directly. Load each pinned SDK only for
// a connection or a chain read. A caller that needs both can await ensureWalletVendors().
(function (win) {
    function onDemand(src, isReady) {
        let pending;
        return function load() {
            if (isReady()) return Promise.resolve(true);
            if (pending) return pending;

            pending = new Promise(resolve => {
                const script = win.document.createElement('script');
                script.src = src;
                const finish = ready => {
                    if (!ready) script.remove();
                    resolve(ready);
                };
                script.onload = () => finish(isReady());
                script.onerror = () => finish(false);
                win.document.head.appendChild(script);
            }).catch(() => false).finally(() => { pending = null; });
            return pending;
        };
    }

    const ethereum = onDemand('vendor/ethers-6.17.0/ethers.umd.min.js',
        () => typeof win.ethers?.BrowserProvider === 'function' && typeof win.ethers?.Contract === 'function');
    const solana = onDemand('vendor/solana-web3-1.98.4/index.iife.min.js',
        () => typeof win.solanaWeb3?.Connection === 'function' && typeof win.solanaWeb3?.Transaction === 'function'
            && typeof win.solanaWeb3?.PublicKey === 'function');

    win.ensureWalletVendors = function ensureWalletVendors(chain) {
        if (chain === 'evm') return ethereum();
        if (chain === 'solana') return solana();
        if (chain === undefined) return Promise.all([ethereum(), solana()]).then(ready => ready.every(Boolean));
        return Promise.resolve(false);
    };
})(window);
