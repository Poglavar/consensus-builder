// Tests for restatements/upu-borovje/borovje-designs.mjs and the scripts built on it: the UPU Borovje
// plan at each version (1 as drawn, 2 replaying data/cadastral-snap.json, 3 replaying data/streets-fit.json),
// the invariants of the committed corrections, the official plan's and the urban-blocks alternative's
// designs, and the publish and correction scripts' command lines (dry runs and usage only).
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as turf from '@turf/turf';
import {
    AUTHOR, BLOCKS_AUTHOR, BLOCKS_DATE, CURRENT_VERSION, LAYOUT_KEYS, PLAN_DATE, PLAN_KEYS, STREET_KEYS,
    borovjeState, officialPlan, urbanBlocksPlan
} from '../../restatements/upu-borovje/borovje-designs.mjs';
import { planObjects } from '../scripts/lib/restatement-publish.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIR = path.join(ROOT, 'restatements', 'upu-borovje');
const data = name => JSON.parse(fs.readFileSync(path.join(DIR, 'data', name), 'utf8'));
const snap = data('cadastral-snap.json');
const fit = data('streets-fit.json');
const { footprints } = data('street-footprints.json');
const feature = geometry => turf.feature(geometry);
const area = geometry => turf.area(feature(geometry));
const plotsOf = state => state.layouts.flatMap(layout => layout.plots);
const BUILDING_KEYS = Array.from({ length: 11 }, (_, index) => `m1-${index + 1}`);
const PARK_KEYS = ['r2-1', 'z1-1', 'z1-2', 'z1-3', 'z1-4', 'z1-5'];

const states = {};
const stateAt = async version => (states[version] ||= await borovjeState(version));

