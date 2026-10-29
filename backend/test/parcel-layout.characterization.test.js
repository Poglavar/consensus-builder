// Characterization of the parcel-layout editor (frontend/js/parcel-layout.js) end to end: a fresh
// editor from createParcelLayoutEditor() in a fake browser world (helpers/parcel-layout-env.js) is
// opened on a selection, a site or a saved layout and driven through its own panel and map —
// buttons, the count field, the drawing tools, keys, the node handles — with the observable effects
// asserted: plots in its state, panel text, layers, and the record it hands to the design
// (window.pendingParcelLayout and the design draft). Geometry only: no owners, shares or money.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { makeEditor, box, lngLat } from './helpers/parcel-layout-env.js';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const SchellingGrid = require('../../frontend/js/parcels/schelling-grid.js');
const SchellingSettings = require('../../frontend/js/schelling/schelling-settings.js');

let env = null;
afterEach(() => {
    env?.dispose();
    env = null;
});

// Two side-by-side parcels, 40 × 50 m and 60 × 50 m: one 100 × 50 m pool.
const PARCELS = [
    { id: 'P1', geometry: box(0, 0, 40, 50) },
    { id: 'P2', geometry: box(40, 0, 100, 50) }
];

function world(options = {}) {
    env = makeEditor({ parcels: PARCELS, selection: { ids: ['P1', 'P2'] }, ...options });
    return env;
}

const area = geometry => turf.area({ type: 'Feature', properties: {}, geometry });
const sources = slices => slices.map(slice => slice.source);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const change = (input, value) => { input.value = String(value); input.dispatchEvent({ type: 'change', bubbles: true }); };

