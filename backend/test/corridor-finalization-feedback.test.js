// Finishing a drawn corridor has to LOOK like it is happening.
//
// Pressing F starts a graph normalization, a parcel query and a full fabric replay — seconds of work
// on a long track — and it used to run with no sign at all. Worse, the drawing tool was torn down
// first, so the road the user had just drawn vanished and the map sat empty until the finished
// object appeared. The two halves of the fix are tested here:
//
//   1. the spinner covers the WHOLE run (it is the same ref-counted indicator an applied-corridor
//      edit already used, so there is one indicator, not two competing ones), and the pointer goes
//      busy with it;
//   2. the drawn layers are DETACHED rather than deleted, and disposed only once the object exists.
//
// The ordering in (2) is the whole bug, and nothing about it is observable from a return value —
// so the real road-drawing.js is loaded into the fake browser world (helpers/road-drawing-env.js),
// with the corridor-render.js stand-in drawing its strips, and the create stand-in looks at the map
// while it runs: a refactor that moves the dismissal back before the create finds the map empty
// there and fails.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadRoadDrawing, at } from './helpers/road-drawing-env.js';

const require = createRequire(import.meta.url);
const corridorProfile = require('../../frontend/js/corridor-profile.js');
const corridorGeometry = require('../../frontend/js/corridor-geometry.js');
const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const detailsSource = read('../../frontend/js/proposals/details-panel.js');
const locales = ['en', 'hr', 'sr', 'es'];
const dictOf = locale => JSON.parse(read(`../../frontend/i18n/${locale}.json`));

let env = null;
afterEach(() => {
    env?.dispose();
    env = null;
});

function loadDisposer() {
    env = env || loadRoadDrawing();
    return env.api.corridorGhostDisposer;
}

// A fake Leaflet map that records what it was asked to remove.
function fakeMap(present = []) {
    const on = new Set(present);
    return {
        removed: [],
        hasLayer: layer => on.has(layer),
        removeLayer(layer) { on.delete(layer); this.removed.push(layer); }
    };
}

// The tool open on a drawn road whose cross-section is on the map: its land and its strips.
async function drawRoad(globals = {}) {
    env = loadRoadDrawing({ renderer: true, globals });
    await env.api.requestCorridorDrawingTool('road');
    await env.click(at(0, 0));
    await env.click(at(100, 0));
    const land = env.session.roadPolygonLayer;
    const strips = env.session.roadStripLayer;
    expect(env.map.hasLayer(land)).toBe(true);
    expect(env.map.hasLayer(strips)).toBe(true);
    return { land, strips };
}

describe('the drawn corridor is disposed once, when the object is ready', () => {
    it('removes every layer it was handed', () => {
        const polygon = { id: 'polygon' };
        const strips = { id: 'strips' };
        const map = fakeMap([polygon, strips]);
        loadDisposer()(map, [polygon, strips])();
        expect(map.removed).toEqual([polygon, strips]);
    });

    it('removes nothing until it is called — that is the point of holding them', () => {
        const polygon = { id: 'polygon' };
        const map = fakeMap([polygon]);
        loadDisposer()(map, [polygon]);
        expect(map.removed).toEqual([]);
    });

    it('is idempotent, because success and failure both dispose it', () => {
        const polygon = { id: 'polygon' };
        const map = fakeMap([polygon]);
        const dispose = loadDisposer()(map, [polygon]);
        dispose();
        dispose();
        expect(map.removed).toEqual([polygon]);
    });

    it('leaves alone a layer the map no longer holds', () => {
        const gone = { id: 'gone' };
        const map = fakeMap([]);
        loadDisposer()(map, [gone])();
        expect(map.removed).toEqual([]);
    });

    it('one layer that throws does not strand the others', () => {
        const bad = { id: 'bad' };
        const good = { id: 'good' };
        const map = fakeMap([bad, good]);
        const guarded = {
            hasLayer: layer => map.hasLayer(layer),
            removeLayer(layer) {
                if (layer === bad) throw new Error('already gone');
                map.removeLayer(layer);
            }
        };
        expect(() => loadDisposer()(guarded, [bad, good])()).not.toThrow();
        expect(map.removed).toEqual([good]);
    });

    it('survives being handed nothing at all', () => {
        expect(() => loadDisposer()(fakeMap(), null)()).not.toThrow();
        expect(() => loadDisposer()(null, [{ id: 'x' }])()).not.toThrow();
    });
});