describe('borovjeState', () => {
    it('has versions 1 to 3 and no other', async () => {
        expect(CURRENT_VERSION).toBe(3);
        for (const version of [0, 4, 1.5, '2']) {
            await expect(borovjeState(version)).rejects.toThrow(`UPU Borovje has versions 1 to 3, not ${version}`);
        }
    });

    it('version 1 is the plan as drawn: three connected blocks of 17 plots, two streets, eleven buildings, six parks', async () => {
        const state = await stateAt(1);
        expect(state.version).toBe(1);
        expect(state.layouts.map(layout => [layout.key, layout.plots.length])).toEqual([['parcelacija-1', 12], ['parcelacija-2', 4], ['parcelacija-3', 1]]);
        expect(state.roads.map(road => road.key)).toEqual([STREET_KEYS.main, STREET_KEYS.west]);
        // M1-12 (PP-5) is the housing row the plan keeps: nothing is built there.
        expect(state.buildings.map(building => building.key)).toEqual(BUILDING_KEYS);
        expect(state.parks.map(park => park.key)).toEqual(PARK_KEYS);
        const plots = new Map(plotsOf(state).map(plot => [plot.key, plot]));
        state.parks.forEach(park => expect(park.geometry).toEqual(plots.get(park.key).geometry));
        state.buildings.forEach(building => {
            const outside = turf.difference(feature(building.geometry), feature(plots.get(building.key).geometry));
            expect(outside ? turf.area(outside) : 0, building.key).toBeLessThan(0.01);
        });
        // The trace overhangs two plots slightly; their edges were clipped, the rest fit as drawn.
        expect(state.buildings.filter(building => building.trimmedM2 > 1).map(building => building.key).sort()).toEqual(['m1-11', 'm1-9']);
    });

    it('version 2 replays the cadastral correction member by member and changes nothing else', async () => {
        const [v1, v2] = [await stateAt(1), await stateAt(2)];
        expect(v2.version).toBe(2);
        for (const layout of v2.layouts) {
            const change = snap.members[layout.key];
            expect(layout.pool).toEqual(change.pool);
            layout.plots.forEach(plot => expect(plot.geometry, `${layout.key}#${plot.key}`).toEqual(change.plots[plot.key].geometry));
        }
        const main = v2.roads.find(road => road.key === STREET_KEYS.main).definition;
        expect(main.polygon).toEqual(snap.members.ulice.polygon);
        expect(main.segments).toEqual(snap.members.ulice.segments);
        expect(main.points).toEqual(main.segments);
        expect(main.points).not.toBe(main.segments);
        expect(main.segmentIds).toEqual(snap.members.ulice.segmentIds);
        expect(main.segmentProfiles).toEqual(snap.members.ulice.segmentProfiles);
        const west = v2.roads.find(road => road.key === STREET_KEYS.west).definition;
        const westBefore = v1.roads.find(road => road.key === STREET_KEYS.west).definition;
        expect(west.polygon).toEqual(snap.members['ulice-zapad'].polygon);
        expect(west.segments).toEqual(westBefore.segments);
        expect(v2.parks.find(park => park.key === 'z1-1').geometry).toEqual(snap.members['z1-1'].geometry);
        // The buildings are not part of the correction.
        expect(v2.buildings.map(building => building.geometry)).toEqual(v1.buildings.map(building => building.geometry));
    });

    it('version 2 lays plots and street land edge to edge over the whole corrected extent', async () => {
        const state = await stateAt(2);
        const pieces = [...plotsOf(state).map(plot => plot.geometry), ...state.roads.map(road => road.definition.polygon)];
        pieces.forEach(piece => expect(piece.type).toBe('Polygon'));
        const sum = pieces.reduce((total, piece) => total + area(piece), 0);
        expect(Math.abs(sum - area(snap.extent.geometry))).toBeLessThan(1);
        for (const layout of state.layouts) {
            const plots = layout.plots.reduce((total, plot) => total + area(plot.geometry), 0);
            expect(Math.abs(area(layout.pool) - plots), layout.key).toBeLessThan(0.5);
        }
    });

    it('version 2 keeps the collector one line, every crossing attached to it at a vertex, and narrows it only by its verges', async () => {
        const street = (await stateAt(2)).roads.find(road => road.key === STREET_KEYS.main).definition;
        const collector = street.segmentIds.map((id, index) => (id.startsWith('upu-sabirna-ulica') ? index : -1)).filter(index => index >= 0);
        for (let k = 1; k < collector.length; k += 1) {
            const previous = street.segments[collector[k - 1]];
            expect(street.segments[collector[k]][0]).toEqual(previous[previous.length - 1]);
        }
        const vertices = new Set(collector.flatMap(index => street.segments[index]).map(point => `${point.lat},${point.lng}`));
        const attached = street.segments.filter((_, index) => !collector.includes(index))
            .flatMap(segment => [segment[0], segment[segment.length - 1]])
            .filter(point => vertices.has(`${point.lat},${point.lng}`));
        // pjesacka-sjever meets the east crossing, not the collector; the other three crossings end on it.
        expect(attached).toHaveLength(3);
        const narrow = street.segmentProfiles['upu-sabirna-ulica-suzenje'];
        const full = street.segmentProfiles['upu-sabirna-ulica'];
        expect(narrow.strips).toEqual(full.strips.filter(strip => strip.type !== 'verge'));
        expect(snap.collector.narrowed.widthM).toBe(13.5);
        // Street lanes stay on street land except where the collector meets the city streets, and the
        // collector's cross-section barely leaves the corrected extent.
        expect(snap.corridor.joins.map(join => join.parcel)).toEqual(['335550-1823/8']);
        expect(snap.corridor.before.cadastral.outsideM2).toBeGreaterThan(1000);
        expect(snap.corridor.after.outsideM2).toBeLessThan(100);
    });

    it('version 3: every street takes exactly the ground its lanes cut, and every plot stays off it', async () => {
        const [v2, v3] = [await stateAt(2), await stateAt(3)];
        expect(v3.version).toBe(3);
        for (const road of v3.roads) {
            expect(road.definition.polygon, road.key).toEqual(footprints[road.key]);
            expect(road.definition.polygon, road.key).toEqual(fit.members[road.key].polygon);
            // Only the land changes: the stretches are version 2's.
            expect(road.definition.segments).toEqual(v2.roads.find(other => other.key === road.key).definition.segments);
        }
        const land = v3.roads.map(road => feature(road.definition.polygon));
        for (const layout of v3.layouts) {
            expect(layout.pool.type, `${layout.key} pool`).toBe('Polygon');
            for (const plot of layout.plots) {
                expect(plot.geometry.type, `${layout.key}#${plot.key}`).toBe('Polygon');
                for (const street of land) {
                    const overlap = turf.intersect(feature(plot.geometry), street);
                    expect(overlap ? turf.area(overlap) : 0, `${plot.key} on a street`).toBeLessThan(0.5);
                }
            }
        }
        // Parks moved with their plots (r2-1, z1-2, z1-3 grew to the street).
        ['r2-1', 'z1-2', 'z1-3'].forEach(key => expect(v3.parks.find(park => park.key === key).geometry).toEqual(fit.members[key].geometry));
        expect(fit.streetLandM2.after).toBeLessThan(fit.streetLandM2.before);
        const streetLand = v3.roads.reduce((total, road) => total + area(road.definition.polygon), 0);
        expect(streetLand).toBeLessThan(v2.roads.reduce((total, road) => total + area(road.definition.polygon), 0));
        expect(fit.plotsGrew.length).toBeGreaterThan(0);
    });
});

