// Unit tests for frontend/js/map-pick.js, the one pick-on-map mode of the share panel and the
// agreement editor (plan-design-agreement.md, "M3 notes"): begin / end / active over a fake body, map
// and Leaflet (the lockdown classes, one surface at a time, the model/photo exit), pick handing only
// applied designs to the surface, the highlight built once per design in the pick pane and repainted
// from the surface's highlight() in frame-sized slices that the end of the mode or a newer repaint
// stops; and the shapes a highlight draws: the design's body first, else the ground it stands on.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const MapPick = require('../../frontend/js/map-pick.js');
const hoverGround = require('../../frontend/js/proposals/hover-ground.js');

const box = (w, s, e, n) => turf.polygon([[[w, s], [e, s], [e, n], [w, n], [w, s]]]);
// Two ~77 m squares side by side near 46°N, and a body that stands on the left one only.
const LEFT = box(16.0000, 46.0000, 16.0010, 46.0010);
const RIGHT = box(16.0010, 46.0000, 16.0020, 46.0010);
const ON_LEFT = box(16.0002, 46.0002, 16.0006, 46.0006);

// Globals the module reads from its root (globalThis in node), restored after every test.
const installed = new Map();
function install(name, value) {
    if (!installed.has(name)) installed.set(name, { had: Object.prototype.hasOwnProperty.call(globalThis, name), value: globalThis[name] });
    globalThis[name] = value;
}

afterEach(() => {
    MapPick.end();
    for (const [name, previous] of installed) {
        if (previous.had) globalThis[name] = previous.value;
        else delete globalThis[name];
    }
    installed.clear();
    vi.restoreAllMocks();
});

function fakeBody() {
    const classes = new Set();
    const attributes = new Map();
    return {
        classes,
        attributes,
        classList: {
            add: (...names) => names.forEach(name => classes.add(name)),
            remove: (...names) => names.forEach(name => classes.delete(name)),
            contains: name => classes.has(name)
        },
        setAttribute: (name, value) => attributes.set(name, String(value)),
        removeAttribute: name => attributes.delete(name)
    };
}

// A map and the two Leaflet factories the mode uses; every geoJSON layer built is kept in `built`.
function fakeLeaflet() {
    const built = [];
    const map = {
        panes: new Map(), added: [], removed: [],
        createPane: vi.fn(name => { map.panes.set(name, {}); return map.panes.get(name); }),
        getPane: name => map.panes.get(name),
        removeLayer: layer => { map.removed.push(layer); }
    };
    const L = {
        layerGroup() {
            const layers = new Set();
            const group = {
                layers,
                addTo(target) { target.added.push(group); return group; },
                hasLayer: layer => layers.has(layer),
                addLayer: layer => { layers.add(layer); return group; },
                removeLayer: layer => { layers.delete(layer); return group; }
            };
            return group;
        },
        geoJSON(data, options) {
            const layer = { data, options, styles: [], setStyle(style) { layer.styles.push(style); } };
            built.push(layer);
            return layer;
        }
    };
    return { map, L, built };
}

// Designs by id: `body` is the shape that names them (collectProposalFeatureSets' primaryFeatures).
function environment(records = []) {
    const { map, L, built } = fakeLeaflet();
    const body = fakeBody();
    const byId = new Map(records.map(record => [String(record.proposalId), record]));
    const shapes = vi.fn(record => ({ primaryFeatures: record.body || [] }));
    const frames = [];
    install('document', { body });
    install('map', map);
    install('L', L);
    install('proposalStorage', { getProposal: id => byId.get(String(id)) || null });
    install('isApplied', record => record.applied === true);
    install('collectProposalFeatureSets', shapes);
    // Frames come only when the test lets one through.
    install('requestAnimationFrame', callback => { frames.push(callback); });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const nextFrame = async () => {
        frames.shift()();
        await new Promise(resolve => setImmediate(resolve));
    };
    return { map, L, built, body, byId, shapes, frames, nextFrame };
}

const design = (proposalId, extra = {}) => ({ proposalId, applied: true, body: [box(16, 46, 16.001, 46.001)], ...extra });
const group = map => map.added.at(-1);

