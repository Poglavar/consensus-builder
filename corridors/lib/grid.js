// Metric raster grid over the study area (EPSG:3765), aligned to multiples of
// CELL_M so cell indices match PostGIS ST_SquareGrid(CELL_M, ...) i/j indices.
import { BBOX_WGS84, CELL_M } from './config.js';
import { toHTRS } from './proj.js';

export function makeGrid() {
    // Transform all four corners: the WGS84 bbox is not axis-aligned in 3765.
    const corners = [
        toHTRS([BBOX_WGS84.west, BBOX_WGS84.south]),
        toHTRS([BBOX_WGS84.east, BBOX_WGS84.south]),
        toHTRS([BBOX_WGS84.west, BBOX_WGS84.north]),
        toHTRS([BBOX_WGS84.east, BBOX_WGS84.north]),
    ];
    const xmin = Math.floor(Math.min(...corners.map(c => c[0])) / CELL_M) * CELL_M;
    const ymin = Math.floor(Math.min(...corners.map(c => c[1])) / CELL_M) * CELL_M;
    const xmax = Math.ceil(Math.max(...corners.map(c => c[0])) / CELL_M) * CELL_M;
    const ymax = Math.ceil(Math.max(...corners.map(c => c[1])) / CELL_M) * CELL_M;
    const cols = Math.round((xmax - xmin) / CELL_M);
    const rows = Math.round((ymax - ymin) / CELL_M);
    return {
        xmin, ymin, xmax, ymax, cols, rows, cell: CELL_M,
        size: cols * rows,
        i0: Math.round(xmin / CELL_M), // ST_SquareGrid i of our column 0
        j0: Math.round(ymin / CELL_M),
        idx(col, row) { return row * cols + col; },
        colOf(x) { return Math.floor((x - xmin) / CELL_M); },
        rowOf(y) { return Math.floor((y - ymin) / CELL_M); },
        centerOf(idx) {
            const row = Math.floor(idx / cols), col = idx % cols;
            return [xmin + (col + 0.5) * CELL_M, ymin + (row + 0.5) * CELL_M];
        },
        inBounds(col, row) { return col >= 0 && col < cols && row >= 0 && row < rows; },
        idxOfPoint([x, y]) {
            const col = Math.floor((x - xmin) / CELL_M), row = Math.floor((y - ymin) / CELL_M);
            return (col >= 0 && col < cols && row >= 0 && row < rows) ? row * cols + col : -1;
        },
    };
}
