// Editor transactions preserve stable route identities, point-owned orientation, anchored looks
// and cues, speed-derived timing and turns during holds.
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
// Three views 15 m apart at the default 15 m/s: arrivals 0, 1 and 2 seconds.
function moving() {
    const editor = Edit.create(draft()); editor.addView(pose(15)); editor.addView(pose(30));
    return editor;
}
const sameOrientation = (a, b) => Math.abs(a.reduce((sum, x, i) => sum + x * b[i], 0));
const lookTimes = record => Flight.timeline(record).looks.filter(key => key.kind === 'look').map(key => key.time);

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
        const before = editor.record, [first, second] = before.route;
        for (const fail of [() => editor.rename(' '), () => editor.transact(record => { record.fov = null; }),
            () => editor.transact(record => { record.title = 'Partial'; throw new Error('cancel'); }),
            () => editor.addView(pose(30), { holdSeconds: -1 }), () => editor.addView({ position: null }),
            () => editor.updatePoint(second.id, { holdSeconds: -1 }), () => editor.updatePoint(second.id, { travelSeconds: 0 }),
            () => editor.updatePoint(first.id, { id: 'replacement' }), () => editor.updatePoint(first.id, { quaternion: [0, 0, 0, 0] }),
            () => editor.updatePoint(first.id, { turn: { axis: 'spin', turns: 1 } }), () => editor.updatePoint(first.id, { turn: { axis: 'yaw', turns: 0 } }),
            () => editor.setLook('missing', .5, pose().quaternion), () => editor.setLook(second.id, .5, pose().quaternion),
            () => editor.setLook(first.id, 0, pose().quaternion), () => editor.setLook(first.id, 1, pose().quaternion),
            () => editor.setLook(first.id, .5, [0, 0, 0, 0]), () => editor.removeLook('missing'),
            () => editor.setCue('missing', { xray: '1' }), () => editor.setCue(first.id, { xray: 1 }), () => editor.removeCue('missing'),
            () => editor.removePoint('missing'), () => editor.setSpeed(0), () => editor.setSpeed(NaN),
            () => editor.replace({ ...before, title: ' ' }),
        ]) {
            expect(fail).toThrow(); expect(editor.record).toEqual(before);
            expect(editor.canUndo).toBe(true); expect(editor.canRedo).toBe(true);
        }
        expect(editor.redo().route).toHaveLength(3);
    });

    it('adds views that own their orientation with speed-derived travel and an optional hold', () => {
        const editor = Edit.create(draft()), startId = editor.record.route[0].id;
        const second = editor.addView(pose(30, 90), { holdSeconds: 3 });
        expect(second.route[1]).toEqual({ id: expect.any(String), position: [30, 2, 3], quaternion: pose(0, 90).quaternion, travelSeconds: null, holdSeconds: 3, turn: null });
        expect(Flight.arrivals(second)).toEqual([0, 2]); expect(Flight.duration(second)).toBe(5);
        const third = editor.addView(pose(45, 180));
        expect(third.route[0].id).toBe(startId); expect(third.route[1].id).toBe(second.route[1].id);
        expect(Flight.arrivals(third)).toEqual([0, 2, 6]); expect(Flight.validate(third)).toBeNull();
        expect(third.looks).toEqual([]);
        expect(sameOrientation(Flight.compile(third).evaluate(2).quaternion, pose(0, 90).quaternion)).toBeCloseTo(1, 10);
    });

    it('assigns fresh stable IDs when a new edit follows undo or deletion', () => {
        const editor = Edit.create(draft());
        const removed = editor.addView(pose(10)).route[1].id; editor.undo();
        const replacement = editor.addView(pose(20)).route[1].id;
        expect(replacement).not.toBe(removed);
        editor.removePoint(replacement);
        expect(editor.addView(pose(30)).route[1].id).not.toBe(replacement);
    });

    it('retimes the whole flight from the cruise speed and keeps looks with their views', () => {
        const editor = moving(), [a, b] = editor.record.route;
        editor.setLook(a.id, .5, pose(0, 70).quaternion); editor.setLook(b.id, .25, pose(0, 90).quaternion);
        expect(lookTimes(editor.record)).toEqual([.5, 1.25]);
        const slower = editor.setSpeed(7.5);
        expect(slower.looks).toEqual(editor.record.looks); expect(Flight.arrivals(slower)).toEqual([0, 2, 4]);
        expect(lookTimes(slower)).toEqual([1, 2.5]);
        expect(editor.undo().speedMps).toBe(15);
    });

    it('updates position, orientation and timing overrides while anchored looks and cues follow their view', () => {
        const editor = moving(), [a, b, c] = editor.record.route;
        editor.setLook(a.id, .5, pose(0, 70).quaternion); editor.setCue(b.id, { xray: '1' });
        const changed = editor.updatePoint(b.id, { position: [3, 4, 5], quaternion: pose(0, 45).quaternion, travelSeconds: 4, holdSeconds: 2 });
        expect(changed.route[1]).toMatchObject({ id: b.id, position: [3, 4, 5], quaternion: pose(0, 45).quaternion, travelSeconds: 4, holdSeconds: 2 });
        expect(Flight.arrivals(changed)[1]).toBe(4); expect(lookTimes(changed)).toEqual([2]);
        expect(Flight.timeline(changed).cues).toEqual([{ id: changed.cues[0].id, time: 4, settings: { xray: '1' }, point: b.id }]);
        const automatic = editor.updatePoint(b.id, { travelSeconds: null });
        expect(automatic.route[1].travelSeconds).toBeNull(); expect(Flight.arrivals(automatic)[1]).toBeGreaterThan(0);
        expect(Flight.arrivals(automatic)[1]).not.toBe(4);
        expect(editor.undo().route[1].travelSeconds).toBe(4);
        expect(editor.undo().route).toEqual([a, b, c]);
    });

    it('gives a turn a default hold and drops the turn when the hold returns to zero', () => {
        const editor = moving(), id = editor.record.route[0].id;
        const turning = editor.updatePoint(id, { turn: { axis: 'yaw', turns: 2 } });
        expect(turning.route[0]).toMatchObject({ holdSeconds: Edit.DEFAULT_TURN_HOLD, turn: { axis: 'yaw', turns: 2 } });
        expect(Flight.timeline(turning).looks.filter(key => key.kind === 'turn')).toHaveLength(16);
        const still = editor.updatePoint(id, { holdSeconds: 0 });
        expect(still.route[0]).toMatchObject({ holdSeconds: 0, turn: null });
        expect(editor.undo()).toEqual(turning);
        const kept = editor.updatePoint(id, { holdSeconds: 3, turn: { axis: 'roll', turns: -1 } });
        expect(kept.route[0]).toMatchObject({ holdSeconds: 3, turn: { axis: 'roll', turns: -1 } });
        expect(Flight.duration(kept)).toBe(5);
    });

    it('deletes points with their looks and cues, normalizes the first travel time, and refuses the final deletion', () => {
        const editor = moving(), [a, b, c] = editor.record.route;
        editor.setLook(a.id, .5, pose(0, 70).quaternion); editor.setLook(b.id, .5, pose(0, 80).quaternion); editor.setCue(a.id, { xray: '1' });
        let changed = editor.removePoint(a.id);
        expect(changed.route.map(point => point.id)).toEqual([b.id, c.id]); expect(changed.route[0].travelSeconds).toBeNull();
        expect(changed.looks.map(look => look.after)).toEqual([b.id]); expect(changed.cues).toEqual([]);
        changed = editor.removePoint(c.id); expect(changed.route).toHaveLength(1);
        expect(changed.route[0].id).toBe(b.id); expect(changed.looks).toEqual([]);
        const before = editor.record; expect(() => editor.removePoint(b.id)).toThrow(/one/);
        expect(editor.record).toEqual(before);
    });

    it('reorders by relative index with stable IDs and drops looks that would follow the last view', () => {
        const editor = moving(), [a, b, c] = editor.record.route;
        editor.updatePoint(b.id, { travelSeconds: 4 }); editor.setLook(a.id, .5, pose(0, 70).quaternion); editor.setLook(b.id, .5, pose(0, 80).quaternion);
        const changed = editor.movePoint(a.id, 1);
        expect(changed.route.map(point => point.id)).toEqual([b.id, a.id, c.id]);
        expect(changed.route.map(point => point.travelSeconds)).toEqual([null, null, null]);
        expect(changed.looks.map(look => look.after).sort()).toEqual([a.id, b.id].sort());
        const last = editor.movePoint(a.id, 100);
        expect(last.route.map(point => point.id)).toEqual([b.id, c.id, a.id]); expect(last.looks.map(look => look.after)).toEqual([b.id]);
        expect(Flight.validate(editor.record, { draft: true })).toBeNull();
        expect(() => editor.movePoint(a.id, 0.1)).toThrow();
    });

    it('replaces a look at the same anchor keeping its identity and removes looks by id', () => {
        const editor = moving(), [a] = editor.record.route;
        editor.setLook(a.id, .5, pose(0, 80).quaternion); editor.setLook(a.id, .25, [0, 0, 0, 2]);
        expect(editor.record.looks.map(look => look.fraction).sort()).toEqual([.25, .5]);
        expect(editor.record.looks.find(look => look.fraction === .25).quaternion).toEqual([0, 0, 0, 1]);
        const priorId = editor.record.looks.find(look => look.fraction === .5).id;
        editor.setLook(a.id, .5, pose(0, 45).quaternion);
        expect(editor.record.looks).toHaveLength(2); expect(editor.record.looks.find(look => look.fraction === .5).id).toBe(priorId);
        expect(editor.removeLook(priorId).looks.map(look => look.fraction)).toEqual([.25]);
    });

    it('replaces cue settings at a view rather than leaking prior flags', () => {
        const editor = moving(), [a, b] = editor.record.route;
        editor.setCue(b.id, { xray: '1', suggested: '1' }); editor.setCue(a.id, { cutaway: '-1' });
        const id = editor.record.cues.find(cue => cue.at === b.id).id; editor.setCue(b.id, { xray: '0' });
        expect(editor.record.cues.map(cue => cue.at).sort()).toEqual([a.id, b.id].sort());
        expect(editor.record.cues.find(cue => cue.at === b.id)).toEqual({ id, at: b.id, settings: { xray: '0' } });
        expect(editor.removeCue(id).cues.map(cue => cue.at)).toEqual([a.id]);
    });

    it('loads another valid draft as one undoable replacement', () => {
        const editor = moving(), previous = editor.record, next = draft(); next.title = 'Loaded';
        expect(editor.replace(next).title).toBe('Loaded'); next.title = 'external';
        expect(editor.record.title).toBe('Loaded'); expect(editor.undo()).toEqual(previous);
        expect(editor.redo().title).toBe('Loaded');
    });
});
