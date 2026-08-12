// The tiling every city-wide lane-topology sweep uses.
//
// One definition, because two of them disagreed: stepping by a fixed span and clamping the last
// tile puts a different set of junctions in each core than dividing the range into equal columns,
// and the two scripts reported 1,917 and 1,956 unresolved junctions for the same city because of it.
//
// Cores tile the target exactly and never overlap, so a junction belongs to exactly one — the core
// holding its centre. Build boxes are cores grown by the overlap, so a junction on a core boundary
// is still derived with all of its arms present.
export const TILE_SPAN_DEG = 0.012;
export const TILE_OVERLAP_DEG = 0.0015;
// The lane-topology API's own ceiling on a bbox; a build box must stay under it.
export const MAX_BBOX_SPAN_DEG = 0.08;

export function enumerationTiles(bbox, options = {}) {
    const spanDeg = Number(options.spanDeg) || TILE_SPAN_DEG;
    const overlapDeg = Number.isFinite(Number(options.overlapDeg))
        ? Number(options.overlapDeg)
        : TILE_OVERLAP_DEG;
    const [west, south, east, north] = bbox;
    const columns = Math.max(1, Math.ceil((east - west) / spanDeg));
    const rows = Math.max(1, Math.ceil((north - south) / spanDeg));
    const spanX = (east - west) / columns;
    const spanY = (north - south) / rows;
    const tiles = [];
    for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
            const core = [
                west + column * spanX,
                south + row * spanY,
                west + (column + 1) * spanX,
                south + (row + 1) * spanY
            ];
            const build = [
                core[0] - overlapDeg,
                core[1] - overlapDeg,
                core[2] + overlapDeg,
                core[3] + overlapDeg
            ];
            if (build[2] - build[0] > MAX_BBOX_SPAN_DEG || build[3] - build[1] > MAX_BBOX_SPAN_DEG) {
                throw new Error('Enumeration tile exceeds the API bbox ceiling; lower the tile span.');
            }
            tiles.push({ core, build, row, column });
        }
    }
    return tiles;
}

// Half-open on the upper edges, so adjacent cores cannot both claim a point on their shared border.
export function insideCore(point, core) {
    if (!Array.isArray(point)) return false;
    const [lng, lat] = point.map(Number);
    return lng >= core[0] && lng < core[2] && lat >= core[1] && lat < core[3];
}
