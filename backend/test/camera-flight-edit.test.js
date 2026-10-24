// Editor transactions preserve stable route identities, authored look timing and complete turn keys.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const Flight = require('../../frontend/js/camera-flight.js');
const Edit = require('../../frontend/js/camera-flight-edit.js');
const pose = (x = 0, degrees = 0) => ({ position: [x, 2, 3], quaternion: [0, 0,
    Math.sin(degrees * Math.PI / 360), Math.cos(degrees * Math.PI / 360)], fov: 45 });
function draft() {
    return Flight.create({ title: 'Flight', view: { at: '52,-1,18', mode: 'model', settings: { xray: '0' } },
        frame: { lat: 52, lng: -1, datum: 'model-ground' }, pose: pose() });
}
function moving() {
    const editor = Edit.create(draft()); editor.addView(pose(10)); editor.addView(pose(20));
    return editor;
}
const sameOrientation = (a, b) => Math.abs(a.reduce((sum, x, i) => sum + x * b[i], 0));

describe('pure camera-flight editing', () => {
    it('isolates inputs, getter snapshots, action returns and retained transaction drafts', () => {
        const source = draft(), editor = Edit.create(source);
        source.title = 'mutated'; expect(editor.record.title).toBe('Flight');
        const snapshot = editor.record; snapshot.route[0].position[0] = 999;
        expect(editor.record.route[0].position[0]).toBe(0);
        let retained;
        const result = editor.transact(record => { retained = record; record.title = 'Changed'; });
        retained.title = 'leaked'; result.title = 'leaked return';
        expect(editor.snapshot().title).toBe('Changed'); expect(editor.undo().title).toBe('Flight');
    });

    it('undoes and redoes whole edits while no-ops preserve redo', () => {
        const editor = Edit.create(draft());
        expect(editor.canUndo).toBe(false); expect(editor.canRedo).toBe(false);
        editor.rename(' One '); editor.rename('Two');
        expect(editor.undo().title).toBe('One'); expect(editor.canRedo).toBe(true);
        editor.rename(' One '); editor.transact(() => {});
        expect(editor.canRedo).toBe(true); expect(editor.redo().title).toBe('Two');
        editor.undo(); editor.rename('Three'); expect(editor.canRedo).toBe(false);
        expect(editor.undo().title).toBe('One'); expect(editor.undo().title).toBe('Flight');
        expect(editor.canUndo).toBe(false); expect(editor.undo().title).toBe('Flight');
    });

    it('caps history at 100 complete records', () => {
        const editor = Edit.create(draft());
        for (let i = 1; i <= 105; i++) editor.rename(`Name ${i}`);
        for (let i = 0; i < 100; i++) editor.undo();
        expect(editor.record.title).toBe('Name 5'); expect(editor.canUndo).toBe(false);
        for (let i = 0; i < 100; i++) editor.redo();
        expect(editor.record.title).toBe('Name 105'); expect(editor.canRedo).toBe(false);
    });

    it('rejects failed transactions without changing the record or either history stack', () => {
        const editor = moving(); editor.undo();
        const before = editor.record;
        for (const fail of [() => editor.rename(' '), () => editor.transact(record => { record.fov = null; }),
            () => editor.transact(record => { record.title = 'Partial'; throw new Error('cancel'); }),
            () => editor.addView(pose(30), { travelSeconds: 0 }),
            () => editor.updatePoint(before.route[1].id, { holdSeconds: -1 }),
            () => editor.updatePoint(before.route[0].id, { id: 'replacement' }),
            () => editor.setLook(1000, pose().quaternion), () => editor.setLook(1, [0, 0, 0, 0]),
            () => editor.setCue(1, { xray: 1 }), () => editor.removePoint('missing'),
            () => editor.replace({ ...before, title: ' ' }),
        ]) {
            expect(fail).toThrow(); expect(editor.record).toEqual(before);
            expect(editor.canUndo).toBe(true); expect(editor.canRedo).toBe(true);
        }
        expect(editor.redo().route).toHaveLength(3);
    });

    it('adds views at their arrivals with independent look keys and default timing', () => {
        const editor = Edit.create(draft()), startId = editor.record.route[0].id;
        const second = editor.addView(pose(10, 90), { travelSeconds: 4, holdSeconds: 3 });
        expect(second.route[1]).toMatchObject({ position: [10, 2, 3], travelSeconds: 4, holdSeconds: 3 });
        expect(second.looks.map(key => key.time)).toEqual([0, 4]);
        const third = editor.addView(pose(20, 180));
        expect(third.route[0].id).toBe(startId); expect(third.route[1].id).toBe(second.route[1].id);
        expect(third.looks.map(key => key.time)).toEqual([0, 4, 12]);
        expect(Flight.duration(third)).toBe(12); expect(Flight.validate(third)).toBeNull();
    });

    it('assigns fresh stable IDs when a new edit follows undo or deletion', () => {
        const editor = Edit.create(draft());
        const removed = editor.addView(pose(10)).route[1].id; editor.undo();
        const replacement = editor.addView(pose(20)).route[1].id;
        expect(replacement).not.toBe(removed);
        editor.removePoint(replacement);
        expect(editor.addView(pose(30)).route[1].id).not.toBe(replacement);
    });

    it('updates position/timing and clamps shortened look/cue timelines with end-key deduplication', () => {
        const editor = moving(), route = editor.record.route;
        editor.setLook(7, pose(0, 70).quaternion); editor.setLook(9, pose(0, 90).quaternion);
        editor.setCue(7, { xray: '1' }); editor.setCue(9, { xray: '0' });
        const lastLookId = editor.record.looks.at(-1).id;
        const changed = editor.updatePoint(route[2].id, { position: [3, 4, 5], travelSeconds: 1 });
        expect(Flight.duration(changed)).toBe(6);
        expect(changed.route[2].position).toEqual([3, 4, 5]);
        expect(changed.looks.map(key => key.time)).toEqual([0, 5, 6]);
        expect(changed.looks.at(-1).id).toBe(lastLookId);
        expect(changed.cues).toMatchObject([{ time: 6, settings: { xray: '0' } }]);
        expect(editor.undo().looks.map(key => key.time)).toEqual([0, 5, 7, 9, 10]);
    });

    it('preserves absolute look timing when route timing grows', () => {
        const editor = moving(), before = editor.record.looks;
        const changed = editor.updatePoint(editor.record.route[1].id, { travelSeconds: 10 });
        expect(Flight.duration(changed)).toBe(15); expect(changed.looks).toEqual(before);
    });

    it('deletes points, normalizes the first travel time, and refuses the final deletion', () => {
        const editor = moving(), [a, b, c] = editor.record.route;
        let changed = editor.removePoint(a.id);
        expect(changed.route.map(point => point.id)).toEqual([b.id, c.id]); expect(changed.route[0].travelSeconds).toBe(0);
        changed = editor.removePoint(c.id); expect(changed.route).toHaveLength(1);
        expect(changed.route[0].id).toBe(b.id); expect(changed.looks).toHaveLength(1); expect(changed.looks[0].time).toBe(0);
        const before = editor.record; expect(() => editor.removePoint(b.id)).toThrow(/one/);
        expect(editor.record).toEqual(before);
    });

    it('reorders by relative index with stable IDs and valid first/later timing', () => {
        const editor = moving(), [a, b, c] = editor.record.route, looks = editor.record.looks;
        const changed = editor.movePoint(a.id, 1);
        expect(changed.route.map(point => point.id)).toEqual([b.id, a.id, c.id]);
        expect(changed.route.map(point => point.travelSeconds)).toEqual([0, 5, 5]); expect(changed.looks).toEqual(looks);
        expect(editor.movePoint(c.id, -100).route.map(point => point.id)).toEqual([c.id, b.id, a.id]);
        expect(Flight.validate(editor.record, { draft: true })).toBeNull();
        expect(() => editor.movePoint(a.id, 0.1)).toThrow();
    });

    it('inserts or replaces sorted look keys at the same time and keeps at least one', () => {
        const editor = moving(); editor.setLook(8, pose(0, 80).quaternion); editor.setLook(2, [0, 0, 0, 2]);
        expect(editor.record.looks.map(key => key.time)).toEqual([0, 2, 5, 8, 10]);
        const priorId = editor.record.looks[1].id; editor.setLook(2, pose(0, 45).quaternion);
        expect(editor.record.looks[1].id).toBe(priorId); expect(editor.record.looks).toHaveLength(5);
        while (editor.record.looks.length > 1) editor.removeLook(editor.record.looks[0].id);
        const last = editor.record.looks[0]; expect(() => editor.removeLook(last.id)).toThrow(/one/);
        expect(editor.record.looks).toEqual([last]);
    });

    it('replaces cue settings at a timestamp rather than leaking prior flags', () => {
        const editor = moving(); editor.setCue(8, { xray: '1', suggested: '1' }); editor.setCue(2, { cutaway: '-1' });
        const id = editor.record.cues[1].id; editor.setCue(8, { xray: '0' });
        expect(editor.record.cues.map(cue => cue.time)).toEqual([2, 8]);
        expect(editor.record.cues[1]).toEqual({ id, time: 8, settings: { xray: '0' } });
    });

    it('loads another valid draft as one undoable replacement', () => {
        const editor = moving(), previous = editor.record, next = draft(); next.title = 'Loaded';
        expect(editor.replace(next).title).toBe('Loaded'); next.title = 'external';
        expect(editor.record.title).toBe('Loaded'); expect(editor.undo()).toEqual(previous);
        expect(editor.redo().title).toBe('Loaded');
    });
});

