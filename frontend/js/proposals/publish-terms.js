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
     * Why a design may not be published on its own, or null. A parcel layout (plan-design-agreement.md,
     * M1 (a)) is published with the agreement that includes it (POST /agreements), never alone; the
     * code is the index's own refusal of one (POST /designs).
     */
    function publishRefusal(record) {
        if (!record || record.goal !== 'parcel-layout') return null;
        return {
            code: 'layout-needs-agreement',
            message: text('parcelLayout.publishWithAgreement', 'A parcel layout is published with its agreement. Propose an agreement that includes it.')
        };
    }

    return Object.freeze({ publishRefusal });
});
