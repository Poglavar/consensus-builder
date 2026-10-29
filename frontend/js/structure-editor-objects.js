// Pure object positions and moves for the park and square map editors.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.StructureEditorObjects = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const tools = { trees: 'tree', benches: 'bench', flowerbeds: 'flowerbed', ponds: 'pond', paths: 'path', fountains: 'fountain', stalls: 'stall', statues: 'statue', lamps: 'lamp', swings: 'swing', seesaws: 'seesaw', slides: 'slide' };
    const records = new Set(['trees', 'benches', 'stalls', 'lamps', 'swings', 'seesaws', 'slides']);
    const shapes = new Set(['paths', 'flowerbeds', 'ponds']);

    function position(type, item, turf) {
        if (records.has(type)) return item.coordinate.slice();
        if (!shapes.has(type)) return item.slice();
        const feature = type === 'paths' ? turf.lineString(item) : turf.polygon([item]);
        return turf.centroid(feature).geometry.coordinates;
    }

    function entries(decorations, turf) {
        return Object.entries(tools).flatMap(([type, tool]) => (decorations?.[type] || []).map((item, index) => ({
            key: `${type}:${index}`, type, tool, index, coordinate: position(type, item, turf)
        })));
    }

    function fits(type, item, boundary, turf) {
        try {
            if (!shapes.has(type)) return turf.booleanPointInPolygon(turf.point(records.has(type) ? item.coordinate : item), boundary);
            const feature = type === 'paths' ? turf.lineString(item) : turf.polygon([item]);
            return turf.booleanWithin(feature, boundary) || (type !== 'paths' && turf.booleanEqual(feature, boundary));
        } catch (_) { return false; }
    }

    function move(type, item, to, boundary, turf, coordinates) {
        if (!Object.hasOwn(tools, type) || !coordinates.valid(to)) return null;
        let next;
        if (records.has(type)) next = { ...item, coordinate: to.slice() };
        else if (shapes.has(type)) next = coordinates.translate(item, position(type, item, turf), to);
        else next = to.slice();
        return next && fits(type, next, boundary, turf) ? next : null;
    }

    return { entries, fits, move, position, tools };
});
