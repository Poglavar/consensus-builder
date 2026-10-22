// Realises Permitted viewport envelopes for display. The server ships the specs: one outer bound
// per parcel, the configurations (housing types) with their direct constraints and lot test, and
// the derivation inputs (parcel, zoning-covered part, usable front edges). This module turns those
// plus a display selection (per-parcel pins, the pinned housing type, the dice counter) into
// renderer-agnostic volumes; the map and the model only extrude what it returns. Pure: geometry
// operations and the shared evaluator come in as `deps`, so it runs headless in tests and in Node.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanningEnvelopes = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const ANY_CONFIGURATION = 'all';
    const forms = Object.freeze(['bound', 'configuration', 'both']);
    // FNV-1a: the same parcel lands on the same configuration in the map, the model and a shared link.
    function hash(text) {
        let h = 0x811c9dc5;
        for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
        return h >>> 0;
    }
    const drawable = configuration => configuration.volumes?.length > 0;
    // A configuration whose recorded minimum lot the parcel does not reach is still drawn when asked
    // for, but the roll prefers the types the parcel qualifies for.
    const qualifies = configuration => configuration.lotArea?.status !== 'fail';
    // Which configuration an item shows: a per-item pin wins, then a pinned housing type, then
    // a deterministic roll over the drawable configurations. Null means only the bound is shown.
    function configurationFor(item, { variation = '', scenario = ANY_CONFIGURATION, pins = {} } = {}) {
        const list = Array.isArray(item?.configurations) ? item.configurations : [];
        if (!list.length) return null;
        const pinned = pins[item.id] ? list.find(configuration => configuration.id === pins[item.id]) : null;
        if (pinned) return pinned;
        if (scenario && scenario !== ANY_CONFIGURATION) return list.find(configuration => configuration.id === scenario) || null;
        const candidates = list.filter(drawable);
        if (!candidates.length) return null;
        const pool = candidates.some(qualifies) ? candidates.filter(qualifies) : candidates;
        return pool[(hash(String(item.id)) + (Number(variation) || 0)) % pool.length];
    }
    // The assumed street side rolls with the configuration: the same counter, a different seed, so
    // one roll changes both. Null when the item carries no derivation inputs.
    function frontEdgeFor(item, { variation = '' } = {}) {
        const edges = item?.derivation?.frontEdges;
        if (!Array.isArray(edges) || !edges.length) return null;
        return edges[(hash(`${item.id}#edge`) + (Number(variation) || 0)) % edges.length];
    }
    // Which side of the parcel an edge faces, as a compass key, from the ring centroid to the edge midpoint.
    function edgeSide(geometry, index) {
        const ring = geometry?.coordinates?.[0];
        if (!ring || !ring[index + 1]) return null;
        const points = ring.slice(0, -1), n = points.length;
        const cx = points.reduce((sum, p) => sum + p[0], 0) / n, cy = points.reduce((sum, p) => sum + p[1], 0) / n;
        const a = ring[index], b = ring[index + 1];
        const dx = ((a[0] + b[0]) / 2 - cx) * Math.cos(cy * Math.PI / 180), dy = (a[1] + b[1]) / 2 - cy;
        const bearing = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
        return ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'][Math.round(bearing / 45) % 8];
    }
    // One configuration drawn on one assumed street side, with the shared evaluator. Without the
    // evaluator, or when the derivation fails, the configuration's own (all-sides) volume is drawn.
    function configurationBody(item, configuration, selection, deps) {
        const frontEdge = frontEdgeFor(item, selection);
        const fallback = { volumes: configuration.volumes || [], frontEdge: null };
        if (frontEdge === null || !deps?.assessment || !deps?.geometry || !Array.isArray(configuration.constraints)) return fallback;
        try {
            const context = { parcel: { type: 'Feature', geometry: item.derivation.parcel },
                coveredGeometry: item.derivation.covered || null, source: { constraints: configuration.constraints } };
            const bound = deps.assessment.derive(context, frontEdge, deps.geometry);
            if (!bound.geometry || !(bound.heightM > 0)) return fallback;
            return { frontEdge, volumes: [{ id: `${item.id}:${configuration.id}:edge${frontEdge}`, geometry: bound.geometry, baseM: 0, topM: bound.heightM }] };
        } catch (_) { return fallback; }
    }
    function volumeFeatures(item, geometryRole = 'body', configurationId = null) {
        if (item?.spatialReference?.horizontal !== 'OGC:CRS84' || item?.spatialReference?.unit !== 'm'
            || item?.spatialReference?.vertical !== 'relative-ground') return [];
        return (item.volumes || []).filter(volume => ['Polygon', 'MultiPolygon'].includes(volume.geometry?.type)
            && typeof volume.baseM === 'number' && Number.isFinite(volume.baseM)
            && typeof volume.topM === 'number' && Number.isFinite(volume.topM) && volume.topM > volume.baseM)
            .map(volume => ({ type: 'Feature', geometry: volume.geometry, properties: {
                representationId: item.id, sourceProposalId: item.proposalId, role: item.role, geometryRole, configurationId,
                partId: volume.id, baseM: volume.baseM, topM: volume.topM, height: volume.topM - volume.baseM
            } }));
    }
    // The volumes a Permitted item draws: `bound` is the translucent outer hull, `body` the shown
    // configuration. Items without configurations (one calculated option) draw their volumes as body.
    function realize(item, { form = 'both', selection = {}, deps = null } = {}) {
        if (!Array.isArray(item?.configurations) || !item.configurations.length) return { bound: [], body: volumeFeatures(item), configuration: null, frontEdge: null };
        const shownForm = forms.includes(form) ? form : 'both';
        const configuration = configurationFor(item, selection);
        const realization = configuration ? configurationBody(item, configuration, selection, deps) : { volumes: [], frontEdge: null };
        const body = shownForm === 'bound' || !configuration ? [] : volumeFeatures({ ...item, volumes: realization.volumes }, 'body', configuration.id)
            .map(feature => ({ ...feature, properties: { ...feature.properties, frontEdge: realization.frontEdge } }));
        const bound = shownForm === 'configuration' && body.length ? [] : volumeFeatures(item, 'bound');
        return { bound, body, configuration, frontEdge: body.length ? realization.frontEdge : null };
    }
    // The joined ground projection has one boundary. Height-part boundaries are an explicit detail.
    function mapFeatures(item, { detail = 'footprint', form = 'both', selection = {}, deps = null } = {}) {
        if (item.areas?.length) return item.areas.map(area => ({ type: 'Feature', geometry: area.geometry,
            properties: { representationId: item.id, role: item.role, geometryRole: 'zoning-area' } }));
        const { bound, body } = realize(item, { form, selection, deps });
        const join = features => {
            if (detail === 'steps' || features.length < 2) return features;
            const joined = features.reduce((result, feature) => result ? deps.geometry.union(result, feature) : feature, null);
            const baseM = Math.min(...features.map(feature => feature.properties.baseM));
            const topM = Math.max(...features.map(feature => feature.properties.topM));
            return joined?.geometry ? [{ ...joined, properties: { ...features[0].properties, partId: null, baseM, topM, height: topM - baseM } }] : [];
        };
        return [...join(bound), ...join(body)];
    }
    return { ANY_CONFIGURATION, forms, configurationFor, frontEdgeFor, edgeSide, volumeFeatures, realize, mapFeatures };
});
