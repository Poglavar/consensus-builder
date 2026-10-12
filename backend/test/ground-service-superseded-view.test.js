// A superseded viewport cancels the grid cells only it wanted; cells another caller still wants keep loading.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/parcels/ground-service.js', import.meta.url), 'utf8');

const feature = id => ({ type: 'Feature', properties: { parcelId: `HR-${id}` },
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } });
const view = keys => ({ keys, getSouthWest: () => ({ lat: 0, lng: 0 }), getNorthEast: () => ({ lat: 1, lng: 1 }) });

function boot() {
    const requests = new Map();
    const fetchBounds = vi.fn((_bounds, { keys: [key], signal }) => new Promise((resolve, reject) => {
        requests.set(key, { signal, resolve: () => resolve({ status: 'ready', complete: true, returnsWGS84: true,
            absentIds: [], ids: [`HR-${key}`], features: [feature(key)] }) });
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const window = {
        LiveParcelFabric: { featureId: item => String(item?.properties?.parcelId || ''), absentCadastreIds: () => [] },
        __cadastralGroundTransport: { fetchBounds },
        getRequiredGridCells: bounds => bounds.keys,
        withCorridorStripRefreshHeld: run => run()
    };
    vm.runInNewContext(source, { window, Promise, console, performance, AbortController });
    return { repository: window.CadastralParcelRepository, fetchBounds, requests };
}

const sentKeys = fetchBounds => fetchBounds.mock.calls.map(([, options]) => options.keys[0]);
const settle = () => new Promise(resolve => setImmediate(resolve));

describe('superseded viewport cells', () => {
    it('cancels cells only the old view wanted, never sends its queued cells, and keeps shared cells loading', async () => {
        const { repository, fetchBounds, requests } = boot();
        const older = new AbortController(), newer = new AbortController();
        // Six cells start at once; o6 and o7 wait in the queue.
        const oldView = repository.ensureBounds(view(['shared', 'o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7']), { city: 'oxford', signal: older.signal });
        const oldOutcome = oldView.then(() => 'resolved', error => error.name);
        await settle();
        expect(sentKeys(fetchBounds)).toEqual(['shared', 'o1', 'o2', 'o3', 'o4', 'o5']);

        const newView = repository.ensureBounds(view(['shared', 'n1']), { city: 'oxford', signal: newer.signal });
        older.abort();
        await settle();
        expect(await oldOutcome).toBe('AbortError');
        expect(['o1', 'o2', 'o3', 'o4', 'o5'].every(key => requests.get(key).signal.aborted)).toBe(true);
        expect(requests.get('shared').signal.aborted).toBe(false);
        expect(sentKeys(fetchBounds)).toEqual(['shared', 'o1', 'o2', 'o3', 'o4', 'o5', 'n1']);

        requests.get('shared').resolve();
        requests.get('n1').resolve();
        const result = await newView;
        expect(result.features.map(item => item.properties.parcelId).sort()).toEqual(['HR-n1', 'HR-shared']);
        expect(sentKeys(fetchBounds)).not.toContain('o6');

        // A cancelled cell is not left behind as in flight: asking again requests it afresh.
        const again = repository.ensureBounds(view(['o1']), { city: 'oxford' });
        await settle();
        expect(sentKeys(fetchBounds).filter(key => key === 'o1')).toHaveLength(2);
        requests.get('o1').resolve();
        await expect(again).resolves.toMatchObject({ status: 'ready' });
    });

    it('a caller without a signal keeps a shared cell alive after every cancellable caller leaves', async () => {
        const { repository, requests } = boot();
        const viewport = new AbortController();
        const cancellable = repository.ensureBounds(view(['cell']), { city: 'oxford', signal: viewport.signal });
        const permanent = repository.ensureBounds(view(['cell']), { city: 'oxford' });
        viewport.abort();
        await expect(cancellable).rejects.toMatchObject({ name: 'AbortError' });
        expect(requests.get('cell').signal.aborted).toBe(false);
        requests.get('cell').resolve();
        await expect(permanent).resolves.toMatchObject({ status: 'ready' });
    });
});

describe('grid cells fetched in blocks', () => {
    function bootBlocks() {
        const blockCalls = [], cellCalls = [], requests = new Map();
        const answer = keys => ({ cells: keys.map(key => ({ key, result: { status: 'ready', complete: true, returnsWGS84: true,
            absentIds: [], features: [feature(key)] } })) });
        const pending = (keys, signal, shape) => new Promise((resolve, reject) => {
            requests.set(keys.join('|'), { signal, resolve: () => resolve(shape(keys)) });
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        const transport = {
            cellBlockSide: () => 5,
            fetchCellBlock: vi.fn((_bounds, { keys, signal }) => { blockCalls.push(keys); return pending(keys, signal, answer); }),
            fetchBounds: vi.fn((_bounds, { keys, signal }) => { cellCalls.push(keys); return pending(keys, signal,
                ([key]) => ({ status: 'ready', complete: true, returnsWGS84: true, absentIds: [], ids: [`HR-${key}`], features: [feature(key)] })); })
        };
        const window = {
            LiveParcelFabric: { featureId: item => String(item?.properties?.parcelId || ''), absentCadastreIds: () => [] },
            __cadastralGroundTransport: transport,
            getRequiredGridCells: bounds => bounds.keys,
            withCorridorStripRefreshHeld: run => run()
        };
        vm.runInNewContext(source, { window, Promise, console, performance, AbortController });
        return { repository: window.CadastralParcelRepository, blockCalls, cellCalls, requests };
    }

    it('groups requested cells into aligned blocks, one request each, and records every cell on its own', async () => {
        const { repository, blockCalls, cellCalls, requests } = bootBlocks();
        const loading = repository.ensureBounds(view(['0,0', '1,0', '4,4', '5,0']), { city: 'oxford' });
        await settle();
        expect(blockCalls).toEqual([['0,0', '1,0', '4,4']]);
        expect(cellCalls).toEqual([['5,0']]);
        requests.forEach(request => request.resolve());
        const result = await loading;
        expect(result.requestCount).toBe(2);
        expect(result.features.map(item => item.properties.parcelId).sort()).toEqual(['HR-0,0', 'HR-1,0', 'HR-4,4', 'HR-5,0']);
        const cached = await repository.ensureBounds(view(['4,4']), { city: 'oxford' });
        expect(cached.cached).toBe(true);
        expect(cached.features.map(item => item.properties.parcelId)).toEqual(['HR-4,4']);
    });

    it('keeps a block loading while a newer view still wants one of its cells, and cancels it when none is wanted', async () => {
        const { repository, requests } = bootBlocks();
        const older = new AbortController(), newer = new AbortController();
        const oldView = repository.ensureBounds(view(['0,0', '1,0']), { city: 'oxford', signal: older.signal });
        const oldOutcome = oldView.then(() => 'resolved', error => error.name);
        await settle();
        const newView = repository.ensureBounds(view(['1,0']), { city: 'oxford', signal: newer.signal });
        older.abort();
        await settle();
        expect(await oldOutcome).toBe('AbortError');
        expect(requests.get('0,0|1,0').signal.aborted).toBe(false);
        newer.abort();
        await expect(newView).rejects.toMatchObject({ name: 'AbortError' });
        expect(requests.get('0,0|1,0').signal.aborted).toBe(true);
    });
});

