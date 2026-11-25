// Enter submits a form from its text fields only. Chrome also submits on Enter in a select, a
// checkbox, a radio and the other non-text inputs (implicit submission), which sent half-finished
// forms such as an agreement or a feedback report; there Enter now does nothing. One capture-phase
// listener on the page covers every form, also in dialogs that stop keys reaching the page.
// Buttons, links and textareas keep their own Enter; arrows and Space still work the select.
// Loaded by every page with such a form (index.html, feedback.html); it has no dependencies.
(function attachFormEnter(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) {
        root.CbFormEnter = api;
        api.install(root.document);
    }
})(typeof window !== 'undefined' ? window : null, function formEnterFactory() {
    'use strict';

    const NO_IMPLICIT_SUBMIT_INPUTS = new Set(['checkbox', 'radio', 'range', 'color', 'file']);

    function blocksImplicitSubmit(target) {
        if (!target || !target.form) return false;
        if (target.tagName === 'SELECT') return true;
        return target.tagName === 'INPUT' && NO_IMPLICIT_SUBMIT_INPUTS.has(String(target.type || '').toLowerCase());
    }

    function onKeydown(event) {
        if (event.key === 'Enter' && !event.isComposing && blocksImplicitSubmit(event.target)) event.preventDefault();
    }

    // Idempotent per document, so a page that loads the script twice still has one listener.
    function install(doc) {
        if (!doc || typeof doc.addEventListener !== 'function' || doc.__cbFormEnterInstalled) return;
        doc.__cbFormEnterInstalled = true;
        doc.addEventListener('keydown', onKeydown, true);
    }

    return Object.freeze({ blocksImplicitSubmit, install });
});
