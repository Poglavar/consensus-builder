// The authored-record boundary has one land declaration: explicit cadastral IDs. Parcel IDs are
// opaque runtime identities; generated output is never interpreted as an ancestry tree.

import { beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let records;

beforeAll(() => {
    records = require('../../frontend/js/proposals/formation-depth.js');
});

const BASE = 'HR-335550-1791/25';
const OTHER = 'HR-335550-1804/1';

describe('proposal role reporting', () => {
    it('reports authored intent without observing materialized output', () => {
        expect(records.roleOf({ goal: 'single', childParcelIds: ['opaque-output'] }))
            .toBe('potential-formation');
        expect(records.roleOf({ goal: 'road-track' })).toBe('potential-formation');
        expect(records.roleOf({ goal: 'urban-rule' })).toBe('content');
    });

    it('can report a completed materialization only from explicit runtime context', () => {
        expect(records.conformanceOf({ goal: 'park', cadastreParcelIds: [BASE] }, { mintsGround: true }).role)
            .toBe('formation');
    });
});

describe('explicit cadastral conformance', () => {
    it('accepts one authoritative flat declaration', () => {
        const verdict = records.conformanceOf({ goal: 'road-track', cadastreParcelIds: [BASE] });
        expect(verdict.flat).toBe(true);
        expect(verdict.cadastreParcelIds).toEqual([BASE]);
        expect(verdict.role).toBe('potential-formation');
    });

    it('rejects a record whose only land field is a retired alias', () => {
        const verdict = records.conformanceOf({ parentParcelIds: [BASE] });
        expect(verdict.flat).toBe(false);
        expect(verdict.violations.map(item => item.code)).toEqual(expect.arrayContaining([
            'missing-cadastral-provenance',
            'legacy-cadastral-declaration'
        ]));
    });

    it('rejects every alias even when it duplicates the authoritative declaration', () => {
        const verdict = records.conformanceOf({
            cadastreParcelIds: [BASE],
            parentParcelIds: [BASE],
            structureProposal: { parentParcelIds: [BASE] }
        });
        expect(verdict.flat).toBe(false);
        expect(verdict.violations).toEqual(expect.arrayContaining([
            { code: 'legacy-cadastral-declaration', field: 'parentParcelIds' },
            { code: 'legacy-cadastral-declaration', field: 'structureProposal.parentParcelIds' }
        ]));
    });

    it('rejects generated live-piece IDs in the authoritative field', () => {
        const verdict = records.conformanceOf({ cadastreParcelIds: [`${BASE}#piece-1`] });
        expect(verdict.flat).toBe(false);
        expect(verdict.violations).toContainEqual(expect.objectContaining({
            code: 'generated-cadastral-anchor',
            field: 'cadastreParcelIds[0]'
        }));
        expect(records.parcelIdDepth).toBeUndefined();
        expect(records.isBaseParcelId).toBeUndefined();
    });
});

describe('publish projection', () => {
    it('keeps the canonical declaration and emits no compatibility copies', () => {
        const gate = records.preparePublishRecord({
            goal: 'reparcellization',
            cadastreParcelIds: [BASE, OTHER, BASE],
            reparcellization: { polygons: [] }
        });

        expect(gate.verdict.flat).toBe(true);
        expect(gate.proposal.cadastreParcelIds).toEqual([BASE, OTHER]);
        expect(gate.proposal).not.toHaveProperty('parentParcelIds');
        expect(gate.proposal).not.toHaveProperty('parcelIds');
        expect(gate.proposal.reparcellization).not.toHaveProperty('parentParcelIds');
        expect(gate.proposal.reparcellization).not.toHaveProperty('parcelIds');
    });

    it('never invents cadastral ground from geometry or aliases', () => {
        const gate = records.preparePublishRecord({ parentParcelIds: ['opaque-live-id'] }, {
            geometricBaseIds: [BASE]
        });
        expect(gate.verdict.flat).toBe(false);
        expect(gate.verdict.violations.map(item => item.code)).toEqual(expect.arrayContaining([
            'missing-cadastral-provenance',
            'legacy-cadastral-declaration',
            'geometric-parent-resolution-required'
        ]));
        expect(gate.proposal).not.toHaveProperty('parentParcelIds');
        expect(gate.proposal).not.toHaveProperty('cadastreParcelIds');
    });

    it('summarises missing, legacy and generated declarations', () => {
        const scan = records.scanRecords([
            { proposalId: 'ok', cadastreParcelIds: [BASE] },
            { proposalId: 'missing', parentParcelIds: [BASE] },
            { proposalId: 'generated', cadastreParcelIds: [`${OTHER}#piece`] }
        ]);
        expect(scan.total).toBe(3);
        expect(scan.offending).toBe(2);
        expect(scan.byCode['missing-cadastral-provenance']).toBe(1);
        expect(scan.byCode['legacy-cadastral-declaration']).toBe(1);
        expect(scan.byCode['generated-cadastral-anchor']).toBe(1);
    });
});

describe('stripDerivedRecordData', () => {
    it('strips materialization, formation receipts, aliases and scans without mutating authored content', () => {
        const record = {
            proposalId: 'c-x', goal: 'park',
            cadastreParcelIds: ['HR-1', 'HR-2'],
            parentParcelIds: ['HR-1', 'HR-2'],
            childParcelIds: ['opaque-child'],
            descendantParcelIds: ['opaque-child'],
            localEditAt: '2026-08-06T13:30:00.000Z',
            ownerAcceptances: { 'HR-1': { accepted: true } },
            structureProposal: {
                kind: 'park', geometry: { type: 'Polygon', coordinates: [] },
                parentParcelIds: ['HR-1'],
                formation: { mode: 'merge', parcelIds: ['HR-1'], childParcelIds: ['opaque-child'] },
                demolishedBuildings: [{ id: 1 }], demolitionScanned: true
            },
            roadProposal: {
                definition: {
                    width: 10, points: [],
                    surfaceFootprint: { type: 'Polygon', coordinates: [] },
                    demolishedBuildings: [{ id: 2 }]
                },
                parentParcelIds: ['HR-2'], childParcelIds: ['opaque-road'], childFeatures: [{}],
                parentsToRemove: ['HR-2']
            }
        };
        const out = records.stripDerivedRecordData(record);
        expect(out.childParcelIds).toBeUndefined();
        expect(out.descendantParcelIds).toBeUndefined();
        expect(out.localEditAt).toBeUndefined();
        expect(out.structureProposal.formation).toBeUndefined();
        expect(out.structureProposal.demolishedBuildings).toBeUndefined();
        expect(out.roadProposal.childParcelIds).toBeUndefined();
        expect(out.roadProposal.childFeatures).toBeUndefined();
        expect(out.roadProposal.parentsToRemove).toBeUndefined();
        expect(out.roadProposal.definition.surfaceFootprint).toBeUndefined();
        expect(out.cadastreParcelIds).toEqual(['HR-1', 'HR-2']);
        expect(out).not.toHaveProperty('parentParcelIds');
        expect(out.structureProposal).not.toHaveProperty('parentParcelIds');
        expect(out.ownerAcceptances).toEqual({ 'HR-1': { accepted: true } });
        expect(record.childParcelIds).toEqual(['opaque-child']);
        expect(record.structureProposal.formation).toBeTruthy();
    });

    it('removes government-plan child pieces; authored geometry belongs in definition.features', () => {
        const out = records.stripDerivedRecordData({
            cadastreParcelIds: [BASE],
            childFeatures: [{ id: 'root-output' }],
            roadProposal: {
                definition: {
                    kind: 'government_plan',
                    features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] } }]
                },
                childFeatures: [{ id: 'runtime-output' }]
            }
        });
        expect(out).not.toHaveProperty('childFeatures');
        expect(out.roadProposal).not.toHaveProperty('childFeatures');
        expect(out.roadProposal.definition.features).toHaveLength(1);
    });

    it('keeps authored building geometry but removes browser-fabric annotations and mirrors', () => {
        const feature = {
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [] },
            properties: {
                height: 15,
                color: '#fff',
                parcelId: 'HR-1#piece',
                proposalId: 'p-1',
                proposalState: 'applied',
                parentParcelIds: ['HR-1'],
                buildingIndex: 4
            }
        };
        const out = records.stripDerivedRecordData({
            proposalId: 'p-1',
            cadastreParcelIds: ['HR-1'],
            similarityHash: 'HR-1',
            geometry: { buildings: [feature] },
            buildingGeometry: feature.geometry,
            buildingProperties: feature.properties,
            properties: feature.properties,
            buildingProposal: {
                buildingFeature: feature,
                buildings: [feature],
                parentParcelNumbers: [{ id: 'HR-1#piece', number: '1' }],
                ancestorKey: 'HR-1#piece'
            }
        });

        expect(out.geometry.buildings).toEqual([{
            type: 'Feature',
            geometry: feature.geometry,
            properties: { height: 15, color: '#fff' }
        }]);
        expect(out).not.toHaveProperty('buildingGeometry');
        expect(out).not.toHaveProperty('buildingProperties');
        expect(out).not.toHaveProperty('properties');
        expect(out).not.toHaveProperty('similarityHash');
        expect(out.buildingProposal).not.toHaveProperty('buildingFeature');
        expect(out.buildingProposal).not.toHaveProperty('buildings');
        expect(out.buildingProposal).not.toHaveProperty('parentParcelNumbers');
        expect(out.buildingProposal).not.toHaveProperty('ancestorKey');
    });
});
