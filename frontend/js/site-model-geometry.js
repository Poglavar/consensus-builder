// Pure geometry for the site review: turns a stored site model (site-model.v1) into local-metre
// storey prisms and placed-plan slabs. No DOM or three.js; loaded in the browser and in node tests.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.__siteModelGeometry = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const DEG = Math.PI / 180;

    function ringArea(ring) {
        let sum = 0;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
        return Math.abs(sum) / 2;
    }
    const open = ring => (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring);

    function largestRing(geometry) {
        if (!geometry) return null;
        const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
        return polygons.map(rings => rings[0]).sort((a, b) => ringArea(b) - ringArea(a))[0] || null;
    }

    // Context locates the project; only the envelope footprint may support a building volume.
    function contextGeometry(model) {
        return model?.envelope?.footprint || model?.parcelContext?.geometry || null;
    }

    function locationPoint(model) {
        if (!['located', 'probable'].includes(model?.location?.status)) return null;
        const ring = largestRing(contextGeometry(model));
        if (!ring || ring.length < 4 || ring.some(p => !Array.isArray(p) || p.length < 2
            || !p.slice(0, 2).every(Number.isFinite) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90)) return null;
        const points = open(ring);
        return { lng: points.reduce((sum, p) => sum + p[0], 0) / points.length,
            lat: points.reduce((sum, p) => sum + p[1], 0) / points.length, status: model.location.status,
            basis: model.envelope?.footprint ? 'building-footprint' : 'parcel-context' };
    }

    // Local tangent-plane metres (x east, y north) around the footprint's first vertex.
    function localFrame(model) {
        const ring = largestRing(model?.envelope?.footprint);
        if (!ring) return null;
        const [lng0, lat0] = ring[0], kx = 111320 * Math.cos(lat0 * DEG), ky = 110574;
        return { origin: [lng0, lat0], toLocal: ([lng, lat]) => [(lng - lng0) * kx, (lat - lat0) * ky] };
    }

    // One prism per storey, all on the footprint (an upper-floor outline is not known yet).
    function storeyPrisms(model) {
        const frame = localFrame(model);
        if (!frame) return [];
        const ring = open(largestRing(model.envelope.footprint)).map(frame.toLocal);
        return (model.envelope.storeys || []).filter(s => typeof s.elevationM === 'number' && s.heightM > 0)
            .map(s => ({ level: s.level, label: s.label, z0: s.elevationM, z1: s.elevationM + s.heightM, ring, recessed: s.outline === 'recessed',
                estimated: s.heightBasis === 'estimated' }));
    }

    const STATUS_COLOURS = { placed: '#2f8f5b', ambiguous: '#d08a2e', unplaced: '#b04a4a' };
    const statusColour = status => STATUS_COLOURS[status] || '#6b7780';

    // Each fitted plan as a thin slab at its storey's floor level (unknown floor: ground level).
    function placedSlabs(model) {
        const frame = localFrame(model);
        if (!frame) return [];
        const byLevel = new Map((model.envelope.storeys || []).map(s => [s.level, s]));
        return (model.placements || []).filter(p => p.best?.outline?.length >= 4).map(p => {
            const storey = byLevel.get(p.floor);
            return { unitId: p.unitId, status: p.status, colour: statusColour(p.status), floor: p.floor,
                z: storey ? storey.elevationM : 0, ring: open(p.best.outline).map(frame.toLocal), floorKnown: Boolean(storey) };
        });
    }

    return { ringArea, largestRing, contextGeometry, locationPoint, localFrame, storeyPrisms, placedSlabs, statusColour };
});
