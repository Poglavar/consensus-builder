// The theme switch: every component reads css/tokens.css, and the dark set of tokens applies when
// <html> carries data-theme="dark". The choice (system / light / dark) lives in this browser;
// "system" follows the OS. Loaded before the stylesheets paint anything, so there is no flash.
// Settings → Appearance drives it through [data-theme-choice] buttons (index.html).
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CbTheme = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const STORAGE_KEY = 'cb.theme';
    const MODES = ['system', 'light', 'dark'];
    let mode = 'system';
    let media = null;

    function read() {
        try {
            const stored = root.localStorage && root.localStorage.getItem(STORAGE_KEY);
            return MODES.includes(stored) ? stored : 'system';
        } catch (_) {
            return 'system';
        }
    }

    function prefersDark() {
        try {
            return !!(root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches);
        } catch (_) {
            return false;
        }
    }

    /** The theme in effect for a mode: 'light' or 'dark'. */
    function resolve(which) {
        if (which === 'dark') return 'dark';
        if (which === 'light') return 'light';
        return prefersDark() ? 'dark' : 'light';
    }

    function apply() {
        const doc = root.document;
        if (!doc || !doc.documentElement) return;
        const effective = resolve(mode);
        if (effective === 'dark') doc.documentElement.setAttribute('data-theme', 'dark');
        else doc.documentElement.removeAttribute('data-theme');
        doc.querySelectorAll && doc.querySelectorAll('[data-theme-choice]').forEach(button => {
            button.setAttribute('aria-pressed', button.getAttribute('data-theme-choice') === mode ? 'true' : 'false');
        });
        try {
            doc.dispatchEvent(new CustomEvent('cb:theme', { detail: { mode, theme: effective } }));
        } catch (_) { /* no CustomEvent here */ }
    }

    function set(next) {
        mode = MODES.includes(next) ? next : 'system';
        try { root.localStorage && root.localStorage.setItem(STORAGE_KEY, mode); } catch (_) { /* private mode */ }
        apply();
        return mode;
    }

    function get() {
        return mode;
    }

    function bind() {
        const doc = root.document;
        if (!doc) return;
        doc.addEventListener('click', event => {
            const button = event.target && event.target.closest ? event.target.closest('[data-theme-choice]') : null;
            if (button) set(button.getAttribute('data-theme-choice'));
        });
        apply();
    }

    mode = read();
    apply();
    try {
        media = root.matchMedia ? root.matchMedia('(prefers-color-scheme: dark)') : null;
        if (media && typeof media.addEventListener === 'function') media.addEventListener('change', () => { if (mode === 'system') apply(); });
    } catch (_) { /* no media queries here */ }
    if (root.document) {
        if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', bind);
        else bind();
    }

    return Object.freeze({ MODES, STORAGE_KEY, get, set, resolve, apply });
});
