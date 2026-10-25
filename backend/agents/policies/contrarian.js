// Contrarian policy (preservationist-01): bet NO on the densest open agreement by another actor that
// this persona has not already bet against. Pure: input = agreements (optionally enriched with their
// designs' content, `designContents`), markets keyed by agreement account, own history and the
// invocation budget; output = one action or none.
//
// Density evidence, strongest first:
//   1. designs: proposed gross floor area = Σ building footprint (m², from each design's
//      geometry.buildings) × floors (feature floors, else buildingProposal.parameters.floors, else
//      round(height / 3)). Existing floor area is not in a design, so this is proposed GFA, not gain.
//   2. heuristic: floors / density words in the agreement's name and its designs' titles, descriptions
//      and goals. Ranked after every design-measured agreement, because a word count is weaker evidence
//      than a measured massing.
// An agreement with no density signal (score 0, e.g. a park) is never a target.
import { agreementName, firstFitting, isOthersOpen, positiveDecimal, stableNumber } from './common.js';

export const ROLE = 'contrarian';
// What society-run.mjs must gather: the designs' content for density, and the persona's own NO positions.
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

/** { source: 'designs'|'heuristic'|'none', score, floorAreaM2?, detail } for one agreement. */
export function densityEvidence(agreement = {}) {
    const designs = Array.isArray(agreement.designContents) ? agreement.designContents.filter(Boolean) : [];
    let floorArea = 0;
    let measured = 0;
    for (const design of designs) {
        const parameters = design.buildingProposal?.parameters || {};
        const buildings = Array.isArray(design.geometry?.buildings) ? design.geometry.buildings : [];
        for (const building of buildings) {
            const area = footprintAreaM2(building?.geometry);
            const floors = floorsOf(building?.properties || {}, parameters);
            if (area > 0 && floors) { floorArea += area * floors; measured += 1; }
        }
    }
    if (floorArea > 0) {
        const floorAreaM2 = Math.round(floorArea);
        return { source: 'designs', score: floorAreaM2, floorAreaM2, detail: `proposed gross floor area ≈ ${floorAreaM2} m² (${measured} building footprint${measured === 1 ? '' : 's'} × floors in its designs)` };
    }
    const text = [agreement.name, ...designs.flatMap(design => [design.title, design.description, design.goal]),
        ...(agreement.designs || []).flatMap(design => [design.title, design.goal])].filter(Boolean).join(' ').toLowerCase();
    const floorsMatch = text.match(FLOORS_RE);
    const floorsMentioned = floorsMatch ? Number(floorsMatch[1]) : 0;
    const dense = DENSE_WORDS.filter(word => text.includes(word));
    const open = OPEN_WORDS.filter(word => text.includes(word));
    const score = open.length && !dense.length && !floorsMentioned ? 0 : floorsMentioned * 100 + dense.length * 50;
    if (score <= 0) return { source: 'none', score: 0, detail: 'no density signal in its designs or their text' };
    const parts = [floorsMentioned ? `${floorsMentioned} floors mentioned` : null, dense.length ? `density words: ${dense.join(', ')}` : null].filter(Boolean);
    return { source: 'heuristic', score, detail: `text heuristic (${parts.join('; ')})` };
}

/**
 * @param {{ persona, seed, now?, wallet?, agreements, markets?, history?: { againstCids?: string[] },
 *           budget?: { actionsLeft, usdcLeft } }} input
 */
export function decide({ persona, seed, now = Date.now(), wallet = null, agreements = [], markets = {}, history = {}, budget = null } = {}) {
    if (!persona?.name) throw new Error('persona.name is required');
    if (!seed) throw new Error('seed is required');
    const config = policyConfig(persona);
    const against = new Set((history.againstCids || []).map(String));
    const others = (agreements || []).filter(agreement => isOthersOpen(agreement, { wallet, personaName: persona.name, now }));
    const alreadyAgainst = others.filter(agreement => against.has(agreement.cid)).map(agreement => agreement.cid);
    const open = others.filter(agreement => !against.has(agreement.cid)
        && markets?.[agreement.account] && !markets[agreement.account].resolved);
    const scored = open.map(agreement => ({ agreement, evidence: densityEvidence(agreement) }))
        .filter(item => item.evidence.score > 0)
        .map(item => ({ ...item, tier: item.evidence.source === 'designs' ? 0 : 1, rank: stableNumber(`${seed}:${persona.name}:${item.agreement.cid}`) }))
        .sort((a, b) => a.tier - b.tier || b.evidence.score - a.evidence.score || a.rank - b.rank);
    const options = scored.map(({ agreement, evidence }, index) => {
        return {
            agreementCid: agreement.cid,
            evidence,
            action: {
                type: 'stake', side: 'no', amount: config.amountUsdc, usdc: Number(config.amountUsdc),
                signedActions: 1,
                agreementCid: agreement.cid, account: agreement.account, agreementName: agreementName(agreement),
                rationale: `Bet NO on ${agreementName(agreement)}: ${evidence.detail}; ${index === 0 ? 'the densest' : `density rank ${index + 1}`} of ${scored.length} open agreement${scored.length === 1 ? '' : 's'} by other actors this persona has not yet opposed${alreadyAgainst.length ? ` (${alreadyAgainst.length} already bet against)` : ''}.`
            }
        };
    });
    const eligibleCids = options.map(option => option.agreementCid);
    if (!options.length) {
        return {
            action: null, options, eligibleCids, capped: false, alreadyAgainst,
            reason: alreadyAgainst.length && !open.length
                ? `Every open agreement by another actor is already bet against (${alreadyAgainst.length}).`
                : others.length ? 'No open agreement by another actor shows a density signal.' : 'No open minted agreement by another actor was available.'
        };
    }
    const { chosen, capped } = firstFitting(options, budget);
    return {
        action: chosen?.action || null, options, eligibleCids, capped, alreadyAgainst,
        reason: chosen ? chosen.action.rationale : `Cap reached: ${options.length} agreement(s) to oppose but the invocation budget (${budget.actionsLeft} action(s), ${budget.usdcLeft.toFixed(2)} USDC left) covers none.`
    };
}
