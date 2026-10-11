import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/parcels/fetch.js', import.meta.url), 'utf8');

function boot(ensureBounds) {
    const button = {};
    const statuses = [];
    const window = {
        map: { getBounds: () => ({ pad: () => 'bounds' }), hasLayer: () => false },
        CadastralParcelRepository: { ensureBounds },
        isZoomWithinParcelRange: () => true,
        updateStatus: message => statuses.push(message),
        ParcelGroundFallback: { resetDismissal: vi.fn() },
        runWithButtonBusyState: vi.fn(async (_button, _label, task) => task())
    };
    vm.runInNewContext(source, {
        window, document: { getElementById: () => button },
        URL, URLSearchParams, setTimeout, Promise, console: { log() {}, warn() {}, error() {} }
    });
    return { window, statuses, button };
}

describe('parcel Refresh button', () => {
    it('reports a failed request and resolves without an unhandled rejection', async () => {
        const { window, statuses, button } = boot(async () => { throw new Error('HTTP 503'); });
        await expect(window.refreshParcelDataWithBusyState()).resolves.toBeNull();
        expect(statuses.at(-1)).toBe('Cadastral ground failed to load: HTTP 503');
        expect(window.ParcelGroundFallback.resetDismissal).toHaveBeenCalledOnce();
        expect(window.runWithButtonBusyState).toHaveBeenCalledWith(button, expect.any(Object), expect.any(Function));
    });

    it('keeps the successful refresh result', async () => {
        const { window } = boot(async () => ({ cached: false, features: [1] }));
        await expect(window.refreshParcelDataWithBusyState()).resolves.toMatchObject({ features: [1] });
    });
});
