// Browser-local working copies; immutable offer terms live only in content.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root?.document) root.PropertyOfferStore = api.create({ storage: () => root.PersistentStorage });
})(typeof window === 'undefined' ? null : window, function () {
    'use strict';
    const PREFIX = 'property-offer:';
    // Copies of offers made under property-offer/v1 belong to the retired program and are not listed.
    const SCHEMA = 'property-offer/v2';
    const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
    function create({ storage } = {}) {
        const listeners = new Set();
        const db = () => typeof storage === 'function' ? storage() : storage;
        function notify(change) { for (const listener of listeners) { try { listener(change); } catch (error) { queueMicrotask(() => { throw error; }); } } }
        function get(id) { const raw = db().getItem(PREFIX + id); return raw == null ? null : JSON.parse(raw); }
        function list() {
            const rows = [];
            db().forEach((raw, key) => { if (key.startsWith(PREFIX)) rows.push(raw); });
            return rows.map(raw => JSON.parse(raw)).filter(row => row.content?.schema === SCHEMA).sort((a, b) => String(b.content.createdAt).localeCompare(String(a.content.createdAt)) || a.id.localeCompare(b.id));
        }
        function save(record) {
            if (!record?.id || record.content?.schema !== SCHEMA) throw new TypeError('A property offer working copy is required.');
            const prior = get(record.id);
            if (prior?.published && (JSON.stringify(stable(prior.content)) !== JSON.stringify(stable(record.content)) || prior.published.cid !== record.published?.cid)) {
                throw new Error('Published offer terms are immutable. Create a new offer.');
            }
            const saved = JSON.parse(JSON.stringify({ ...record, updatedAt: new Date().toISOString() }));
            db().setItem(PREFIX + saved.id, JSON.stringify(saved)); notify({ type: 'save', id: saved.id }); return saved;
        }
        function remove(id) { if (!get(id)) return false; db().removeItem(PREFIX + id); notify({ type: 'remove', id }); return true; }
        function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
        return Object.freeze({ get, list, save, remove, subscribe });
    }
    return { create };
});
