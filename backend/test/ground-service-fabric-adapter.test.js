// Verify the repository's global fabric adapter batches cache checks and respects explicit drafts.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/parcels/ground-service.js', import.meta.url), 'utf8');

function feature(id, offset = 0) {
    return {
        type: 'Feature',
        properties: { parcelId: id },
        geometry: { type: 'Polygon', coordinates: [[[offset, 0], [offset + 1, 0], [offset + 1, 1], [offset, 1], [offset, 0]]] }
    };
}

function boot({ features, absent = [], mutation } = {}) {
    const integrate = vi.fn(async () => ({ ok: true }));
    const fetchBounds = vi.fn(async () => ({
        status: 'ready', complete: true, returnsWGS84: true, absentIds: [],
        ids: features.map(item => item.properties.parcelId), features
    }));
    const fabric = {
        featureId: vi.fn(item => String(item?.properties?.parcelId || '').trim()),
        absentCadastreIds: vi.fn(() => absent),
        hasCadastreEntries: vi.fn(() => { throw new Error('per-ID membership checks are not used'); })
    };
    const window = {
        LiveParcelFabric: fabric,
        __cadastralGroundTransport: { fetchBounds },
        getRequiredGridCells: () => ['0,0'],
        ProposalManager: { integrateCadastralGround: integrate },
        withCorridorStripRefreshHeld: run => run()
    };
    vm.runInNewContext(source, { window, Promise, console, performance, AbortController });
    return { window, fabric, fetchBounds, integrate, mutation };
}

const bounds = {
    getSouthWest: () => ({ lat: 0, lng: 0 }),
    getNorthEast: () => ({ lat: 1, lng: 1 })
};

describe('global cadastral repository fabric adapter', () => {
    it('checks a cached represented batch once and does no feature-by-feature or mutation work', async () => {
        const rows = [feature('HR-A'), feature('HR-B', 2)];
        const f = boot({ features: rows });
        await f.window.CadastralParcelRepository.ensureBounds(bounds, { city: 'test' });
        f.fabric.absentCadastreIds.mockClear();
        f.fabric.featureId.mockClear();
        f.integrate.mockClear();

        const cached = await f.window.CadastralParcelRepository.ensureBounds(bounds, { city: 'test' });
        expect(cached.cached).toBe(true);
        expect(f.fetchBounds).toHaveBeenCalledTimes(1);
        expect(f.fabric.absentCadastreIds).toHaveBeenCalledOnce();
        expect(f.fabric.absentCadastreIds).toHaveBeenCalledWith(['HR-A', 'HR-B'], { includeCorridors: true });
        expect(f.fabric.featureId).toHaveBeenCalledTimes(rows.length);
        expect(f.fabric.hasCadastreEntries).not.toHaveBeenCalled();
        expect(f.integrate).not.toHaveBeenCalled();
    });

    it('integrates only missing IDs and seeds an explicit draft without consulting committed membership', async () => {
        const rows = [feature('HR-A'), feature('HR-B', 2)];
        const f = boot({ features: rows, absent: ['HR-B'] });
        await f.window.CadastralParcelRepository.ensureBounds(bounds, { city: 'test' });
        expect(f.integrate).toHaveBeenCalledOnce();
        expect(f.integrate).toHaveBeenCalledWith([expect.objectContaining({ properties: expect.objectContaining({ parcelId: 'HR-B' }) })]);

        const seedCadastre = vi.fn();
        const explicitMutation = { seedCadastre };
        const other = boot({ features: rows, absent: ['HR-B'] });
        await other.window.CadastralParcelRepository.ensureBounds(bounds, { city: 'test', mutation: explicitMutation });
        expect(seedCadastre).toHaveBeenCalledOnce();
        expect(Array.from(seedCadastre.mock.calls[0][0], item => item.properties.parcelId)).toEqual(['HR-A', 'HR-B']);
        expect(other.fabric.absentCadastreIds).not.toHaveBeenCalled();
        expect(other.integrate).not.toHaveBeenCalled();
    });
});
