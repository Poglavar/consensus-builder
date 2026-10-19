// Step 2b geometry: recover a plan's placement in its storey outline; priors help, never gate.
import { describe, expect, it } from 'vitest';
import { boundaryCoincidence, dominantAngle, fitPlan, intersectionArea, ringArea, sampledIntersectionArea, toLngLat, toLocalMetres, transformRing } from '../floor-plans/plan-placement.js';

// An L-shaped storey, 30 x 20 m with a 10 x 8 m notch, rotated 23 degrees and offset.
const L = [[0, 0], [30, 0], [30, 12], [20, 12], [20, 20], [0, 20]];
const truth = { scale: 1, rotationDeg: 23, tx: 105, ty: -40 };
const storey = transformRing(L, truth);

describe('helpers', () => {
    it('measures area, dominant direction and boundary agreement', () => {
        expect(ringArea(L)).toBe(30 * 12 + 20 * 8);
        expect(dominantAngle(storey)).toBeCloseTo(23, 0);
        expect(boundaryCoincidence(storey, storey)).toBeCloseTo(1, 5);
        const back = toLocalMetres(toLngLat([[10, 20]], [15.98, 45.81]), [15.98, 45.81])[0];
        expect(back[0]).toBeCloseTo(10, 6);
        expect(back[1]).toBeCloseTo(20, 6);
    });

    it('the sampled overlap agrees with exact clipping', () => {
        const a = [[0, 0], [10, 0], [10, 10], [0, 10]], b = [[5, 5], [15, 5], [15, 15], [5, 15]];
        expect(intersectionArea(a, b)).toBeCloseTo(25, 6);
        expect(sampledIntersectionArea(a, b)).toBeCloseTo(25, 0);
    });
});

describe('full-floor fit', () => {
    it('recovers rotation and position of a plan drawn at 50 px per metre with no printed scale', () => {
        const plan = L.map(([x, y]) => [x * 50, y * 50]);
        const fit = fitPlan({ plan, target: storey, scope: 'floor' });
        expect(fit.status).toBe('placed');
        const [best] = fit.placements;
        expect(best.scale).toBeCloseTo(1 / 50, 3);
        expect(best.rotationDeg).toBeCloseTo(23, 0);
        expect(best.iou).toBeGreaterThan(0.95);
    });

    it('calls a symmetric rectangle ambiguous unless a north arrow breaks the tie', () => {
        const rect = [[0, 0], [24, 0], [24, 10], [0, 10]];
        const target = transformRing(rect, { scale: 1, rotationDeg: 10, tx: 0, ty: 0 });
        expect(fitPlan({ plan: rect, target, scope: 'floor', scalePrior: { mPerUnit: 1 } }).status).toBe('ambiguous');
        const north = fitPlan({ plan: rect, target, scope: 'floor', scalePrior: { mPerUnit: 1 }, rotationPrior: { deg: 10 } });
        expect(north.status).toBe('placed');
        expect(north.placements[0].rotationDeg).toBeCloseTo(10, 0);
    });

    it('a wrong printed north only costs score, it does not block the right fit', () => {
        const plan = L.map(([x, y]) => [x * 50, y * 50]);
        const fit = fitPlan({ plan, target: storey, scope: 'floor', rotationPrior: { deg: 113 } });
        expect(fit.placements[0].rotationDeg).toBeCloseTo(23, 0);
    });
});