describe('opening', () => {
    it('refuses without a selection, and says so', async () => {
        const w = world({ selection: null });
        expect(await w.editor.openParcelLayoutEditor()).toBe(false);
        expect(globalThis.updateStatus.calls.at(-1)[0]).toBe('Select at least one parcel to lay out.');
        expect(globalThis.OnMapEditor.open.calls).toHaveLength(0);
    });

    it('refuses ground another design holds (a road\'s corridor piece)', async () => {
        const w = world({ parcels: [PARCELS[0], { ...PARCELS[1], properties: { isCorridor: true } }] });
        // The reason travels to the design shell, which shows it instead of "editor is unavailable".
        await expect(w.editor.openParcelLayoutEditor()).rejects.toMatchObject({ code: 'editor-refused',
            message: 'A parcel layout cannot redraw ground another design already holds. Deselect it, or unapply that design first.' });
        expect(globalThis.OnMapEditor.open.calls).toHaveLength(0);
        // The one-editor latch is released after a refusal: a second request is refused for its
        // reason again, not ignored as "already open" (which would answer false).
        await expect(w.editor.openParcelLayoutEditor()).rejects.toMatchObject({ code: 'editor-refused' });
    });

    it('is one editor at a time, even for two requests in the same tick', async () => {
        // Reopening a saved layout awaits its input parcels before anything is built, which is
        // where a guard on the built editor alone lets a second request through.
        const layout = { parcelIds: ['P1', 'P2'], plots: [{ geometry: box(0, 0, 100, 50), source: 'manual' }] };
        const w = world({ pendingLayout: layout });
        const open = () => w.editor.openParcelLayoutEditor({ algorithm: 'manual', initialPlots: layout.plots });
        const [first, second] = await Promise.all([open(), open()]);
        expect([first, second]).toEqual([true, false]);
        expect(await w.editor.openParcelLayoutEditor()).toBe(false);
        expect(globalThis.OnMapEditor.open.calls).toHaveLength(1);
    });

    it('opens on equal plots, one per input parcel, that tile the pool: Done is enabled and nothing names an owner', async () => {
        const w = world();
        expect(await w.editor.openParcelLayoutEditor()).toBe(true);
        const { state } = w;
        expect(state.algorithm).toBe('equal');
        expect(state.plotCount).toBe(2);
        expect(sources(state.slices)).toEqual(['equal', 'equal']);
        state.slices.forEach(slice => expect(area(slice.geometry) / state.totalArea).toBeCloseTo(0.5, 1));
        expect(state.slices.reduce((sum, slice) => sum + area(slice.geometry), 0)).toBeCloseTo(state.totalArea, 0);
        // A plot is geometry and how it was made, nothing else.
        state.slices.forEach(slice => expect(Object.keys(slice).sort()).toEqual(['geometry', 'source']));

        // The panel and the map.
        const [options] = globalThis.OnMapEditor.open.calls[0];
        expect(options).toMatchObject({ owner: 'parcel-layout', title: 'Lay out parcels', modes: ['2d'], handleEscape: false });
        expect(options.hints['2d']).toBe('Draw the plots here. Who receives which plot is decided later, in the agreement.');
        expect(w.document.contains(state.modal)).toBe(true);
        expect(w.plotLayers()).toHaveLength(2);
        expect(w.plotLayers()[0].options.pane).toBe('reparcelPlots');
        expect(w.plotLayers()[0].tooltip).toMatch(/^Plot 1 · /);
        expect(w.plotLayers()[0].options.fillColor).not.toBe(w.plotLayers()[1].options.fillColor);
        expect(state.boundaryLayer.getLayers()[0].options).toMatchObject({ color: '#dc2626', pane: 'reparcelTools', interactive: false });
        expect(w.$('[data-reparcel-commit]').disabled).toBe(false);
        expect(state.coverageEl.getAttribute('data-state')).toBe('ok');
        expect(state.coverageEl.textContent).toMatch(/^The plots cover the whole pool \(.+\)\.$/);
        const rows = state.newPlotsListEl.querySelectorAll('tr.reparcel-newplot-row');
        expect(rows).toHaveLength(2);
        expect(rows[0].textContent).toMatch(/^\s*1\s+[\d,.]+\s*m²\s*$/);
        // The owners, cash, approval and assignment controls are gone.
        ['[data-reparcel-owners-table]', '[data-reparcel-cashtotal]', '[data-reparcel-approval]', '[data-reparcel-owner-review]',
            '[data-reparcel-assign]', '[data-reparcel-all-public]', '[data-reparcel-shuffle]', '.reparcel-edit-shares']
            .forEach(selector => expect(state.modal.querySelector(selector)).toBeNull());
        // The node handles are the editor: they are on from the start.
        expect(state.nodeEdit.active).toBe(true);
        expect(w.handles()).not.toBeNull();
        expect(state.sweepHandle).not.toBeNull();
        expect(w.windowListeners('keydown')).toContain(state.escHandler);
    });

    it('offers the four layouts, the count beside Equal plots', async () => {
        const w = world();
        await w.editor.openParcelLayoutEditor();
        const radios = w.state.modal.querySelectorAll('input[name="reparcel-algorithm"]');
        expect(radios.map(radio => radio.value)).toEqual(['equal', 'schelling', 'amend', 'manual']);
        expect(w.state.modal.querySelectorAll('.reparcel-alg-option').map(option => option.textContent.trim()))
            .toEqual(['Equal plots', 'Schelling plots', 'Keep existing borders', 'Draw freely']);
        expect(radios.filter(radio => radio.disabled)).toEqual([]);
        const count = w.$('[data-parcel-layout-count]');
        expect([count.value, count.min, count.max]).toEqual(['2', '2', '64']);
        expect(w.$('[data-parcel-layout-count-field]').hidden).toBe(false);
    });

    it('without the Schelling plan its layout is offered disabled, saying why', async () => {
        const w = world({ globals: { SchellingGrid: undefined } });
        await w.editor.openParcelLayoutEditor();
        const radio = w.$('input[name="reparcel-algorithm"][value="schelling"]');
        expect(radio.disabled).toBe(true);
        expect(radio.parentNode.getAttribute('title')).toBe('The Schelling plan has not loaded.');
    });
});

describe('equal plots', () => {
    it('a new count re-slices the pool as one undo step', async () => {
        const w = world();
        await w.editor.openParcelLayoutEditor();
        const count = w.$('[data-parcel-layout-count]');
        change(count, 5);
        expect(w.state.plotCount).toBe(5);
        expect(sources(w.state.slices)).toEqual(Array(5).fill('equal'));
        w.state.slices.forEach(slice => expect(area(slice.geometry) / w.state.totalArea).toBeCloseTo(0.2, 1));
        expect(w.state.newPlotsListEl.querySelectorAll('tr.reparcel-newplot-row')).toHaveLength(5);
        expect(w.editor.isDirty()).toBe(true);

        expect(w.key('z', { ctrlKey: true }).defaultPrevented).toBe(true);
        expect(w.state.slices).toHaveLength(2);
        expect([w.state.plotCount, count.value]).toEqual([2, '2']);
        w.key('y', { ctrlKey: true });
        expect([w.state.slices.length, count.value]).toEqual([5, '5']);
    });

    it('the count stays within 2 and 64', async () => {
        const w = world();
        await w.editor.openParcelLayoutEditor();
        const count = w.$('[data-parcel-layout-count]');
        change(count, 1);
        expect([count.value, w.state.slices.length]).toEqual(['2', 2]);
        expect([w.editor.clampPlotCount(999), w.editor.clampPlotCount('3.4'), w.editor.clampPlotCount('x')]).toEqual([64, 3, 2]);
    });

    it('the first hand edit adopts the layout as drawn; undo gives the equal plots and the handle back', async () => {
        const w = world();
        await w.editor.openParcelLayoutEditor();
        w.$('[data-reparcel-line]').click();
        w.clickAt(70, -10);
        w.clickAt(70, 60);
        w.key('f');
        expect(w.state.algorithm).toBe('manual');
        expect(w.state.sweepHandle).toBeNull();
        expect(w.state.slices).toHaveLength(3);
        expect(w.$('[data-parcel-layout-count-field]').hidden).toBe(true);
        w.key('z', { ctrlKey: true });
        expect(w.state.algorithm).toBe('equal');
        expect(w.state.sweepHandle).not.toBeNull();
        expect(w.state.slices).toHaveLength(2);
        expect(w.$('input[name="reparcel-algorithm"][value="equal"]').checked).toBe(true);
    });
});

