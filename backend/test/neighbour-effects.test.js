// The effects of a design on its neighbouring plots (frontend/js/planning/neighbour-effects.js):
// the sky a wall sees, garden sunlight on 21 March and the nearest facing wall, before and after.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const effects = require('../../frontend/js/planning/neighbour-effects.js');
const sunCalc = require('../../frontend/vendor/suncalc-1.9.0/suncalc.js');

const LNG = -0.1, LAT = 51.5;
const { lngLat } = effects.projector(LNG, LAT);
// A rectangle given in metres east and north of the origin, as a lng/lat Polygon.
const rect = (x0, y0, x1, y1) => ({ type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map(lngLat)] });
const SUN = effects.sunPath(sunCalc, '2026-03-21', LAT, LNG);

// A street block: the site is the whole row south of a shared back line (y 0–30), a neighbour north
// of it (y 30–60) has its house at the far end, and one plot lies far to the east.
const SITE = rect(-100, 0, 110, 30);
const NORTH = { id: 'north', geometry: rect(0, 30, 10, 60) };
const FAR = { id: 'far', geometry: rect(400, 0, 410, 30) };
const NORTH_HOUSE = { id: 'north-house', geometry: rect(1, 50, 9, 58), heightM: 7 };
const OLD_HOUSE = { id: 'old-house', geometry: rect(1, 2, 9, 10), heightM: 7 };

// England's guides as configured (frontend/data/planning-sources.json, rule set gb-eng-planning).
const config = JSON.parse(readFileSync(new URL('../../frontend/data/planning-sources.json', import.meta.url), 'utf8'));
const ENGLAND = config.ruleSets.find(ruleSet => ruleSet.id === 'gb-eng-planning').neighbourGuides;
const assess = (proposed, guides = ENGLAND) => effects.assess({ site: [SITE], lots: [NORTH, FAR], existing: [NORTH_HOUSE, OLD_HOUSE], proposed, sun: SUN, guides });

describe('vertical sky component', () => {
    it('is 39.6 % for a wall with nothing in front of it', () => {
        expect(effects.skyComponent([], 0, 0, 1.6, 0, 1)).toBeCloseTo(39.6, 0);
    });
    it('is about 27 % behind a long obstruction 25° above the window', () => {
        const project = effects.projector(LNG, LAT).point;
        const wall = { parts: [{ rings: [[[-500, 20], [500, 20], [500, 21], [-500, 21], [-500, 20]]], box: [-500, 20, 500, 21] }],
            box: [-500, 20, 500, 21], heightM: 1.6 + 20 * Math.tan(25 * Math.PI / 180) };
        expect(project).toBeTypeOf('function');
        expect(effects.skyComponent([wall], 0, 0, 1.6, 0, 1)).toBeGreaterThan(26);
        expect(effects.skyComponent([wall], 0, 0, 1.6, 0, 1)).toBeLessThan(28.5);
    });
});

