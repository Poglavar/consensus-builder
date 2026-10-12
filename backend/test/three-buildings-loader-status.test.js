// The 3D buildings loader writes the status line (ephemerals.md): "Loading buildings…" under a
// hold while the nearby fetch and the glTF models are in flight, then a completion word when the
// hold ends, so the loading text never stays behind without its spinner. Exercises the real
// updateBuildingsLoader from three-mode.js with its closure state stubbed.
import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const source = fs.readFileSync(new URL('../../frontend/js/three-mode.js', import.meta.url), 'utf8');
const start = source.indexOf('function updateBuildingsLoader()');
const end = source.indexOf('function stopIntroAutoRotate()', start);
if (start < 0 || end <= start) throw new Error('Could not find updateBuildingsLoader in three-mode.js');

function harness() {
    const updateStatus = vi.fn();
    const release = vi.fn();
    const beginStatusActivity = vi.fn(() => release);
    const api = new Function('threeI18n', 'updateStatus', 'beginStatusActivity', `
        let isActive = true, nearbyProposalBuildingsFetching = false, pendingModelLoads = 0;
        let buildingsLoaderRelease = null, buildingsLoaderText = '';
        ${source.slice(start, end)}
        return {
            update: updateBuildingsLoader,
            set(state) {
                if ('active' in state) isActive = state.active;
                if ('fetching' in state) nearbyProposalBuildingsFetching = state.fetching;
                if ('pending' in state) pendingModelLoads = state.pending;
            }
        };
    `)((_key, fallback) => fallback, updateStatus, beginStatusActivity);
    return { ...api, updateStatus, beginStatusActivity, release };
}

describe('3D buildings loader on the status line', () => {
    it('holds the line while models load and ends the hold with a completion word, once', () => {
        const h = harness();
        h.set({ pending: 2 });
        h.update();
        expect(h.updateStatus).toHaveBeenLastCalledWith('Loading buildings… (2)', { transient: true });
        expect(h.beginStatusActivity).toHaveBeenCalledTimes(1);

        h.set({ pending: 1 });
        h.update();
        expect(h.updateStatus).toHaveBeenLastCalledWith('Loading buildings… (1)', { transient: true });
        expect(h.beginStatusActivity).toHaveBeenCalledTimes(1);
        expect(h.release).not.toHaveBeenCalled();

        h.set({ pending: 0 });
        h.update();
        expect(h.release).toHaveBeenCalledTimes(1);
        expect(h.updateStatus).toHaveBeenLastCalledWith('Buildings loaded');
        expect(h.updateStatus).toHaveBeenCalledTimes(3);

        h.update();
        h.update();
        expect(h.release).toHaveBeenCalledTimes(1);
        expect(h.updateStatus).toHaveBeenCalledTimes(3);
    });

    it('says nothing when nothing was loading, in or out of 3D', () => {
        const h = harness();
        h.update();
        h.set({ active: false, fetching: true, pending: 3 });
        h.update();
        expect(h.updateStatus).not.toHaveBeenCalled();
        expect(h.beginStatusActivity).not.toHaveBeenCalled();
        expect(h.release).not.toHaveBeenCalled();
    });

    it('treats the nearby fetch alone as loading and closes it the same way', () => {
        const h = harness();
        h.set({ fetching: true });
        h.update();
        expect(h.updateStatus).toHaveBeenLastCalledWith('Loading buildings…', { transient: true });
        h.set({ fetching: false });
        h.update();
        expect(h.release).toHaveBeenCalledTimes(1);
        expect(h.updateStatus).toHaveBeenLastCalledWith('Buildings loaded');
    });
});
