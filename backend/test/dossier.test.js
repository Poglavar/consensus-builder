// dossier.js — the owner's triaged dossier (rethink-proposals.md §10): acceptance / offer / vote /
// disclosure per (owner's parcel, proposal), the chain-rule deferral to earlier formations, and
// the remainder report (what the owner is left holding).

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let dossier;
let t;

function square(lngWest, latSouth, lngWidth, latHeight) {
    return {
        type: 'Feature',
        properties: {},
        geometry: {
            type: 'Polygon',
            coordinates: [[
                [lngWest, latSouth],
                [lngWest + lngWidth, latSouth],
                [lngWest + lngWidth, latSouth + latHeight],
                [lngWest, latSouth + latHeight],
                [lngWest, latSouth]
            ]]
        }
    };
}

// The parcel, a road strip crossing it, a school wholly on the strip, a house on retained ground.
const PARCEL = square(16.000, 45.800, 0.001, 0.001);
const STRIP = square(15.9995, 45.8004, 0.002, 0.0002);
const SCHOOL = square(16.0002, 45.80045, 0.0002, 0.0001);   // inside STRIP ∩ PARCEL
const HOUSE = square(16.0002, 45.8008, 0.0002, 0.00015);    // inside PARCEL, clear of STRIP

const ROOT = 'HR-1-P';
const BASE_PARCELS = [{ id: ROOT, feature: PARCEL }];

function makePlan() {
    return [
        {
            proposalId: 'road-1', title: 'Road', goal: 'road-track',
            createdAt: '2026-01-01T00:00:00Z',
            geometry: STRIP.geometry, cadastreParcelIds: [ROOT]
        },
        {
            proposalId: 'school-1', title: 'School', goal: 'single',
            createdAt: '2026-01-02T00:00:00Z',
            geometry: SCHOOL.geometry, cadastreParcelIds: [ROOT]
        },
        {
            proposalId: 'house-1', title: 'House', goal: 'single',
            createdAt: '2026-01-03T00:00:00Z',
            geometry: HOUSE.geometry, cadastreParcelIds: [ROOT]
        },
        {
            proposalId: 'rule-1', title: 'Height rule', goal: 'urban-rule',
            createdAt: '2026-01-04T00:00:00Z',
            parentParcelIds: [ROOT]
        },
        {
            proposalId: 'offer-1', title: 'Purchase offer', goal: 'as-is',
            createdAt: '2026-01-05T00:00:00Z',
            parentParcelIds: [ROOT]
        }
    ];
}

beforeAll(() => {
    globalThis.turf = require('@turf/turf');
    t = globalThis.turf;
    dossier = require('../../frontend/js/proposals/dossier.js');
});

describe('channelFor', () => {
    it('rules and votes are political whatever ground they touch', () => {
        expect(dossier.channelFor({ goal: 'urban-rule' }, ROOT, {})).toBe('vote');
        expect(dossier.channelFor({ goal: 'as-is', isVote: true }, ROOT, {})).toBe('vote');
    });

    it('a formation taking this ground with no geometry to check ASKS the owner', () => {
        const ctx = { flow: [{ parcelId: ROOT, cededM2: 500, destination: 'public' }] };
        expect(dossier.channelFor({ goal: 'road-track' }, ROOT, ctx)).toBe('acceptance');
    });

    it('a formation reaching the ancestry but taking nothing measurable is a disclosure', () => {
        expect(dossier.channelFor({ goal: 'park', geometry: STRIP.geometry }, ROOT, { flow: [] })).toBe('disclosure');
    });

    it('non-forming content with no footprint is an offer', () => {
        expect(dossier.channelFor({ goal: 'as-is' }, ROOT, {})).toBe('offer');
    });
});

describe('buildDossier — the worked §10 example', () => {
    it('triages road=acceptance, house=acceptance, school-on-the-strip=disclosure, rule=vote, offer=offer', () => {
        const result = dossier.buildDossier(ROOT, makePlan(), {
            baseParcels: BASE_PARCELS,
            parcelFeature: PARCEL
        });
        const byId = Object.fromEntries(result.entries.map(e => [e.proposalId, e]));
        expect(byId['road-1'].channel).toBe('acceptance');
        expect(byId['house-1'].channel).toBe('acceptance');
        expect(byId['school-1'].channel).toBe('disclosure'); // its ground is already ceded to the road
        expect(byId['rule-1'].channel).toBe('vote');
        expect(byId['offer-1'].channel).toBe('offer');

        // The road's take is measured, public-bound, and the largest acceptance.
        expect(byId['road-1'].destination).toBe('public');
        const expectedTake = Math.round(t.area(t.intersect(STRIP, PARCEL)));
        expect(Math.abs(byId['road-1'].cededM2 - expectedTake)).toBeLessThanOrEqual(2);

        // Acceptances sort first, biggest take first.
        expect(result.entries[0].proposalId).toBe('road-1');
        expect(result.entries.map(e => e.channel)).toEqual(
            ['acceptance', 'acceptance', 'offer', 'vote', 'disclosure']);
    });

    it('membership follows base ancestry even for derived declared parents', () => {
        const plan = makePlan();
        plan.push({
            proposalId: 'derived-1', title: 'On a slice', goal: 'as-is',
            parentParcelIds: [`${ROOT}#p-road-2`]
        });
        const result = dossier.buildDossier(ROOT, plan, { baseParcels: BASE_PARCELS, parcelFeature: PARCEL });
        expect(result.entries.some(e => e.proposalId === 'derived-1')).toBe(true);
    });

    it('reports the remainder: the strip and the house leave the owner two pieces', () => {
        const result = dossier.buildDossier(ROOT, makePlan(), {
            baseParcels: BASE_PARCELS,
            parcelFeature: PARCEL
        });
        expect(result.remainder).not.toBeNull();
        // The strip splits the parcel in two; the house punches into one piece but splits nothing.
        expect(result.remainder.pieces.length).toBe(2);

        const parcelM2 = Math.round(t.area(PARCEL));
        const stripM2 = Math.round(t.area(t.intersect(STRIP, PARCEL)));
        const houseM2 = Math.round(t.area(HOUSE));
        // Taken = road + house (the school's ground is the road's, not subtracted twice).
        expect(Math.abs(result.remainder.takenM2 - (stripM2 + houseM2))).toBeLessThanOrEqual(3);
        expect(Math.abs(result.remainder.remainderM2 - (parcelM2 - stripM2 - houseM2))).toBeLessThanOrEqual(4);
    });

    it('an unrelated parcel gets an empty dossier', () => {
        const result = dossier.buildDossier('HR-9-NOPE', makePlan(), {
            baseParcels: BASE_PARCELS,
            parcelFeature: PARCEL
        });
        expect(result.entries).toEqual([]);
        expect(result.remainder).toBeNull();
    });
});
