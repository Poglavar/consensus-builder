// Unit tests for frontend/js/model-edit-handles-math.js: the ray, plane and turn geometry behind the
// model view's editor drag handles, and the slider value a dragged height becomes.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    screenHeightDelta, rayPointAtHeight, turnDegrees, snapDegrees, sliderHeight, sliderValueForHeight
} = require('../../frontend/js/model-edit-handles-math.js');

const ray = (origin, direction) => ({ origin: { x: origin[0], y: origin[1], z: origin[2] }, direction: { x: direction[0], y: direction[1], z: direction[2] } });

describe('screenHeightDelta', () => {
    it('follows the pointer along the axis as drawn on screen', () => {
        // One metre up is 10 px up the screen: 50 px up is 5 m, and sideways movement does not count.
        expect(screenHeightDelta({ x: 0, y: -50 }, { x: 0, y: -10 }, 2)).toBeCloseTo(5, 9);
        expect(screenHeightDelta({ x: 30, y: -50 }, { x: 0, y: -10 }, 2)).toBeCloseTo(5, 9);
        expect(screenHeightDelta({ x: 0, y: 20 }, { x: 0, y: -10 }, 2)).toBeCloseTo(-2, 9);
        // A leaning axis on screen: movement along it counts in full.
        expect(screenHeightDelta({ x: 30, y: -40 }, { x: 6, y: -8 }, 2)).toBeCloseTo(5, 9);
    });

    it('caps the gain when the camera looks down the axis', () => {
        // One metre up is 0.5 px: without the floor 50 px would be 100 m; at 4 px per metre it is 12.5 m.
        expect(screenHeightDelta({ x: 0, y: -50 }, { x: 0, y: -0.5 }, 4)).toBeCloseTo(12.5, 9);
        expect(screenHeightDelta({ x: 0, y: -50 }, { x: 0, y: 0 }, 4)).toBeCloseTo(12.5, 9);
    });

    it('has no answer without a usable scale', () => {
        expect(screenHeightDelta({ x: 0, y: -50 }, { x: 0, y: -10 }, 0)).toBeNull();
        expect(screenHeightDelta({ x: 0, y: null }, { x: 0, y: -10 }, 2)).toBeNull();
    });
});

describe('rayPointAtHeight', () => {
    it('crosses a horizontal plane in front of the camera', () => {
        expect(rayPointAtHeight(ray([0, 0, 100], [1, 2, -1]), 20)).toEqual({ x: 80, y: 160 });
    });

    it('has no answer for a parallel ray or a plane behind the camera', () => {
        expect(rayPointAtHeight(ray([0, 0, 100], [1, 0, 0]), 20)).toBeNull();
        expect(rayPointAtHeight(ray([0, 0, 100], [0, 1, 1]), 20)).toBeNull();
    });
});

describe('turnDegrees', () => {
    const centre = { x: 10, y: 10 };
    it('measures counter-clockwise turns as positive and wraps across ±180°', () => {
        expect(turnDegrees(centre, { x: 20, y: 10 }, { x: 10, y: 20 })).toBeCloseTo(90, 9);
        expect(turnDegrees(centre, { x: 10, y: 20 }, { x: 20, y: 10 })).toBeCloseTo(-90, 9);
        // Just past west going anticlockwise is a small positive turn, not -350°.
        expect(turnDegrees(centre, { x: 0, y: 10.01 }, { x: 0, y: 9.99 })).toBeGreaterThan(0);
        expect(turnDegrees(centre, { x: 0, y: 10.01 }, { x: 0, y: 9.99 })).toBeLessThan(1);
    });

    it('has no direction at the centre itself', () => {
        expect(turnDegrees(centre, centre, { x: 20, y: 10 })).toBeNull();
    });
});

describe('snapDegrees', () => {
    it('snaps to the step and never returns -0', () => {
        expect(snapDegrees(7.4, 5)).toBe(5);
        expect(snapDegrees(-7.6, 5)).toBe(-10);
        expect(Object.is(snapDegrees(-1, 5), 0)).toBe(true);
        expect(snapDegrees(3.3, 0)).toBe(3.3);
    });
});

describe('slider heights', () => {
    it('reads a storey slider as metres from its storey height and base', () => {
        expect(sliderHeight(4, { metresPerStep: 3 })).toBe(12);
        expect(sliderHeight(2, { metresPerStep: 3, baseM: 10 })).toBe(16);
        expect(sliderHeight(Number.NaN)).toBeNull();
    });

    it('turns a dragged height into the nearest value on the slider grid, within its range', () => {
        const storeys = { min: 1, max: 20, step: 1, metresPerStep: 3 };
        expect(sliderValueForHeight(13.4, storeys)).toBe(4);
        expect(sliderValueForHeight(14, storeys)).toBe(5);
        expect(sliderValueForHeight(-5, storeys)).toBe(1);
        expect(sliderValueForHeight(500, storeys)).toBe(20);
        expect(sliderValueForHeight(12.26, { min: 2.5, max: 5, step: 0.1, metresPerStep: 1 })).toBe(5);
        expect(sliderValueForHeight(3.14, { min: 2.5, max: 5, step: 0.1, metresPerStep: 1 })).toBe(3.1);
        expect(sliderValueForHeight(16.5, { ...storeys, baseM: 10 })).toBe(2);
    });

    it('refuses a height it cannot place on the slider', () => {
        expect(sliderValueForHeight(null, { min: 1, max: 20 })).toBeNull();
        expect(sliderValueForHeight(10, { min: 1, max: 20, metresPerStep: 0 })).toBeNull();
    });
});
