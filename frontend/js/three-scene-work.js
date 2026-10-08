// Cooperative scene work: inspect cancellation and the time budget after every item.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeSceneWork = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    async function forEach(items, visit, options = {}) {
        const now = options.now || (() => performance.now());
        const yieldTask = options.yieldTask || (() => new Promise(resolve => setTimeout(resolve, 0)));
        const isCurrent = options.isCurrent || (() => true);
        const budgetMs = options.budgetMs || 6;
        let start = now();
        for (let index = 0; index < items.length; index++) {
            if (!isCurrent()) return false;
            visit(items[index], index);
            if (now() - start >= budgetMs && index + 1 < items.length) {
                await yieldTask();
                start = now();
            }
        }
        return isCurrent();
    }
    function geometryBytes(scene) {
        const seen = new Set();
        let bytes = 0;
        scene?.traverse(object => {
            const geometry = object.geometry;
            if (!geometry || seen.has(geometry)) return;
            seen.add(geometry);
            for (const attr of Object.values(geometry.attributes || {})) bytes += attr.array?.byteLength || 0;
            bytes += geometry.index?.array?.byteLength || 0;
        });
        return bytes;
    }
    return { forEach, geometryBytes };
});
