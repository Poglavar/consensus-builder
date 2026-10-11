// Where a proposer looks on one run: run keys and slots, area rotation, the moving window, live
// parcel-source features as planner parcels, the persona's already-picked parcels and rival parcels.
import { describe, expect, it } from 'vitest';
import * as turf from '@turf/turf';
import { chooseArea, contestParcels, parcelsFromSource, pickedParcelIds, runKeyFor, seedFor, slotLabel, windowIn, withPublishedParcelSources } from '../agents/area-plan.js';
import { planCandidates } from '../agents/planner.js';

const square = (west, south, size = 0.0003) => ({ type: 'Polygon', coordinates: [[[west, south], [west + size, south], [west + size, south + size], [west, south + size], [west, south]]] });

function run({ persona, day, slot = null, city = 'san_francisco', parcelId = 'US-CA-SF-1', posted = true, retiredPda = null, rule = { source: 'default', maxFloors: 5, minSetbackM: 3 } }) {
    const candidateId = `${persona}:${parcelId}`;
    return {
        persona, day, run_id: `${runKeyFor(day, slot)}-${persona}`,
        summary: {
            city,
            candidates: [{ candidateId, parcelId, koName: 'San Francisco', areaM2: 900, geometry: square(-122.42, 37.77), builtGfaM2: 0, builtKnown: false, rule }],
            picks: [{ candidateId, proposalId: `agent-${persona}-${day}-1`, name: `5-storey infill on parcel ${parcelId}` }],
            mints: { [candidateId]: { proposalPda: `pda-${parcelId}` } },
            ...(posted ? { posts: { [candidateId]: { id: 1 } } } : {}),
            ...(retiredPda ? { retirements: { [retiredPda]: { cancel: { signature: 'x' } } } } : {})
        }
    };
}

function withPublishedSnapshot(value, { parcelId, sourceId, source, protocol = 'cadastre-snapshot/1', recordProposalId } = {}) {
    const pick = value.summary.picks[0];
    value.summary.publications = {
        [pick.candidateId]: {
            record: {
                proposalId: recordProposalId ?? pick.proposalId,
                cadastreSnapshot: {
                    protocol,
                    ...(source ? { source } : {}),
                    parcels: [{ id: parcelId ?? value.summary.candidates[0].parcelId, ...(sourceId ? { sourceId } : {}) }]
                }
            }
        }
    };
    return value;
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
        const [candidate] = planCandidates(parcels, { name: 'p', weights: { density: 1 } }, { turf, limit: 1 });
        expect(candidate).toMatchObject({ rule: { source: 'default' }, builtKnown: false, parcelNumber: '3513080' });
    });
});

