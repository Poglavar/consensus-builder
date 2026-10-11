import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

it('the vertices button follows the rendered layer through show and hide', () => {
    const classes = new Set();
    const button = {
        textContent: '',
        classList: {
            add: (...names) => names.forEach(name => classes.add(name)),
            remove: (...names) => names.forEach(name => classes.delete(name)),
            toggle: name => { if (classes.has(name)) { classes.delete(name); return false; } classes.add(name); return true; }
        },
        addEventListener: (_name, handler) => { button.click = handler; }
    };
    const feature = { type: 'Feature', properties: { parcelId: 'p' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } };
    const layers = new Set();
    const map = { removeLayer: layer => layers.delete(layer) };
    const context = vm.createContext({
        window: {
            addEventListener() {},
            LiveParcelFabric: { queryBounds: () => [feature], get: () => feature },
            ParcelPresenter: { getLayer: () => ({}) }
        },
        document: { getElementById: id => id === 'block-vertices-button' ? button : id === 'block-tools-content' ? {} : null },
        map, console,
        L: {
            layerGroup: () => ({ vertices: [], addTo() { layers.add(this); return this; } }),
            circleMarker: coordinates => ({ addTo(layer) { layer.vertices.push(coordinates); } })
        }
    });
    vm.runInContext(readFileSync(new URL('../../frontend/js/parcel-blocks.js', import.meta.url), 'utf8'), context);
    context.window.blockStorage.blocks.set('test block', { parcelIds: ['p'] });
    context.renderBlockInfoTools('test block');

    button.click();
    expect(layers.size).toBe(1);
    expect([...layers][0].vertices).toHaveLength(4);
    expect(button.textContent).toBe('Hide vertices');
    expect(classes.has('active')).toBe(true);

    button.click();
    expect(layers.size).toBe(0);
    expect(button.textContent).toBe('Show vertices');
    expect(classes.has('active')).toBe(false);
});
