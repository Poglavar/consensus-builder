// Where a proposer looks on one run: run keys and slots, area rotation, the moving window, live
// parcel-source features as planner parcels, the parcels the persona already published a design on and
// the rival's parcels (other proposers' open agreements, answered with a lower build-out).
import { describe, expect, it } from 'vitest';
import * as turf from '@turf/turf';
import { chooseArea, contestParcels, parcelsFromSource, pickedParcelIds, rivalAgreementCids, runKeyFor, seedFor, slotLabel, windowIn } from '../agents/area-plan.js';
import { planCandidates } from '../agents/planner.js';
import { selectAlgorithmicPicks } from '../agents/algorithmic-picker.js';

const square = (west, south, size = 0.0003) => ({ type: 'Polygon', coordinates: [[[west, south], [west + size, south], [west + size, south + size], [west, south + size], [west, south]]] });
const cidOf = seed => `bafkrei${seed.toLowerCase().replace(/[^a-z2-7]/g, 'a').padEnd(52, 'q').slice(0, 52)}`;

// One proposer run as its checkpoint stores it: the candidate, the pick, and as far as the pick got
// (designed: a design CID; proposed: the agreement's CID and deadline; minted: its account), plus the
// settlement records the persona's later runs wrote for that account.
function run({
    persona, day, slot = null, city = 'san_francisco', parcelId = 'US-CA-SF-1', parcelSourceId = undefined,
    reached = 'minted', deadline = '2026-10-18T00:00:00.000Z', settlements = null,
    rule = { source: 'default', maxFloors: 5, minSetbackM: 3 }
}) {
    const candidateId = `${persona}:${parcelId}`;
    const account = `account-${parcelId}`;
    const order = ['chosen', 'designed', 'proposed', 'minted'];
    const at = stage => order.indexOf(reached) >= order.indexOf(stage);
    return {
        persona, day, run_id: `${runKeyFor(day, slot)}-${persona}`,
        summary: {
            city,
            candidates: [{
                candidateId, parcelId, koName: 'San Francisco', areaM2: 900, geometry: square(-122.42, 37.77), builtGfaM2: 0, builtKnown: false, rule,
                ...(parcelSourceId !== undefined ? { parcelSourceId } : {})
            }],
            picks: [{ candidateId, pickId: `agent-${persona}-${day}-1`, name: `5-storey infill on parcel ${parcelId}` }],
            ...(at('designed') ? { designs: { [candidateId]: { cid: cidOf(`design${parcelId}`) } } } : {}),
            ...(at('proposed') ? { agreements: { [candidateId]: { cid: cidOf(`agreement${parcelId}`), deadline } } } : {}),
            ...(at('minted') ? { mints: { [candidateId]: { account } } } : {}),
            ...(settlements ? { settlements: { [account]: settlements } } : {})
        }
    };
}

describe('agent run keys and slots', () => {
    it('keeps one run a day keyed by the day alone, and slots several into ids and seeds', () => {
        expect(slotLabel(undefined)).toBeNull();
        expect(slotLabel('auto', new Date('2026-10-11T08:59:00Z'))).toBe('h08');
        expect(slotLabel('B2')).toBe('b2');
        expect(() => slotLabel('../x')).toThrow('--slot');
        expect(runKeyFor('2026-10-11')).toBe('2026-10-11');
        expect(runKeyFor('2026-10-11', 'h08')).toBe('2026-10-11-h08');
        expect(seedFor('2026-10-11')).toBe(20261011);
        expect(seedFor('2026-10-11-h08')).not.toBe(seedFor('2026-10-11-h10'));
    });

    it('rotates the area and moves the window between runs, inside the bbox', () => {
        const areas = ['zagreb', 'paris', 'new_york', 'lima'].map(city => ({ city }));
        const visited = new Set(['h00', 'h02', 'h04', 'h06', 'h08', 'h10', 'h12', 'h14'].map(slot => chooseArea(areas, `2026-10-11-${slot}`, 'densifier-01').city));
        expect(visited.size).toBeGreaterThan(2);
        expect(chooseArea(areas, '2026-10-11-h02', 'densifier-01')).toBe(chooseArea(areas, '2026-10-11-h02', 'densifier-01'));
        expect(chooseArea([], 'k', 'p')).toBeNull();
        const bbox = [15.93, 45.78, 16.02, 45.83];
        const a = windowIn(bbox, '2026-10-11-h02', 'densifier-01');
        const b = windowIn(bbox, '2026-10-11-h04', 'densifier-01');
        expect(a).not.toEqual(b);
        for (const w of [a, b]) {
            expect(w[0]).toBeGreaterThanOrEqual(bbox[0]); expect(w[2]).toBeLessThanOrEqual(bbox[2] + 1e-9);
            expect(w[1]).toBeGreaterThanOrEqual(bbox[1]); expect(w[3]).toBeLessThanOrEqual(bbox[3] + 1e-9);
            expect((w[3] - w[1]) * 110540).toBeCloseTo(350, 0);
        }
    });
});

