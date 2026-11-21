// proposals/plan-scope.js — a measured plan narrowed to one cadastral parcel, so Compare plans can set
// plans side by side on the parcel an owner holds as well as over all their land. A narrowed plan is
// the same prepared snapshot (PlanAnalysis.prepare) with its land, its parcels, its formed pieces and
// road ground, and its designs' buildings and open space clipped to the parcel; Plan stats and the
// present state then measure it exactly as they measure a whole plan. A building across the parcel's
// edge counts its part on the parcel, with its stated storeys.
//
// Pure: snapshots and GeoJSON in, snapshots out. The geometry operations come from the caller
// (ops.intersect(a, b) → Feature|null, ops.areaOf(feature) → m²; PresentState.ops in the browser).
// window.__planScope.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__planScope = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const keyOf = feature => String(feature?.properties?.parcelId ?? feature?.id ?? '');
    // The number a person reads for a parcel (proposals/parcel-id.js: a browser global, required in node).
    const displayNumber = (feature, fallback) => (typeof getParcelDisplayNumberFromFeature === 'function'
        ? getParcelDisplayNumberFromFeature : require('./parcel-id.js').getParcelDisplayNumberFromFeature)(feature, fallback);

    // The parcels the compared plans stand on, each once: { id, number, areaM2, plans, feature },
    // the ones every plan stands on first, then the larger first.
    function parcelsOf(snapshots, ops) {
        const byId = new Map();
        (snapshots || []).forEach((snapshot, index) => (snapshot?.cadastralFeatures || []).forEach(feature => {
            const id = keyOf(feature);
            if (!id) return;
            if (!byId.has(id)) {
                byId.set(id, { id, number: displayNumber(feature, id),
                    areaM2: ops.areaOf(feature), plans: new Set(), feature });
            }
            byId.get(id).plans.add(index);
        }));
        return [...byId.values()].map(entry => ({ ...entry, plans: entry.plans.size }))
            .sort((a, b) => b.plans - a.plans || b.areaM2 - a.areaM2 || a.id.localeCompare(b.id));
    }

    // The part of a feature on the parcel, its properties kept; null when nothing of it is there.
    function partOn(feature, parcel, ops) {
        if (!feature?.geometry) return null;
        const piece = ops.intersect(feature, parcel);
        return piece?.geometry && ops.areaOf(piece) > 0 ? { ...feature, geometry: piece.geometry } : null;
    }

    const clipAll = (features, parcel, ops) => (features || []).map(feature => partOn(feature, parcel, ops)).filter(Boolean);

    // A building list in either shape (plain features, or the older { feature } wrapper).
    function clipBuildings(list, parcel, ops) {
        return list.map(entry => {
            const feature = entry?.feature ?? entry;
            if (!feature?.geometry) return entry;
            const part = partOn(feature, parcel, ops);
            if (!part) return null;
            return entry?.feature ? { ...entry, feature: part } : part;
        }).filter(Boolean);
    }

    // One design record with its buildings and open space cut to the parcel.
    function recordOn(record, parcel, ops) {
        const out = { ...record };
        if (Array.isArray(record.geometry?.buildings)) out.geometry = { ...record.geometry, buildings: clipBuildings(record.geometry.buildings, parcel, ops) };
        for (const key of ['buildingProposal', 'building_proposal']) {
            if (Array.isArray(record[key]?.buildings)) out[key] = { ...record[key], buildings: clipBuildings(record[key].buildings, parcel, ops) };
        }
        for (const key of ['structureProposal', 'structure_proposal']) {
            const geometry = record[key]?.geometry;
            if (!geometry) continue;
            const part = partOn(geometry.type === 'Feature' ? geometry : { type: 'Feature', properties: {}, geometry }, parcel, ops);
            out[key] = { ...record[key], geometry: part ? (geometry.type === 'Feature' ? part : part.geometry) : null };
        }
        return out;
    }

    /**
     * The snapshot narrowed to one parcel (a cadastral Feature). Designs not declared on the parcel
     * do nothing there and are left out. What was measured over the whole plan (its ground, its
     * laid-out apartments) is dropped, so the caller measures the narrowed plan afresh.
     */
    function toParcel(snapshot, parcel, ops) {
        const id = keyOf(parcel);
        const { land, remaining, units, groundError, unitsCounting, ...rest } = snapshot;
        const landPart = snapshot.landFeature ? ops.intersect(snapshot.landFeature, parcel) : null;
        const records = (snapshot.records || [])
            .filter(record => (record.cadastreParcelIds || []).map(String).includes(id))
            .map(record => recordOn(record, parcel, ops));
        return { ...rest, records, scopeParcelId: id,
            landFeature: landPart?.geometry && ops.areaOf(landPart) > 0 ? landPart : null,
            cadastralFeatures: (snapshot.cadastralFeatures || []).filter(feature => keyOf(feature) === id),
            materializedFeatures: clipAll(snapshot.materializedFeatures, parcel, ops),
            corridorFeatures: clipAll(snapshot.corridorFeatures, parcel, ops) };
    }

    return { parcelsOf, toParcel, recordOn };
});
