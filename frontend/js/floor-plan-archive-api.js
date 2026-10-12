// API base for the floor-plan archive page. A loopback page takes ?backend= (dev.sh and the review
// server run the API on their own port); every other host talks to the production API, as the map
// app does. No DOM; loaded in the browser and in node tests.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.__floorPlanArchiveApi = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const PRODUCTION_API = 'https://api.urbangametheory.xyz';
    const LOOPBACK = /^(localhost|127\.0\.0\.1)$/;

    function apiBase({ hostname = '', search = '' } = {}) {
        if (!LOOPBACK.test(hostname)) return PRODUCTION_API;
        const override = new URLSearchParams(search).get('backend');
        if (override && /^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/.test(override)) return override.replace(/\/$/, '');
        return 'http://localhost:3000';
    }

    return { apiBase, PRODUCTION_API };
});
