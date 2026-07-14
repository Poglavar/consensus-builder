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

// Node-only: lets backend/test/proposals-sharing-utils.test.js unit-test these without a browser.
// The browser is unaffected by this block (`module` is undefined there).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        escapeHtml,
        deepClone,
        deepCloneArray,
        ensureArrayOfStrings
    };
}