describe('officialPlan', () => {
    it('is two streets, three parcel layouts, eleven buildings and six parks at the current version, dated by the plan', async () => {
        const plan = await officialPlan();
        const state = await stateAt(3);
        expect(plan).toMatchObject({ key: PLAN_KEYS.official, title: 'UPU Borovje – zona jug', author: AUTHOR, city: 'zagreb', parcelSourceId: null });
        expect(plan.groundFile).toBe(path.join(DIR, 'ground', 'upu-borovje.json'));
        expect(plan.designs.map(design => design.key)).toEqual([STREET_KEYS.main, STREET_KEYS.west, ...LAYOUT_KEYS, ...BUILDING_KEYS, ...PARK_KEYS]);
        plan.designs.forEach(design => {
            expect(design.record.createdAt).toBe(PLAN_DATE);
            expect(design.record.author).toBe(AUTHOR);
        });
        const byKey = new Map(plan.designs.map(design => [design.key, design.record]));
        // A street's own geometry is its land.
        expect(byKey.get('ulice').geometry).toEqual(state.roads[0].definition.polygon);
        expect(byKey.get('ulice').roadProposal.isCorridor).toBe(true);
        // A layout publishes its pool as its site and its plots, in plot order, as geometry only.
        const layout = byKey.get('parcelacija-2');
        expect(layout.site).toEqual(state.layouts[1].pool);
        expect(layout.parcelLayout.plots.map(plot => plot.geometry)).toEqual(state.layouts[1].plots.map(plot => plot.geometry));
        expect(layout.description).toContain(state.layouts[1].plots.map(plot => plot.name).join(', '));
        // A building is content on its plot, its height the floors at 3.5 m.
        const building = byKey.get('m1-3');
        const traced = state.buildings.find(item => item.key === 'm1-3');
        expect(building.goal).toBe('buildings');
        expect(building.geometry.buildings[0].geometry).toEqual(traced.geometry);
        expect(building.buildingProposal.parameters).toMatchObject({ floors: traced.floors, height: Math.round(traced.floors * 3.5 * 10) / 10, typology: 'single' });
        expect(building.title).toBe(`UPU Borovje – zgrada ${traced.name} [${traced.pp}]`);
        expect(byKey.get('r2-1').title).toContain('rekreacija');
        expect(byKey.get('z1-4').structureProposal.geometry).toEqual(state.parks.find(park => park.key === 'z1-4').geometry);

        const objects = planObjects(plan);
        expect(objects).toHaveLength(22);
        expect(objects.filter(object => object.content.goal === 'parcel-layout').map(object => object.key)).toEqual(LAYOUT_KEYS);
        objects.forEach(object => expect(object.content.authoredAt).toBe(PLAN_DATE));
    });
});

