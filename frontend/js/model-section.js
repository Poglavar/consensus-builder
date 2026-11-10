// X-ray for uploaded building models: finds a model's storeys from its horizontal surfaces and
// chooses where a horizontal section cuts it, so the rooms of the chosen storey show from above as in
// a floor plan. Pure: horizontal faces (height above ground and plan area, metres) in, storeys and
// section heights out. No DOM, no THREE.
(function attachModelSection(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__modelSection = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createModelSection() {
    'use strict';

    // A slab's top and bottom faces (and anything else flat within this) are one floor (m).
    const MERGE_M = 0.6;
    // A floor holds at least this share of the fullest height bin, and this much area (m²): smaller
    // flat surfaces are furniture, stair landings, sills and column heads. The share is small
    // because the fullest bin is usually the ground storey, which often carries the site's paving.
    const MIN_FLOOR_SHARE = 0.03;
    const MIN_FLOOR_M2 = 25;
    // The section cuts this far above a storey's floor, the height of an architectural plan cut (m).
    const CUT_ABOVE_FLOOR_M = 1.2;

    const finite = value => typeof value === 'number' && Number.isFinite(value);

    // Horizontal area is summed in bins of this height (m) before floors are picked.
    const BIN_M = 0.1;

    /**
     * The model's storeys from its horizontal faces [{ z, areaM2 }] (z = height above ground). Areas
     * are summed per BIN_M; a bin is floor when it holds at least MIN_FLOOR_M2 and MIN_FLOOR_SHARE of
     * the fullest bin (stair treads, furniture and sills never do), and floor bins within MERGE_M (a
     * slab's top and bottom) are one floor at its top. The highest of them is the roof, not a storey.
     * Level 0 is the storey nearest the ground, lower ones are basements.
     * → [{ level, elevationM, areaM2 }] from the lowest up.
     */
    function storeysOf(faces) {
        const bins = new Map();
        for (const face of Array.isArray(faces) ? faces : []) {
            if (!face || !finite(face.z) || !finite(face.areaM2) || face.areaM2 <= 0) continue;
            const key = Math.round(face.z / BIN_M);
            bins.set(key, (bins.get(key) || 0) + face.areaM2);
        }
        const fullest = Math.max(0, ...bins.values());
        const floorBins = [...bins.entries()].filter(([, areaM2]) => areaM2 >= Math.max(MIN_FLOOR_M2, MIN_FLOOR_SHARE * fullest))
            .map(([key, areaM2]) => ({ z: key * BIN_M, areaM2 })).sort((a, b) => a.z - b.z);
        const floors = [];
        for (const bin of floorBins) {
            const floor = floors[floors.length - 1];
            if (floor && bin.z - floor.topM <= MERGE_M) { floor.topM = bin.z; floor.areaM2 = Math.max(floor.areaM2, bin.areaM2); }
            else floors.push({ topM: bin.z, areaM2: bin.areaM2 });
        }
        floors.pop();
        if (!floors.length) return [];
        const ground = floors.reduce((best, floor, index) => (Math.abs(floor.topM) < Math.abs(floors[best].topM) ? index : best), 0);
        return floors.map((floor, index) => ({ level: index - ground, elevationM: Math.round(floor.topM * 1000) / 1000, areaM2: Math.round(floor.areaM2) }));
    }

    /**
     * The height at which X-ray cuts the model: CUT_ABOVE_FLOOR_M above the chosen storey's floor.
     * With no level chosen it shows the ground storey (level 0): a model's storeys cannot all be open
     * at once, and a cut above the top one would leave the building closed. A level the model lacks
     * takes its nearest storey below, or the lowest. null for a model without storeys.
     */
    function sectionHeightM(storeys, level) {
        const list = Array.isArray(storeys) ? storeys : [];
        if (!list.length) return null;
        const chosen = level === null || level === undefined ? 0 : level;
        const below = list.filter(item => item.level <= chosen);
        const storey = below.length ? below[below.length - 1] : list[0];
        return storey.elevationM + CUT_ABOVE_FLOOR_M;
    }

    return { BIN_M, MERGE_M, MIN_FLOOR_SHARE, MIN_FLOOR_M2, CUT_ABOVE_FLOOR_M, storeysOf, sectionHeightM };
});
