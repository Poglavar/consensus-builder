// The one home for persistent notices (ephemerals.md): a parcel or building source that failed,
// another tab holding this city, the explore banner. They mount in one stack under the top row of
// controls that reads as one card, each banner a section of it; the notices (js/ui-helpers.js)
// move below it through --cb-banner-stack-height, set on the map container as the stack grows
// and shrinks.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__BannerStack = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const STACK_ID = 'cb-banner-stack';
    const GAP_PX = 8;
    let observed = null;

    function host() {
        const doc = root.document;
        return doc ? (doc.getElementById('map-container') || doc.body) : null;
    }

    function measure() {
        const doc = root.document;
        const stack = doc && doc.getElementById(STACK_ID);
        const target = host();
        if (!stack || !target || !target.style || typeof target.style.setProperty !== 'function') return;
        const height = (stack.children && stack.children.length && typeof stack.getBoundingClientRect === 'function')
            ? Math.round(stack.getBoundingClientRect().height) : 0;
        target.style.setProperty('--cb-banner-stack-height', height > 0 ? `${height + GAP_PX}px` : '0px');
    }

    function ensure() {
        const doc = root.document;
        if (!doc) return null;
        let stack = doc.getElementById(STACK_ID);
        if (!stack) {
            const target = host();
            if (!target) return null;
            stack = doc.createElement('div');
            stack.id = STACK_ID;
            stack.className = 'cb-banner-stack';
            target.appendChild(stack);
        }
        if (observed !== stack) {
            observed = stack;
            try {
                if (typeof root.ResizeObserver === 'function') new root.ResizeObserver(measure).observe(stack);
                if (typeof root.MutationObserver === 'function') new root.MutationObserver(measure).observe(stack, { childList: true, subtree: true, attributes: true });
            } catch (_) { /* no observers here: measured on mount only */ }
        }
        return stack;
    }

    function mount(el) {
        const stack = ensure();
        if (!stack || !el) return null;
        stack.appendChild(el);
        measure();
        return stack;
    }

    return Object.freeze({ STACK_ID, ensure, mount, measure });
});