describe('urbanBlocksPlan', () => {
    it('keeps the official streets, layouts and parks as the same objects and puts an open block on each building plot', async () => {
        const [official, blocks] = [await officialPlan(), await urbanBlocksPlan()];
        expect(blocks).toMatchObject({ key: PLAN_KEYS.urbanBlocks, title: 'Borovje – urbani blokovi', author: BLOCKS_AUTHOR, city: 'zagreb' });
        expect(blocks.blocks.buildings).toBe(11);
        expect(blocks.designs.map(design => design.key)).toEqual([STREET_KEYS.main, STREET_KEYS.west, ...LAYOUT_KEYS, ...BUILDING_KEYS.map(key => `blok-${key}`), ...PARK_KEYS]);
        const officialCids = new Map(planObjects(official).map(object => [object.key, object.cid]));
        const objects = planObjects(blocks);
        // The shared designs are the very same objects: a counter-plan reuses them, so their CIDs match.
        objects.filter(object => !object.key.startsWith('blok-')).forEach(object => expect(object.cid, object.key).toBe(officialCids.get(object.key)));
        const plots = new Map(plotsOf(await stateAt(3)).map(plot => [plot.key, plot.geometry]));
        blocks.designs.filter(design => design.key.startsWith('blok-')).forEach(design => {
            const plotKey = design.key.replace('blok-', '');
            const building = design.record.geometry.buildings[0];
            expect(design.record.createdAt).toBe(BLOCKS_DATE);
            expect(turf.booleanWithin(feature(building.geometry), feature(plots.get(plotKey))), plotKey).toBe(true);
            const floors = ['m1-1', 'm1-2', 'm1-10', 'm1-11'].includes(plotKey) ? 6 : 5;
            expect(design.record.buildingProposal.parameters.floors, plotKey).toBe(floors);
        });
    });
});

describe('the scripts\' command lines (dry runs and usage only)', () => {
    const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'borovje-scripts-'));
    afterAll(() => fs.rmSync(HOME, { recursive: true, force: true }));
    const childEnv = { ...process.env };
    // The parent test runner sets both colour controls; only script diagnostics belong on stderr.
    delete childEnv.NO_COLOR;
    const run = (script, args) => spawnSync(process.execPath, [path.join(DIR, script), ...args], {
        cwd: ROOT, encoding: 'utf8', timeout: 120_000,
        // A non-local database: a step that reached for the cadastre would be refused, never connected.
        env: { ...childEnv, HOME, DATABASE_URL: 'postgres://reader@db.invalid:5432/none' }
    });

    it('build-and-upload.mjs --dry-run prints the official plan\'s 22 designs and waits for its ground file', async () => {
        const result = run('build-and-upload.mjs', ['--dry-run']);
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('plan 1/1 upu-borovje "UPU Borovje – zona jug": 22 designs\n');
        for (const object of planObjects(await officialPlan())) expect(result.stdout).toContain(` ${object.content.goal} ${object.cid} `);
        expect(result.stdout).toContain(`upu-borovje: no ground file yet (${path.join('restatements', 'upu-borovje', 'ground', 'upu-borovje.json')})`);
        expect(fs.existsSync(path.join(HOME, '.config'))).toBe(false);
    }, 120_000);

    it('build-urban-blocks.mjs --dry-run reports its blocks and designs', () => {
        const result = run('build-urban-blocks.mjs', ['--dry-run']);
        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/urban blocks: 11 buildings, footprint \d+ m², floor area \d+ m²/);
        expect(result.stdout).toContain('plan 1/1 borovje-urbani-blokovi "Borovje – urbani blokovi": 22 designs\n');
    }, 120_000);

    it('snap-to-cadastre.mjs and fit-streets.mjs print their usage and touch nothing without a step', () => {
        const snapUsage = run('snap-to-cadastre.mjs', []);
        expect(snapUsage.status).toBe(0);
        expect(snapUsage.stdout).toContain('node snap-to-cadastre.mjs --compute');
        const fitUsage = run('fit-streets.mjs', ['--help']);
        expect(fitUsage.status).toBe(0);
        expect(fitUsage.stdout).toContain('node fit-streets.mjs --capture --app <app url> [--api <api>]');
        expect(fitUsage.stdout).toContain('node fit-streets.mjs --compute');
    }, 120_000);
});
