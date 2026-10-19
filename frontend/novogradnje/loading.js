(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(root);
    else root.NovogradnjeLoading = factory(root);
}(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const active = new WeakMap();

    function start(host, label = 'Učitavanje…') {
        const document = host.ownerDocument || root.document;
        const indicator = document.createElement('div');
        indicator.className = 'loading-indicator';
        indicator.setAttribute('role', 'status');
        indicator.setAttribute('aria-label', label);
        const text = document.createElement('span');
        text.className = 'sr-only';
        text.textContent = label;
        indicator.appendChild(text);

        let pending = active.get(host);
        if (!pending) {
            pending = new Set();
            active.set(host, pending);
        }
        pending.add(indicator);
        host.appendChild(indicator);
        host.classList.add('is-loading');
        host.setAttribute('aria-busy', 'true');

        let stopped = false;
        return function stop() {
            if (stopped) return;
            stopped = true;
            indicator.remove();
            pending.delete(indicator);
            if (pending.size === 0) {
                active.delete(host);
                host.classList.remove('is-loading');
                host.setAttribute('aria-busy', 'false');
            }
        };
    }

    function media(host, element, label) {
        const stop = start(host, label);
        let cleaned = false;
        function cleanup() {
            if (cleaned) return;
            cleaned = true;
            element.removeEventListener('load', cleanup);
            element.removeEventListener('error', cleanup);
            stop();
        }
        element.addEventListener('load', cleanup);
        element.addEventListener('error', cleanup);
        if (element.tagName === 'IMG' && element.complete) cleanup();
        return cleanup;
    }

    return { start, media };
}));
