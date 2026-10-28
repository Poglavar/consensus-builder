// The 2D shallow-water overlay must become a separate solid in the recessed 3D basin.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeLakeBasin = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    function partitionLakeBasin(geometry, graphics, clip) {
        // Without derived zones, draw open water rather than a solid shore covering it.
        if (!graphics?.water) return { shore: null, transition: null, water: geometry };
        const transition = graphics.transition || null;
        let shore = graphics.shore || geometry;
        if (transition) {
            const feature = value => ({ type: 'Feature', properties: {}, geometry: value });
            shore = clip('difference', feature(shore), feature(transition))?.geometry || null;
        }
        return { shore, transition, water: graphics.water };
    }

    return { partitionLakeBasin };
});
