// Small, dependency-free helpers shared by the classic <script> files (HTML escaping, cloning).
// Loaded before every consumer so these resolve as ordinary globals. Each of these helpers
// previously existed in 2-6 copies across files; because a top-level `function` in a classic
// script is a global, the last file loaded silently won for every caller. Keep this file free of
// DOM and app dependencies so it can stay first in the load order.

const HTML_ESCAPE_CHARS = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
};

// Escapes text for interpolation into HTML. Quotes are escaped too, so the result is also safe
// inside a quoted attribute value. null/undefined yield '' (not the strings "null"/"undefined").
function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    try {
        return String(value).replace(/[&<>"']/g, char => HTML_ESCAPE_CHARS[char]);
    } catch (_) {
        return '';
    }
}

function deepClone(value) {
    try {
        if (value === undefined) return undefined;
        return JSON.parse(JSON.stringify(value));
    } catch (_) {
        return null;
    }
}

function deepCloneArray(values) {
    if (!Array.isArray(values)) return [];
    return values.map(item => deepClone(item));
}

function ensureArrayOfStrings(list) {
    if (!Array.isArray(list)) return [];
    return list
        .map(value => {
            if (value === null || value === undefined) return '';
            try {
                return value.toString();
            } catch (_) {
                return '';
            }
        })
        .filter(Boolean);
}

// Deterministic JSON: object keys sorted at every nesting level, array order preserved. Unlike
// `JSON.stringify(obj, keysArray)` — an array replacer is an allowlist applied at ALL levels, so it
// silently DROPS any nested key not in the top-level list — this keeps nested keys, so two objects
// that differ only in a nested value serialize differently. Used for stable proposal hash seeds.
// (For a FLAT object it yields exactly the same string the old array-replacer did, so existing
// hashes/ids are unchanged.)
function stableStringify(value) {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return '[' + value.map(stableStringify).join(',') + ']';
    }
    const keys = Object.keys(value).sort();
    return '{' + keys.map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

// Node-only: lets backend/test/proposals-sharing-utils.test.js unit-test these without a browser.
// The browser is unaffected by this block (`module` is undefined there).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        escapeHtml,
        deepClone,
        deepCloneArray,
        ensureArrayOfStrings,
        stableStringify
    };
}
