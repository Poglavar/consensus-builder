// The paths the browser app answers itself. nginx sends index.html for any extensionless path it has
// no file for (backend/nginx/urbangametheory.xyz.nginx.conf), so the app decides what is unknown:
// such a page is marked noindex (no soft 404 in search) and a notice says there is no page there.
// Add a pattern here when a router gains a new path; app-routes.test.js checks the routers against it.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__AppRoutes = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // Prefix-level on purpose: each router validates its own ids, this only knows which paths exist.
    const ROUTES = Object.freeze([
        /^\/(index\.html)?$/,     // the map
        /^\/proposals\/?$/,       // the proposal list (js/proposals/core.js)
        /^\/designs(?:\/.+)?$/,        // /designs/<cid>[,<cid>…] (js/proposals/sharing-routes.js)
        /^\/agreements\/.+$/,     // /agreements/<cid> (js/agreement-sync.js)
        /^\/parcel\/.+$/,         // /parcel/<id> (js/parcels/route.js)
        /^\/bets\/.+$/            // /bets/<account> (js/bets/bets-link.js; nginx proxies it first)
    ]);
    // Area-monitor links append /monitors/<n> to any app path (js/area-monitor/routing.js).
    const MONITOR_SUFFIX = /\/monitors\/\d+\/?$/;

    function isAppPath(pathname) {
        if (typeof pathname !== 'string') return false;
        const base = pathname.replace(MONITOR_SUFFIX, '') || '/';
        return ROUTES.some(route => route.test(base));
    }

    // Marks an unknown path: noindex for crawlers and one notice for people. Returns whether it did.
    function markUnknownPath({ doc, pathname, notify }) {
        if (isAppPath(pathname)) return false;
        const meta = doc.createElement('meta');
        meta.name = 'robots';
        meta.content = 'noindex';
        doc.head.appendChild(meta);
        if (typeof notify === 'function') notify();
        return true;
    }

    return Object.freeze({ ROUTES, isAppPath, markUnknownPath });
});
