// Colours that identify a lens key in the lens pattern: two palette slots from a hash of the whole
// key, so any key format (Solana base58, EVM hex, a name) gets a stable, distinct pair.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.LensPattern = api;
})(typeof window === 'undefined' ? null : window, function () {
    // FNV-1a over the key's UTF-16 code units: fast, synchronous and spreads one-character changes.
    function hashKey(key) {
        let hash = 0x811c9dc5;
        for (let i = 0; i < key.length; i++) {
            hash ^= key.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        return hash;
    }

    // EVM addresses are case-insensitive; base58 keys are not, so only 0x keys are lower-cased.
    function canonicalKey(address) {
        const key = String(address || '').trim();
        return /^0x[0-9a-f]+$/i.test(key) ? key.toLowerCase() : key;
    }

    /** [top, bottom] palette indexes for a key; the two differ, so each stripe shows two colours. */
    function keyColorIndexes(address, paletteSize) {
        if (!Number.isInteger(paletteSize) || paletteSize < 2) throw new RangeError('paletteSize must be an integer of at least 2.');
        const hash = hashKey(canonicalKey(address));
        const top = hash % paletteSize;
        const bottom = (top + 1 + (Math.floor(hash / paletteSize) % (paletteSize - 1))) % paletteSize;
        return [top, bottom];
    }

    return { keyColorIndexes };
});
