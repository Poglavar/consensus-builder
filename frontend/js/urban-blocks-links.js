// Share a detected block by stable geometry ID and bounds. The bounds let a phone reload the
// whole road enclosure independently of its narrower viewport; no cadastral data is required.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.UrbanBlocksLinks = api;
})(typeof self !== 'undefined' ? self : null, function () {
    'use strict';
    const sizes = [50, 100, 150, 200];
    function validBounds(bbox) {
        return Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite)
            && bbox[0] >= -180 && bbox[2] <= 180 && bbox[1] >= -90 && bbox[3] <= 90
            && bbox[2] > bbox[0] && bbox[3] > bbox[1]
            && bbox[2] - bbox[0] < 0.06 && bbox[3] - bbox[1] < 0.06;
    }
    function loadBounds(bbox) {
        if (!validBounds(bbox)) return null;
        const [w, s, e, n] = bbox;
        const dx = Math.max(0, Math.min(Math.max((e - w) * 0.15, 0.0001), (0.06 - (e - w)) / 2 - 1e-12));
        const dy = Math.max(0, Math.min(Math.max((n - s) * 0.15, 0.0001), (0.06 - (n - s)) / 2 - 1e-12));
        return [Math.max(-180, w - dx), Math.max(-90, s - dy), Math.min(180, e + dx), Math.min(90, n + dy)];
    }
    function parse(href) {
        try {
            const url = new URL(href);
            const blockId = url.searchParams.get('block');
            const raw = url.searchParams.get('blockBounds');
            const bbox = raw?.split(',').map(value => value.trim() ? Number(value) : NaN);
            if (!/^osm-block-[a-f0-9]{1,8}$/.test(blockId || '') || !validBounds(bbox)) return null;
            const size = Number(url.searchParams.get('blockSize'));
            return { blockId, bbox, targetSideM: sizes.includes(size) ? size : 100, city: url.searchParams.get('city') };
        } catch (_) { return null; }
    }
    function build({ baseUrl, city, blockId, bbox, targetSideM = 100 }) {
        if (!validBounds(bbox) || !/^osm-block-[a-f0-9]{1,8}$/.test(blockId)) return null;
        const base = new URL(baseUrl), url = new URL('/', base);
        for (const key of ['backend', 'lang', 'reduceMotion']) {
            if (base.searchParams.has(key)) url.searchParams.set(key, base.searchParams.get(key));
        }
        url.searchParams.set('city', city || 'explore');
        url.searchParams.set('blocks', '1');
        url.searchParams.set('block', blockId);
        url.searchParams.set('blockBounds', bbox.join(','));
        url.searchParams.set('blockSize', sizes.includes(targetSideM) ? targetSideM : 100);
        url.searchParams.set('at', [(bbox[1] + bbox[3]) / 2, (bbox[0] + bbox[2]) / 2, 17].join(','));
        return url.toString();
    }
    return { build, parse, loadBounds };
});
