// The model view's side-by-side comparison (frontend/js/three-compare.js): which sides are offered,
// what each side shows, how a scene splits between the two passes, and the scissor rectangles.
// The divider and the Compare tab are checked in the browser; these are the pure rules. The map's
// halves are in compare-on-map.test.js.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compare = require('../../frontend/js/three-compare.js');

const side = value => compare.parseSide(value, compare.sideOptions({
    designs: [{ id: 'd1', title: 'Block' }, { id: 'd2', title: 'Park' }],
    plans: [{ id: 'plan-a', title: 'Plan A', members: ['d1'] }, { id: 'plan-b', title: 'Plan B', members: [] }]
}));

describe('compare sides', () => {
    it('offers the three base states, then every applied design and plan', () => {
        const options = compare.sideOptions({ designs: [{ id: 7, title: 'Row' }, { id: null }], plans: [{ id: 'p', title: 'P', members: [7, 'x'] }] });
        expect(options.map(option => option.value)).toEqual(['built', 'permitted', 'proposed', 'design:7', 'plan:p']);
        expect(options[3]).toEqual({ value: 'design:7', kind: 'design', id: '7', title: 'Row', canPublish: false });
        expect(options[4].members).toEqual(['7', 'x']);
        expect(compare.parseSide('design:7', options).kind).toBe('design');
        expect(compare.parseSide('design:gone', options)).toBeNull();
    });
});

