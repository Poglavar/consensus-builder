// A failed cadastral ground fetch must surface (status bar + timestamped console.error) and never
// escape as an unhandled rejection from the fire-and-forget callers (boot, visibility, data source).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const fetchSource = readFileSync(new URL('../../frontend/js/parcels/fetch.js', import.meta.url), 'utf8');
const visibilitySource = readFileSync(new URL('../../frontend/js/parcels/ui/visibility.js', import.meta.url), 'utf8');

function boot(ensureBounds, fabric = null, ParcelSourceHealth = null) {
    const statuses = [];
    const window = {
        map: { getBounds: () => ({ pad: () => 'padded-bounds' }), hasLayer: () => false },
        CadastralParcelRepository: { ensureBounds },
        LiveParcelFabric: fabric,
        ParcelSourceHealth,
        updateStatus: message => statuses.push(message),
        isZoomWithinParcelRange: () => true
    };
    const context = vm.createContext({ window, URL, URLSearchParams, console, setTimeout, Promise, AbortController });
    vm.runInContext(fetchSource, context);
    vm.runInContext(visibilitySource, context);
    return { window, statuses };
}

async function collectUnhandled(run) {
    const unhandled = [];
    const onUnhandled = reason => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
        await run();
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
    return unhandled;
}

afterEach(() => vi.restoreAllMocks());

describe('fetchParcelDataReported', () => {
    it('reports a failed fetch and resolves null instead of rejecting', async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { window, statuses } = boot(async () => { throw new Error('HTTP 502'); });

        const unhandled = await collectUnhandled(async () => {
            await expect(window.fetchParcelDataReported(undefined, 'initial map load')).resolves.toBeNull();
        });

        expect(unhandled).toEqual([]);
        expect(statuses.at(-1)).toBe('Cadastral ground failed to load: HTTP 502');
        expect(errors).toHaveBeenCalledWith(
            expect.stringMatching(/^\[\d{4}-\d\d-\d\dT[^\]]+\] \[ParcelFetch\] .*\(initial map load\): HTTP 502$/),
            expect.any(Error)
        );
        expect(window._fetchParcelDataInProgress).toBe(false);
    });

    it('passes a successful result through', async () => {
        const { window } = boot(async () => ({ cached: false, features: [1, 2] }));
        await expect(window.fetchParcelDataReported(undefined, 'x')).resolves.toMatchObject({ features: [1, 2] });
    });

    it('uses clone-free fabric counts when reporting a failed fetch', async () => {
        const counts = vi.fn().mockReturnValueOnce(2).mockReturnValueOnce(7);
        const queryBounds = vi.fn(() => { throw new Error('queryBounds should not clone for counts'); });
        let loaded;
        const fabric = { countBounds: counts, queryBounds };
        const health = { createRequester: () => async () => {}, describeFailure: (_error, context) => {
            loaded = context.loaded;
            return 'reported';
        } };
        const { window, statuses } = boot(async () => { throw new Error('offline'); }, fabric, health);
        await window.fetchParcelDataReported(undefined, 'test');

        expect(loaded).toEqual({ inMemory: 2, inView: 7 });
        expect(counts).toHaveBeenCalledTimes(2);
        expect(queryBounds).not.toHaveBeenCalled();
        expect(statuses.at(-1)).toBe('reported');
    });

    it('showAllParcels and showOnlyRoadParcels surface a failure without an unhandled rejection', async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { window, statuses } = boot(async () => { throw new Error('offline'); });

        const unhandled = await collectUnhandled(async () => {
            window.showAllParcels();
            // Let the first fetch settle: a second whole-view fetch would supersede it.
            await new Promise(resolve => setImmediate(resolve));
            window.showOnlyRoadParcels();
        });

        expect(unhandled).toEqual([]);
        expect(statuses).toContain('Cadastral ground failed to load: offline');
        expect(statuses.at(-1)).toBe('No parcel layer loaded yet; road parcels cannot be shown.');
        expect(errors.mock.calls.map(call => call[0]).join('\n')).toMatch(/show all parcels[\s\S]*show road parcels/);
    });

    it('a newer whole-view fetch supersedes the older one, which resolves null without reporting', async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const signals = [], gates = [];
        const { window, statuses } = boot((_bounds, { signal }) => {
            signals.push(signal);
            return new Promise((resolve, reject) => {
                gates.push({ resolve, reject });
                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
        });
        window.ParcelsState = { isFetching: false, setIsFetchingParcels(value) { this.isFetching = value; } };
        const older = window.fetchParcelDataReported(undefined, 'older view');
        const newer = window.fetchParcelDataReported(undefined, 'newer view');
        await expect(older).resolves.toBeNull();
        expect(signals[0].aborted).toBe(true);
        expect(signals[1].aborted).toBe(false);
        expect(window.ParcelsState.isFetching).toBe(true);
        gates[1].reject(new Error('offline'));
        await expect(newer).resolves.toBeNull();
        expect(errors.mock.calls.map(call => call[0]).join('\n')).not.toMatch(/older view/);
        expect(errors.mock.calls.map(call => call[0]).join('\n')).toMatch(/newer view/);
        expect(statuses.at(-1)).toBe('Cadastral ground failed to load: offline');
        expect(window.ParcelsState.isFetching).toBe(false);
    });
});
