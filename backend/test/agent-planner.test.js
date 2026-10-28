// Unit tests for backend/agents/planner.js — the step that turns candidate parcels into candidate
// proposals. Four properties matter, and each of them is a way the runner could publish a lie:
//   1. a parcel the rule excludes must be skipped, not silently built on;
//   2. a sample over a rule's ceiling must be rejected, never hidden by a smaller statistic;
//   3. a missing rule value must take a documented default, never Number(null) = 0;
//   4. the sampled massing must lie inside the parcel it claims — a building over the neighbour's
//      land is not a proposal, it is a trespass.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { planCandidates, DEFAULT_MAX_FLOORS, DEFAULT_MIN_DISTANCE_M } from '../agents/planner.js';
import { buildDesignRecord } from '../agents/record-builder.js';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const { measureBuilding } = require('../../frontend/js/proposals/plan-yield.js');

const LAT = 45.79;
const LNG = 15.93;

// A square of the given size in metres near the persona's area. Latitude matters: a degree of
// longitude there is ~70% of a degree of latitude, so a naive square in degrees is not a square.
function squareGeometry(sideM, index = 0) {
    const lat = LAT + index * 0.002;
    const dLat = (sideM / 2) / 110540;
    const dLng = (sideM / 2) / (111320 * Math.cos(lat * Math.PI / 180));
    return {
        type: 'Polygon',
        coordinates: [[
            [LNG - dLng, lat - dLat],
            [LNG + dLng, lat - dLat],
            [LNG + dLng, lat + dLat],
            [LNG - dLng, lat + dLat],
            [LNG - dLng, lat - dLat]
        ]]
    };
}

function parcel(overrides = {}) {
    const index = overrides.index ?? 0;
    const sideM = overrides.sideM ?? 40;
    const geometry = squareGeometry(sideM, index);
    const areaM2 = turf.area(turf.polygon(geometry.coordinates));
    const base = {
        parcelId: `HR-335614-${1000 + index}`,
        cesticaId: 1000 + index,
        koCode: 335614,
        koName: 'RUDEŠ',
        areaM2,
        centroid: { lng: LNG, lat: LAT + index * 0.002 },
        geometry,
        buildingCount: 0,
        builtFootprintM2: 0,
        builtGfaM2: 0,
        buildingSourceId: 'survey-fixture',
        buildingCoverage: 'complete',
        rule: { ruleId: 'r', shortName: '1.4', maxFloors: 4, maxCoveragePct: null, maxGfaM2: null, minSetbackM: 3, minPlotM2: null, variables: {} }
    };
    const { index: _i, sideM: _s, ...rest } = overrides;
    return { ...base, ...rest };
}

const PERSONA = {
    name: 'densifier-01',
    weights: { density: 0.6, openSpace: 0.1, valueUplift: 0.3, heritage: 0.0 },
    dailyProposals: 3
};

// A London plan: gains are in the city's money, never assumed to be euros.
const OPTS = { turf, seed: 7, money: { currency: 'GBP', salePricePerM2: 4000 } };

describe('planCandidates basics', () => {
    it('plans an empty lot: a massing, a measured uplift and an offer that is a share of the gain', () => {
        const [candidate] = planCandidates([parcel()], PERSONA, OPTS);
        expect(candidate.candidateId).toBe('densifier-01:HR-335614-1000');
        expect(candidate.parcelId).toBe('HR-335614-1000');
        expect(candidate.koName).toBe('RUDEŠ');
        expect(candidate.allowedFloors).toBe(4);
        expect(candidate.rule).toEqual({ maxFloors: 4, minSetbackM: 3, source: 'urban-rule' });
        expect(candidate.envelope.geometry.type).toBe('Polygon');
        expect(candidate.massing.properties.floors).toBeGreaterThanOrEqual(1);
        expect(candidate.massing.properties.height).toBeCloseTo(candidate.massing.properties.floors * 3, 6);
        expect(candidate.proposedGfaM2).toBeGreaterThan(0);
        expect(candidate.gain).toBeCloseTo(candidate.proposedGfaM2 * 4000, 3);
        expect(candidate.currency).toBe('GBP');
        expect(candidate.offer).toBe(Math.round(candidate.gain * 0.3));
        expect(Number.isInteger(candidate.offer)).toBe(true);
    });

    it('carries the normalized rule the massing was derived from', () => {
        const [candidate] = planCandidates([parcel()], PERSONA, OPTS);
        expect(candidate.normalizedRule.maxFloors).toBe(4);
        expect(candidate.normalizedRule.minDistance).toBe(3);
        expect(candidate.normalizedRule.floorHeightM).toBe(3);
    });

    it('refuses to run without turf rather than producing geometry-free candidates', () => {
        expect(() => planCandidates([parcel()], PERSONA, {})).toThrow(/turf/);
    });

    it('refuses to price gains without the city\'s money rather than assuming euros', () => {
        expect(() => planCandidates([parcel()], PERSONA, { turf })).toThrow(/money/);
    });

    it('honours the limit', () => {
        const parcels = [0, 1, 2, 3, 4].map(index => parcel({ index }));
        expect(planCandidates(parcels, PERSONA, { ...OPTS, limit: 2 })).toHaveLength(2);
    });
});

