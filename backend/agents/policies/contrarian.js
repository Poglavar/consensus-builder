// Contrarian policy (preservationist-01): bet NO on the densest active proposal by another actor
// that this persona has not already bet against. Pure: input = proposals (optionally enriched with
// the full `record`), markets, own history and the invocation budget; output = one action or none.
//
// Density evidence, strongest first:
//   1. record: proposed gross floor area = Σ building footprint (m², from the record's
//      geometry.buildings) × floors (feature floors, else buildingProposal.parameters.floors, else
//      round(height / 3)). Existing floor area is not in the record, so this is proposed GFA, not gain.
//   2. heuristic: floors / density words in name, title and description. Ranked after every
//      record-scored proposal, because a word count is weaker evidence than a measured massing.
// A proposal with no density signal (score 0, e.g. a park) is never a target.
import {
    firstFitting, isOthersActiveMinted, positiveDecimal, proposalAccount, proposalKey, proposalName, stableNumber
} from './common.js';

export const ROLE = 'contrarian';
// What society-run.mjs must gather: full records for density, and the persona's own NO positions.
export const NEEDS = { records: true, noPositions: true, pledges: false };

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LNG_EQUATOR = 111_320;
const DENSE_WORDS = ['tower', 'high-rise', 'highrise', 'skyscraper', 'neboder', 'densif', 'apartment', 'stamben',
    'mixed-use', 'infill', 'nadogradnj', 'extension', 'storey'];
const OPEN_WORDS = ['park', 'garden', 'green', 'square', 'trg', 'lake', 'playground', 'preserv', 'heritage', 'tree'];
const FLOORS_RE = /(\d{1,3})\s*-?\s*(?:floors?|storeys?|stories|story|katova|kata|kat|etaž\w*)/i;

export function policyConfig(persona = {}) {
    const policy = persona.policy || {};
    return { amountUsdc: positiveDecimal(policy.amountUsdc, '0.01', `${persona.name || 'contrarian'} policy.amountUsdc`) };
}

function ringAreaM2(ring, cosLat) {
    if (!Array.isArray(ring) || ring.length < 3) return 0;
    let sum = 0;
    for (let i = 0; i < ring.length; i += 1) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % ring.length];
        sum += (x1 * cosLat * M_PER_DEG_LNG_EQUATOR) * (y2 * M_PER_DEG_LAT) - (x2 * cosLat * M_PER_DEG_LNG_EQUATOR) * (y1 * M_PER_DEG_LAT);
    }
    return Math.abs(sum) / 2;
}

function polygonAreaM2(rings) {
    const first = rings?.[0]?.[0];
    if (!Array.isArray(first) || typeof first[1] !== 'number') return 0;
    const cosLat = Math.cos((first[1] * Math.PI) / 180);
    const [outer, ...holes] = rings;
    return Math.max(0, ringAreaM2(outer, cosLat) - holes.reduce((sum, hole) => sum + ringAreaM2(hole, cosLat), 0));
}

/** Footprint area in m² of a GeoJSON Polygon/MultiPolygon in lng/lat (equirectangular; fine at parcel scale). */
export function footprintAreaM2(geometry) {
    if (geometry?.type === 'Polygon') return polygonAreaM2(geometry.coordinates);
    if (geometry?.type === 'MultiPolygon') return (geometry.coordinates || []).reduce((sum, rings) => sum + polygonAreaM2(rings), 0);
    return 0;
}

function positiveNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function floorsOf(properties = {}, parameters = {}) {
    const floors = positiveNumber(properties.floors) ?? positiveNumber(parameters.floors);
    if (floors) return floors;
    const height = positiveNumber(properties.height) ?? positiveNumber(parameters.height);
    return height ? Math.max(1, Math.round(height / 3)) : null;
}