describe('what a side shows', () => {
    const intact = { role: 'existing', demolishedBy: [] };
    const razed = { role: 'existing', demolishedBy: [{ id: 'd1', unapplied: false }] };
    const block = { role: 'proposed', designIds: ['d1'] };
    const park = { role: 'proposed', designIds: ['d2'] };
    const shared = { role: 'proposed', designIds: [] };
    const junction = { role: 'proposed', designIds: ['d2', 'd1'] };
    const massing = { role: 'permitted' };
    const shows = (value, descriptor) => compare.showsOn(side(value), descriptor);

    it('keeps the standing city on every side and removes only what the side applies', () => {
        for (const value of ['built', 'permitted', 'proposed', 'design:d1', 'design:d2', 'plan:plan-a', 'plan:plan-b']) expect(shows(value, intact)).toBe(true);
        expect(['built', 'permitted'].map(value => shows(value, razed))).toEqual([true, true]);
        expect(shows('proposed', razed)).toBe(false);
        expect(shows('design:d1', razed)).toBe(false);
        expect(shows('design:d2', razed)).toBe(true);
        expect(shows('plan:plan-a', razed)).toBe(false);
        expect(shows('plan:plan-b', razed)).toBe(true);
        // A building two designs cut is gone wherever either applies.
        const twice = { role: 'existing', demolishedBy: [{ id: 'd2', unapplied: false }, { id: 'd1', unapplied: false }] };
        expect(['built', 'design:d1', 'design:d2', 'plan:plan-a', 'plan:plan-b'].map(value => shows(value, twice))).toEqual([true, false, false, false, true]);
    });

    it('applies a design on Proposed, on its own side and on a plan holding it; a plan applies its unapplied members too', () => {
        const options = compare.sideOptions({ designs: [{ id: 'd1' }], plans: [{ id: 'p', members: ['d1', 'cidX'], unapplied: ['cidX'] }] });
        const applies = (value, by) => compare.appliesDesign(compare.parseSide(value, options), by);
        expect(['built', 'permitted', 'proposed', 'design:d1', 'plan:p'].map(value => applies(value, { id: 'd1' }))).toEqual([false, false, true, true, true]);
        expect(['proposed', 'design:d1', 'plan:p'].map(value => applies(value, { id: 'cidX', unapplied: true }))).toEqual([false, false, true]);
        expect(applies('plan:p', { id: 'd9' })).toBe(false);
        expect(options[4].unapplied).toEqual(['cidX']);
    });

    it('offers an agreement as a side that draws its plan: its applied members by id, the rest from the plan read', () => {
        const options = compare.sideOptions({ designs: [{ id: 'd1' }], agreements: [
            { id: 'a1', title: 'Owners deal', members: ['d1', 'cidX'], unapplied: ['cidX'], readId: 'plan-1' },
            { id: 'a2', title: 'No plan yet' }
        ] });
        expect(options.map(option => option.value)).toEqual(['built', 'permitted', 'proposed', 'design:d1', 'agreement:a1']);
        expect(options[4]).toEqual({ value: 'agreement:a1', kind: 'agreement', id: 'a1', title: 'Owners deal',
            members: ['d1', 'cidX'], unapplied: ['cidX'], readId: 'plan-1' });
        const applies = (value, by) => compare.appliesDesign(compare.parseSide(value, options), by);
        expect(applies('agreement:a1', { id: 'd1' })).toBe(true);
        expect(applies('agreement:a1', { id: 'cidX', unapplied: true })).toBe(true);
        expect(applies('agreement:a1', { id: 'd9' })).toBe(false);
        const razed = { role: 'existing', demolishedBy: [{ id: 'd1', unapplied: false }] };
        expect(compare.showsOn(options[4], razed)).toBe(false);
        expect(compare.readiness([options[0], options[4]], () => null).ready).toBe(false);
        expect(compare.readiness([options[0], options[4]], id => (id === 'plan-1' ? { status: 'ready' } : null)).ready).toBe(true);
    });

    // Two designs on the same parcels cannot both be applied: the one that is not is still a side,
    // drawn from its own read (under its CID), never from the applied rival.
    it('offers a design that is not applied as a side that applies it alone, read under its CID', () => {
        const options = compare.sideOptions({ designs: [{ id: 'tower', title: 'Tower' }, { id: 'block', title: 'Block', cid: 'cidBlock', readId: 'plan-of-block' }] });
        expect(options[4]).toEqual({ value: 'design:block', kind: 'design', id: 'block', title: 'Block',
            members: ['cidBlock'], unapplied: ['cidBlock'], readId: 'plan-of-block', canPublish: false });
        const applies = (value, by) => compare.appliesDesign(compare.parseSide(value, options), by);
        expect(applies('design:block', { id: 'cidBlock', unapplied: true })).toBe(true);
        expect(applies('design:block', { id: 'tower' })).toBe(false);
        expect(applies('design:tower', { id: 'cidBlock', unapplied: true })).toBe(false);
        expect(applies('proposed', { id: 'cidBlock', unapplied: true })).toBe(false);
    });

    it('draws proposed work only on Proposed, its own design or a plan holding it', () => {
        expect(['built', 'permitted'].map(value => shows(value, block))).toEqual([false, false]);
        expect(shows('proposed', block)).toBe(true);
        expect(shows('design:d1', block)).toBe(true);
        expect(shows('design:d2', block)).toBe(false);
        expect(shows('plan:plan-a', block)).toBe(true);
        expect(shows('plan:plan-a', park)).toBe(false);
        // A drawing no design is known for belongs to Proposed alone.
        expect(shows('proposed', shared)).toBe(true);
        expect(shows('design:d1', shared)).toBe(false);
        expect(shows('plan:plan-a', shared)).toBe(false);
        // A junction where two designs' roads meet stands wherever either road does.
        expect(['built', 'proposed', 'design:d1', 'design:d2', 'plan:plan-a', 'plan:plan-b'].map(value => shows(value, junction)))
            .toEqual([false, true, true, true, true, false]);
    });

    it('draws permitted massing on the Permitted side alone', () => {
        expect(['built', 'permitted', 'proposed', 'design:d1', 'plan:plan-a'].map(value => shows(value, massing))).toEqual([false, true, false, false, false]);
    });

    it('splits a scene into what only the left, only the right, or neither pass shows', () => {
        const descriptors = [intact, razed, block, park, massing].map((descriptor, index) => ({ object: `o${index}`, ...descriptor }));
        const split = compare.splitDescriptors(side('built'), side('design:d1'), descriptors);
        expect(split.leftOnly.map(item => item.object)).toEqual(['o1']);
        expect(split.rightOnly.map(item => item.object)).toEqual(['o2']);
        expect(split.hidden.map(item => item.object)).toEqual(['o3', 'o4']);
        // The same side twice switches nothing between the passes; what neither shows stays hidden.
        expect(compare.splitDescriptors(side('proposed'), side('proposed'), descriptors)).toEqual({ leftOnly: [], rightOnly: [], hidden: [descriptors[1], descriptors[4]] });
    });
});

