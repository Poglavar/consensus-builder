// Canton price values do not carry a currency in the ledger contract. Keep the unit visible
// whenever an upstream parcel estimate supplies one, and call missing units unknown.
(function attachCantonReadPrice(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CantonReadPrice = api;
})(typeof window !== 'undefined' ? window : globalThis, function cantonReadPriceFactory() {
    'use strict';

    function currencyCode(value) {
        if (typeof value !== 'string') return null;
        const code = value.trim().toUpperCase();
        return /^[A-Z0-9]{2,8}$/.test(code) ? code : null;
    }

    function formatAmount(value, currency) {
        const code = currencyCode(currency);
        if (!['number', 'string'].includes(typeof value) || String(value).trim() === '' || !Number.isFinite(Number(value))) {
            return code ? `— ${code}` : '— (currency unknown)';
        }
        const amount = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(value));
        return code ? `${amount} ${code}` : `${amount} (currency unknown)`;
    }

    return Object.freeze({ currencyCode, formatAmount });
});