describe('live parcel-source parcels', () => {
    it('keeps sized polygons with their id and number, and leaves buildings and zoning unknown', () => {
        const fc = { type: 'FeatureCollection', features: [
            { type: 'Feature', id: 'US-CA-SF-3513080', properties: { parcelId: 'US-CA-SF-3513080', parcelNumber: '3513080' }, geometry: square(-122.42, 37.77) },
            { type: 'Feature', id: 'tiny', properties: { parcelId: 'tiny' }, geometry: square(-122.42, 37.77, 0.00005) },
            { type: 'Feature', id: 'line', properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } }
        ] };
        const parcels = parcelsFromSource(fc, { turf, place: 'San Francisco' });
        expect(parcels.map(parcel => parcel.parcelId)).toEqual(['US-CA-SF-3513080']);
        expect(parcels[0]).toMatchObject({ parcelNumber: '3513080', koName: 'San Francisco', builtKnown: false, builtGfaM2: 0, rule: null });
        expect(parcels[0].areaM2).toBeGreaterThan(250);
        const [candidate] = planCandidates(parcels, { name: 'p', weights: { density: 1 } }, { turf, money: { currency: 'EUR', salePricePerM2: 4000 }, limit: 1 });
        expect(candidate).toMatchObject({ rule: { source: 'default' }, builtKnown: false, parcelNumber: '3513080' });
    });

    it('carries geometry identity through planning and names it without exposing its coordinates or hash', () => {
        const parcelId = `KE-NAIROBI-NM-g1~368402797~-12643572~${'a'.repeat(64)}`;
        const fc = { type: 'FeatureCollection', features: [{
            type: 'Feature', id: parcelId,
            properties: {
                parcelId, sourceId: 'ke-nairobi-maps-outlines', parcelNumber: null,
                parcelIdentityKind: 'geometry-sha256-v1', geometryDisplayId: `G1-${'a'.repeat(12)}`
            },
            geometry: square(36.8452, -1.2662)
        }] };
        const [sourceParcel] = parcelsFromSource(fc, { turf, place: 'Nairobi' });
        const [candidate] = planCandidates([sourceParcel], { name: 'densifier-01', weights: { density: 1 } }, { turf, money: { currency: 'EUR', salePricePerM2: 4000 }, limit: 1 });
        const [pick] = selectAlgorithmicPicks({
            day: '2026-10-11', persona: { name: 'densifier-01' }, candidates: [candidate]
        }).picks;

        expect(candidate.candidateId).toBe(`densifier-01:${parcelId}`);
        expect(candidate).toMatchObject({
            parcelId, parcelIdentityKind: 'geometry-sha256-v1', geometryDisplayId: `G1-${'a'.repeat(12)}`
        });
        expect(pick.name).toBe(`5-storey infill on parcel G1-${'a'.repeat(8)}, Nairobi`);
        expect(pick.rationale).toContain(`parcel G1-${'a'.repeat(8)}`);
        expect(pick.name).not.toContain('12643572');
        expect(pick.name).not.toContain('a'.repeat(20));
    });
});

