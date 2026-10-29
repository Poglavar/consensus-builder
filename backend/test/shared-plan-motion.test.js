import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { appTurf as turf, intentDesign } from '../agents/mcp-geometry.js';
const require = createRequire(import.meta.url);
const motion = require('../../frontend/js/shared-plan-motion.js');
const square = (x = 0, y = 0, width = .0001) => ({ type: 'Feature', properties: { height: 10 }, geometry: { type: 'Polygon', coordinates: [[[x,y],[x+width,y],[x+width,y+.0001],[x,y+.0001],[x,y]]] } });
const design = (cid, buildings = [], benches = []) => ({ cid, content: { title: 'Garden', geometry: { buildings }, structureProposal: { decorationDesign: { benches } } } });
const plan = (cid, ...designs) => ({ cid, designs });
const receipt = { fromCid: 'old-plan', toCid: 'new-plan', members: [{ beforeCid: 'old', afterCid: 'new' }] };
const changes = (old, current, change = receipt) => motion.describe({ previous: plan('old-plan', old), next: plan('new-plan', current), change });

describe('shared plan presentation changes', () => {
    it('measures a verified rigid translation and leaves unchanged objects alone', () => {
        const before = design('old', [square(), square(.001)]);
        const after = design('new', [square(.00001, .00002), square(.001)]);
        const result = changes(before, after);
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ kind: 'move', type: 'building', before: { index: 0 }, after: { index: 0 } });
        expect(result[0].eastM).toBeCloseTo(1.113, 2);
        expect(result[0].northM).toBeCloseTo(2.226, 2);
    });
    it('detects rotation and rejects a resized shape', () => {
        const a = square().geometry;
        const b = { type: 'Polygon', coordinates: [a.coordinates[0].map(([x,y]) => [-y,x])] };
        expect(motion.rigid(a, b).degrees).toBeCloseTo(90, 3);
        expect(changes(design('old', [square()]), design('new', [square(0,0,.0002)]))[0].kind).toBe('change');
    });
    it('recognizes the real MCP rotation after placement metadata is removed', () => {
        const site = { type: 'Polygon', coordinates: [[[-.1, 51.5], [-.098, 51.5], [-.098, 51.502], [-.1, 51.502], [-.1, 51.5]]] };
        const original = intentDesign.build({ kind: 'building', city: 'london', title: 'Tower', authoredAt: '2026-10-24T00:00:00.000Z', site, floors: 4, coverage: .05, rotationDegrees: 10 }, { turf });
        const edited = structuredClone(original);
        const editing = require('../../frontend/js/intent-editing.js');
        expect(original.geometry.buildings[0].properties.rotation).toBe(0);
        editing.buildings(edited, { type: 'rotate', degrees: 30, buildingIndex: 0 }, turf);
        expect(edited.geometry.buildings[0].properties.rotation).toBeUndefined();
        const result = changes({ cid: 'old', content: original }, { cid: 'new', content: edited });
        expect(result).toHaveLength(1);
        expect(result[0].kind).toBe('rotate');
        expect(result[0].distanceM).toBeLessThan(.05);
        expect(result[0].degrees).toBeCloseTo(30, 1);
        edited.geometry.buildings[0].properties.height += 3;
        expect(changes({ cid: 'old', content: original }, { cid: 'new', content: edited })[0].kind).toBe('change');
    });
    it('recognizes bench bearing and coordinate edits', () => {
        const a = { coordinate: [0, 0], bearing: 0 };
        const b = { coordinate: [0, 0], bearing: 45 };
        expect(changes(design('old', [], [a]), design('new', [], [b]))[0]).toMatchObject({ kind: 'rotate', type: 'bench', degrees: 45 });
    });
    it('never invents pairs for multiple changed objects or a missed revision', () => {
        const a = design('old', [square(), square(.001)]);
        const b = design('new', [square(.00001), square(.00101)]);
        expect(changes(a, b).map(x => x.kind)).toEqual(['remove', 'remove', 'add', 'add']);
        expect(changes(design('old', [square()]), design('new', [square(.00001)]), { ...receipt, fromCid: 'missed' }).map(x => x.kind)).toEqual(['remove', 'add']);
    });
    it('does not pair ambiguous receipt entries', () => {
        const ambiguous = { ...receipt, members: [receipt.members[0], receipt.members[0]] };
        expect(changes(design('old', [square()]), design('new', [square(.00001)]), ambiguous).map(x => x.kind)).toEqual(['remove', 'add']);
    });
});

