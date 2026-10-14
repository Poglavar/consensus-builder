// Unit tests for generic immutable-replacement source supersession.
import { describe, it, expect } from 'vitest';
import * as turf from '@turf/turf';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.turf = turf;
const {
    proposalIsAppliedForReplacement,
    proposalReplacementSourceId,
    proposalReplacementFamilyIds,
    collectAppliedProposalAlternatives,
    commitReplacementSupersession
} = require('../../frontend/js/proposal-supersession.js');

const building = (proposalId, west, applied = false) => ({
    proposalId,
    applied,
    goal: 'single',
    buildingProposal: {},
    geometry: {
        buildings: [turf.polygon([[[
            west, 45.8
        ], [
            west + 0.001, 45.8
        ], [
            west + 0.001, 45.801
        ], [
            west, 45.801
        ], [
            west, 45.8
        ]]])]
    }
});

describe('proposal replacement supersession', () => {
    it('recognizes only the canonical root application flag', () => {
        expect(proposalIsAppliedForReplacement({ applied: true, buildingProposal: {} })).toBe(true);
        expect(proposalIsAppliedForReplacement({ applied: false, reparcellization: {} })).toBe(false);
        expect(proposalIsAppliedForReplacement({ buildingProposal: { status: 'applied' } })).toBe(false);
    });

    it('accepts new provenance fields before the legacy copied-from field', () => {
        expect(proposalReplacementSourceId({ sourceProposalId: 'new', copiedFromProposalId: 'old' })).toBe('new');
        expect(proposalReplacementSourceId({ replacementOfProposalId: 'replacement-source' })).toBe('replacement-source');
    });

    it('parks an applied source after its replacement succeeds', () => {
        const source = { proposalId: 'source', applied: true, appliedAt: 'before', buildingProposal: {} };
        const replacement = { proposalId: 'replacement', sourceProposalId: 'source', applied: true, buildingProposal: {} };
        const records = new Map([['source', source], ['replacement', replacement]]);

        const committed = commitReplacementSupersession(replacement, 'replacement', id => records.get(id));

        expect(committed).toMatchObject({ source, sourceId: 'source', replacementId: 'replacement' });
        expect(source.applied).toBe(false);
        expect(source.appliedAt).toBeUndefined();
        expect(replacement.replacementLifecycle).toBeUndefined();
        expect(replacement.supersedesProposalIds).toBeUndefined();
    });

    it('preserves a published source for a moved non-overlapping fork but still finds real overlap', () => {
        const source = {
            proposalId: 'published-source', lifecycleStatus: 'published', applied: true, appliedAt: 'before',
            goal: 'park', structureProposal: { kind: 'park', geometry: turf.polygon([[[15.9, 45.8], [15.901, 45.8], [15.901, 45.801], [15.9, 45.801], [15.9, 45.8]]]) }
        };
        const moved = {
            proposalId: 'moved-fork', sourceProposalId: source.proposalId, applied: true, goal: 'park', freePlacement: true,
            structureProposal: { kind: 'park', geometry: turf.polygon([[[16.1, 45.8], [16.101, 45.8], [16.101, 45.801], [16.1, 45.801], [16.1, 45.8]]]) }
        };
        const records = [source, moved];
        const sourceBefore = structuredClone(source);

        expect([...proposalReplacementFamilyIds(moved, records)]).toEqual(['moved-fork']);
        expect(collectAppliedProposalAlternatives(moved, records, {
            planOrder: require('../../frontend/js/proposals/plan-order.js')
        })).toEqual([]);
        expect(commitReplacementSupersession(moved, moved.proposalId, id => records.find(record => record.proposalId === id))).toBeNull();
        expect(source).toEqual(sourceBefore);

        const overlapping = {
            ...moved,
            proposalId: 'overlapping-fork',
            structureProposal: { kind: 'park', geometry: source.structureProposal.geometry }
        };
        expect(collectAppliedProposalAlternatives(overlapping, [source, overlapping], {
            planOrder: require('../../frontend/js/proposals/plan-order.js')
        }).map(record => record.proposalId)).toEqual(['published-source']);
    });

    it('does not treat a disjoint land fork as an alternative to its applied source', () => {
        const source = {
            proposalId: 'source', applied: true, goal: 'park',
            structureProposal: { kind: 'park', geometry: turf.polygon([[[15.9, 45.8], [15.901, 45.8], [15.901, 45.801], [15.9, 45.801], [15.9, 45.8]]]) }
        };
        const fork = {
            proposalId: 'fork', sourceProposalId: 'source', landFork: { relation: 'disjoint' }, applied: true, goal: 'park',
            structureProposal: { kind: 'park', geometry: turf.polygon([[[16.0, 45.8], [16.001, 45.8], [16.001, 45.801], [16.0, 45.801], [16.0, 45.8]]]) }
        };
        const records = [source, fork];

        expect([...proposalReplacementFamilyIds(fork, records)]).toEqual(['fork']);
        expect([...proposalReplacementFamilyIds(source, records)]).toEqual(['source']);
        expect(collectAppliedProposalAlternatives(fork, records, {
            planOrder: require('../../frontend/js/proposals/plan-order.js')
        })).toEqual([]);
        expect(collectAppliedProposalAlternatives(source, records, {
            planOrder: require('../../frontend/js/proposals/plan-order.js')
        })).toEqual([]);

        const overlappingFork = {
            ...fork,
            proposalId: 'overlapping-fork',
            structureProposal: { kind: 'park', geometry: source.structureProposal.geometry }
        };
        expect(collectAppliedProposalAlternatives(overlappingFork, [source, overlappingFork], {
            planOrder: require('../../frontend/js/proposals/plan-order.js')
        }).map(record => record.proposalId)).toEqual(['source']);
        expect(source.applied).toBe(true);
    });

    it('keeps an applied source standing for a changed-land counterproposal', () => {
        const source = { proposalId: 'source', applied: true, appliedAt: 'before', buildingProposal: {} };
        const replacement = {
            proposalId: 'fork', sourceProposalId: 'source', applied: true, buildingProposal: {},
            landFork: { originParcelIds: ['HR-1'], relation: 'disjoint' }
        };
        const records = new Map([['source', source], ['fork', replacement]]);
        const before = structuredClone(source);

        expect(commitReplacementSupersession(replacement, 'fork', id => records.get(id))).toBeNull();
        expect(source).toEqual(before);
    });

    it('leaves an already-unapplied source alone', () => {
        const source = { proposalId: 'source', applied: false };
        const replacement = { proposalId: 'replacement', sourceProposalId: 'source' };
        const records = new Map([['source', source], ['replacement', replacement]]);
        expect(commitReplacementSupersession(replacement, 'replacement', id => records.get(id))).toBeNull();
        expect(source.applied).toBe(false);
    });

    it('treats a replacement chain as one switchable family in either direction', () => {
        const source = { proposalId: 'source', applied: false };
        const replacement = { proposalId: 'replacement', sourceProposalId: 'source', applied: false };
        const secondReplacement = { proposalId: 'second', sourceProposalId: 'replacement', applied: true };
        const records = [source, replacement, secondReplacement];

        expect([...proposalReplacementFamilyIds(source, records)].sort()).toEqual(['replacement', 'second', 'source']);
        expect(collectAppliedProposalAlternatives(source, records).map(record => record.proposalId)).toEqual(['second']);
        expect(collectAppliedProposalAlternatives(replacement, records).map(record => record.proposalId)).toEqual(['second']);
    });

    it('switches an independently drawn overlapping building plan, but keeps a separate one', () => {
        const target = building('target', 16.0, false);
        const overlapping = building('overlap', 16.0005, true);
        const separate = building('separate', 16.01, true);

        expect(collectAppliedProposalAlternatives(target, [target, overlapping, separate])
            .map(record => record.proposalId)).toEqual(['overlap']);
    });

    it('does not reinterpret a reparcellization as a building alternative', () => {
        const currentBuilding = building('building', 16.0, true);
        const readjustment = {
            proposalId: 'plots',
            applied: false,
            reparcellization: { polygons: [{ geometry: currentBuilding.geometry.buildings[0].geometry }] }
        };

        expect(collectAppliedProposalAlternatives(readjustment, [currentBuilding, readjustment])).toEqual([]);
    });
});

