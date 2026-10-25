// Publishes and opens named plan snapshots. All ground changes still go through the shared-design route.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.NamedPlans = api.browser(root);
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    function parsePath(path) { return /^\/plans\/([^/]+)\/?$/.exec(path)?.[1] || null; }
    function restoreUrl(href, view, mapShare) {
        const source = new URL(href);
        const saved = new URL(mapShare.link(source.origin + source.pathname, view));
        // Explicit URL view settings win (the map updates its address as the visitor moves).
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
        const t = (key, fallback, params) => win.getProposalI18nHelper()(key, fallback, params);
        const backend = () => win.resolveBackendBaseUrl().replace(/\/$/, '');
        const verify = (row, cid) => {
            const error = win.PlanRecord.validate(row?.content);
            if (error || row?.cid !== cid || win.Cid.cidOfObject(row.content) !== cid) throw new Error(error || 'The saved plan does not match its link.');
            return row;
        };
        async function request(method, path, body) {
            const response = await win.fetch(backend() + path, { method,
                ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
                signal: AbortSignal.timeout(method === 'POST' ? 120000 : 30000) });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
            return data;
        }
        async function fetchPlan(cid) {
            if (!win.Cid.isCid(cid)) throw new Error('Invalid plan link.');
            return verify(await request('GET', `/plans/${cid}`), cid);
        }
        function link(cid) {
            const url = new URL(`/plans/${cid}`, win.resolveFrontendBaseUrl());
            const apiOverride = new URLSearchParams(win.location.search).get('backend');
            if (apiOverride) url.searchParams.set('backend', apiOverride);
            return url.href;
        }
        // Resolve a compact link before route application. A one-time reload supplies the saved
        // city/locale/view to the existing bootstrap, which reads them synchronously. No marker,
        // temporary link or session storage is needed; explicit query overrides remain usable.
        const arrive = () => routeCid ? fetchPlan(routeCid).then(record => {
            const restored = restoreUrl(arrivalHref, record.content.view, win.MapShare);
            if (restored !== new URL(arrivalHref).href) {
                win.location.replace(restored);
                return { redirecting: true };
            }
            return { record };
        }).catch(error => ({ error })) : null;
        return {
            link,
            fetchPlan,
            get current() { return current; },
            async save(content) {
                const error = win.PlanRecord.validate(content);
                if (error) throw new Error(error);
                const cid = win.Cid.cidOfObject(content);
                verify(await request('POST', '/plans', { content }), cid);
                // Read back the durable record before presenting its link as saved.
                current = await fetchPlan(cid);
                return { ...current, link: link(cid) };
            },
            async open() {
                const result = await arrive();
                if (!result || result.redirecting) return;
                if (result.error) {
                    win.showStyledAlert(result.error.message, { title: t('proposals.share.named.openFailed', 'The named plan could not be opened') });
                    return;
                }
                current = result.record;
                win.document.title = `${current.content.title} · Consensus Builder`;
                const loaded = await win.handleSharedDesignRoute(current.content.designCids, { frame: false, openDetails: false });
                if (!loaded.blocked && !loaded.failed.length) {
                    win.showEphemeralMessage(t('proposals.share.named.opened', 'Opened “{{title}}”.', { title: current.content.title }), 6000, 'success');
                }
            }
        };
    }
    return { parsePath, restoreUrl, browser };
});
