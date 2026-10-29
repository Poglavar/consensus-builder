// Whether a design may be published on its own (plan-design-agreement.md): the one choke point the
// share, publish and walk paths consult before a design is published. Pure: no DOM.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalPublishTerms = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    function text(key, fallback) {
        try {
            const value = root.i18n?.t?.(key);
            if (value && value !== key) return value;
        } catch (_) { }
        return fallback;
    }

    /**
     * Why a design may not be published on its own, or null: invalid content, or more than the
     * publication limit. Every kind of design, parcel layouts included, is shareable by itself.
     */
    function publishRefusal(record) {
        if (!record) return null;
        const api = root.DesignRecord || (typeof require === 'function' ? require('../design-record.js') : null);
        if (!api) throw new Error('DesignRecord is not loaded.');
        let bytes;
        try { bytes = api.publicationSize(record); } catch (error) {
            return { code: error.code || 'invalid-design', message: text('proposals.share.errors.invalidDesign', 'This design contains invalid data. Correct it before sharing.') };
        }
        return bytes > api.MAX_PUBLISHED_OBJECT_BYTES ? {
            code: 'too-large', bytes, maxBytes: api.MAX_PUBLISHED_OBJECT_BYTES,
            message: text('proposals.share.errors.tooLarge', 'This design exceeds the 10 MiB publication limit. Reduce its extent or detail before sharing; it is saved locally.')
        } : null;
    }

    return Object.freeze({ publishRefusal });
});