describe('scissor rectangles', () => {
    it('cuts the canvas at the divider, from the left, in whole pixels', () => {
        expect(compare.scissorRects(1000, 600, 50)).toEqual({ left: [0, 0, 500, 600], right: [500, 0, 500, 600] });
        expect(compare.scissorRects(1001, 600, 33.3)).toEqual({ left: [0, 0, 333, 600], right: [333, 0, 668, 600] });
        expect(compare.scissorRects(800, 600, -5)).toEqual({ left: [0, 0, 0, 600], right: [0, 0, 800, 600] });
        expect(compare.scissorRects(800, 600, 140)).toEqual({ left: [0, 0, 800, 600], right: [800, 0, 0, 600] });
    });
});

describe('whether two sides can be compared yet', () => {
    const plan = (id, unapplied = ['c1']) => ({ kind: 'plan', id, unapplied, readId: id });
    it('waits for every plan side with unapplied members to be read, and names the one that failed', () => {
        const { readiness } = compare;
        const statuses = { a: { status: 'ready' }, b: { status: 'loading' }, c: { status: 'failed', error: 'plot 7 refused' } };
        const statusOf = id => statuses[id] || null;
        expect(readiness([{ kind: 'built' }, plan('a')], statusOf)).toEqual({ ready: true, reading: [], failed: [] });
        expect(readiness([plan('a'), plan('x', [])], statusOf).ready).toBe(true);
        const waiting = readiness([plan('b'), plan('z')], statusOf);
        expect(waiting.ready).toBe(false);
        expect(waiting.reading.map(side => side.id)).toEqual(['b', 'z']);
        const broken = readiness([plan('a'), plan('c')], statusOf);
        expect(broken).toEqual({ ready: false, reading: [], failed: [{ side: plan('c'), error: 'plot 7 refused' }] });
    });

    it('waits for a design that is not applied to be read as its one-member plan', () => {
        const options = compare.sideOptions({ designs: [{ id: 'd1' }, { id: 'd2', cid: 'cidD2', readId: 'plan-of-d2' }] });
        const statuses = { 'plan-of-d2': { status: 'loading' } };
        const pair = [compare.parseSide('design:d1', options), compare.parseSide('design:d2', options)];
        expect(compare.readiness(pair, id => statuses[id] || null).reading.map(side => side.id)).toEqual(['d2']);
        statuses['plan-of-d2'] = { status: 'ready' };
        expect(compare.readiness(pair, id => statuses[id] || null).ready).toBe(true);
    });
});

