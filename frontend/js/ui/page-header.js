// Apply the shared satellite-page header copy from the selected language dictionary.
(function attachPageHeader(root) {
    'use strict';
    function text(key) {
        return root.i18n.t(`pageHeader.${key}`);
    }
    function apply(scope = root.document) {
        scope.querySelectorAll('[data-page-header-key]').forEach(node => {
            node.textContent = text(node.getAttribute('data-page-header-key'));
        });
    }
    root.CbPageHeader = Object.freeze({ text, apply });
})(typeof window !== 'undefined' ? window : globalThis);
