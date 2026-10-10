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

// "Rudeš" from the cadastre's "RUDEŠ"; a city label from the persona's area is already cased.
function placeName(value) {
    const text = String(value || '').trim();
    if (!text || text !== text.toUpperCase()) return text;
    return text.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, gap, letter) => gap + letter.toUpperCase());
}

// The parcel number people know: "1754/1" from HR-335614-1754/1, "3513080" from US-CA-SF-3513080.
function parcelNumberOf(candidate) {
    if (candidate.parcelNumber) return String(candidate.parcelNumber);
    const segments = String(candidate.parcelId || '').split('-');
    const last = segments[segments.length - 1];
    return segments.length >= 2 && /^\d/.test(last) ? last : String(candidate.parcelId || '');
}

// Distinct per parcel and per build-out, so a list of agent proposals never reads as one title
// repeated: "4-storey infill on parcel 1754/1, Rudeš".
function titleFor(candidate) {
    const floors = round(candidate.plannedFloors ?? candidate.allowedFloors);
    const kind = candidate.rival ? 'alternative' : 'infill';
    const place = placeName(candidate.koName);
    return `${floors}-storey ${kind} on parcel ${parcelNumberOf(candidate)}${place ? `, ${place}` : ''}`.slice(0, MAX_NAME_CHARS);
}

function rationaleFor(candidate) {
    const planned = round(candidate.plannedFloors ?? candidate.allowedFloors);
    const allowed = round(candidate.allowedFloors);
    const ceiling = candidate.rule?.source === 'urban-rule'
        ? `The mapped urban rule allows ${allowed} floors on parcel ${candidate.parcelId}`
        : `No zoning rule is mapped for parcel ${candidate.parcelId}, so the platform's default envelope applies (${allowed} floors, setbacks from every boundary)`;
    const builds = planned < allowed ? `; this proposal builds ${planned}.` : '.';
    const existing = candidate.builtKnown === false
        ? `Existing buildings are not measured in this city's data, so the build-out of ${formatInteger(candidate.proposedGfaM2)} m² is counted against an empty plot, with a calculated owner offer of €${formatInteger(candidate.offerEur)}.`
        : `The measured build-out increases floor area from ${formatInteger(candidate.builtGfaM2)} m² to ${formatInteger(candidate.proposedGfaM2)} m², with a calculated owner offer of €${formatInteger(candidate.offerEur)}.`;
    const rival = candidate.rival ? ` It answers "${candidate.rival.name}" by ${candidate.rival.persona} on the same land, so the two compete in one contest.` : '';
    return `${ceiling}${builds} ${existing}${rival}`;
}

function isEligible(candidate) {
    const score = finite(candidate?.score);
    const gain = finite(candidate?.gainEur);
    const built = finite(candidate?.builtGfaM2);
    const proposed = finite(candidate?.proposedGfaM2);
    const floors = finite(candidate?.allowedFloors);
    // The default envelope is eligible only where no rule CAN be mapped (a live parcel source
    // carries no zoning); where a rule layer exists, a parcel it misses is not a candidate.
    const ruleOk = candidate?.rule?.source === 'urban-rule'
        || (candidate?.rule?.source === 'default' && candidate?.builtKnown === false);
    return Boolean(candidate?.candidateId)
        && ruleOk
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
            eligibility: 'urban-rule (or the default envelope where the parcel source carries no zoning) + positive score + positive floor-area/value uplift',
            competitiveRatio: COMPETITIVE_RATIO,
            competitiveLimit: MAX_COMPETITIVE_CANDIDATES,
            seed: `${day || ''}:${personaName}`,
            eligibleCandidateIds: eligible.map(candidate => candidate.candidateId),
            competitiveCandidateIds: competitive.map(({ candidate }) => candidate.candidateId)
        }
    };
}

export { hash32, isEligible };
