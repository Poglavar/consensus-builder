// Tests for restatements/dup-travno: the transcription of the 1971 sheet's flat table against the sheet's
// own totals, and the designs travno-designs.mjs builds from the committed data (every drawn building in
// exactly one design, the plan's heights, no two designs on one bound parcel or one patch of ground).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as turf from '@turf/turf';
import { AUTHOR, PLAN_DATE, groupByBinding, planBuildings, travnoPlan } from '../../restatements/dup-travno/travno-designs.mjs';
import { planObjects } from '../scripts/lib/restatement-publish.mjs';

const DIR = fileURLToPath(new URL('../../restatements/dup-travno/data/', import.meta.url));
const data = name => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
const claims = data('claims.json').claims;
const bindings = data('bindings.json').buildings;
const plan = travnoPlan();
const residential = claims.filter(claim => claim.kind === 'residential');

describe('the DUP Travno sheet as transcribed', () => {
    it('adds up to the table totals the sheet prints (SVEUK.: 3830 flats, 291 400 m²)', () => {
        const flats = residential.reduce((sum, claim) => sum + Object.values(claim.flats).reduce((a, b) => a + b, 0), 0);
        expect(flats).toBe(3830);
        expect(residential.reduce((sum, claim) => sum + claim.netFlatAreaM2, 0)).toBe(291400);
    });

    it('has the plan\'s fifteen residential blocks and its labelled heights', () => {
        expect(residential.map(claim => claim.block).sort()).toEqual(['1a', '1b', '1c', '1d', '1e', '1f', '1g', '1h', '1i', '2', '3a', '3b', '4', '5', '6']);
        const height = key => claims.find(claim => claim.key === key).heightM;
        expect(['1a', '1e', '1i'].map(height)).toEqual([64, 64, 64]);
        expect(['2', '3a', '3b', '4', '5'].map(height)).toEqual([28, 28, 28, 28, 28]);
        expect(height('6')).toBe(66);
    });
});

describe('travnoPlan', () => {
    const buildingsOf = design => new Set(design.record.geometry.buildings.map(building => building.properties.block));

    it('puts every drawn building in exactly one design, dated and authored by the plan', () => {
        const blocks = plan.designs.flatMap(design => [...buildingsOf(design)]);
        expect(new Set(blocks).size).toBe(blocks.length);
        expect(blocks.length).toBe(claims.length);
        plan.designs.forEach(design => {
            expect(design.record).toMatchObject({ goal: 'single', author: AUTHOR, createdAt: PLAN_DATE, city: 'zagreb' });
            expect(design.record.site).toBeUndefined();
        });
    });

    it('draws the towers at P+20, 64 m, with ground-floor parts at 4 m', () => {
        const tower = plan.designs.flatMap(design => design.record.geometry.buildings).filter(building => building.properties.block === 'DUP Travno 1a');
        expect(tower.length).toBeGreaterThan(0);
        expect(Math.max(...tower.map(building => building.properties.height))).toBe(64);
        expect(tower.filter(building => building.properties.height === 64).every(building => building.properties.levels === 21)).toBe(true);
        expect(tower.filter(building => building.properties.height !== 64).every(building => building.properties.height === 4)).toBe(true);
    });

    it('never lets two designs bind one parcel or cover one patch of ground', () => {
        const groups = groupByBinding(planBuildings(), bindings);
        const parcelsOf = group => new Set(group.flatMap(building => bindings[building.key]));
        const seen = new Map();
        groups.forEach((group, index) => parcelsOf(group).forEach(parcel => {
            expect(seen.get(parcel) ?? index).toBe(index);
            seen.set(parcel, index);
        }));
        const footprints = plan.designs.map(design => design.record.geometry.buildings
            .reduce((merged, building) => (merged ? turf.union(merged, building) : building), null));
        for (let a = 0; a < footprints.length; a++) {
            for (let b = a + 1; b < footprints.length; b++) {
                const overlap = turf.intersect(footprints[a], footprints[b]);
                expect(overlap ? turf.area(overlap) : 0).toBeLessThan(0.5);
            }
        }
    });

    it('groups buildings that bind a common parcel and refuses a building without a recorded binding', () => {
        const buildings = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
        expect(groupByBinding(buildings, { a: ['p1'], b: ['p2', 'p1'], c: ['p3'] }).map(group => group.map(item => item.key))).toEqual([['a', 'b'], ['c']]);
        expect(() => groupByBinding(buildings, { a: ['p1'], b: ['p2'] })).toThrow('c: no recorded binding');
    });

    it('publishes valid design/v1 objects', () => {
        const objects = planObjects(plan);
        expect(objects).toHaveLength(plan.designs.length);
        objects.forEach(object => expect(object.cid).toMatch(/^bafkrei/));
    });
});
