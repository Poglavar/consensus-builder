// Weighs candidate sites against a posting's location signals the way a person would: each
// agreeing clue adds weight, contradictions subtract, and nothing is a hard gate. Pure; the
// weights are heuristics to be tuned against reviewed outcomes, not rules.
import { fold } from './site-signals.js';

export const WEIGHTS = Object.freeze({
    klasa: 0.9,             // the posting cites this permit's KLASA
    parcel: 0.5,            // the posting cites a parcel number of this site
    addressExact: 0.55,     // street + number name an official address point on this site
    addressVariant: 0.35,   // base number of a slash/letter/range variant
    addressField: 0.1,      // the address comes from the page's own address/location field, not prose
    permitStreetNumber: 0.4,// a permit on this site is filed under the posting's street and number
    permitStreet: 0.2,      // ...under a street the posting mentions in passing
    permitStreetStated: 0.3,// ...under the street in the posting's address field or title
    district: 0.1,          // the title names the permit's cadastral municipality ("Trnje")
    sameSettlement: 0.05,   // the address point lies in the settlement the posting names
    otherSettlement: -0.15, // ...or in another one (Sesvete for an ad that says Zagreb)
    pinInside: 0.25, pinNear: 0.18, pinClose: 0.1, pinArea: 0.04,
    newBuildPermit: 0.15,   // a new-build ad and a recent building permit
    residential: 0.08,
    unitsClose: 0.2, unitsRough: 0.1,
    nonBuildingWorks: -0.4, // roads, utilities, landscaping: not where an apartment is sold
    staleExistingOnly: -0.05,
});

const RESIDENTIAL = /stamben|mješovit|mjesovit|višestamben|visestamben/i;
// Building works: a stated new build, or a building permit whose works field is left blank.
const NEW_WORKS = /građenje|gradenje|nova|novog|izgradnj|građevinska dozvola|gradevinska dozvola/i;
const NON_BUILDING = /prometnic|cest[ae]\b|ulic[ae]\b|javna rasvjeta|dtk|kanal|vodovod|plinovod|kanalizac|vrelovod|trafostanic|krajobraz|parkiralište|infrastruktur/i;

const streetKey = value => fold(value).split(' ').filter(word => word.length > 2 && !streetType(word) && !/^(?:bb|zagreb)$/.test(word) && !/^\d/.test(word))
    .map(word => word.slice(0, Math.max(4, word.length - 2)));

// Street-type words. Two names that both state a type must state the same one: Obala and Ulica
// kneza Branimira, or Odranska ulica and Odranska zavrtnica, are different streets.
const TYPES = [['ulic', 'ulica'], ['cest', 'cesta'], ['trg', 'trg'], ['obal', 'obala'], ['aveni', 'avenija'], ['odvoj', 'odvojak'],
    ['prilaz', 'prilaz'], ['zavrtnic', 'zavrtnica'], ['setalist', 'setaliste'], ['stub', 'stube'], ['vijen', 'vijenac'], ['put', 'put']];
function streetType(value) {
    for (const word of fold(value).split(' ')) {
        const hit = TYPES.find(([stem]) => stem === 'put' ? word === 'put' || word === 'putu' : word.startsWith(stem));
        if (hit) return hit[1];
    }
    return null;
}

// "Strojarska cesta 19" and "Strojarska" share a street when every key stem of the shorter name
// opens a word of the longer one and neither states a different street type.
export function sameStreet(a, b) {
    const ta = streetType(a), tb = streetType(b);
    if (ta && tb && ta !== tb) return false;
    const x = streetKey(a), y = streetKey(b);
    if (!x.length || !y.length) return false;
    const [short, long] = x.length <= y.length ? [x, y] : [y, x];
    return short.every(stem => long.some(word => word.startsWith(stem) || stem.startsWith(word)));
}

export function houseNumberOf(value) {
    return fold(value).match(/(?:^|\s)(\d{1,4}[a-z]?(?:\/\d{1,4})?)(?:\s|$)/)?.[1] || null;
}

const baseNumber = value => String(value || '').toLowerCase().match(/^\d+/)?.[0] || null;

function yearsBetween(isoDate, at) {
    const time = Date.parse(isoDate);
    return Number.isFinite(time) ? (at - time) / (365.25 * 86400000) : null;
}

