/* Pure validation and data shaping for reparcellization ownership declarations. */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.ReparcellizationOwnership = factory();
}(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this), function () {
    const EPSILON = 1e-6;
    const OPEN_GROUND_OWNER_KEY = 'open-ground';
    const UNASSIGNED_LABELS = new Set(['unassigned', 'sin asignar', 'nedodijeljeno', 'nedodeljeno']);

    function isUnassignedLabel(value) {
        return UNASSIGNED_LABELS.has(String(value || '').trim().normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase());
    }

    function shapeSliceOwnership(slice, proposalData) {
        if (!slice || typeof slice !== 'object') return null;
        if (Object.prototype.hasOwnProperty.call(slice, 'noOwner')) {
            throw new Error('The noOwner marker is retired; use unrepresentedGround');
        }
        if (Array.isArray(slice.owners) && slice.owners.some(entry =>
            Object.prototype.hasOwnProperty.call(entry || {}, 'noOwner'))) {
            throw new Error('The noOwner marker is retired; use unrepresentedGround');
        }
        // Site-backed plans can include unrepresented open-ground plots. They remain open ground
        // through application and must not be assigned to a synthetic owner agent.
        const listedOwners = Array.isArray(slice.owners) ? slice.owners : null;
        const unrepresentedGround = slice.ownerKey === OPEN_GROUND_OWNER_KEY || slice.unrepresentedGround === true;
        if (slice.unrepresentedGround === true && slice.ownerKey && slice.ownerKey !== OPEN_GROUND_OWNER_KEY) {
            throw new Error('Unrepresented ground cannot also name a represented owner');
        }
        if (unrepresentedGround) {
            if (slice.ownerKey && slice.ownerKey !== OPEN_GROUND_OWNER_KEY) {
                throw new Error('Unrepresented ground cannot also name a represented owner');
            }
            if (listedOwners?.length) {
                // The current site subdivision editor encodes its unrepresented pool share in
                // owners[] as a single sentinel row. It is not an owner: recognize only the
                // complete sentinel allocation, never a mixed or fractional share.
                const sentinelOnly = listedOwners.length === 1
                    && listedOwners[0]?.ownerKey === OPEN_GROUND_OWNER_KEY
                    && listedOwners[0]?.share === 1;
                if (!sentinelOnly) {
                    throw new Error('Unrepresented open-ground slices require one complete sentinel allocation');
                }
            }
            return { owners: [], jointPool: false };
        }
        if (Array.isArray(slice.owners)) {
            if (!slice.owners.length) throw new Error('Reparcellization ownership requires at least one owner');
            const owners = slice.owners.map((entry, index) => {
                if (Object.prototype.hasOwnProperty.call(entry || {}, 'noOwner')) {
                    throw new Error(`Reparcellization owner ${index + 1} uses the retired noOwner marker`);
                }
                if (entry?.unrepresentedGround === true && entry?.ownerKey !== OPEN_GROUND_OWNER_KEY) {
                    throw new Error(`Reparcellization allocation ${index + 1} cannot mark a represented owner as unrepresented ground`);
                }
                if (entry?.ownerKey === OPEN_GROUND_OWNER_KEY) {
                    throw new Error(`Reparcellization owner ${index + 1} uses the open-ground accounting sentinel`);
                }
                if (!entry || !String(entry.ownerKey || '').trim()) throw new Error(`Reparcellization owner ${index + 1} is missing ownerKey`);
                const share = entry.share;
                if (!Number.isFinite(share) || share <= 0) throw new Error(`Reparcellization owner ${index + 1} has an invalid share`);
                const explicitName = entry.displayName || entry.ownerLabel || entry.name || '';
                if (explicitName && isUnassignedLabel(explicitName)) {
                    throw new Error(`Reparcellization owner ${index + 1} uses an unassigned placeholder label`);
                }
                const name = String(explicitName || entry.ownerKey).trim();
                if (!name) throw new Error(`Reparcellization owner ${index + 1} is missing a name`);
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
        if (isUnassignedLabel(slice.displayName)) {
            throw new Error('Reparcellization slice uses an unassigned placeholder label');
        }
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