describe('Schelling plots', () => {
    // A 300 × 250 m pool: wider and deeper than a block, so the plan's streets cross it.
    const BIG = [{ id: 'B1', geometry: box(0, 0, 300, 250) }];

    it('lay the plan\'s plots over the pool and make the street strips between them plots too, tiling the pool', async () => {
        const w = world({ parcels: BIG, selection: { ids: ['B1'] } });
        await w.editor.openParcelLayoutEditor();
        w.$('input[name="reparcel-algorithm"][value="schelling"]').click();
        await tick();
        const { state } = w;
        expect(state.algorithm).toBe('schelling');
        expect(state.sweepHandle).toBeNull();
        const plan = SchellingGrid.planFor({ ...SchellingSettings.DEFAULTS, lat: 45.81 });
        expect(state.schellingCode).toBe(plan.code);
        expect(w.statusText()).toBe(`Plots of Schelling plan ${plan.code}. The street strips between them are plots too.`);
        const plots = state.slices.filter(slice => slice.source === 'schelling');
        const remainders = state.slices.filter(slice => slice.source === 'schelling-remainder');
        expect(plots.length).toBeGreaterThan(10);
        expect(remainders.length).toBeGreaterThan(0);
        expect(state.slices.reduce((sum, slice) => sum + area(slice.geometry), 0)).toBeCloseTo(state.totalArea, 0);
        expect(w.$('[data-reparcel-commit]').disabled).toBe(false);

        w.$('[data-reparcel-commit]').click();
        const record = globalThis.pendingParcelLayout;
        expect(record).toMatchObject({ algorithm: 'schelling', schelling: { code: plan.code } });
        expect(record.plotCount).toBeUndefined();
        expect(new Set(record.plots.map(plot => plot.source))).toEqual(new Set(['schelling', 'schelling-remainder']));
    });

    it('take the plan layer\'s current settings', async () => {
        const settings = { targetBlockM: 100, streetWidthM: 16, plotLevel: null };
        const w = world({ parcels: BIG, selection: { ids: ['B1'] }, schelling: settings });
        await w.editor.openParcelLayoutEditor({ algorithm: 'schelling' });
        const plan = SchellingGrid.planFor({ ...settings, lat: 45.81 });
        expect(w.state.schellingCode).toBe(plan.code);
        expect(plan.code).toMatch(/-16@/);
        // Whole blocks: every Schelling plot is a block clipped to the pool.
        const blockArea = plan.block.areaM2;
        w.state.slices.filter(slice => slice.source === 'schelling')
            .forEach(slice => expect(area(slice.geometry)).toBeLessThanOrEqual(blockArea * 1.01));
    });
});