describe('beginning and ending', () => {
    it('needs a surface name and a pick callback', () => {
        environment();
        expect(() => MapPick.begin({ pick: () => {} })).toThrow(/needs a name/);
        expect(() => MapPick.begin({ name: ' ', pick: () => {} })).toThrow(TypeError);
        expect(() => MapPick.begin({ name: 'share' })).toThrow(/needs pick/);
        expect(MapPick.active()).toBeNull();
    });

    it('locks the map for the surface that picks, and lifts the lock when that surface ends', async () => {
        const { map, body } = environment();
        await expect(MapPick.begin({ name: 'share', pick: () => {} })).resolves.toBe(true);
        expect(MapPick.active()).toBe('share');
        expect(body.classes.has('map-pick-mode')).toBe(true);
        expect(body.attributes.get('data-map-pick')).toBe('share');
        expect(map.createPane).toHaveBeenCalledWith('pick-highlight');
        expect(map.added).toHaveLength(1);
        // A surface closing late never ends the one picking now.
        expect(MapPick.end('agreement')).toBe(false);
        expect(MapPick.active()).toBe('share');
        expect(MapPick.end('share')).toBe(true);
        expect(MapPick.active()).toBeNull();
        expect(body.classes.size).toBe(0);
        expect(body.attributes.has('data-map-pick')).toBe(false);
        expect(map.removed).toEqual([map.added[0]]);
        expect(MapPick.end()).toBe(false);
    });

    it('creates the highlight pane once, and leaves model/photo view first', async () => {
        const { map } = environment();
        const exitThreeMode = vi.fn();
        install('exitThreeMode', exitThreeMode);
        install('isThreeModeActive', () => true);
        await MapPick.begin({ name: 'share', pick: () => {} });
        expect(exitThreeMode).toHaveBeenCalledTimes(1);
        MapPick.end();
        install('isThreeModeActive', () => false);
        await MapPick.begin({ name: 'agreement', pick: () => {} });
        expect(exitThreeMode).toHaveBeenCalledTimes(1);
        expect(map.createPane).toHaveBeenCalledTimes(1);
    });

    it('lets one surface pick at a time: another one beginning closes the one picking', async () => {
        const { map } = environment();
        const closeShare = vi.fn(() => MapPick.end('share'));
        await MapPick.begin({ name: 'share', pick: () => {}, close: closeShare });
        const closeAgreement = vi.fn();
        await MapPick.begin({ name: 'agreement', pick: () => {}, close: closeAgreement });
        expect(closeShare).toHaveBeenCalledTimes(1);
        expect(MapPick.active()).toBe('agreement');
        // The same surface beginning again starts clean, without closing itself.
        await MapPick.begin({ name: 'agreement', pick: () => {}, close: closeAgreement });
        expect(closeAgreement).not.toHaveBeenCalled();
        expect(map.removed).toEqual(map.added.slice(0, 2));
        // A surface that does not end its mode when closed is ended anyway.
        const stubborn = vi.fn();
        await MapPick.begin({ name: 'share', pick: () => {}, close: stubborn });
        await MapPick.begin({ name: 'agreement', pick: () => {} });
        expect(stubborn).toHaveBeenCalledTimes(1);
        expect(MapPick.active()).toBe('agreement');
    });
});

describe('picking a design on the map', () => {
    it('hands only an applied design to the surface, with the parcel clicked', async () => {
        const road = design('road-1');
        const park = design('park-1', { applied: false });
        const numbered = design(7);
        environment([road, park, numbered]);
        const pick = vi.fn();
        await MapPick.begin({ name: 'agreement', pick });
        expect(MapPick.pick(' road-1 ', { parcelId: 'k9' })).toBe(true);
        expect(pick).toHaveBeenLastCalledWith('road-1', road, { parcelId: 'k9' });
        expect(MapPick.pick(7)).toBe(true);
        expect(pick).toHaveBeenLastCalledWith('7', numbered, { parcelId: null });
        expect(MapPick.pick('park-1')).toBe(false);
        expect(MapPick.pick('gone')).toBe(false);
        expect(MapPick.pick('')).toBe(false);
        expect(pick).toHaveBeenCalledTimes(2);
    });

    it('answers nothing while no surface picks', () => {
        environment([design('road-1')]);
        expect(MapPick.pick('road-1')).toBe(false);
    });
});