describe('the side picker', () => {
    it('groups today, plans, agreements and designs, each newest first, and keeps when each was made', () => {
        const options = compare.sideOptions({
            designs: [{ id: 'old', title: 'Library', at: '2026-11-17T07:07:20Z' }, { id: 'new', title: 'Library', at: '2026-11-17T08:47:29Z' }, { id: 'undated', title: 'Sketch' }],
            plans: [{ id: 'p1', title: 'Courtyard', at: '2026-11-17T07:06:44Z' }, { id: 'p2', title: 'Courtyard', at: '2026-11-17T08:47:30Z' }, { id: 'local', title: 'Local only' }],
            agreements: [{ id: 'a1', title: 'Deal', readId: 'p1', at: '2026-11-19T12:00:00Z' }]
        });
        const groups = compare.optionGroups(options);
        expect(groups.map(g => g.group)).toEqual(['today', 'plan', 'agreement', 'design']);
        expect(groups[0].options.map(o => o.value)).toEqual(['built', 'permitted', 'proposed']);
        // The same title twice is told apart by its time; one without a time comes after the dated ones.
        expect(groups[1].options.map(o => [o.id, o.at])).toEqual([['p2', '2026-11-17T08:47:30Z'], ['p1', '2026-11-17T07:06:44Z'], ['local', undefined]]);
        expect(groups[3].options.map(o => o.id)).toEqual(['new', 'old', 'undated']);
        // Every option offered is in exactly one group.
        expect(groups.flatMap(g => g.options).map(o => o.value).sort()).toEqual(options.map(o => o.value).sort());
    });

    it('leaves out a group with nothing in it', () => {
        expect(compare.optionGroups(compare.sideOptions({ plans: [{ id: 'p', title: 'P' }] })).map(g => g.group)).toEqual(['today', 'plan']);
    });
});

describe('the plans a side can be', () => {
    it("adds the city's published plans to this browser's own, each once, with its publication time", () => {
        const local = [{ cid: 'a', content: { title: 'Opened here' } }, { cid: 'b', content: { title: 'Saved here' }, publishedAt: '2026-11-17T07:00:00Z' }];
        const published = [{ cid: 'a', content: { title: 'Opened here' }, publishedAt: '2026-11-21T07:42:48Z' }, { cid: 'c', content: { title: 'Never opened' }, publishedAt: '2026-11-21T07:11:50Z' }];
        const rows = compare.planRowsOf(local, published);
        expect(rows.map(row => [row.cid, row.publishedAt || null])).toEqual([['a', '2026-11-21T07:42:48Z'], ['b', '2026-11-17T07:00:00Z'], ['c', '2026-11-21T07:11:50Z']]);
        // This browser's row is kept (it may hold its designs), only dated from the published list.
        expect(rows[0]).not.toBe(local[0]);
        expect(rows[1]).toBe(local[1]);
        expect(compare.planRowsOf(local, [])).toEqual(local);
    });
});

describe("the divider's stats", () => {
    const options = compare.sideOptions({
        designs: [{ id: 'd1', title: 'Library' }, { id: 'd2', title: 'School' }],
        plans: [{ id: 'p1', title: 'Courtyard' }],
        agreements: [{ id: 'a1', title: 'Deal', readId: 'p1' }, { id: 'a2', title: 'Other deal', readId: 'p1' }]
    });
    const side = value => compare.parseSide(value, options);
    const statsOf = (...values) => {
        const stats = compare.statsOf(values.map(side));
        return stats && { subject: stats.subject, sides: stats.sides.map(entry => entry.value) };
    };

    it('measures the sides that are designs, plans or agreements, named after what they are', () => {
        expect(statsOf('design:d1', 'design:d2')).toEqual({ subject: 'designs', sides: ['design:d1', 'design:d2'] });
        expect(statsOf('agreement:a1', 'agreement:a2')).toEqual({ subject: 'agreements', sides: ['agreement:a1', 'agreement:a2'] });
        expect(statsOf('plan:p1', 'design:d1')).toEqual({ subject: 'plans', sides: ['plan:p1', 'design:d1'] });
        expect(statsOf('agreement:a1', 'design:d1')).toEqual({ subject: 'plans', sides: ['agreement:a1', 'design:d1'] });
    });

    it('leaves today\'s states out (Built today is the dialog\'s present state), and the same side counts once', () => {
        expect(statsOf('built', 'plan:p1')).toEqual({ subject: 'plans', sides: ['plan:p1'] });
        expect(statsOf('design:d1', 'proposed')).toEqual({ subject: 'designs', sides: ['design:d1'] });
        expect(statsOf('plan:p1', 'plan:p1')).toEqual({ subject: 'plans', sides: ['plan:p1'] });
        expect(statsOf('built', 'permitted')).toBeNull();
        expect(compare.statsOf([null, undefined])).toBeNull();
    });
});

