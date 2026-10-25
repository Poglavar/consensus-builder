// Unit tests for the ground-conflict rules in proposals/claims.js: which applied records an apply
// displaces (appliedRivals: geometry only, no lineage exception) and which ones an in-place edit
// takes the ground from (editDependents), plus the edit-in-place rule in proposals/lineage.js.
import { describe, it, expect } from 'vitest';
import * as turf from '@turf/turf';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.turf = turf;
const { appliedRivals, editDependents } = require('../../frontend/js/proposals/claims.js');
const lineage = require('../../frontend/js/proposals/lineage.js');
const Cid = require('../../frontend/js/cid.js');
const planOrder = require('../../frontend/js/proposals/plan-order.js');
const { isApplied } = require('../../frontend/js/proposals/status.js');
const collectAppliedProposalAlternatives = (proposal, records, options = {}) =>
    appliedRivals(proposal, records, { isApplied, ...options });

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

describe('lineage is not a ground conflict', () => {
    it('a published source and its moved, non-overlapping fork both stay applied; real overlap still counts', () => {
        const source = {
            proposalId: 'published-source', lifecycleStatus: 'published', applied: true, appliedAt: 'before',
            goal: 'park', structureProposal: { kind: 'park', geometry: turf.polygon([[[15.9, 45.8], [15.901, 45.8], [15.901, 45.801], [15.9, 45.801], [15.9, 45.8]]]) }
        };
        const moved = {
            proposalId: 'moved-fork', sourceProposalId: source.proposalId, applied: true, goal: 'park', freePlacement: true,
            structureProposal: { kind: 'park', geometry: turf.polygon([[[16.1, 45.8], [16.101, 45.8], [16.101, 45.801], [16.1, 45.801], [16.1, 45.8]]]) }
        };
        const sourceBefore = structuredClone(source);

        expect(collectAppliedProposalAlternatives(moved, [source, moved], { planOrder })).toEqual([]);
        expect(source).toEqual(sourceBefore);

        const overlapping = {
            ...moved,
            proposalId: 'overlapping-fork',
            structureProposal: { kind: 'park', geometry: source.structureProposal.geometry }
        };
        expect(collectAppliedProposalAlternatives(overlapping, [source, overlapping], { planOrder })
            .map(record => record.proposalId)).toEqual(['published-source']);
    });

    it('does not treat a disjoint land fork as an alternative to its applied source, in either direction', () => {
        const source = {
            proposalId: 'source', applied: true, goal: 'park',
            structureProposal: { kind: 'park', geometry: turf.polygon([[[15.9, 45.8], [15.901, 45.8], [15.901, 45.801], [15.9, 45.801], [15.9, 45.8]]]) }
        };
        const fork = {
            proposalId: 'fork', sourceProposalId: 'source', landFork: { relation: 'disjoint' }, applied: true, goal: 'park',
            structureProposal: { kind: 'park', geometry: turf.polygon([[[16.0, 45.8], [16.001, 45.8], [16.001, 45.801], [16.0, 45.801], [16.0, 45.8]]]) }
        };
        expect(collectAppliedProposalAlternatives(fork, [source, fork], { planOrder })).toEqual([]);
        expect(collectAppliedProposalAlternatives(source, [source, fork], { planOrder })).toEqual([]);
    });

    // Supersession made a replacement chain one switchable family: applying any member parked the
    // others however far apart they stood. Removed with it (2026-10-17): lineage alone is no rival.
    it('a replacement chain left over from older edits is no family: only overlapping ground counts', () => {
        const source = { proposalId: 'source', applied: false, goal: 'single', buildingProposal: {} };
        const replacement = { proposalId: 'replacement', sourceProposalId: 'source', applied: false, goal: 'single', buildingProposal: {} };
        const secondReplacement = { proposalId: 'second', sourceProposalId: 'replacement', applied: true, goal: 'single', buildingProposal: {} };
        const records = [source, replacement, secondReplacement];

        expect(collectAppliedProposalAlternatives(source, records, { planOrder })).toEqual([]);
        expect(collectAppliedProposalAlternatives(replacement, records, { planOrder })).toEqual([]);
    });

    it('switches an independently drawn overlapping building plan, but keeps a separate one', () => {
        const target = building('target', 16.0, false);
        const overlapping = building('overlap', 16.0005, true);
        const separate = building('separate', 16.01, true);

        expect(collectAppliedProposalAlternatives(target, [target, overlapping, separate])
            .map(record => record.proposalId)).toEqual(['overlap']);
    });

    it('does not reinterpret a parcel layout as a building alternative', () => {
        const currentBuilding = building('building', 16.0, true);
        const ground = currentBuilding.geometry.buildings[0].geometry;
        const layout = {
            proposalId: 'plots',
            applied: false,
            goal: 'parcel-layout',
            parcelLayout: { pool: ground, plots: [{ geometry: ground, source: 'manual' }] }
        };

        expect(collectAppliedProposalAlternatives(layout, [currentBuilding, layout])).toEqual([]);
    });
});

