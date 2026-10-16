// geometry-edit-history.js — the one undo stack every map geometry editor uses. An undo step must
// always correspond to something the user actually did.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let History;

beforeAll(() => {
    History = require('../../frontend/js/geometry-edit/history.js');
});

// A tiny editor whose "geometry" is a string.
function editor(initial = 'a') {
    const state = { value: initial };
    const history = History.create({
        capture: () => state.value,
        restore: snap => { state.value = snap; }
    });
    return { state, history };
}

describe('record / undo', () => {
    it('restores the state captured before the change', () => {
        const { state, history } = editor('a');
        history.record();
        state.value = 'b';
        expect(history.undo()).toBe(true);
        expect(state.value).toBe('a');
    });

    it('unwinds several steps in order', () => {
        const { state, history } = editor('a');
        history.record(); state.value = 'b';
        history.record(); state.value = 'c';
        history.undo();
        expect(state.value).toBe('b');
        history.undo();
        expect(state.value).toBe('a');
    });

    it('does nothing and reports false with an empty stack', () => {
        const { state, history } = editor('a');
        expect(history.undo()).toBe(false);
        expect(state.value).toBe('a');
    });

    it('tracks whether undo is available', () => {
        const { history } = editor();
        expect(history.canUndo()).toBe(false);
        history.record();
        expect(history.canUndo()).toBe(true);
        history.undo();
        expect(history.canUndo()).toBe(false);
    });
});

describe('depth limit', () => {
    it('keeps only the newest `limit` snapshots', () => {
        const state = { value: 0 };
        const history = History.create({
            limit: 3,
            capture: () => state.value,
            restore: snap => { state.value = snap; }
        });
        for (let i = 0; i < 6; i++) { history.record(); state.value = i + 1; }
        expect(history.depth()).toBe(3);
        history.undo();
        expect(state.value).toBe(5);   // the oldest three were dropped, not the newest
    });
});

describe('discardLast', () => {
    it('removes a snapshot taken for an action that then failed', () => {
        const { state, history } = editor('a');
        history.record();          // action starts…
        history.discardLast();     // …and fails, so it must leave no step
        expect(history.canUndo()).toBe(false);
        expect(state.value).toBe('a');
    });
});

describe('isEqual guard', () => {
    it('refuses a snapshot identical to the top of the stack', () => {
        const state = { value: 'a' };
        const history = History.create({
            capture: () => state.value,
            restore: snap => { state.value = snap; },
            isEqual: (a, b) => a === b
        });
        expect(history.record()).toBe(true);
        expect(history.record()).toBe(false);   // nothing changed in between
        expect(history.depth()).toBe(1);
    });
});

describe('onChange', () => {
    it('reports availability on every stack change', () => {
        const onChange = vi.fn();
        const state = { value: 1 };
        const history = History.create({ capture: () => state.value, restore: s => { state.value = s; }, onChange });
        history.record();
        history.undo();
        expect(onChange).toHaveBeenCalledWith(true);
        expect(onChange).toHaveBeenLastCalledWith(false);
    });
});

describe('bindButton', () => {
    it('drives the button disabled state and undoes on click', () => {
        const listeners = {};
        const button = {
            disabled: false,
            addEventListener: (type, fn) => { listeners[type] = fn; },
            removeEventListener: () => { },
            setAttribute: () => { }
        };
        const { state, history } = editor('a');
        history.bindButton(button);
        expect(button.disabled).toBe(true);       // nothing to undo yet
        history.record();
        state.value = 'b';
        expect(button.disabled).toBe(false);
        listeners.click();
        expect(state.value).toBe('a');
        expect(button.disabled).toBe(true);
    });
});

