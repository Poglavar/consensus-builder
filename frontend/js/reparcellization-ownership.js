/* Pure validation and data shaping for reparcellization ownership declarations. */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.ReparcellizationOwnership = factory();
}(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this), function () {
    const EPSILON = 1e-6;

    function shapeSliceOwnership(slice, proposalData) {
        if (!slice || typeof slice !== 'object') return null;
        if (Array.isArray(slice.owners)) {
            if (!slice.owners.length) throw new Error('Reparcellization ownership requires at least one owner');
            const owners = slice.owners.map((entry, index) => {
                if (!entry || !String(entry.ownerKey || '').trim()) throw new Error(`Reparcellization owner ${index + 1} is missing ownerKey`);
                const share = entry.share;
                if (!Number.isFinite(share) || share <= 0) throw new Error(`Reparcellization owner ${index + 1} has an invalid share`);
                const name = String(entry.displayName || entry.ownerLabel || entry.name || entry.ownerKey).trim();
                return {
                    name,
                    ownerLabel: name,
                    ownerKey: String(entry.ownerKey).trim(),
                    percentageShare: share * 100,
                    actualShareText: `${share * 100}%`
                };
            });
            const total = owners.reduce((sum, owner) => sum + owner.percentageShare / 100, 0);
            if (new Set(owners.map(owner => owner.ownerKey)).size !== owners.length) {
                throw new Error('Reparcellization owners must have unique owner keys');
            }
            if (Math.abs(total - 1) > EPSILON) throw new Error(`Reparcellization owner shares must sum to 1 (got ${total})`);
            return { owners, jointPool: slice.jointPool === true };
        }
        const ownerKey = String(slice.ownerKey || '').trim();
        const name = String(slice.displayName || proposalData?.author || 'Owner').trim();
        if (!ownerKey) throw new Error('Reparcellization slice is missing ownerKey');
        return {
            owners: [{ name, ownerLabel: name, ownerKey, percentageShare: 100, actualShareText: '100%' }],
            jointPool: false
        };
    }

    function validatePlanOwnership(polygons, proposalData) {
        return (Array.isArray(polygons) ? polygons : []).map(slice => shapeSliceOwnership(slice, proposalData));
    }

    return { shapeSliceOwnership, validatePlanOwnership, EPSILON };
}));
