// Fit the same map rectangle the critic leaves visible around its side or bottom panel.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';

const win = {};
vm.runInNewContext(readFileSync(new URL('../../frontend/js/proposals/critic-tour.js', import.meta.url), 'utf8'), { window: win });
const bounds = { isValid: () => true, getNorthWest: () => ({ x: 60, y: 110 }), getSouthEast: () => ({ x: 540, y: 540 }) };

it.each([
    [{ left: 35, top: 80, right: 320, bottom: 70 }, false],
    [{ left: 35, top: 80, right: 480, bottom: 70 }, true],
    [{ left: 35, top: 80, right: 35, bottom: 300 }, true]
])('keeps a visible target and fits one obscured by the panel', (padding, moved) => {
    const map = { getSize: () => ({ x: 1000, y: 800 }), latLngToContainerPoint: p => p, fitBounds: vi.fn() };
    expect(win.CriticTour.fitContext(map, bounds, padding)).toBe(moved);
    expect(map.fitBounds).toHaveBeenCalledTimes(Number(moved));
    expect(win.CriticTour.fitContext(map, bounds, padding, { force: true })).toBe(true);
    expect(map.fitBounds).toHaveBeenLastCalledWith(bounds, expect.objectContaining({ paddingBottomRight: [padding.right, padding.bottom] }));
});
