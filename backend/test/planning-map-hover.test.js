// Keep the planning 2D map directly selectable without transient hover labels.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';

describe('planning 2D map hover behavior', () => {
    it('renders permitted envelope geometry without height labels and keeps click inspection wired', () => {
        const source = readFileSync(new URL('../../frontend/js/planning/views.js', import.meta.url), 'utf8');
        const body = parse(source).program.body.find(node => node.type === 'ExpressionStatement').expression.callee.body.body;
        const drawMap = body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'drawMap');
        const feature = { properties: { geometryRole: 'body', topM: 10.7 }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } };
        const item = { id: 'permitted:1', role: 'permitted', title: 'Permitted envelope', parcelEnvelope: true, source: { parcel: '1-2' },
            assessment: { meaning: 'outer-bound' } };
        const state = { selectedId: null, permittedMap: null };
        const shape = { bindTooltip: vi.fn(), addTo: vi.fn(function () { return this; }), on: vi.fn(),
            eachLayer: vi.fn(), getBounds: vi.fn() };
        const layer = { clearLayers: vi.fn() };
        const select = vi.fn();
        const marker = vi.fn();
        const root = { L: { geoJSON: vi.fn(() => shape), marker, DomEvent: { stopPropagation: vi.fn() } }, map: { getZoom: () => 19 }, MapHighlight: { color: '#000', style: () => ({}) },
            __mapEditLock: null, ClickStack: { handleClick: vi.fn() }, i18n: { t: key => key },
            dispatchEvent() {} };
        const context = vm.createContext({ root, ready: true, selectionLayer: { clearLayers: vi.fn() }, layer,
            hitShapes: [], store: { get: () => state }, selected: () => null, sceneItems: () => [item],
            appearance: () => 'solid', envelopes: { mapFeatures: vi.fn(() => [feature]) }, realization: () => ({}),
            color: () => '#fff', select, t: key => key, lotNote: () => '', scenarioLabel: () => '',
            rootMap: root.map, console });

        vm.runInContext(`(${source.slice(drawMap.start, drawMap.end)})()`, context);

        expect(context.envelopes.mapFeatures).toHaveBeenCalledWith(item, expect.any(Object));
        expect(root.L.geoJSON).toHaveBeenCalledWith(feature, expect.objectContaining({ interactive: true }));
        expect(marker).not.toHaveBeenCalled();
        expect(shape.bindTooltip).not.toHaveBeenCalled();
        expect(shape.on).toHaveBeenCalledWith('click', expect.any(Function));
        expect(context.hitShapes).toHaveLength(1);
        const click = shape.on.mock.calls.find(([name]) => name === 'click')[1];
        const at = { lat: 51, lng: 0 };
        click({ latlng: at });
        expect(root.ClickStack.handleClick).toHaveBeenCalledWith(at, { allowUrbanBlocks: true });
    });
});