describe('authored full turns', () => {
    it('preserves a stationary complete turn with distinct midpoint orientation and one undo step', () => {
        const editor = Edit.create(draft()); editor.updatePoint(editor.record.route[0].id, { holdSeconds: 10 });
        const before = editor.record, changed = editor.spin(2, 4);
        expect(changed.route).toEqual(before.route);
        expect(changed.looks.map(key => key.time)).toEqual([0, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6]);
        const compiled = Flight.compile(changed), first = compiled.evaluate(2), middle = compiled.evaluate(4), last = compiled.evaluate(6);
        expect(first.position).toEqual(middle.position); expect(last.position).toEqual(first.position);
        expect(sameOrientation(first.quaternion, last.quaternion)).toBeCloseTo(1, 10);
        expect(sameOrientation(first.quaternion, middle.quaternion)).toBeLessThan(0.01);
        expect(editor.undo()).toEqual(before); expect(editor.redo()).toEqual(changed);
    });

    it('retains outside look keys, replaces interval keys and preserves exact endpoint identities', () => {
        const editor = moving(); editor.setLook(3, pose(0, 30).quaternion); editor.setLook(8, pose(0, 80).quaternion);
        const prior = editor.record.looks, changed = editor.spin(0, 5, 'yaw', -2);
        expect(changed.looks.find(key => key.time === 0).id).toBe(prior[0].id);
        expect(changed.looks.find(key => key.time === 5).id).toBe(prior.find(key => key.time === 5).id);
        expect(changed.looks.filter(key => key.time > 5)).toEqual(prior.filter(key => key.time > 5));
        expect(changed.looks.some(key => key.time === 3)).toBe(false);
        const compiled = Flight.compile(changed);
        expect(compiled.evaluate(0.625).quaternion[2]).toBeLessThan(-0.7);
        expect(sameOrientation(compiled.evaluate(0).quaternion, compiled.evaluate(5).quaternion)).toBeCloseTo(1, 10);
    });

    it('applies yaw around world Z and pitch/roll around camera-local axes', () => {
        const initial = draft(); initial.looks[0].quaternion = pose(0, 90).quaternion; initial.route[0].holdSeconds = 4;
        const pitch = Edit.create(initial); pitch.spin(0, 4, 'pitch');
        const qPitch = Flight.compile(pitch.record).evaluate(1).quaternion;
        qPitch.forEach(x => expect(x).toBeCloseTo(0.5, 10));
        const roll = Edit.create(initial); roll.spin(0, 4, 'roll');
        const qRoll = Flight.compile(roll.record).evaluate(1).quaternion;
        expect(sameOrientation(qRoll, [0, 0, 0, 1])).toBeCloseTo(1, 10);
        initial.looks[0].quaternion = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
        const yaw = Edit.create(initial); yaw.spin(0, 4, 'yaw');
        Flight.compile(yaw.record).evaluate(1).quaternion.forEach(x => expect(x).toBeCloseTo(0.5, 10));
    });

    it('rejects invalid spin ranges/axes/turn counts atomically', () => {
        const editor = moving(), before = editor.record;
        for (const args of [[-1, 1], [0, 0], [9, 2], [0, 1, 'unknown'], [0, 1, 'yaw', 0],
            [0, 1, 'yaw', 17], [NaN, 1], [0, Infinity], [0, 1, 'yaw', null]]) {
            expect(() => editor.spin(...args)).toThrow(/spin/); expect(editor.record).toEqual(before);
        }
    });
});