describe('drawing freely', () => {
    async function manual(w) {
        await w.editor.openParcelLayoutEditor({ algorithm: 'manual' });
        return w;
    }

    it('starts from the undivided pool as one plot, which is already a complete layout', async () => {
        const w = await manual(world());
        expect(sources(w.state.slices)).toEqual(['base']);
        expect(w.$('[data-reparcel-commit]').disabled).toBe(false);
        expect(w.$('[data-parcel-layout-count-field]').hidden).toBe(true);
        expect(w.state.sweepHandle).toBeNull();
    });

    it('a line across the pool cuts it in two; Ctrl+Z puts it back', async () => {
        const w = await manual(world());
        w.$('[data-reparcel-line]').click();
        expect(w.state.drawing).toMatchObject({ active: true, mode: 'line' });
        expect(w.$('[data-reparcel-line]').getAttribute('aria-pressed')).toBe('true');
        expect(w.$('[data-reparcel-draw-toolbar]').hidden).toBe(false);
        w.clickAt(30, -10);
        w.clickAt(30, 60);
        expect(w.state.drawing.points).toHaveLength(2);
        w.key('f');
        expect(w.state.drawing.active).toBe(false);
        expect(w.state.slices).toHaveLength(2);
        const areas = w.state.slices.map(slice => area(slice.geometry)).sort((a, b) => a - b);
        expect(areas[0] / w.state.totalArea).toBeCloseTo(0.3, 2);
        expect(w.statusText()).toBe('Line drawn — 1 new plot(s), 2 new node(s).');
        expect(w.plotLayers()).toHaveLength(2);

        const undo = w.key('z', { ctrlKey: true });
        expect(undo.defaultPrevented).toBe(true);
        expect(w.state.slices).toHaveLength(1);
        expect(w.statusText()).toBe('Undid the last change.');
    });

    it('a line that meets the boundary only once changes nothing and says why', async () => {
        const w = await manual(world());
        w.$('[data-reparcel-line]').click();
        w.clickAt(30, -10);
        w.clickAt(30, 25);
        w.key('Enter');
        expect(w.state.slices).toHaveLength(1);
        expect(w.statusText()).toMatch(/^That line met the existing boundaries in fewer than two places/);
    });

    it('a drawn plot is carved out of the plot it lies in; U takes back a point while drawing', async () => {
        const w = await manual(world());
        w.$('[data-reparcel-draw]').click();
        w.clickAt(10, 10);
        w.clickAt(30, 10);
        w.clickAt(99, 99);
        w.key('u');
        expect(w.state.drawing.points).toHaveLength(2);
        w.clickAt(30, 30);
        w.clickAt(10, 30);
        w.$('[data-reparcel-finish]').click();
        expect(w.state.slices).toHaveLength(2);
        const carved = w.state.slices.find(slice => area(slice.geometry) < 1000);
        expect(area(carved.geometry)).toBeCloseTo(400, -1);
        expect(carved.source).toBe('manual');
        expect(w.statusText()).toBe('Plot added.');
        // The pieces still tile the pool.
        const total = w.state.slices.reduce((sum, slice) => sum + area(slice.geometry), 0);
        expect(total).toBeCloseTo(w.state.totalArea, 0);
        expect(w.$('[data-reparcel-commit]').disabled).toBe(false);
    });

    it('a plot drawn outside the pool is refused', async () => {
        const w = await manual(world());
        w.$('[data-reparcel-draw]').click();
        [[200, 0], [220, 0], [220, 20]].forEach(([e, n]) => w.clickAt(e, n));
        w.key('f');
        expect(w.state.slices).toHaveLength(1);
        expect(w.statusText()).toBe('The drawn plot is outside the pooled land.');
    });

    it('erasing the boundary between two plots makes them one', async () => {
        const w = await manual(world());
        w.$('[data-reparcel-line]').click();
        w.clickAt(30, -10);
        w.clickAt(30, 60);
        w.key('f');
        w.$('[data-reparcel-erase]').click();
        expect(w.state.erase.active).toBe(true);
        expect(w.statusText()).toMatch(/1 boundaries can be erased\.$/);
        const lines = w.state.erase.layer.getLayers().filter(layer => layer.options.className === 'reparcel-erase-line');
        expect(lines.length).toBeGreaterThan(0);
        lines[0].fire('click', { originalEvent: {} });
        expect(w.state.slices).toHaveLength(1);
        expect(area(w.state.slices[0].geometry)).toBeCloseTo(w.state.totalArea, 0);
    });
});

describe('switching the starting layout', () => {
    it('Draw freely continues from the equal plots', async () => {
        const w = world();
        await w.editor.openParcelLayoutEditor();
        const before = w.state.slices.map(slice => slice.geometry);
        w.$('input[name="reparcel-algorithm"][value="manual"]').click();
        await tick();
        expect(w.state.algorithm).toBe('manual');
        expect(w.state.slices.map(slice => slice.geometry)).toEqual(before);
        expect(w.state.sweepHandle).toBeNull();
        expect(w.statusText()).toMatch(/^Drawing freely from the current layout\./);
    });
});

describe('moving a boundary node', () => {
    it('a node moved through the handle layer reshapes both plots that share it', async () => {
        const w = world();
        await w.editor.openParcelLayoutEditor({ algorithm: 'manual' });
        w.$('[data-reparcel-line]').click();
        w.clickAt(50, -10);
        w.clickAt(50, 60);
        w.key('f');
        const layer = w.handles();
        const topology = layer.render();
        // The cut's top end: on the pool's north edge, where it may only slide along that edge.
        const [lng50, lat50] = lngLat(50, 50);
        const node = topology.nodes.find(candidate => Math.abs(candidate.coord[0] - lng50) < 1e-6 && Math.abs(candidate.coord[1] - lat50) < 1e-6);
        expect(node).toBeTruthy();
        const [lng70] = lngLat(70, 50);
        const before = w.state.slices.map(slice => area(slice.geometry));
        layer.options.onMove(node.id, [lng70, node.coord[1]], topology);
        const after = w.state.slices.map(slice => area(slice.geometry));
        // The cut now runs from (50, 0) to (70, 50): 500 m² moves from one plot to the other.
        expect(Math.abs(after[0] - before[0])).toBeCloseTo(500, -1);
        expect(after[0] + after[1]).toBeCloseTo(before[0] + before[1], 0);
        expect(w.state.slices.every(slice => slice.source === 'manual')).toBe(true);
        w.key('z', { metaKey: true });
        expect(w.state.slices.map(slice => area(slice.geometry))).toEqual(before);
    });
});

