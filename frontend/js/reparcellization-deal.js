// One versioned LR consent payload for the editor, local approvals and server plan commitments.
// This commits to declared terms; it does not attest ownership, funding or legal validity.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ReparcellizationDeal = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const SCHEMA = 'land-readjustment-deal/v3';
    const HASH_PREFIX = 'lr3-sha256:';
    const OPEN_GROUND_OWNER_KEY = 'open-ground';
    const ownership = () => root.ReparcellizationOwnership
        || (typeof require === 'function' ? require('./reparcellization-ownership.js') : null);
    const crypto = () => root.__consentSha256
        || (typeof require === 'function' ? require('../vendor/noble-hashes-1.8.0/sha256.js') : null);
    const approval = () => root.ProposalApproval
        || (typeof require === 'function' ? require('./proposals/approval.js') : null);
    const cityMoney = () => root.CityMoney
        || (typeof require === 'function' ? require('./city-money.js') : null);
    const isFiat = code => cityMoney().isFiat(code);

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

    // Content identity within a proposal, derived from the same plot payload the deal commits.
    // It is independent of array position and runtime cuts, not a continuing identity after edits.
    function plotFingerprint(slice) {
        const payload = { schema: 'land-readjustment-plot/v1', plot: plot(slice) };
        return 'lr-plot1-sha256:' + crypto().sha256Hex(stableStringify(payload));
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
            if (Object.prototype.hasOwnProperty.call(owner, 'noOwner')) {
                throw new Error('The noOwner marker is retired; use unrepresentedGround.');
            }
            const unrepresentedGround = owner.unrepresentedGround === true || key === OPEN_GROUND_OWNER_KEY;
            if (owner.unrepresentedGround === true && key !== OPEN_GROUND_OWNER_KEY) {
                throw new Error('Unrepresented ground cannot also name a represented owner.');
            }
            const cashCents = moneyCents(owner.cashOffer === undefined || (unrepresentedGround && owner.cashOffer === null) ? 0 : owner.cashOffer);
            // What the owner pays into the deal (e.g. for land beyond their entitlement). Present only
            // when non-zero, so deals without owner payments keep their committed fingerprint.
            const payCents = owner.cashPayment == null ? 0 : moneyCents(owner.cashPayment);
            if (unrepresentedGround && (cashCents || payCents)) throw new Error('Unrepresented ground cannot receive or pay cash.');
            if (cashCents && payCents) throw new Error('An owner either receives or pays cash, not both.');
            return {
                ownerKey: key, unrepresentedGround, cashCents, ...(payCents ? { payCents } : {}),
                contributedArea: optionalNumber(owner.contributedArea),
                contributedValue: optionalNumber(owner.contributedValue),
                entitledValue: optionalNumber(owner.entitledValue),
                assignedArea: optionalNumber(owner.assignedArea),
                assignedValue: optionalNumber(owner.assignedValue),
                cashBalance: optionalNumber(owner.cashBalance)
            };
        }));
        const totalCashCents = ledger.reduce((sum, owner) => sum + owner.cashCents, 0);
        const ownerPaymentsCents = ledger.reduce((sum, owner) => sum + (owner.payCents || 0), 0);
        if (!Number.isSafeInteger(totalCashCents) || !Number.isSafeInteger(ownerPaymentsCents)) throw new Error('Total cash offer is too large.');
        if (moneyCents(proposal.offer ?? 0) !== totalCashCents) throw new Error('Proposal offer must equal the owner cash ledger.');
        // A deal without cash has no currency: the stored record may still carry one (a database
        // column default stamped USD on the Borovje readjustments), and it must not void the deal.
        // Cash and land values are a country's money (ISO 4217), the city's when it was authored,
        // never a chain token, and one deal counts both in the same one.
        const hasCash = totalCashCents > 0 || ownerPaymentsCents > 0;
        const currency = hasCash ? String(proposal.offerCurrency || '').toUpperCase() : null;
        if (hasCash && !isFiat(currency)) throw new Error('Readjustment cash offers require an explicit fiat offerCurrency (ISO 4217).');
        const contributionBasis = plan.contributionBasis ?? null;
        const valuationCurrency = plan.valuationCurrency ?? null;
        if ((contributionBasis === 'value' && !isFiat(valuationCurrency))
            || (contributionBasis !== 'value' && valuationCurrency !== null)) {
            throw new Error('Readjustment value allocations require a fiat valuationCurrency; other allocation bases must not declare one.');
        }
        if (hasCash && contributionBasis === 'value' && currency !== valuationCurrency) {
            throw new Error('Readjustment cash and land values must be in one currency.');
        }
        return {
            schema: SCHEMA,
            approval: approval().contextContent(proposal),
            cadastreParcelIds: [...new Set((proposal.cadastreParcelIds || []).map(String))].sort(),
            poolGeometry: plan.poolGeometry ? geometry(plan.poolGeometry) : null,
            poolSource: plan.poolSource || null,
            plots: ordered(plan.polygons.map(plot)),
            inputs: ordered((plan.inputParcels || []).map(plot)),
            valuation: {
                contributionBasis,
                currency: valuationCurrency,
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

    // The deal's money as one balanced schedule: each owner's net (+ receives, − pays) and the
    // sponsor (the proposer), whose line makes the total exactly zero. The sponsor pays what owner
    // payments do not cover, or receives what they exceed. Derived from the committed ledger, so
    // the deal fingerprint already commits it.
    function schedule(payload) {
        const owners = (payload?.ledger || []).filter(owner => !owner.unrepresentedGround)
            .map(owner => ({ party: 'owner', ownerKey: owner.ownerKey, amountCents: owner.cashCents - (owner.payCents || 0) }))
            .filter(line => line.amountCents !== 0);
        const payOutCents = owners.filter(line => line.amountCents > 0).reduce((sum, line) => sum + line.amountCents, 0);
        const payInCents = owners.filter(line => line.amountCents < 0).reduce((sum, line) => sum - line.amountCents, 0);
        const sponsorCents = payInCents - payOutCents;
        const lines = [...owners, { party: 'sponsor', amountCents: sponsorCents }];
        return {
            currency: payload?.terms?.currency ?? null, lines, payOutCents, payInCents, sponsorCents,
            // What the sponsor must fund before the deal can execute; owner payments settle with it.
            sponsorFundingCents: Math.max(0, -sponsorCents),
            balanced: lines.reduce((sum, line) => sum + line.amountCents, 0) === 0
        };
    }

    // An owner's net cash (+ receives, − pays) and the ledger fields that store it.
    const netCash = owner => (Number(owner?.cashOffer) || 0) - (Number(owner?.cashPayment) || 0);
    function cashFields(amount) {
        if (typeof amount !== 'number' || !Number.isFinite(amount)) throw new Error('Cash must be a finite amount.');
        return amount < 0 ? { cashOffer: 0, cashPayment: -amount } : { cashOffer: amount };
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
        return 'lr-design3-sha256:' + crypto().sha256Hex(stableStringify(design));
    }

    return { SCHEMA, HASH_PREFIX, isReadjustment, content, plotFingerprint, schedule, netCash, cashFields, fingerprint, designFingerprint, stableStringify, moneyCents };
});
