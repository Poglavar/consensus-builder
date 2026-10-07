// Exercise optional model lookup, immutable versioning, and safe archive attachment.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
import request from 'supertest';
import { createRouteApp } from './helpers/create-route-app.js';
import { setupBuildingFloorModelsRoute } from '../routes/building-floor-models.js';
import { stripLocalProposalState } from '../proposals/serializer.js';
import {
    canonicalJson, fingerprint, prepareFloorModel, saveFloorModel, buildingSourceId,
    fetchFloorModels, attachProposalFloorModels, attachNearbyFloorModels, nativeFloorModelSource
} from '../buildings/floor-models.js';
import { importFloorModels, parseArgs } from '../scripts/import-building-floor-plans.mjs';

const footprint = (x = 15) => ({ type: 'Polygon', coordinates: [[[x, 45], [x + .001, 45], [x + .001, 45.001], [x, 45],]] });
const plans = () => ({ schema: 'consensus-builder.building-floor-plans.v2', registration: { basis: 'corners', corners: [[15,45],[15.001,45],[15.001,45.001],[15,45.001]] }, layouts: [{ id: 'a', source: { url: 'https://example.test/scan.jpg', page: 2, crop: [0, 0, 10, 8], sha256: 'fixture-sha256' }, architecture: { schema: 'consensus-builder.floor-architecture.v1', dimensionsM: [10,8], wallHeightM: 2.8, slabThicknessM: .2, walls: [[[[0,0],[1,0],[1,.1],[0,.1]]]], slabs: [[[[0,0],[1,0],[1,1],[0,1]]]], landings: [], openings: [], stairs: [], railings: [] } }], floors: [{ id: 'f1', level: 1, elevationM: 0, elevationBasis: 'documented', layoutId: 'a', apartments: [] }] });
const model = (extra = {}) => ({ city: 'city_a', source: 'survey-3d', buildingId: 'b1', footprint: footprint(), floorPlans: plans(), ...extra });

function dbClient(rows = [], readback = null) {
    const calls = [];
    return { calls, async query(sql, params) {
        calls.push({ sql, params });
        if (sql.startsWith('SELECT version')) return { rows };
        if (sql.startsWith('SELECT footprint')) return { rows: readback ? [readback] : [] };
        return { rows: [] };
    } };
}

