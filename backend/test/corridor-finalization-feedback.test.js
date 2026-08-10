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
// so the disposer is exercised for real against a fake map, and the call ORDER around the await is
// pinned against the source. A refactor that moves the dismissal back before the create would keep
// every behavioural test green while restoring the blank map.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const roadSource = read('../../frontend/js/road-drawing.js');
const detailsSource = read('../../frontend/js/proposals/details-panel.js');
const locales = ['en', 'hr', 'sr', 'es'];
const dictOf = locale => JSON.parse(read(`../../frontend/i18n/${locale}.json`));

// Lift a real function out of the classic script and run it with its collaborators injected.
function lift(name) {
    const start = roadSource.indexOf(`function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    const end = roadSource.indexOf('\n}', start);
    return roadSource.slice(start, end + 2);
}

function loadDisposer() {
    // eslint-disable-next-line no-new-func
    return new Function(`${lift('corridorGhostDisposer')}; return corridorGhostDisposer;`)();
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
    const detach = lift('detachDrawnCorridorAsGhost');

    it('holds both the corridor fill and its cross-section strips', () => {
        expect(detach).toMatch(/\[roadPolygonLayer, roadStripLayer\]/);
    });

    it('clears the references resetRoadDrawing would remove them through', () => {
        // resetRoadDrawing removes roadPolygonLayer and calls clearRoadStripLayer(); both are
        // guarded on the variable being set, so nulling them is what keeps the layers on the map.
        expect(detach).toMatch(/roadPolygonLayer = null;/);
        expect(detach).toMatch(/roadStripLayer = null;/);
    });

    it('still removes them through the disposer it returns', () => {
        expect(detach).toMatch(/return corridorGhostDisposer\(map, held\)/);
    });
});

describe('finalization order: hold, tear down, build, then let go', () => {
    const branch = (() => {
        const start = roadSource.indexOf("window.syncActiveProposalDraftFromEditor?.('corridor'");
        expect(start, 'instant-create branch not found').toBeGreaterThan(-1);
        return roadSource.slice(start, roadSource.indexOf('    // Legacy path', start));
    })();

    const at = needle => {
        const index = branch.indexOf(needle);
        expect(index, `${needle} not found in the instant-create branch`).toBeGreaterThan(-1);
        return index;
    };

    it('detaches the drawing before the tool is torn down', () => {
        expect(at('detachDrawnCorridorAsGhost()')).toBeLessThan(at('exitRoadDrawingMode()'));
    });

    it('creates the object only after the drawing is safely held', () => {
        // The CALL, not the prose above it that names the same function.
        expect(at('detachDrawnCorridorAsGhost()')).toBeLessThan(at('await window.instantCreateProposalFromDraft'));
    });

    it('lets the drawing go only after the create has resolved', () => {
        expect(at('await window.instantCreateProposalFromDraft')).toBeLessThan(at('dismissGhost()'));
    });

    it('lets it go on failure too, or the ghost outlives the tool that reopens', () => {
        expect(branch).toMatch(/finally \{[\s\S]*dismissGhost\(\);[\s\S]*\}/);
    });
});

describe('the spinner covers the whole run', () => {
    const wrapper = (() => {
        const start = roadSource.indexOf('function finishRoadDrawing()');
        return roadSource.slice(start, roadSource.indexOf('\n}', start) + 2);
    })();

    it('starts before any of the work', () => {
        expect(wrapper.indexOf('beginCorridorApplyIndicator'))
            .toBeLessThan(wrapper.indexOf('finishRoadDrawingOnce'));
    });

    it('ends however the run ends — every early return in there is a return, not a throw', () => {
        expect(wrapper).toMatch(/finally \{[\s\S]*endCorridorApplyIndicator\(\);[\s\S]*\}/);
    });

    it('yields once so the indicator paints before the synchronous geometry work', () => {
        // Without this the main thread is held from the keypress onwards and the spinner — which
        // fades in on a CSS delay — never gets a frame in which to appear.
        const yieldAt = wrapper.search(/await new Promise\(/);
        expect(yieldAt).toBeGreaterThan(-1);
        expect(yieldAt).toBeLessThan(wrapper.indexOf('finishRoadDrawingOnce'));
    });

    it('names what is being built from the lanes, not from the button that opened the tool', () => {
        const label = lift('corridorFinalizationLabel');
        expect(label).toMatch(/corridorDrawingIsTrack/);
        expect(label).toMatch(/panel\.road\.buildingTrack/);
        expect(label).toMatch(/panel\.road\.buildingRoad/);
    });
});

describe('the indicator itself', () => {
    let env;
    let indicator;

    // The pair shares module-level state, so they are lifted together with their variables.
    const source = (() => {
        const start = roadSource.indexOf('let corridorApplyIndicatorCount = 0;');
        expect(start, 'indicator state not found').toBeGreaterThan(-1);
        return roadSource.slice(start, roadSource.indexOf('// True while any corridor re-apply', start));
    })();

    function element(className) {
        return { className, children: [], parentNode: null, textContent: '', appendChild(child) { this.children.push(child); } };
    }

    beforeEach(() => {
        const host = element('host');
        host.removeChild = child => { host.children = host.children.filter(c => c !== child); child.parentNode = null; };
        const classes = new Set();
        env = {
            host,
            classes,
            document: {
                body: { classList: { add: c => classes.add(c), remove: c => classes.delete(c) } },
                createElement: () => element('')
            }
        };
        env.document.body.appendChild = child => { host.children.push(child); child.parentNode = host; };
        // eslint-disable-next-line no-new-func
        indicator = new Function('document', 'map', 'translateRoadText',
            `${source}; return { begin: beginCorridorApplyIndicator, end: endCorridorApplyIndicator };`
        )(env.document, { getContainer: () => host }, (key, fallback) => fallback);
        host.appendChild = child => { host.children.push(child); child.parentNode = host; };
    });

    const shown = () => env.host.children.length;

    it('shows the label it is given', () => {
        indicator.begin('Building the track…');
        expect(env.host.children[0].children.map(c => c.textContent).join('')).toBe('Building the track…');
    });

    it('falls back to the generic apply label when given none', () => {
        indicator.begin();
        expect(env.host.children[0].children.map(c => c.textContent).join('')).toBe('Applying…');
    });

    it('marks the document busy so the pointer says so too', () => {
        indicator.begin('x');
        expect(env.classes.has('corridor-busy')).toBe(true);
    });

    it('stays up until the last overlapping claim ends', () => {
        indicator.begin('x');
        indicator.begin('y');
        indicator.end();
        expect(shown()).toBe(1);
        expect(env.classes.has('corridor-busy')).toBe(true);
        indicator.end();
        expect(shown()).toBe(0);
        expect(env.classes.has('corridor-busy')).toBe(false);
    });

    it('never leaves the pointer busy after an unbalanced end', () => {
        indicator.begin('x');
        indicator.end();
        indicator.end();
        expect(env.classes.has('corridor-busy')).toBe(false);
        indicator.begin('x');
        indicator.end();
        expect(shown()).toBe(0);
    });
});

describe('finishing an empty drawing does nothing at all', () => {
    // eslint-disable-next-line no-new-func
    const load = segments => new Function('getAllRoadSegments',
        `${lift('hasDrawableCorridor')}; return hasDrawableCorridor;`)(() => segments);

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
        expect(lift('hasDrawableCorridor')).toMatch(/getAllRoadSegments\(true\)/);
    });

    it('is checked before the spinner, so an empty finish never flashes one', () => {
        const start = roadSource.indexOf('function finishRoadDrawing()');
        const wrapper = roadSource.slice(start, roadSource.indexOf('\n}', start) + 2);
        expect(wrapper.indexOf('hasDrawableCorridor()'))
            .toBeLessThan(wrapper.indexOf('beginCorridorApplyIndicator'));
        expect(wrapper).toMatch(/if \(!hasDrawableCorridor\(\)\) return/);
    });

    it('is checked before the gate, so an empty finish cannot block a real one', () => {
        const start = roadSource.indexOf('function finishRoadDrawing()');
        const wrapper = roadSource.slice(start, roadSource.indexOf('\n}', start) + 2);
        expect(wrapper.indexOf('hasDrawableCorridor()')).toBeLessThan(wrapper.indexOf('roadFinalizationGate.run'));
    });

    it('every entry point asks the same question', () => {
        // The Finish (F) button reached finalization on an empty drawing because only the keyboard
        // paths tested it. Each of them now defers to the predicate rather than restating it — the
        // Finish button by way of finishRoadDrawing, which is where the check moved to.
        const keydown = lift('handleRoadKeydown');
        // The F/Enter branch and the Escape branch; the U branch asks a different question (undo).
        expect(keydown).toMatch(/e\.key === 'Enter'\) && hasDrawableCorridor\(\)/);
        expect(keydown).toMatch(/\} else if \(hasDrawableCorridor\(\)\) \{/);
        expect(lift('cancelRoadDrawing')).not.toMatch(/getAllRoadSegments\(true\)\.some/);
        expect(lift('finishRoadOrTrackDrawing')).toMatch(/finishRoadDrawing\(\)/);
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