// What "the ground is taken" means. Decided 2026-08-24 (the user): GEOMETRY, not parcel identity.
//
// A cadastral parcel is not the unit a proposal competes for. Roads and land readjustments cut one
// cadastral parcel into many plots, and a plan puts a different building on each — so two buildings
// sharing a cadastral ancestor are usually neighbours, not rivals. Deciding by parcel identity made
// them rivals: on the 299-member Sibenik plan it left 34 of 166 buildings applied, each new member
// unapplying the one before it, while the summary still reported 298 applied and the map showed 34.
//
// A proposal is in the way only when the ground it holds actually overlaps the ground being taken.
const blockOn = (proposalId, parcelIds, west, applied = false) => ({
    proposalId,
    applied,
    goal: 'buildings',
    typologyType: 'block',
    parentParcelIds: parcelIds.slice(),
    buildingProposal: { parentParcelIds: parcelIds.slice() },
    geometry: {
        buildings: [turf.polygon([[
            [west, 45.8], [west + 0.0002, 45.8], [west + 0.0002, 45.8002], [west, 45.8002], [west, 45.8]
        ]])]
    }
});

describe('ground is taken by overlap, not by parcel identity', () => {
    it('leaves a block that merely shares a cadastral parcel applied', () => {
        // Rings ~90 m apart on a shared cadastral ancestor: two buildings on different plots of one
        // parcel. The old rule unapplied the standing one; both now stay applied.
        const standing = blockOn('block-a', ['HR-1', 'HR-2'], 15.900, true);
        const chosen = blockOn('block-b', ['HR-2', 'HR-3'], 15.902);

        expect(collectAppliedProposalAlternatives(chosen, [standing, chosen])).toEqual([]);
    });

    it('unapplies a block whose ground the new one actually takes', () => {
        const standing = blockOn('block-a', ['HR-1'], 15.900, true);
        const chosen = blockOn('block-b', ['HR-1'], 15.9001);   // rings overlap

        const alternatives = collectAppliedProposalAlternatives(chosen, [standing, chosen], {
            planOrder: require('../../frontend/js/proposals/plan-order.js')
        });

        expect(alternatives.map(entry => entry.proposalId)).toEqual(['block-a']);
    });

    it('leaves a block on entirely different parcels alone', () => {
        const elsewhere = blockOn('block-a', ['HR-9'], 15.900, true);
        const chosen = blockOn('block-b', ['HR-2', 'HR-3'], 15.902);

        expect(collectAppliedProposalAlternatives(chosen, [elsewhere, chosen])).toEqual([]);
    });

    it('ignores a shared parcel when the standing proposal is not applied', () => {
        const parked = blockOn('block-a', ['HR-2'], 15.900, false);
        const chosen = blockOn('block-b', ['HR-2'], 15.902);

        expect(collectAppliedProposalAlternatives(chosen, [parked, chosen])).toEqual([]);
    });

    // These two used to need coordinatedPlanId to carve out an exception. They now hold for the
    // ordinary reason — disjoint footprints do not overlap — so one of them drops the marker
    // entirely: if it ever fails, the parcel-identity rule has come back.
    it('lets disjoint building members of one plan share their original parent parcel', () => {
        const standing = {
            ...blockOn('plan-building-a', ['HR-BASE'], 15.900, true),
            coordinatedPlanId: 'upu-borovje'
        };
        const chosen = blockOn('plan-building-b', ['HR-BASE'], 15.902);   // no marker

        expect(collectAppliedProposalAlternatives(chosen, [standing, chosen], {
            planOrder: require('../../frontend/js/proposals/plan-order.js')
        })).toEqual([]);
    });

    it('still unapplies genuinely overlapping building members of one plan', () => {
        const standing = {
            ...blockOn('plan-building-a', ['HR-BASE'], 15.900, true),
            coordinatedPlanId: 'upu-borovje'
        };
        const chosen = {
            ...blockOn('plan-building-b', ['HR-BASE'], 15.9001),
            coordinatedPlanId: 'upu-borovje'
        };

        const alternatives = collectAppliedProposalAlternatives(chosen, [standing, chosen], {
            planOrder: require('../../frontend/js/proposals/plan-order.js')
        });

        expect(alternatives.map(entry => entry.proposalId)).toEqual(['plan-building-a']);
    });

    it('still unapplies an overlapping design that declares no parcels', () => {
        // The footprint rule has to survive: a record with no parcel list is decided on geometry.
        const standing = building('single-a', 15.900, true);
        const chosen = building('single-b', 15.9005);

        const alternatives = collectAppliedProposalAlternatives(chosen, [standing, chosen], {
            planOrder: require('../../frontend/js/proposals/plan-order.js')
        });

        expect(alternatives.map(entry => entry.proposalId)).toEqual(['single-a']);
    });
});

