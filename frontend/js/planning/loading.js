// What is still loading for each Buildings and massing role (built, permitted, proposed), by the
// code loading it. Loaded before the map, so the first fetches report too; planning/views.js
// draws it in the Buildings and massing button and the corresponding panel sections.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanningLoading = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';
    const sources = { existing: new Set(), permitted: new Set(), proposed: new Set() };
    const bytes = { existing: 0, permitted: 0, proposed: 0 };
    let progressTimer = null;
    function notify() {
        root?.dispatchEvent(new CustomEvent('planningloadingchange', { detail: state() }));
    }
    // set('existing', 'map', true) while the map's buildings fetch runs; false when it ends.
    function set(role, source, on) {
        const holders = sources[role];
        if (!holders) throw new Error(`Unknown Buildings and massing role: ${role}`);
        if (holders.has(source) === !!on) return;
        if (on) {
            if (!holders.size) bytes[role] = 0;
            holders.add(source);
        } else holders.delete(source);
        notify();
    }
    function state() {
        return Object.fromEntries(Object.entries(sources).map(([role, holders]) => [role, holders.size > 0]));
    }
    function track(role, pending) {
        const holder = Symbol(role);
        set(role, holder, true);
        return Promise.resolve(pending).finally(() => set(role, holder, false));
    }
    function addBytes(role, delta) {
        if (!sources[role]?.size || !Number.isFinite(delta) || delta <= 0) return;
        bytes[role] += delta;
        if (progressTimer === null) progressTimer = setTimeout(() => {
            progressTimer = null;
            notify();
        }, 100);
    }
    // Tap the body the consumer already reads. Preserve redirects, status and headers for
    // provider adapters that validate the final URL and bound their own streaming reads.
    function countedResponse(response, onBytes) {
        if (!onBytes || !response.ok || !response.body?.pipeThrough || typeof TransformStream !== 'function') return response;
        const stream = response.body.pipeThrough(new TransformStream({
            transform(chunk, controller) {
                onBytes(chunk.byteLength);
                controller.enqueue(chunk);
            }
        }));
        const counted = new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
        return Object.defineProperties(counted, {
            url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type }
        });
    }
    // Fetch exposes decoded body bytes, including bodies served from the browser cache.
    async function readJson(role, response) {
        const transfer = beginTransfer(role);
        try {
            return await countedResponse(response, transfer.add).json();
        } finally {
            transfer.end();
        }
    }
    // The map, model and overlapping requests share one total per continuous period of work.
    function beginTransfer(role) {
        const holder = Symbol(role);
        set(role, holder, true);
        let ended = false;
        return {
            add(delta) {
                if (!ended) addBytes(role, delta);
            },
            end() {
                if (ended) return;
                ended = true;
                set(role, holder, false);
            }
        };
    }
    return { set, state, track, countedResponse, readJson, beginTransfer, addBytes, bytesLoaded: role => bytes[role] };
});