describe('transition lifecycle', () => {
    function runtime({ reduced = false, finish = () => Promise.resolve() } = {}) {
        const listeners = new Map();
        const calls = [];
        return { calls, root: {
            document: { hidden: false, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) },
            matchMedia: () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} }),
            SharedPlanMotionBuildings: { begin(ids) { calls.push(['retain', ids]); return () => calls.push(['release']); } },
            SharedPlanMotion3D: { capture() { calls.push(['capture']); return { finish, cancel() { calls.push(['cancel']); } }; } },
            setTimeout, clearTimeout, requestAnimationFrame() { return 1; }, cancelAnimationFrame() {}, performance: { now: () => 0 }
        } };
    }
    it.each(['media', 'url'])('uses the final state immediately for reduced motion (%s) and releases retained objects', async mode => {
        const { root, calls } = runtime({ reduced: mode === 'media' });
        root.__reducedMotion = mode === 'url';
        const previous = { ...plan('old-plan', design('old', [square()])), memberIds: ['local'] };
        const next = plan('new-plan', design('new', [square(.00001)]));
        await motion.browser(root).prepare({ previous, next, change: receipt, changedBeforeIds: ['local'] }).finish({ next, memberIds: ['new-local'] });
        expect(calls.map(value => value[0])).toEqual(['capture', 'retain', 'cancel', 'release']);
    });
    it('cancels an in-flight renderer and settles finish without waiting for it', async () => {
        const { root, calls } = runtime({ finish: () => new Promise(() => {}) });
        const previous = { ...plan('old-plan', design('old', [square()])), memberIds: ['local'] };
        const next = plan('new-plan', design('new', [square(.00001)]));
        const controller = motion.browser(root).prepare({ previous, next, change: receipt, changedBeforeIds: ['local'] });
        const finishing = controller.finish({ next, memberIds: ['new-local'] });
        controller.cancel();
        await finishing;
        expect(calls.map(value => value[0])).toEqual(['capture', 'retain', 'cancel', 'release']);
    });
    it('gives the animation its full duration after a slow renderer becomes ready', async () => {
        let ready;
        const { root, calls } = runtime({ finish: () => new Promise(resolve => { ready = resolve; }) });
        const scheduled = new Map(); let nextTimer = 0, nextFrame, progress = [];
        root.setTimeout = (callback, ms) => { const id = ++nextTimer; scheduled.set(id, { callback, ms }); return id; };
        root.clearTimeout = id => scheduled.delete(id);
        root.requestAnimationFrame = callback => { nextFrame = callback; return 1; };
        root.SharedPlanMotion3D.capture = () => ({ finish: () => new Promise(resolve => { ready = resolve; }), frame: value => progress.push(value), cancel() { calls.push(['cancel']); } });
        const previous = { ...plan('old-plan', design('old', [square()])), memberIds: ['local'] };
        const next = plan('new-plan', design('new', [square(.00001)]));
        const controller = motion.browser(root).prepare({ previous, next, change: receipt, changedBeforeIds: ['local'] });
        const finishing = controller.finish({ next, memberIds: ['new-local'] });
        expect([...scheduled.values()].map(value => value.ms)).toEqual([2000]);
        ready();
        for (let i = 0; i < 4; i++) await Promise.resolve();
        expect([...scheduled.values()].map(value => value.ms)).toEqual([900]);
        nextFrame(275); expect(progress[0]).toBeCloseTo(0.5);
        nextFrame(550); await finishing;
        expect(progress.at(-1)).toBe(1);
        expect(scheduled.size).toBe(0);
    });
    it('retains only members with unchanged content CIDs', () => {
        const { root, calls } = runtime();
        const previous = { ...plan('old-plan', design('same'), design('old', [square()])), memberIds: ['keep', 'replace'] };
        const next = plan('new-plan', design('same'), design('new', [square(.00001)]));
        const controller = motion.browser(root).prepare({ previous, next, change: receipt, changedBeforeIds: ['replace'] });
        expect(calls.find(value => value[0] === 'retain')[1]).toEqual(['keep']);
        controller.cancel();
    });
});