describe('the drawing is hidden from the teardown, not deleted by it', () => {
    it('holds both the corridor fill and its cross-section strips', async () => {
        const { land, strips } = await drawRoad();
        env.api.detachDrawnCorridorAsGhost();
        expect(env.map.hasLayer(land)).toBe(true);
        expect(env.map.hasLayer(strips)).toBe(true);
    });

    it('clears the references resetRoadDrawing would remove them through', async () => {
        // resetRoadDrawing removes roadPolygonLayer and calls clearRoadStripLayer(); both are
        // guarded on the variable being set, so nulling them is what keeps the layers on the map.
        const { land, strips } = await drawRoad();
        env.api.detachDrawnCorridorAsGhost();
        expect(env.session.roadPolygonLayer).toBeNull();
        expect(env.session.roadStripLayer).toBeNull();
        env.api.exitRoadDrawingMode();
        expect([...env.map.layers]).toEqual([land, strips]);
    });

    it('still removes them through the disposer it returns', async () => {
        const { land, strips } = await drawRoad();
        const dismiss = env.api.detachDrawnCorridorAsGhost();
        env.api.exitRoadDrawingMode();
        dismiss();
        expect(env.map.hasLayer(land)).toBe(false);
        expect(env.map.hasLayer(strips)).toBe(false);
        expect(env.map.layers.size).toBe(0);
    });
});

describe('finalization order: hold, tear down, build, then let go', () => {
    // A create that looks at the tool and the map while it runs, and resolves (or fails) on release.
    function watchedCreate() {
        const seen = [];
        let settle = null;
        const create = async () => {
            seen.push({
                drawing: env.session.roadDrawingMode,
                layers: [...env.map.layers],
                busy: env.document.body.classList.contains('corridor-busy'),
                indicator: env.session.corridorApplyIndicatorCount
            });
            return new Promise((resolve, reject) => { settle = { resolve, reject }; });
        };
        return { create, seen, settle: () => settle };
    }
    const untilCalled = async watched => { while (!watched.settle()) await new Promise(resolve => setTimeout(resolve, 0)); };

    it('detaches the drawing before the tool is torn down', async () => {
        const watched = watchedCreate();
        const { land, strips } = await drawRoad();
        globalThis.instantCreateProposalFromDraft = watched.create;
        const finishing = env.api.finishRoadDrawing();
        await untilCalled(watched);
        // The tool is down, and the drawing it drew is still exactly where it was.
        expect(watched.seen[0].drawing).toBe(false);
        expect(watched.seen[0].layers).toEqual([land, strips]);
        watched.settle().resolve('p-1');
        await finishing;
    });

    it('creates the object only after the drawing is safely held', async () => {
        const watched = watchedCreate();
        const { land } = await drawRoad();
        globalThis.instantCreateProposalFromDraft = watched.create;
        const finishing = env.api.finishRoadDrawing();
        await untilCalled(watched);
        expect(watched.seen).toHaveLength(1);
        expect(watched.seen[0].layers).toContain(land);
        watched.settle().resolve('p-1');
        await finishing;
    });

    it('lets the drawing go only after the create has resolved', async () => {
        const watched = watchedCreate();
        await drawRoad();
        globalThis.instantCreateProposalFromDraft = watched.create;
        const finishing = env.api.finishRoadDrawing();
        await untilCalled(watched);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(env.map.layers.size).toBe(2);   // still held while the create is under way
        watched.settle().resolve('p-1');
        await finishing;
        expect(env.map.layers.size).toBe(0);
    });

    it('lets it go on failure too, or the ghost outlives the tool that reopens', async () => {
        const watched = watchedCreate();
        await drawRoad();
        globalThis.instantCreateProposalFromDraft = watched.create;
        const finishing = env.api.finishRoadDrawing();
        await untilCalled(watched);
        watched.settle().reject(new Error('create failed'));
        await expect(finishing).rejects.toThrow('create failed');
        expect(env.map.layers.size).toBe(0);
    });
});

