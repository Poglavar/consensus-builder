// The words of the shared satellite-page header (css/page-chrome.css) in the four UI languages, for
// the pages that translate themselves by script without the app's i18n tables
// (floor-plan-archive.html, parcel-coverage-report.html). CbPageHeader.apply(lang) rewrites every
// [data-page-header-key] element; pages on the app's i18n use their own keys instead.
(function attachPageHeader(root) {
    'use strict';

    const STRINGS = Object.freeze({
        backToMap: Object.freeze({ en: 'Back to the map', es: 'Volver al mapa', hr: 'Natrag na kartu', sr: 'Nazad na mapu' })
    });

    // A missing key is a page bug, so it throws; a language without a translation falls back to English.
    function text(key, lang) {
        const entry = STRINGS[key];
        if (!entry) throw new Error(`page header: no string "${key}"`);
        return entry[lang] || entry.en;
    }

    function apply(lang, scope) {
        const base = scope || (root && root.document);
        if (!base || typeof base.querySelectorAll !== 'function') return;
        base.querySelectorAll('[data-page-header-key]').forEach(node => {
            node.textContent = text(node.getAttribute('data-page-header-key'), lang);
        });
    }

    const api = Object.freeze({ STRINGS, text, apply });
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CbPageHeader = api;
})(typeof window !== 'undefined' ? window : globalThis);
