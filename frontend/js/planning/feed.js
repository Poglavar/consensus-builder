// Load a complete viewport from bounded source pages. No persistent or cross-viewport cache.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanningFeed = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    async function loadViewport(url, { city, signal, fetchPage = fetch, onProgress = () => {} }) {
        const items = new Map(), summaries = new Map(), cursors = new Set();
        const pageUrl = new URL(url);
        let cursor = null, omitted = 0, answer;
        do {
            signal?.throwIfAborted();
            if (cursor) pageUrl.searchParams.set('cursor', cursor);
            const response = await fetchPage(pageUrl.toString(), { signal, cache: 'no-store' });
            if (!response.ok) throw Object.assign(new Error(`Planning source HTTP ${response.status}`), { status: response.status });
            answer = await response.json();
            signal?.throwIfAborted();
            if (answer.schemaVersion !== 'planning-representations.v1' || answer.city !== city || !Array.isArray(answer.items)
                || (answer.nextCursor !== null && typeof answer.nextCursor !== 'string')
                || Boolean(answer.truncated) !== Boolean(answer.nextCursor)) throw new Error('Invalid planning representation response');
            for (const item of answer.items) items.set(item.id, item);
            for (const summary of answer.summaries || []) summaries.set(summary.sourceId, summary);
            omitted += answer.omitted || 0;
            cursor = answer.nextCursor;
            if (cursor && cursors.has(cursor)) throw new Error('Repeated planning cursor');
            if (cursor) cursors.add(cursor);
            onProgress({ count: items.size + omitted, total: [...summaries.values()].reduce((sum, entry) => sum + entry.withGeometry, 0) });
        } while (cursor);
        return { ...answer, items: [...items.values()], summaries: [...summaries.values()], omitted };
    }
    return { loadViewport };
});
