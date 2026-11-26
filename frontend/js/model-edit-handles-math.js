// Pure geometry for the model view's editor drag handles (model-edit-handles.js): how far a pointer
// moved up a building's axis on screen, where a pointer ray meets a horizontal plane, how far it
// turned about a centre, and which value a height slider takes for a dragged height. Scene units: x/y as the 3D view lays them out,
// z in metres.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ModelEditHandlesMath = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const EPSILON = 1e-9;

    // Metres a pointer moved up a vertical axis on screen: its displacement in pixels along the axis's
    // screen direction, over the axis's pixels per metre (`axisPerMetre`, the screen vector of one
    // metre up). An axis foreshortened below `minPxPerMetre` (a camera looking down it) counts as that
    // many pixels per metre, straight up the screen, so the height stays controllable from above.
    function screenHeightDelta(delta, axisPerMetre, minPxPerMetre) {
        if (![delta?.x, delta?.y, axisPerMetre?.x, axisPerMetre?.y, minPxPerMetre].every(finite) || minPxPerMetre <= 0) return null;
        const length = Math.hypot(axisPerMetre.x, axisPerMetre.y);
        if (length >= minPxPerMetre) return (delta.x * axisPerMetre.x + delta.y * axisPerMetre.y) / (length * length);
        return -delta.y / minPxPerMetre; // screen y grows downwards
    }

    // Where the ray crosses the horizontal plane at height z, or null when it runs parallel to the
    // plane or crosses it behind the camera.
    function rayPointAtHeight(ray, z) {
        const { origin, direction } = ray || {};
        if (![origin?.x, origin?.y, origin?.z, direction?.x, direction?.y, direction?.z, z].every(finite)) return null;
        if (Math.abs(direction.z) < EPSILON) return null;
        const along = (z - origin.z) / direction.z;
        if (along < 0) return null;
        return { x: origin.x + along * direction.x, y: origin.y + along * direction.y };
    }

    // The counter-clockwise turn, in degrees within (-180, 180], from `from` to `to` about `centre`;
    // null when either point sits on the centre, where the direction is undefined.
    function turnDegrees(centre, from, to) {
        if (![centre?.x, centre?.y, from?.x, from?.y, to?.x, to?.y].every(finite)) return null;
        const fx = from.x - centre.x, fy = from.y - centre.y, tx = to.x - centre.x, ty = to.y - centre.y;
        if (Math.hypot(fx, fy) < EPSILON || Math.hypot(tx, ty) < EPSILON) return null;
        let degrees = (Math.atan2(ty, tx) - Math.atan2(fy, fx)) * 180 / Math.PI;
        while (degrees <= -180) degrees += 360;
        while (degrees > 180) degrees -= 360;
        return degrees;
    }

    function snapDegrees(degrees, step) {
        if (!finite(degrees)) return null;
        if (!finite(step) || step <= 0) return degrees;
        // -0 and 0 are the same turn; callers compare the result with ===.
        return Math.round(degrees / step) * step + 0;
    }

    function decimalsOf(step) {
        const text = String(step);
        return text.includes('.') ? text.length - text.indexOf('.') - 1 : 0;
    }

    // The height in metres a slider value stands for: `baseM` plus `metresPerStep` for each unit of
    // value (1 for a slider in metres, the storey height for a slider in storeys).
    function sliderHeight(value, { metresPerStep = 1, baseM = 0 } = {}) {
        if (![value, metresPerStep, baseM].every(finite)) return null;
        return baseM + value * metresPerStep;
    }

    // The slider value nearest to a dragged height: on the slider's own step grid, within its range.
    function sliderValueForHeight(metres, { min, max, step = 1, metresPerStep = 1, baseM = 0 } = {}) {
        if (![metres, min, max, step, metresPerStep, baseM].every(finite) || metresPerStep <= 0 || step <= 0 || max < min) return null;
        const raw = (metres - baseM) / metresPerStep;
        const snapped = min + Math.round((raw - min) / step) * step;
        const clamped = Math.min(max, Math.max(min, snapped));
        return Number(clamped.toFixed(decimalsOf(step)));
    }

    return { screenHeightDelta, rayPointAtHeight, turnDegrees, snapDegrees, sliderHeight, sliderValueForHeight };
});