// candidate: { id, parcels:[{kc}], addressPoints:[{matchKind}], permits:[...], pinDistanceM, pinInside }
export function scoreCandidate(candidate, signals, { observedAt = Date.now() } = {}) {
    const reasons = [];
    const add = (weight, code, detail) => reasons.push({ weight, code, ...(detail ? { detail } : {}) });
    const permits = candidate.permits || [];
    if (signals.klasa?.length && permits.some(p => p.klasa && signals.klasa.includes(p.klasa.replace(/\s+/g, '').toUpperCase())))
        add(WEIGHTS.klasa, 'klasa');
    const citedParcels = new Set((signals.parcels || []).map(value => value.replace(/\s+/g, '')));
    const parcelHit = (candidate.parcels || []).find(parcel => citedParcels.has(String(parcel.kc).replace(/\s+/g, '')));
    if (parcelHit) add(WEIGHTS.parcel, 'parcel', parcelHit.kc);
    const exact = (candidate.addressPoints || []).find(point => point.matchKind === 'exact');
    const variant = (candidate.addressPoints || []).find(point => point.matchKind !== 'exact');
    if (exact) {
        add(WEIGHTS.addressExact, 'address-point', `${exact.street} ${exact.number}`);
        if (exact.basis === 'explicit-location') add(WEIGHTS.addressField, 'address-field');
    } else if (variant) add(WEIGHTS.addressVariant, 'address-point-variant', `${variant.street} ${variant.number}`);
    const point = exact || variant;
    if (point?.settlement && signals.locality) {
        if (fold(point.settlement) === fold(signals.locality)) add(WEIGHTS.sameSettlement, 'same-settlement', point.settlement);
        else add(WEIGHTS.otherSettlement, 'other-settlement', point.settlement);
    }
    if (!exact) {
        const wanted = [...(signals.addresses || []), ...(signals.streets || []).map(s => ({ ...s, number: null }))];
        const stated = basis => ['explicit-location', 'address-label', 'title-mention'].includes(basis);
        let best = null;
        for (const permit of permits) for (const street of permit.streets || []) for (const claim of wanted) {
            if (!sameStreet(street, claim.street)) continue;
            const numbered = Boolean(claim.number) && baseNumber(houseNumberOf(street)) === baseNumber(claim.number);
            const weight = numbered ? WEIGHTS.permitStreetNumber : stated(claim.basis) ? WEIGHTS.permitStreetStated : WEIGHTS.permitStreet;
            if (!best || weight > best.weight) best = { numbered, street, weight };
        }
        if (best) add(best.weight, best.numbered ? 'permit-street-number' : best.weight === WEIGHTS.permitStreetStated ? 'permit-street-stated' : 'permit-street', best.street);
    }
    if (typeof candidate.pinDistanceM === 'number' && Number.isFinite(candidate.pinDistanceM)) {
        const d = candidate.pinDistanceM;
        if (candidate.pinInside || d <= 5) add(WEIGHTS.pinInside, 'pin-inside');
        else if (d <= 50) add(WEIGHTS.pinNear, 'pin-near', Math.round(d));
        else if (d <= 150) add(WEIGHTS.pinClose, 'pin-close', Math.round(d));
        else if (d <= 300) add(WEIGHTS.pinArea, 'pin-area', Math.round(d));
    }
    const buildPermits = permits.filter(p => !NON_BUILDING.test(`${p.works || ''} ${p.worksDetail || ''} ${p.use || ''}`));
    if (permits.length && !buildPermits.length) add(WEIGHTS.nonBuildingWorks, 'non-building-works');
    const recentNew = buildPermits.find(p => NEW_WORKS.test(`${p.works || ''} ${p.kind || ''}`)
        && (yearsBetween(p.finalOn || p.decidedOn || p.receivedOn, observedAt) ?? 99) <= 7);
    if (signals.newBuild && recentNew) add(WEIGHTS.newBuildPermit, 'recent-building-permit', recentNew.caseId);
    if (buildPermits.some(p => RESIDENTIAL.test(p.use || ''))) add(WEIGHTS.residential, 'residential-use');
    const title = ` ${fold(signals.titleText || '')} `;
    const district = (candidate.parcels || []).map(p => fold(p.koName || '')).find(name => name.length > 3 && title.includes(` ${name} `));
    if (district) add(WEIGHTS.district, 'district', district);
    const units = buildPermits.map(p => p.units).find(value => typeof value === 'number' && value > 0);
    if (signals.units && units) {
        const ratio = Math.abs(units - signals.units) / Math.max(units, signals.units);
        if (ratio <= 0.15) add(WEIGHTS.unitsClose, 'units', `${signals.units}~${units}`);
        else if (ratio <= 0.35) add(WEIGHTS.unitsRough, 'units-rough', `${signals.units}~${units}`);
    }
    const score = Math.max(0, Math.min(1, reasons.reduce((sum, reason) => sum + reason.weight, 0)));
    return { id: candidate.id, score: Math.round(score * 1000) / 1000, reasons };
}

export const THRESHOLDS = Object.freeze({ located: 0.6, probable: 0.35, margin: 0.15, closeCall: 0.1 });

// Rank candidates and say how sure we are. A close second is a question for the adjudicator,
// not a rejection.
export function rankSites(candidates, signals, options = {}) {
    const ranked = candidates.map(candidate => ({ candidate, ...scoreCandidate(candidate, signals, options) }))
        .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
    const [top, second] = ranked;
    const margin = top ? top.score - (second?.score || 0) : 0;
    let status = 'unresolved';
    if (top && top.score >= THRESHOLDS.located && margin >= THRESHOLDS.margin) status = 'located';
    else if (top && top.score >= THRESHOLDS.probable && margin >= THRESHOLDS.closeCall) status = 'probable';
    else if (top && top.score >= THRESHOLDS.probable) status = 'ambiguous';
    return { status, margin: Math.round(margin * 1000) / 1000, ranked };
}