describe('uploading a GeoJSON layout', () => {
    // FileReader stand-in: the "file" carries its text.
    class FakeFileReader { readAsText(file) { this.onload({ target: { result: file.text } }); } }
    const upload = (w, geojson) => w.$('[data-reparcel-upload]').dispatchEvent({
        type: 'change', bubbles: false, target: { files: [{ text: JSON.stringify(geojson) }] }
    });

    it('carves the file\'s polygons into the pool, leaves the rest as one plot, and is one undo step', async () => {
        const w = world({ globals: { FileReader: FakeFileReader } });
        await w.editor.openParcelLayoutEditor();
        upload(w, { type: 'FeatureCollection', features: [
            { type: 'Feature', properties: {}, geometry: box(0, 0, 20, 50) },
            { type: 'Feature', properties: {}, geometry: box(20, 0, 50, 50) }
        ] });
        expect(w.state.algorithm).toBe('manual');
        expect(sources(w.state.slices).sort()).toEqual(['base', 'geojson', 'geojson']);
        expect(w.state.slices.reduce((sum, slice) => sum + area(slice.geometry), 0)).toBeCloseTo(w.state.totalArea, 0);
        expect(w.statusText()).toBe('Loaded 2 polygons from file.');
        w.key('z', { ctrlKey: true });
        expect(w.state.algorithm).toBe('equal');
        expect(sources(w.state.slices)).toEqual(['equal', 'equal']);
    });

    it('a file that misses the pool keeps the layout and says so', async () => {
        const w = world({ globals: { FileReader: FakeFileReader } });
        await w.editor.openParcelLayoutEditor();
        const before = w.state.slices;
        upload(w, box(500, 500, 520, 520));
        expect(w.state.slices).toBe(before);
        expect(w.statusText()).toBe('Uploaded polygons do not overlap with selected parcels.');
    });

    it('rejects an oversized file before changing the layout or its history', async () => {
        const w = world({ globals: { FileReader: FakeFileReader } });
        await w.editor.openParcelLayoutEditor();
        const before = w.state.slices;
        const depth = w.state.historyCtl.depth();
        const feature = { type: 'Feature', properties: {}, geometry: box(0, 0, 1, 1) };
        upload(w, { type: 'FeatureCollection', features: Array(1001).fill(feature) });
        expect(w.state.slices).toBe(before);
        expect(w.state.historyCtl.depth()).toBe(depth);
        expect(w.statusText()).toBe('Use at most 1000 polygons in one layout.');
    });
});

describe('before and after', () => {
    it('Before / After shows the input parcels, each in its own colour, on the before map', async () => {
        const drawn = [];
        const disposed = [];
        const beforeAfter = {
            attach: (map, options) => {
                const beforeMap = { addLayer: layer => drawn.push(layer) };
                options.drawBefore(beforeMap);
                return { beforeMap, dispose: () => disposed.push(true) };
            }
        };
        const w = world({ globals: { __MapBeforeAfter: beforeAfter } });
        await w.editor.openParcelLayoutEditor();
        w.$('[data-reparcel-compare]').click();
        expect(w.state.compare.active).toBe(true);
        expect(w.$('[data-reparcel-compare]').getAttribute('aria-pressed')).toBe('true');
        const parcels = drawn[0].getLayers();
        expect(parcels).toHaveLength(2);
        expect(parcels[0].options.fillColor).not.toBe(parcels[1].options.fillColor);
        w.$('[data-reparcel-compare]').click();
        expect(w.state.compare.active).toBe(false);
        expect(disposed).toHaveLength(1);
    });
});

