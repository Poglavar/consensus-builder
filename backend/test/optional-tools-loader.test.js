import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../frontend/js/optional-tools-loader.js', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');
const INLINE_OPTIONAL_FUNCTIONS = [
    'toggleOSMRoadLines', 'toggleGUPRoadLines', 'toggleWFSPolygons',
    'detectExistingRoads', 'drawOSMRoads', 'detectRoadsFromOSM', 'drawGUPRoads',
    'detectRoadsFromGUP', 'drawWFSRoadParcels', 'detectRoadsFromWFS', 'clearDetectedRoads',
    'analyzeAllOSMRoadSegmentsInView', 'toggleRoadAnalysisVisibility', 'showRoadAnalysisPanel',
    'hideRoadAnalysisPanel', 'focusOnRoadAnalysis', 'clearRoadAnalysisVisualization',
    'hideOSMRoadSegmentListPopup'
];
const NO_LOAD_CLEANUPS = new Set([
    'hideRoadAnalysisPanel', 'clearRoadAnalysisVisualization', 'hideOSMRoadSegmentListPopup'
]);

async function flushMicrotasks() {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

function harness() {
    const scripts = [];
    const statuses = [];
    const errors = [];
    const sandbox = {
        Promise,
        Set,
        Map,
        Error,
        WeakSet,
        appendBuildToken: path => `${path}?build=test-token`,
        console: { error: (...args) => errors.push(args) },
        i18n: { t: key => key === 'optionalTools.loadFailed' ? 'Localized load failure' : key },
        updateStatus: message => statuses.push(message),
        document: {
            head: { appendChild: script => scripts.push(script) },
            createElement: () => ({})
        }
    };
    sandbox.window = sandbox;
    vm.runInNewContext(source, sandbox, { filename: 'optional-tools-loader.js' });
    return {
        window: sandbox,
        scripts,
        statuses,
        errors,
        succeed(script, install = () => {}) {
            install(sandbox);
            script.onload();
        },
        fail(script) { script.onerror(); }
    };
}

describe('optional tools loader', () => {
    it('forwards every active inline road tool after cold startup, keeping cleanup calls lazy', async () => {
        const inlineNames = [...indexSource.matchAll(/\bon(?:click|change)="\s*([A-Za-z_$][\w$]*)\s*\(/g)]
            .map(([, name]) => name);
        for (const name of INLINE_OPTIONAL_FUNCTIONS) expect(inlineNames, `${name} inline handler`).toContain(name);

        const h = harness();
        const initial = new Map(INLINE_OPTIONAL_FUNCTIONS.map(name => [name, h.window[name]() ]));
        for (const name of NO_LOAD_CLEANUPS) expect(initial.get(name), `${name} before module load`).toBeUndefined();
        for (const name of INLINE_OPTIONAL_FUNCTIONS.filter(name => !NO_LOAD_CLEANUPS.has(name))) {
            expect(initial.get(name), `${name} must defer its implementation until load`).toBeInstanceOf(Promise);
        }

        expect(h.scripts.map(script => script.src)).toEqual([
            'js/road-detection.js?build=test-token',
            'js/road-analysis.js?build=test-token'
        ]);
        const calls = [];
        const installGroup = names => win => names.forEach(name => {
            win[name] = (...args) => { calls.push([name, args]); return name; };
        });
        h.succeed(h.scripts[0], installGroup(INLINE_OPTIONAL_FUNCTIONS.filter(name =>
            !NO_LOAD_CLEANUPS.has(name) && !['analyzeAllOSMRoadSegmentsInView', 'toggleRoadAnalysisVisibility',
                'showRoadAnalysisPanel', 'focusOnRoadAnalysis'].includes(name))));
        h.succeed(h.scripts[1], installGroup(['analyzeAllOSMRoadSegmentsInView', 'toggleRoadAnalysisVisibility',
            'showRoadAnalysisPanel', 'hideRoadAnalysisPanel', 'focusOnRoadAnalysis',
            'clearRoadAnalysisVisualization', 'hideOSMRoadSegmentListPopup']));

        const activeNames = INLINE_OPTIONAL_FUNCTIONS.filter(name => !NO_LOAD_CLEANUPS.has(name));
        await expect(Promise.all(activeNames.map(name => initial.get(name))))
            .resolves.toEqual(activeNames);
        expect(calls.map(([name]) => name).sort()).toEqual(activeNames.slice().sort());
        for (const name of NO_LOAD_CLEANUPS) expect(h.window[name]()).toBe(name);
    });

    it('coalesces concurrent first calls, loads shared geometry before the editor, and forwards receiver and arguments', async () => {
        const h = harness();
        const receiver = { id: 'caller' };
        const first = h.window.openSingleBuildingForParcels.call(receiver, { parcelIds: ['a'] });
        const second = h.window.createSingleBuildingProposal.call(receiver, { parcelIds: ['b'] });

        expect(h.scripts).toHaveLength(1);
        expect(h.scripts[0].src).toBe('js/single-building-geometry.js?build=test-token');
        h.succeed(h.scripts[0], win => { win.SingleBuildingGeometry = { ready: true }; });
        await flushMicrotasks();
        expect(h.scripts).toHaveLength(2);
        expect(h.scripts[1].src).toBe('js/single-building.js?build=test-token');

        const calls = [];
        h.succeed(h.scripts[1], win => {
            win.openSingleBuildingForParcels = function (value) { calls.push([this, 'open', value]); return 'opened'; };
            win.createSingleBuildingProposal = function (value) { calls.push([this, 'create', value]); return 'created'; };
        });
        await expect(first).resolves.toBe('opened');
        await expect(second).resolves.toBe('created');
        expect(calls).toEqual([
            [receiver, 'open', { parcelIds: ['a'] }],
            [receiver, 'create', { parcelIds: ['b'] }]
        ]);
    });

    it('shares the geometry request across row-house and single-building groups', async () => {
        const h = harness();
        const single = h.window.openSingleBuildingForParcels({ parcelIds: ['s'] });
        const row = h.window.openRowHouseForParcels({ parcelIds: ['r'] });
        expect(h.scripts).toHaveLength(1);
        expect(h.scripts[0].src).toBe('js/single-building-geometry.js?build=test-token');
        h.succeed(h.scripts[0], win => { win.SingleBuildingGeometry = {}; });
        await flushMicrotasks();
        expect(h.scripts.map(script => script.src)).toEqual([
            'js/single-building-geometry.js?build=test-token',
            'js/single-building.js?build=test-token',
            'js/row-house.js?build=test-token'
        ]);
        h.succeed(h.scripts[1], win => { win.openSingleBuildingForParcels = () => 'single'; });
        h.succeed(h.scripts[2], win => { win.openRowHouseForParcels = () => 'row'; });
        await expect(single).resolves.toBe('single');
        await expect(row).resolves.toBe('row');
    });

    it('loads the synchronous building creation pipeline before opening BuildingUpload', async () => {
        const h = harness();
        const created = { id: 'created' };
        const open = h.window.BuildingUpload.open({ file: 'upload.geojson' });
        expect(h.scripts[0].src).toBe('js/single-building-geometry.js?build=test-token');
        expect(h.window.BuildingUpload.close()).toBeUndefined();

        h.succeed(h.scripts[0], win => { win.SingleBuildingGeometry = {}; });
        await flushMicrotasks();
        expect(h.scripts[1].src).toBe('js/single-building.js?build=test-token');
        h.succeed(h.scripts[1], win => {
            win.createSingleBuildingFromUpload = () => created;
        });
        await flushMicrotasks();
        expect(h.scripts[2].src).toBe('js/building-upload.js?build=test-token');
        h.succeed(h.scripts[2], win => {
            win.BuildingUpload = {
                open() {
                    return typeof win.createSingleBuildingFromUpload === 'function'
                        ? win.createSingleBuildingFromUpload()
                        : null;
                },
                close: () => 'closed'
            };
        });

        await expect(open).resolves.toBe(created);
        expect(h.window.BuildingUpload.close()).toBe('closed');
    });

    it.each([
        ['openSingleBuildingForParcels', 'js/single-building.js'],
        ['openRowHouseForParcels', 'js/row-house.js'],
        ['openParcelBasedForParcels', 'js/parcel-based.js']
    ])('does not open %s after the map mode changes during loading', async (name, editorScript) => {
        const h = harness();
        const calls = [];
        h.window.__mapModeState = { mode: '2d' };
        const pending = h.window[name]();
        h.window.__mapModeState = { mode: '3d' };

        expect(h.scripts[0].src).toBe('js/single-building-geometry.js?build=test-token');
        h.succeed(h.scripts[0], win => { win.SingleBuildingGeometry = {}; });
        await flushMicrotasks();
        expect(h.scripts[1].src).toBe(`${editorScript}?build=test-token`);
        h.succeed(h.scripts[1], win => {
            win[name] = () => { calls.push(name); return 'opened'; };
        });

        await expect(pending).resolves.toBe(false);
        expect(calls).toEqual([]);
        expect(h.window[name]()).toBe('opened');
        expect(calls).toEqual([name]);
    });

    it('does not load row-house or parcel-based tools just to close their modals', () => {
        const h = harness();
        expect(h.window.closeRowHouseModal()).toBeUndefined();
        expect(h.window.closeParcelBasedModal()).toBeUndefined();
        expect(h.scripts).toHaveLength(0);
    });

    it('retries a failed script without caching a rejected promise', async () => {
        const h = harness();
        const failed = h.window.analyzeAllOSMRoadSegmentsInView();
        expect(h.scripts).toHaveLength(1);
        h.fail(h.scripts[0]);
        await expect(failed).rejects.toThrow('Could not load optional tool: js/road-analysis.js');

        const retried = h.window.analyzeAllOSMRoadSegmentsInView();
        expect(h.scripts).toHaveLength(2);
        const result = { ok: true };
        h.succeed(h.scripts[1], win => {
            win.analyzeAllOSMRoadSegmentsInView = () => result;
        });
        await expect(retried).resolves.toBe(result);
    });

    it('reports ignored facade failures while preserving rejection and retry behavior', async () => {
        const h = harness();
        const first = h.window.analyzeAllOSMRoadSegmentsInView();
        h.window.analyzeAllOSMRoadSegmentsInView(); // emulate an inline handler that ignores its return value
        h.fail(h.scripts[0]);
        await flushMicrotasks();

        expect(h.errors).toHaveLength(1);
        expect(h.statuses).toEqual(['Localized load failure']);
        await expect(first).rejects.toThrow('Could not load optional tool: js/road-analysis.js');

        const retried = h.window.analyzeAllOSMRoadSegmentsInView();
        expect(h.scripts).toHaveLength(2);
        h.succeed(h.scripts[1], win => {
            win.analyzeAllOSMRoadSegmentsInView = () => 'ready';
        });
        await expect(retried).resolves.toBe('ready');
    });

    it('reports BuildingUpload open failures without hiding their rejection', async () => {
        const h = harness();
        const open = h.window.BuildingUpload.open({ file: 'x' });
        h.succeed(h.scripts[0], win => { win.SingleBuildingGeometry = {}; });
        await flushMicrotasks();
        h.succeed(h.scripts[1], win => { win.createSingleBuildingFromUpload = () => ({ id: 'created' }); });
        await flushMicrotasks();
        h.fail(h.scripts[2]);
        await flushMicrotasks();
        expect(h.errors).toHaveLength(1);
        expect(h.statuses).toEqual(['Localized load failure']);
        await expect(open).rejects.toThrow('Could not load optional tool: js/building-upload.js');
    });

    it('does not open BuildingUpload after the map mode changes during loading', async () => {
        const h = harness();
        const calls = [];
        h.window.__mapModeState = { mode: '2d' };
        const pending = h.window.BuildingUpload.open({ file: 'upload.glb' });
        h.window.__mapModeState = { mode: '3d' };

        h.succeed(h.scripts[0], win => { win.SingleBuildingGeometry = {}; });
        await flushMicrotasks();
        h.succeed(h.scripts[1], win => { win.createSingleBuildingFromUpload = () => ({ id: 'created' }); });
        await flushMicrotasks();
        h.succeed(h.scripts[2], win => {
            win.BuildingUpload = {
                open: () => { calls.push('open'); return 'opened'; },
                close: () => 'closed'
            };
        });

        await expect(pending).resolves.toBe(false);
        expect(calls).toEqual([]);
        expect(h.window.BuildingUpload.open()).toBe('opened');
        expect(calls).toEqual(['open']);
    });

    it('does not load road analysis just to close a panel that was never opened', () => {
        const h = harness();
        expect(h.window.hideRoadAnalysisPanel()).toBeUndefined();
        expect(h.window.clearRoadAnalysisVisualization()).toBeUndefined();
        expect(h.scripts).toHaveLength(0);
    });
});
