// Durable flight transport stays cheap at startup; route opening is explicit and never autoplays.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) {
        root.CameraFlightShare = api;
        root.CameraFlightSharing = api.browser(root);
    }
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    function parsePath(path) { return /^\/flights\/([^/]+)\/?$/.exec(path)?.[1] || null; }
    function restoreUrl(href, view, mapShare) {
        const source = new URL(href);
        const saved = new URL(mapShare.link(source.origin + source.pathname, view));
        const hasMode = ['3d', 'photo', 'model', 'mode3d', 'real', 'rl', 'rw'].some(key => source.searchParams.has(key));
        for (const [key, value] of saved.searchParams) {
            if ((key === '3d' || key === 'photo') && hasMode) continue;
            if (!source.searchParams.has(key)) source.searchParams.set(key, value);
        }
        return source.href;
    }
    function browser(win) {
        const arrivalHref = win.location.href;
        const routeCid = parsePath(win.location.pathname);
        let current = null;
        function verify(row, cid) {
            const error = win.CameraFlight.validate(row?.content);
            if (error) throw new Error(error);
            if (row?.cid !== cid || win.Cid.cidOfObject(row.content) !== cid) throw new Error('The saved flight does not match its link.');
            return row;
        }
        async function request(method, path, body) {
            const response = await win.fetch(win.resolveBackendBaseUrl().replace(/\/$/, '') + path, { method,
                ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
                signal: AbortSignal.timeout(method === 'POST' ? 120000 : 30000) });
            let data;
            try { data = await response.json(); }
            catch { throw new Error(`The flight service returned an unreadable response (HTTP ${response.status}).`); }
            if (!response.ok) {
                const error = new Error(data?.error || `The flight request failed (HTTP ${response.status}).`);
                if (data?.code) error.code = data.code;
                if (data?.next) error.next = data.next;
                throw error;
            }
            return data;
        }
        async function load(cid) {
            if (!win.Cid.isCid(cid)) throw new Error('Invalid camera flight link.');
            return verify(await request('GET', `/flights/${cid}`), cid);
        }
        function link(cid) {
            if (!win.Cid.isCid(cid)) throw new Error('Invalid camera flight link.');
            const url = new URL(`/flights/${cid}`, win.resolveFrontendBaseUrl());
            const override = new URLSearchParams(win.location.search).get('backend');
            if (override) url.searchParams.set('backend', override);
            return url.href;
        }
        return {
            link, load,
            get current() { return current; },
            async save(content) {
                const error = win.CameraFlight.validate(content);
                if (error) throw new Error(error);
                // Freeze the submitted projection across asynchronous requests and caller edits.
                const snapshot = JSON.parse(JSON.stringify(content));
                const cid = win.Cid.cidOfObject(snapshot);
                verify(await request('POST', '/flights', { content: snapshot }), cid);
                const record = await load(cid);
                current = record;
                return { ...record, link: link(cid) };
            },
            async open() {
                if (!routeCid) return;
                const record = await load(routeCid);
                const restored = restoreUrl(arrivalHref, record.content.view, win.MapShare);
                if (restored !== new URL(arrivalHref).href) {
                    win.location.replace(restored);
                    return { redirecting: true };
                }
                const loaded = await win.handleSharedDesignRoute(record.content.designCids, { frame: false, openDetails: false });
                if (!loaded || loaded.blocked || loaded.failed?.length || loaded.omitted?.length) {
                    throw new Error('The flight could not be opened because its selected designs were not fully restored.');
                }
                // Flights are authored in the model view; a link carrying `photo` plays one over the photo view.
                const mode = new URL(arrivalHref).searchParams.has('photo') ? 'photo' : 'model';
                const ready = await win.requestMapMode(mode, { restoreView: record.content.view.camera, fromUrl: true });
                if (!ready) throw new Error(`The ${mode} view could not be opened for this flight.`);
                await win.openCameraFlightEditor({ record: record.content, readOnly: true, cid: record.cid });
                current = record;
                return record;
            }
        };
    }
    return Object.freeze({ parsePath, restoreUrl, browser });
});
