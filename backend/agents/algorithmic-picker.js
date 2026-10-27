// Deterministic, zero-model-cost proposal selection for the scheduled demo persona. The planner
// has already rejected infeasible parcels and sorted candidates by the persona's weighted score;
// this step applies a few explicit guardrails, then uses a day/persona hash to vary among only the
// near-best candidates. A rerun for the same day always makes the same choice.

import { housingPick } from './housing-policy.js';
import { buildingBaseline } from './building-baseline.js';

const COMPETITIVE_RATIO = 0.9;
const MAX_COMPETITIVE_CANDIDATES = 3;
const MAX_NAME_CHARS = 60;
const GEOMETRY_IDENTITY_KIND = 'geometry-sha256-v1';

function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
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

function geometryDisplayLabel(candidate) {
    const parcelId = String(candidate?.parcelId || '');
    // A canonical ID is sufficient to identify persisted geometry-derived candidates even when
    // their optional presentation metadata predates this field. The full ID remains authoritative.
    const parcelIdHash = parcelId.match(/^[a-z0-9]+(?:-[a-z0-9]+)*-g1~-?(?:0|[1-9]\d*)~-?(?:0|[1-9]\d*)~([0-9a-f]{64})$/i)?.[1];
    if (parcelIdHash) return `G1-${parcelIdHash.slice(0, 8).toLowerCase()}`;
    if (candidate?.parcelIdentityKind === GEOMETRY_IDENTITY_KIND) {
        return parcelId || 'Geometry-derived parcel unavailable';
    }
    return null;
}

// Prefer a native parcel number; geometry-derived identities have no registry number, so use
// their source-provided display label instead of leaking encoded coordinates and a content hash.
function parcelLabelOf(candidate) {
    const geometryLabel = geometryDisplayLabel(candidate);
    if (geometryLabel) return geometryLabel;
    if (candidate.parcelNumber) return String(candidate.parcelNumber);
    const segments = String(candidate.parcelId || '').split('-');
    const last = segments[segments.length - 1];
    return segments.length >= 2 && /^\d/.test(last) ? last : String(candidate.parcelId || '');
}

// Distinct per parcel and per build-out, so a list of agent proposals never reads as one title
// repeated: "4-storey infill on parcel 1754/1, Rudeš".
function titleFor(candidate) {
    const floors = round(candidate.plannedFloors ?? candidate.allowedFloors);
    const kind = candidate.rival ? 'alternative' : candidate.designPolicy ? 'design' : 'infill';
    const place = placeName(candidate.koName);
    return `${floors}-storey ${kind} on parcel ${parcelLabelOf(candidate)}${place ? `, ${place}` : ''}`.slice(0, MAX_NAME_CHARS);
}

function rationaleFor(candidate) {
    const planned = round(candidate.plannedFloors ?? candidate.allowedFloors);
    const allowed = round(candidate.allowedFloors);
    const parcelLabel = geometryDisplayLabel(candidate) || String(candidate.parcelId || '');
    if (candidate.designPolicy?.kind === 'proposed-design') {
        const controls = candidate.designPolicy.controls;
        const floors = controls?.floors?.basis === 'mapped' ? `The mapped rule allows ${allowed} floors` : `The design assumes a ${allowed}-floor ceiling`;
        const setback = controls?.setback?.basis === 'mapped' ? `mapped setbacks of ${controls.setback.value} m` : `assumed setbacks of ${controls?.setback?.value ?? candidate.rule.minSetbackM} m`;
        const basis = `${floors}, with ${setback}`;
        const stock = buildingBaseline(candidate).builtGfaM2;
        const existing = stock === null ? 'Existing floor area and net uplift are unknown.' : `The supported existing floor area is ${formatInteger(stock)} m².`;
        const rival = candidate.rival ? ` It answers “${candidate.rival.name}” by ${candidate.rival.persona} on the same land.` : '';
        return `${basis}; this building has ${planned} floors and ${formatInteger(candidate.proposedGfaM2)} m² gross floor area, leaving ${round(candidate.designPolicy.openSpaceRatio * 100)}% of the parcel outside its footprint. ${existing}${rival}`;
    }
    const ceiling = `The mapped urban rule allows ${allowed} floors on parcel ${parcelLabel}`;
    const builds = planned < allowed ? `; this design builds ${planned}.` : '.';
    const existing = `The measured build-out increases floor area from ${formatInteger(candidate.builtGfaM2)} m² to ${formatInteger(candidate.proposedGfaM2)} m².`;
    const rival = candidate.rival ? ` It answers "${candidate.rival.name}" by ${candidate.rival.persona} on the same land, so the two compete in one contest.` : '';
    return `${ceiling}${builds} ${existing}${rival}`;
}