describe('the highlight', () => {
    it('draws and dims nothing while the surface highlights nothing', async () => {
        const { body, built } = environment([design('road-1')]);
        await expect(MapPick.begin({ name: 'share', pick: () => {}, highlight: () => null })).resolves.toBe(true);
        expect(body.classes.has('map-pick-highlighting')).toBe(false);
        expect(built).toEqual([]);
    });

    it('draws each design the surface names once, in the pick pane, never as a click target', async () => {
        const { map, body, built } = environment([design('road-1'), design('park-1'), design('rule-1')]);
        let wanted = ['road-1', 'park-1'];
        await expect(MapPick.begin({ name: 'agreement', pick: () => {}, highlight: () => wanted })).resolves.toBe(true);
        expect(body.classes.has('map-pick-highlighting')).toBe(true);
        expect(built).toHaveLength(2);
        built.forEach(layer => expect(layer.options).toMatchObject({ interactive: false, pane: 'pick-highlight', className: 'map-pick-highlight' }));
        expect(built[0].data.features).toEqual(design('road-1').body);
        expect([...group(map).layers]).toEqual(built);
        // A design dropped from the highlight is taken off; added back, it is shown, never rebuilt.
        wanted = ['road-1'];
        await expect(MapPick.refresh()).resolves.toBe(true);
        expect([...group(map).layers]).toEqual([built[0]]);
        wanted = ['road-1', 'park-1'];
        await MapPick.refresh();
        expect(built).toHaveLength(2);
        expect(group(map).layers.size).toBe(2);
        // Nothing highlighted: the layers come off and the map is no longer dimmed.
        wanted = null;
        await MapPick.refresh();
        expect(group(map).layers.size).toBe(0);
        expect(body.classes.has('map-pick-highlighting')).toBe(false);
    });

    it('styles each design as the surface says, on every repaint', async () => {
        const { built } = environment([design('road-1'), design('park-1')]);
        const published = new Set(['road-1']);
        const style = vi.fn(id => ({ color: published.has(id) ? 'green' : 'grey', dashArray: published.has(id) ? null : '7 6' }));
        await MapPick.begin({ name: 'share', pick: () => {}, highlight: () => ['road-1', 'park-1'], style });
        expect(built[0].options.className).toBeUndefined();
        expect(built[0].options.style()).toEqual({ color: 'green', dashArray: null });
        expect(built[1].styles.at(-1)).toEqual({ color: 'grey', dashArray: '7 6' });
        published.add('park-1');
        await expect(MapPick.refresh(['park-1'])).resolves.toBe(true);
        expect(built[1].styles.at(-1)).toEqual({ color: 'green', dashArray: null });
        expect(style).toHaveBeenCalledWith('park-1', expect.objectContaining({ proposalId: 'park-1' }));
    });

    it('repaints only the designs named, building one that is newly wanted', async () => {
        const { map, built, shapes } = environment([design('road-1'), design('park-1')]);
        let wanted = ['road-1'];
        await MapPick.begin({ name: 'agreement', pick: () => {}, highlight: () => wanted });
        expect(built).toHaveLength(1);
        wanted = ['road-1', 'park-1'];
        await expect(MapPick.refresh(['park-1'])).resolves.toBe(true);
        expect(built).toHaveLength(2);
        expect(group(map).layers.size).toBe(2);
        wanted = ['road-1'];
        await MapPick.refresh(['park-1']);
        expect([...group(map).layers]).toEqual([built[0]]);
        expect(shapes).toHaveBeenCalledTimes(2);
    });

    it('remembers a design without a shape instead of resolving it again', async () => {
        const { built, shapes } = environment([design('bare', { body: [] })]);
        await MapPick.begin({ name: 'share', pick: () => {}, highlight: () => ['bare'] });
        await MapPick.refresh();
        expect(built).toEqual([]);
        expect(shapes).toHaveBeenCalledTimes(1);
    });

    it('draws a large highlight in frame-sized slices, reporting progress, and stops when the mode ends', async () => {
        const records = ['a', 'b', 'c'].map(id => design(id));
        const { built, shapes, frames, nextFrame } = environment(records);
        // Each outline costs more than the 12 ms frame budget, so every design ends a slice.
        shapes.mockImplementation(record => {
            const until = performance.now() + 13;
            while (performance.now() < until) { /* an expensive outline */ }
            return { primaryFeatures: record.body };
        });
        const progress = [];
        const drawn = MapPick.begin({ name: 'share', pick: () => {}, highlight: () => ['a', 'b', 'c'], onProgress: (done, total) => progress.push([done, total]) });
        expect(built).toHaveLength(1);
        expect(progress).toEqual([[1, 3]]);
        expect(frames).toHaveLength(1);
        await nextFrame();
        expect(built).toHaveLength(2);
        expect(progress).toEqual([[1, 3], [2, 3]]);
        MapPick.end('share');
        await nextFrame();
        await expect(drawn).resolves.toBe(false);
        expect(built).toHaveLength(2);
        expect(frames).toHaveLength(0);
    });

    it('lets a newer repaint take over a slow one, building each design once', async () => {
        const { built, shapes, nextFrame } = environment(['a', 'b', 'c'].map(id => design(id)));
        shapes.mockImplementation(record => {
            const until = performance.now() + 13;
            while (performance.now() < until) { /* an expensive outline */ }
            return { primaryFeatures: record.body };
        });
        const first = MapPick.begin({ name: 'share', pick: () => {}, highlight: () => ['a', 'b', 'c'] });
        const second = MapPick.refresh();
        // The first repaint waits on its frame after "a"; the second built "b" and waits too.
        expect(built).toHaveLength(2);
        await nextFrame();
        await expect(first).resolves.toBe(false);
        await nextFrame();
        await nextFrame();
        await expect(second).resolves.toBe(true);
        expect(built.map(layer => layer.data.features)).toEqual(['a', 'b', 'c'].map(id => design(id).body));
    });
});

