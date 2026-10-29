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
        expect(options[3]).toEqual({ value: 'design:7', kind: 'design', id: '7', title: 'Row' });
        expect(options[4].members).toEqual(['7', 'x']);
        expect(compare.parseSide('design:7', options).kind).toBe('design');
        expect(compare.parseSide('design:gone', options)).toBeNull();
    });
});

describe('what a side shows', () => {
    const intact = { role: 'existing', demolishedBy: [] };
    const razed = { role: 'existing', demolishedBy: [{ id: 'd1', unapplied: false }] };
    const block = { role: 'proposed', designId: 'd1' };
    const park = { role: 'proposed', designId: 'd2' };
    const shared = { role: 'proposed', designId: null };
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

    // Two designs on the same parcels cannot both be applied: the one that is not is still a side,
    // drawn from its own read (under its CID), never from the applied rival.
    it('offers a design that is not applied as a side that applies it alone, read under its CID', () => {
        const options = compare.sideOptions({ designs: [{ id: 'tower', title: 'Tower' }, { id: 'block', title: 'Block', cid: 'cidBlock', readId: 'plan-of-block' }] });
        expect(options[4]).toEqual({ value: 'design:block', kind: 'design', id: 'block', title: 'Block',
            members: ['cidBlock'], unapplied: ['cidBlock'], readId: 'plan-of-block' });
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
        // A drawing shared by several designs belongs to Proposed alone.
        expect(shows('proposed', shared)).toBe(true);
        expect(shows('design:d1', shared)).toBe(false);
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
