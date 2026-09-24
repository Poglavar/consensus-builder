// A failed cadastral ground fetch must surface (status bar + timestamped console.error) and never
// escape as an unhandled rejection from the fire-and-forget callers (boot, visibility, data source).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const fetchSource = readFileSync(new URL('../../frontend/js/parcels/fetch.js', import.meta.url), 'utf8');
const visibilitySource = readFileSync(new URL('../../frontend/js/parcels/ui/visibility.js', import.meta.url), 'utf8');

function boot(ensureBounds) {
    const statuses = [];
    const window = {
        map: { getBounds: () => ({ pad: () => 'padded-bounds' }), hasLayer: () => false },
        CadastralParcelRepository: { ensureBounds },
        updateStatus: message => statuses.push(message),
        isZoomWithinParcelRange: () => true
    };
    const context = vm.createContext({ window, URL, URLSearchParams, console, setTimeout, Promise });
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

    it('showAllParcels and showOnlyRoadParcels surface a failure without an unhandled rejection', async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { window, statuses } = boot(async () => { throw new Error('offline'); });

        const unhandled = await collectUnhandled(async () => {
            window.showAllParcels();
            window.showOnlyRoadParcels();
        });

        expect(unhandled).toEqual([]);
        expect(statuses).toContain('Cadastral ground failed to load: offline');
        expect(statuses.at(-1)).toBe('No parcel layer loaded yet; road parcels cannot be shown.');
        expect(errors.mock.calls.map(call => call[0]).join('\n')).toMatch(/show all parcels[\s\S]*show road parcels/);
    });
});
