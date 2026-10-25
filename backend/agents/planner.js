// The agent runner's planning step: turns candidate parcels into candidate proposals — permitted
// envelope, one build-out satisfying the checked limits, its floor area and modeled gain in the city's money — and scores them against a
// persona's weights. Pure: turf is injected, nothing here touches the database or the network, and
// the same (parcels, persona, seed) always produces the same ordered list.
//
// The geometry and the money come from the app's own modules (urban-rule-variation, plan-yield,
// gain), so an agent's proposal is measured exactly the way the UI measures a human's.

import { createRequire } from 'node:module';
import { buildingBaseline } from './building-baseline.js';

const require = createRequire(import.meta.url);
const {
    DEFAULT_MAX_FLOORS,
    DEFAULT_MIN_DISTANCE_M,
    normalizeParcelRule,
    evaluateParcel,
    realizeFromEnvelope
} = require('../../frontend/js/urban-rule-variation.js');
const { measureBuilding } = require('../../frontend/js/proposals/plan-yield.js');
const { computeGain } = require('../../frontend/js/proposals/gain.js');

export { DEFAULT_MAX_FLOORS, DEFAULT_MIN_DISTANCE_M };

/** A number or null. Never a 0 conjured out of null, never NaN. */
function num(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/** A weight the persona may simply not have declared reads as 0, not as NaN. */
function weightOf(persona, key) {
    const weights = (persona && persona.weights && typeof persona.weights === 'object') ? persona.weights : {};
    return num(weights[key]) ?? 0;
}

// Did an urban rule actually say anything about this parcel, or are we building on the module's
// defaults? The distinction has to survive into the record: a proposal made under the plan and a
// proposal made under an assumption are different claims.
function ruleSourceOf(rule) {
    if (!rule || typeof rule !== 'object') return 'default';
    const stated = ['maxFloors', 'minSetbackM', 'minPlotM2', 'maxCoveragePct', 'maxGfaM2']
        .some(key => num(rule[key]) !== null);
    return stated ? 'urban-rule' : 'default';
}

/**
 * Candidate proposals for one persona, best first.
 *
 * Skips a parcel when the rule excludes it (evaluateParcel status ≠ 'ok'), when no build-out can be
 * sampled inside the envelope, when it exceeds a stated coverage/GFA limit, when the build-out cannot be measured, or when it would not add
 * floor area over a known existing-stock baseline — an agent that proposes less than exists is noise.
 * An unknown baseline permits geometry previews, but dependent quantities and weighted scores stay
 * null. Only a named source with complete inventory coverage can establish existing-stock totals.
 *
 * Scoring (all parts in 0..1 before weighting):
 *   density      (proposed − built) / max(proposed, 1)   — how much of the result is new
 *   valueUplift  gain / the best gain in this set     — relative, so it needs the whole set
 *   openSpace    1 − builtFootprint / parcelArea         — an empty lot is "open"; a densifier
 *                                                          weights this at ~0 and ignores it
 *   heritage     0                                       — PLACEHOLDER. There is no heritage
 *                                                          dataset wired in yet, so the term is
 *                                                          declared and contributes nothing rather
 *                                                          than being faked from something else.
 *
 * @param {Array} parcels        rows from parcel-source.js
 * @param {Object} persona       an entry from personas.json
 * @param {Object} options       { turf, money, floorHeightM, offerShareOfGain, seed, limit }; `money` is
 *                               the city's { currency, salePricePerM2 } (consumer-supplied money settings): gains
 *                               and offers are in the money of the place, never assumed to be euros
 */
export function planCandidates(parcels, persona, {
    turf,
    money,
    floorHeightM = 3,
    offerShareOfGain = 0.3,
    seed = 1,
    limit = 8
} = {}) {
    if (!turf) throw new Error('planCandidates: turf must be injected.');
    if (!money || typeof money.currency !== 'string' || !(money.salePricePerM2 > 0)) {
        throw new Error('planCandidates: the city\'s money ({ currency, salePricePerM2 }) must be given.');
    }
    const list = Array.isArray(parcels) ? parcels : [];
    const personaName = (persona && persona.name) ? String(persona.name) : 'agent';
    const deps = { turf };
    const candidates = [];

    list.forEach((parcel, index) => {
        if (!parcel || !parcel.geometry) return;

        const areaM2 = num(parcel.areaM2);
        const baseline = buildingBaseline(parcel);
        const { builtGfaM2, builtFootprintM2 } = baseline;
        const sourceRule = (parcel.rule && typeof parcel.rule === 'object') ? parcel.rule : null;

        // A rule that states nothing takes the module's own defaults — never Number(null), which
        // would read a missing setback as "build to the boundary".
        const allowedFloors = num(sourceRule && sourceRule.maxFloors) ?? DEFAULT_MAX_FLOORS;
        // A parcel may ask to build lower than the ceiling (a rival's gentler answer, a low-rise
        // persona); the ceiling itself stays on the candidate as allowedFloors.
        const floorCap = num(parcel.floorCap);
        const maxFloors = floorCap !== null && floorCap >= 1 ? Math.min(allowedFloors, Math.floor(floorCap)) : allowedFloors;
        const minSetbackM = num(sourceRule && sourceRule.minSetbackM) ?? DEFAULT_MIN_DISTANCE_M;
        const minPlotM2 = num(sourceRule && sourceRule.minPlotM2);
        const rule = normalizeParcelRule({
            maxFloors,
            minDistance: minSetbackM,
            floorHeightM,
            minPlotAreaM2: minPlotM2 === null ? undefined : minPlotM2
        });

        const parcelFeature = { type: 'Feature', properties: {}, geometry: parcel.geometry };
        const evaluated = evaluateParcel(parcelFeature, rule, deps);
        if (evaluated.status !== 'ok' || !evaluated.envelope) return;

        // The seed is offset by the parcel's position so two parcels in one run do not get the same
        // build-out; it stays a pure function of (seed, index), so a rerun reproduces the plan.
        const massing = realizeFromEnvelope(evaluated.envelope, rule, seed + index, deps);
        if (!massing || !massing.geometry) return;

        const measured = measureBuilding(massing, {}, { floorHeightM });
        const proposedGfaM2 = num(measured && measured.gfaM2);
        if (proposedGfaM2 === null || proposedGfaM2 <= 0) return;

        // A quantity describes the building we publish. Reject a sample that exceeds a ceiling;
        // lowering its reported area would leave an oversized building in the published record.
        // This sampler does not search for the maximum feasible capacity or retry smaller designs.
        const maxCoveragePct = num(sourceRule && sourceRule.maxCoveragePct);
        if (maxCoveragePct !== null) {
            if (areaM2 === null || areaM2 <= 0) return;
            const footprintM2 = num(measured.footprintM2);
            const allowedFootprintM2 = areaM2 * (maxCoveragePct / 100);
            if (footprintM2 === null || footprintM2 > allowedFootprintM2) return;
        }
        const maxGfaM2 = num(sourceRule && sourceRule.maxGfaM2);
        if (maxGfaM2 !== null && proposedGfaM2 > maxGfaM2) return;

        // A known non-positive uplift is rejected. Unknown stock still permits a geometry preview,
        // but it cannot establish gain, an offer or an uplift-based ranking.
        if (builtGfaM2 !== null && proposedGfaM2 <= builtGfaM2) return;

        const gain = builtGfaM2 === null ? null : computeGain({
            builtFloorArea: builtGfaM2,
            proposedFloorArea: proposedGfaM2,
            pricePerM2: money.salePricePerM2,
            currency: money.currency,
            parcelCount: 1
        }).gain;

        const density = builtGfaM2 === null ? null : (proposedGfaM2 - builtGfaM2) / Math.max(proposedGfaM2, 1);
        const openSpace = (builtFootprintM2 !== null && areaM2 !== null && areaM2 > 0)
            ? Math.max(0, 1 - (builtFootprintM2 / areaM2))
            : null;

        candidates.push({
            candidateId: `${personaName}:${parcel.parcelId}`,
            parcelId: parcel.parcelId,
            parcelSourceId: parcel.parcelSourceId || null,
            parcelIdentityKind: parcel.parcelIdentityKind ?? null,
            geometryDisplayId: parcel.geometryDisplayId ?? null,
            koName: parcel.koName ?? null,
            areaM2,
            centroid: parcel.centroid ?? null,
            geometry: parcel.geometry,
            ...baseline,
            ...(parcel.buildingObservations ? { buildingObservations: { ...parcel.buildingObservations } } : {}),
            rule: { maxFloors: allowedFloors, minSetbackM: rule.minDistance, source: ruleSourceOf(sourceRule) },
            allowedFloors,
            plannedFloors: rule.maxFloors,
            parcelNumber: parcel.parcelNumber ?? null,
            ...(parcel.rival ? { rival: parcel.rival } : {}),
            envelope: evaluated.envelope,
            massing,
            proposedGfaM2,
            currency: money.currency,
            gain,
            offer: gain === null ? null : Math.round(gain * offerShareOfGain),
            score: null,
            scoreParts: { density, valueUplift: null, openSpace, heritage: 0 },
            // The exact rule the envelope and the build-out were derived from. record-builder.js
            // stamps this onto buildingProposal.parameters.rule so the stored proposal can be
            // re-derived: the same rule and the same seed reproduce this massing.
            normalizedRule: rule
        });
    });

    // valueUplift is relative to the best gain in THIS set, so it can only be filled once the set
    // is known. With no positive gain anywhere the term contributes nothing rather than dividing.
    const maxGain = candidates.reduce((best, c) => c.gain === null ? best : Math.max(best, c.gain), 0);
    const weights = {
        density: weightOf(persona, 'density'),
        valueUplift: weightOf(persona, 'valueUplift'),
        openSpace: weightOf(persona, 'openSpace'),
        heritage: weightOf(persona, 'heritage')
    };
    for (const candidate of candidates) {
        candidate.scoreParts.valueUplift = candidate.gain === null ? null : maxGain > 0 ? candidate.gain / maxGain : 0;
        const weighted = Object.entries(weights).filter(([, weight]) => weight !== 0);
        candidate.score = weighted.some(([part]) => candidate.scoreParts[part] === null) ? null
            : weighted.reduce((score, [part, weight]) => score + weight * candidate.scoreParts[part], 0);
    }

    // candidateId breaks ties so the order is total, not merely sorted — two parcels with equal
    // scores must not swap places between runs.
    candidates.sort((a, b) => (a.score === null) - (b.score === null)
        || (a.score !== null && b.score !== null ? b.score - a.score : 0)
        || a.candidateId.localeCompare(b.candidateId));
    return candidates.slice(0, Math.max(0, limit));
}