describe('unknown existing buildings', () => {
    it.each([
        { builtGfaM2: null, builtFootprintM2: null, buildingCount: null },
        { builtGfaM2: undefined, builtFootprintM2: undefined, buildingCount: undefined },
        { buildingCoverage: 'unknown' },
        { buildingCoverage: 'partial' },
        { buildingSourceId: null },
        { builtKnown: false, builtFootprintM2: null, buildingCount: null }
    ])('keeps a geometry preview without inventing stock, gain, offer or rank for %j', evidence => {
        const [candidate] = planCandidates([parcel(evidence)], PERSONA, OPTS);
        expect(candidate.massing.geometry.type).toBe('Polygon');
        expect(candidate.proposedGfaM2).toBeGreaterThan(0);
        expect(candidate).toMatchObject({
            builtGfaM2: null, builtKnown: false, gain: null, offer: null, score: null,
            scoreParts: { density: null, valueUplift: null, openSpace: null }
        });
    });

    it('retains measured footprint evidence when only floor area is missing', () => {
        const [candidate] = planCandidates([parcel({ builtGfaM2: null, builtFootprintM2: 400, buildingCount: 2 })], PERSONA, OPTS);
        expect(candidate).toMatchObject({ builtGfaM2: null, builtFootprintM2: 400, buildingCount: 2, gain: null, score: null });
        expect(candidate.scoreParts.openSpace).toBeCloseTo(1 - 400 / candidate.areaM2);
    });

    it('ranks supported candidates first without letting unknown stock alter their gain scores', () => {
        const known = parcel({ index: 1, sideM: 30 });
        const unknown = parcel({ index: 0, sideM: 100, buildingCoverage: 'unknown' });
        const candidates = planCandidates([known, unknown], PERSONA, OPTS);
        expect(candidates).toHaveLength(2);
        expect(candidates[0].parcelId).toBe(known.parcelId);
        expect(candidates[0].scoreParts.valueUplift).toBe(1);
        expect(candidates[1].score).toBeNull();
    });

    it('does not require a missing footprint for a persona that gives open space zero weight', () => {
        const [candidate] = planCandidates([parcel({ builtFootprintM2: null })],
            { ...PERSONA, weights: { density: 1, openSpace: 0 } }, OPTS);
        expect(candidate.scoreParts.openSpace).toBeNull();
        expect(candidate.score).toBe(1);
    });
});

describe('what is skipped', () => {
    it('skips a plot below the rule\'s minimum building plot', () => {
        const tiny = parcel({ sideM: 12, rule: { maxFloors: 4, minSetbackM: 3, minPlotM2: 1000 } });
        expect(planCandidates([tiny], PERSONA, OPTS)).toHaveLength(0);
    });

    it('skips a plot the setback eats entirely', () => {
        const narrow = parcel({ sideM: 6, rule: { maxFloors: 4, minSetbackM: 5 } });
        expect(planCandidates([narrow], PERSONA, OPTS)).toHaveLength(0);
    });

    it('skips a parcel already built past what the rule permits — no uplift, no proposal', () => {
        const [reference] = planCandidates([parcel()], PERSONA, OPTS);
        const full = parcel({ builtGfaM2: reference.proposedGfaM2 * 2, builtFootprintM2: 1000, buildingCount: 4 });
        expect(planCandidates([full], PERSONA, OPTS)).toHaveLength(0);
    });

    it('skips a parcel with no geometry instead of throwing', () => {
        expect(planCandidates([{ parcelId: 'HR-1-1', geometry: null }], PERSONA, OPTS)).toHaveLength(0);
        expect(planCandidates([null, undefined], PERSONA, OPTS)).toHaveLength(0);
    });
});