describe('leaving', () => {
    it('Done saves the layout record to the design and closes the editor', async () => {
        const w = world();
        await w.editor.openParcelLayoutEditor();
        const session = w.session();
        w.$('[data-reparcel-commit]').click();

        const record = globalThis.pendingParcelLayout;
        expect(Object.keys(record).sort()).toEqual(['algorithm', 'generatedAt', 'parcelIds', 'plotCount', 'plots', 'pool', 'totalArea']);
        expect(record).toMatchObject({ algorithm: 'equal', plotCount: 2, parcelIds: ['P1', 'P2'] });
        expect(area(record.pool)).toBeCloseTo(record.totalArea, 0);
        expect(record.plots.map(plot => Object.keys(plot).sort())).toEqual([['area', 'geometry', 'source'], ['area', 'geometry', 'source']]);
        expect(record.plots.reduce((sum, plot) => sum + plot.area, 0)).toBeCloseTo(record.totalArea, 0);
        expect(JSON.stringify(record)).not.toMatch(/owner|cash|share|approval|color/i);
        expect(globalThis.syncActiveProposalDraftFromEditor.calls[0]).toEqual(['parcel-layout', record, { coalesceKey: 'parcel-layout-design' }]);
        expect(session.close.calls).toHaveLength(1);
        expect(w.document.contains(session.root)).toBe(false);
        expect(w.state.modal).toBeNull();
        expect(w.windowListeners('keydown')).toEqual([]);
        expect(globalThis.finishProposalDraftDesignSession.calls).toHaveLength(1);
        expect(globalThis.discardProposalDraftDesignSession.calls).toHaveLength(0);
        expect(globalThis.showEphemeralMessage.calls.at(-1)).toEqual(['Saved the parcel layout to this design.', 4000, 'success']);
    });

    it('Cancel with nothing changed closes and discards without asking', async () => {
        const w = world();
        await w.editor.openParcelLayoutEditor();
        w.$('[data-reparcel-cancel]').click();
        await tick();
        expect(globalThis.CbDialog.confirm.calls).toHaveLength(0);
        expect(w.state.modal).toBeNull();
        expect(globalThis.pendingParcelLayout).toBeNull();
        expect(globalThis.syncActiveProposalDraftFromEditor.calls).toHaveLength(0);
        expect(globalThis.discardProposalDraftDesignSession.calls).toHaveLength(1);
    });

    it('Escape after an edit asks first: Keep editing keeps the editor, Discard closes it unsaved', async () => {
        const w = world();
        await w.editor.openParcelLayoutEditor();
        change(w.$('[data-parcel-layout-count]'), 3);
        globalThis.CbDialog.confirm = Object.assign(async () => false, { calls: [] });
        w.key('Escape');
        await tick();
        expect(w.state.modal).not.toBeNull();

        globalThis.CbDialog.confirm = async () => true;
        w.key('Escape');
        await tick();
        expect(w.state.modal).toBeNull();
        expect(globalThis.pendingParcelLayout).toBeNull();
        expect(globalThis.discardProposalDraftDesignSession.calls).toHaveLength(1);
    });
});

describe('editing a saved layout', () => {
    function savedLayout() {
        return {
            algorithm: 'upu-plan',
            parcelIds: ['P1', 'P2'],
            pool: box(0, 0, 100, 50),
            plots: [
                { geometry: box(0, 0, 45, 50), source: 'manual' },
                { geometry: box(45, 0, 100, 50), source: 'geojson' }
            ]
        };
    }

    // What the design draft's adapter does: the layout becomes the seed, and the editor opens on its
    // algorithm, plots and pool.
    function reopen(w, layout) {
        return w.editor.openParcelLayoutEditor({
            algorithm: layout.algorithm,
            initialPlots: JSON.parse(JSON.stringify(layout.plots)),
            pool: JSON.parse(JSON.stringify(layout.pool))
        });
    }

    it('reopens on the layout\'s own plots and declared parcels — not the map selection — in Draw freely, clean', async () => {
        const layout = savedLayout();
        const w = world({ selection: { ids: ['P1'] }, pendingLayout: layout });
        expect(await reopen(w, layout)).toBe(true);
        expect(globalThis.CadastralParcelRepository.ensureIds.calls[0][0]).toEqual(['P1', 'P2']);
        expect(w.state.selection).toEqual({ ids: ['P1', 'P2'], source: 'cadastre' });
        // An algorithm this editor does not know is hand-authored ground.
        expect(w.state.algorithm).toBe('manual');
        expect(sources(w.state.slices)).toEqual(['manual', 'geojson']);
        expect(w.$('[data-reparcel-commit]').disabled).toBe(false);
        expect(w.editor.isDirty()).toBe(false);
        w.$('[data-reparcel-cancel]').click();
        await tick();
        expect(globalThis.CbDialog.confirm.calls).toHaveLength(0);
    });

    it('an edit of the saved layout is saved by Done and only by Done', async () => {
        const layout = savedLayout();
        const w = world({ selection: null, pendingLayout: layout });
        await reopen(w, layout);
        w.$('[data-reparcel-line]').click();
        w.clickAt(20, -10);
        w.clickAt(20, 60);
        w.key('f');
        expect(w.editor.isDirty()).toBe(true);
        expect(globalThis.syncActiveProposalDraftFromEditor.calls).toHaveLength(0);
        w.$('[data-reparcel-commit]').click();
        const saved = globalThis.pendingParcelLayout;
        expect(saved.parcelIds).toEqual(['P1', 'P2']);
        expect(saved.plots).toHaveLength(3);
        expect(saved).not.toBe(layout);
        expect(globalThis.syncActiveProposalDraftFromEditor.calls).toHaveLength(1);
    });

    it('a saved layout that leaves part of its pool uncovered holds Done back and says how much', async () => {
        const layout = { ...savedLayout(), plots: [savedLayout().plots[0]] };
        const w = world({ selection: null, pendingLayout: layout });
        await reopen(w, layout);
        expect(w.$('[data-reparcel-commit]').disabled).toBe(true);
        expect(w.state.coverageEl.getAttribute('data-state')).toBe('warn');
        expect(w.state.coverageEl.textContent).toMatch(/^The plots leave [\d,.]+\s*m² of the pool uncovered\.$/);
        w.$('[data-reparcel-commit]').click();
        expect(globalThis.pendingParcelLayout).toBe(layout);
    });
});

