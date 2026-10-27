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
    // A source response must not cancel an in-flight build of an unrelated family. Collect
    // synchronous notifications and drain later requests before resolving entry's await.
    function createRefreshQueue(build) {
        let batch = null;
        return {
            get pending() { return batch !== null; },
            request(family = 'all') {
                if (!batch) {
                    const current = { families: new Set() };
                    batch = current;
                    current.promise = Promise.resolve().then(async () => {
                        try {
                            while (batch === current && current.families.size) {
                                const families = current.families;
                                current.families = new Set();
                                await build(families.has('all') || families.size > 1 ? 'all' : [...families][0]);
                            }
                        } finally {
                            if (batch === current) batch = null;
                        }
                    });
                }
                batch.families.add(family);
                return batch.promise;
            },
            cancel() { batch = null; }
        };
    }
    return { forEach, geometryBytes, createRefreshQueue };
});
