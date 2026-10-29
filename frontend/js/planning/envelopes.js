// Realises Permitted viewport envelopes for display. The server ships the specs: one outer bound
// per parcel, the configurations (housing types) with their direct constraints and lot test, and
// the frontage evidence used to orient them. This module turns those
// plus a display selection (per-parcel pins, the pinned housing type, the dice counter) into
// renderer-agnostic volumes; the map and the model only extrude what it returns. Pure: geometry
// operations come in as `deps`, so it runs headless in tests and in Node.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanningEnvelopes = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const ANY_CONFIGURATION = 'all';
    const forms = Object.freeze(['bound', 'configuration', 'both']);
    // FNV-1a: the same parcel lands on the same configuration and sample in map and model.
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
    // a deterministic choice among drawable configurations. Dice vary the building inside it.
    // Null means only the bound is shown.
    function configurationFor(item, { scenario = ANY_CONFIGURATION, pins = {} } = {}) {
        const list = Array.isArray(item?.configurations) ? item.configurations : [];
        if (!list.length) return null;
        const pinned = pins[item.id] ? list.find(configuration => configuration.id === pins[item.id]) : null;
        if (pinned) return pinned;
        if (scenario && scenario !== ANY_CONFIGURATION) return list.find(configuration => configuration.id === scenario) || null;
        const candidates = list.filter(drawable);
        if (!candidates.length) return null;
        const pool = candidates.some(qualifies) ? candidates.filter(qualifies) : candidates;
        // A configuration the project must opt into (an incentive's extra storeys) is shown only when
        // pinned or when nothing unconditional draws; the roll otherwise stays with what the map grants.
        const settled = pool.filter(configuration => !configuration.condition);
        const choice = settled.length ? settled : pool;
        return choice[hash(String(item.id)) % choice.length];
    }
    // Frontage belongs to the parcel's source evidence; changing the housing type cannot rotate it.
    function frontEdgeFor(item) {
        const edges = item?.derivation?.frontEdges;
        const edge = item?.sourceEvidence?.frontEdge;
        return Number.isInteger(edge) && Array.isArray(edges) && edges.includes(edge) ? edge : null;
    }
    // Compass direction of the outward edge normal; collinear digitization cannot skew it.
    function edgeSide(geometry, index) {
        const ring = geometry?.coordinates?.[0];
        if (!ring || !ring[index + 1]) return null;
        const points = ring.slice(0, -1), n = points.length;
        const a = ring[index], b = ring[index + 1];
        const signedArea = points.reduce((sum, p, i) => {
            const q = points[(i + 1) % n], origin = points[0];
            return sum + (p[0] - origin[0]) * (q[1] - origin[1]) - (q[0] - origin[0]) * (p[1] - origin[1]);
        }, 0);
        const dx = (b[0] - a[0]) * Math.cos((a[1] + b[1]) / 2 * Math.PI / 180), dy = b[1] - a[1];
        if (!signedArea || !(Math.hypot(dx, dy) > 0)) return null;
        const outward = signedArea > 0 ? [dy, -dx] : [-dy, dx];
        const bearing = (Math.atan2(outward[0], outward[1]) * 180 / Math.PI + 360) % 360;
        return ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'][Math.round(bearing / 45) % 8];
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
    function sampleVolumes(item, configuration, variation, geometry) {
        if (!configuration.volumes?.length) return [];
        const step = Number(variation) || 0;
        const seed = hash(`${item.id}:${configuration.id}`);
        // A bounded sequence gives consecutive rolls different proportions, including when the
        // chosen housing type has just one maximum box. Keep its street-facing orientation.
        const scale = 0.62 + ((seed + step * 7) % 17) / 60;
        const heightScale = step % 5 === 0 ? 1 : 0.65 + ((seed + step * 3) % 7) / 20;
        const base = Math.min(...configuration.volumes.map(volume => volume.baseM));
        const roof = base + (Math.max(...configuration.volumes.map(volume => volume.topM)) - base) * heightScale;
        return configuration.volumes.flatMap(volume => {
            const topM = Math.min(volume.topM, roof);
            if (topM <= volume.baseM) return [];
            const source = geometry.feature(volume.geometry);
            const smaller = geometry.transformScale(source, scale);
            // Scaling a concave or holed polygon about its centre can leave its original shape.
            // Intersection keeps every sampled piece inside the exact source volume.
            const clipped = geometry.intersect(source, smaller);
            return clipped ? [{ ...volume, geometry: clipped.geometry, topM }] : [];
        });
    }

    function realize(item, { form = 'both', selection = {}, deps = {} } = {}) {
        if (!Array.isArray(item?.configurations) || !item.configurations.length) return { bound: [], body: volumeFeatures(item), configuration: null, frontEdge: null };
        const shownForm = forms.includes(form) ? form : 'both';
        const configuration = configurationFor(item, selection);
        const realization = configuration && shownForm !== 'bound'
            ? { volumes: sampleVolumes(item, configuration, selection.variation, deps.geometry), frontEdge: frontEdgeFor(item) }
            : { volumes: [], frontEdge: null };
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