describe('the spinner covers the whole run', () => {
    it('starts before any of the work', async () => {
        const normalizeCorridorGraph = vi.fn(corridorGeometry.normalizeCorridorGraph);
        let atCreate = null;
        await drawRoad({ normalizeCorridorGraph });
        globalThis.instantCreateProposalFromDraft = async () => {
            atCreate = { busy: env.document.body.classList.contains('corridor-busy'), indicator: env.session.corridorApplyIndicatorCount };
            return 'p-1';
        };
        const finishing = env.api.finishRoadDrawing();
        await Promise.resolve();
        await Promise.resolve();
        expect(env.session.corridorApplyIndicatorCount).toBe(1);
        expect(env.document.body.classList.contains('corridor-busy')).toBe(true);
        await finishing;
        expect(normalizeCorridorGraph).toHaveBeenCalledTimes(1);
        expect(atCreate).toEqual({ busy: true, indicator: 1 });
    });

    it('ends however the run ends — every early return in there is a return, not a throw', async () => {
        // Built, refused (a cross-section change still waiting) and failed: the indicator is down each time.
        await drawRoad();
        await env.api.finishRoadDrawing();
        expect(env.session.corridorApplyIndicatorCount).toBe(0);
        env.dispose();

        await drawRoad();
        env.session.roadDrawingProfileValidationPending = true;
        await expect(env.api.finishRoadDrawing()).resolves.toBe(false);
        expect(env.session.corridorApplyIndicatorCount).toBe(0);
        expect(env.document.body.classList.contains('corridor-busy')).toBe(false);
        env.dispose();

        await drawRoad();
        globalThis.instantCreateProposalFromDraft = async () => { throw new Error('create failed'); };
        await expect(env.api.finishRoadDrawing()).rejects.toThrow('create failed');
        expect(env.session.corridorApplyIndicatorCount).toBe(0);
        expect(env.document.body.classList.contains('corridor-busy')).toBe(false);
    });

    it('yields once so the indicator paints before the synchronous geometry work', async () => {
        // Without this the main thread is held from the keypress onwards and the spinner — which
        // fades in on a CSS delay — never gets a frame in which to appear.
        const normalizeCorridorGraph = vi.fn(corridorGeometry.normalizeCorridorGraph);
        await drawRoad({ normalizeCorridorGraph });
        const finishing = env.api.finishRoadDrawing();
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
        // Every microtask has run: the indicator is up, and the geometry still waits for the next task.
        expect(env.session.corridorApplyIndicatorCount).toBe(1);
        expect(normalizeCorridorGraph).not.toHaveBeenCalled();
        await finishing;
        expect(normalizeCorridorGraph).toHaveBeenCalledTimes(1);
    });

    it('names what is being built from the lanes, not from the button that opened the tool', async () => {
        env = loadRoadDrawing();
        await env.api.requestCorridorDrawingTool('road');
        expect(env.api.corridorFinalizationLabel()).toBe('Building the road…');
        // A tram lane in the road's cross-section makes it a track.
        env.session.roadProfile = corridorProfile.corridorDefaultTrackProfile();
        expect(env.api.corridorFinalizationLabel()).toBe('Building the track…');
        globalThis.i18n = { t: key => ({ 'panel.road.buildingTrack': 'Gradi se pruga…' })[key] || key };
        expect(env.api.corridorFinalizationLabel()).toBe('Gradi se pruga…');
    });
});

describe('the indicator itself', () => {
    let release;

    // The apply is said by the status line (ephemerals.md): the label once the short delay has run
    // out, and a status activity held for as long as the apply lasts.
    // The tool is loaded first, so the globals it restores on dispose are the real timers.
    beforeEach(() => {
        release = vi.fn();
        env = loadRoadDrawing({ globals: { beginStatusActivity: vi.fn(() => release) } });
        vi.useFakeTimers();
    });

    afterEach(() => { vi.useRealTimers(); });

    const indicator = {
        begin: label => env.api.beginApplyIndicator(label),
        end: () => env.api.endApplyIndicator()
    };
    const settle = () => vi.advanceTimersByTime(150);
    const held = () => globalThis.beginStatusActivity.mock.calls.length - release.mock.calls.length;
    const busy = () => env.document.body.classList.contains('corridor-busy');
    const statusCalls = () => globalThis.updateStatus.calls;

    it('says the label it is given on the status line', () => {
        indicator.begin('Building the track…');
        settle();
        expect(statusCalls()).toEqual([['Building the track…', { transient: true }]]);
        expect(globalThis.beginStatusActivity).toHaveBeenCalledTimes(1);
    });

    it('falls back to the generic apply label when given none', () => {
        indicator.begin();
        settle();
        expect(statusCalls()).toEqual([['Applying…', { transient: true }]]);
    });

    it('a quick apply never reaches the status line', () => {
        indicator.begin('x');
        indicator.end();
        settle();
        expect(statusCalls()).toEqual([]);
        expect(globalThis.beginStatusActivity).not.toHaveBeenCalled();
    });

    it('marks the document busy so the pointer says so too', () => {
        indicator.begin('x');
        expect(busy()).toBe(true);
    });

    it('stays up until the last overlapping claim ends', () => {
        indicator.begin('x');
        indicator.begin('y');
        settle();
        indicator.end();
        expect(held()).toBe(1);
        expect(busy()).toBe(true);
        expect(env.api.isCorridorApplyInFlight()).toBe(true);
        indicator.end();
        expect(held()).toBe(0);
        expect(busy()).toBe(false);
        expect(env.api.isCorridorApplyInFlight()).toBe(false);
    });

    it('never leaves the pointer busy after an unbalanced end', () => {
        indicator.begin('x');
        settle();
        indicator.end();
        indicator.end();
        expect(busy()).toBe(false);
        indicator.begin('x');
        indicator.end();
        expect(held()).toBe(0);
    });
});

