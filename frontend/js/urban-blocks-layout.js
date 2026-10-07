// Pure map framing for the block inspector. Reserve the actual panel and map controls before
// asking Leaflet to fit a polygon, including when the phone sheet is collapsed or resized.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.UrbanBlocksLayout = api;
})(typeof self !== 'undefined' ? self : null, function () {
    'use strict';
    function fitPadding(mapRect, obstacles, gap = 16) {
        const free = { left: mapRect.left + gap, top: mapRect.top + gap,
            right: mapRect.right - gap, bottom: mapRect.bottom - gap };
        for (const { edge, rect } of obstacles) {
            if (!rect || rect.right <= mapRect.left || rect.left >= mapRect.right
                || rect.bottom <= mapRect.top || rect.top >= mapRect.bottom) continue;
            if (edge === 'left') free.left = Math.max(free.left, rect.right + gap);
            if (edge === 'right') free.right = Math.min(free.right, rect.left - gap);
            if (edge === 'top') free.top = Math.max(free.top, rect.bottom + gap);
            if (edge === 'bottom') free.bottom = Math.min(free.bottom, rect.top - gap);
        }
        if (free.right - free.left < 40 || free.bottom - free.top < 40) return null;
        return { paddingTopLeft: [free.left - mapRect.left, free.top - mapRect.top],
            paddingBottomRight: [mapRect.right - free.right, mapRect.bottom - free.bottom] };
    }
    return { fitPadding };
});
