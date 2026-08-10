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

// A block, a row or a parcel-based design is CONTENT on existing parcels, and the only thing it
// competes for is the parcel. Alternatives were decided by comparing FOOTPRINTS — which for these
// designs is the union of their building rings — so two block designs over overlapping parcels
// whose rings landed in different places did not overlap, were not alternatives, and both stayed
// applied on the same ground.
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

describe('one design per parcel', () => {
    it('stands down a block that shares a parcel, even when the two rings are nowhere near each other', () => {
        // Rings ~90 m apart: no footprint overlap at all, so the old rule saw nothing.
        const standing = blockOn('block-a', ['HR-1', 'HR-2'], 15.900, true);
        const chosen = blockOn('block-b', ['HR-2', 'HR-3'], 15.902);

        const alternatives = collectAppliedProposalAlternatives(chosen, [standing, chosen]);

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

    it('still stands down an overlapping design that declares no parcels', () => {
        // The footprint rule has to survive: a record with no parcel list is decided on geometry.
        const standing = building('single-a', 15.900, true);
        const chosen = building('single-b', 15.9005);

        const alternatives = collectAppliedProposalAlternatives(chosen, [standing, chosen], {
            planOrder: require('../../frontend/js/proposals/plan-order.js')
        });

        expect(alternatives.map(entry => entry.proposalId)).toEqual(['single-a']);
    });
});
