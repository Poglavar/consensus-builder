// Content identity of a parcel-layout design (plan-design-agreement.md, M1 (a)): a fingerprint per
// plot and the canonical content of the whole layout, both over geometry only, so no owner, share,
// colour or term can move a layout's identity.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ParcelLayoutRecord = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const PLOT_FINGERPRINT_PREFIX = 'layout-plot1-sha256:';

    // Synchronous SHA-256 from vendor/noble-hashes: a browser global, a CommonJS module in node.
    function sha256Hex(text) {
        const api = root.__consentSha256
            || (typeof require === 'function' ? require('../vendor/noble-hashes-1.8.0/sha256.js') : null);
        if (!api || typeof api.sha256Hex !== 'function') throw new Error('SHA-256 (vendor/noble-hashes) is not loaded.');
        return api.sha256Hex(text);
    }

    // JSON with object keys sorted, so equal content always gives equal text. Undefined keys are
    // left out; a number that is not finite is refused rather than written as null.
    function stableStringify(value) {
        if (value === null || value === undefined) return 'null';
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Layout numbers must be finite.');
        if (typeof value !== 'object') return JSON.stringify(value);
        if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
        return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort()
            .map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
    }

    // A polygon as identity sees it: its type and exact authored coordinates. A Feature wrapper,
    // bbox or properties never reach the hash, and no rounding may erase a moved border.
    function canonicalGeometry(value, what) {
        const shape = value && value.type === 'Feature' ? value.geometry : value;
        if (!shape || (shape.type !== 'Polygon' && shape.type !== 'MultiPolygon')) {
            throw new Error(`${what} needs polygon geometry.`);
        }
        const polygons = shape.type === 'Polygon' ? [shape.coordinates] : shape.coordinates;
        if (!Array.isArray(polygons) || !polygons.length) throw new Error(`${what} has empty polygon geometry.`);
        for (const polygon of polygons) {
            if (!Array.isArray(polygon) || !polygon.length) throw new Error(`${what} has empty polygon geometry.`);
            for (const ring of polygon) {
                if (!Array.isArray(ring) || ring.length < 4 || ring.some(point => !Array.isArray(point)
                    || point.length < 2 || point.some(n => typeof n !== 'number' || !Number.isFinite(n)))
                    || stableStringify(ring[0]) !== stableStringify(ring[ring.length - 1])) {
                    throw new Error(`${what} needs closed polygon rings of finite coordinates.`);
                }
            }
        }
        return { type: shape.type, coordinates: shape.coordinates };
    }

    // A plot's identity within its layout: its exact geometry, hashed. Array position, area,
    // source and anything about owners stay out. Apply stamps it on every piece formed from the
    // plot, so the reference survives a later road carving that piece.
    function plotFingerprint(plot) {
        return PLOT_FINGERPRINT_PREFIX + sha256Hex(stableStringify(canonicalGeometry(plot && plot.geometry, 'A layout plot')));
    }

    // The canonical JSON of a whole layout: the pool and, in authored order (the plot numbers),
    // each plot's geometry, source and derivation. Hashing it gives the layout's content identity.
    function content(plan) {
        if (!plan || typeof plan !== 'object') throw new Error('A parcel layout is required.');
        if (!Array.isArray(plan.plots) || !plan.plots.length) throw new Error('A parcel layout needs at least one plot.');
        return stableStringify({
            pool: canonicalGeometry(plan.pool, 'The layout pool'),
            plots: plan.plots.map((plot, index) => ({
                geometry: canonicalGeometry(plot && plot.geometry, `Plot ${index + 1}`),
                source: plot.source,
                derivation: plot.derivation
            }))
        });
    }

    return { PLOT_FINGERPRINT_PREFIX, stableStringify, plotFingerprint, content };
});
