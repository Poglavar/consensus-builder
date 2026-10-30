// Building transport: a URL source (`building.<base64url>`) is read by the browser's adapter worker and
// never reaches our server; a database source goes to POST /buildings/cell. Everything the browser
// reads goes by cell: loadBox reads the cells over a box from the sources in use there.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const client = require('../../frontend/js/building-source-client.js');
const SourceList = require('../../frontend/js/source-list.js');
const geometry = { type: 'Point', coordinates: [-74.08, 4.61] };
const urlSource = 'building.eyJhZGFwdGVyIjoiYXJjZ2lzIn0';
function page(sources, answers, configAt = null, extra = {}) {
    const calls = [];
    const global = { SourceList, getBackendBase: () => 'http://backend.test',
        CityConfigManager: { getCurrentCityConfig: () => ({ buildings: { sources } }),
            ...(configAt ? { getCityConfigAt: configAt } : {}) },
        fetch: async (url, init) => {
            calls.push({ url, body: JSON.parse(init.body), signal: init.signal });
            const answer = answers.shift();
            if (answer instanceof Error) throw answer;
            return { ok: true, json: async () => answer };
        }, ...extra };
    return { global, calls };
}
describe('building source client', () => {
    it('asks a database source for one cell from POST /buildings/cell', async () => {
        const readCell = vi.fn();
        const { global, calls } = page([{ id: 'gdi-3d' }], [{ supported: true, items: [], complete: true }], null,
            { BrowserBuildingSources: { readCell } });
        const bbox = [15.97, 45.80, 15.975, 45.805];
        await client.requestCell({ kind: 'footprints', source: 'gdi-3d', bbox }, { global });
        expect(calls[0]).toMatchObject({ url: 'http://backend.test/buildings/cell', body: { kind: 'footprints', source: 'gdi-3d', bbox } });
        expect(readCell).not.toHaveBeenCalled();
    });

    it('reads a URL source cell in the adapter worker, with no request to our server', async () => {
        const answer = { supported: true, kind: 'near', items: [{ object_id: 'B-1' }], complete: true };
        const readCell = vi.fn(async () => answer);
        const { global, calls } = page([{ id: urlSource }], [], null, { BrowserBuildingSources: { readCell } });
        const signal = new AbortController().signal;
        const bbox = [-74.11, 4.61, -74.10, 4.62];
        expect(await client.requestCell({ kind: 'near', source: urlSource, bbox, signal }, { global })).toBe(answer);
        expect(readCell).toHaveBeenCalledExactlyOnceWith(urlSource, { kind: 'near', bbox }, { signal });
        expect(calls).toHaveLength(0);
        // Without the worker the read fails loudly instead of falling back to our server.
        const bare = page([{ id: urlSource }], []);
        await expect(client.requestCell({ kind: 'near', source: urlSource, bbox }, { global: bare.global })).rejects.toThrow(/adapter worker/);
        expect(bare.calls).toHaveLength(0);
    });

    it('sends the evidence namespace of the city at the cell with a 3D cell only', async () => {
        const { global, calls } = page([{ id: 'gdi-3d' }], [{ items: [] }, { items: [] }], () => ({
            buildings: { sources: [{ id: 'gdi-3d' }] }, floorModels: { namespace: 'evidence-collection' } }));
        const bbox = [15.97, 45.80, 15.975, 45.805];
        await client.requestCell({ kind: 'near', source: 'gdi-3d', bbox }, { global });
        await client.requestCell({ kind: 'footprints', source: 'gdi-3d', bbox }, { global });
        expect(calls.map(call => call.body.floorModelNamespace)).toEqual(['evidence-collection', undefined]);
    });

    it('reads the cells over a box from the sources in use there, each item with its source', async () => {
        const cell = { key: 'c', bbox: [0, 0, 1, 1], distanceM: 0 };
        const load = vi.fn(async ({ onCell }) => {
            onCell(cell, { items: [{ id: 1 }], source: 'osm' });
            onCell(cell, { failed: true, items: [] });
            return { failed: 1, retryAfter: 30 };
        });
        const global = { buildingCellsFor: vi.fn(() => ({ cells: [cell], sources: ['gdi-3d', 'osm'] })), BuildingCellLoader: { load } };
        expect(await client.loadBox({ kind: 'near', box: [0, 0, 1, 1] }, { global }))
            .toEqual({ items: [{ id: 1, source: 'osm' }], failed: 1, retryAfter: 30 });
        expect(load.mock.calls[0][0]).toMatchObject({ kind: 'near', sources: ['gdi-3d', 'osm'], cells: [cell] });
    });
});