describe('other starting layouts and pools', () => {
    it('Keep existing borders starts from the input parcels and records them', async () => {
        const w = world();
        await w.editor.openParcelLayoutEditor({ algorithm: 'amend' });
        expect(sources(w.state.slices)).toEqual(['amend', 'amend']);
        expect(w.state.slices.map(slice => Math.round(area(slice.geometry)))).toEqual(PARCELS.map(parcel => Math.round(area(parcel.geometry))));
        expect(w.$('[data-reparcel-courtyard-tools]').hidden).toBe(false);
        expect(w.$('[data-reparcel-commit]').disabled).toBe(false);
        w.$('[data-reparcel-commit]').click();
        expect(globalThis.pendingParcelLayout.inputParcels.map(input => [input.parcelId, input.cadastreParcelId, input.label]))
            .toEqual([['P1', 'P1', 'P1'], ['P2', 'P2', 'P2']]);
    });

    it('a building block\'s courtyard is carved out as a plot of its own that names the block', async () => {
        const ring = (w, s, e, n) => [lngLat(w, s), lngLat(e, s), lngLat(e, n), lngLat(w, n), lngLat(w, s)];
        // A block wrapping the two parcels' common corner: its hole is the courtyard.
        const block = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring(20, 5, 70, 45), ring(30, 15, 60, 35).reverse()] } };
        const proposals = [{ proposalId: 'b-1', title: 'Courtyard block', buildingProposal: {}, geometry: { ruleMassing: block } }];
        const w = world({ proposals });
        await w.editor.openParcelLayoutEditor({ algorithm: 'amend' });
        w.$('[data-reparcel-courtyard-building]').click();
        const courtyard = w.state.slices.find(slice => slice.source === 'form');
        expect(courtyard).toBeTruthy();
        expect(area(courtyard.geometry)).toBeCloseTo(600, -1);
        expect(courtyard.derivation).toMatchObject({ kind: 'building-courtyard', sourceTitle: 'Courtyard block' });
        expect(w.statusText()).toBe('Courtyard carved out as a plot of its own.');
        expect(w.state.slices.reduce((sum, slice) => sum + area(slice.geometry), 0)).toBeCloseTo(w.state.totalArea, 0);
        w.$('[data-reparcel-commit]').click();
        const saved = globalThis.pendingParcelLayout.plots.find(plot => plot.source === 'form');
        expect(saved.derivation.kind).toBe('building-courtyard');
    });

    it('a subdivision lays out a drawn site: the bound parcel\'s part plus open ground', async () => {
        const w = world({ selection: null });
        const site = box(0, 0, 60, 50);   // P1 whole (2,000 m²) and 1,000 m² of open ground beside it
        expect(await w.editor.openParcelLayoutEditor({ sitePool: { site, boundParcelIds: ['P1'] } })).toBe(true);
        expect(globalThis.OnMapEditor.open.calls[0][0].title).toBe('Subdivide');
        // Keep existing borders has nothing to keep on open ground.
        expect(w.$('input[name="reparcel-algorithm"][value="amend"]').hasAttribute('disabled')).toBe(true);
        expect(w.state.slices.reduce((sum, slice) => sum + area(slice.geometry), 0)).toBeCloseTo(area(site), 0);
        w.$('[data-reparcel-commit]').click();
        expect(globalThis.pendingParcelLayout).toMatchObject({ poolSource: 'site', parcelIds: ['P1'] });
        expect(globalThis.pendingParcelLayout.openGroundM2).toBeCloseTo(area(site) - area(PARCELS[0].geometry), -1);
    });

    it('reopens its own applied ground but still refuses ground held by another design', async () => {
        const site = box(0, 0, 60, 50);
        const holder = id => ({ type: 'Feature', properties: { producedByProposalId: id }, geometry: site });
        let features = [holder('layout-1')];
        const layout = { poolSource: 'site', pool: site, parcelIds: ['P1'], openGroundM2: area(site) - area(PARCELS[0].geometry),
            plots: [{ geometry: site, source: 'manual' }] };
        const w = world({ selection: null, pendingLayout: layout, globals: {
            getActiveProposalDesignDraft: () => ({ sourceLocalProposalId: 'layout-1' }),
            LiveParcelFabric: { queryBounds: () => features },
            __openGround: { bboxOf: () => [], groundIdsOf: () => ['open-1'] },
            proposalStorage: { getProposal: id => ({ title: id === 'other' ? 'Other design' : id }) }
        } });
        const pool = await w.editor.buildSitePool(w.editor.sitePoolOfPendingLayout());
        expect(pool.boundParcelIds).toEqual(['P1']);
        features = [holder('layout-1'), holder('other')];
        expect(await w.editor.buildSitePool(w.editor.sitePoolOfPendingLayout())).toEqual({ error: 'taken', names: ['Other design'] });
        features = [holder('layout-1')];
        expect(await w.editor.openParcelLayoutEditor()).toBe(true);
        w.$('[data-reparcel-commit]').click();
        expect(globalThis.pendingParcelLayout).toMatchObject({ poolSource: 'site', parcelIds: ['P1'] });
    });
});

