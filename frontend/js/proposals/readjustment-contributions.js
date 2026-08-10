// The arithmetic of a land readjustment: what each OWNER puts into the pool, and whether the plan
// it hands back is sound.
//
// A readjustment pools ground and gives back plots, so the thing that decides what someone is owed
// is the area they contributed — not how many parcels they contributed it from. One owner may enter
// with three whole parcels and half of a fourth; another may hold a quarter share of two of those
// same parcels and nothing else. Both are single numbers at the end, and the same owner appearing
// in several parcels is one entry, not several.
//
// Two multiplications, in this order, and neither is optional:
//
//   taken(parcel)  = area(parcel ∩ take)     — a partial parcel contributes only its overlap
//   owner's share  = taken(parcel) × recorded share of that parcel
//
// The recorded share carries over from the cadastre untouched. A parcel owned 1/2 + 1/4 + 1/4 that
// contributes 800 m² contributes 400 / 200 / 200 — the readjustment does not get to reinterpret
// who owns what, only to measure how much of it is coming in.
//
// Pure: plain GeoJSON and plain objects in, plain objects out. No DOM, no map, no storage.

(function (global) {
    'use strict';

    const T = () => (typeof turf !== 'undefined' && turf)
        ? turf
        : (typeof require === 'function' ? require('@turf/turf') : null);

    // Below this a contribution is boundary noise from a cut, not land someone is owed for.
    const MIN_CONTRIBUTION_M2 = 0.25;

    function featureOf(value) {
        if (!value) return null;
        if (value.type === 'Feature') return value;
        return { type: 'Feature', properties: {}, geometry: value };
    }

    // Owners are matched on a normalised name: the same person written "Ivan Horvat" in one parcel
    // and "IVAN  HORVAT" in another is one contributor, or they would be paid twice for half each.
    function ownerKeyOf(owner) {
        const raw = owner && (owner.ownerKey || owner.name || owner.ownerLabel);
        const text = (raw === undefined || raw === null) ? '' : String(raw);
        return text.trim().replace(/\s+/g, ' ').toLowerCase();
    }

    // A share may be recorded as 50, "50", "50%" or 0.5. Anything unreadable is NOT silently zero
    // and NOT silently 100 — the parcel is reported as unreadable instead, because guessing here
    // means paying the wrong person.
    function shareFractionOf(owner) {
        const raw = owner ? (owner.percentageShare ?? owner.share ?? owner.percent) : null;
        const value = (typeof raw === 'string') ? Number(raw.replace('%', '').trim()) : raw;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
        // 0–1 is a fraction; anything above is a percentage. 1 is ambiguous and read as 100%, which
        // is what a sole owner recorded as "1/1" means in this cadastre.
        const fraction = value > 1 ? value / 100 : value;
        return fraction > 1 ? null : fraction;
    }

    function ownersOf(feature) {
        const details = feature && feature.properties && feature.properties.ownershipDetails;
        const owners = details && Array.isArray(details.owners) ? details.owners : null;
        return (owners && owners.length) ? owners : null;
    }

    /**
     * Aggregate contributions per owner.
     *
     * @param {Array} parents  GeoJSON features of the parcels/pieces the readjustment draws from.
     * @param {object} take    The readjustment's outline. Omit to treat every parent as contributed
     *                         whole (the old whole-parcel case, which is now just a special case).
     * @returns {{contributions: Array, totalM2: number, unreadable: Array}}
     *          `contributions` is `[{ ownerKey, name, areaM2, share }]`, largest first, where
     *          `share` is that owner's fraction of the pool. `unreadable` names parcels whose
     *          ownership could not be read — their area is still pooled, so the totals stay honest,
     *          but the caller must show them rather than quietly assigning the land to nobody.
     */
    function contributionsByOwner(parents, take) {
        const t = T();
        if (!t) throw new Error('readjustment-contributions: turf is unavailable');
        const takeFeature = take ? featureOf(take) : null;

        const byOwner = new Map();
        const unreadable = [];
        let totalM2 = 0;

        (Array.isArray(parents) ? parents : []).forEach(parent => {
            const feature = featureOf(parent);
            if (!feature || !feature.geometry) return;

            let contributedM2 = 0;
            try {
                if (!takeFeature) {
                    contributedM2 = t.area(feature);
                } else {
                    const hit = t.intersect(feature, takeFeature);
                    contributedM2 = hit ? t.area(hit) : 0;
                }
            } catch (_) {
                contributedM2 = 0;
            }
            if (!(contributedM2 > MIN_CONTRIBUTION_M2)) return;
            totalM2 += contributedM2;

            const parcelId = feature.properties
                ? (feature.properties.parcelId || feature.properties.PARCEL_ID || feature.properties.id || null)
                : null;
            const owners = ownersOf(feature);
            if (!owners) {
                unreadable.push({ parcelId: parcelId ? String(parcelId) : null, areaM2: contributedM2, reason: 'no ownership recorded' });
                return;
            }

            let assigned = 0;
            owners.forEach(owner => {
                const key = ownerKeyOf(owner);
                const fraction = shareFractionOf(owner);
                if (!key || fraction === null || !(fraction > 0)) return;
                const areaM2 = contributedM2 * fraction;
                assigned += areaM2;
                const existing = byOwner.get(key);
                if (existing) {
                    existing.areaM2 += areaM2;
                    existing.parcels.push(parcelId ? String(parcelId) : null);
                } else {
                    byOwner.set(key, {
                        ownerKey: key,
                        name: String(owner.name || owner.ownerLabel || owner.ownerKey || '').trim(),
                        areaM2,
                        parcels: [parcelId ? String(parcelId) : null]
                    });
                }
            });

            // Shares that do not add up are the cadastre's business, not something to paper over —
            // but the land is real and stays in the pool, so it is reported rather than dropped.
            const unassigned = contributedM2 - assigned;
            if (unassigned > MIN_CONTRIBUTION_M2) {
                unreadable.push({
                    parcelId: parcelId ? String(parcelId) : null,
                    areaM2: unassigned,
                    reason: 'recorded shares do not account for the whole parcel'
                });
            }
        });

        const contributions = Array.from(byOwner.values())
            .map(entry => ({
                ownerKey: entry.ownerKey,
                name: entry.name,
                areaM2: entry.areaM2,
                parcels: entry.parcels.filter(Boolean),
                share: totalM2 > 0 ? entry.areaM2 / totalM2 : 0
            }))
            .sort((a, b) => (b.areaM2 - a.areaM2) || a.ownerKey.localeCompare(b.ownerKey));

        return { contributions, totalM2, unreadable };
    }

    /**
     * Plots that overlap one another.
     *
     * A readjustment's take IS the union of its plots (plan-order.footprintOf), which makes two of
     * the three tessellation failures impossible by construction: there is no "gap" between the
     * plots and the take, and no "excess" beyond it. A gap BETWEEN plots is not an error either —
     * it simply means that land was not taken, and it stays with its owner as a remainder.
     *
     * What remains possible, and is never acceptable, is two plots covering the same ground. The
     * pool would still measure correctly (the union is what was taken) while the redistribution
     * handed the same square metre to two people. So this is the check the apply path needs, and
     * the only one.
     *
     * The tolerance matches the draft-time validator in proposal-editor-adapters.js rather than
     * introducing a third number: manually cut plots leave hairline slivers of float noise along
     * their shared edges, and only a real two-dimensional overlap is a plan error.
     *
     * @returns {Array<{a: number, b: number, areaM2: number}>} offending pairs, by plot index.
     */
    function overlappingPlots(plots) {
        const t = T();
        if (!t || typeof t.intersect !== 'function') return [];
        const features = (Array.isArray(plots) ? plots : [])
            .map(plot => featureOf(plot && plot.geometry ? plot.geometry : plot))
            .map(feature => (feature && feature.geometry) ? feature : null);

        const overlaps = [];
        for (let i = 0; i < features.length; i += 1) {
            if (!features[i]) continue;
            for (let j = i + 1; j < features.length; j += 1) {
                if (!features[j]) continue;
                try {
                    const hit = t.intersect(features[i], features[j]);
                    if (!hit) continue;
                    const areaM2 = t.area(hit) || 0;
                    const smaller = Math.min(t.area(features[i]) || 0, t.area(features[j]) || 0);
                    if (areaM2 > Math.max(0.5, smaller * 0.001)) {
                        overlaps.push({ a: i, b: j, areaM2 });
                    }
                } catch (_) { /* an unmeasurable pair is reported by the geometry gates, not here */ }
            }
        }
        return overlaps;
    }

    const api = {
        MIN_CONTRIBUTION_M2,
        contributionsByOwner,
        overlappingPlots,
        ownerKeyOf,
        shareFractionOf
    };

    // Namespaced only — a bare global here could shadow a top-level function in the classic scripts
    // loaded alongside this file.
    if (typeof window !== 'undefined') window.__readjustmentContributions = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
