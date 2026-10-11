/* Pure helpers for exact recipient allocations and per-owner readjustment impact. */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ReparcellizationAllocation = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const SUM_TOLERANCE_PERCENT = 1e-8;
    function parsePercentShares(rows) {
        if (!Array.isArray(rows) || !rows.length) throw new Error('Recipient shares need at least one row.');
        const seen = new Set();
        const parsed = rows.map((row, index) => {
            const ownerKey = typeof row?.ownerKey === 'string' ? row.ownerKey.trim() : '';
            if (!ownerKey) throw new Error(`Recipient ${index + 1} needs an owner key.`);
            if (seen.has(ownerKey)) throw new Error(`Recipient owner key ${ownerKey} is duplicated.`);
            seen.add(ownerKey);

            const raw = row.percent;
            let percent;
            if (typeof raw === 'number') percent = raw;
            else if (typeof raw === 'string' && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw.trim())) percent = Number(raw.trim());
            else throw new Error(`Recipient ${ownerKey} needs a decimal percentage.`);
            if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
                throw new Error(`Recipient ${ownerKey} percentage must be greater than 0 and at most 100.`);
            }
            return { ownerKey, displayName: row.displayName, color: row.color, percent };
        });

        const total = parsed.reduce((sum, row) => sum + row.percent, 0);
        if (Math.abs(total - 100) > SUM_TOLERANCE_PERCENT) {
            throw new Error(`Recipient percentages must sum to 100 (got ${total}).`);
        }
        let assigned = 0;
        const shares = parsed.map((row, index) => {
            const share = index === parsed.length - 1 ? 1 - assigned : row.percent / 100;
            assigned += share;
            return { ownerKey: row.ownerKey, displayName: row.displayName, color: row.color, share };
        });
        if (shares[shares.length - 1].share <= 0) {
            throw new Error('Recipient percentages cannot be represented as positive shares.');
        }
        return shares;
    }

    function validateGeometry(value, plotIndex) {
        const geometry = value?.type === 'Feature' ? value.geometry : value;
        if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) {
            throw new Error(`Plot ${plotIndex + 1} needs Polygon or MultiPolygon geometry.`);
        }
        const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
        if (!Array.isArray(polygons) || !polygons.length) throw new Error(`Plot ${plotIndex + 1} geometry is empty.`);
        for (const polygon of polygons) {
            if (!Array.isArray(polygon) || !polygon.length) throw new Error(`Plot ${plotIndex + 1} geometry is empty.`);
            for (const ring of polygon) {
                if (!Array.isArray(ring) || ring.length < 4 || ring.some(point =>
                    !Array.isArray(point) || point.length < 2 || point.some(value => typeof value !== 'number' || !Number.isFinite(value)))) {
                    throw new Error(`Plot ${plotIndex + 1} has invalid polygon coordinates.`);
                }
                const first = ring[0], last = ring[ring.length - 1];
                if (first[0] !== last[0] || first[1] !== last[1]) {
                    throw new Error(`Plot ${plotIndex + 1} has an open polygon ring.`);
                }
            }
        }
        return geometry;
    }

    function ownershipApi() {
        return root.ReparcellizationOwnership
            || (typeof require === 'function' ? require('./reparcellization-ownership.js') : null);
    }

    function dealApi() {
        return root.ReparcellizationDeal
            || (typeof require === 'function' ? require('./reparcellization-deal.js') : null);
    }

    function ownerImpact(owner, plots, turfApi) {
        const ownerKey = typeof owner?.ownerKey === 'string' ? owner.ownerKey.trim() : '';
        if (!ownerKey) throw new Error('Owner impact needs an owner key.');
        if (!Array.isArray(plots)) throw new Error('Owner impact plots must be an array.');
        if (!turfApi || typeof turfApi.area !== 'function') throw new Error('Owner impact needs a Turf area function.');

        let contributedAreaM2 = null;
        if (owner.unresolvedContribution !== true) {
            const hasExplicitContribution = Object.prototype.hasOwnProperty.call(owner, 'contributedArea');
            const rawContribution = hasExplicitContribution && owner.contributedArea !== null
                ? owner.contributedArea
                : (hasExplicitContribution ? null : owner.area);
            if (rawContribution !== null && Number.isFinite(rawContribution)) {
                if (rawContribution < 0) throw new Error('Owner contributed area cannot be negative.');
                contributedAreaM2 = rawContribution;
            }
        }
        const ownerPlots = [];
        let assignedAreaM2 = 0;

        plots.forEach((plot, index) => {
            if (!plot || typeof plot !== 'object') throw new Error(`Plot ${index + 1} is invalid.`);
            const geometry = validateGeometry(plot.geometry, index);
            // Empty ownership on a design plot means it is still unassigned. A singular ownerKey
            // is the compact form used by some saved plans; all assigned shapes go through the
            // shared validator so its duplicate-key and sum tolerance remain authoritative.
            const isUnassigned = Array.isArray(plot.owners) && !plot.owners.length
                && !String(plot.ownerKey || '').trim() && plot.noOwner !== true;
            if (isUnassigned) return;
            const shaped = ownershipApi().shapeSliceOwnership(plot);
            const share = shaped.owners.find(allocation => allocation.ownerKey === ownerKey)?.percentageShare / 100 || 0;
            if (!share) return;
            const areaM2 = turfApi.area({ type: 'Feature', properties: {}, geometry });
            if (typeof areaM2 !== 'number' || !Number.isFinite(areaM2) || areaM2 < 0) {
                throw new Error(`Plot ${index + 1} has an invalid measured area.`);
            }
            const assigned = areaM2 * share;
            ownerPlots.push({ index, areaM2, share, assignedAreaM2: assigned, jointPool: plot.jointPool === true });
            assignedAreaM2 += assigned;
        });

        const cashOfferCents = dealApi().moneyCents(owner.cashOffer ?? 0);
        return {
            ownerKey,
            contributedAreaM2,
            assignedAreaM2,
            areaChangeM2: contributedAreaM2 == null ? null : assignedAreaM2 - contributedAreaM2,
            plots: ownerPlots,
            cashOfferCents
        };
    }

    return { parsePercentShares, ownerImpact };
});
