// Closing the drawing tool must not destroy the road.
//
// R (and the X button) close the tool. The close path cancelled the ACTIVE STROKE first and only
// then asked whether there was anything left to finish — but a stroke stays "started" until Escape
// or F, so for a road drawn in one continuous run of clicks the cancel took all of it, the "is
// there anything to finish" test then answered no, and the tool closed having silently destroyed
// the road with no undo.
//
// Two things are locked here: the ORDER (ask while the drawing still exists), and that the answer
// is asked rather than assumed — finishing puts an object on the map the user may not have wanted,
// discarding loses work, so neither is a safe default.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const roadSource = read('../../frontend/js/road-drawing.js');
const dictOf = locale => JSON.parse(read(`../../frontend/i18n/${locale}.json`));
const locales = ['en', 'hr', 'sr', 'es'];

function lift(name) {
    let start = roadSource.indexOf(`function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    // Keep the `async` — the body awaits, and a slice that starts at `function` will not parse.
    if (roadSource.slice(start - 6, start) === 'async ') start -= 6;
    return roadSource.slice(start, roadSource.indexOf('\n}', start) + 2);
}

let calls;
let answer;
let drawable;

// The close path with every collaborator recorded, so the ORDER of what it does is observable.
function loadClosePath() {
    calls = [];
    // eslint-disable-next-line no-new-func
    return new Function(
        'hasDrawableCorridor', 'promptCloseDrawnCorridor', 'cancelActiveRoadStroke',
        'exitRoadDrawingMode', 'roadHasStarted',
        `${lift('cancelRoadDrawing')}; return cancelRoadDrawing;`
    )(
        () => { calls.push('asked-if-drawable'); return drawable; },
        async () => { calls.push('prompted'); return answer; },
        () => { calls.push('cancelled-stroke'); },
        () => { calls.push('closed'); },
        true
    );
}

// The prompt itself, with the dialog stubbed.
function loadPrompt(dialog) {
    calls = [];
    // eslint-disable-next-line no-new-func
    return new Function(
        'corridorDrawingIsTrack', 'translateRoadText', 'showStyledChoice',
        'finishRoadDrawing', 'discardRoadDrawing',
        `${lift('promptCloseDrawnCorridor')}; return promptCloseDrawnCorridor;`
    )(
        () => false,
        (key, fallback) => fallback,
        dialog,
        async () => { calls.push('built'); },
        () => { calls.push('discarded'); }
    );
}

beforeEach(() => { answer = 'keep'; drawable = true; });

describe('a drawing that exists is never closed silently', () => {
    it('asks before touching anything', async () => {
        await loadClosePath()();
        expect(calls[0]).toBe('asked-if-drawable');
        expect(calls[1]).toBe('prompted');
    });

    it('never cancels the active stroke on the way to asking', async () => {
        // This is the bug: the stroke IS the road, so cancelling it first is what emptied the
        // drawing before anyone got to decide what to do with it.
        await loadClosePath()();
        expect(calls).not.toContain('cancelled-stroke');
    });

    it('reports the tool still open when the user keeps drawing', async () => {
        answer = 'keep';
        await expect(loadClosePath()()).resolves.toBe(false);
        expect(calls).not.toContain('closed');
    });

    it('reports it closed when the user builds', async () => {
        answer = 'build';
        await expect(loadClosePath()()).resolves.toBe(true);
    });

    it('reports it closed when the user discards', async () => {
        answer = 'discard';
        await expect(loadClosePath()()).resolves.toBe(true);
    });
});

describe('an empty drawing still just closes', () => {
    it('does not ask about nothing', async () => {
        drawable = false;
        await expect(loadClosePath()()).resolves.toBe(true);
        expect(calls).not.toContain('prompted');
        expect(calls).toContain('closed');
    });

    it('tidies the half-placed stroke on its way out', async () => {
        drawable = false;
        await loadClosePath()();
        expect(calls).toContain('cancelled-stroke');
    });
});

describe('the three answers', () => {
    it('builds the road', async () => {
        expect(await loadPrompt(async () => 'build')()).toBe('build');
        expect(calls).toEqual(['built']);
    });

    it('discards it only when that is what was chosen', async () => {
        expect(await loadPrompt(async () => 'discard')()).toBe('discard');
        expect(calls).toEqual(['discarded']);
    });

    it('does neither when the user keeps drawing', async () => {
        expect(await loadPrompt(async () => 'keep')()).toBe('keep');
        expect(calls).toEqual([]);
    });

    it('treats a dismissed dialog as "keep drawing"', async () => {
        // Escape resolves null. The safe reading of "I did not answer" is to change nothing.
        expect(await loadPrompt(async () => null)()).toBe('keep');
        expect(calls).toEqual([]);
    });

    it('builds rather than discards when the dialog is unavailable', async () => {
        // No dialog is not a licence to destroy the drawing; building loses nothing.
        expect(await loadPrompt(undefined)()).toBe('build');
        expect(calls).toEqual(['built']);
    });

    it('builds rather than discards when the dialog throws', async () => {
        expect(await loadPrompt(async () => { throw new Error('no dialog'); })()).toBe('build');
        expect(calls).toEqual(['built']);
    });

    it('offers building as the primary choice', async () => {
        let offered = null;
        await loadPrompt(async (_message, choices) => { offered = choices; return 'keep'; })();
        expect(offered.map(c => c.value)).toEqual(['build', 'discard', 'keep']);
        expect(offered.find(c => c.primary).value).toBe('build');
    });
});

describe('opening the other tool respects the answer', () => {
    const request = lift('requestCorridorDrawingTool');

    it('stops entirely when the user kept drawing', () => {
        expect(request).toMatch(/const closed = await cancelRoadDrawing\(\);/);
        expect(request).toMatch(/if \(!closed\) return false;/);
    });

    it('checks that before deciding whether this was the same tool', () => {
        expect(request.indexOf('if (!closed) return false;'))
            .toBeLessThan(request.indexOf('if (kind === corridorDrawKind)'));
    });
});

describe('discarding is the only path that loses work', () => {
    it('is reachable only from the prompt', () => {
        const calls = (roadSource.match(/discardRoadDrawing\(\)/g) || []).length;
        const declarations = (roadSource.match(/function discardRoadDrawing\(\)/g) || []).length;
        expect(calls - declarations).toBe(1);   // the one call, inside promptCloseDrawnCorridor
        expect(lift('promptCloseDrawnCorridor')).toContain('discardRoadDrawing()');
    });
});

describe('every locale can ask', () => {
    it.each(locales)('%s has all four strings', locale => {
        const road = dictOf(locale).panel.road;
        ['closeDrawnRoadPrompt', 'closeDrawnTrackPrompt', 'closeDrawnBuild', 'closeDrawnDiscard', 'closeDrawnKeep']
            .forEach(key => {
                expect(road[key], `${locale} is missing panel.road.${key}`).toBeTruthy();
                expect(typeof road[key]).toBe('string');
            });
        expect(road.closeDrawnRoadPrompt).not.toBe(road.closeDrawnTrackPrompt);
    });
});
