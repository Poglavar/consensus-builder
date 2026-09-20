// Deterministic, zero-model-cost proposal selection for the scheduled demo persona. The planner
// has already rejected infeasible parcels and sorted candidates by the persona's weighted score;
// this step applies a few explicit guardrails, then uses a day/persona hash to vary among only the
// near-best candidates. A rerun for the same day always makes the same choice.

const COMPETITIVE_RATIO = 0.9;
const MAX_COMPETITIVE_CANDIDATES = 3;
const MAX_NAME_CHARS = 60;

function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function maxPicksOf(persona) {
    const declared = finite(persona?.dailyProposals);
    return declared !== null && declared > 0 ? Math.floor(declared) : 1;
}

function hash32(value) {
    let hash = 2166136261;
    for (const character of String(value)) {
        hash ^= character.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function round(value) {
    return Math.round(Number(value));
}

function formatInteger(value) {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(round(value));
}

function titleFor(candidate) {
    const place = String(candidate.koName || candidate.parcelId || 'selected parcel').trim();
    return `Plan-led infill in ${place}`.slice(0, MAX_NAME_CHARS);
}

function rationaleFor(candidate) {
    return [
        `The mapped urban rule allows ${round(candidate.allowedFloors)} floors on parcel ${candidate.parcelId}.`,
        `The measured build-out increases floor area from ${formatInteger(candidate.builtGfaM2)} m² to ${formatInteger(candidate.proposedGfaM2)} m², with a calculated owner offer of €${formatInteger(candidate.offerEur)}.`
    ].join(' ');
}

function isEligible(candidate) {
    const score = finite(candidate?.score);
    const gain = finite(candidate?.gainEur);
    const built = finite(candidate?.builtGfaM2);
    const proposed = finite(candidate?.proposedGfaM2);
    const floors = finite(candidate?.allowedFloors);
    return Boolean(candidate?.candidateId)
        && candidate?.rule?.source === 'urban-rule'
        && score !== null && score > 0
        && gain !== null && gain > 0
        && built !== null && proposed !== null && proposed > built
        && floors !== null && floors > 0;
}

/**
 * Select at most persona.dailyProposals candidates without a model or network call.
 *
 * Candidates must be backed by an explicit urban rule and add positive measured floor area/value.
 * Variation is restricted to the top three candidates scoring at least 90% of the best candidate.
 */
export function selectAlgorithmicPicks({ day, persona, candidates } = {}) {
    const personaName = String(persona?.name || 'agent');
    const eligible = (Array.isArray(candidates) ? candidates : []).filter(isEligible);
    const topScore = eligible.length ? Number(eligible[0].score) : 0;
    const competitive = eligible
        .filter(candidate => Number(candidate.score) >= topScore * COMPETITIVE_RATIO)
        .slice(0, MAX_COMPETITIVE_CANDIDATES)
        .map(candidate => ({
            candidate,
            rank: hash32(`${day || ''}:${personaName}:${candidate.candidateId}`)
        }))
        .sort((left, right) => left.rank - right.rank || left.candidate.candidateId.localeCompare(right.candidate.candidateId));
    const selected = competitive.slice(0, maxPicksOf(persona)).map(({ candidate }) => ({
        candidateId: candidate.candidateId,
        name: titleFor(candidate),
        rationale: rationaleFor(candidate)
    }));

    return {
        picks: selected,
        rejected: [],
        policy: {
            controller: 'algorithm',
            eligibility: 'urban-rule + positive score + positive measured floor-area/value uplift',
            competitiveRatio: COMPETITIVE_RATIO,
            competitiveLimit: MAX_COMPETITIVE_CANDIDATES,
            seed: `${day || ''}:${personaName}`,
            eligibleCandidateIds: eligible.map(candidate => candidate.candidateId),
            competitiveCandidateIds: competitive.map(({ candidate }) => candidate.candidateId)
        }
    };
}

export { hash32, isEligible };
