// Pure layout operations for keeping existing parcels and carving a shared courtyard.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ReparcellizationPlanUtils = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const clone = value => JSON.parse(JSON.stringify(value));
    const feature = geometry => ({ type: 'Feature', properties: {}, geometry });

    function computeJointProRataShares(entries) {
        if (!Array.isArray(entries) || !entries.length) return [];
        const weighted = entries.map(entry => ({
            ownerKey: entry.ownerKey,
            weight: typeof entry.weight === 'number' && Number.isFinite(entry.weight) && entry.weight > 0
                ? entry.weight : 0
        }));
        const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
        // A recipient with no private allocation has no courtyard share. If the entire private
        // allocation is empty, use equal shares so a wholly shared layout can still be edited.
        const recipients = total > 0 ? weighted.filter(entry => entry.weight > 0) : weighted;
        let assigned = 0;
        return recipients.map((entry, index) => {
            const share = index === recipients.length - 1 ? 1 - assigned
                : (total > 0 ? entry.weight / total : 1 / recipients.length);
            assigned += share;
            return { ownerKey: entry.ownerKey, share };
        });
    }

    function jointOwnersForLayout(recipients, slices, turfApi, unitValue = 1) {
        const weights = new Map(recipients.map(owner => [owner.ownerKey, 0]));
        for (const slice of slices) {
            if (slice.jointPool) continue;
            const value = turfApi.area(feature(slice.geometry)) * unitValue;
            for (const owner of slice.owners || []) {
                if (weights.has(owner.ownerKey) && Number.isFinite(owner.share) && owner.share > 0) {
                    weights.set(owner.ownerKey, weights.get(owner.ownerKey) + value * owner.share);
                }
            }
        }
        const byKey = new Map(recipients.map(owner => [owner.ownerKey, owner]));
        return computeJointProRataShares(recipients.map(owner => ({
            ownerKey: owner.ownerKey, weight: weights.get(owner.ownerKey)
        }))).map(owner => ({ ...byKey.get(owner.ownerKey), share: owner.share }));
    }

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

    function existingParcelPlots(parcelFeatures, ownerIndex) {
        return parcelFeatures.map(parcel => {
            const id = String(parcel.properties.parcelId);
            const owners = ownerIndex.get(id);
            if (!owners?.length) throw new Error(`Missing owners for parcel ${id}`);
            return { geometry: clone(parcel.geometry), owners: clone(owners), source: 'amend', jointPool: false };
        });
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
    function carveLayout({ pool, slices, polygon, owners, source, jointPool = false }, turfApi) {
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
        append(clipped.geometry, { owners: clone(owners), source, jointPool });
        return next;
    }

    // Candidates are authored building proposals, so an unapplied block can guide a readjustment
    // without first claiming the ground the readjustment needs to reshape.
    function buildingCourtyardCandidates(proposals, pool, turfApi) {
        const entries = [];
        for (const proposal of proposals) {
            if (!proposal.buildingProposal) continue;
            // Block massing retains the complete ring even when its rendered buildings are split
            // into per-parcel pieces. Other authored building groups can enclose a courtyard too.
            const footprints = proposal.geometry?.blockMassing?.geometry
                ? [proposal.geometry.blockMassing]
                : (proposal.geometry?.buildings || []).filter(value => value?.geometry);
            let footprintUnion = null;
            for (const footprint of footprints) {
                footprintUnion = footprintUnion ? turfApi.union(footprintUnion, footprint) : footprint;
            }
            const courtyard = deriveCourtyardFromFootprint(footprintUnion);
            if (!courtyard) continue;
            const overlap = turfApi.intersect(pool, courtyard);
            if (overlap && turfApi.area(overlap) >= 1) entries.push({ proposal, courtyard });
        }
        return entries;
    }

    function sameOwners(a, b) {
        const fractions = new Map((a || []).map(owner => [owner.ownerKey, owner.share]));
        return fractions.size === (b || []).length && (b || []).every(owner =>
            fractions.has(owner.ownerKey) && Math.abs(fractions.get(owner.ownerKey) - owner.share) <= 1e-6);
    }

    // Each agreement retains the actual drawn boundaries, clipped to one original parcel. Private
    // transfers cannot be silently dropped: such a layout needs the ordinary combined agreement.
    function splitPlanPerParcel(plan, turfApi) {
        if (!plan?.inputParcels?.length || !plan.polygons?.some(plot => plot.jointPool)) {
            throw Object.assign(new Error('A shared courtyard and original parcels are required.'), { code: 'courtyard-required' });
        }
        const result = [];
        for (const input of plan.inputParcels) {
            const inputFeature = feature(input.geometry);
            const totalArea = turfApi.area(inputFeature);
            const polygons = [];
            let sharedArea = 0;
            let privateArea = 0;
            for (const plot of plan.polygons) {
                const hit = turfApi.intersect(inputFeature, feature(plot.geometry));
                if (!hit) continue;
                const area = turfApi.area(hit);
                if (!(area > 0)) continue;
                if (!plot.jointPool && !sameOwners(input.owners, plot.owners)) {
                    throw Object.assign(new Error('Private land changes owners in this layout.'), { code: 'private-transfer' });
                }
                if (plot.jointPool) sharedArea += area;
                else privateArea += area;
                polygons.push({ ...clone(plot), geometry: clone(hit.geometry), area, percent: 100 * area / totalArea });
            }
            if (privateArea <= 0 || Math.abs(sharedArea + privateArea - totalArea) > Math.max(0.05, totalArea * 1e-8)) {
                throw Object.assign(new Error('Every parcel must retain its private remainder and its full area.'), { code: 'private-transfer' });
            }
            result.push({ input: clone(input), totalArea, polygons });
        }
        if (!result.some(part => part.polygons.some(plot => plot.jointPool))) {
            throw Object.assign(new Error('No parcel contributes to the courtyard.'), { code: 'courtyard-required' });
        }
        return result;
    }

    return { computeJointProRataShares, jointOwnersForLayout, deriveCourtyardFromFootprint,
        existingParcelPlots, carveLayout, buildingCourtyardCandidates, splitPlanPerParcel };
});