describe('bindKeyboard', () => {
    function fakeTarget() {
        const handlers = [];
        return {
            handlers,
            addEventListener: (_type, fn) => handlers.push(fn),
            removeEventListener: fn => {
                const i = handlers.indexOf(fn);
                if (i >= 0) handlers.splice(i, 1);
            },
            fire: event => handlers.forEach(fn => fn(event))
        };
    }
    const keyEvent = extra => Object.assign({
        key: 'z', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false,
        target: { tagName: 'DIV' }, preventDefault: () => { }
    }, extra);

    it('undoes on Cmd+Z', () => {
        const target = fakeTarget();
        const { state, history } = editor('a');
        history.bindKeyboard(target);
        history.record(); state.value = 'b';
        target.fire(keyEvent());
        expect(state.value).toBe('a');
    });

    it('leaves typing alone', () => {
        const target = fakeTarget();
        const { state, history } = editor('a');
        history.bindKeyboard(target);
        history.record(); state.value = 'b';
        target.fire(keyEvent({ target: { tagName: 'INPUT' } }));
        expect(state.value).toBe('b');
    });

    it('does not undo on Shift+Cmd+Z — there is no redo to pair it with', () => {
        const target = fakeTarget();
        const { state, history } = editor('a');
        history.bindKeyboard(target);
        history.record(); state.value = 'b';
        target.fire(keyEvent({ shiftKey: true }));
        expect(state.value).toBe('b');
    });

    it('respects an enabled() gate', () => {
        const target = fakeTarget();
        const { state, history } = editor('a');
        let on = false;
        history.bindKeyboard(target, { enabled: () => on });
        history.record(); state.value = 'b';
        target.fire(keyEvent());
        expect(state.value).toBe('b');
        on = true;
        target.fire(keyEvent());
        expect(state.value).toBe('a');
    });
});

describe('redo (opt-in)', () => {
    function redoEditor(initial = 'a') {
        const state = { value: initial };
        const history = History.create({
            redo: true,
            capture: () => state.value,
            restore: snap => { state.value = snap; }
        });
        return { state, history };
    }

    it('replays an undone step, and undo/redo walk the same path both ways', () => {
        const { state, history } = redoEditor('a');
        history.record(); state.value = 'b';
        history.record(); state.value = 'c';
        history.undo(); history.undo();
        expect(state.value).toBe('a');
        expect(history.redo()).toBe(true);
        expect(state.value).toBe('b');
        expect(history.redo()).toBe(true);
        expect(state.value).toBe('c');
        expect(history.redo()).toBe(false);
        history.undo();
        expect(state.value).toBe('b');
    });

    it('drops the redo branch when a new edit is made', () => {
        const { state, history } = redoEditor('a');
        history.record(); state.value = 'b';
        history.undo();
        expect(history.canRedo()).toBe(true);
        history.record(); state.value = 'x';
        expect(history.canRedo()).toBe(false);
        expect(history.redo()).toBe(false);
        expect(state.value).toBe('x');
    });

    it('stays off unless asked for, so other editors keep their behaviour', () => {
        const { state, history } = editor('a');
        history.record(); state.value = 'b';
        history.undo();
        expect(history.canRedo()).toBe(false);
        expect(history.redo()).toBe(false);
        expect(state.value).toBe('a');
    });

    it('redoes on Shift+Cmd+Z and Ctrl+Y, and drives a redo button', () => {
        const listeners = [];
        const target = { addEventListener: (_t, fn) => listeners.push(fn), removeEventListener: () => { } };
        const fire = ev => listeners.forEach(fn => fn({ preventDefault() { }, target: {}, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...ev }));
        let clickRedo = null;
        const button = { disabled: false, addEventListener: (_t, fn) => { clickRedo = fn; }, removeEventListener: () => { }, setAttribute: () => { } };
        const { state, history } = redoEditor('a');
        history.bindKeyboard(target);
        history.bindRedoButton(button);
        history.record(); state.value = 'b';
        expect(button.disabled).toBe(true);
        fire({ key: 'z', metaKey: true });
        expect(state.value).toBe('a');
        expect(button.disabled).toBe(false);
        fire({ key: 'Z', metaKey: true, shiftKey: true });
        expect(state.value).toBe('b');
        fire({ key: 'z', ctrlKey: true });
        expect(state.value).toBe('a');
        fire({ key: 'y', ctrlKey: true });
        expect(state.value).toBe('b');
        history.undo();
        clickRedo();
        expect(state.value).toBe('b');
    });
});
