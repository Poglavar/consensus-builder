// Regression tests for turning one clicked system-road polygon into a normal editable corridor
// proposal, including the parcel-panel entry point that makes the flow reachable.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const adoption = require('../../frontend/js/system-road-adoption.js');
const panelSource = readFileSync(
    new URL('../../frontend/js/parcels/ui/parcel-panel.js', import.meta.url),
    'utf8'
);
const indexSource = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');

afterEach(() => {
    [
        'isRoadParcel', 'currentParcel', 'proposalStorage', 'ProposalManager',
        'calculateRoadMetrics', 'corridorProfileFromLegacy', 'openCorridorProfileEditor',
        'getCurrentUsername', 'getCurrentUserAgent', 'getProposalCityId',
        'generateDefaultProposalName', 'updateStatus'
    ].forEach(key => { delete globalThis[key]; });
});

function roadFeature(geometry = {
    type: 'Polygon',
    coordinates: [[[15.9, 45.8], [15.91, 45.8], [15.91, 45.801], [15.9, 45.801], [15.9, 45.8]]]
}) {
    return {
        type: 'Feature',
        properties: { isRoad: true, roadName: 'Test Street' },
        geometry
    };
}

function metrics(lines, width = 12) {
    return {
        widths: { average: width },
        segments: lines.map(centerline => ({ centerline }))
    };
}

describe('system road adoption eligibility', () => {
    it('offers adoption only for a source road polygon without an existing road proposal', () => {
        expect(adoption.canOffer(roadFeature(), 'road-1', [])).toBe(true);
        expect(adoption.canOffer(roadFeature(), 'road-1', [{ goal: 'road-track' }])).toBe(false);

        const proposalChild = roadFeature();
        proposalChild.properties.ancestorProposal = 'proposal-1';
        expect(adoption.canOffer(proposalChild, 'road-1', [])).toBe(false);

        const ordinaryParcel = roadFeature();
        ordinaryParcel.properties.isRoad = false;
        expect(adoption.canOffer(ordinaryParcel, 'parcel-1', [])).toBe(false);
    });

    it('also recognizes roads held only in the road-parcel registry', () => {
        globalThis.isRoadParcel = id => id === 'road-registered';
        const feature = roadFeature();
        feature.properties = {};
        expect(adoption.canOffer(feature, 'road-registered', [])).toBe(true);
    });
});

describe('clicked system road geometry', () => {
    it('selects only the clicked polygon from a disconnected MultiPolygon road feature', () => {
        const left = [[[0, 0], [2, 0], [2, 1], [0, 1], [0, 0]]];
        const right = [[[10, 0], [12, 0], [12, 1], [10, 1], [10, 0]]];
        const feature = roadFeature({ type: 'MultiPolygon', coordinates: [left, right] });

        expect(adoption.clickedRoadGeometry(feature, [11, 0.5])).toEqual({
            type: 'Polygon',
            coordinates: right
        });
    });

    it('chooses the analysed centreline nearest the click', () => {
        const selected = adoption.centerlineFromMetrics(metrics([
            [[0, 0], [0, 10]],
            [[10, 0], [10, 10]]
        ]), [9.9, 4]);
        expect(selected).toEqual([{ lat: 0, lng: 10 }, { lat: 10, lng: 10 }]);
    });
});

describe('system road proposal materialization', () => {
    it('preserves the source polygon while giving the proposal an editable measured profile', () => {
        const feature = roadFeature();
        const profileFactory = width => ({
            strips: [
                { type: 'driving', width: width / 2, direction: 'backward' },
                { type: 'driving', width: width / 2, direction: 'forward' }
            ]
        });
        const proposal = adoption.buildProposal(feature, metrics([
            [[15.9, 45.8005], [15.91, 45.8005]]
        ], 12), {
            parcelId: 'road-1',
            author: 'Planner',
            city: 'zagreb',
            profileFactory
        });

        expect(proposal).toMatchObject({
            author: 'Planner',
            title: 'Test Street',
            goal: 'road-track',
            primaryType: 'Road',
            applied: false,
            parentParcelIds: ['road-1'],
            roadProposal: {
                parentParcelIds: ['road-1'],
                mode: 'adopt-system-road'
            }
        });
        expect(proposal.roadProposal.definition).toMatchObject({
            width: 12,
            segmentIds: ['system-1'],
            metadata: {
                source: 'system-road',
                sourceParcelId: 'road-1'
            }
        });
        expect(proposal.roadProposal.definition.points[0]).toEqual([
            { lat: 45.8005, lng: 15.9 },
            { lat: 45.8005, lng: 15.91 }
        ]);
        expect(proposal.geometry.roadGeometry.polygon).toEqual(feature.geometry);

        feature.geometry.coordinates[0][0][0] = 999;
        expect(proposal.geometry.roadGeometry.polygon.coordinates[0][0][0]).toBe(15.9);
    });

    it('keeps adopted widths inside the profile editor limits', () => {
        expect(adoption.measuredRoadWidth(metrics([], 0.4))).toBe(2);
        expect(adoption.measuredRoadWidth(metrics([], 120))).toBe(80);
    });

    it('stores, applies, and immediately opens the created road in the profile editor', async () => {
        const feature = roadFeature();
        const stored = [];
        const opened = vi.fn();
        globalThis.currentParcel = {
            id: 'road-1',
            layer: { feature },
            clickedLatLng: { lat: 45.8005, lng: 15.905 }
        };
        globalThis.proposalStorage = {
            getProposalsForParcel: vi.fn(() => []),
            addProposal: vi.fn(proposal => {
                stored.push(proposal);
                return 'proposal-1';
            }),
            removeProposal: vi.fn()
        };
        globalThis.ProposalManager = {
            _linkProposalToAncestors: vi.fn(),
            applyProposal: vi.fn(async () => true),
            unapplyProposal: vi.fn()
        };
        globalThis.calculateRoadMetrics = vi.fn(() => metrics([
            [[15.9, 45.8005], [15.91, 45.8005]]
        ], 10));
        globalThis.corridorProfileFromLegacy = width => ({
            strips: [
                { type: 'driving', width: width / 2, direction: 'backward' },
                { type: 'driving', width: width / 2, direction: 'forward' }
            ]
        });
        globalThis.openCorridorProfileEditor = opened;
        globalThis.getCurrentUsername = () => 'Planner';
        globalThis.getProposalCityId = () => 'zagreb';
        globalThis.generateDefaultProposalName = () => 'Road 1';
        globalThis.updateStatus = vi.fn();

        await expect(adoption.adoptSelectedSystemRoad()).resolves.toBe('proposal-1');
        expect(globalThis.proposalStorage.addProposal).toHaveBeenCalledOnce();
        expect(globalThis.ProposalManager.applyProposal).toHaveBeenCalledWith('proposal-1', {
            applyAnyway: true,
            suppressMissingParentAlerts: true
        });
        expect(opened).toHaveBeenCalledWith('proposal-1');
        expect(stored[0].roadProposal.definition.metadata).toMatchObject({
            source: 'system-road',
            sourceParcelId: 'road-1'
        });
        expect(globalThis.proposalStorage.removeProposal).not.toHaveBeenCalled();
    });
});

describe('system road adoption UI contract', () => {
    it('loads the adoption module and exposes the parcel-panel action', () => {
        expect(indexSource).toContain("'js/system-road-adoption.js'");
        expect(panelSource).toContain('global.SystemRoadAdoption.canOffer(feature, parcelKey, parcelProposals)');
        expect(panelSource).toContain('onclick="adoptSelectedSystemRoad()"');
    });
});
