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
//
// Drives the real road-drawing.js in the fake browser world (helpers/road-drawing-env.js): the
// close prompt is a showStyledChoice stand-in that records what the drawing looked like when it was
// asked, and the answers are read off the tool (open or closed, drawing kept, road built).

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadRoadDrawing, at, boxRing } from './helpers/road-drawing-env.js';

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

let env = null;
afterEach(() => {
    env?.dispose();
    env = null;
});

// What the drawing looked like each time the user was asked, and the dialog's answer.
let asked;
function dialog(answer) {
    asked = [];
    return async (message, choices) => {
        asked.push({
            message, choices,
            points: env.api.getAllRoadSegments(true).flat().length,
            penDown: env.session.roadHasStarted
        });
        if (answer instanceof Error) throw answer;
        return answer;
    };
}

// The tool open on a road drawn in one continuous run of clicks — the pen is still down.
async function drawRoad(answer, options = {}) {
    env = loadRoadDrawing({ ...options, globals: { showStyledChoice: dialog(answer), ...(options.globals || {}) } });
    await env.api.requestCorridorDrawingTool('road');
    await env.click(at(0, 0));
    await env.click(at(100, 0));
    expect(env.session.roadHasStarted).toBe(true);
}

const built = () => globalThis.instantCreateProposalFromDraft.calls.length;

describe('a drawing that exists is never closed silently', () => {
    it('asks before touching anything', async () => {
        await drawRoad('keep');
        await env.api.cancelRoadDrawing();
        expect(asked).toHaveLength(1);
        expect(asked[0].points).toBe(2);
    });

    it('never touches the active stroke on the way to asking', async () => {
        // This is the bug: the stroke IS the road, so cancelling it first is what emptied the
        // drawing before anyone got to decide what to do with it.
        await drawRoad('keep');
        await env.api.cancelRoadDrawing();
        expect(asked[0].penDown).toBe(true);
    });

    it('reports the tool still open when the user keeps drawing', async () => {
        await drawRoad('keep');
        await expect(env.api.cancelRoadDrawing()).resolves.toBe(false);
        expect(env.session.roadDrawingMode).toBe(true);
        expect(env.session.roadSegments[0]).toHaveLength(2);
    });

    it('reports it closed when the user builds', async () => {
        await drawRoad('build');
        await expect(env.api.cancelRoadDrawing()).resolves.toBe(true);
        expect(built()).toBe(1);
        expect(env.session.roadDrawingMode).toBe(false);
    });

    it('reports it closed when the user discards', async () => {
        await drawRoad('discard');
        await expect(env.api.cancelRoadDrawing()).resolves.toBe(true);
        expect(built()).toBe(0);
        expect(env.session.roadDrawingMode).toBe(false);
    });
});

describe('an empty drawing still just closes', () => {
    it('does not ask about nothing', async () => {
        env = loadRoadDrawing({ globals: { showStyledChoice: dialog('keep') } });
        await env.api.requestCorridorDrawingTool('road');
        await expect(env.api.cancelRoadDrawing()).resolves.toBe(true);
        expect(asked).toEqual([]);
        expect(env.session.roadDrawingMode).toBe(false);
    });

    // Was "tidies the half-placed stroke on its way out" (a stroke cancel before closing). The
    // stroke cancel is retired with the pen lift (road-editor.md decision 5), and closing needs
    // no separate tidy: exitRoadDrawingMode resets every piece of drawing state, a lone click too.
    it('closes through the full reset alone', async () => {
        env = loadRoadDrawing({ globals: { showStyledChoice: dialog('keep') } });
        await env.api.requestCorridorDrawingTool('road');
        await env.click(at(0, 0));
        await expect(env.api.cancelRoadDrawing()).resolves.toBe(true);
        expect(asked).toEqual([]);
        expect(env.session.roadSegments).toEqual([]);
        expect(env.session.roadHasStarted).toBe(false);
        expect(env.map.layers.size).toBe(0);
    });
});

describe('the three answers', () => {
    const prompt = () => env.api.promptCloseDrawnCorridor();

    it('builds the road', async () => {
        await drawRoad('build');
        expect(await prompt()).toBe('build');
        expect(built()).toBe(1);
    });

    it('reports "keep drawing" when the build was sent back and the tool is still open', async () => {
        // Finish reviews the obstacles first; "Choose another route" returns to the drawing. Saying
        // "build" then would let a caller open another tool over it and reset the live drawing.
        const building = { type: 'Feature', properties: { id: 'b1' }, geometry: { type: 'Polygon', coordinates: [boxRing(40, -10, 60, 10)] } };
        await drawRoad('build', {
            globals: {
                detectLoadedBuildingTunnelIntersections: () => [{ id: 'b1', feature: building }],
                resolveBuildingObstacles: async () => ({ action: 'cancel' })
            }
        });
        expect(await prompt()).toBe('keep');
        expect(built()).toBe(0);
        expect(env.session.roadDrawingMode).toBe(true);
    });

    it('discards it only when that is what was chosen', async () => {
        await drawRoad('discard');
        expect(await prompt()).toBe('discard');
        expect(built()).toBe(0);
        expect(env.session.roadSegments).toEqual([]);
    });

    it('does neither when the user keeps drawing', async () => {
        await drawRoad('keep');
        expect(await prompt()).toBe('keep');
        expect(built()).toBe(0);
        expect(env.session.roadSegments[0]).toHaveLength(2);
    });

    it('treats a dismissed dialog as "keep drawing"', async () => {
        // Escape resolves null. The safe reading of "I did not answer" is to change nothing.
        await drawRoad(null);
        expect(await prompt()).toBe('keep');
        expect(built()).toBe(0);
        expect(env.session.roadSegments[0]).toHaveLength(2);
    });

    it('builds rather than discards when the dialog is unavailable', async () => {
        // No dialog is not a licence to destroy the drawing; building loses nothing.
        await drawRoad('keep');
        globalThis.showStyledChoice = undefined;
        expect(await prompt()).toBe('build');
        expect(built()).toBe(1);
    });

    it('builds rather than discards when the dialog throws', async () => {
        await drawRoad(new Error('no dialog'));
        expect(await prompt()).toBe('build');
        expect(built()).toBe(1);
    });

    it('offers building as the primary choice', async () => {
        await drawRoad('keep');
        await prompt();
        const offered = asked[0].choices;
        expect(asked[0].message).toBe('This road has not been built yet. Build it, or discard the drawing?');
        expect(offered.map(c => c.value)).toEqual(['build', 'discard', 'keep']);
        expect(offered.find(c => c.primary).value).toBe('build');
    });
});

describe('opening the other tool respects the answer', () => {
    it('stops entirely when the user kept drawing', async () => {
        await drawRoad('keep');
        await expect(env.api.requestCorridorDrawingTool('track')).resolves.toBe(false);
        expect(env.api.corridorDrawingKind()).toBe('road');
        expect(env.session.roadDrawingMode).toBe(true);
        expect(env.session.roadSegments[0]).toHaveLength(2);
    });

    it('checks that before deciding whether this was the same tool', async () => {
        // The road button again, answered "keep drawing": still a refusal, not "already open".
        await drawRoad('keep');
        await expect(env.api.requestCorridorDrawingTool('road')).resolves.toBe(false);
        expect(env.session.roadSegments[0]).toHaveLength(2);
        // Answered "discard": the same button closed the tool.
        globalThis.showStyledChoice = dialog('discard');
        await expect(env.api.requestCorridorDrawingTool('road')).resolves.toBe(true);
        expect(env.session.roadDrawingMode).toBe(false);
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
