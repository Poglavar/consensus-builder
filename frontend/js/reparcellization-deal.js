// One versioned LR consent payload for the editor, local approvals and server plan commitments.
// This commits to declared terms; it does not attest ownership, funding or legal validity.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ReparcellizationDeal = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const SCHEMA = 'land-readjustment-deal/v2';
    const HASH_PREFIX = 'lr2-sha256:';
    const OPEN_GROUND_OWNER_KEY = 'open-ground';
    const ownership = () => root.ReparcellizationOwnership
        || (typeof require === 'function' ? require('./reparcellization-ownership.js') : null);
    const crypto = () => root.__consentSha256
        || (typeof require === 'function' ? require('../vendor/noble-hashes-1.8.0/sha256.js') : null);
    const approval = () => root.ProposalApproval
        || (typeof require === 'function' ? require('./proposals/approval.js') : null);

    function stableStringify(value) {
        if (value === null || value === undefined) return 'null';
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Deal numbers must be finite.');
        if (typeof value !== 'object') return JSON.stringify(value);
        if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
        return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort()
            .map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
    }

    // Do not use localeCompare for canonical ordering: results can differ by machine locale.
    const ordered = rows => rows.sort((a, b) => {
        const left = stableStringify(a), right = stableStringify(b);
        return left < right ? -1 : left > right ? 1 : 0;
    });
    const optionalNumber = value => {
        if (value == null) return null;
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Deal numbers must be finite numbers.');
        return value;
    };

    function moneyCents(value) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
            throw new Error('Cash offers must be finite non-negative numbers.');
        }
        const cents = Math.round((value + Number.EPSILON * Math.max(1, value)) * 100);
        if (!Number.isSafeInteger(cents)) throw new Error('Cash offer is too large to represent in cents.');
        return cents;
    }

    function geometry(value) {
        const shape = value?.type === 'Feature' ? value.geometry : value;
        if (!shape || !['Polygon', 'MultiPolygon'].includes(shape.type)) {
            throw new Error('Every readjustment plot needs polygon geometry.');
        }
        const polygons = shape.type === 'Polygon' ? [shape.coordinates] : shape.coordinates;
        if (!Array.isArray(polygons) || !polygons.length) throw new Error('Polygon geometry is empty.');
        for (const polygon of polygons) {
            if (!Array.isArray(polygon) || !polygon.length) throw new Error('Polygon geometry is empty.');
            for (const ring of polygon) {
                if (!Array.isArray(ring) || ring.length < 4 || ring.some(point => !Array.isArray(point)
                    || point.length < 2 || point.some(n => typeof n !== 'number' || !Number.isFinite(n)))
                    || stableStringify(ring[0]) !== stableStringify(ring[ring.length - 1])) {
                    throw new Error('Polygon rings must be closed and contain finite coordinates.');
                }
            }
        }
        // Coordinates are exact authored numbers. No footprint union or surveyor rounding may
        // erase an internal boundary change from the deal the owner approves.
        return { type: shape.type, coordinates: shape.coordinates };
    }

    function plot(slice) {
        const shaped = ownership().shapeSliceOwnership(slice);
        return {
            geometry: geometry(slice.geometry),
            jointPool: shaped.jointPool,
            owners: ordered(shaped.owners.map(owner => ({
                ownerKey: owner.ownerKey, share: owner.percentageShare / 100
            })))
        };
    }

    function isReadjustment(proposal) {
        return !!proposal && (proposal.goal === 'reparcellization' || !!proposal.reparcellization);
    }

    function content(proposal) {
        if (!isReadjustment(proposal)) return null;
        const plan = proposal.reparcellization;
        if (!Array.isArray(plan?.polygons) || !plan.polygons.length) throw new Error('Readjustment needs replacement plots.');
        if (plan.ownerShares != null && !Array.isArray(plan.ownerShares)) throw new Error('Owner ledger must be an array.');
        const keys = new Set();
        const ledger = ordered((plan.ownerShares || []).map(owner => {
            const key = String(owner?.ownerKey || '').trim();
            if (!key || keys.has(key)) throw new Error('Owner ledger needs unique, non-empty owner keys.');
            keys.add(key);
            const noOwner = owner.noOwner === true || key === OPEN_GROUND_OWNER_KEY;
            const cashCents = moneyCents(owner.cashOffer === undefined || (noOwner && owner.cashOffer === null) ? 0 : owner.cashOffer);
            if (noOwner && cashCents) throw new Error('Ownerless ground cannot receive cash.');
            return {
                ownerKey: key, noOwner, cashCents,
                contributedArea: optionalNumber(owner.contributedArea),
                contributedValue: optionalNumber(owner.contributedValue),
                entitledValue: optionalNumber(owner.entitledValue),
                assignedArea: optionalNumber(owner.assignedArea),
                assignedValue: optionalNumber(owner.assignedValue),
                cashBalance: optionalNumber(owner.cashBalance)
            };
        }));
        const totalCashCents = ledger.reduce((sum, owner) => sum + owner.cashCents, 0);
        if (!Number.isSafeInteger(totalCashCents)) throw new Error('Total cash offer is too large.');
        if (moneyCents(proposal.offer ?? 0) !== totalCashCents) throw new Error('Proposal offer must equal the owner cash ledger.');
        // A deal without cash has no currency: the stored record may still carry one (a database
        // column default stamped USD on the Borovje readjustments), and it must not void the deal.
        const currency = totalCashCents ? String(proposal.offerCurrency || proposal.currency || 'EUR').toUpperCase() : null;
        if (currency !== null && currency !== 'EUR') throw new Error('Readjustment cash offers currently use EUR.');
        return {
            schema: SCHEMA,
            approval: approval().contextContent(proposal),
            cadastreParcelIds: [...new Set((proposal.cadastreParcelIds || []).map(String))].sort(),
            poolGeometry: plan.poolGeometry ? geometry(plan.poolGeometry) : null,
            poolSource: plan.poolSource || null,
            plots: ordered(plan.polygons.map(plot)),
            inputs: ordered((plan.inputParcels || []).map(plot)),
            valuation: {
                contributionBasis: plan.contributionBasis ?? null,
                poolUnitValue: optionalNumber(plan.poolUnitValue),
                totalValue: optionalNumber(plan.totalValue),
                contributionRatio: optionalNumber(plan.contributionRatio)
            },
            ledger,
            terms: {
                totalCashCents, currency,
                isConditional: proposal.isConditional === true,
                expiresAt: proposal.expiresAt == null ? null : new Date(proposal.expiresAt).toISOString(),
                depositEnabled: proposal.depositEnabled === true,
                depositPercent: optionalNumber(proposal.depositPercent),
                decayEnabled: proposal.decayEnabled === true,
                decayPercent: optionalNumber(proposal.decayPercent),
                decayDurationMs: optionalNumber(proposal.decayDurationMs),
                disbursementMode: proposal.disbursementMode ?? null
            },
            agreement: proposal.reparcellizationAgreement ?? null,
            // Reserve the complete authored policy/electorate in the commitment. Their presence
            // does not enable threshold execution; that evaluator is not implemented yet.
            regime: plan.regime ?? null,
            policy: plan.policy ?? null,
            electorate: plan.electorate ?? null
        };
    }

    function fingerprint(proposal) {
        let payload;
        try {
            payload = content(proposal);
        } catch (error) {
            const validationError = error instanceof Error ? error : new Error(String(error));
            validationError.code = 'invalid-readjustment-deal';
            throw validationError;
        }
        return payload ? HASH_PREFIX + crypto().sha256Hex(stableStringify(payload)) : null;
    }

    // Identical designs may be reused under different approval setups. Only the full fingerprint
    // is valid for consent; this separate identity is for design comparison/reuse.
    function designFingerprint(proposal) {
        const payload = content(proposal);
        if (!payload) return null;
        const { approval: _approval, ...design } = payload;
        return 'lr-design2-sha256:' + crypto().sha256Hex(stableStringify(design));
    }

    return { SCHEMA, HASH_PREFIX, isReadjustment, content, fingerprint, designFingerprint, stableStringify, moneyCents };
});