describe('parcels a persona has used and rival parcels', () => {
    const runs = [
        run({ persona: 'densifier-01', day: '2026-10-11', slot: 'h02', parcelId: 'US-CA-SF-1' }),
        run({ persona: 'densifier-01', day: '2026-10-10', parcelId: 'US-CA-SF-2', posted: false }),
        run({ persona: 'densifier-01', day: '2026-10-01', parcelId: 'US-CA-SF-old' }),
        run({ persona: 'densifier-01', day: '2026-10-11', parcelId: 'US-CA-SF-retired', retiredPda: 'pda-US-CA-SF-retired' }),
        run({ persona: 'gentle-01', day: '2026-10-11', parcelId: 'US-CA-SF-own' })
    ];

    it('lists every parcel a persona minted on, so it never proposes the same land twice', () => {
        expect([...pickedParcelIds(runs, { persona: 'densifier-01' })].sort()).toEqual(['US-CA-SF-1', 'US-CA-SF-2', 'US-CA-SF-old', 'US-CA-SF-retired']);
        expect([...pickedParcelIds(runs, { persona: 'gentle-01' })]).toEqual(['US-CA-SF-own']);
    });

    it("answers other agents' recent published proposals that are still standing, building lower", () => {
        const parcels = contestParcels(runs, { persona: 'gentle-01', runDay: '2026-10-11', withinDays: 3, floorCap: 3 });
        expect(parcels.map(parcel => parcel.parcelId)).toEqual(['US-CA-SF-1']);
        expect(parcels[0]).toMatchObject({ city: 'san_francisco', floorCap: 3, rule: null, builtKnown: false,
            rival: { proposalId: 'agent-densifier-01-2026-10-11-1', persona: 'densifier-01' } });
        const [candidate] = planCandidates(parcels, { name: 'gentle-01', weights: { density: 1 } }, { turf, limit: 1 });
        expect(candidate).toMatchObject({ allowedFloors: 5, plannedFloors: 3, rival: { persona: 'densifier-01' } });
    });

    it('propagates verified source identity from a published rival into contest planning', () => {
        const rival = withPublishedSnapshot(run({
            persona: 'densifier-01', day: '2026-10-11', city: 'new_york', parcelId: 'US-NYC-BBL-1001440001'
        }), { sourceId: 'us-nyc-dof-digital-tax-map' });

        const [parcel] = contestParcels([rival], { persona: 'gentle-01', runDay: '2026-10-11' });
        expect(parcel.parcelSourceId).toBe('us-nyc-dof-digital-tax-map');

        const [planned] = planCandidates([parcel], { name: 'gentle-01', weights: { density: 1 } }, { turf, limit: 1 });
        expect(planned).toMatchObject({
            parcelSourceId: 'us-nyc-dof-digital-tax-map',
            rival: { persona: 'densifier-01', proposalId: rival.summary.picks[0].proposalId }
        });
    });

    it('restores a resumed candidate source only from its exact published rival record', () => {
        const rival = withPublishedSnapshot(run({ persona: 'densifier-01', day: '2026-10-11' }), {
            source: 'us-ca-sf-datasf-active-parcels'
        });
        const resumed = [{
            candidateId: 'gentle-01:US-CA-SF-1', parcelId: 'US-CA-SF-1', parcelSourceId: null,
            rival: { persona: 'densifier-01', proposalId: rival.summary.picks[0].proposalId },
            geometry: square(-122.42, 37.77), pickId: 'unchanged'
        }];

        const restored = withPublishedParcelSources(resumed, [rival]);
        expect(restored).not.toBe(resumed);
        expect(restored[0]).not.toBe(resumed[0]);
        expect(restored[0]).toMatchObject({ parcelSourceId: 'us-ca-sf-datasf-active-parcels', pickId: 'unchanged' });
        expect(restored[0].geometry).toBe(resumed[0].geometry);
        expect(restored[0].rival).toBe(resumed[0].rival);
    });

    it('does not restore a source from an unrelated proposal, wrong snapshot parcel, or mismatched record id', () => {
        const proposalId = 'agent-densifier-01-2026-10-11-1';
        const resumed = [{
            candidateId: 'gentle-01:US-CA-SF-1', parcelId: 'US-CA-SF-1', parcelSourceId: null,
            rival: { persona: 'densifier-01', proposalId }
        }];
        const wrongPick = withPublishedSnapshot(run({ persona: 'densifier-01', day: '2026-10-11' }), {
            parcelId: 'US-CA-SF-1', sourceId: 'us-nyc-dof-digital-tax-map'
        });
        wrongPick.summary.picks[0].proposalId = 'different-proposal';
        const wrongParcel = withPublishedSnapshot(run({ persona: 'densifier-01', day: '2026-10-11' }), {
            parcelId: 'US-CA-SF-other', sourceId: 'us-nyc-dof-digital-tax-map', recordProposalId: proposalId
        });
        wrongParcel.summary.picks[0].proposalId = proposalId;
        const wrongRecord = withPublishedSnapshot(run({ persona: 'densifier-01', day: '2026-10-11' }), {
            parcelId: 'US-CA-SF-1', sourceId: 'us-nyc-dof-digital-tax-map', recordProposalId: 'different-proposal'
        });
        wrongRecord.summary.picks[0].proposalId = proposalId;
        const wrongProtocol = withPublishedSnapshot(run({ persona: 'densifier-01', day: '2026-10-11' }), {
            parcelId: 'US-CA-SF-1', sourceId: 'us-nyc-dof-digital-tax-map', protocol: 'cadastre-snapshot/2'
        });
        const unpublished = withPublishedSnapshot(run({ persona: 'densifier-01', day: '2026-10-11', posted: false }), {
            parcelId: 'US-CA-SF-1', sourceId: 'us-nyc-dof-digital-tax-map'
        });

        for (const runs of [[wrongPick], [wrongParcel], [wrongRecord], [wrongProtocol], [unpublished]]) {
            expect(withPublishedParcelSources(resumed, runs)).toBe(resumed);
        }
    });

    it('keeps native HR cadastre on the database path instead of treating it as a parcel adapter', () => {
        const rival = withPublishedSnapshot(run({
            persona: 'densifier-01', day: '2026-10-11', city: 'zagreb', parcelId: 'HR-335614-1754/1'
        }), { sourceId: 'hr-cadastre' });
        const [parcel] = contestParcels([rival], { persona: 'gentle-01', runDay: '2026-10-11' });
        expect(parcel.parcelSourceId).toBeNull();

        const resumed = [{ parcelId: 'HR-335614-1754/1', parcelSourceId: null,
            rival: { persona: 'densifier-01', proposalId: rival.summary.picks[0].proposalId } }];
        expect(withPublishedParcelSources(resumed, [rival])).toBe(resumed);
        expect(resumed[0].parcelSourceId).toBeNull();
    });

    it('keeps a rule-backed parcel rule-backed with its stated ceiling', () => {
        const zagreb = [run({ persona: 'densifier-01', day: '2026-10-11', city: 'zagreb', parcelId: 'HR-335614-1754/1', rule: { source: 'urban-rule', maxFloors: 4, minSetbackM: 3 } })];
        const [parcel] = contestParcels(zagreb, { persona: 'gentle-01', runDay: '2026-10-11', floorCap: 2 });
        expect(parcel.rule).toEqual({ maxFloors: 4, minSetbackM: 3 });
        expect(parcel.floorCap).toBe(2);
    });
});
