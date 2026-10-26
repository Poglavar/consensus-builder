// Whole source-parcel boundaries for an explicit space-geometry edit.
// Pure GeoJSON selection shared by the map editor and agent editing checks.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.StructureParcelFit = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const clone = value => JSON.parse(JSON.stringify(value));
    const polygon = value => {
        const geometry = value?.type === 'Feature' ? value.geometry : value;
        return geometry && ['Polygon', 'MultiPolygon'].includes(geometry.type)
            ? { type: 'Feature', properties: {}, geometry } : null;
    };
    function fail(code) { throw Object.assign(new Error(code), { code }); }
    function fit({ boundary, parcels, mode, turf }) {
        if (!['largest', 'all'].includes(mode)) fail('invalid-parcel-fit');
        const outline = polygon(boundary);
        if (!outline || !Array.isArray(parcels) || !(turf.area(outline) > 0)) fail('invalid-parcel-fit');
        const order = root.__planOrder || (typeof require === 'function' ? require('./proposals/plan-order.js') : null);
        if (!order) fail('invalid-parcel-fit');
        const touched = new Map();
        for (const parcel of parcels) {
            const feature = polygon(parcel);
            if (!feature) fail('invalid-parcel-fit');
            const overlap = turf.intersect(outline, feature);
            // Match the cadastral repository's ancestry floor; a shared edge is not a take.
            if (!overlap || turf.area(overlap) < order.MIN_INTERSECTION_M2) continue;
            const id = String(parcel.properties?.parcelId ?? parcel.id ?? '');
            const key = JSON.stringify([id, feature.geometry]);
            touched.set(key, { id, key, feature, areaM2: turf.area(feature) });
        }
        const rows = [...touched.values()].sort((a, b) => b.areaM2 - a.areaM2
            || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        if (!rows.length) fail('no-touched-parcels');
        const selected = mode === 'largest' ? rows.slice(0, 1) : rows;
        let result = clone(selected[0].feature);
        for (const row of selected.slice(1)) {
            result = turf.union(result, row.feature);
            if (!result) fail('invalid-parcel-fit');
        }
        return { geometry: clone(result.geometry), parcelIds: selected.map(row => row.id) };
    }
    return { fit };
});