describe('the shapes of a design', () => {
    it('is the design\'s own body when it has one, whatever parcels it sits on', () => {
        const body = [box(16, 46, 16.001, 46.001), { type: 'Feature', properties: {}, geometry: null }];
        const shapes = vi.fn(() => ({ primaryFeatures: body }));
        install('collectProposalFeatureSets', shapes);
        install('__claims', { materializedParcelIdsOf: () => { throw new Error('the body needs no parcels'); } });
        const record = { proposalId: 'road-1' };
        expect(MapPick.outlineOf(record)).toEqual([body[0]]);
        expect(shapes).toHaveBeenCalledWith(record, { includeBuildingGeometry: true });
    });

    it('is otherwise the parcels the design minted, the ones it stands on', () => {
        install('collectProposalFeatureSets', () => ({ primaryFeatures: [] }));
        install('__claims', { materializedParcelIdsOf: () => ['k9-p1', ' k9-p2 ', '', 'k9-p1'] });
        const features = { 'k9-p1': LEFT, 'k9-p2': RIGHT };
        const asked = [];
        install('getParcelFeatureForHighlight', id => { asked.push(id); return features[id]; });
        expect(MapPick.outlineOf({ proposalId: 'layout-1' })).toEqual([LEFT, RIGHT]);
        expect(asked).toEqual(['k9-p1', 'k9-p2']);
    });

    it('keeps of those parcels the ones the body stands on, measured with turf', () => {
        install('turf', turf);
        install('__hoverGround', hoverGround);
        expect(MapPick.groundOf([LEFT, RIGHT], [ON_LEFT])).toEqual([LEFT]);
        // No body to stand on: every parcel it holds.
        expect(MapPick.groundOf([LEFT, RIGHT], [])).toEqual([LEFT, RIGHT]);
        // Without the hover-ground helper or turf there is nothing to measure with.
        install('__hoverGround', undefined);
        expect(MapPick.groundOf([LEFT, RIGHT], [ON_LEFT])).toEqual([LEFT, RIGHT]);
    });

    it('falls back to the highlight features when the design minted no parcels', () => {
        install('__claims', { materializedParcelIdsOf: () => [] });
        install('collectProposalHighlightFeatures', () => [LEFT, { type: 'Feature', geometry: null }, null]);
        expect(MapPick.parcelsOf({ proposalId: 'park-1' })).toEqual([LEFT]);
        install('collectProposalHighlightFeatures', undefined);
        expect(MapPick.parcelsOf({ proposalId: 'park-1' })).toEqual([]);
    });

    it('skips a parcel without a shape, and gives no shapes when a resolver throws', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        install('__claims', { materializedParcelIdsOf: () => ['k9-p1', 'k9-p2'] });
        install('getParcelFeatureForHighlight', id => { if (id === 'k9-p2') throw new Error('not loaded'); return LEFT; });
        expect(MapPick.parcelsOf({ proposalId: 'layout-1' })).toEqual([LEFT]);
        install('collectProposalFeatureSets', () => { throw new Error('no geometry'); });
        expect(MapPick.bodyOf({ proposalId: 'road-1' })).toEqual([]);
        install('__claims', { materializedParcelIdsOf: () => [] });
        install('collectProposalHighlightFeatures', () => { throw new Error('no parcels'); });
        expect(MapPick.parcelsOf({ proposalId: 'road-1' })).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(3);
    });

    it('measures the ground under a body as the area of their intersection', () => {
        install('turf', turf);
        expect(MapPick.groundIntersectionArea(LEFT, ON_LEFT)).toBeCloseTo(turf.area(ON_LEFT), 3);
        expect(MapPick.groundIntersectionArea(LEFT, box(16.005, 46.005, 16.006, 46.006))).toBe(0);
    });
});
