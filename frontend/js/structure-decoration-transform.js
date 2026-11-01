// Shared authored-decoration translation used by the map editor and typed design edits.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.StructureDecorationTransform = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const POINT_RECORD_TYPES = ['benches', 'trees', 'lamps', 'stalls', 'swings', 'seesaws', 'slides'];

    function moveDecorations(value, from, to, { moveCoordinates, moveEnclosure } = {}) {
        if (!value || typeof value !== 'object') return value;
        if (typeof moveCoordinates !== 'function') throw new Error('Structure decoration translation needs coordinate movement.');
        const moved = structuredClone(value);
        for (const [key, coordinates] of Object.entries(value)) {
            if (!POINT_RECORD_TYPES.includes(key) && key !== 'enclosures' && Array.isArray(coordinates)) {
                moved[key] = moveCoordinates(coordinates, from, to);
            }
        }
        if (Array.isArray(value.enclosures)) {
            if (typeof moveEnclosure !== 'function') throw new Error('Structure decoration translation needs enclosure movement.');
            moved.enclosures = value.enclosures.map(entry => moveEnclosure(entry, item => moveCoordinates(item, from, to)));
        }
        for (const key of POINT_RECORD_TYPES) {
            if (!Array.isArray(value[key])) continue;
            moved[key] = value[key].map(record => ({
                ...record,
                coordinate: moveCoordinates(record.coordinate, from, to)
            }));
        }
        return moved;
    }

    return Object.freeze({ moveDecorations });
});
