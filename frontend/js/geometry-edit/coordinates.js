// Coordinate input and metre offsets shared by keyboard and pointer-independent geometry controls.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.GeometryEditCoordinates = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    function valid(point) {
        return Array.isArray(point) && point.length >= 2
            && Number.isFinite(point[0]) && Number.isFinite(point[1])
            && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90;
    }

    function parse(longitude, latitude) {
        const values = [longitude, latitude];
        if (values.some(value => value == null || String(value).trim() === '')) return null;
        const point = values.map(Number);
        return valid(point) ? point : null;
    }

    function nudge(point, direction, metres, turf) {
        const bearings = { north: 0, east: 90, south: 180, west: -90 };
        if (!valid(point) || !Object.hasOwn(bearings, direction)
            || !Number.isFinite(metres) || metres <= 0 || metres > 1000 || !turf) return null;
        const next = turf.destination(turf.point(point), metres, bearings[direction], { units: 'meters' }).geometry.coordinates;
        return valid(next) ? next : null;
    }

    function translate(value, from, to) {
        if (!Array.isArray(value) || !valid(from) || !valid(to)) return null;
        if (typeof value[0] === 'number') {
            const next = [value[0] + to[0] - from[0], value[1] + to[1] - from[1]];
            return valid(next) ? next : null;
        }
        const next = value.map(item => translate(item, from, to));
        return next.every(Boolean) ? next : null;
    }

    return { valid, parse, nudge, translate };
});
