// A public share names published designs and their view; it does not convey consent.
// Share links and the live address use the same geographic camera representation.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.MapShare = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const fields = ['targetLat', 'targetLng', 'headingDeg', 'pitchRad', 'range'];
    function readCamera(value) {
        try {
            if (typeof value !== 'string' || value.split(',').some(part => !part.trim())) return null;
            const parts = value.split(',').map(Number);
            if (parts.length !== fields.length || !parts.every(Number.isFinite)) return null;
            const [lat, lng, , pitch, range] = parts;
            if (Math.abs(lat) > 85.0511 || Math.abs(lng) > 180 || pitch < -Math.PI / 2 || pitch > 0 || range < 1) return null;
            return Object.fromEntries(fields.map((key, index) => [key, parts[index]]));
        } catch (_) { return null; }
    }
    function capture(win) {
        const center = win.map.getCenter();
        const mode = win.__mapModeState?.desired || '2d';
        const camera = mode === '2d' ? null : win.getThree3DGeoView?.();
        const settings = win.PlanningScene?.settings(win.PlanningViews?.getState());
        const source = new URLSearchParams(win.location?.search || '');
        if (settings) for (const key of ['planningSource', 'planningScenario']) {
            if (source.has(key)) settings[key] = source.get(key);
        }
        return { mode, at: [camera?.targetLat ?? center.lat, camera?.targetLng ?? center.lng, win.map.getZoom()].join(','),
            camera,
            rotate: mode !== '2d' && source.get('rotate') === '1',
            language: win.i18n?.getLanguage?.(),
            ...(source.has('backend') ? { backend: source.get('backend') } : {}),
            ...(settings ? { settings } : {}),
            city: win.CityConfigManager?.getCurrentCityId?.() };
    }
    function link(base, context) {
        const url = new URL(base);
        url.searchParams.delete('draft');
        if (context.city) url.searchParams.set('city', context.city);
        if (context.language) url.searchParams.set('lang', context.language);
        if (context.backend) url.searchParams.set('backend', context.backend);
        for (const [key, value] of Object.entries(context.settings || {})) url.searchParams.set(key, value);
        return address(url, context);
    }
    // Updating the address must retain private preview references and the current content route.
    function address(base, context) {
        const url = new URL(base);
        for (const key of ['3d', 'photo', 'model', 'mode3d', 'real', 'rl', 'rw', 'camera', 'rotate']) url.searchParams.delete(key);
        url.searchParams.set('at', context.at);
        if (context.mode === 'model') url.searchParams.set('3d', '');
        if (context.mode === 'photo') url.searchParams.set('photo', '');
        if (context.camera) url.searchParams.set('camera', fields.map(key => context.camera[key]).join(','));
        if (context.mode !== '2d') url.searchParams.set('rotate', context.rotate === true ? '1' : '0');
        return url.toString();
    }
    function createAddressSync(win) {
        let timer = null;
        function write() {
            if (!win.map?.getCenter || win.__mapModeState?.pending) return;
            if (win.BrowserWorkspace && win.BrowserWorkspace.status !== 'ready') return;
            const next = address(win.location.href, capture(win));
            if (next !== win.location.href) win.history.replaceState(win.history.state, '', next);
        }
        function schedule() {
            // Sample the latest pose at most four times a second, including the final settled pose.
            if (timer !== null) return;
            timer = win.setTimeout(() => { timer = null; write(); }, 250);
        }
        return { write, schedule };
    }
    // Publication alone is insufficient: the address must name the exact applied revisions too.
    function compositionStatus(win) {
        if (!win.proposalStorage || !win.DesignSync || !win.isApplied) return 'pending';
        if (win.BrowserWorkspace?.status === 'loading') return 'pending';
        const applied = win.proposalStorage.getAllProposals().filter(win.isApplied);
        const current = applied.map(record => {
            try { return win.DesignSync.publishedCid(record); } catch (_) { return null; }
        });
        if (current.some(cid => !cid)) return 'local';
        const path = new URL(win.location.href).pathname.replace(/\/$/, '');
        let referenced = win.DesignSync.parseDesignsPath(path);
        if (path.startsWith('/plans/')) {
            const plan = win.NamedPlans?.current;
            if (!plan || path !== `/plans/${plan.cid}`) return 'pending';
            referenced = plan.content.designCids;
        } else if (path.startsWith('/agreements/')) {
            const agreement = win.AgreementSync?.localCopyOf(path.slice('/agreements/'.length));
            if (!agreement) return 'pending';
            referenced = agreement.plan.content.designCids;
        } else if (!referenced) {
            referenced = [];
        }
        const signature = cids => JSON.stringify([...new Set(cids)].sort());
        return signature(current) === signature(referenced) ? 'shared' : 'local';
    }
    function arrivalOptions(search) {
        const params = new URLSearchParams(search);
        return { restoreView: readCamera(params.get('camera')), rotate: params.get('rotate') === '1' };
    }
    return Object.freeze({ readCamera, capture, link, address, createAddressSync, compositionStatus, arrivalOptions });
});
