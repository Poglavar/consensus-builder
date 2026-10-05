// One capture-phase Escape owner for blocking UI. Modal implementations register their real close
// callback while open; the router never guesses how to hide a component or repair its state.
(function attachModalEscape(root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ModalEscape = api;
})(typeof window !== 'undefined' ? window : globalThis, function modalEscapeFactory(root) {
    'use strict';

    function visible(element, doc) {
        for (let current = element; current; current = current.parentElement) {
            if (current.isConnected === false || current.hidden) return false;
            const style = doc?.defaultView?.getComputedStyle?.(current);
            if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
        }
        return !!element;
    }

    function zIndex(element, doc) {
        const value = doc?.defaultView?.getComputedStyle?.(element)?.zIndex ?? element?.style?.zIndex;
        const number = Number.parseInt(value, 10);
        return Number.isFinite(number) ? number : 0;
    }

    function createRouter(doc = root?.document) {
        const registrations = new Set();
        let sequence = 0;
        const compareStacking = (left, right) => {
            const byZ = zIndex(right.element, doc) - zIndex(left.element, doc);
            if (byZ) return byZ;
            const relation = left.element?.compareDocumentPosition?.(right.element) || 0;
            // With equal z-index, a later sibling paints over its predecessor.
            if (relation & 4) return 1;
            if (relation & 2) return -1;
            return right.order - left.order;
        };
        const topmost = () => Array.from(registrations)
            .filter(entry => entry.blocking && visible(entry.element, doc))
            .sort(compareStacking)[0] || null;
        const onKeydown = event => {
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            const entry = topmost();
            if (!entry) return;
            // A modal can decline this key for a child control (the globe search results use their
            // own Escape first). Every ordinary dismiss callback handles the key implicitly.
            if (entry.dismiss(event) === false) return;
            event.preventDefault();
            event.stopImmediatePropagation();
        };
        doc?.addEventListener?.('keydown', onKeydown, true);
        return {
            register(element, dismiss, { blocking = true } = {}) {
                if (!element || typeof dismiss !== 'function') return () => {};
                const entry = { element, dismiss, blocking, order: ++sequence };
                registrations.add(entry);
                return () => registrations.delete(entry);
            },
            destroy() { doc?.removeEventListener?.('keydown', onKeydown, true); registrations.clear(); },
            topmost,
            size: () => registrations.size
        };
    }

    const router = createRouter(root?.document);
    return { register: router.register, createRouter, topmost: router.topmost };
});
