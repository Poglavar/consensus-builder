// Check the exact proposal body the runner intends to publish before choosing or minting it.
// The checker is injected so this orchestration stays headless and testable; production passes the
// the server's checkProposalBinding (proposals/binding.js).
import { buildProposalRecord } from './record-builder.js';
import { retryParcelRead } from './parcel-read-retry.js';

function neutralPick(candidate) {
    return {
        proposalId: `preflight-${candidate.candidateId}`,
        name: `Preflight ${candidate.parcelId}`,
        rationale: 'Candidate parcel binding preflight.'
    };
}

export function bindingRejection(candidate, result) {
    const missing = Array.isArray(result?.missing) ? result.missing.length : 0;
    const extra = Array.isArray(result?.extra) ? result.extra.length : 0;
    const reason = String(result?.error ?? result?.reason ?? 'Canonical parcel binding refused.')
        .replace(/\s+/g, ' ').trim().slice(0, 240);
    return {
        candidateId: String(candidate.candidateId),
        code: typeof result?.code === 'string' ? result.code : 'binding-refused',
        reason,
        missing,
        extra
    };
}

export function prioritizedPlannedCandidates(planned) {
    if (!Array.isArray(planned)) throw new TypeError('planned must be an array');
    const ruleBacked = planned.filter(candidate => candidate.rule?.source === 'urban-rule');
    return ruleBacked.length ? ruleBacked : planned;
}

export async function checkCandidateBinding({
    db, candidate, pick, persona, runId, city, turf, checkBinding, log, retryOptions
}) {
    if (typeof checkBinding !== 'function') throw new TypeError('checkBinding must be injected');
    const record = buildProposalRecord({
        candidate, pick: pick ?? neutralPick(candidate), persona, runId, city, turf
    });
    // Keep the declaration exactly as the record builder authored it. Never infer or widen it from
    // missing binding hits; the canonical checker must refuse a mismatching site as published.
    // The posted agent record has no authored `site`; match the route's create precheck exactly and
    // let checkProposalBinding derive its footprint from geometry.buildings.
    const result = await retryParcelRead(() => checkBinding(db, record, record.cadastreParcelIds, {
        city, parcelSourceId: candidate.parcelSourceId || null
    }), { ...retryOptions, sourceId: candidate.parcelSourceId || city || 'cadastre', log });
    if (!result || typeof result.ok !== 'boolean') {
        throw new Error(`binding checker returned no boolean result for ${candidate.candidateId}`);
    }
    if (result.ok && result.binding?.coverage !== 'complete') {
        const coverage = typeof result.binding?.coverage === 'string' ? result.binding.coverage : 'missing';
        return {
            ...result,
            ok: false,
            status: 409,
            code: 'agent-cadastre-incomplete',
            error: `Autonomous proposals require complete cadastre binding; checker reported ${coverage} coverage.`
        };
    }
    return result;
}

export async function preflightCandidates({
    db, rankedCandidates, limit, scanLimit = rankedCandidates?.length,
    persona, runId, city, turf, checkBinding, log, retryOptions
}) {
    if (!Array.isArray(rankedCandidates)) throw new TypeError('rankedCandidates must be an array');
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer');
    if (!Number.isInteger(scanLimit) || scanLimit < 0) throw new RangeError('scanLimit must be a non-negative integer');
    const candidates = [];
    const rejected = [];
    let scanned = 0;
    for (const candidate of rankedCandidates.slice(0, scanLimit)) {
        scanned += 1;
        const result = await checkCandidateBinding({
            db, candidate, persona, runId, city, turf, checkBinding, log, retryOptions
        });
        if (result.ok) candidates.push(candidate);
        else rejected.push(bindingRejection(candidate, result));
        if (candidates.length >= limit) break;
    }
    return { candidates, rejected, scanned };
}
