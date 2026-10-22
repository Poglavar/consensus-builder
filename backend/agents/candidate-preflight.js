// Check the design a pick would publish before it is chosen or published: the server binds a design's
// ground itself (routes/designs.js, POST /designs), and an autonomous agent publishes only a building
// whose footprint binds exactly its candidate parcel with complete cadastral coverage, so the agreement
// it proposes settles that one parcel and its output is that parcel as it stands. The checker is injected
// (production passes proposals/binding.js checkProposalBinding, the function the index runs), so this
// orchestration stays headless and testable.
import { buildDesignRecord } from './record-builder.js';
import { designObject } from './agreement-objects.js';
import { retryParcelRead } from './parcel-read-retry.js';

// Content that does not reach the binding: only the footprint does.
const PREFLIGHT_PICK = Object.freeze({ name: 'Binding preflight', rationale: null });
const PREFLIGHT_TIME = '2000-01-01T00:00:00.000Z';

export function bindingRejection(candidate, result) {
    const reason = String(result?.error ?? result?.reason ?? 'The design does not bind exactly its candidate parcel.')
        .replace(/\s+/g, ' ').trim().slice(0, 240);
    return {
        candidateId: String(candidate.candidateId),
        code: typeof result?.code === 'string' ? result.code : 'binding-refused',
        reason,
        bound: Array.isArray(result?.parcelIds) ? result.parcelIds.length : 0
    };
}

export function prioritizedPlannedCandidates(planned) {
    if (!Array.isArray(planned)) throw new TypeError('planned must be an array');
    const ruleBacked = planned.filter(candidate => candidate.rule?.source === 'urban-rule');
    return ruleBacked.length ? ruleBacked : planned;
}

/**
 * The binding the index will give the candidate's design: { ok: true, binding, parcelIds } when it binds
 * exactly the candidate parcel with complete coverage, else { ok: false, code, error, parcelIds }.
 */
export async function checkCandidateBinding({
    db, candidate, persona, city, checkBinding, log, retryOptions
}) {
    if (typeof checkBinding !== 'function') throw new TypeError('checkBinding must be injected');
    const { content } = designObject(buildDesignRecord({ candidate, pick: PREFLIGHT_PICK, persona, city, authoredAt: PREFLIGHT_TIME }));
    // The design as the index binds it (routes/designs.js bindingShape): its footprint and nothing else.
    const shape = { geometry: content.geometry, buildingProposal: content.buildingProposal, roadProposal: null, structureProposal: null, parcelLayout: null };
    const result = await retryParcelRead(() => checkBinding(db, shape, [], {
        city, parcelSourceId: candidate.parcelSourceId || null, derive: true
    }), { ...retryOptions, sourceId: candidate.parcelSourceId || city || 'cadastre', log });
    if (!result || typeof result.ok !== 'boolean') throw new Error(`binding checker returned no boolean result for ${candidate.candidateId}`);
    if (!result.ok) return { ...result, parcelIds: [] };
    const parcelIds = (result.binding?.parcels || []).map(hit => String(hit.parcelId)).sort();
    if (result.binding?.coverage !== 'complete') {
        return {
            ok: false, code: 'agent-cadastre-incomplete', parcelIds,
            error: `Autonomous agreements need complete cadastral coverage; the binding is ${result.binding?.coverage ?? 'missing'}.`
        };
    }
    if (parcelIds.length !== 1 || parcelIds[0] !== String(candidate.parcelId)) {
        return {
            ok: false, code: 'agent-binding-not-candidate', parcelIds,
            error: `The building binds ${parcelIds.join(', ') || 'no parcel'}, not exactly ${candidate.parcelId}.`
        };
    }
    return { ok: true, binding: result.binding, parcelIds };
}

export async function preflightCandidates({
    db, rankedCandidates, limit, scanLimit = rankedCandidates?.length,
    persona, city, checkBinding, log, retryOptions
}) {
    if (!Array.isArray(rankedCandidates)) throw new TypeError('rankedCandidates must be an array');
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer');
    if (!Number.isInteger(scanLimit) || scanLimit < 0) throw new RangeError('scanLimit must be a non-negative integer');
    const candidates = [];
    const rejected = [];
    let scanned = 0;
    for (const candidate of rankedCandidates.slice(0, scanLimit)) {
        scanned += 1;
        const result = await checkCandidateBinding({ db, candidate, persona, city, checkBinding, log, retryOptions });
        if (result.ok) candidates.push(candidate);
        else rejected.push(bindingRejection(candidate, result));
        if (candidates.length >= limit) break;
    }
    return { candidates, rejected, scanned };
}
