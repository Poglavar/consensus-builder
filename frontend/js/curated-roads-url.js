// Builds the request URL for curated road parcels on the SHARED roads API. Pure so it can be
// tested without a map: the failure it guards against — appending "?bbox=" to a path that already
// carries query params — still returns HTTP 200, just with the classification filter silently gone.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CuratedRoadsUrl = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function build(config, bbox, base, pageUrl) {
        if (!config || !config.path) return null;
        const url = new URL(`${base || ''}${config.path}`, pageUrl || 'http://localhost/');
        Object.entries(config.params || {}).forEach(([key, value]) => {
            url.searchParams.set(key, value);
        });
        url.searchParams.set('bbox', bbox);
        return url.toString();
    }

    return { build };
});
