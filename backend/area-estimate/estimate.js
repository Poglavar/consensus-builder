// Area estimate: what a rule set (a building eligibility set such as Living Tradition mansards, or a street code such
// as Strong Suburbs) would add if it were taken up across an area, judged building by building with the same rule
// evaluator, the same building facts and the same floor-area arithmetic the app uses for one plan. Pure: the
// command-line script (scripts/area-estimate.mjs) reads the sources and calls these.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Eligibility = require('../../frontend/js/planning/eligibility.js');
const PlanYield = require('../../frontend/js/proposals/plan-yield.js');

const finite = value => typeof value === 'number' && Number.isFinite(value);

// The cells of a box, `size` degrees each, as [w, s, e, n], row by row (a stable order for checkpoints).
export function cellsOf([w, s, e, n], size) {
    const cells = [];
    for (let y = Math.floor(s / size); y * size < n; y++) for (let x = Math.floor(w / size); x * size < e; x++) {
        cells.push({ key: `${x}_${y}`, bbox: [x * size, y * size, (x + 1) * size, (y + 1) * size] });
    }
    return cells;
}

const ringsOf = geometry => geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
function inRing([x, y], ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}
export const inGeometry = (point, geometry) => ringsOf(geometry).some(polygon => inRing(point, polygon[0]) && !polygon.slice(1).some(hole => inRing(point, hole)));

// A footprint's centre: the mean of its outer ring's vertices (a house is small and near convex).
export function centreOf(geometry) {
    const ring = ringsOf(geometry)[0]?.[0];
    if (!ring?.length) return null;
    const pts = ring.slice(0, -1);
    return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
}

// The fact-contract id of an OSM building feature from the app's buildings read ('w123' → 'osm:way/123').
export function factIdOf(feature) {
    const match = /^w(\d+)$/.exec(String(feature?.properties?.osm_id ?? feature?.id ?? ''));
    return match ? `osm:way/${match[1]}` : null;
}

// The building redrawn as the app's Based on existing buildings does: its own footprint, `walls` storeys of
// `floorHeightM`, with the existing height it has (null when the facts give none) and a mansard roof if asked.
export function extendedFeature(feature, { walls, floorHeightM = 3.5, existingHeightM = null, roof = 'mansard' }) {
    return { type: 'Feature', geometry: feature.geometry,
        properties: { type: 'proposedBuilding', basedOnExisting: true, sourceBuildingId: `osm:${feature.properties?.osm_id ?? feature.id}`,
            existingHeight: existingHeightM, height: walls * floorHeightM, floors: walls, floorHeightM, roof } };
}

// The existing height a building's facts give, in metres: its height, else its storeys at the storey height.
export function existingHeightOf(contract, floorHeightM = 3.5) {
    const facts = contract?.facts || {};
    if (finite(facts.height_m?.value) && facts.height_m.value > 0) return facts.height_m.value;
    if (finite(facts.storeys?.value) && facts.storeys.value > 0) return facts.storeys.value * floorHeightM;
    return null;
}

// What one mansard adds on an existing building: the mansard storey's floor area (from the footprint and the
// party walls with `siblings`, as Plan stats measures it); null when the roof cannot be fitted.
export function mansardAddedM2(feature, siblings) {
    const redrawn = extendedFeature(feature, { walls: 1 });
    const others = siblings.filter(other => other !== feature).map(other => ({ type: 'Feature', geometry: other.geometry, properties: {} }));
    const measured = PlanYield.measureBuilding(redrawn, null, {}, [redrawn, ...others]);
    return finite(measured.mansardFloorAreaM2) ? measured.mansardFloorAreaM2 : null;
}

// Net homes in an added floor area at Plan stats' assumptions (efficiency and average flat), all housing.
export function homesIn(floorAreaM2, assumptions = {}) {
    const opts = { ...PlanYield.DEFAULTS, ...assumptions };
    return finite(floorAreaM2) ? Math.floor(floorAreaM2 * opts.efficiency / opts.avgApartmentM2) : null;
}

// One building judged by a building eligibility set (Living Tradition): its verdict, the tests that fail or are
// unknown, and the floor area its mansard adds when it is eligible or could be (no test fails).
export function judgeEligibility(set, contract, feature, siblings) {
    const result = Eligibility.evaluate(set, contract?.facts || {});
    const failing = result.tests.filter(t => t.status === 'fail').map(t => t.id);
    const unknown = result.tests.filter(t => t.status === 'unknown').map(t => t.id);
    const addedM2 = result.verdict === 'ineligible' ? 0 : mansardAddedM2(feature, siblings);
    return { verdict: result.verdict, failing, unknown, addedM2 };
}