describe('finishing an empty drawing does nothing at all', () => {
    const load = (segments, active = null) => {
        env?.dispose();
        env = loadRoadDrawing();
        env.session.roadSegments = segments;
        if (active) {
            env.session.roadPoints = active;
            env.session.roadHasStarted = true;
        }
        return env.api.hasDrawableCorridor;
    };

    it('two placed points are a line', () => {
        expect(load([[{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }]])()).toBe(true);
    });

    it('a stroke of one click is not', () => {
        expect(load([[{ lat: 1, lng: 1 }]])()).toBe(false);
    });

    it('nothing drawn is not', () => {
        expect(load([])()).toBe(false);
    });

    it('one drawable segment among stubs is enough', () => {
        expect(load([[{ lat: 1, lng: 1 }], [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }]])()).toBe(true);
    });

    it('counts the stroke in progress, not only committed segments', () => {
        // getAllRoadSegments(true) — F during an unfinished stroke still finishes the road.
        expect(load([], [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }])()).toBe(true);
    });

    // A lone click on the open tool, with every class the body is given recorded.
    async function loneClick() {
        env = loadRoadDrawing();
        const added = [];
        const add = env.document.body.classList.add;
        env.document.body.classList.add = (...names) => { added.push(...names); add(...names); };
        await env.api.requestCorridorDrawingTool('road');
        await env.click(at(0, 0));
        return added;
    }

    it('is checked before the spinner, so an empty finish never flashes one', async () => {
        const added = await loneClick();
        await expect(env.api.finishRoadDrawing()).resolves.toBe(false);
        expect(added).not.toContain('corridor-busy');
        expect(globalThis.updateStatus.calls.flat()).not.toContain('Building the road…');
    });

    it('is checked before the gate, so an empty finish cannot block a real one', async () => {
        await loneClick();
        const empty = env.api.finishRoadDrawing();
        expect(env.session.roadFinalizationGate.isRunning()).toBe(false);
        await empty;
        await env.click(at(100, 0));
        env.key('f');
        await env.idle();
        expect(globalThis.instantCreateProposalFromDraft.calls).toHaveLength(1);
    });

    it('every entry point asks the same question', async () => {
        // The Finish (F) button reached finalization on an empty drawing because only the keyboard
        // paths tested it. Each of them now defers to the predicate rather than restating it — the
        // Finish button by way of finishRoadDrawing, which is where the check moved to.
        const added = await loneClick();
        // F and Enter on a lone click: not taken, nothing built.
        expect(env.key('f').defaultPrevented).toBe(false);
        expect(env.key('Enter').defaultPrevented).toBe(false);
        // The Finish button.
        env.api.finishRoadOrTrackDrawing();
        await env.idle();
        expect(added).not.toContain('corridor-busy');
        expect(globalThis.instantCreateProposalFromDraft.calls).toHaveLength(0);
        // Escape with the pen up and nothing drawable closes; closing asks nothing about a lone click.
        env.session.roadHasStarted = false;
        env.api.handleRoadEscape();
        expect(env.session.roadDrawingMode).toBe(false);
        await env.api.requestCorridorDrawingTool('road');
        await env.click(at(0, 0));
        await expect(env.api.cancelRoadDrawing()).resolves.toBe(true);
        expect(globalThis.showStyledChoice.calls).toHaveLength(0);
    });
});

describe('the Drive button is short', () => {
    it.each(locales)('%s says it in a word', locale => {
        const label = dictOf(locale).panel.proposal.actions.drive;
        expect(label, `${locale} is missing the drive label`).toBeTruthy();
        // It sits inline beside Share/Edit/Details with an emoji in front — a sentence wraps the row.
        expect(label.split(/\s+/).length, `${locale} drive label is a phrase: "${label}"`).toBe(1);
    });

    it('the code fallback agrees with English, so a missing dictionary reads the same', () => {
        const call = detailsSource.slice(detailsSource.indexOf("tProposal('panel.proposal.actions.drive'"));
        expect(call.slice(0, call.indexOf(')'))).toContain(`'${dictOf('en').panel.proposal.actions.drive}'`);
    });
});

describe('every locale can say what is being built', () => {
    it.each(locales)('%s has both building labels', locale => {
        const road = dictOf(locale).panel.road;
        expect(road.buildingRoad, `${locale} is missing panel.road.buildingRoad`).toBeTruthy();
        expect(road.buildingTrack, `${locale} is missing panel.road.buildingTrack`).toBeTruthy();
        expect(road.buildingRoad).not.toBe(road.buildingTrack);
    });
});