// The road tool's "Build through": a road crossing an applied park cuts through it (the park keeps
// the rest), so explicit Apply must not take the park off the map as a rival. Buildings it covers
// remain rivals.
describe('a road across an applied structure', () => {
    const box = (west, south, east, north) => ({
        type: 'Polygon',
        coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
    });
    const road = { proposalId: 'road', goal: 'road-track', roadProposal: { definition: { polygon: box(15.9695, 45.8004, 15.9725, 45.8006), width: 6 } } };

    it('is not an alternative to the park it crosses', () => {
        const park = { proposalId: 'park', applied: true, goal: 'park', structureProposal: { kind: 'park', geometry: box(15.97, 45.8, 15.972, 45.801) } };
        expect(collectAppliedProposalAlternatives(road, [road, park])).toEqual([]);
    });

    it('still displaces a building it covers', () => {
        const house = building('house', 15.9705, true);
        expect(collectAppliedProposalAlternatives(road, [road, house]).map(p => p.proposalId)).toEqual(['house']);
    });
});

describe('reparcellization agreement replacement families', () => {
    const plot = (west, east, south = 0, north = 1) => turf.polygon([[
        [west, south], [east, south], [east, north], [west, north], [west, south]
    ]]);
    const agreement = (proposalId, geometry, applied, index) => ({
        proposalId, sourceProposalId: 'source-plan', applied,
        reparcellizationAgreement: { groupId: 'courtyard-group', index, count: 2 },
        reparcellization: { polygons: [{ geometry, jointPool: false }] }
    });

    it('allows two disjoint siblings from the same source to remain applied alternatives', () => {
        const first = agreement('agreement-1', plot(0, 1).geometry, true, 0);
        const second = agreement('agreement-2', plot(2, 3).geometry, false, 1);
        expect(collectAppliedProposalAlternatives(second, [first, second], {
            planOrder: require('../../frontend/js/proposals/plan-order.js')
        })).toEqual([]);
    });

    it('parks both applied siblings when the original source is the target', () => {
        const source = { proposalId: 'source-plan', applied: false,
            reparcellization: { polygons: [{ geometry: plot(0, 3).geometry }] } };
        const first = agreement('agreement-1', plot(0, 1).geometry, true, 0);
        const second = agreement('agreement-2', plot(2, 3).geometry, true, 1);
        expect(collectAppliedProposalAlternatives(source, [source, first, second], {
            planOrder: require('../../frontend/js/proposals/plan-order.js')
        }).map(record => record.proposalId)).toEqual(['agreement-1', 'agreement-2']);
    });

    it('parks the original source when publishing a sibling agreement', () => {
        const source = { proposalId: 'source-plan', applied: true };
        const first = agreement('agreement-1', plot(0, 1).geometry, true, 0);
        const second = agreement('agreement-2', plot(2, 3).geometry, false, 1);
        expect(collectAppliedProposalAlternatives(second, [source, first, second], {
            planOrder: require('../../frontend/js/proposals/plan-order.js')
        }).map(record => record.proposalId)).toEqual(['source-plan']);
    });

    it('still treats overlapping siblings in one group as rivals', () => {
        const first = agreement('agreement-1', plot(0, 2).geometry, true, 0);
        const second = agreement('agreement-2', plot(1, 3).geometry, false, 1);
        expect(collectAppliedProposalAlternatives(second, [first, second], {
            planOrder: require('../../frontend/js/proposals/plan-order.js')
        }).map(record => record.proposalId)).toEqual(['agreement-1']);
    });

    it('keeps a same-index replacement as an alternative even when its sibling is disjoint', () => {
        const original = agreement('agreement-1', plot(0, 1).geometry, true, 0);
        const replacement = { ...agreement('agreement-1b', plot(0, 1).geometry, false, 0), sourceProposalId: 'agreement-1' };
        expect(collectAppliedProposalAlternatives(replacement, [original, replacement], {
            planOrder: require('../../frontend/js/proposals/plan-order.js')
        }).map(record => record.proposalId)).toEqual(['agreement-1']);
    });
});

