// Conservative land-to-archive routing, made from every polygon in a verified ZIP.
// This stores occupied cells, never parcel IDs or recoverable parcel geometry.
export const HMLR_SCOPE_GRID_DEGREES = 0.0005;
export const HMLR_SCOPE_POLICY = 'hmlr-land-scope-v1-projected-edge-hull-250m';
const GRID = HMLR_SCOPE_GRID_DEGREES;
// Covers the ground engine's 1 mm coordinate snap and numerical boundary noise.
const EPSILON = 1e-7;
const cell = value => Math.floor(value / GRID);
const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

function convexHull(points) {
    const sorted = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const half = list => {
        const out = [];
        for (const point of list) { while (out.length > 1 && cross(out.at(-2), out.at(-1), point) <= 0) out.pop(); out.push(point); }
        return out;
    };
    const lower = half(sorted), upper = half(sorted.reverse());
    const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
    return hull.length > 2 ? [...hull, hull[0]] : null;
}

function addInterval(rows, y, start, end) {
    let row = rows.get(y);
    if (!row) { rows.set(y, [start, end]); return; }
    let low = 0, high = row.length / 2;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (row[middle * 2 + 1] < start - 1) low = middle + 1;
        else high = middle;
    }
    const first = low * 2;
    let after = first;
    while (after < row.length && row[after] <= end + 1) {
        start = Math.min(start, row[after]); end = Math.max(end, row[after + 1]); after += 2;
    }
    if (after === first + 2 && row[first] === start && row[first + 1] === end) return;
    row.splice(first, after - first, start, end);
}

export function createHmlrArchiveScopeBuilder(project = point => point) {
    const rows = new Map();
    let featureCount = 0;
    const projectPoint = point => {
        const projected = project(point);
        if (!Array.isArray(projected) || projected.length !== 2 || !projected.every(Number.isFinite)
            || projected[0] < -180 || projected[0] > 180 || projected[1] < -90 || projected[1] > 90) {
            throw new Error('Invalid projected HMLR scope coordinate.');
        }
        return projected;
    };
    function addGeometry(geometry) {
        if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) throw new Error('Invalid HMLR scope geometry.');
        const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
        const projectedPolygons = [];
        for (const polygon of polygons) {
            const rings = [];
            for (const ring of polygon) {
                const points = ring.map(projectPoint); rings.push(points);
                // Repair can add native vertices on long edges before projection.
                // Cover chords between any such points, as well as the original
                // projected endpoints, using the hull of 250 m edge samples.
                for (let i = 1; i < ring.length; i++) {
                    const a = ring[i - 1], b = ring[i];
                    const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 250);
                    if (steps <= 1) continue;
                    if (steps > 10000) throw new Error('HMLR scope edge exceeds the native coordinate range.');
                    const samples = [points[i - 1], points[i]];
                    for (let step = 1; step < steps; step++) {
                        const fraction = step / steps;
                        samples.push(projectPoint([a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction]));
                    }
                    const hull = convexHull(samples);
                    if (hull) projectedPolygons.push([hull]);
                }
            }
            projectedPolygons.push(rings);
        }
        for (const polygon of projectedPolygons) {
            // A cell either meets an edge, or is wholly inside/outside the polygon.
            // Scanline parity fills interiors and preserves holes; explicit edge
            // coverage also retains slivers, self-intersections and boundary touches.
            const crossings = new Map();
            for (const points of polygon) {
                for (let i = 1; i < points.length; i++) {
                    const [x0, y0] = points[i - 1], [x1, y1] = points[i];
                    const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
                    const first = cell(minY - EPSILON), last = cell(maxY + EPSILON);
                    for (let y = first; y <= last; y++) {
                        const bottom = y * GRID - EPSILON, top = (y + 1) * GRID + EPSILON;
                        const t0 = y0 === y1 ? 0 : Math.max(0, Math.min(1, (bottom - y0) / (y1 - y0)));
                        const t1 = y0 === y1 ? 1 : Math.max(0, Math.min(1, (top - y0) / (y1 - y0)));
                        const a = x0 + (x1 - x0) * t0, b = x0 + (x1 - x0) * t1;
                        addInterval(rows, y, cell(Math.min(a, b) - EPSILON), cell(Math.max(a, b) + EPSILON));
                        const centre = (y + 0.5) * GRID;
                        if ((y0 <= centre && y1 > centre) || (y1 <= centre && y0 > centre)) {
                            const list = crossings.get(y) || [];
                            list.push(x0 + (centre - y0) * (x1 - x0) / (y1 - y0)); crossings.set(y, list);
                        }
                    }
                }
            }
            for (const [y, xs] of crossings) {
                xs.sort((a, b) => a - b);
                if (xs.length % 2) throw new Error('Unclosed HMLR scope polygon.');
                for (let i = 0; i < xs.length; i += 2) addInterval(rows, y, cell(xs[i] - EPSILON), cell(xs[i + 1] + EPSILON));
            }
        }
        featureCount++;
    }
    function finish(archiveSha256) {
        if (!featureCount || !rows.size) throw new Error('Empty HMLR archive scope.');
        return { schemaVersion: 1, policy: HMLR_SCOPE_POLICY, gridDegrees: GRID, archiveSha256, featureCount,
            rows: [...rows].sort(([a], [b]) => a - b).map(([y, spans]) => [y, ...spans]) };
    }
    return Object.freeze({ addGeometry, finish });
}

export function validateHmlrArchiveScope(value, authority) {
    if (!value || value.schemaVersion !== 1 || value.policy !== HMLR_SCOPE_POLICY || value.gridDegrees !== GRID
        || value.archiveSha256 !== authority.archiveSha256 || value.featureCount !== authority.featureCount
        || !Array.isArray(value.rows) || !value.rows.length || value.rows.length > 360_002) {
        throw new Error('HMLR archive scope does not match its complete pinned archive.');
    }
    let previousY = -Infinity;
    for (const row of value.rows) {
        if (!Array.isArray(row) || row.length < 3 || row.length % 2 !== 1 || !row.every(Number.isSafeInteger)
            || row[0] <= previousY || row[0] < -180_001 || row[0] > 180_000) throw new Error('Invalid HMLR archive scope row.');
        previousY = row[0]; let previousEnd = -Infinity;
        for (let i = 1; i < row.length; i += 2) {
            if (row[i] <= previousEnd + 1 || row[i] > row[i + 1] || row[i] < -360_001 || row[i + 1] > 360_000) {
                throw new Error('Invalid HMLR archive scope span.');
            }
            const bounds = [row[i] * GRID, row[0] * GRID, (row[i + 1] + 1) * GRID, (row[0] + 1) * GRID];
            if (!overlaps(bounds, authority.bounds)) throw new Error('HMLR archive scope exceeds its authority extent.');
            previousEnd = row[i + 1];
        }
    }
    return value;
}

export function hmlrArchiveScopeIntersects(scope, bounds) {
    const minY = cell(bounds[1] - EPSILON), maxY = cell(bounds[3] + EPSILON);
    const minX = cell(bounds[0] - EPSILON), maxX = cell(bounds[2] + EPSILON);
    const rows = scope.rows;
    let low = 0, high = rows.length;
    while (low < high) { const mid = (low + high) >>> 1; if (rows[mid][0] < minY) low = mid + 1; else high = mid; }
    for (let i = low; i < rows.length && rows[i][0] <= maxY; i++) {
        const row = rows[i];
        for (let j = 1; j < row.length && row[j] <= maxX; j += 2) if (row[j + 1] >= minX) return true;
    }
    return false;
}
