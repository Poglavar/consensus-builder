// Keep global navigation stationary; fit the inspection column around visible bottom controls.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root?.document) {
        root.DockClearance = api;
        if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', () => api.install(root), { once: true });
        else api.install(root);
    }
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    function bottomInset({ width, height, dockWidth, dockGap, gap, obstacles }) {
        const left = width - dockGap - dockWidth;
        return Math.ceil(obstacles.reduce((inset, rect) => {
            if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.top >= height) return inset;
            if (rect.right + gap <= left || rect.left - gap >= width - dockGap) return inset;
            return Math.max(inset, height - rect.top + gap);
        }, dockGap));
    }

    function install(win) {
        const doc = win.document, body = doc.body, variables = doc.documentElement.style;
        const navigation = doc.getElementById('map-shell-bottom-right');
        const feedback = doc.getElementById('map-feedback-stack');
        if (!navigation || !feedback) return;
        const update = () => {
            if (win.innerWidth < 768) { variables.removeProperty('--right-dock-clearance'); return; }
            const style = win.getComputedStyle(body);
            const obstacles = [navigation, ...feedback.children].flatMap(element => {
                const computed = win.getComputedStyle(element);
                if (computed.visibility === 'hidden' || element.classList.contains('is-idle')) return [];
                return [element.getBoundingClientRect()];
            });
            const value = `${bottomInset({ width: win.innerWidth, height: win.innerHeight,
                dockWidth: parseFloat(style.getPropertyValue('--right-dock-width')),
                dockGap: parseFloat(style.getPropertyValue('--right-dock-gap')),
                gap: parseFloat(style.getPropertyValue('--map-shell-gap')), obstacles })}px`;
            if (variables.getPropertyValue('--right-dock-clearance') !== value) variables.setProperty('--right-dock-clearance', value);
        };
        const resize = new win.ResizeObserver(update);
        resize.observe(navigation); resize.observe(feedback);
        // The app updates its viewport height after window resize; controls can move without
        // changing their own sizes. Recheck once their containing map has actually resized.
        const map = doc.getElementById('map-container');
        if (map) resize.observe(map);
        const mutation = new win.MutationObserver(update);
        mutation.observe(navigation, { attributes: true, childList: true, subtree: true, characterData: true });
        mutation.observe(feedback, { attributes: true, childList: true, subtree: true, characterData: true });
        mutation.observe(body, { attributes: true, attributeFilter: ['class'] });
        win.addEventListener('resize', update);
        doc.fonts?.ready.then(update);
        update();
    }

    return { bottomInset, install };
});