export function selectionScore(candidate) {
    return candidate?.designPolicy?.kind === 'proposed-design' ? candidate.designPolicy.score : candidate?.score;
}

function isEligible(candidate) {
    if (candidate?.designPolicy?.kind === 'proposed-design') {
        const policy = candidate.designPolicy;
        const built = buildingBaseline(candidate).builtGfaM2;
        return Boolean(candidate.candidateId && candidate.massing?.geometry)
            && ['mapped', 'assumed'].includes(policy.ruleBasis)
            && finite(policy.score) !== null && policy.score > 0
            && finite(policy.footprintM2) !== null && policy.footprintM2 > 0
            && finite(policy.openSpaceRatio) !== null && policy.openSpaceRatio >= 0 && policy.openSpaceRatio <= 1
            && finite(candidate.proposedGfaM2) !== null && candidate.proposedGfaM2 > 0
            && finite(candidate.plannedFloors) !== null && candidate.plannedFloors > 0
            && (built === null || candidate.proposedGfaM2 > built);
    }
    if (candidate?.housing) return candidate.rule?.source === 'housing-research' && candidate.housing.screening?.complete === true && candidate.housing.screening?.excluded === false && candidate.housing.homes >= 10 && candidate.score > 0;
    const score = finite(candidate?.score);
    const gain = finite(candidate?.gain);
    const built = buildingBaseline(candidate).builtGfaM2;
    const proposed = finite(candidate?.proposedGfaM2);
    const floors = finite(candidate?.allowedFloors);
    // The generic autonomous path needs supported stock and a mapped rule. Unknown stock is
    // never an empty-plot assumption; explicitly scoped housing research has its own gate above.
    const ruleOk = candidate?.rule?.source === 'urban-rule';
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
 * Candidates use their explicitly recorded design/housing policy, or the strict measured uplift policy.
 * Variation is restricted to the top three candidates scoring at least 90% of the best candidate.
 */
export function selectAlgorithmicPicks({ day, persona, candidates } = {}) {
    const personaName = String(persona?.name || 'agent');
    const eligible = (Array.isArray(candidates) ? candidates : []).filter(isEligible);
    const topScore = eligible.length ? Number(selectionScore(eligible[0])) : 0;
    const competitive = eligible
        .filter(candidate => Number(selectionScore(candidate)) >= topScore * COMPETITIVE_RATIO)
        .slice(0, MAX_COMPETITIVE_CANDIDATES)
        .map(candidate => ({
            candidate,
            rank: hash32(`${day || ''}:${personaName}:${candidate.candidateId}`)
        }))
        .sort((left, right) => left.rank - right.rank || left.candidate.candidateId.localeCompare(right.candidate.candidateId));
    const selected = competitive.slice(0, maxPicksOf(persona)).map(({ candidate }) => ({
        candidateId: candidate.candidateId,
        ...(candidate.housing ? housingPick(candidate) : { name: titleFor(candidate), rationale: rationaleFor(candidate) })
    }));

    return {
        picks: selected,
        rejected: [],
        policy: {
            controller: 'algorithm',
            eligibility: 'explicit proposed-design geometry policy; uplift policy requires complete named building inventory + urban-rule + positive score + positive floor-area/value uplift; screened housing research uses its own policy',
            competitiveRatio: COMPETITIVE_RATIO,
            competitiveLimit: MAX_COMPETITIVE_CANDIDATES,
            seed: `${day || ''}:${personaName}`,
            eligibleCandidateIds: eligible.map(candidate => candidate.candidateId),
            competitiveCandidateIds: competitive.map(({ candidate }) => candidate.candidateId)
        }
    };
}

export { hash32, isEligible };
