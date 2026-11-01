// Compact display of existing record identifiers. These labels never become storage keys.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.RecordLabel = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const text = value => value == null ? '' : String(value);
    function shortId(id, peers = []) {
        const value = text(id);
        if (value.length <= 10) return value;
        const others = peers.map(text).filter(other => other !== value);
        let length = 8;
        while (length < value.length && others.some(other => other.endsWith(value.slice(-length)))) length += 4;
        return length >= value.length ? value : `…${value.slice(-length)}`;
    }
    function label(title, id, peers = []) {
        const name = text(title), key = text(id);
        if (!key) return name;
        return !name || name === key ? shortId(key, peers) : `${name} · ${shortId(key, peers)}`;
    }
    function badge(doc, id, peers = []) {
        const node = doc.createElement('code');
        node.className = 'record-id';
        node.textContent = shortId(id, peers);
        node.title = text(id);
        return node;
    }
    return Object.freeze({ shortId, label, badge });
});