describe('a missing rule value never becomes a real one', () => {
    it('takes the module defaults when the parcel has no rule at all', () => {
        const [candidate] = planCandidates([parcel({ rule: null })], PERSONA, OPTS);
        expect(candidate.rule).toEqual({
            maxFloors: DEFAULT_MAX_FLOORS,
            minSetbackM: DEFAULT_MIN_DISTANCE_M,
            source: 'default'
        });
        expect(candidate.allowedFloors).toBe(DEFAULT_MAX_FLOORS);
        expect(candidate.builtGfaM2).toBe(0);
        expect(candidate.scoreParts.openSpace).toBe(1);   // nothing built, so wholly open
    });

    it('takes the defaults per field when the rule states only some of them', () => {
        const partial = parcel({ rule: { ruleId: 'r', shortName: '2.9', maxFloors: null, minSetbackM: null, minPlotM2: null, maxCoveragePct: null, maxGfaM2: null, variables: {} } });
        const [candidate] = planCandidates([partial], PERSONA, OPTS);
        // A null setback must NOT read as 0 — that would mean "build to the boundary".
        expect(candidate.rule.minSetbackM).toBe(DEFAULT_MIN_DISTANCE_M);
        expect(candidate.rule.maxFloors).toBe(DEFAULT_MAX_FLOORS);
        expect(candidate.rule.source).toBe('default');
    });

    it('calls a rule that states something "urban-rule", even if only the setback', () => {
        const [candidate] = planCandidates([parcel({ rule: { maxFloors: null, minSetbackM: 5 } })], PERSONA, OPTS);
        expect(candidate.rule).toEqual({ maxFloors: DEFAULT_MAX_FLOORS, minSetbackM: 5, source: 'urban-rule' });
    });

    it('treats an absent persona weight as 0, never NaN', () => {
        const [candidate] = planCandidates([parcel()], { name: 'x', weights: { density: null } }, OPTS);
        expect(Number.isFinite(candidate.score)).toBe(true);
        expect(candidate.score).toBe(0);
    });
});

describe('rule ceilings apply to the published geometry', () => {
    it('rejects a sample above max_gbp instead of lowering only its reported area', () => {
        const [uncapped] = planCandidates([parcel()], PERSONA, OPTS);
        const capAt = Math.floor(uncapped.proposedGfaM2 / 2);
        expect(planCandidates([parcel({ rule: { maxFloors: 4, minSetbackM: 3, maxGfaM2: capAt } })], PERSONA, OPTS)).toEqual([]);
    });

    it('rejects a sample above max_izgradenost (coverage)', () => {
        expect(planCandidates([parcel({ rule: { maxFloors: 4, minSetbackM: 3, maxCoveragePct: 5 } })], PERSONA, OPTS)).toEqual([]);
    });

    it('cannot claim to meet a coverage limit without a positive parcel area', () => {
        for (const areaM2 of [null, undefined, 0, -1]) {
            expect(planCandidates([parcel({ areaM2, rule: { maxCoveragePct: 50 } })], PERSONA, OPTS)).toEqual([]);
        }
    });

    it('publishes the measured design area and derives the gain and offer from that same area', () => {
        const [reference] = planCandidates([parcel()], PERSONA, OPTS);
        const [candidate] = planCandidates([parcel({ rule: {
            maxFloors: 4, minSetbackM: 3, maxCoveragePct: 100, maxGfaM2: reference.proposedGfaM2
        } })], PERSONA, OPTS);
        const record = buildDesignRecord({ candidate, pick: { name: 'Sample' }, persona: PERSONA, city: 'test-city', authoredAt: '2026-10-22T00:00:00.000Z' });
        const measured = measureBuilding(record.geometry.buildings[0], {}, { floorHeightM: 3 });
        expect(candidate.proposedGfaM2).toBe(measured.gfaM2);
        expect(measured.gfaM2).toBe(reference.proposedGfaM2);
        expect(measured.footprintM2).toBeLessThanOrEqual(candidate.areaM2);
        expect(candidate.gain).toBeCloseTo(measured.gfaM2 * 4000, 3);
        // The planner's offer stays a share of that gain; the design itself carries no money.
        expect(candidate.offer).toBe(Math.round(measured.gfaM2 * 4000 * 0.3));
        expect(JSON.stringify(record)).not.toMatch(/offer/i);
    });

    it('leaves an uncapped proposal unmarked', () => {
        const [candidate] = planCandidates([parcel()], PERSONA, OPTS);
        expect(candidate.scoreParts.capped).toBeUndefined();
        expect(candidate.scoreParts).toEqual({
            density: expect.any(Number),
            valueUplift: expect.any(Number),
            openSpace: expect.any(Number),
            heritage: 0
        });
    });

    it('drops a candidate whose cap removes the uplift entirely', () => {
        const built = parcel({ builtGfaM2: 500, builtFootprintM2: 200, buildingCount: 1, rule: { maxFloors: 4, minSetbackM: 3, maxGfaM2: 400 } });
        expect(planCandidates([built], PERSONA, OPTS)).toHaveLength(0);
    });
});