// Point-to-segment distance in metres on a local plane.
function metresTo([lng0, lat0]) {
    const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
    return ([lng, lat]) => [(lng - lng0) * kx, (lat - lat0) * ky];
}
function pointSegment([px, py], [ax, ay], [bx, by]) {
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
// The named street each building fronts: the nearest named street line within `maxM` of its footprint's
// centre. streets: [{ name, lines: [[lng, lat]...] }]. Returns Map name → [feature]; buildings fronting none
// are under ''.
// The plots in a box ({ bbox } → [{ id, geometry }]), for the street code's light planes, read a cell at a time
// with readCell(cellBbox) and the last `keep` cells kept: a parcel source answers a cell in tens of seconds, and
// streets taken in cell order ask for the same few cells again and again.
export function plotReader(readCell, { size = 0.01, keep = 12 } = {}) {
    const cells = new Map();
    const boxOfGeometry = geometry => {
        const pts = ringsOf(geometry).flat(2);
        return [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))];
    };
    async function cell({ key, bbox }) {
        if (cells.has(key)) { const rows = cells.get(key); cells.delete(key); cells.set(key, rows); return rows; }
        const rows = (await readCell(bbox)).map(row => ({ ...row, box: boxOfGeometry(row.geometry) }));
        cells.set(key, rows);
        if (cells.size > keep) cells.delete(cells.keys().next().value);
        return rows;
    }
    return async query => {
        if (!query?.bbox) throw new Error('The area estimate reads plots by box only.');
        const [w, s, e, n] = query.bbox, found = new Map();
        for (const c of cellsOf(query.bbox, size)) {
            for (const row of await cell(c)) if (row.box[0] <= e && row.box[2] >= w && row.box[1] <= n && row.box[3] >= s) found.set(row.id, { id: row.id, geometry: row.geometry });
        }
        return [...found.values()];
    };
}

export function streetsOf(features, streets, maxM = 40) {
    const out = new Map();
    for (const feature of features) {
        const centre = centreOf(feature.geometry);
        if (!centre) continue;
        const project = metresTo(centre);
        let best = { name: '', d: maxM };
        for (const street of streets) for (const line of street.lines) {
            const pts = line.map(project);
            for (let i = 0; i + 1 < pts.length; i++) {
                const d = pointSegment([0, 0], pts[i], pts[i + 1]);
                if (d < best.d) best = { name: street.name, d };
            }
        }
        if (!out.has(best.name)) out.set(best.name, []);
        out.get(best.name).push(feature);
    }
    return out;
}

// Sums of judged buildings: counts by verdict and, for the eligible and for the eligible plus the possible
// (no failing test, some fact unknown), the floor area added, its homes and the money rows' totals.
export function summarize(rows) {
    const tiers = { eligible: r => r.verdict === 'eligible', possible: r => r.verdict === 'eligible' || r.verdict === 'unknown' };
    const sum = (list, key) => list.reduce((s, r) => s + (finite(r[key]) ? r[key] : 0), 0);
    const out = { buildings: rows.length, byVerdict: {}, unmeasured: {}, tiers: {} };
    for (const r of rows) out.byVerdict[r.verdict] = (out.byVerdict[r.verdict] || 0) + 1;
    for (const [tier, keep] of Object.entries(tiers)) {
        const list = rows.filter(keep);
        out.unmeasured[tier] = list.filter(r => !finite(r.addedM2)).length;
        const priced = list.filter(r => r.money && finite(r.money.value));
        const viable = priced.filter(r => finite(r.money.profit) && r.money.profit > 0);
        out.tiers[tier] = { buildings: list.length, addedM2: sum(list, 'addedM2'), homes: homesIn(sum(list, 'addedM2')),
            value: priced.reduce((s, r) => s + r.money.value, 0), totalCost: priced.reduce((s, r) => s + (r.money.totalCost || 0), 0),
            profit: priced.reduce((s, r) => s + (r.money.profit || 0), 0),
            viable: { buildings: viable.length, addedM2: sum(viable, 'addedM2'), homes: homesIn(sum(viable, 'addedM2')),
                value: viable.reduce((s, r) => s + r.money.value, 0), profit: viable.reduce((s, r) => s + r.money.profit, 0) } };
    }
    const fails = {}, unknowns = {};
    for (const r of rows) { for (const id of r.failing || []) fails[id] = (fails[id] || 0) + 1; for (const id of r.unknown || []) unknowns[id] = (unknowns[id] || 0) + 1; }
    out.failingTests = fails; out.unknownTests = unknowns;
    return out;
}
