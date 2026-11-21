// Private preview URLs contain an opaque reference only. Fetch each immutable object separately.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.DraftLink = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const MAX_OBJECT_BYTES = 10 * 1024 * 1024;
    // Requests a draft keeps in flight at once: a plan's members and their ground bindings were
    // fetched one after another, ~66 round trips for a 33-design plan with nothing on screen.
    const CONCURRENCY = 6;
    // Maps items through an async function, at most `limit` at a time, results in input order.
    // `onSettled(done, total)` is called after each item.
    async function mapLimit(items, limit, fn, onSettled) {
        const results = new Array(items.length);
        let next = 0, done = 0;
        async function worker() {
            while (next < items.length) {
                const index = next++;
                results[index] = await fn(items[index], index);
                done += 1;
                if (onSettled) onSettled(done, items.length);
            }
        }
        await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
        return results;
    }
    function reference(value) {
        const url = new URL(value);
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
            || url.username || url.password || url.search || url.hash
            || !/^\/mcp\/previews\/[\w-]{32}$/.test(url.pathname)) throw new Error('Invalid private draft reference');
        return url;
    }
    async function read(response) {
        if (!response.ok) throw new Error(response.status === 410
            ? 'This private draft expired. Ask the agent to generate it again.' : 'The private draft could not be loaded.');
        const reader = response.body.getReader(), chunks = []; let size = 0;
        try {
            for (;;) {
                const { value, done } = await reader.read(); if (done) break;
                size += value.byteLength;
                // One object plus its transport envelope, never a collection's combined geometry.
                if (size > MAX_OBJECT_BYTES + 64 * 1024) throw new Error('A private draft object exceeds 10 MiB');
                chunks.push(value);
            }
        } finally { await reader.cancel(); }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        return JSON.parse(new TextDecoder().decode(bytes));
    }
    // `onProgress({ done, total })` reports fetched collection members.
    async function load(href, { fetchImpl = root.fetch.bind(root), cidOf = value => root.Cid.cidOfObject(value), onProgress } = {}) {
        const value = new URL(href).searchParams.get('draft');
        if (!value) return null;
        const base = reference(value);
        async function get(ref, expectedCid) {
            const url = reference(ref);
            if (url.origin !== base.origin) throw new Error('Draft members must come from the same preview server');
            const row = await read(await fetchImpl(url.href, { credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error' }));
            if (!['design/v1', 'agreement/v1', 'plan/v1'].includes(row.record?.schema)
                || row.cid !== cidOf(row.record) || (expectedCid && row.cid !== expectedCid)) throw new Error('The private draft does not match its content identifier');
            return row;
        }
        const row = await get(base.href);
        if (row.record.schema === 'design/v1') return { design: row.record, parcelSourceId: row.parcelSourceId };
        if (!Array.isArray(row.designs) || !row.designs.length) throw new Error('The private collection has no designs');
        const designs = [], designSources = {};
        const namedPlan = row.record.schema === 'plan/v1';
        if (!namedPlan && (row.plan?.content?.schema !== 'plan/v1' || row.plan.cid !== row.record.planCid
            || cidOf(row.plan.content) !== row.plan.cid)) throw new Error('The private agreement does not match its saved plan');
        if (onProgress) onProgress({ done: 0, total: row.designs.length });
        const children = await mapLimit(row.designs, CONCURRENCY, member => get(member.draftRef, member.cid),
            onProgress && ((done, total) => onProgress({ done, total })));
        row.designs.forEach((member, index) => {
            const child = children[index];
            if (child.record.schema !== 'design/v1' || (!namedPlan && child.parcelSourceId !== row.parcelSourceId)
                || (row.designSources && Object.hasOwn(row.designSources, member.cid)
                    && child.parcelSourceId !== row.designSources[member.cid])) throw new Error('Invalid private collection member');
            designs.push(child.record);
            designSources[member.cid] = child.parcelSourceId;
        });
        return { [row.record.schema === 'plan/v1' ? 'plan' : 'agreement']: row.record, designs, parcelSourceId: row.parcelSourceId,
            ...(!namedPlan ? { plan: row.plan.content } : {}),
            ...(namedPlan && row.designSources ? { designSources } : {}) };
    }
    return { reference, load, mapLimit, CONCURRENCY, MAX_OBJECT_BYTES };
});