describe('ordering and determinism', () => {
    it('sorts by score, best first', () => {
        const parcels = [0, 1, 2].map(index => parcel({ index, sideM: 30 + index * 15 }));
        const scores = planCandidates(parcels, PERSONA, OPTS).map(c => c.score);
        expect(scores.length).toBeGreaterThan(1);
        for (let i = 1; i < scores.length; i++) expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
    });

    it('a densifier ranks the big empty lot first; an open-space persona ranks the same set differently', () => {
        const parcels = [
            parcel({ index: 0, sideM: 45 }),
            parcel({ index: 1, sideM: 45, builtFootprintM2: 1500, builtGfaM2: 300, buildingCount: 2 })
        ];
        const densifier = planCandidates(parcels, PERSONA, OPTS);
        const preserver = planCandidates(parcels, { name: 'preserver', weights: { density: 0, openSpace: 1, valueUplift: 0, heritage: 0 } }, OPTS);
        // The densifier weights openSpace at 0.1 and uplift at 0.9 combined; the preserver only
        // cares which lot is still open, so its ranking is driven by a different part entirely.
        expect(preserver[0].scoreParts.openSpace).toBeGreaterThanOrEqual(preserver[preserver.length - 1].scoreParts.openSpace);
        expect(densifier.map(c => c.parcelId).sort()).toEqual(preserver.map(c => c.parcelId).sort());
        // The score is the persona's, not the parcel's: the same lot is worth different things.
        const densifierBuilt = densifier.find(c => c.builtGfaM2 > 0);
        const preserverBuilt = preserver.find(c => c.builtGfaM2 > 0);
        expect(densifierBuilt.score).not.toBeCloseTo(preserverBuilt.score, 6);
    });

    it('reproduces the same plan for the same seed, and a different massing for a different one', () => {
        const parcels = [0, 1, 2].map(index => parcel({ index }));
        const a = planCandidates(parcels, PERSONA, { ...OPTS, seed: 7 });
        const b = planCandidates(parcels, PERSONA, { ...OPTS, seed: 7 });
        expect(JSON.stringify(b)).toBe(JSON.stringify(a));

        const c = planCandidates(parcels, PERSONA, { ...OPTS, seed: 99 });
        expect(c.map(x => x.candidateId).sort()).toEqual(a.map(x => x.candidateId).sort());
        expect(JSON.stringify(c.map(x => x.massing))).not.toBe(JSON.stringify(a.map(x => x.massing)));
    });

    it('varies the build-out between parcels in one run, not just their position', () => {
        // Same geometry on every parcel, so the only thing that can differ is the sampled
        // variation — if the seed were not offset per parcel, every lot would get an identical one.
        const clones = [0, 1, 2, 3, 4].map(n => ({ ...parcel({ index: 0 }), parcelId: `HR-335614-${9000 + n}` }));
        const massings = planCandidates(clones, PERSONA, OPTS).map(c => JSON.stringify(c.massing));
        expect(massings).toHaveLength(5);
        expect(new Set(massings).size).toBeGreaterThan(1);
    });
});

describe('the massing stays on its own parcel', () => {
    it('every candidate\'s building lies inside the parcel it names', () => {
        const parcels = [0, 1, 2, 3].map(index => parcel({ index, sideM: 25 + index * 10 }));
        const candidates = planCandidates(parcels, PERSONA, OPTS);
        expect(candidates.length).toBeGreaterThan(0);
        for (const candidate of candidates) {
            const parcelFeature = turf.polygon(candidate.geometry.coordinates);
            const spill = turf.difference(candidate.massing, parcelFeature);
            const spillArea = spill ? turf.area(spill) : 0;
            expect(spillArea).toBeLessThan(0.5);   // m², i.e. buffer rounding only
            expect(turf.area(candidate.massing)).toBeLessThanOrEqual(turf.area(parcelFeature));
        }
    });

    it('holds with no setback at all, where the envelope IS the parcel', () => {
        const [candidate] = planCandidates([parcel({ rule: { maxFloors: 3, minSetbackM: 0 } })], PERSONA, OPTS);
        const parcelFeature = turf.polygon(candidate.geometry.coordinates);
        const spill = turf.difference(candidate.massing, parcelFeature);
        expect(spill ? turf.area(spill) : 0).toBeLessThan(0.5);
    });
});
