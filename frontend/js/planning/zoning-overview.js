// Compact, regional display geometry shared by planning sources that provide an overview asset.
(function (root) {
    'use strict';

    const reads = new Map();
    const supports = source => !!source?.zoningOverview && typeof source.id === 'string' && /^[a-z0-9][a-z0-9_-]{0,99}$/.test(source.id);

    function decode(answer, source, turf) {
        if (answer?.sourceId !== source.id || !Array.isArray(answer.zones) || !Array.isArray(answer.uses)
            || answer.bbox?.length !== 4 || !answer.bbox.every(Number.isFinite)) {
            throw new Error('Invalid zoning overview response.');
        }
        const entries = answer.zones.map(([recordId, useIndex, geometry]) => {
            const { status, landBasis, ...use } = answer.uses[useIndex];
            const id = `${source.id}:${recordId}`;
            const item = {
                id, role: 'permitted', title: use.label, site: geometry, overview: true,
                areas: [{ id: `${id}:area`, geometry }], volumes: [], constraints: [], metrics: {}, use, landBasis,
                source: { ...source, recordId: String(recordId) },
                assessment: { meaning: 'zoning-area', status, current: true }
            };
            const feature = turf.feature(geometry, { id });
            return { item, feature, bbox: turf.bbox(feature) };
        });
        return { sourceId: source.id, detailZoom: source.zoningOverview?.detailZoom,
            bbox: answer.bbox, entries, items: entries.map(({ item }) => item) };
    }

    function load(source) {
        if (!supports(source)) return Promise.reject(new Error('Planning source has no overview.'));
        const cached = reads.get(source.id);
        if (cached) return cached;
        const pending = fetch(`/data/planning/${source.id}-overview.json`).then(response => {
            if (!response.ok) throw new Error(`Zoning overview HTTP ${response.status}`);
            return response.json();
        }).then(answer => decode(answer, source, root.turf)).catch(error => {
            reads.delete(source.id);
            throw error;
        });
        reads.set(source.id, pending);
        return pending;
    }

    function hitsAt(entries, point, turf) {
        const [lng, lat] = point.geometry.coordinates;
        return entries.filter(({ bbox: [w, s, e, n], feature }) =>
            w <= lng && lng <= e && s <= lat && lat <= n && turf.booleanPointInPolygon(point, feature)
        ).map(({ item }) => item);
    }

    const api = { supports, decode, load, hitsAt };
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ZoningOverview = api;
})(typeof window !== 'undefined' ? window : null);