describe('parcels a persona has used and rival parcels', () => {
    const runs = [
        run({ persona: 'densifier-01', day: '2026-10-11', slot: 'h02', parcelId: 'US-CA-SF-1' }),
        run({ persona: 'densifier-01', day: '2026-10-10', parcelId: 'US-CA-SF-2', reached: 'designed' }),
        run({ persona: 'densifier-01', day: '2026-10-01', parcelId: 'US-CA-SF-old' }),
        run({ persona: 'densifier-01', day: '2026-10-11', parcelId: 'US-CA-SF-chosen', reached: 'chosen' }),
        run({ persona: 'densifier-01', day: '2026-10-10', parcelId: 'US-CA-SF-lapsed', deadline: '2026-10-11T00:00:00.000Z' }),
        run({ persona: 'densifier-01', day: '2026-10-11', parcelId: 'US-CA-SF-expired',
            settlements: { cid: cidOf('agreementUS-CA-SF-expired'), account: 'account-US-CA-SF-expired', state: 'due', expiry: { signature: 'sig-expire' }, settled: true } }),
        run({ persona: 'densifier-01', day: '2026-10-11', parcelId: 'US-CA-SF-executed',
            settlements: { cid: cidOf('agreementUS-CA-SF-executed'), account: 'account-US-CA-SF-executed', state: 'decidable', execution: { signature: 'sig-execute', status: 'Executed' }, settled: true } }),
        run({ persona: 'gentle-01', day: '2026-10-11', parcelId: 'US-CA-SF-own' })
    ];

    it('lists every parcel a persona published a design on, so it never proposes the same land twice', () => {
        expect([...pickedParcelIds(runs, { persona: 'densifier-01' })].sort())
            .toEqual(['US-CA-SF-1', 'US-CA-SF-2', 'US-CA-SF-executed', 'US-CA-SF-expired', 'US-CA-SF-lapsed', 'US-CA-SF-old']);
        expect([...pickedParcelIds(runs, { persona: 'gentle-01' })]).toEqual(['US-CA-SF-own']);
        expect([...pickedParcelIds(runs)].sort()).toContain('US-CA-SF-own');
    });

    it("answers other agents' recent agreements that are still open, building lower", () => {
        const parcels = contestParcels(runs, { persona: 'gentle-01', runDay: '2026-10-11', withinDays: 3, floorCap: 3 });
        // Not the design without an agreement, the 10-day-old one, the one whose deadline is the run
        // day's start, the one its author expired, or the one its author executed (its land is settled).
        expect(parcels.map(parcel => parcel.parcelId)).toEqual(['US-CA-SF-1']);
        expect(parcels[0]).toMatchObject({ city: 'san_francisco', floorCap: 3, rule: null, builtKnown: false, parcelSourceId: null,
            rival: { agreementCid: cidOf('agreementUS-CA-SF-1'), persona: 'densifier-01', name: '5-storey infill on parcel US-CA-SF-1' } });
        const [candidate] = planCandidates(parcels, { name: 'gentle-01', weights: { density: 1 } }, { turf, money: { currency: 'EUR', salePricePerM2: 4000 }, limit: 1 });
        expect(candidate).toMatchObject({ allowedFloors: 5, plannedFloors: 3, rival: { persona: 'densifier-01' } });
        // The persona never answers its own agreements.
        expect(contestParcels(runs, { persona: 'densifier-01', runDay: '2026-10-11' }).map(parcel => parcel.parcelId)).toEqual(['US-CA-SF-own']);
    });

    it('answers an agreement until its author executes or expires it', () => {
        const open = run({ persona: 'densifier-01', day: '2026-10-11', parcelId: 'US-CA-SF-9' });
        expect(contestParcels([open], { persona: 'gentle-01', runDay: '2026-10-11' })).toHaveLength(1);
        // A later run of its author checkpoints the expiry under the account it settled.
        const later = { persona: 'densifier-01', day: '2026-10-12', run_id: '2026-10-12-densifier-01',
            summary: { settlements: { 'account-US-CA-SF-9': { state: 'due', expiry: { replayed: true, signature: null, status: 'Expired' } } } } };
        expect(contestParcels([open, later], { persona: 'gentle-01', runDay: '2026-10-11' })).toEqual([]);
        // Or its execution: an executed agreement settled its land, there is nothing left to contest.
        const executed = { ...later, summary: { settlements: { 'account-US-CA-SF-9': { execution: { replayed: false, signature: 'sig-execute', status: 'Executed' } } } } };
        expect(contestParcels([open, executed], { persona: 'gentle-01', runDay: '2026-10-11' })).toEqual([]);
        // A settlement that only resolved a market (no execution or expiry) leaves it open.
        const resolvedOnly = { ...later, summary: { settlements: { 'account-US-CA-SF-9': { state: 'decided', resolution: { outcome: 'YES' } } } } };
        expect(contestParcels([open, resolvedOnly], { persona: 'gentle-01', runDay: '2026-10-11' })).toHaveLength(1);
    });

    it('takes a rival the index records as executed, cancelled or expired for closed, whoever ended it', () => {
        const open = run({ persona: 'densifier-01', day: '2026-10-11', parcelId: 'US-CA-SF-9' });
        const cid = open.summary.agreements[open.summary.picks[0].candidateId].cid;
        // The CIDs to look up first: other proposers' recent agreements with a deadline ahead.
        expect(rivalAgreementCids([open], { persona: 'gentle-01', runDay: '2026-10-11' })).toEqual([cid]);
        expect(rivalAgreementCids([open], { persona: 'densifier-01', runDay: '2026-10-11' })).toEqual([]);
        expect(rivalAgreementCids([open], { persona: 'gentle-01', runDay: '2026-10-20' })).toEqual([]);
        // Its author's runs record no settlement: the index row's onchain.status (the lifecycle oracle's)
        // is what knows someone else executed or expired it.
        for (const status of ['executed', 'cancelled', 'expired']) {
            expect(contestParcels([open], { persona: 'gentle-01', runDay: '2026-10-11', indexStatuses: { [cid]: status } }), status).toEqual([]);
        }
        for (const status of ['active', null, undefined]) {
            expect(contestParcels([open], { persona: 'gentle-01', runDay: '2026-10-11', indexStatuses: { [cid]: status } }), String(status)).toHaveLength(1);
        }
    });

    it('carries the rival candidate\'s own parcel source into contest planning', () => {
        const rival = run({ persona: 'densifier-01', day: '2026-10-11', city: 'new_york', parcelId: 'US-NYC-BBL-1001440001', parcelSourceId: 'us-nyc-dof-digital-tax-map' });
        const [parcel] = contestParcels([rival], { persona: 'gentle-01', runDay: '2026-10-11' });
        expect(parcel.parcelSourceId).toBe('us-nyc-dof-digital-tax-map');
        const [planned] = planCandidates([parcel], { name: 'gentle-01', weights: { density: 1 } }, { turf, money: { currency: 'EUR', salePricePerM2: 4000 }, limit: 1 });
        expect(planned).toMatchObject({
            parcelSourceId: 'us-nyc-dof-digital-tax-map',
            rival: { persona: 'densifier-01', agreementCid: rival.summary.agreements[rival.summary.picks[0].candidateId].cid }
        });
    });

    it('keeps native HR cadastre candidates on the database path (no parcel source)', () => {
        const rival = run({ persona: 'densifier-01', day: '2026-10-11', city: 'zagreb', parcelId: 'HR-335614-1754/1' });
        const [parcel] = contestParcels([rival], { persona: 'gentle-01', runDay: '2026-10-11' });
        expect(parcel.parcelSourceId).toBeNull();
    });

    it('keeps a rule-backed parcel rule-backed with its stated ceiling', () => {
        const zagreb = [run({ persona: 'densifier-01', day: '2026-10-11', city: 'zagreb', parcelId: 'HR-335614-1754/1', rule: { source: 'urban-rule', maxFloors: 4, minSetbackM: 3 } })];
        const [parcel] = contestParcels(zagreb, { persona: 'gentle-01', runDay: '2026-10-11', floorCap: 2 });
        expect(parcel.rule).toEqual({ maxFloors: 4, minSetbackM: 3 });
        expect(parcel.floorCap).toBe(2);
    });
});