// Exercise the actual Leaflet visibility hook with two buildings in one proposal.
describe('building visibility', () => {
    it('hides and restores only the affected building', () => {
        const source = readFileSync(new URL('../../frontend/js/building-blocks.js', import.meta.url), 'utf8');
        const start = source.indexOf('    window.SharedPlanMotionBuildings = {');
        const end = source.indexOf('\n    };\n}', start) + '\n    };'.length;
        expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start);
        const makeVisual = index => {
            const leaf = { options: { opacity: .8, fillOpacity: .6 }, setStyle(style) { Object.assign(this.options, style); } };
            return { leaf, sharedPlanBuildingIndex: index, eachLayer(fn) { fn(leaf); } };
        };
        const first = makeVisual(0), second = makeVisual(1), group = { eachLayer(fn) { [first, second].forEach(fn); } };
        const window = {}, proposedBuildingSublayers = new Map([['local', group]]);
        runInNewContext(source.slice(start, end), { window, proposedBuildingSublayers, Set, String });
        const row = plan('p', design('d', [square(), square(.001)]));
        const restore = window.SharedPlanMotionBuildings.hide(['local'], [{ type: 'building', after: { cid: 'd', index: 1 } }], new Map([['d', 'local']]), row);
        expect(first.leaf.options).toEqual({ opacity: .8, fillOpacity: .6 });
        expect(second.leaf.options).toEqual({ opacity: 0, fillOpacity: 0 });
        restore(); expect(second.leaf.options).toEqual({ opacity: .8, fillOpacity: .6 });
    });
});

describe('shared-update structure retention', () => {
    it('retains a 2D family only when the last drawn inputs and layer still match', () => {
        const source = readFileSync(new URL('../../frontend/js/structures.js', import.meta.url), 'utf8');
        const start = source.indexOf('    const renderedStructureSignatures = new Map();');
        const end = source.indexOf('    // A canonical plan replay', start);
        expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start);
        const layer = {}, window = { parks: [{ geometry: 'old' }], LiveParcelFabric: { revision: () => 1 } };
        const context = { window, document: { getElementById: () => ({ checked: true }) },
            parksLayer: layer, squaresLayer: {}, lakesLayer: {}, buildingGroundLayer: {}, buildingGroundSignature: 'ground',
            appliedCorridorCutters: () => [], JSON, Map };
        const hooks = runInNewContext(source.slice(start, end) + `
            renderedStructureSignatures.set('parks', structureRenderSignature('parks'));
            ({ signature: structureRenderSignature, unchanged: unchangedSharedStructure });`, context);
        const release = window.SharedPlanMotionStructures.begin();
        expect(hooks.unchanged('parks', hooks.signature('parks'), layer)).toBe(true);
        expect(hooks.unchanged('parks', hooks.signature('parks'), {})).toBe(false);
        window.parks[0].geometry = 'changed';
        expect(hooks.unchanged('parks', hooks.signature('parks'), layer)).toBe(false);
        window.parks[0].geometry = 'old';
        window.LiveParcelFabric.revision = () => 2;
        expect(hooks.unchanged('parks', hooks.signature('parks'), layer)).toBe(false);
        release();
        expect(hooks.unchanged('parks', hooks.signature('parks'), layer)).toBe(false);
    });
    it('retains a 3D family only when feature, corridor, fabric and buildout inputs remain equal', () => {
        const source = readFileSync(new URL('../../frontend/js/three-mode.js', import.meta.url), 'utf8');
        const start = source.indexOf('    let sharedPlanRetainedIds = null;');
        const end = source.indexOf('    function sharedPlanMeshes(', start);
        expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start);
        const roads = [], window = { parks: [{ geometry: 'park' }], proposalStorage: { getAllProposals: () => roads }, LiveParcelFabric: { revision: () => 1 } };
        const buildoutSites = new Map();
        const guard = runInNewContext(source.slice(start, end) + `
            sharedPlanStructureSignatures = new Map([['parks', sharedPlanStructureSignature('parks')]]);
            sharedPlanStructureUnchanged;`, { window, buildoutSites, Map, JSON });
        expect(guard('parks')).toBe(true);
        roads.push({ roadProposal: { geometry: 'road' } });
        expect(guard('parks')).toBe(false);
        roads.length = 0; buildoutSites.set('park', { phase: 'built' });
        expect(guard('parks')).toBe(false);
    });
});
