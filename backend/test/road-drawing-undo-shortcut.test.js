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

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const roadSource = read('../../frontend/js/road-drawing.js');
const historySource = read('../../frontend/js/geometry-edit/history.js');

function lift(name) {
    const start = roadSource.indexOf(`function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    return roadSource.slice(start, roadSource.indexOf('\n}', start) + 2);
}

let calls;
let handle;

beforeEach(() => {
    calls = { undo: 0, finish: 0, exit: 0, cancelStroke: 0, status: [] };
    // eslint-disable-next-line no-new-func
    handle = new Function(
        'undoLastRoadSegment', 'finishRoadDrawing', 'exitRoadDrawingMode', 'cancelActiveRoadStroke',
        'updateStatus', 'translateRoadText', 'hasDrawableCorridor', 'roadFinalizationGate',
        'roadSegmentPlacementInProgress', 'roadHasStarted',
        `${lift('handleRoadKeydown')}; return handleRoadKeydown;`
    )(
        () => { calls.undo += 1; },
        () => { calls.finish += 1; },
        () => { calls.exit += 1; },
        () => { calls.cancelStroke += 1; },
        message => calls.status.push(message),
        (key, fallback) => fallback,
        () => true,
        { isRunning: () => false },
        false,
        false
    );
});

// A keydown with a recording preventDefault, on a plain (non-typing) target.
function key(init) {
    const event = {
        key: 'z',
        metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false,
        target: { tagName: 'BODY', isContentEditable: false },
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        ...init
    };
    handle(event);
    return event;
}

describe('Ctrl/Cmd+Z undoes, just like U', () => {
    it('undoes on Ctrl+Z', () => {
        key({ ctrlKey: true });
        expect(calls.undo).toBe(1);
    });

    it('undoes on Cmd+Z', () => {
        key({ metaKey: true });
        expect(calls.undo).toBe(1);
    });

    it('still undoes on U', () => {
        key({ key: 'u' });
        expect(calls.undo).toBe(1);
    });

    it('and on a capital U, since Shift does not change what the key means', () => {
        key({ key: 'U', shiftKey: true });
        expect(calls.undo).toBe(1);
    });

    it('takes the browser undo away while the tool is open', () => {
        // Otherwise the page's own undo fires alongside — or instead of — the road undo.
        expect(key({ ctrlKey: true }).defaultPrevented).toBe(true);
    });
});

describe('what it deliberately does not do', () => {
    it('swallows Shift+Ctrl+Z rather than undoing, because there is no redo', () => {
        const event = key({ ctrlKey: true, shiftKey: true });
        expect(calls.undo).toBe(0);
        expect(event.defaultPrevented).toBe(true);
    });

    it('ignores Alt+Ctrl+Z, which is somebody else’s shortcut', () => {
        const event = key({ ctrlKey: true, altKey: true });
        expect(calls.undo).toBe(0);
        expect(event.defaultPrevented).toBe(false);
    });

    it('leaves a bare Z alone', () => {
        key({ key: 'z' });
        expect(calls.undo).toBe(0);
    });

    it.each(['INPUT', 'TEXTAREA', 'SELECT'])('does nothing while typing in %s', tagName => {
        key({ ctrlKey: true, target: { tagName, isContentEditable: false } });
        expect(calls.undo).toBe(0);
    });

    it('does nothing in a contenteditable either', () => {
        key({ ctrlKey: true, target: { tagName: 'DIV', isContentEditable: true } });
        expect(calls.undo).toBe(0);
    });

    it('does not finish the road on its way past', () => {
        // The undo branch returns; falling through would hand Ctrl+Z to the F/Escape handling too.
        key({ ctrlKey: true });
        expect(calls.finish).toBe(0);
        expect(calls.exit).toBe(0);
    });
});

describe('it matches the shared undo, rather than inventing a second set of rules', () => {
    const shared = historySource.slice(historySource.indexOf('function bindKeyboard('));
    const branch = lift('handleRoadKeydown');

    it('excludes Alt the same way', () => {
        expect(shared).toContain('event.altKey');
        expect(branch).toContain('!e.altKey');
    });

    it('matches the key case-insensitively the same way', () => {
        expect(shared).toMatch(/toLowerCase\(\) !== 'z'/);
        expect(branch).toMatch(/toLowerCase\(\) === 'z'/);
    });

    it('swallows Shift the same way', () => {
        expect(shared).toMatch(/if \(event\.shiftKey\) return;/);
        expect(branch).toMatch(/if \(e\.shiftKey\) return;/);
    });

    it('guards contenteditable the same way', () => {
        expect(shared).toContain('isContentEditable');
        expect(branch).toContain('isContentEditable');
    });
});
