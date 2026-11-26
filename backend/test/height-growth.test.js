// The 3D view's blocks growing to a height survey's measurements (frontend/js/buildings/height-growth.js):
// which height a block shows, the ripple's delay by distance, the easing to the end, and a growth
// that turns around midway.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const growth = createRequire(import.meta.url)('../../frontend/js/buildings/height-growth.js');

describe('height growth', () => {
    it('shows the survey height where it measured one and the source height otherwise', () => {
        expect(growth.targetHeight({ sourceM: 6, measuredM: 9.16, mode: 'survey' })).toBe(9.16);
        expect(growth.targetHeight({ sourceM: 6, measuredM: 9.16, mode: 'source' })).toBe(6);
        expect(growth.targetHeight({ sourceM: 6, measuredM: undefined, mode: 'survey' })).toBe(6);
    });

    it('starts a farther building later and eases each to its height', () => {
        const g = growth.create({ durationMs: 1000, speedMps: 500 });
        g.grow('near', 6, 9, 0, 0);
        g.grow('far', 6, 12, 500, 0);
        const early = g.step(500);
        expect(early.get('near')).toBeGreaterThan(8); // ease-out: most of the way at half time
        expect(early.get('far')).toBe(6); // its ripple reaches it at 1 s
        const end = g.step(2000);
        expect(end.get('near')).toBe(9);
        expect(end.get('far')).toBe(12);
        expect(g.active).toBe(false);
    });

    it('turns a moving building around from where it is', () => {
        const g = growth.create({ durationMs: 1000 });
        g.grow('house', 6, 9, 0, 0);
        const midway = g.heightOf('house', 500);
        g.grow('house', 6, 6, 0, 500);
        expect(g.heightOf('house', 500)).toBeCloseTo(midway, 6);
        expect(g.step(1500).get('house')).toBe(6);
    });
});
