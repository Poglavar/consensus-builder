// A singular parcel lookup is a join between the committed fabric and its presenter projection.
// It never rebuilds an id index by scanning Leaflet and never resurrects source/cache records.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../../frontend/js/proposals/data.js', import.meta.url)), 'utf8');

function loadFindParcelById(fabric, presenter) {
    const start = source.indexOf('    findParcelById(parcelId) {');
    expect(start, 'findParcelById not found').toBeGreaterThan(-1);
    const end = source.indexOf('\n    },', start);
    expect(end, 'end of findParcelById not found').toBeGreaterThan(start);
    const body = source.slice(start + 4, end + 6);
    // eslint-disable-next-line no-new-func
    return new Function('globalThis', 'window', `return function ${body}`)(
        { LiveParcelFabric: fabric, ParcelPresenter: presenter },
        { LiveParcelFabric: fabric, ParcelPresenter: presenter }
    );
}

describe('proposalStorage.findParcelById authority', () => {
    it('returns an exact layer only while the exact feature is committed', () => {
        const layer = { feature: { properties: { parcelId: 'HR-A#piece' } } };
        const fabric = { get: vi.fn(id => id === 'HR-A#piece' ? layer.feature : null) };
        const presenter = { getLayer: vi.fn(() => layer), resolveLiveLayers: vi.fn(() => []) };
        const find = loadFindParcelById(fabric, presenter);

        expect(find('HR-A#piece')).toBe(layer);
        expect(presenter.getLayer).toHaveBeenCalledWith('HR-A#piece');
    });

    it('returns no stale presenter layer once the fabric no longer contains that id', () => {
        const stale = { feature: { properties: { parcelId: 'HR-A#old' } } };
        const fabric = { get: () => null };
        const presenter = { getLayer: () => stale, resolveLiveLayers: () => [] };
        const find = loadFindParcelById(fabric, presenter);

        expect(find('HR-A#old')).toBeNull();
    });

    it('does not implicitly expand a cadastral anchor, even when it currently has one live piece', () => {
        const left = { feature: { properties: { parcelId: 'HR-A#left' } } };
        const right = { feature: { properties: { parcelId: 'HR-A#right' } } };
        const fabric = { get: () => null };
        const presenter = { getLayer: () => null, resolveLiveLayers: vi.fn(() => [left]) };
        const find = loadFindParcelById(fabric, presenter);

        expect(find('HR-A')).toBeNull();
        presenter.resolveLiveLayers.mockReturnValue([left, right]);
        expect(find('HR-A')).toBeNull();
        expect(presenter.resolveLiveLayers).not.toHaveBeenCalled();
    });

    it('contains no cache, persistence, registry-map, or Leaflet-scan recovery path', () => {
        const start = source.indexOf('    findParcelById(parcelId) {');
        const end = source.indexOf('\n    },', start);
        const implementation = source.slice(start, end);
        expect(implementation).not.toMatch(/parcelCache|PersistentStorage|parcelLayerById/);
        expect(implementation).not.toMatch(/parcelLayer\.(eachLayer|getLayers)/);
        expect(implementation).toContain('LiveParcelFabric');
        expect(implementation).toContain('ParcelPresenter');
    });
});
