// Headless tests for urban-block map framing and the transparent target-block scenario. These pure
// functions keep layout decisions and area arithmetic verifiable without a map or browser.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fitPadding } = require('../../frontend/js/urban-blocks-layout.js');
const { targetBlockCount } = require('../../frontend/js/urban-blocks-model.js');

describe('urban block inspector map framing', () => {
    const mapRect = { left: 0, top: 0, right: 1000, bottom: 700 };

    it('reserves a desktop right-side panel with the requested gap', () => {
        expect(fitPadding(mapRect, [{ edge: 'right', rect: { left: 700, top: 80, right: 990, bottom: 620 } }], 16))
            .toEqual({ paddingTopLeft: [16, 16], paddingBottomRight: [316, 16] });
    });

    it('reserves a mobile bottom sheet and gives a collapsed sheet more map space', () => {
        const expanded = fitPadding(mapRect, [{ edge: 'bottom', rect: { left: 0, top: 430, right: 1000, bottom: 700 } }]);
        const collapsed = fitPadding(mapRect, [{ edge: 'bottom', rect: { left: 0, top: 610, right: 1000, bottom: 700 } }]);
        expect(expanded.paddingBottomRight[1]).toBe(286);
        expect(collapsed.paddingBottomRight[1]).toBe(106);
        expect(collapsed.paddingBottomRight[1]).toBeLessThan(expanded.paddingBottomRight[1]);
    });

    it('returns padding relative to an offset map container', () => {
        expect(fitPadding({ left: 120, top: 80, right: 920, bottom: 680 }, [
            { edge: 'left', rect: { left: 0, top: 100, right: 300, bottom: 500 } },
            { edge: 'top', rect: { left: 400, top: 0, right: 700, bottom: 160 } }
        ], 10)).toEqual({ paddingTopLeft: [190, 90], paddingBottomRight: [10, 10] });
    });

    it('ignores obstacles fully outside the map container', () => {
        expect(fitPadding(mapRect, [
            { edge: 'right', rect: { left: 1010, top: 100, right: 1200, bottom: 500 } },
            { edge: 'bottom', rect: { left: 10, top: 710, right: 900, bottom: 800 } }
        ])).toEqual({ paddingTopLeft: [16, 16], paddingBottomRight: [16, 16] });
    });

    it('returns null when obstacles leave less than 40 pixels of usable map span', () => {
        expect(fitPadding({ left: 0, top: 0, right: 500, bottom: 400 }, [
            { edge: 'left', rect: { left: 0, top: 0, right: 240, bottom: 400 } },
            { edge: 'right', rect: { left: 260, top: 0, right: 500, bottom: 400 } }
        ])).toBeNull();
    });
});

describe('target block count scenario', () => {
    it('rounds up area divided by the target square area and keeps at least one block', () => {
        expect(targetBlockCount(10_000)).toBe(1);
        expect(targetBlockCount(10_001)).toBe(2);
        expect(targetBlockCount(50_000, 50)).toBe(20);
        expect(targetBlockCount(1, 100)).toBe(1);
    });

    it.each([
        [null, 100], [0, 100], [-1, 100], [NaN, 100], [Infinity, 100],
        [10_000, 0], [10_000, -10], [10_000, NaN], [10_000, Infinity]
    ])('returns null for invalid inputs (%s, %s)', (area, side) => {
        expect(targetBlockCount(area, side)).toBeNull();
    });
});
