// CPU-only glTF bounding-box validation and conversion to building dimensions in metres.
(function (global) {
    'use strict';

    function dimensionsFromBounds({ min, max }) {
        if (![min.x, min.y, min.z, max.x, max.y, max.z].every(Number.isFinite)) return null;
        const sizes = [max.x - min.x, max.z - min.z, max.y - min.y];
        if (sizes.some(size => !Number.isFinite(size) || size < 0)) return null;
        const [width, length, height] = sizes.map(size => Math.max(1, +size.toFixed(1)));
        return { width, length, height };
    }

    const api = { dimensionsFromBounds };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (global) global.BuildingModelGeometry = api;
})(typeof window !== 'undefined' ? window : null);
