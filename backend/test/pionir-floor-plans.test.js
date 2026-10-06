// Verify the published corpus and plan-only import against the canonical archive.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { attachBuildingFloorPlans } from '../proposals/building-floor-plans.js';

const read = name => JSON.parse(readFileSync(new URL(`../../rekonstrukcije/pionir-paron/borongajska-caviceva/${name}`, import.meta.url)));
const manifest = read('floor-plan-sources.json');
const proposal = read('proposal.geojson');
const buildings = proposal.features.filter(f => f.properties['consensus:role'] === 'building');
const source = buildings.filter(f => f.properties.floorPlans);
const require = createRequire(import.meta.url);
const { validateFloorPlans, buildFloorPlanGeometry, buildingSourceId } = require('../../frontend/js/building-floor-plans.js');

const archive = slug => JSON.parse(readFileSync(new URL(`../../rekonstrukcije/pionir-paron/${slug}/proposal.geojson`, import.meta.url)));
const crossProject = [
    ['spansko-sjever-a-f', ['F']],
    ['savica-f1-f3', ['F3']],
    ['lovinciceva-4090-1', ['C1']],
];

describe('Borongaj floor-plan archive', () => {
    it('retains 54 sourced floors, differing layouts and 648 apartment references', () => {
        expect(source.map(b => b.properties.name)).toEqual(['A1', 'B1', 'B2', 'B3', 'B4', 'C1']);
        let apartmentCount = 0;
        for (const building of source) {
            const plans = building.properties.floorPlans;
            const evidence = manifest.buildings.find(b => b.id === building.properties.name);
            expect(validateFloorPlans(plans)).toEqual([]);
            expect(plans.floors.map(f => f.level)).toEqual([0,1,2,3,4,5,6,7,8]);
            expect(plans.layouts.length).toBeGreaterThan(1);
            expect(plans.layouts.length).toBeLessThan(plans.floors.length);
            expect(plans.registration.accuracy).toBe('approximate');
            expect(plans.registration.permitFeatureId).toBe(building.properties.sourceFeatureId);
            expect(plans.registration.northInDrawing).toBe(building.properties.name === 'B3' ? 'right' : 'up');
            for (const floor of plans.floors) {
                expect(floor.source).toEqual(evidence.floors.find(f => f.level === floor.level).source);
                expect(floor.source.sha256).toMatch(/^[a-f0-9]{64}$/);
                expect(floor.source.url).toMatch(/^https:\/\/pionir.hr\//);
                expect(floor.elevationM).toBe(building.properties.name === 'A1' ? (floor.level === 0 ? 0 : floor.level * 3 + 0.7) : floor.level * 3);
                expect(floor.elevationBasis).toBe('estimated');
                apartmentCount += floor.apartments.length;
            }
            for (const layout of plans.layouts) {
                expect(layout.sourceVectorSha256).toMatch(/^[a-f0-9]{64}$/);
                expect(layout.segments).toBeUndefined();
                expect(layout.architecture.walls.length).toBeGreaterThanOrEqual(building.properties.name === 'A1' ? 8 : 11);
                expect(layout.architecture.openings.length).toBeGreaterThan(10);
                expect(layout.architecture.stairs.length).toBeGreaterThanOrEqual(building.properties.name === 'A1' ? 2 : (layout.id.endsWith('-1') ? 2 : 4));
                expect(layout.architecture.slabs.some(polygon => polygon.length > 1)).toBe(true);
                expect(layout.architecture.inference.verticalDimensions).toBe('estimated');
            }
            const rendered = buildFloorPlanGeometry(building, (lng, lat) => [lng, lat]);
            expect(rendered).toHaveLength(9);
            for (const floor of rendered) {
                expect(floor.parts.length).toBeGreaterThan(100);
                const kinds = new Set(floor.parts.map(p => p.kind));
                for (const kind of ['wall','slab','frame','glass','door','stair']) expect(kinds.has(kind)).toBe(true);
                if (building.properties.name !== 'A1') expect(kinds.has('railing')).toBe(true);
                expect(floor.elevationM).toBe(building.properties.name === 'A1' ? (floor.level === 0 ? 0 : floor.level * 3 + 0.7) : floor.level * 3);
                expect(floor.parts.every(p => Number.isFinite(p.baseM) && p.heightM > 0)).toBe(true);
            }
        }
        expect(apartmentCount).toBe(648);
        expect(buildings.filter(f => !f.properties.floorPlans).map(f => f.properties.name)).toEqual(['A2','C2','C3']);
    });

    it('rejects moved, absent or ambiguous building identities before importing', () => {
        const moved = structuredClone(source[0]);
        moved.geometry.coordinates[0][0][0] += 0.001;
        expect(() => attachBuildingFloorPlans(buildings, [moved])).toThrow(/Footprint changed/);
        const unknown = structuredClone(source[0]);
        unknown.properties.sourceFeatureId = 'unknown-feature';
        expect(() => attachBuildingFloorPlans(buildings, [unknown])).toThrow(/found 0/);
        expect(() => attachBuildingFloorPlans([...buildings, source[0]], source)).toThrow(/found 2/);
    });

    it('adds only floorPlans, owns its copy, and treats reordered JSONB keys as a no-op', () => {
        const targets = structuredClone(buildings);
        for (const b of targets) delete b.properties.floorPlans;
        const before = structuredClone(targets);
        const patch = attachBuildingFloorPlans(targets, source);
        expect(patch.changed).toBe(6);
        expect(patch.floors).toBe(54);
        expect(targets).toEqual(before);
        const stripped = structuredClone(patch.buildings);
        for (const b of stripped) delete b.properties.floorPlans;
        expect(stripped).toEqual(before);
        const stored = JSON.parse(JSON.stringify(patch.buildings));
        for (const b of stored.filter(b => b.properties.floorPlans)) {
            b.properties.floorPlans = Object.fromEntries(Object.entries(b.properties.floorPlans).reverse());
        }
        expect(attachBuildingFloorPlans(stored, source).changed).toBe(0);
        const imported = patch.buildings.find(b => b.properties.floorPlans);
        imported.properties.floorPlans.layouts[0].architecture.walls[0][0][0][0] = 99;
        expect(source[0].properties.floorPlans.layouts[0].architecture.walls[0][0][0][0]).not.toBe(99);
    });
});

describe('canonical cross-project floor-plan corpus', () => {
    it('has the expected owners, floor levels, source identity and validation', () => {
        const expected = {
            'spansko-sjever-a-f': { F: [1, 7, 8] },
            'savica-f1-f3': { F3: [-1, 0, 1, 2, 3, 4, 5, 6, 7] },
            'lovinciceva-4090-1': { C1: [-1] },
        };
        let total = 54;
        const owners = [];
        for (const [slug, names] of crossProject) {
            const d = archive(slug);
            for (const name of names) {
                const b = d.features.find(f => f.properties.name === name && f.properties.floorPlans);
                expect(b).toBeTruthy();
                const plans = b.properties.floorPlans;
                expect(validateFloorPlans(plans)).toEqual([]);
                expect(plans.floors.map(f => f.level)).toEqual(expected[slug][name]);
                expect(buildingSourceId(b)).toBeTruthy();
                expect(plans.floors.every(f => f.source?.url && /^https:\/\//.test(f.source.url) && /^[a-f0-9]{64}$/.test(f.source.sha256))).toBe(true);
                expect(plans.floors.every(f => Number.isFinite(f.elevationM))).toBe(true);
                total += plans.floors.length;
                owners.push(`${slug}:${name}`);
            }
        }
        expect(total).toBe(67);
        expect(owners).toEqual(['spansko-sjever-a-f:F', 'savica-f1-f3:F3', 'lovinciceva-4090-1:C1']);
    });

    it('keeps shared basement ownership unique and preserves source structures', () => {
        const savicaFeatures = archive('savica-f1-f3').features;
        expect(savicaFeatures.filter(f => f.properties.floorPlans?.floors.some(floor => floor.level === -1))).toHaveLength(1);
        const savica = savicaFeatures.find(f => f.properties.name === 'F3').properties.floorPlans;
        expect(savica.floors.filter(f => f.level === -1)).toHaveLength(1);
        const top = savica.floors.find(f => f.level === 7);
        const lower = savica.floors.find(f => f.level === 6);
        const byId = new Map(savica.layouts.map(l => [l.id, l]));
        const topLayout = byId.get(top.layoutId).architecture;
        const lowerLayout = byId.get(lower.layoutId).architecture;
        expect(topLayout.railings?.length || 0).toBeGreaterThan(0);
        expect(topLayout.walls.length).toBeLessThan(lowerLayout.walls.length);
        const lov = archive('lovinciceva-4090-1').features.find(f => f.properties.name === 'C1').properties.floorPlans;
        expect(lov.floors).toHaveLength(1);
        expect(lov.floors[0].level).toBe(-1);
        const lovLayout = lov.layouts.find(l => l.id === lov.floors[0].layoutId).architecture;
        expect(lovLayout.stairs || []).toHaveLength(0);
        expect(lovLayout.openings.filter(opening => opening.kind === 'window' || opening.kind === 'glazedDoor')).toHaveLength(0);
    });
});
