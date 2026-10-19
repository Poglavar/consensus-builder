// Unit tests for the photoreal tile-layer frame math: the mapping from the tiles' reoriented
// ENU frame (east=−X, north=+Z, up=+Y) into three-mode's scene frame (east=+X, north=+Y,
// up=+Z, XY Mercator-inflated). The axis assertions ARE the contract — the isochrone sim
// shipped a world spun 180° because nothing pinned this down.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mercatorScaleFactor, TILES_FRAME_EULER, applyTilesFrame } =
    require('../../frontend/js/photoreal-frame.js');

describe('mercatorScaleFactor', () => {
    it('is 1 at the equator and ~1.434 at Zagreb', () => {
        expect(mercatorScaleFactor(0)).toBeCloseTo(1, 10);
        expect(mercatorScaleFactor(45.815)).toBeCloseTo(1 / Math.cos(45.815 * Math.PI / 180), 10);
        expect(mercatorScaleFactor(45.815)).toBeGreaterThan(1.43);
        expect(mercatorScaleFactor(45.815)).toBeLessThan(1.44);
    });

    it('never divides by ~zero at extreme latitudes', () => {
        expect(mercatorScaleFactor(89.999)).toBeLessThanOrEqual(10);
    });
});

describe('applyTilesFrame (tiles ENU → scene axes)', () => {
    it('maps tiles east (−X) to scene east (+X)', () => {
        expect(applyTilesFrame([-1, 0, 0])).toEqual([1, 0, 0]);
    });

    it('maps tiles north (+Z) to scene north (+Y)', () => {
        expect(applyTilesFrame([0, 0, 1])).toEqual([0, 1, 0]);
    });

    it('maps tiles up (+Y) to scene up (+Z)', () => {
        expect(applyTilesFrame([0, 1, 0])).toEqual([0, 0, 1]);
    });

    it('is a proper rotation (preserves handedness and length)', () => {
        const e = applyTilesFrame([-1, 0, 0]);
        const n = applyTilesFrame([0, 0, 1]);
        const u = applyTilesFrame([0, 1, 0]);
        // east × north = up (right-handed)
        const cross = [
            e[1] * n[2] - e[2] * n[1],
            e[2] * n[0] - e[0] * n[2],
            e[0] * n[1] - e[1] * n[0]
        ];
        expect(cross).toEqual(u);
    });
});

describe('TILES_FRAME_EULER matches applyTilesFrame', () => {
    // Compose Rz(z)·Ry(y)·Rx(x) (three's 'ZYX' order) with plain math and compare against
    // applyTilesFrame on a non-axis vector, so the euler handed to THREE cannot drift from
    // the tested rotation.
    function rotate(euler, v) {
        const [x, y, z] = v;
        // Rx
        let x1 = x, y1 = y * Math.cos(euler.x) - z * Math.sin(euler.x), z1 = y * Math.sin(euler.x) + z * Math.cos(euler.x);
        // Ry
        let x2 = x1 * Math.cos(euler.y) + z1 * Math.sin(euler.y), y2 = y1, z2 = -x1 * Math.sin(euler.y) + z1 * Math.cos(euler.y);
        // Rz
        return [
            x2 * Math.cos(euler.z) - y2 * Math.sin(euler.z),
            x2 * Math.sin(euler.z) + y2 * Math.cos(euler.z),
            z2
        ];
    }

    it('agrees on an arbitrary vector', () => {
        expect(TILES_FRAME_EULER.order).toBe('ZYX');
        const v = [0.3, -1.2, 2.5];
        const viaEuler = rotate(TILES_FRAME_EULER, v);
        const viaFn = applyTilesFrame(v);
        for (let i = 0; i < 3; i++) expect(viaEuler[i]).toBeCloseTo(viaFn[i], 12);
    });
});