describe('unit fit', () => {
    it('places a corner unit against the facade when its scale is known', () => {
        const unit = [[0, 0], [10, 0], [10, 8], [0, 8]].map(([x, y]) => [x * 40, y * 40]);
        const fit = fitPlan({ plan: unit, target: storey, scope: 'unit', scalePrior: { mPerUnit: 1 / 40 } });
        expect(['placed', 'ambiguous']).toContain(fit.status);
        expect(fit.placements[0].containment).toBeGreaterThan(0.99);
        expect(fit.placements[0].coincidence).toBeGreaterThan(0.4);
    });

    it('keeps the plan at its own scale when shrinking it would only make it fit more easily', () => {
        const unit = [[0, 0], [10, 0], [10, 8], [0, 8]];
        const fit = fitPlan({ plan: unit, target: storey, scope: 'unit', scalePrior: { mPerUnit: 1 } });
        expect(fit.placements[0].scale).toBe(1);
    });

    it('tolerates a balcony projecting beyond the footprint, but not a unit standing outside it', async () => {
        const { growRing } = await import('../floor-plans/plan-placement.js');
        const grown = growRing([[0, 0], [10, 0], [10, 10], [0, 10]], 1.8);
        expect(ringArea(grown)).toBeGreaterThan(13 * 13 - 4);
        expect(ringArea(grown)).toBeLessThan(13.6 * 13.6);
        const slab = [[0, 0], [40, 0], [40, 12], [0, 12]];
        const withBalcony = [[0, 0], [10, 0], [10, 10], [6, 10], [6, 11.5], [2, 11.5], [2, 10], [0, 10]];
        const fit = fitPlan({ plan: withBalcony, target: slab, scope: 'unit', scalePrior: { mPerUnit: 1 } });
        expect(fit.placements[0].containment).toBeGreaterThan(0.99);
    });

    it('corrects an estimated scale that is 20% off when the prior is loose', () => {
        const plan = L.map(([x, y]) => [x * 1.2, y * 1.2]);
        const fit = fitPlan({ plan, target: storey, scope: 'unit', scalePrior: { mPerUnit: 1, tolerance: 0.24, weight: 0.3 } });
        expect(fit.placements[0].scale).toBeCloseTo(1 / 1.2, 1);
        expect(fit.placements[0].containment).toBeGreaterThan(0.95);
    });

    it('treats an unscaled drawing that matches the whole storey as a full floor', () => {
        const fit = fitPlan({ plan: L.map(([x, y]) => [x * 37, y * 37]), target: storey, scope: 'unit' });
        expect(fit).toMatchObject({ status: 'placed', scope: 'floor-inferred' });
        expect(fit.placements[0].scale).toBeCloseTo(1 / 37, 3);
    });

    it('leaves a unit without any scale unplaced instead of guessing', () => {
        // A long strip is no drawing of this L-shaped storey, so it cannot borrow the storey's scale.
        expect(fitPlan({ plan: [[0, 0], [6, 0], [6, 1], [0, 1]], target: storey, scope: 'unit' })).toMatchObject({ status: 'unplaced', reason: 'unit-without-scale' });
    });
});

describe('key-plan position prior', () => {
    it('breaks the tie between the two ends of a symmetric slab', async () => {
        const { positionAgreement } = await import('../floor-plans/plan-placement.js');
        const slab = [[0, 0], [100, 0], [100, 20], [0, 20]];
        const unit = [[0, 0], [10, 0], [10, 10], [0, 10]];
        const open = fitPlan({ plan: unit, target: slab, scope: 'unit', scalePrior: { mPerUnit: 1 } });
        expect(open.status).toBe('ambiguous');
        // The inset shows the unit at the bottom-left (south-west) of the floor, drawn north-up.
        const keyed = fitPlan({ plan: unit, target: slab, scope: 'unit', scalePrior: { mPerUnit: 1 }, rotationPrior: { deg: 0 },
            positionPrior: { center: [0.05, 0.75], weight: 0.2 } });
        const [best] = keyed.placements;
        const centre = transformRing(unit, best).reduce((s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4], [0, 0]);
        expect(centre[0]).toBeLessThan(15);
        expect(centre[1]).toBeLessThan(10);
        expect(positionAgreement(transformRing(unit, best), slab, best.rotationDeg, [0.05, 0.75])).toBeLessThan(0.1);
        expect(keyed.status).toBe('placed');
    });

    it('places a mid-facade unit where its key plan shows it, against the facade', () => {
        const slab = [[0, 0], [100, 0], [100, 20], [0, 20]];
        const unit = [[0, 0], [10, 0], [10, 10], [0, 10]];
        const fit = fitPlan({ plan: unit, target: slab, scope: 'unit', scalePrior: { mPerUnit: 1 }, rotationPrior: { deg: 0 },
            positionPrior: { center: [0.45, 0.75], weight: 0.2 } });
        const [best] = fit.placements;
        const placed = transformRing(unit, best), xs = placed.map(p => p[0]), ys = placed.map(p => p[1]);
        expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeGreaterThan(38);
        expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeLessThan(52);
        expect(Math.min(...ys)).toBeCloseTo(0, 1);
        expect(best.coincidence).toBeGreaterThan(0.2);
    });
});