describe('collectAppliedProposalAlternatives reads the footprint lazily', () => {
    it('never unions the target when no applied rival is there to compare with', () => {
        const planOrder = require('../../frontend/js/proposals/plan-order.js');
        let unions = 0;
        const counting = { ...planOrder, footprintOf: record => { unions += 1; return planOrder.footprintOf(record); } };
        const square = turf.polygon([[[16, 45.8], [16.001, 45.8], [16.001, 45.801], [16, 45.801], [16, 45.8]]]);
        const target = { proposalId: 'plan', goal: 'buildings', buildingProposal: {}, geometry: square.geometry };
        const unapplied = { proposalId: 'other', applied: false, goal: 'buildings', buildingProposal: {}, geometry: square.geometry };
        const road = { proposalId: 'road', applied: true, goal: 'road-track', roadProposal: { definition: { polygon: square.geometry } } };
        expect(collectAppliedProposalAlternatives(target, [target, unapplied, road], { planOrder: counting })).toEqual([]);
        expect(unions).toBe(0);
        const rival = { proposalId: 'rival', applied: true, goal: 'buildings', buildingProposal: {}, geometry: square.geometry };
        expect(collectAppliedProposalAlternatives(target, [target, rival], { planOrder: counting }).map(r => r.proposalId)).toEqual(['rival']);
        expect(unions).toBeGreaterThan(0);
    });
});