// What "the ground is taken" means. Decided 2026-08-24 (the user): GEOMETRY, not parcel identity.
//
// A cadastral parcel is not the unit a proposal competes for. Roads and parcel layouts cut one
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

describe('confirmed plan replacement includes occupied ground', () => {
    const ground = west => building('shape', west).geometry.buildings[0].geometry;
    const layout = (proposalId, west, applied = false) => ({ proposalId, applied, goal: 'parcel-layout',
        parcelLayout: { plots: [{ geometry: ground(west) }] } });
    const road = (proposalId, west, applied = true) => ({ proposalId, applied, goal: 'road-track',
        roadProposal: { definition: { polygon: ground(west) } } });
    const options = { planOrder, replaceOccupiedGround: true };

    it('releases overlapping roads, layouts and content, but keeps disjoint, bordering and parked records', () => {
        const target = layout('new-layout', 16);
        const old = [layout('old-layout', 16, true), road('old-road', 16), building('old-building', 16, true),
            { proposalId: 'old-park', applied: true, structureProposal: { kind: 'park', geometry: ground(16) } }];
        const keep = [road('separate-road', 16.01), road('bordering-road', 16.001),
            layout('separate-layout', 16.01, true), road('parked-road', 16, false)];
        const records = [...old, ...keep, target];
        const before = structuredClone(records);
        expect(collectAppliedProposalAlternatives(target, records, options).map(r => r.proposalId))
            .toEqual(old.map(r => r.proposalId));
        expect(records).toEqual(before);
        expect(collectAppliedProposalAlternatives(target, records, { planOrder })).toEqual([]);
    });

    it.each(['building', 'park', 'square', 'lake'])('releases an old corridor under incoming %s ground without a layout design', kind => {
        const target = kind === 'building' ? building('new-building', 16)
            : { proposalId: `new-${kind}`, structureProposal: { kind, geometry: ground(16) } };
        const old = road('old-road', 16);
        const keep = [road('outside', 16.01), road('touches-boundary', 16.001), road('parked', 16, false)];
        expect(collectAppliedProposalAlternatives(target, [old, ...keep], options).map(record => record.proposalId)).toEqual(['old-road']);
        expect(collectAppliedProposalAlternatives(target, [old], { planOrder })).toEqual([]);
    });

    it('retains a host layout for a building-only share and retains road crossings', () => {
        expect(collectAppliedProposalAlternatives(building('new-building', 16), [layout('host-layout', 16, true)], options)).toEqual([]);
        expect(collectAppliedProposalAlternatives(road('new-road', 16, false), [road('crossing', 16)], options)).toEqual([]);
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

describe('overlapping published road revisions', () => {
    const box = west => turf.polygon([[[west,45.8],[west+.002,45.8],[west+.002,45.8001],[west,45.8001],[west,45.8]]]).geometry;
    const originalCid = Cid.cidOfObject({ road: 'original' });
    const source = { proposalId:'original-road', goal:'road-track', applied:true, published:{cid:originalCid}, roadProposal:{definition:{polygon:box(16)}} };
    const revision = { proposalId:'revised-road', goal:'road-track', applied:true, origin:{cid:originalCid}, roadProposal:{definition:{polygon:box(16)}} };
    it('treats the same road profile revisions as rivals in either direction', () => {
        expect(collectAppliedProposalAlternatives(revision,[source],{planOrder})).toEqual([source]);
        expect(collectAppliedProposalAlternatives(source,[revision],{planOrder})).toEqual([revision]);
    });
    it('retains moved copies and ordinary crossing roads', () => {
        const moved={...revision,roadProposal:{definition:{polygon:box(16.1)}}};
        expect(collectAppliedProposalAlternatives(moved,[source],{planOrder})).toEqual([]);
        const crossing={...revision,origin:null};
        expect(collectAppliedProposalAlternatives(crossing,[source],{planOrder})).toEqual([]);
    });
});

describe('appliedRivals reads the footprint lazily', () => {
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

// "Editing and saving a land readjustment that has had something built on top of its child parcels
// unapplies … anything proposed on top" (the user). Reproduced 2026-10-17: a Block urban rule on a
// readjustment's child plot declares the PARENT cadastre parcels, so a check keyed on child plots
// found nothing and the block stayed applied over changed ground. The link is geometric.
describe('editDependents: who stands on ground an in-place edit changes', () => {
    const box = (west, east) => ({
        type: 'Polygon',
        coordinates: [[[west, 45.8], [east, 45.8], [east, 45.8004], [west, 45.8004], [west, 45.8]]]
    });
    const layout = (plots, createdAt = '2026-10-01T10:00:00.000Z') => ({
        proposalId: 'layout', goal: 'parcel-layout', applied: true, createdAt,
        cadastreParcelIds: ['HR-1', 'HR-2'],
        parcelLayout: { pool: box(15.9000, 15.9020), plots: plots.map(geometry => ({ geometry, source: 'manual' })) }
    });
    const blockOnPlot = (proposalId, west, east, createdAt = '2026-10-02T10:00:00.000Z') => ({
        proposalId, goal: 'buildings', applied: true, createdAt,
        // The parents, exactly as a Block built on a child plot stores them.
        cadastreParcelIds: ['HR-1', 'HR-2'],
        buildingProposal: {},
        geometry: { buildings: [turf.polygon(box(west, east).coordinates)] }
    });
    const options = { planOrder, area: turf.area, isApplied };
    const plotA = box(15.9000, 15.9010);
    const plotB = box(15.9010, 15.9020);

    it('finds a block on a child plot the edit reshaped', () => {
        const before = layout([plotA, plotB]);
        const after = layout([plotA, box(15.9010, 15.9016), box(15.9016, 15.9020)]);
        const onB = blockOnPlot('block-on-b', 15.9012, 15.9014);
        expect(editDependents(before, after, [before, onB], options).map(record => record.proposalId)).toEqual(['block-on-b']);
    });

    it('leaves a block on a plot the edit did not touch, and a parked one', () => {
        const before = layout([plotA, plotB]);
        const after = layout([plotA, box(15.9010, 15.9016), box(15.9016, 15.9020)]);
        const onA = blockOnPlot('block-on-a', 15.9002, 15.9004);
        const parked = { ...blockOnPlot('parked-on-b', 15.9012, 15.9014), applied: false };
        expect(editDependents(before, after, [before, onA, parked], options)).toEqual([]);
    });

    it('does not count what the edited record itself stands on (older records)', () => {
        const before = layout([plotA, plotB], '2026-10-05T10:00:00.000Z');
        const after = layout([plotA, box(15.9010, 15.9016), box(15.9016, 15.9020)], '2026-10-05T10:00:00.000Z');
        const older = blockOnPlot('older-block', 15.9012, 15.9014, '2026-10-01T10:00:00.000Z');
        expect(editDependents(before, after, [before, older], options)).toEqual([]);
    });

    it('finds nothing when the edit changed no ground', () => {
        const before = layout([plotA, plotB]);
        const onB = blockOnPlot('block-on-b', 15.9012, 15.9014);
        expect(editDependents(before, layout([plotA, plotB]), [before, onB], options)).toEqual([]);
    });
});

describe('lineage: what saving an edit does to its source', () => {
    const published = (extra = {}) => ({ cid: Cid.cidOfObject({ schema: 'design/v1', title: 'Published' }), publishedAt: null,
        apiBase: 'https://api.example.test', ...extra });

    it('takes a design CID mark as published, and no mint record, generic hash, lifecycle label or row id', () => {
        expect(lineage.isPublished({ published: published() })).toBe(true);
        // Whichever index it went to: the CID names the design, not the index.
        expect(lineage.isPublished({ published: published({ apiBase: 'https://other.example.test' }) })).toBe(true);
        // Designs are not minted (M3): a mint flag or transaction is no publication.
        expect(lineage.isPublished({ isMinted: true })).toBe(false);
        expect(lineage.isPublished({ onchain: { transactionHash: '0xabc' } })).toBe(false);
        expect(lineage.isPublished({ published: published({ cid: 'not-a-cid' }) })).toBe(false);
        expect(lineage.isPublished({ hash: 'abc', lifecycleStatus: 'published' })).toBe(false);
        // A server row id is no publication any more (M2): a published design is named by its CID.
        expect(lineage.isPublished({ serverProposalId: '17', publicationApiBase: 'https://api.example.test' })).toBe(false);
        expect(lineage.isPublished(null)).toBe(false);
    });

    it('edits one\'s own local record in place, forks a published one, and forks on an explicit Fork', () => {
        expect(lineage.editsInPlace({ proposalId: 'own', applied: true })).toBe(true);
        expect(lineage.editsInPlace({ proposalId: 'p', published: published() })).toBe(false);
        expect(lineage.editsInPlace({ proposalId: 'p', lifecycleStatus: 'published' })).toBe(true);
        expect(lineage.editsInPlace({ proposalId: 'p', lifecycleStatus: 'Active', published: published() })).toBe(false);
        expect(lineage.editsInPlace({ proposalId: 'own' }, { fork: true })).toBe(false);
        expect(lineage.editsInPlace(null)).toBe(false);
    });

    it('keeps the record\'s id, replay place and own lineage; the edit is not its own source', () => {
        const source = {
            proposalId: 'own', createdAt: '2026-10-01T10:00:00.000Z', lifecycleStatus: 'active',
            proposalOrigin: { relation: 'revision', source: { kind: 'local', localProposalId: 'published-original' }, title: 'Published original' }, title: 'Old'
        };
        const edited = {
            proposalId: undefined, title: 'New',
            proposalDraftId: 'draft-1', roadProposal: { definition: {} }
        };
        expect(lineage.inPlaceRecord(source, edited)).toEqual({
            proposalId: 'own', createdAt: '2026-10-01T10:00:00.000Z', lifecycleStatus: 'active',
            proposalOrigin: { relation: 'revision', source: { kind: 'local', localProposalId: 'published-original' }, title: 'Published original' }, title: 'New',
            roadProposal: { definition: {}, id: 'own', proposalId: 'own' }
        });
    });

    it('preserves the land fork and draft metadata, and defaults the author and lifecycle, on in-place edits', () => {
        const source = {
            proposalId: 'draft', createdAt: '2026-10-01',
            proposalOrigin: { relation: 'copy', source: { kind: 'local', localProposalId: 'source' }, title: 'Source' },
            landFork: { kind: 'overlap' }, proposalDraftId: 'draft-group', proposalDraftRevision: 3,
            authorAgentId: 'agent', lifecycleStatus: 'Draft', termsConfirmed: true
        };
        const out = lineage.inPlaceRecord(source, { title: 'Edited' });
        expect(out).toMatchObject({
            proposalId: 'draft', createdAt: '2026-10-01', proposalOrigin: source.proposalOrigin,
            landFork: source.landFork, proposalDraftId: 'draft-group', proposalDraftRevision: 3,
            authorAgentId: 'agent', lifecycleStatus: 'Draft', title: 'Edited'
        });
        // A design has no terms to confirm (M2): the retired flag is not carried into the edit.
        expect(out).not.toHaveProperty('termsConfirmed');
    });
});
