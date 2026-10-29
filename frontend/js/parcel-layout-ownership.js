// Who holds a piece formed by a parcel layout (plan-design-agreement.md, M1 (a)): the owners of the
// ground under it, pro rata by overlapping area, with open ground left unowned. A layout changes
// borders, never ownership; only an executed agreement moves land between owners.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ParcelLayoutOwnership = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    // A holder of less than half a percent of the owned ground is a sliver along a border, not a
    // co-owner: dropped, and the other shares renormalised. This is ownership policy, not noise.
    const MIN_SHARE = 0.005;

    // Whether a source parcel is under the piece at all is the shared rule (geometry-tolerances.js
    // isGround of their overlap on the shared clip), the rule formation-edit.js overlappingBaseIds
    // uses for a piece's cadastral anchors, so holders and anchors agree.
    function groundApi() {
        return (root && root.GeometryTolerances)
            || (typeof require === 'function' ? require('./geometry-tolerances.js') : null);
    }

    function arrangementApi() {
        return (root && root.__parcelArrangement)
            || (typeof require === 'function' ? require('./proposals/parcel-arrangement.js') : null);
    }

    const isArea = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

    function asFeature(value) {
        if (!value) return null;
        if (value.type === 'Feature') return value.geometry ? value : null;
        if (value.type === 'Polygon' || value.type === 'MultiPolygon') return { type: 'Feature', properties: {}, geometry: value };
        return null;
    }

    const disjoint = (a, b) => !!a && !!b && (a[0] > b[2] || b[0] > a[2] || a[1] > b[3] || b[1] > a[3]);

    /**
     * The holders of one formed piece.
     * @param plot the piece (Feature or Polygon/MultiPolygon geometry)
     * @param sources the parcels it was formed from (Features)
     * @param ownerOf (source) => { ownerKey, displayName } | null — null for open ground or a parcel
     *   with no recorded owner; injected, so the apply path passes the app's own owner lookup
     * @param options { turf }
     * @returns {{ owners: { ownerKey: string, displayName: string, share: number }[],
     *   openGroundShare: number }} owners sorted by share (largest first), shares summing to 1
     *   over the owned ground; an owner holding several sources is one entry. openGroundShare is
     *   the fraction of the piece no owned source covers.
     */
    function ownersOf(plot, sources, ownerOf, options = {}) {
        if (typeof ownerOf !== 'function') throw new TypeError('ownersOf needs an ownerOf(source) lookup.');
        const t = options.turf || (root && root.turf) || null;
        if (!t || typeof t.area !== 'function' || typeof t.intersect !== 'function') throw new Error('ownersOf needs turf.');
        const area = feature => t.area(feature);
        const ground = groundApi();
        const piece = asFeature(plot);
        if (!piece) throw new Error('ownersOf needs a polygon piece.');
        const pieceArea = area(piece);
        if (!isArea(pieceArea)) throw new Error('The area of the piece could not be measured.');
        const box = typeof t.bbox === 'function' ? t.bbox(piece) : null;

        const byOwner = new Map();
        let ownedM2 = 0;
        (Array.isArray(sources) ? sources : []).forEach(source => {
            const feature = asFeature(source);
            if (!feature) return;
            const holder = ownerOf(source);
            if (holder === null || holder === undefined) return;
            const ownerKey = holder.ownerKey === undefined || holder.ownerKey === null ? '' : String(holder.ownerKey).trim();
            if (!ownerKey) throw new Error('ownerOf returned a holder without an ownerKey.');
            if (box && disjoint(box, t.bbox(feature))) return;
            // A clip that fails throws a typed ClipFailure rather than guessing a holder.
            const overlap = arrangementApi().clipWith(t, 'intersect', piece, feature, { site: 'parcel-layout-ownership.ownersOf' });
            if (!ground.isGround(t, overlap)) return;
            const overlapM2 = area(overlap);
            if (!isArea(overlapM2)) throw new Error(`The overlap with a parcel of ${ownerKey} could not be measured.`);
            const entry = byOwner.get(ownerKey) || { ownerKey, displayName: '', areaM2: 0 };
            entry.areaM2 += overlapM2;
            if (!entry.displayName && holder.displayName) entry.displayName = String(holder.displayName);
            byOwner.set(ownerKey, entry);
            ownedM2 += overlapM2;
        });

        const openGroundShare = pieceArea > 0 ? Math.min(1, Math.max(0, 1 - ownedM2 / pieceArea)) : 1;
        const shares = Array.from(byOwner.values())
            .map(entry => ({ ownerKey: entry.ownerKey, displayName: entry.displayName || entry.ownerKey, share: entry.areaM2 / ownedM2 }))
            .filter(owner => owner.share >= MIN_SHARE);
        const kept = shares.reduce((sum, owner) => sum + owner.share, 0);
        const owners = shares
            .map(owner => ({ ...owner, share: owner.share / kept }))
            .sort((a, b) => b.share - a.share || (a.ownerKey < b.ownerKey ? -1 : a.ownerKey > b.ownerKey ? 1 : 0));
        return { owners, openGroundShare };
    }

    return { ownersOf, MIN_SHARE };
});
