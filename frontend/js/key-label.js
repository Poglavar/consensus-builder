// How a Solana key is shown to people, as Tokenizario shows it: a portrait and ring colour derived
// from the key (the same 16 portraits and hash, so a key looks the same in both apps), the name the
// key gave itself labelled "self-described", and the short key; the full key on hover.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root?.document) root.KeyLabel = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const PORTRAITS = 16;
    // Tokenizario's utils/avatar.ts: a 31-multiplier hash of the lower-cased address.
    function hashOf(address) { let hash = 0; const s = String(address || '').trim().toLowerCase(); for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0; return hash >>> 0; }
    const portrait = address => `avatars/avatar${(hashOf(address) % PORTRAITS) + 1}.png`;
    function ring(address) { const h = hashOf(address); const hue = h % 360, sat = Math.min(90, 55 + (h % 25) + 10), light = Math.max(28, 42 + (h % 12) - 8); return `hsl(${hue} ${sat}% ${light}%)`; }
    const short = key => { const s = String(key || ''); return s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s; };

    // Names keys gave themselves: lens members register theirs in the lens directory.
    const names = new Map();
    let loading = null;
    function loadNames() {
        if (loading || !root.LensServiceClient?.fetchDirectory) return loading || Promise.resolve();
        loading = root.LensServiceClient.fetchDirectory({ base: root.resolveBackendBaseUrl?.() || '', fetchImpl: root.fetch.bind(root) })
            .then(directory => { for (const member of directory?.members || []) if (member.key && member.name) names.set(member.key, member.name); })
            .catch(error => { console.warn(`[${new Date().toISOString()}] [KeyLabel] lens directory not loaded`, error); loading = null; });
        return loading;
    }
    const nameOf = key => names.get(key) || null;

    /** An inline label: <span class="key-label"><img> name (self-described) · Ab12…Cd34</span>. */
    function element(key, { you = false, t = (k, f) => f } = {}) {
        const doc = root.document;
        const wrap = doc.createElement('span'); wrap.className = 'key-label'; wrap.title = key;
        wrap.style.setProperty('--key-ring', ring(key));
        const img = doc.createElement('img'); img.className = 'key-label__portrait'; img.src = portrait(key); img.alt = ''; img.width = 20; img.height = 20;
        const text = doc.createElement('span'); text.className = 'key-label__text';
        const name = nameOf(key);
        const parts = [];
        if (you) parts.push(t('keyLabel.you', 'You'));
        if (name) parts.push(`${name} (${t('keyLabel.selfDescribed', 'self-described')})`);
        parts.push(short(key));
        text.textContent = parts.join(' · ');
        wrap.append(img, text);
        return wrap;
    }
    return { hashOf, portrait, ring, short, loadNames, nameOf, element, remember: (key, name) => { if (key && name) names.set(key, name); } };
});