/** { source: 'record'|'heuristic'|'none', score, floorAreaM2?, detail } for one proposal. */
export function densityEvidence(proposal = {}) {
    const record = proposal.record || proposal;
    const parameters = record.buildingProposal?.parameters || {};
    const buildings = Array.isArray(record.geometry?.buildings) ? record.geometry.buildings : [];
    let floorArea = 0;
    let measured = 0;
    for (const building of buildings) {
        const area = footprintAreaM2(building?.geometry);
        const floors = floorsOf(building?.properties || {}, parameters);
        if (area > 0 && floors) { floorArea += area * floors; measured += 1; }
    }
    if (floorArea > 0) {
        const floorAreaM2 = Math.round(floorArea);
        return { source: 'record', score: floorAreaM2, floorAreaM2, detail: `proposed gross floor area ≈ ${floorAreaM2} m² (${measured} building footprint${measured === 1 ? '' : 's'} × floors in the record)` };
    }
    const text = [record.name, record.title, record.description, record.goal].filter(Boolean).join(' ').toLowerCase();
    const floorsMatch = text.match(FLOORS_RE);
    const floorsMentioned = floorsMatch ? Number(floorsMatch[1]) : 0;
    const dense = DENSE_WORDS.filter(word => text.includes(word));
    const open = OPEN_WORDS.filter(word => text.includes(word));
    const score = open.length && !dense.length && !floorsMentioned ? 0 : floorsMentioned * 100 + dense.length * 50;
    if (score <= 0) return { source: 'none', score: 0, detail: 'no density signal in the record or its text' };
    const parts = [floorsMentioned ? `${floorsMentioned} floors mentioned` : null, dense.length ? `density words: ${dense.join(', ')}` : null].filter(Boolean);
    return { source: 'heuristic', score, detail: `text heuristic (${parts.join('; ')})` };
}

/**
 * @param {{ persona, seed, wallet?, proposals, markets?, history?: { againstProposalIds?: string[] },
 *           budget?: { actionsLeft, usdcLeft } }} input
 */
export function decide({ persona, seed, wallet = null, proposals = [], markets = {}, history = {}, budget = null } = {}) {
    if (!persona?.name) throw new Error('persona.name is required');
    if (!seed) throw new Error('seed is required');
    const config = policyConfig(persona);
    const against = new Set((history.againstProposalIds || []).map(String));
    const others = (proposals || []).filter(proposal => isOthersActiveMinted(proposal, { wallet, personaName: persona.name }));
    const alreadyAgainst = others.filter(proposal => against.has(proposalKey(proposal))).map(proposalKey);
    const open = others.filter(proposal => !against.has(proposalKey(proposal)) && !markets?.[proposalAccount(proposal)]?.resolved);
    const scored = open.map(proposal => ({ proposal, evidence: densityEvidence(proposal) }))
        .filter(item => item.evidence.score > 0)
        .map(item => ({ ...item, tier: item.evidence.source === 'record' ? 0 : 1, rank: stableNumber(`${seed}:${persona.name}:${proposalKey(item.proposal)}`) }))
        .sort((a, b) => a.tier - b.tier || b.evidence.score - a.evidence.score || a.rank - b.rank);
    const options = scored.map(({ proposal, evidence }, index) => {
        const account = proposalAccount(proposal);
        const hasMarket = Boolean(markets?.[account]);
        return {
            proposalId: proposalKey(proposal),
            evidence,
            action: {
                type: 'stake', side: 'no', amount: config.amountUsdc, usdc: Number(config.amountUsdc),
                // Creating a missing market is a second signature.
                signedActions: hasMarket ? 1 : 2,
                proposalId: proposalKey(proposal), proposalAccount: account, proposalName: proposalName(proposal),
                rationale: `Bet NO on ${proposalName(proposal)}: ${evidence.detail}; ${index === 0 ? 'the densest' : `density rank ${index + 1}`} of ${scored.length} active proposal${scored.length === 1 ? '' : 's'} by other actors this persona has not yet opposed${alreadyAgainst.length ? ` (${alreadyAgainst.length} already bet against)` : ''}.`
            }
        };
    });
    const eligibleProposalIds = options.map(option => option.proposalId);
    if (!options.length) {
        return {
            action: null, options, eligibleProposalIds, capped: false, alreadyAgainst,
            reason: alreadyAgainst.length && !open.length
                ? `Every active proposal by another actor is already bet against (${alreadyAgainst.length}).`
                : others.length ? 'No active proposal by another actor shows a density signal.' : 'No active minted proposal by another actor was available.'
        };
    }
    const { chosen, capped } = firstFitting(options, budget);
    return {
        action: chosen?.action || null, options, eligibleProposalIds, capped, alreadyAgainst,
        reason: chosen ? chosen.action.rationale : `Cap reached: ${options.length} proposal(s) to oppose but the invocation budget (${budget.actionsLeft} action(s), ${budget.usdcLeft.toFixed(2)} USDC left) covers none.`
    };
}