describe('a comparison in the address', () => {
    const cidA = `bafkrei${'a'.repeat(52)}`, cidB = `bafkrei${'b'.repeat(52)}`, cidD = `bafkrei${'d'.repeat(52)}`;
    const options = compare.sideOptions({
        designs: [{ id: 'local-1', title: 'Block', canPublish: true }, { id: 'p-2', title: 'Published', publishedCid: cidD },
            { id: 'too-big', title: 'Refused' }],
        plans: [{ id: cidA, title: 'Published', published: true }, { id: cidB, title: 'Only here' }],
        agreements: [{ id: 'ag', title: 'Agreement', readId: cidA }]
    });
    const on = value => compare.parseSide(value, options);
    it('names today\'s states by name, a saved plan by its CID and a published design as design-<cid>, and reads them back', () => {
        expect(compare.compareParam(on(`plan:${cidA}`), on(`plan:${cidB}`))).toBe(`${cidA},${cidB}`);
        expect(compare.compareParam(on('built'), on('design:p-2'))).toBe(`built,design-${cidD}`);
        expect(compare.parseCompareParam(`${cidA},design-${cidD}`)).toEqual({ left: { kind: 'plan', cid: cidA }, right: { kind: 'design', cid: cidD } });
        expect(compare.parseCompareParam(`permitted, ${cidA}`)).toEqual({ left: { kind: 'permitted' }, right: { kind: 'plan', cid: cidA } });
    });
    it('finds the offered side a link names: a plan by its CID, a design by the CID it was published under', () => {
        expect(compare.resolveWanted({ kind: 'built' }, options)).toBe('built');
        expect(compare.resolveWanted({ kind: 'plan', cid: cidB }, options)).toBe(`plan:${cidB}`);
        expect(compare.resolveWanted({ kind: 'design', cid: cidD }, options)).toBe('design:p-2');
        // Not offered (yet): the caller fetches the design, or reports the plan as not published.
        expect(compare.resolveWanted({ kind: 'design', cid: cidB }, options)).toBeNull();
        expect(compare.resolveWanted({ kind: 'plan', cid: cidD }, options)).toBeNull();
    });
    it('does not name a design that is not published or an agreement, and reads nothing from a malformed value', () => {
        expect(compare.compareParam(on('design:local-1'), on('built'))).toBeNull();
        expect(compare.compareParam(on('agreement:ag'), on('built'))).toBeNull();
        for (const value of [null, '', cidA, `${cidA},${cidB},built`, `${cidA},nope`, 'built,', `design-nope,built`]) {
            expect(compare.parseCompareParam(value), String(value)).toBeNull();
        }
    });
    it('gives Copy link the page address with the chosen sides, keeping the view and replacing an old comparison', () => {
        const page = `https://example.test/?at=1%2C2%2C18&compare=built%2Cpermitted&xray=proposed`;
        const link = new URL(compare.comparisonLink(page, on('proposed'), on(`plan:${cidA}`)));
        expect(link.searchParams.get('compare')).toBe(`proposed,${cidA}`);
        expect(link.searchParams.get('at')).toBe('1,2,18');
        expect(link.searchParams.get('xray')).toBe('proposed');
        expect(new URL(compare.comparisonLink(page, on('design:p-2'), on('built'))).searchParams.get('compare')).toBe(`design-${cidD},built`);
        // Another browser could not open what is only in this browser: Copy link publishes it first.
        expect(compare.comparisonLink(page, on('design:local-1'), on('built'))).toBeNull();
        expect(compare.comparisonLink(page, on('built'), on(`plan:${cidB}`))).toBeNull();
        expect([on('design:local-1'), on(`plan:${cidB}`)].map(compare.publishable)).toEqual([true, true]);
        // An agreement, and a design the publication terms refuse, cannot be published from here.
        expect([on('agreement:ag'), on('design:too-big'), on('built'), on(`plan:${cidA}`)].map(compare.publishable)).toEqual([false, false, false, false]);
    });
});