describe('building floor model registry', () => {
    it('keeps city, source, and proposal ownership in distinct identities', () => {
        expect(prepareFloorModel(model())).toMatchObject({ ownerId: '' });
        expect(prepareFloorModel(model({ source: 'proposal', ownerId: 'proposal-1' }))).toMatchObject({ ownerId: 'proposal-1' });
        expect(() => prepareFloorModel(model({ source: 'proposal' }))).toThrow(/ownerId/);
        expect(() => prepareFloorModel(model({ source: 'survey-3d', ownerId: 'proposal-1' }))).toThrow(/ownerId/);
        expect(canonicalJson(['city_a', 'proposal', 'p', 'b']) ).not.toBe(canonicalJson(['city_a', 'survey-3d', '', 'b']));
    });

    it('refuses to store a suggested default layout as evidence', () => {
        const require = createRequire(import.meta.url);
        const generator = require('../../frontend/js/default-floor-plans.js');
        const footprintWgs = turf.polygon([[[16, 45.8], [16.00026, 45.8], [16.00026, 45.80011], [16, 45.80011], [16, 45.8]]]);
        const suggested = generator.planDefaultFloorPlans({ footprint: footprintWgs, floors: 3, storeyHeightM: 3 }, { turf }).floorPlans;
        expect(suggested.suggested).toBe(true);
        expect(() => prepareFloorModel(model({ footprint: footprintWgs.geometry, floorPlans: suggested }))).toThrow(/Suggested layouts are generated for display/);
        // The same solids without the flag are rejected earlier, by the shared validator.
        expect(() => prepareFloorModel(model({ footprint: footprintWgs.geometry, floorPlans: { ...suggested, suggested: false } }))).toThrow(/floorPlans.suggested = true/);
    });

    it('cannot attach a same-numbered building from another city, survey, proposal, or custom feed', async () => {
        const row = { city: 'city_a', source: 'survey-3d', owner_id: '', building_id: 'b1', version: 1, floor_plans: plans() };
        const pool = { query: async () => ({ rows: [row] }) };
        for (const [city, source] of [['city_b', 'survey-3d'], ['city_a', 'another-survey']]) {
            const [building] = await attachNearbyFloorModels(pool, city, source, [{ object_id: 'b1' }]);
            expect(building).toEqual({ object_id: 'b1' });
        }
        const proposal = { city: 'city_a', proposalId: 'p1', geometry: { buildings: [
            { properties: { sourceFeatureId: 'b1' }, geometry: footprint() }
        ] } };
        await attachProposalFloorModels(pool, [proposal]);
        expect(proposal.geometry.buildings[0].properties.floorPlans).toBeUndefined();
        expect(nativeFloorModelSource('building.feed-a', 'custom-3d'))
            .not.toBe(nativeFloorModelSource('building.feed-b', 'custom-3d'));
        expect(nativeFloorModelSource(undefined, 'survey-3d')).toBe('survey-3d');
    });

    it('uses provider-prefixed DGU and ISPU identities in proposal registry queries', async () => {
        const seen = [];
        const pool = { query: async (sql, params) => { seen.push({ sql, params }); return { rows: [] }; } };
        const proposal = { city: 'city_a', proposalId: 'p1', geometry: { buildings: [
            { geometry: footprint(), properties: { dguBuildingId: 123 } },
            { geometry: footprint(16), properties: { sourceLayerId: 123 } }
        ] } };
        await attachProposalFloorModels(pool, [proposal]);
        const keys = JSON.parse(seen[0].params[0]);
        expect(keys.map(k => k.building_id)).toEqual(['dgu-building:123', 'source-layer:123']);
        expect(buildingSourceId({ properties: { dguBuildingId: 123 } })).toBe('dgu-building:123');
        expect(buildingSourceId({ properties: { sourceLayerId: 123 } })).toBe('source-layer:123');
    });

    it('returns matched and absent rows without conflating nearby buildings', async () => {
        const identity = model();
        const row = { city: 'city_a', source: 'survey-3d', owner_id: '', building_id: 'b1', version: 2, floor_plans: plans() };
        const pool = { query: async () => ({ rows: [row] }) };
        const found = await fetchFloorModels(pool, [identity]);
        expect(found.size).toBe(1);
        const buildings = await attachNearbyFloorModels(pool, 'city_a', 'survey-3d', [{ object_id: 'b1' }, { object_id: 'missing' }]);
        expect(buildings[0].floorModel).toMatchObject({ buildingId: 'b1', version: 2 });
        expect(buildings[1].floorPlans).toBeUndefined();
    });

    it('attaches proposal models only when the registered footprint still matches', async () => {
        const proposal = { city: 'city_a', proposalId: 'p1', geometry: { buildings: [{ geometry: footprint(), properties: { sourceFeatureId: 'b1' } }, { geometry: footprint(16), properties: { sourceFeatureId: 'b2' } }] } };
        const row = { city: 'city_a', source: 'proposal', owner_id: 'p1', building_id: 'b1', version: 1, geom_hash: fingerprint(footprint()), floor_plans: plans() };
        await attachProposalFloorModels({ query: async () => ({ rows: [row] }) }, [proposal]);
        expect(proposal.geometry.buildings[0].properties.floorPlans).toEqual(plans());
        expect(proposal.geometry.buildings[1].properties.floorPlans).toBeUndefined();
        proposal.geometry.buildings[0].geometry = footprint(17);
        delete proposal.geometry.buildings[0].properties.floorPlans;
        await attachProposalFloorModels({ query: async () => ({ rows: [row] }) }, [proposal]);
        expect(proposal.geometry.buildings[0].properties.floorPlans).toBeUndefined();
    });

    it('accepts non-PDF sources with optional page and crop metadata', () => {
        const record = model();
        delete record.floorPlans.layouts[0].source.page;
        delete record.floorPlans.layouts[0].source.crop;
        expect(prepareFloorModel(record).floorPlans.layouts[0].source).toEqual({ url: 'https://example.test/scan.jpg', sha256: 'fixture-sha256' });
    });

    it('uses canonical JSON hashes so reordered JSONB keys are a no-op', async () => {
        const first = prepareFloorModel(model());
        const reordered = structuredClone(model());
        reordered.floorPlans.layouts[0].source = { crop: [0,0,10,8], page: 2, sha256: 'fixture-sha256', url: 'https://example.test/scan.jpg' };
        const active = { version: 4, current: true, geom_hash: first.geomHash, model_hash: fingerprint(reordered.floorPlans) };
        const client = dbClient([active]);
        const saved = await saveFloorModel(client, reordered);
        expect(saved).toMatchObject({ changed: false, version: 4 });
        expect(client.calls.filter(c => c.sql.startsWith('INSERT'))).toHaveLength(0);
    });

    it('versions changed models, retains history, and validates production readback', async () => {
        const next = prepareFloorModel(model({ floorPlans: { ...plans(), floors: [{ id: 'f2', level: 2, elevationM: 3, elevationBasis: 'documented', layoutId: 'a', apartments: [] }] } }));
        const client = dbClient([{ version: 2, current: true, geom_hash: 'old', model_hash: 'old' }], { footprint: next.footprint, floor_plans: next.floorPlans });
        const saved = await saveFloorModel(client, next, { apply: true });
        expect(saved).toMatchObject({ changed: true, version: 3 });
        expect(client.calls.some(c => c.sql.startsWith('UPDATE'))).toBe(true);
        expect(client.calls.some(c => c.sql.startsWith('INSERT'))).toBe(true);
        expect(client.calls.some(c => c.sql.startsWith('SELECT footprint'))).toBe(true);
        const inserted = client.calls.find(c => c.sql.startsWith('INSERT'));
        expect(inserted.params.slice(0, 5)).toEqual(['city_a', 'survey-3d', '', 'b1', 3]);
        expect(JSON.parse(inserted.params[8])).toEqual(next.floorPlans);
        expect(client.calls.some(c => /DELETE|TRUNCATE/.test(c.sql))).toBe(false);
        const brokenReadback = dbClient([], { footprint: next.footprint, floor_plans: plans() });
        await expect(saveFloorModel(brokenReadback, next, { apply: true })).rejects.toThrow(/read-back failed/);
    });

    it('imports registry models without touching proposal inline fields and protects production apply', async () => {
        expect(() => parseArgs(['--models', 'x', '--target', 'production', '--apply'])).toThrow(/confirm-production/);
        const client = dbClient([]);
        const result = await importFloorModels(client, { models: 'x', apply: false, target: 'local' }, { schema: 'consensus-builder.building-floor-model-registry.v1', models: [model()] });
        expect(result).toMatchObject({ buildings: 1, apply: false, removedInlineCopies: false });
        expect(client.calls.some(c => /UPDATE\s+(consensus\.)?proposal\s/.test(c.sql))).toBe(false);
    });

    it('removes only the transferred inline copies and leaves proposal geometry and authored metadata intact', async () => {
        const source = { type: 'Feature', geometry: footprint(), properties: {
            'consensus:role': 'building', sourceFeatureId: 'b1', floorPlans: plans()
        } };
        const original = structuredClone(source);
        original.properties.note = 'authored note';
        const stored = { id: 9, city: 'city_a', proposal_data: { geometry: { buildings: [original] }, offer: 123 } };
        let update;
        const client = { async query(sql, params) {
            if (sql.startsWith('SELECT id, city')) return { rows: [stored] };
            if (sql.startsWith('SELECT footprint')) return { rows: [{ footprint: source.geometry, floor_plans: plans() }] };
            if (sql.startsWith('UPDATE proposal')) update = params;
            return { rows: [] };
        } };
        const archive = { reconstruction: { schema: 'consensus-builder.reconstruction.v1', proposal: { city: 'city_a', proposalId: 'p1' } }, features: [source] };
        const result = await importFloorModels(client, { archive: 'fixture', apply: true }, archive);
        expect(result).toMatchObject({ buildings: 1, floors: 1, removedInlineCopies: true });
        const [cleaned] = JSON.parse(update[1]);
        expect(update[0]).toBe(9);
        expect(cleaned.geometry).toEqual(original.geometry);
        expect(cleaned.properties).toEqual({ 'consensus:role': 'building', sourceFeatureId: 'b1', note: 'authored note' });
        expect(original.properties.floorPlans).toEqual(plans());
        source.geometry = footprint(16);
        await expect(importFloorModels(client, { archive: 'fixture', apply: true }, archive)).rejects.toThrow(/Footprint changed/);
    });

    it('does not persist API-enriched models when publishing a proposal again', () => {
        const record = { geometry: { buildings: [{ geometry: footprint(), properties: {
            sourceFeatureId: 'b1', floorPlans: plans(), floorModel: { version: 1 }, height: 12
        } }] } };
        const saved = stripLocalProposalState(record);
        expect(saved.geometry.buildings[0].properties).toEqual({ sourceFeatureId: 'b1', height: 12 });
        expect(record.geometry.buildings[0].properties.floorPlans).toEqual(plans());
    });

    it('serves a registered model through the public API and treats missing evidence as normal', async () => {
        let rows = [{ city: 'city_a', source: 'survey-3d', owner_id: '', building_id: 'b1', version: 2, floor_plans: plans() }];
        const app = createRouteApp(setupBuildingFloorModelsRoute, { query: async () => ({ rows }) });
        const url = '/buildings/floor-model?city=city_a&source=survey-3d&buildingId=b1';
        const found = await request(app).get(url);
        expect(found.status).toBe(200);
        expect(found.body.model).toMatchObject({ buildingId: 'b1', version: 2, floorPlans: plans() });
        rows = [];
        const absent = await request(app).get(url);
        expect(absent.status).toBe(200);
        expect(absent.body).toEqual({ model: null });
        expect((await request(app).get('/buildings/floor-model?source=proposal')).status).toBe(400);
    });
});
