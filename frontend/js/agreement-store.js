// The agreements of this device (plan-design-agreement.md, M1 (b)): one JSON row per agreement at
// `agreement:<id>` in the city's storage, next to the `proposal:<id>` rows. Saving normalizes and
// stamps the record.
//
// create({ storage, normalize?, now? }) builds a store over any PersistentStorage-shaped
// object (getItem, setItem, removeItem, forEach), so a node test can drive it; window.AgreementStore
// is the browser instance over window.PersistentStorage.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root.document !== 'undefined') {
        // Resolved at call time: the storage and the record module may load after this file.
        root.AgreementStore = Object.freeze({
            ...api.create({
                storage: () => root.PersistentStorage
            }),
            create: api.create
        });
    }
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const KEY_PREFIX = 'agreement:';

    const recordApi = () => root.AgreementRecord || (typeof require === 'function' ? require('./agreement-record.js') : null);
    const idOf = value => (value === undefined || value === null ? '' : String(value).trim());

    // A subscriber that throws must not undo or hide a write that already happened: its error is
    // raised on its own, after the write and the other subscribers, so it still fails loudly.
    function raiseLater(error) {
        if (typeof queueMicrotask === 'function') queueMicrotask(() => { throw error; });
        else console.error('[AgreementStore] subscriber failed', error);
    }

    function create({ storage, normalize, now } = {}) {
        const subscribers = new Set();

        function store() {
            const resolved = typeof storage === 'function' ? storage() : storage;
            if (!resolved || typeof resolved.getItem !== 'function') throw new Error('AgreementStore has no storage.');
            return resolved;
        }

        function normalized(raw) {
            if (typeof normalize === 'function') return normalize(raw);
            const records = recordApi();
            if (!records || typeof records.normalize !== 'function') throw new Error('AgreementRecord is unavailable.');
            return records.normalize(raw);
        }

        function stamp() {
            const date = typeof now === 'function' ? now() : new Date();
            return (date instanceof Date ? date : new Date(date)).toISOString();
        }

        function notify(change) {
            Array.from(subscribers).forEach(listener => {
                try { listener(change); } catch (error) { raiseLater(error); }
            });
        }

        // A row that is not JSON is a bug in whatever wrote it; it is named, never skipped.
        function parse(key, text) {
            try {
                return JSON.parse(text);
            } catch (error) {
                const problem = new Error(`Stored agreement ${key} is not valid JSON.`);
                problem.code = 'invalid-agreement-row';
                problem.cause = error;
                throw problem;
            }
        }

        function keyOf(id) {
            const value = idOf(id);
            if (!value) throw new TypeError('An agreement id is required.');
            return KEY_PREFIX + value;
        }

        function get(id) {
            const value = idOf(id);
            if (!value) return null;
            const key = KEY_PREFIX + value;
            const text = store().getItem(key);
            return text === null || text === undefined ? null : parse(key, text);
        }

        // Newest first by creation time; the id breaks ties, so the order never depends on storage.
        function list() {
            const rows = [];
            // PersistentStorage.forEach swallows what its iterator throws: only collect inside it.
            store().forEach((value, key) => {
                if (typeof key === 'string' && key.startsWith(KEY_PREFIX)) rows.push([key, value]);
            });
            return rows.map(([key, value]) => parse(key, value)).sort((a, b) => {
                const at = String(a && a.createdAt || '');
                const bt = String(b && b.createdAt || '');
                if (at !== bt) return at < bt ? 1 : -1;
                return String(a && a.id || '').localeCompare(String(b && b.id || ''));
            });
        }

        // Normalizes, stamps updatedAt (and createdAt when it is missing), writes, notifies, and
        // returns what was stored.
        function save(agreement) {
            if (!agreement || typeof agreement !== 'object') throw new TypeError('save() needs an agreement.');
            const at = stamp();
            const record = normalized({ ...agreement, createdAt: agreement.createdAt || at, updatedAt: at });
            if (!record.createdAt) record.createdAt = agreement.createdAt || at;
            record.updatedAt = at;
            const key = keyOf(record.id);
            store().setItem(key, JSON.stringify(record));
            notify({ type: 'save', id: record.id, agreement: record });
            return record;
        }

        function remove(id) {
            const key = keyOf(id);
            const storage = store();
            if (storage.getItem(key) === null) return false;
            storage.removeItem(key);
            notify({ type: 'remove', id: idOf(id) });
            return true;
        }

        // Every agreement row of this city goes; nothing else in the storage is touched.
        function clear() {
            const storage = store();
            const keys = [];
            storage.forEach((_value, key) => {
                if (typeof key === 'string' && key.startsWith(KEY_PREFIX)) keys.push(key);
            });
            keys.forEach(key => storage.removeItem(key));
            if (keys.length) notify({ type: 'clear', ids: keys.map(key => key.slice(KEY_PREFIX.length)) });
            return keys.length;
        }

        function subscribe(listener) {
            if (typeof listener !== 'function') throw new TypeError('subscribe() needs a function.');
            subscribers.add(listener);
            return () => subscribers.delete(listener);
        }

        return Object.freeze({ KEY_PREFIX, list, get, save, remove, clear, subscribe });
    }

    return Object.freeze({ KEY_PREFIX, create });
});
