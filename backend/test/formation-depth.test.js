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

describe('design body parcels', () => {
    it('distinguishes the park body from leftovers carrying the same producer', () => {
        const park = { goal: 'park', structureProposal: { kind: 'park' } };
        expect(records.isBodyParcel(park, { properties: { structureType: 'park' } })).toBe(true);
        expect(records.isBodyParcel(park, { properties: { producedByProposalId: 'park' } })).toBe(false);
    });
    it('keeps multiple authored layout plots while excluding layout remainders', () => {
        const layout = { goal: 'parcel-layout' };
        expect(records.isBodyParcel(layout, { properties: { readjustmentPiece: { role: 'plot' } } })).toBe(true);
        expect(records.isBodyParcel(layout, { properties: { structureType: 'park', readjustmentPiece: { role: 'remainder' } } })).toBe(false);
        expect(records.isBodyParcel({ goal: 'single' }, { properties: { buildingParcel: true } })).toBe(true);
        expect(records.isBodyParcel({ goal: 'road-track' }, { properties: { isCorridor: true } })).toBe(true);
    });
});

describe('the authored road is its record (roads.md §11)', () => {
    const A = { lat: 45.8001, lng: 15.9701 };
    const B = { lat: 45.8004, lng: 15.9712 };
    const P = require('../../frontend/js/corridor-profile.js');
    const osmForm = require('../../frontend/js/corridor-osm-form.js');
    const profile = { strips: P.CORRIDOR_PROFILE_PRESETS[10].map(lane => ({ ...lane })) };

    it('keeps the stretch fields in memory and encodes the OSM document only at the publish boundary', () => {
        const authored = {
            goal: 'road-track', cadastreParcelIds: [BASE], applied: true,
            roadProposal: { definition: { points: [[A, B]], segments: [[A, B]], profile, width: 10, tunnels: [], metadata: { isRoad: true }, polygon: { type: 'Polygon', coordinates: [] }, surfaceFootprint: {}, demolishedBuildings: [] } }
        };
        // the in-memory projection (draft build, import, store entry): the view, minus derived data
        const view = records.stripDerivedRecordData(authored).roadProposal.definition;
        expect(view.points).toEqual([[A, B]]);
        expect(view.osm).toBeUndefined();
        expect(view.surfaceFootprint).toBeUndefined();
        expect(view.demolishedBuildings).toBeUndefined();
        // the stored shape: the OSM document and nothing else about the stretches
        const record = records.encodeRoadRecord(records.stripDerivedRecordData(authored)).roadProposal.definition;
        osmForm.VIEW_FIELDS.forEach(field => expect(record[field], field).toBeUndefined());
        expect(record.osm.elements.filter(element => element.type === 'way')).toHaveLength(1);
        expect(record).toMatchObject({ tunnels: [], metadata: { isRoad: true }, polygon: { type: 'Polygon' } });
        expect(records.decodeRoadView({ roadProposal: { definition: record } }).roadProposal.definition.points).toEqual([[A, B]]);
        // the publish body carries the record
        const published = records.preparePublishRecord(authored).proposal.roadProposal.definition;
        expect(published.osm).toBeTruthy();
        expect(published.points).toBeUndefined();
        // a record handed to the projection is left as it is (it is decoded on load, not here)
        expect(records.stripDerivedRecordData({ roadProposal: { definition: record } }).roadProposal.definition).toEqual(record);
    });

    it('leaves a designation (land, no centre line) as it is', () => {
        const designation = { kind: 'road', polygon: { type: 'Polygon', coordinates: [] }, width: 12 };
        expect(records.stripDerivedRecordData({ goal: 'road-track', cadastreParcelIds: [BASE], roadProposal: { definition: designation } }).roadProposal.definition).toEqual(designation);
    });
});

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
    it('projects a portable record without the local application state, and leaves the record alone', () => {
        const record = { goal: 'as-is', cadastreParcelIds: [BASE], applied: true, appliedAt: '2026-10-01T00:00:00.000Z',
            approvalConfig: { schema: 'proposal-approval/v1' } };
        const before = structuredClone(record);
        const gate = records.preparePublishRecord(record);
        expect(gate.verdict.flat).toBe(true);
        expect(gate.proposal).not.toHaveProperty('applied');
        expect(gate.proposal).not.toHaveProperty('appliedAt');
        expect(gate.proposal.approvalConfig).toEqual(record.approvalConfig);
        expect(records.stripDerivedRecordData(record)).toMatchObject(record);
        expect(record).toEqual(before);
    });

    it('omits an unverified execution timestamp without mutating the local record or lifecycle', () => {
        const record = { goal: 'park', cadastreParcelIds: [BASE], lifecycleStatus: 'Executed',
            executedAt: '2026-10-01T10:00:00.000Z', createdAt: '2026-09-01T10:00:00.000Z' };
        const before = structuredClone(record);
        const gate = records.preparePublishRecord(record);
        expect(gate.verdict.flat).toBe(true);
        expect(gate.proposal).not.toHaveProperty('executedAt');
        expect(gate.proposal).toMatchObject({ lifecycleStatus: 'Executed', createdAt: record.createdAt });
        expect(record).toEqual(before);
        expect(records.stripDerivedRecordData(record).executedAt).toBe(record.executedAt);
    });

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
        expect(record.childParcelIds).toEqual(['opaque-child']);
        expect(record.structureProposal.formation).toBeTruthy();
    });

    it('keeps apply-time demolition results for the store when asked, stripping everything else as usual', () => {
        const record = {
            proposalId: 'c-y', goal: 'park', cadastreParcelIds: ['HR-1'],
            structureProposal: { kind: 'park', formation: { mode: 'merge' }, demolishedBuildings: [{ id: '1' }], demolitionScanned: true },
            buildingProposal: { typologyType: 'block', childParcelIds: ['opaque'], demolishedBuildings: [{ id: '2' }] },
            roadProposal: { definition: { width: 10, surfaceFootprint: { type: 'Polygon', coordinates: [] }, demolishedBuildings: [{ id: '3' }], demolitionScanned: true }, childFeatures: [{}] }
        };
        const kept = records.stripDerivedRecordData(record, { keepDemolition: true });
        expect(kept.structureProposal.demolishedBuildings).toEqual([{ id: '1' }]);
        expect(kept.structureProposal.demolitionScanned).toBe(true);
        expect(kept.buildingProposal.demolishedBuildings).toEqual([{ id: '2' }]);
        expect(kept.roadProposal.definition.demolishedBuildings).toEqual([{ id: '3' }]);
        expect(kept.roadProposal.definition.demolitionScanned).toBe(true);
        expect(kept.structureProposal.formation).toBeUndefined();
        expect(kept.buildingProposal.childParcelIds).toBeUndefined();
        expect(kept.roadProposal.childFeatures).toBeUndefined();
        expect(kept.roadProposal.definition.surfaceFootprint).toBeUndefined();
        // The authored projections (rows, publish, share) still drop them.
        const authored = records.stripDerivedRecordData(record);
        expect(authored.structureProposal.demolishedBuildings).toBeUndefined();
        expect(authored.buildingProposal.demolishedBuildings).toBeUndefined();
        expect(authored.roadProposal.definition.demolishedBuildings).toBeUndefined();
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

// PARCEL-OPTIONAL.md rule 4: a material proposal may stand with an empty declaration when it has a
// site or a footprint of its own; parcel acts may not.
describe('site-first records', () => {
    const SITE = {
        type: 'MultiPolygon',
        coordinates: [[[[15.97, 45.8], [15.971, 45.8], [15.971, 45.801], [15.97, 45.801], [15.97, 45.8]]]]
    };

    it('accepts a material record with a site and no declaration', () => {
        const verdict = records.conformanceOf({ goal: 'park', site: SITE, cadastreParcelIds: [] });
        expect(verdict.flat).toBe(true);
        expect(verdict.cadastreParcelIds).toEqual([]);
        // ...and one whose site is its own footprint (a road across bare ground).
        expect(records.conformanceOf({ goal: 'park', structureProposal: { kind: 'park', geometry: SITE.coordinates[0] && { type: 'Polygon', coordinates: SITE.coordinates[0] } } }).flat).toBe(true);
    });

    it('refuses only records about nothing: any goal or kind stands on its site', () => {
        // A design is never an act on parcels (plan-design-agreement.md): goal and kind do not matter.
        expect(records.conformanceOf({ goal: 'ownership-transfer', site: SITE, cadastreParcelIds: [] }).flat).toBe(true);
        expect(records.conformanceOf({ goal: 'park', kind: 'owner-vote', site: SITE }).flat).toBe(true);
        const nothing = records.conformanceOf({ goal: 'park', cadastreParcelIds: [] });
        expect(nothing.flat).toBe(false);
        expect(nothing.violations.map(v => v.code)).toContain('missing-cadastral-provenance');
    });

    it('lets the publish gate pass a site record with an empty declaration', () => {
        const gate = records.preparePublishRecord({ goal: 'park', site: SITE, cadastreParcelIds: [], structureProposal: { kind: 'park', geometry: { type: 'Polygon', coordinates: SITE.coordinates[0] } } });
        expect(gate.verdict.flat).toBe(true);
        expect(gate.proposal.site).toEqual(SITE);
        expect(records.preparePublishRecord({ goal: 'parcel-layout', site: SITE, cadastreParcelIds: [] }).verdict.flat).toBe(true);
        const nothing = records.preparePublishRecord({ goal: 'parcel-layout', cadastreParcelIds: [] });
        expect(nothing.verdict.violations.map(v => v.code)).toContain('geometric-parent-resolution-required');
    });
});
