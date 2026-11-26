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

    it('takes the 25° test from windows facing the design, as a first check the sky reading then decides', () => {
        // The slab's face is 22 m from the house's back wall and 30 m tall: about 52° above a window.
        const slab = [{ id: 'slab', geometry: rect(-100, 2, 110, 28), heightM: 30 }];
        const [north] = assess(slab).lots;
        expect(north.angle.after).toBeCloseTo(Math.atan2(30 - 1.6, 22) * 180 / Math.PI, 0);
        expect(north.angle.degrees).toBe(25);
        // England names the sky reading as the detailed one: the crossed test grades nothing itself.
        expect(north.angle.status).toBe('screen');
        expect(north.status).toBe('fail');
        // Without a sky guide to follow it, crossing the line is the finding.
        expect(assess(slab, { angle: { degrees: 25 } }).lots[0].angle.status).toBe('fail');
        // A two-storey block 22 m away stays under 25°: no reading listed.
        expect(assess([{ id: 'low', geometry: rect(-100, 2, 110, 28), heightM: 8 }], { angle: { degrees: 25 } }).lots).toEqual([]);
        // Drawn: the window 1.6 m up the wall, the guide's plane rising from it, the line to the slab's top.
        const roles = north.angle.marks.map(mark => `${mark.type}:${mark.role}`);
        expect(roles).toEqual(['point:window', 'plane:guide', 'line:guide', 'line:measured']);
        const [window] = north.angle.marks[0].points;
        expect(window[2]).toBeCloseTo(1.6, 5);
        // On the back wall (y = 50), just off its face.
        expect(window[1]).toBeCloseTo(lngLat([0, 49.95])[1], 6);
        expect(north.angle.marks[3].points[1][2]).toBe(30);
    });

    it('takes the 45° test for an extension beside a window, in plan and elevation', () => {
        // Two plots side by side; the neighbour's back wall faces south at y = 15. The design is a
        // house next door with an extension 10 m deep along the shared side.
        const neighbour = { id: 'neighbour', geometry: rect(0, 0, 10, 30) };
        const site = rect(10, 0, 30, 30);
        const house = { id: 'house', geometry: rect(0.5, 15, 9.5, 25), heightM: 7 };
        const run = (heightM, guides) => effects.assess({ site: [site], lots: [neighbour], existing: [house],
            proposed: [{ id: 'main', geometry: rect(11, 15, 21, 25), heightM: 7 }, { id: 'extension', geometry: rect(11, 5, 15, 15), heightM }], sun: SUN, guides }).lots;
        // Two storeys: the nearest window (about 2.5 m from the extension) lies past both lines.
        const [lot] = run(6, { splay: { degrees: 45 } });
        expect(lot.splay.status).toBe('fail');
        expect(lot.splay.after).toBeGreaterThan(0);
        expect(lot.splay.marks.map(mark => `${mark.type}:${mark.role}`)).toEqual(['point:window', 'line:guide', 'line:guide', 'line:measured']);
        // England names the sky reading as the detailed one.
        expect(run(6, ENGLAND)[0].splay.status).toBe('screen');
        // One storey: the elevation line from its top passes under the window.
        expect(run(3, { splay: { degrees: 45 } })).toEqual([]);
    });

    it('keeps a crossed first check out of the harm and the grade groups', () => {
        const lot = { id: 'a', distanceM: 5, status: 'minor', sky: { before: 39, after: 30, status: 'minor' },
            angle: { before: 0, after: 40, degrees: 25, status: 'screen' } };
        expect(effects.harm(lot)).toBeCloseTo(9 / 39, 5);
        expect(effects.harm(lot, 'angle')).toBeCloseTo(15 / 65, 5);
        expect(effects.arrange([lot], { kind: 'angle' }).map(group => group.length)).toEqual([0, 0, 1]);
        expect(effects.changes(lot)).toEqual([{ kind: 'sky', status: 'minor' }, { kind: 'angle', status: 'screen' }]);
    });

    it('marks where a garden loses its hours of sun', () => {
        const [north] = assess([{ id: 'slab', geometry: rect(-100, 2, 110, 28), heightM: 30 }]).lots;
        const [lost] = north.garden.marks;
        expect(lost.role).toBe('lost');
        expect(lost.points.length).toBeGreaterThan(10);
        // On the plot (x 0–10, y 30–60), on the ground.
        const [w, s] = lngLat([0, 30]), [e, n] = lngLat([10, 60]);
        expect(lost.points.every(([lng, lat, z]) => lng >= w && lng <= e && lat >= s && lat <= n && z < 1)).toBe(true);
    });

    it('counts sun on 21 March only while the sun is up', () => {
        expect(SUN.positions.length * SUN.stepMin).toBeGreaterThan(11.5 * 60);
        expect(SUN.positions.length * SUN.stepMin).toBeLessThan(12.7 * 60);
        expect(SUN.positions.every(position => position.altitude > 0)).toBe(true);
    });
});

