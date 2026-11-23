// Compact, regional display geometry. Inspection reads the full source record by id.
(function (root) {
    'use strict';

    const sourceId = 'alatau-genplan-727';
    const path = `/data/planning/${sourceId}-overview.json`;
    let pending;

    function decode(answer, source, turf) {
        if (answer?.sourceId !== sourceId || !Array.isArray(answer.zones) || !Array.isArray(answer.uses)
            || answer.bbox?.length !== 4 || !answer.bbox.every(Number.isFinite)) {
            throw new Error('Invalid zoning overview response.');
        }
        const entries = answer.zones.map(([recordId, useIndex, geometry]) => {
            const { status, landBasis, ...use } = answer.uses[useIndex];
            const id = `${sourceId}:${recordId}`;
            const item = {
                id, role: 'permitted', title: use.label, site: geometry, overview: true,
                areas: [{ id: `${id}:area`, geometry }], volumes: [], constraints: [], metrics: {}, use, landBasis,
                source: { ...source, recordId: String(recordId) },
                assessment: { meaning: 'zoning-area', status, current: true }
            };
            const feature = turf.feature(geometry, { id });
            return { item, feature, bbox: turf.bbox(feature) };
        });
        return { bbox: answer.bbox, entries };
    }

    function load(source) {
        return pending ??= fetch(path).then(response => {
            if (!response.ok) throw new Error(`Zoning overview HTTP ${response.status}`);
            return response.json();
        }).then(answer => decode(answer, source, root.turf)).catch(error => {
            pending = null;
            throw error;
        });
    }

    function hitsAt(entries, point, turf) {
        const [lng, lat] = point.geometry.coordinates;
        return entries.filter(({ bbox: [w, s, e, n], feature }) =>
            w <= lng && lng <= e && s <= lat && lat <= n && turf.booleanPointInPolygon(point, feature)
        ).map(({ item }) => item);
    }

    const api = { sourceId, decode, load, hitsAt };
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ZoningOverview = api;
})(typeof window !== 'undefined' ? window : null);
