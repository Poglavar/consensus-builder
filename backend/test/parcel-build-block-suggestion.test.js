import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const actionsSource = fs.readFileSync(
    path.resolve(here, '../../frontend/js/parcels/ui/proposal-actions.js'),
    'utf8'
);
const listUiSource = fs.readFileSync(
    path.resolve(here, '../../frontend/js/proposals/list-ui.js'),
    'utf8'
);

function loadActions(overrides = {}) {
    const window = {
        document: { querySelector: vi.fn(() => null), getElementById: vi.fn(() => null) },
        console,
        ...overrides
    };
    window.window = window;
    vm.runInNewContext(actionsSource, {
        window,
        globalThis: window,
        document: window.document,
        console
    });
    return window;
}

describe('whole-block build suggestion', () => {
    it('offers every detected block, including blocks larger than the old hidden cutoff', async () => {
        const showStyledConfirm = vi.fn(async () => false);
        const window = loadActions({
            detectBlockParcelIdsForParcel: vi.fn(() => ({ count: 81, parcelIds: [] })),
            showStyledConfirm
        });

        await expect(window.maybeSuggestWholeBlockForBuild(['parcel-1'])).resolves.toBe(false);
        expect(showStyledConfirm).toHaveBeenCalledOnce();
        expect(showStyledConfirm.mock.calls[0][0]).toContain('81');
    });

    it('stops the one-parcel launch after accepting and selecting the block', async () => {
        const animateFloodfillFromSelected = vi.fn(async () => true);
        const window = loadActions({
            detectBlockParcelIdsForParcel: vi.fn(() => ({ count: 16, parcelIds: [] })),
            showStyledConfirm: vi.fn(async () => true),
            animateFloodfillFromSelected
        });

        await expect(window.maybeSuggestWholeBlockForBuild(['parcel-1'])).resolves.toBe(true);
        expect(animateFloodfillFromSelected).toHaveBeenCalledOnce();
    });

    it('runs the same preflight when Detached is launched from the classic proposal dialog', async () => {
        const maybeSuggestWholeBlockForBuild = vi.fn(async () => true);
        const openParcelBasedForParcels = vi.fn();
        const context = {
            console,
            window: null,
            document: {},
            selectedParcelId: 'parcel-1',
            currentParcel: { layer: { feature: {} } },
            maybeSuggestWholeBlockForBuild,
            openParcelBasedForParcels,
            updateStatus: vi.fn()
        };
        context.window = context;
        vm.runInNewContext(listUiSource, context);

        await context.launchParcelBasedToolForSelection();

        expect(maybeSuggestWholeBlockForBuild).toHaveBeenCalledWith(['parcel-1']);
        expect(openParcelBasedForParcels).not.toHaveBeenCalled();
    });
});
