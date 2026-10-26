// Keep the planning 2D map directly selectable without transient hover labels.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';

describe('planning 2D map hover behavior', () => {
    it('does not bind hover tooltips to ordinary massing shapes and keeps click inspection wired', () => {
        const source = readFileSync(new URL('../../frontend/js/planning/views.js', import.meta.url), 'utf8');
        const body = parse(source).program.body.find(node => node.type === 'ExpressionStatement').expression.callee.body.body;
        const drawMap = body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'drawMap');
        const feature = { properties: { geometryRole: 'body' } };
        const item = { id: 'existing:1', role: 'existing', title: 'Building', source: { parcel: '1-2' },
            assessment: { meaning: 'existing-stock-estimate' } };
        const state = { selectedId: null, permittedMap: null };
        const shape = { bindTooltip: vi.fn(), addTo: vi.fn(function () { return this; }), on: vi.fn(),
            eachLayer: vi.fn(), getBounds: vi.fn() };
        const layer = { clearLayers: vi.fn() };
        const select = vi.fn();
        const root = { L: { geoJSON: vi.fn(() => shape), DomEvent: { stopPropagation: vi.fn() } }, map: {}, MapHighlight: { color: '#000', style: () => ({}) },
            __mapEditLock: null, ClickStack: { handleClick: vi.fn() }, i18n: { t: key => key },
            dispatchEvent() {} };
        const context = vm.createContext({ root, ready: true, selectionLayer: { clearLayers: vi.fn() }, layer,
            hitShapes: [], store: { get: () => state }, selected: () => null, sceneItems: () => [item],
            appearance: () => 'solid', envelopes: { mapFeatures: () => [feature] }, realization: () => ({}),
            color: () => '#fff', select, t: key => key, lotNote: () => '', scenarioLabel: () => '',
            rootMap: root.map, console });

        vm.runInContext(`(${source.slice(drawMap.start, drawMap.end)})()`, context);

        expect(shape.bindTooltip).not.toHaveBeenCalled();
        expect(shape.on).toHaveBeenCalledWith('click', expect.any(Function));
        expect(context.hitShapes).toHaveLength(1);
        const click = shape.on.mock.calls.find(([name]) => name === 'click')[1];
        const at = { lat: 51, lng: 0 };
        click({ latlng: at });
        expect(root.ClickStack.handleClick).toHaveBeenCalledWith(at, { allowUrbanBlocks: true });
    });
});
