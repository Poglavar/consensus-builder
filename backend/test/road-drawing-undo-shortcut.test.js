// Undo while drawing a road: U and Ctrl/Cmd+Z must be the same thing.
//
// The drawing tool had U. Every other geometry editor in the app — including the node editor for an
// already-applied road — undoes with Ctrl/Cmd+Z through geometry-edit/history.js, so the drawing
// tool was the one place where the muscle memory failed. Both now call the same function, which is
// itself a no-op when there is nothing to undo, so they cannot drift from each other or from the
// (U) button.
//
// The conventions are copied from the shared history deliberately, and are tested here because a
// keyboard shortcut that fires while you are typing, or that lets the browser's own undo through, is
// worse than not having it.

// Drives the real road-drawing.js in the fake browser world (helpers/road-drawing-env.js): keys are
// dispatched on its document, and what they did is read off the drawing (points, pen, tool, build).

import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { loadRoadDrawing, at, makeElement } from './helpers/road-drawing-env.js';

const require = createRequire(import.meta.url);
const GeometryEditHistory = require('../../frontend/js/geometry-edit/history.js');

let env = null;
afterEach(() => {
    env?.dispose();
    env = null;
});

// The tool open on a three-point road with the pen still down.
async function drawThreePoints() {
    env = loadRoadDrawing();
    await env.api.requestCorridorDrawingTool('road');
    for (const point of [at(0, 0), at(100, 0), at(100, 100)]) await env.click(point);
    expect(env.session.roadPoints).toHaveLength(3);
}

// A keydown with a recording preventDefault, on a plain (non-typing) target, and what it did.
async function key(init) {
    const placed = () => env.api.getAllRoadSegments(true).flat().length;
    const before = placed();
    const event = env.key(init.key ?? 'z', { target: makeElement(null, 'BODY'), ...init });
    await env.idle();
    return { event, undone: before - placed() };
}

describe('Ctrl/Cmd+Z undoes, just like U', () => {
    it('undoes on Ctrl+Z', async () => {
        await drawThreePoints();
        expect((await key({ ctrlKey: true })).undone).toBe(1);
    });

    it('undoes on Cmd+Z', async () => {
        await drawThreePoints();
        expect((await key({ metaKey: true })).undone).toBe(1);
    });

    it('still undoes on U', async () => {
        await drawThreePoints();
        expect((await key({ key: 'u' })).undone).toBe(1);
    });

    it('and on a capital U, since Shift does not change what the key means', async () => {
        await drawThreePoints();
        expect((await key({ key: 'U', shiftKey: true })).undone).toBe(1);
    });

    it('takes the browser undo away while the tool is open', async () => {
        // Otherwise the page's own undo fires alongside — or instead of — the road undo.
        await drawThreePoints();
        expect((await key({ ctrlKey: true })).event.defaultPrevented).toBe(true);
    });
});

describe('what it deliberately does not do', () => {
    it('swallows Shift+Ctrl+Z rather than undoing, because there is no redo', async () => {
        await drawThreePoints();
        const { event, undone } = await key({ ctrlKey: true, shiftKey: true });
        expect(undone).toBe(0);
        expect(event.defaultPrevented).toBe(true);
    });

    it('ignores Alt+Ctrl+Z, which is somebody else’s shortcut', async () => {
        await drawThreePoints();
        const { event, undone } = await key({ ctrlKey: true, altKey: true });
        expect(undone).toBe(0);
        expect(event.defaultPrevented).toBe(false);
    });

    it('leaves a bare Z alone', async () => {
        await drawThreePoints();
        expect((await key({ key: 'z' })).undone).toBe(0);
    });

    it.each(['INPUT', 'TEXTAREA', 'SELECT'])('does nothing while typing in %s', async tagName => {
        await drawThreePoints();
        expect((await key({ ctrlKey: true, target: makeElement(null, tagName) })).undone).toBe(0);
    });

    it('does nothing in a contenteditable either', async () => {
        await drawThreePoints();
        const target = { ...makeElement(null, 'DIV'), isContentEditable: true };
        expect((await key({ ctrlKey: true, target })).undone).toBe(0);
    });

    it('does not finish the road on its way past', async () => {
        // The undo branch returns; falling through would hand Ctrl+Z to the F/Escape handling too.
        await drawThreePoints();
        await key({ ctrlKey: true });
        expect(globalThis.instantCreateProposalFromDraft.calls).toHaveLength(0);
        expect(env.session.roadDrawingMode).toBe(true);
        expect(env.session.roadHasStarted).toBe(true);
    });
});

describe('Escape', () => {
    it('hands over to handleRoadEscape, which decides lift / ask / close when it runs', async () => {
        await drawThreePoints();
        const { event, undone } = await key({ key: 'Escape' });
        expect(event.defaultPrevented).toBe(true);
        // The pen is down, so it is lifted and every point stays.
        expect(env.session.roadHasStarted).toBe(false);
        expect(undone).toBe(0);
        // Never a silent build, never a silent close from the key handler itself.
        expect(globalThis.instantCreateProposalFromDraft.calls).toHaveLength(0);
        expect(env.session.roadDrawingMode).toBe(true);
    });

    it('acts once for a held key: a repeat neither lifts again nor opens the close prompt', async () => {
        await drawThreePoints();
        await key({ key: 'Escape', repeat: true });
        expect(env.session.roadHasStarted).toBe(true);
        expect(globalThis.showStyledChoice.calls).toHaveLength(0);
    });
});

describe('it matches the shared undo, rather than inventing a second set of rules', () => {
    // The shared history bound to a fake target with one step on its stack: did a key undo it, and
    // did it take the browser's undo away?
    function sharedAnswer(init) {
        let handler = null;
        let restored = 0;
        const history = GeometryEditHistory.create({ capture: () => ({}), restore: () => { restored += 1; } });
        history.record();
        history.bindKeyboard({ addEventListener: (_type, fn) => { handler = fn; }, removeEventListener: () => {} });
        const event = {
            key: 'z', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
            target: makeElement(null, 'BODY'), defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; },
            ...init
        };
        handler(event);
        return { undone: restored, prevented: event.defaultPrevented };
    }

    async function roadAnswer(init) {
        await drawThreePoints();
        const { event, undone } = await key(init);
        env.dispose();
        env = null;
        return { undone, prevented: event.defaultPrevented };
    }

    const cases = {
        'excludes Alt the same way': { ctrlKey: true, altKey: true },
        'matches the key case-insensitively the same way': { ctrlKey: true, key: 'Z' },
        'swallows Shift the same way': { metaKey: true, shiftKey: true },
        'guards contenteditable the same way': { ctrlKey: true, target: { ...makeElement(null, 'DIV'), isContentEditable: true } },
        'guards a text field the same way': { metaKey: true, target: makeElement(null, 'INPUT') }
    };

    it.each(Object.entries(cases))('%s', async (_name, init) => {
        expect(await roadAnswer(init)).toEqual(sharedAnswer(init));
    });
});
