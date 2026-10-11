// Regression coverage for ownership carried by applied readjustment plots.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const formationEdit = require('../../frontend/js/proposals/formation-edit.js');
const { _applyReparcellizationProposal } = require('../../frontend/js/proposals/apply/parcels.js');
require('../../frontend/js/proposal-parcel-identity.js');

const saved = {};
const globalKeys = [
    '_normalizeProposalId', 'updateStatus', 'turf', 'window',
    '_resolveRootParcelIdFromProperties', '_resolveRootParcelNumberFromProperties',
    '_calculateGeoJsonArea', 'persistAppliedProposal', 'refreshProposalUIAfterApply', 'transferParcelOwnership'
];

function rect() {
    return {
        type: 'Polygon',
        coordinates: [[[15.96, 45.80], [15.961, 45.80], [15.961, 45.802], [15.96, 45.802], [15.96, 45.80]]]
    };
}

function spy() {
    const fn = (...args) => { fn.calls.push(args); };
    fn.calls = [];
    return fn;
}

function manager() {
    const parent = {
        type: 'Feature', geometry: rect(), properties: {
            parcelId: 'HR-A', BROJ_CESTICE: 'A', rootParcelId: 'HR-A',
            rootParcelNumber: 'A', cadastreParcelIds: ['HR-A']
        }
    };
    return {
        added: [],
        _resolveLiveFormationParents: () => ({ ok: true, ids: ['HR-A'], cadastreIds: ['HR-A'], features: [parent] }),
        _assignSyntheticChildIdentities(proposalId, features) {
            features.forEach((feature, index) => {
                feature.properties.parcelId = `HR-A#${proposalId}-${index + 1}`;
                feature.properties.syntheticToken = String(proposalId);
                feature.properties.syntheticIndex = index + 1;
            });
        },
        _addFeaturesToMap(features) { this.added.push(...features); },
        _markParcelProducedByProposal: spy(),
        _setDescendantProposalOnParcels: spy(),
        _linkProposalToAncestors: spy(),
        _consumeFeaturesFromLiveFabric: spy(),
        _markParcelsModifiedBatch: spy(),
        _addChildParcels: spy(),
        _adoptForeignPlotPieces: spy(),
        _setLastApplyFailure: spy(),
        _applyReparcellizationProposal
    };
}

beforeEach(() => {
    globalKeys.forEach(key => { saved[key] = globalThis[key]; });
    globalThis._normalizeProposalId = value => value == null ? '' : String(value);
    globalThis.updateStatus = spy();
    globalThis.turf = turf;
    globalThis.window = { __formationEdit: formationEdit };
    globalThis._resolveRootParcelIdFromProperties = (props, explicit) =>
        props?.cadastreParcelIds?.[0] || props?.rootParcelId || explicit || null;
    globalThis._resolveRootParcelNumberFromProperties = props => props?.rootParcelNumber || null;
    globalThis._calculateGeoJsonArea = geometry => turf.area({ type: 'Feature', properties: {}, geometry });
    globalThis.persistAppliedProposal = spy();
    globalThis.refreshProposalUIAfterApply = spy();
    globalThis.transferParcelOwnership = spy();
});

afterEach(() => {
    globalKeys.forEach(key => {
        if (saved[key] === undefined) delete globalThis[key];
        else globalThis[key] = saved[key];
    });
});

describe('applied land readjustment ownership', () => {
    it('preserves both assigned owners and their shares on the formed parcel', async () => {
        const apply = manager();
        const data = {
            cadastreParcelIds: ['HR-A'],
            reparcellization: { polygons: [{
                geometry: rect(), ownerKey: 'joint:a+b', displayName: 'Ana and Boris', percent: 1,
                jointPool: true,
                owners: [
                    { ownerKey: 'a', displayName: 'Ana', share: 0.6 },
                    { ownerKey: 'b', displayName: 'Boris', share: 0.4 }
                ]
            }] }
        };

        await apply._applyReparcellizationProposal('joint-plan', data, {});

        expect(apply.added).toHaveLength(1);
        expect(apply.added[0].properties.ownershipDetails).toMatchObject({
            jointPool: true,
            owners: [
                { ownerKey: 'a', name: 'Ana', percentageShare: 60 },
                { ownerKey: 'b', name: 'Boris', percentageShare: 40 }
            ]
        });
    });

    it('records each sole recipient at 100% when server-normalized plot shares are partial', async () => {
        const apply = manager();
        const data = {
            cadastreParcelIds: ['HR-A'],
            reparcellization: { isSingleOwner: false, polygons: [
                {
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[[15.96, 45.80], [15.96035, 45.80], [15.96035, 45.802], [15.96, 45.802], [15.96, 45.80]]]
                    },
                    ownerKey: 'recipient-a', displayName: 'Recipient A', percent: 35,
                    owners: [{ ownerKey: 'recipient-a', displayName: 'Recipient A', share: 1 }]
                },
                {
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[[15.96035, 45.80], [15.961, 45.80], [15.961, 45.802], [15.96035, 45.802], [15.96035, 45.80]]]
                    },
                    ownerKey: 'recipient-b', displayName: 'Recipient B', percent: 65,
                    owners: [{ ownerKey: 'recipient-b', displayName: 'Recipient B', share: 1 }]
                }
            ] }
        };

        await apply._applyReparcellizationProposal('single-plan', data, {});

        expect(apply.added).toHaveLength(2);
        expect(apply.added.map(feature => feature.properties.ownershipDetails.owners)).toMatchObject([
            [{ name: 'Recipient A', ownerLabel: 'Recipient A', percentageShare: 100, actualShareText: '100%' }],
            [{ name: 'Recipient B', ownerLabel: 'Recipient B', percentageShare: 100, actualShareText: '100%' }]
        ]);
    });

    it('rejects placeholder and contradictory ownerless rows before map or ownership mutation', async () => {
        const malformedPlans = [
            { ownerKey: 'stable-owner-key', displayName: 'Unassigned', percent: 100, owners: [
                { ownerKey: 'stable-owner-key', displayName: 'Unassigned', share: 1 }
            ] },
            { ownerKey: 'open-ground', displayName: 'Open ground', percent: 100, owners: [
                { ownerKey: 'recipient', displayName: 'Recipient', share: 1 }
            ] }
        ];

        for (const [index, polygon] of malformedPlans.entries()) {
            const apply = manager();
            const data = { cadastreParcelIds: ['HR-A'], reparcellization: { polygons: [{ geometry: rect(), ...polygon }] } };
            await expect(apply._applyReparcellizationProposal(`invalid-${index}`, data, {})).rejects.toThrow();
            expect(apply.added).toHaveLength(0);
            expect(globalThis.transferParcelOwnership.calls).toHaveLength(0);
        }
    });
});
