// Pure layout operations of the parcel-layout editor: carving a polygon (a drawn plot, an imported
// one, a building block's courtyard) into a layout, and finding those courtyards.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ReparcellizationPlanUtils = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const clone = value => JSON.parse(JSON.stringify(value));
    const feature = geometry => ({ type: 'Feature', properties: {}, geometry });

    // The inner rings (courtyards) of a building footprint, as polygons of their own.
    function deriveCourtyardFromFootprint(input) {
        const geometry = input?.type === 'Feature' ? input.geometry : input;
        if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) return null;
        const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
        const rings = polygons.flatMap(polygon => polygon.slice(1))
            .filter(ring => Array.isArray(ring) && ring.length >= 4)
            .map(ring => ring.map(point => point.slice()).reverse());
        if (!rings.length) return null;
        return feature(rings.length === 1
            ? { type: 'Polygon', coordinates: [rings[0]] }
            : { type: 'MultiPolygon', coordinates: rings.map(ring => [ring]) });
    }

    function polygonParts(geometry) {
        if (geometry.type === 'Polygon') return [geometry];
        if (geometry.type === 'MultiPolygon') {
            return geometry.coordinates.map(coordinates => ({ type: 'Polygon', coordinates }));
        }
        throw new Error('A parcel must have polygon geometry.');
    }

    // Build a new array before committing anything. A failed boolean operation must leave the
    // old layout intact; every positive-area remainder survives, including sub-square-metre parts.
    // The carved plot takes `source` (and `derivation`, for a courtyard); remainders keep theirs.
    function carveLayout({ pool, slices, polygon, source, derivation = null }, turfApi) {
        const clipped = turfApi.intersect(pool, polygon);
        if (!clipped?.geometry || turfApi.area(clipped) < 1) return null;
        const next = [];
        const append = (geometry, template) => {
            for (const part of polygonParts(geometry)) {
                if (turfApi.area(feature(part)) > 0) next.push({ ...clone(template), geometry: clone(part) });
            }
        };
        for (const slice of slices) {
            const remainder = turfApi.difference(feature(slice.geometry), clipped);
            if (remainder?.geometry) append(remainder.geometry, slice);
        }
        append(clipped.geometry, {
            source,
            ...(derivation ? { derivation: clone(derivation) } : {})
        });
        return next;
    }

    // Candidates are authored building proposals, so an unapplied block can guide a layout without
    // first claiming the ground the layout needs to reshape.
    function buildingCourtyardCandidates(proposals, pool, turfApi) {
        const entries = [];
        for (const proposal of proposals) {
            if (!proposal.buildingProposal) continue;
            // Block massing retains the complete ring even when its rendered buildings are split
            // into per-parcel pieces. Other authored building groups can enclose a courtyard too.
            const footprints = proposal.geometry?.ruleMassing?.geometry
                ? [proposal.geometry.ruleMassing]
                : (proposal.geometry?.buildings || []).filter(value => value?.geometry);
            let footprintUnion = null;
            for (const footprint of footprints) {
                footprintUnion = footprintUnion ? turfApi.union(footprintUnion, footprint) : footprint;
            }
            const courtyard = deriveCourtyardFromFootprint(footprintUnion);
            if (!courtyard) continue;
            const overlap = turfApi.intersect(pool, courtyard);
            if (overlap && turfApi.area(overlap) >= 1) {
                const title = proposal.title ?? proposal.name ?? proposal.proposalName ?? '';
                entries.push({ proposal, courtyard, derivation: {
                    kind: 'building-courtyard',
                    sourceTitle: String(title),
                    sourceFootprint: clone(footprintUnion.geometry)
                } });
            }
        }
        return entries;
    }

    return { deriveCourtyardFromFootprint, carveLayout, buildingCourtyardCandidates };
});