describe('Old plots read-only controls', () => {
    it('disables edit controls and history shortcuts while preserving individual validity flags', async () => {
        const w = world();
        await w.editor.openParcelLayoutEditor();
        const controls = w.state.modal.querySelector('[data-reparcel-alg-group]');
        const done = w.state.modal.querySelector('[data-reparcel-commit]');
        w.editor.pushHistory();
        const snapshot = JSON.stringify(w.state.slices);
        const depth = w.state.historyCtl.depth();
        done.disabled = true;
        w.editor.setPlotsTab('old');
        expect(controls.tagName).toBe('FIELDSET');
        expect(controls.disabled).toBe(true);
        expect(controls.getAttribute('aria-disabled')).toBe('true');
        expect(w.state.nodeEdit.active).toBe(false);
        w.key('z', { ctrlKey: true });
        expect(w.state.historyCtl.depth()).toBe(depth);
        expect(JSON.stringify(w.state.slices)).toBe(snapshot);
        w.editor.setPlotsTab('new');
        expect(controls.disabled).toBe(false);
        expect(controls.getAttribute('aria-disabled')).toBe('false');
        expect(done.disabled).toBe(true);
        expect(w.state.undoEditBtn.disabled).toBe(false);
        expect(w.state.redoEditBtn.disabled).toBe(true);
        w.key('z', { ctrlKey: true });
        expect(w.state.historyCtl.depth()).toBe(depth - 1);
    });
});

// Merging plots (node removal and the eraser) is the shared clip's union (parcel-arrangement.js
// clipWith): the merged plot holds both plots' ground on the grid, and a union that cannot be done
// merges nothing rather than dropping a plot.
describe('merging plots', () => {
    const onGrid = geometry => turf.coordAll({ type: 'Feature', properties: {}, geometry })
        .every(([x, y]) => Math.round(x * 1e9) / 1e9 === x && Math.round(y * 1e9) / 1e9 === y);

    it('joins two plots into one holding the ground of both, on the grid', async () => {
        const w = world();
        await w.editor.openParcelLayoutEditor();
        change(w.$('[data-parcel-layout-count]'), 4);
        const before = w.state.slices.map(slice => area(slice.geometry));
        expect(w.editor.mergePlots([0, 1])).toBe(true);
        expect(w.state.slices).toHaveLength(3);
        const merged = w.state.slices.find(slice => slice.source === 'manual');
        expect(area(merged.geometry)).toBeCloseTo(before[0] + before[1], 1);
        expect(onGrid(merged.geometry)).toBe(true);
    });

    it('merges nothing when the union cannot be done', async () => {
        const w = world();
        await w.editor.openParcelLayoutEditor();
        change(w.$('[data-parcel-layout-count]'), 4);
        const before = JSON.stringify(w.state.slices);
        globalThis.__parcelArrangement = { clipWith() { throw new Error('union failed'); }, clipFailure: error => error };
        try {
            expect(w.editor.mergePlots([0, 1])).toBe(false);
        } finally {
            delete globalThis.__parcelArrangement;
        }
        expect(JSON.stringify(w.state.slices)).toBe(before);
    });
});
