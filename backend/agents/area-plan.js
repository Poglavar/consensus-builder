// Where a proposer looks on one run: the run key (day, plus an optional slot for several runs a
// day), which of the persona's areas this run visits, the small window inside it, and the parcels it
// may plan on (a live parcel source's features, or the rival's parcels taken from other agents'
// published picks). Pure: no network, no database; run.mjs fetches and passes the results in.
import { hash32 } from './algorithmic-picker.js';

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LNG_EQUATOR = 111_320;

/** `auto` → `h` + the UTC hour ("h08"); any other label must be short and id-safe. */
export function slotLabel(slot, now = new Date()) {
    if (slot === undefined || slot === null || slot === '') return null;
    if (slot === 'auto') return `h${String(now.getUTCHours()).padStart(2, '0')}`;
    if (!/^[a-z0-9]{1,8}$/i.test(String(slot))) throw new Error(`--slot must be "auto" or 1-8 letters/digits, got ${slot}`);
    return String(slot).toLowerCase();
}

/** The id stem of one run: the day alone (one run a day, as before) or `<day>-<slot>`. */
export function runKeyFor(day, slot = null) {
    return slot ? `${day}-${slot}` : day;
}

/** The planner's numeric seed: the day's digits as before, a hash of the key once a slot is in it. */
export function seedFor(runKey) {
    return /^\d{4}-\d{2}-\d{2}$/.test(runKey) ? Number(runKey.replace(/-/g, '')) : hash32(runKey);
}

/** The persona's area this run visits: a stable rotation, so successive runs walk different areas. */
export function chooseArea(areas, runKey, personaName) {
    const list = Array.isArray(areas) ? areas.filter(Boolean) : [];
    if (!list.length) return null;
    return list[hash32(`${runKey}:${personaName}:area`) % list.length];
}

/**
 * A square window of about `sizeM` metres inside `bbox`, placed by the run key. A whole-city bbox
 * read in parcel-id order returned the same corner every day; a moving window does not.
 */
export function windowIn(bbox, runKey, personaName, sizeM = 350) {
    const [minLng, minLat, maxLng, maxLat] = bbox;
    const midLat = (minLat + maxLat) / 2;
    const dLat = Math.min(maxLat - minLat, sizeM / M_PER_DEG_LAT);
    const dLng = Math.min(maxLng - minLng, sizeM / (M_PER_DEG_LNG_EQUATOR * Math.cos((midLat * Math.PI) / 180)));
    const fx = (hash32(`${runKey}:${personaName}:x`) % 10_000) / 10_000;
    const fy = (hash32(`${runKey}:${personaName}:y`) % 10_000) / 10_000;
    const west = minLng + (maxLng - minLng - dLng) * fx;
    const south = minLat + (maxLat - minLat - dLat) * fy;
    const round = value => Math.round(value * 1e6) / 1e6;
    return [round(west), round(south), round(west + dLng), round(south + dLat)];
}

function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Planner parcels from a live parcel source's FeatureCollection (GET /parcel-sources/:id?bbox=).
 * These sources carry no buildings and no zoning, so both are left unknown (`builtKnown: false`,
 * `rule: null`) rather than invented; the candidate says so in its rationale.
 */
export function parcelsFromSource(featureCollection, { turf, place, minAreaM2 = 250, maxAreaM2 = 3000 } = {}) {
    if (!turf) throw new Error('parcelsFromSource: turf must be injected.');
    const features = Array.isArray(featureCollection?.features) ? featureCollection.features : [];
    const parcels = [];
    for (const feature of features) {
        const parcelId = String(feature?.properties?.parcelId || feature?.id || '').trim();
        const type = feature?.geometry?.type;
        if (!parcelId || (type !== 'Polygon' && type !== 'MultiPolygon')) continue;
        const areaM2 = turf.area(feature);
        if (!(areaM2 >= minAreaM2 && areaM2 <= maxAreaM2)) continue;
        const [lng, lat] = turf.pointOnFeature(feature).geometry.coordinates;
        parcels.push({
            parcelId,
            parcelNumber: String(feature.properties?.parcelNumber || feature.properties?.sourceParcelId || '').trim() || null,
            koName: place || null,
            areaM2,
            centroid: { lng, lat },
            geometry: feature.geometry,
            buildingCount: 0,
            builtFootprintM2: 0,
            builtGfaM2: 0,
            builtKnown: false,
            rule: null
        });
    }
    return parcels;
}

/** Every parcel id a set of runs picked and minted (optionally only one persona's). */
export function pickedParcelIds(runs, { persona = null } = {}) {
    const ids = new Set();
    for (const run of runs || []) {
        if (persona && run?.persona !== persona) continue;
        const summary = run?.summary || {};
        for (const pick of summary.picks || []) {
            if (!summary.mints?.[pick.candidateId]) continue;
            const candidate = (summary.candidates || []).find(item => item.candidateId === pick.candidateId);
            if (candidate?.parcelId) ids.add(candidate.parcelId);
        }
    }
    return ids;
}

/**
 * The rival's parcels: land other proposers published on in the last `withinDays` days, as planner
 * parcels carrying the stored geometry and what was measured there. A rival proposal on the same
 * parcels puts both into one contest, which is how the Bets list groups competing proposals.
 * `floorCap` builds lower than the ceiling (planner.js keeps the ceiling as `allowedFloors`), so the
 * rival offers a different build-out, never a copy.
 */
export function contestParcels(runs, { persona, runDay, withinDays = 3, floorCap = null } = {}) {
    const byParcel = new Map();
    const oldest = Date.parse(`${runDay}T00:00:00Z`) - withinDays * 86_400_000;
    // A proposal its author already retired (cancelled or expired) is no longer worth answering.
    const retired = new Set((runs || []).flatMap(run => Object.keys(run?.summary?.retirements || {})));
    for (const run of runs || []) {
        if (!run || run.persona === persona) continue;
        const day = run.day instanceof Date ? run.day.toISOString().slice(0, 10) : String(run.day || '').slice(0, 10);
        if (!(Date.parse(`${day}T00:00:00Z`) >= oldest)) continue;
        const summary = run.summary || {};
        for (const pick of summary.picks || []) {
            if (!summary.posts?.[pick.candidateId]) continue;
            const candidate = (summary.candidates || []).find(item => item.candidateId === pick.candidateId);
            if (!candidate?.geometry || byParcel.has(candidate.parcelId)) continue;
            if (retired.has(summary.mints?.[pick.candidateId]?.proposalPda)) continue;
            byParcel.set(candidate.parcelId, {
                parcelId: candidate.parcelId,
                parcelNumber: candidate.parcelNumber ?? null,
                koName: candidate.koName ?? null,
                city: summary.city ?? null,
                areaM2: candidate.areaM2,
                centroid: candidate.centroid ?? null,
                geometry: candidate.geometry,
                buildingCount: candidate.buildingCount ?? 0,
                builtFootprintM2: candidate.builtFootprintM2 ?? 0,
                builtGfaM2: candidate.builtGfaM2 ?? 0,
                builtKnown: candidate.builtKnown !== false,
                rival: { proposalId: pick.proposalId, persona: run.persona, name: pick.name },
                // The same rule origin as the proposal it answers: a parcel planned under a mapped
                // urban rule stays rule-backed, a default-envelope one stays default.
                rule: candidate.rule?.source === 'urban-rule'
                    ? { maxFloors: finiteNumber(candidate.rule?.maxFloors), minSetbackM: finiteNumber(candidate.rule?.minSetbackM) }
                    : null,
                floorCap
            });
        }
    }
    return Array.from(byParcel.values());
}