// Sunlight to windows over the year (BRE BR 209 3.2): the sun weighted by the place's sunshine
// records (frontend/data/sunshine-records.json), graded against England's sunlight guide.
const STATION = JSON.parse(readFileSync(new URL('../../frontend/data/sunshine-records.json', import.meta.url), 'utf8')).stations[0];
const YEAR = effects.sunYear(sunCalc, 2026, LAT, LNG, STATION.monthHours, ENGLAND.sunlight.winter);
const assessYear = (proposed, guides = ENGLAND) => effects.assess({ site: [SITE], lots: [NORTH, FAR], existing: [NORTH_HOUSE, OLD_HOUSE], proposed, sun: SUN, year: YEAR, guides });

describe('sunlight to windows over the year', () => {
    it("weights the year's sun by each month's recorded sunshine, so open ground gets the records' total", () => {
        const recorded = STATION.monthHours.reduce((sum, hours) => sum + hours, 0);
        expect(YEAR.total).toBeCloseTo(recorded, 0);
        expect(YEAR.equatorY).toBe(-1);
        // 21 September to 21 March is winter: some positions are, some are not.
        const winter = YEAR.positions.filter(position => position.winter).reduce((sum, position) => sum + position.weight, 0);
        expect(winter / YEAR.total).toBeGreaterThan(0.2);
        expect(winter / YEAR.total).toBeLessThan(0.4);
    });

    it('takes the sun a tall slab south of a window takes, beyond the guide', () => {
        const [north] = assessYear([{ id: 'slab', geometry: rect(-100, 2, 110, 28), heightM: 60 }]).lots;
        // The house's south wall saw the low two-storey house beyond the back line; a 60 m slab 22 m
        // away rises 69° from the window, above London's highest sun, and blocks most of the year's.
        // (At 30 m, 52°, the summer midday sun still clears it.)
        expect(north.sunlight.before).toBeGreaterThan(25);
        expect(north.sunlight.after).toBeLessThan(25);
        expect(north.sunlight.before - north.sunlight.after).toBeGreaterThan(4);
        expect(north.sunlight.winterAfter).toBeLessThan(north.sunlight.winterBefore);
        expect(north.sunlight.status).toBe('fail');
        expect(north.sunlight.marks.find(mark => mark.role === 'window')).toBeTruthy();
        expect(north.sunlight.marks.filter(mark => mark.role === 'measured').length).toBeGreaterThan(0);
    });

    it('takes no sunlight reading for a window facing north, nor without sunshine records or a guide', () => {
        // A slab north of the house, no wider than it: only its north wall sees it, and no sun
        // comes from there.
        const behind = [{ id: 'behind', geometry: rect(1, 64, 9, 90), heightM: 30 }];
        const north = assessYear(behind).lots.find(lot => lot.id === 'north');
        expect(north.sky).toBeTruthy();
        expect(north.sunlight).toBeNull();
        const slab = [{ id: 'slab', geometry: rect(-100, 2, 110, 28), heightM: 30 }];
        expect(assess(slab).lots[0].sunlight).toBeNull();
        const { sunlight, ...withoutSunlight } = ENGLAND;
        expect(sunlight).toBeTruthy();
        expect(assessYear(slab, withoutSunlight).lots[0].sunlight).toBeNull();
    });

    it("grades by BRE's tests: under 25 % or 5 % in winter, under 0.8 times before, and over 4 % lost in the year", () => {
        const grade = (before, after) => effects.sunlightGrade(before, after, ENGLAND.sunlight);
        expect(grade({ annual: 40, winter: 10 }, { annual: 20, winter: 4 })).toBe('fail');
        // Winter alone under its level and its ratio, with more than 4 % lost over the year.
        expect(grade({ annual: 40, winter: 10 }, { annual: 34, winter: 4 })).toBe('fail');
        // Under the levels and the ratio, but only 4 % lost over the year: within the guide.
        expect(grade({ annual: 18, winter: 3 }, { annual: 14, winter: 2 })).toBe('below');
        // Under 25 % but at 0.8 times before or more: within the guide.
        expect(grade({ annual: 28, winter: 8 }, { annual: 23, winter: 7 })).toBe('below');
        // Still over both levels.
        expect(grade({ annual: 50, winter: 15 }, { annual: 40, winter: 10 })).toBe('minor');
        expect(grade({ annual: 50, winter: 15 }, { annual: 49.5, winter: 14.8 })).toBe('same');
    });
});

describe('how far a plot is', () => {
    it("names a plot's distance from the design's nearest building, not from what it replaces or a bounding box", () => {
        const tri = { type: 'Polygon', coordinates: [[[12, 0], [40, 0], [40, 28], [12, 0]].map(lngLat)] };
        // A triangle whose bounding box comes within 2.8 m of the north plot's corner (10, 30); its
        // slope, the nearest side, runs 32/√2 m from it.
        const [north] = assess([{ id: 'triangle', geometry: tri, heightM: 60 }]).lots.filter(lot => lot.id === 'north');
        expect(north.distanceM).toBeCloseTo(32 / Math.SQRT2, 2);
        // A design 50 m east of the plot that replaces the old house 20 m south of it: from the plot's
        // corner (10, 30) to the design's (60, 28).
        const far = assess([{ id: 'far', geometry: rect(60, 2, 70, 28), heightM: 60 }]).lots.find(lot => lot.id === 'north');
        expect(far.distanceM).toBeCloseTo(Math.hypot(50, 2), 2);
    });
});