describe('effects on neighbouring plots', () => {
    it('lists nothing when the design is the house it replaces', () => {
        expect(assess([{ id: 'new', geometry: OLD_HOUSE.geometry, heightM: 7 }]).lots).toEqual([]);
    });

    it('finds the garden, sky and distance a tall slab south of a neighbour takes, and leaves a far plot out', () => {
        const result = assess([{ id: 'slab', geometry: rect(-100, 2, 110, 28), heightM: 30 }]);
        expect(result.lots.map(lot => lot.id)).toEqual(['north']);
        const [north] = result.lots;
        expect(north.status).toBe('fail');
        expect(north.direction).toBe('n');
        // The garden lay north of a two-storey house; a 30 m slab along the back line takes its sun.
        expect(north.garden.before).toBeGreaterThan(0.5);
        expect(north.garden.after).toBeLessThan(0.5);
        expect(north.garden.status).toBe('fail');
        // The house's back wall faces the slab 22 m away, 30 m tall: well under 27 %.
        expect(north.sky.after).toBeLessThan(27);
        expect(north.sky.after).toBeLessThan(0.8 * north.sky.before);
        expect(north.sky.status).toBe('fail');
        expect(north.distance.after).toBeCloseTo(22, 0);
        expect(north.distance.before).toBeCloseTo(40, 0);
        // 22 m is still beyond the 21 m guide, so a closer wall there is no effect.
        expect(north.distance.status).toBe('same');
    });

    it("leaves a narrow tower's side light alone but still counts the sky it takes", () => {
        const [north] = assess([{ id: 'tower', geometry: rect(1, 2, 9, 28), heightM: 30 }]).lots;
        // Morning and evening sun reach the garden past an 8 m wide tower.
        expect(north.garden.status).toBe('same');
        // It still meets the 27 % level: a minor loss.
        expect(north.sky.status).toBe('minor');
        expect(north.sky.after).toBeGreaterThan(27);
    });

    it('takes only the readings a place has guides for, with its thresholds', () => {
        const slab = [{ id: 'slab', geometry: rect(-100, 2, 110, 28), heightM: 30 }];
        // No guides: nothing is measured.
        expect(assess(slab, {}).lots).toEqual([]);
        // Only a sky guide: no garden or distance reading, and a laxer threshold turns fail into within.
        const [skyOnly] = assess(slab, { sky: { percent: 27, ratio: 0.8 } }).lots;
        expect(skyOnly.garden ?? null).toBe(null);
        expect(skyOnly.distance ?? null).toBe(null);
        expect(skyOnly.sky.status).toBe('fail');
        const [lax] = assess(slab, { sky: { percent: 5, ratio: 0.1 } }).lots;
        expect(lax.sky.status).toBe('minor');
        // A 30 m distance guide makes the 22 m wall a failure the 21 m one does not.
        const [far] = assess(slab, { distance: { metres: 30 } }).lots;
        expect(far.distance.status).toBe('fail');
    });

    it('calls a facing wall closer than 21 m beyond the guide', () => {
        const [north] = assess([{ id: 'block', geometry: rect(1, 2, 9, 35), heightM: 6 }]).lots;
        expect(north.distance.after).toBeCloseTo(15, 0);
        expect(north.distance.status).toBe('fail');
    });

    it('groups plots beyond a guide before those within, each by its largest loss, and filters by reading', () => {
        const worstOf = readings => ['fail', 'below', 'minor'].find(grade => readings.some(r => r?.status === grade));
        const lot = (id, garden, sky, distance) => ({ id, distanceM: 1, status: worstOf([garden, sky, distance]), garden, sky, distance });
        const small = lot('small', { before: 1, after: 0.9, status: 'minor' }, null, null);
        const big = lot('big', null, { before: 30, after: 25, status: 'below' }, null);
        const failing = lot('failing', { before: 0.6, after: 0.45, status: 'fail' }, { before: 30, after: 29, status: 'minor' }, null);
        const near = lot('near', null, null, { before: null, after: 10.5, guideM: 21, status: 'fail' });
        const [beyond, below, minor] = effects.arrange([small, big, failing, near]);
        // near: 10.5 m is half way inside 21 m (0.5); failing: a quarter of its garden sun (0.25).
        expect(beyond.map(l => l.id)).toEqual(['near', 'failing']);
        expect(below.map(l => l.id)).toEqual(['big']);
        expect(minor.map(l => l.id)).toEqual(['small']);
        // By sky alone: big is below the level, failing's sky a minor loss; the others drop out.
        const bySky = effects.arrange([small, big, failing, near], { kind: 'sky' });
        expect(bySky.map(group => group.map(l => l.id))).toEqual([[], ['big'], ['failing']]);
        expect(effects.changes(failing)).toEqual([{ kind: 'garden', status: 'fail' }, { kind: 'sky', status: 'minor' }]);
    });

    it('grades a loss red beyond the guide, orange under its level within the allowance, green above the level', () => {
        // The garden guide: half the garden, or 0.8 times before.
        const [lot] = assess([{ id: 'slab', geometry: rect(-100, 2, 110, 28), heightM: 30 }], { garden: ENGLAND.garden }).lots;
        expect(lot.garden.status).toBe('fail');
        const grade = (before, after) => assess([{ id: 'slab', geometry: rect(-100, 2, 110, 28), heightM: 30 }],
            { garden: { ...ENGLAND.garden, share: before, ratio: after } }).lots[0]?.garden.status;
        // A level of 0 is always met: any loss is minor.
        expect(grade(0, 0.8)).toBe('minor');
        // A level of 1 with no allowance left (ratio 0) is under the level but within the allowance.
        expect(grade(1, 0)).toBe('below');
    });

    it('counts sun on 21 March only while the sun is up', () => {
        expect(SUN.positions.length * SUN.stepMin).toBeGreaterThan(11.5 * 60);
        expect(SUN.positions.length * SUN.stepMin).toBeLessThan(12.7 * 60);
        expect(SUN.positions.every(position => position.altitude > 0)).toBe(true);
    });
});
