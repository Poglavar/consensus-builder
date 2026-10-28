import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const { bottomInset } = createRequire(import.meta.url)('../../frontend/js/ui/dock-clearance.js');
const viewport = { width: 1600, height: 900, dockWidth: 400, dockGap: 10, gap: 8 };
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });

describe('desktop dock clearance', () => {
    it('uses the bottom edge when centred navigation clears the inspection column', () => {
        expect(bottomInset({ ...viewport, obstacles: [rect(650, 850, 300, 40)] })).toBe(10);
    });
    it('shortens the column above controls only when their horizontal bounds meet', () => {
        expect(bottomInset({ ...viewport, width: 1100, obstacles: [rect(400, 850, 300, 40)] })).toBe(58);
    });
    it('clears the highest overlapping message independently of the navigation row', () => {
        expect(bottomInset({ ...viewport, width: 1100, obstacles: [rect(400, 850, 300, 40), rect(290, 780, 520, 54)] })).toBe(128);
    });
    it('retains the bottom edge for empty, offscreen and nonoverlapping controls', () => {
        expect(bottomInset({ ...viewport, obstacles: [rect(1300, 20, 0, 40), rect(0, 700, 400, 40), rect(1300, 920, 100, 40)] })).toBe(10);
    });
    it('keeps a gap at the collision boundary and rounds up fractional clearance', () => {
        expect(bottomInset({ ...viewport, obstacles: [rect(1000, 850.5, 182, 40)] })).toBe(10);
        expect(bottomInset({ ...viewport, obstacles: [rect(1000, 850.5, 183, 40)] })).toBe(58);
    });
});
