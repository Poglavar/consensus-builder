// Share a detected block by stable geometry ID and bounds. The bounds let a phone reload the
// whole road enclosure independently of its narrower viewport; no cadastral data is required.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.UrbanBlocksLinks = api;
})(typeof self !== 'undefined' ? self : null, function () {
    'use strict';
    const sizes = [50, 75, 100, 150, 200];
    const kinds = ['t', 'dead-end', 'perimeter', 'dead-end-projection'];
    const COORD_SCALE = 1e7, MAX_PAYLOAD = 60000;
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
    function decodeSubdivision(raw, bbox) {
        if (typeof raw !== 'string' || raw.length > MAX_PAYLOAD) throw new Error('The shared layout is too large.');
        const data = JSON.parse(raw);
        if (!Array.isArray(data) || data.length !== 3 || ![1, 2].includes(data[0]) || !Array.isArray(data[1]) || data[1].length !== 3
            || !(data[0] === 1 ? sizes.includes(data[1][0])
                : Number.isInteger(data[1][0]) && data[1][0] >= 1000 && data[1][0] <= 50000 && data[1][0] % 125 === 0)
            || !data[1].slice(1).every(value => Number.isInteger(value) && value >= 50 && value <= 300 && value % 25 === 0)
            || !Array.isArray(data[2]) || data[2].length > 48) throw new Error('Invalid shared layout settings.');
        let pointCount = 0;
        const cuts = data[2].map(tuple => {
            if (!Array.isArray(tuple) || tuple.length !== 4) throw new Error('Invalid shared split.');
            const [from, to, connectorIndex, coordinates] = tuple;
            if (![from, to].every(value => Number.isInteger(value) && value >= 0 && value < kinds.length)
                || !Array.isArray(coordinates) || coordinates.length < 4 || coordinates.length > 1024 || coordinates.length % 2
                || (pointCount += coordinates.length / 2) > 4096 || !coordinates.every(Number.isSafeInteger)
                || !Number.isInteger(connectorIndex) || connectorIndex < 0 || connectorIndex >= coordinates.length / 2 - 1
                || (from !== 1 && connectorIndex !== 0) || (to !== 1 && connectorIndex !== coordinates.length / 2 - 2)) throw new Error('Invalid shared split path.');
            const path = [];
            for (let i = 0; i < coordinates.length; i += 2) {
                const point = [bbox[0] + coordinates[i] / COORD_SCALE, bbox[1] + coordinates[i + 1] / COORD_SCALE];
                if (point[0] < bbox[0] - 1e-7 || point[0] > bbox[2] + 1e-7 || point[1] < bbox[1] - 1e-7 || point[1] > bbox[3] + 1e-7) throw new Error('A shared split lies outside the block bounds.');
                path.push(point);
            }
            return { fromKind: kinds[from], toKind: kinds[to], connectorIndex, path };
        });
        return { options: { targetAreaM2: data[0] === 1 ? data[1][0] ** 2 : data[1][0], maxSideM: data[1][1], perimeterStepM: data[1][2] }, cuts };
    }

    function encodeSubdivision({ options, layout }, bbox) {
        if (!Array.isArray(layout?.cuts?.features)) throw new Error('Generate a layout before sharing.');
        const data = [2, [options?.targetAreaM2, options?.maxSideM, options?.perimeterStepM], layout.cuts.features.map(cut => {
            const p = cut.properties;
            if (!Array.isArray(p?.splitPath)) throw new Error('Missing split geometry.');
            return [kinds.indexOf(p.fromKind), kinds.indexOf(p.toKind), p.connectorIndex,
                p.splitPath.flatMap(point => [Math.round((point[0] - bbox[0]) * COORD_SCALE), Math.round((point[1] - bbox[1]) * COORD_SCALE)])];
        })];
        const raw = JSON.stringify(data);
        decodeSubdivision(raw, bbox);
        return raw;
    }

    function parse(href) {
        try {
            const url = new URL(href);
            const blockId = url.searchParams.get('block');
            const raw = url.searchParams.get('blockBounds');
            const bbox = raw?.split(',').map(value => value.trim() ? Number(value) : NaN);
            if (!/^osm-block-[a-f0-9]{1,8}$/.test(blockId || '') || !validBounds(bbox)) return null;
            const size = Number(url.searchParams.get('blockSize'));
            const link = { blockId, bbox, targetSideM: sizes.includes(size) ? size : 100, city: url.searchParams.get('city') };
            const hash = new URLSearchParams(url.hash.slice(1));
            if (hash.has('splits')) {
                try {
                    if (hash.getAll('splits').length !== 1) throw new Error('Duplicate shared layouts.');
                    link.subdivision = decodeSubdivision(hash.get('splits'), bbox);
                } catch (_) { link.subdivision = null; link.subdivisionError = true; }
            }
            return link;
        } catch (_) { return null; }
    }
    function build({ baseUrl, city, blockId, bbox, targetSideM = 100, subdivision }) {
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
        // Geometry lives in the fragment: opening a shared preview needs no server-side plan.
        if (subdivision) url.hash = new URLSearchParams({ splits: encodeSubdivision(subdivision, bbox) }).toString();
        return url.toString();
    }
    return { build, parse, loadBounds };
});
