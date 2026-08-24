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

// What "the ground is taken" means. Decided 2026-08-24 (Simun): GEOMETRY, not parcel identity.
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
