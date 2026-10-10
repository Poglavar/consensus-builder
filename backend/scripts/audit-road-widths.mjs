#!/usr/bin/env node
// Read-only audit of every stored road proposal's LAND POLYGON width (projections.md §7).
//
// A corridor's polygon should be exactly as wide as its declared cross-section. One built in the
// wrong map projection (the app used the ACTIVE city's metric CRS; with no city that was New York's
// UTM 18N, which at Zagreb makes a 19 m street 13.65 m) is uniformly too narrow or too wide. This
// measures it directly on the ellipsoid: perpendicular transects through straight, isolated stretches
// of the centre line, the nearest polygon boundary crossing on each side, the geodesic distance
// between the two, and its ratio to the declared width. Width resolution (corridor-profile.js), the
// metric frame (metric-frame.js) and the underground rule (corridor-levels.js) are the app's own.
// Nothing is written anywhere except the report files.
//
//   node scripts/audit-road-widths.mjs --help
//   PGHOST=127.0.0.1 node scripts/audit-road-widths.mjs --db --out /tmp/road-widths-local.md
//   node scripts/audit-road-widths.mjs --input rows.json --label production --out /tmp/road-widths-prod.md

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import dotenv from 'dotenv';
import pg from 'pg';
import proj4 from 'proj4';

const require = createRequire(import.meta.url);
// metric-frame.js reads the proj4 global first, so the backend's copy serves it from any cwd.
globalThis.proj4 = globalThis.proj4 || proj4;
const { corridorSegmentEntries, corridorProfileWidth } = require('../../frontend/js/corridor-profile.js');
const { frameFor, geodesicDistance } = require('../../frontend/js/metric-frame.js');
const { acquiringSpans } = require('../../frontend/js/proposals/corridor-levels.js');

const USAGE = `Usage: node scripts/audit-road-widths.mjs (--db | --input <rows.json>) [options]

Measures the land polygon of every stored road proposal against its declared width. Read-only.

Source (exactly one):
  --db                   read the road rows of --table from the database named by the PG* environment;
                         backend/.env fills in what the environment leaves unset (its PGHOST=db is the
                         docker service name, so from the host run with PGHOST=127.0.0.1). The session
                         is opened with default_transaction_read_only=on.
  --input <rows.json>    a JSON array of rows {id, proposal_id, city, created_at, lifecycle_status,
                         road_proposal}, e.g. the output of
                           SELECT json_agg(json_build_object('id', id, ..., 'road_proposal', road_proposal))
                           FROM consensus.proposal WHERE road_proposal IS NOT NULL
Options:
  --table <schema.table> table for --db (default public.proposal)
  --ids <a,b,...>        only these row ids
  --label <text>         name of the data set in the report title (default: the source)
  --out <report.md>      write the Markdown report here (default: stdout)
  --json <file.json>     also write every record's measurements as JSON
  --help                 this text

Method: stations at 25/50/75 % of every straight centre-line run >= 20 m, skipping stations within
15 m of a run end or within (width + 5 m) of any other centre line or bend of the record; a transect of
1.5 x width each side; the nearest boundary crossing per side, measured on the WGS84 ellipsoid.
A record is OK when |median(measured / declared) - 1| <= 2 %, SUSPECT otherwise.`;

const STATION_FRACTIONS = [0.25, 0.5, 0.75];
const MIN_EDGE_M = 20;              // only straight runs at least this long carry stations
const END_CLEARANCE_M = 15;         // no station this close to either end of an acquiring run
const CLEARANCE_MARGIN_M = 5;       // ... nor closer than width + this to another centre line or bend
const REACH_FACTOR = 1.5;           // a transect reaches 1.5 x width on each side of the centre line
const STRAIGHT_TOLERANCE_M = 0.02;  // a vertex this close to the chord is not a bend
const MAX_BOUNDARY_ANGLE_DEG = 10;  // a crossing counts only where the boundary runs within 10° of the centre line
const MIN_RING_AREA_M2 = 1;         // smaller rings are union slivers (zero-area holes), not land
const OK_TOLERANCE = 0.02;          // |median ratio - 1| <= 2 % is OK
const OUTLIER_TOLERANCE = 0.05;     // an OK record with a transect beyond 5 % is listed for a look
const PROJECTION_MATCH = 0.005;     // a SUSPECT median within 0.5 % of a frame's factor "matches" it
const ATTRIBUTION_MIN_TRANSECTS = 3; // ... provided it has this many transects,
const ATTRIBUTION_MAX_SPREAD = 0.01; // ... (max - min) / median within 1 %,
const ATTRIBUTION_MAX_ASYMMETRY = 0.01; // ... and both halves alike within 1 % of the width
const MISMATCH_KM = 30;             // declared city centre farther than this while another city is nearer

const log = message => console.error(`[${new Date().toISOString()}] ${message}`);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const round = (value, digits) => (finite(value) ? Number(value.toFixed(digits)) : null);

function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function monthOf(createdAt) {
    const date = createdAt ? new Date(createdAt) : null;
    return date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 7) : 'unknown';
}

// ---- planar helpers (metric [x, y] in the record's frame) ------------------------------------

function pointSegmentDistance(p, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq)) : 0;
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// Douglas–Peucker: drop vertices within `tolerance` of the chord, so a straight run stored as many
// collinear pieces is one edge and every vertex left is a real bend.
export function simplifyPolyline(points, tolerance) {
    if (points.length <= 2) return points.slice();
    const keep = points.map((_, index) => index === 0 || index === points.length - 1);
    const stack = [[0, points.length - 1]];
    while (stack.length) {
        const [from, to] = stack.pop();
        let worst = -1;
        let worstDistance = tolerance;
        for (let index = from + 1; index < to; index += 1) {
            const d = pointSegmentDistance(points[index], points[from], points[to]);
            if (d > worstDistance) { worst = index; worstDistance = d; }
        }
        if (worst !== -1) { keep[worst] = true; stack.push([from, worst], [worst, to]); }
    }
    return points.filter((_, index) => keep[index]);
}

function ringArea(ring) {
    let twice = 0;
    for (let i = 0; i < ring.length - 1; i += 1) twice += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    return Math.abs(twice) / 2;
}

// Even–odd over every ring of every part (holes included).
function insideRings(p, rings) {
    let inside = false;
    for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
            const [xi, yi] = ring[i];
            const [xj, yj] = ring[j];
            if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) inside = !inside;
        }
    }
    return inside;
}

// The nearest boundary crossing on each side of p along the normal n, within ±reach. `s` is the
// signed offset (positive = left of travel); `sin` is the sine of the angle between the crossed
// boundary edge and the centre-line direction u.
function nearestCrossings(p, u, n, reach, rings) {
    let left = null;
    let right = null;
    for (const ring of rings) {
        for (let i = 0; i < ring.length - 1; i += 1) {
            const q = ring[i];
            const ex = ring[i + 1][0] - q[0];
            const ey = ring[i + 1][1] - q[1];
            const denom = n[0] * ey - n[1] * ex;
            if (Math.abs(denom) < 1e-12) continue;
            const wx = q[0] - p[0];
            const wy = q[1] - p[1];
            const s = (wx * ey - wy * ex) / denom;
            const t = (wx * n[1] - wy * n[0]) / denom;
            if (t < 0 || t > 1 || Math.abs(s) > reach || s === 0) continue;
            const sin = Math.abs(u[0] * ey - u[1] * ex) / Math.hypot(ex, ey);
            if (s > 0 && (!left || s < left.s)) left = { s, sin };
            if (s < 0 && (!right || s > right.s)) right = { s, sin };
        }
    }
    return { left, right };
}

// ---- reading a stored record -----------------------------------------------------------------

function parseJson(value) {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch (_) { return null; }
}

// The stored land polygon as its parts (arrays of rings of [lon, lat]), with what kind it was.
export function readPolygon(stored) {
    let geometry = parseJson(stored);
    if (geometry === undefined || geometry === null) return { kind: 'absent', parts: [] };
    if (geometry && geometry.type === 'Feature') geometry = geometry.geometry;
    if (geometry && geometry.type === 'Polygon' && Array.isArray(geometry.coordinates)) {
        return { kind: 'Polygon', parts: [geometry.coordinates] };
    }
    if (geometry && geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
        return { kind: 'MultiPolygon', parts: geometry.coordinates };
    }
    return { kind: 'unreadable', parts: [] };
}

// The width the record DECLARES for a segment — the same rule corridor-footprint.js builds with —
// or null where corridorSegmentEntries would fall back to its 10 m default.
function declaredWidth(entry, definition) {
    const width = corridorProfileWidth(entry.profile) || Number(definition && definition.width);
    return finite(width) && width > 0 ? width : null;
}

// ---- one record ------------------------------------------------------------------------------

function stationsAndTransects(entries, widths, frame, rings) {
    // Straight runs: each acquiring span of each segment (a fully underground stretch takes no
    // land, so the polygon has a gap there), in the frame, collinear vertices merged.
    const runs = [];
    entries.forEach((entry, index) => {
        acquiringSpans(entry.points).forEach(span => {
            if (span.length < 2) return;
            const metric = span.map(point => frame.toMetric([point.lng, point.lat]));
            runs.push({ segmentId: entry.segmentId, width: widths[index], points: simplifyPolyline(metric, STRAIGHT_TOLERANCE_M) });
        });
    });
    const edges = runs.flatMap((run, r) => run.points.slice(1).map((b, k) => ({ r, k, a: run.points[k], b, width: run.width })));
    const counts = { candidateStations: 0, nearEnd: 0, nearJunctionOrBend: 0 };
    const transects = [];
    const maxSin = Math.sin(MAX_BOUNDARY_ANGLE_DEG * Math.PI / 180);

    runs.forEach((run, r) => {
        const first = run.points[0];
        const last = run.points[run.points.length - 1];
        for (let k = 0; k < run.points.length - 1; k += 1) {
            const a = run.points[k];
            const b = run.points[k + 1];
            const length = dist(a, b);
            if (length < MIN_EDGE_M) continue;
            const u = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
            const n = [-u[1], u[0]];
            const bearing = ((Math.atan2(u[0], u[1]) * 180 / Math.PI) + 360) % 180;
            for (const fraction of STATION_FRACTIONS) {
                counts.candidateStations += 1;
                const p = [a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction];
                if (dist(p, first) < END_CLEARANCE_M || dist(p, last) < END_CLEARANCE_M) { counts.nearEnd += 1; continue; }
                // Every other edge of the record — other segments (junctions) and this run's own
                // neighbours (bends) alike. A wider neighbour needs room for its own half-width.
                const crowded = edges.some(edge => !(edge.r === r && edge.k === k)
                    && pointSegmentDistance(p, edge.a, edge.b) < Math.max(run.width, (run.width + edge.width) / 2) + CLEARANCE_MARGIN_M);
                if (crowded) { counts.nearJunctionOrBend += 1; continue; }

                const transect = { segmentId: run.segmentId, declared: run.width, bearing: round(bearing, 1) };
                const centre = frame.toLngLat(p);
                transect.at = [round(centre[0], 7), round(centre[1], 7)];
                if (!insideRings(p, rings)) { transects.push({ ...transect, reason: 'station outside polygon' }); continue; }
                const { left, right } = nearestCrossings(p, u, n, REACH_FACTOR * run.width, rings);
                if (!left || !right) { transects.push({ ...transect, reason: 'no boundary within 1.5 x width' }); continue; }
                const leftEdge = frame.toLngLat([p[0] + n[0] * left.s, p[1] + n[1] * left.s]);
                const rightEdge = frame.toLngLat([p[0] + n[0] * right.s, p[1] + n[1] * right.s]);
                const measured = geodesicDistance(leftEdge, rightEdge);
                transects.push({
                    ...transect,
                    measured: round(measured, 4),
                    ratio: round(measured / run.width, 5),
                    halfLeft: round(geodesicDistance(centre, leftEdge), 4),
                    halfRight: round(geodesicDistance(centre, rightEdge), 4),
                    ...(left.sin > maxSin || right.sin > maxSin ? { reason: 'oblique boundary' } : {})
                });
            }
        }
    });
    return { runs: runs.length, counts, transects };
}

export function measureRecord(row) {
    const record = {
        id: row.id,
        proposalId: row.proposal_id ?? null,
        city: row.city ?? null,
        month: monthOf(row.created_at),
        lifecycle: row.lifecycle_status ?? null,
        status: null
    };
    const roadProposal = parseJson(row.road_proposal);
    const definition = roadProposal && roadProposal.definition;
    if (!definition || typeof definition !== 'object') return { ...record, status: 'no-definition' };

    const polygon = readPolygon(definition.polygon);
    record.polygon = polygon.kind;
    const entries = corridorSegmentEntries(definition);
    if (!entries.length) return { ...record, status: 'no-centreline' };
    const widths = entries.map(entry => declaredWidth(entry, definition));
    record.segments = entries.length;
    record.declaredWidths = [...new Set(widths.map(width => (width === null ? null : round(width, 3))))];
    record.noDeclaredWidth = widths.some(width => width === null);

    let frame;
    try {
        frame = frameFor(entries.flatMap(entry => entry.points.map(point => [point.lng, point.lat])));
        record.location = [frame.anchor[0], frame.anchor[1]];
        entries.forEach(entry => entry.points.forEach(point => frame.toMetric([point.lng, point.lat])));
    } catch (error) {
        return { ...record, status: 'frame-error', error: error.message };
    }
    if (polygon.kind === 'absent') return { ...record, status: 'no-polygon' };
    if (polygon.kind === 'unreadable') return { ...record, status: 'unreadable-polygon' };
    if (record.noDeclaredWidth) return { ...record, status: 'no-declared-width' };

    let rings;
    try {
        rings = polygon.parts.flatMap(part => part.map(ring => ring.map(position => frame.toMetric(position))));
    } catch (error) {
        return { ...record, status: 'polygon-out-of-frame', error: error.message };
    }
    const slivers = rings.filter(ring => ringArea(ring) < MIN_RING_AREA_M2).length;
    if (slivers) { record.sliverRingsIgnored = slivers; rings = rings.filter(ring => ringArea(ring) >= MIN_RING_AREA_M2); }

    const { runs, counts, transects } = stationsAndTransects(entries, widths, frame, rings);
    const clean = transects.filter(transect => !transect.reason);
    record.runs = runs;
    record.stations = { ...counts, measured: clean.length };
    record.rejected = {};
    transects.filter(transect => transect.reason).forEach(transect => {
        record.rejected[transect.reason] = (record.rejected[transect.reason] || 0) + 1;
    });
    record.transects = transects;
    if (!clean.length) return { ...record, status: 'no-transect', why: noTransectReason(counts, record.rejected) };

    const ratios = clean.map(transect => transect.ratio);
    record.ratio = {
        median: round(median(ratios), 5),
        min: round(Math.min(...ratios), 5),
        max: round(Math.max(...ratios), 5)
    };
    // (left - right) / declared: a uniform projection error keeps this near 0; a clipped or
    // displaced polygon does not.
    record.asymmetry = round(median(clean.map(transect => (transect.halfLeft - transect.halfRight) / transect.declared)), 4);
    record.outliers = ratios.filter(ratio => Math.abs(ratio - 1) > OUTLIER_TOLERANCE).length;
    record.verdict = Math.abs(record.ratio.median - 1) <= OK_TOLERANCE ? 'OK' : 'SUSPECT';
    return { ...record, status: 'measured' };
}

function noTransectReason(counts, rejected) {
    if (!counts.candidateStations) return `no straight run >= ${MIN_EDGE_M} m`;
    const parts = [];
    if (counts.nearEnd) parts.push(`${counts.nearEnd} near a run end`);
    if (counts.nearJunctionOrBend) parts.push(`${counts.nearJunctionOrBend} near a junction or bend`);
    Object.entries(rejected).forEach(([reason, count]) => parts.push(`${count} ${reason}`));
    return `${counts.candidateStations} stations: ${parts.join(', ')}`;
}

// ---- where a record is, and which wrong frame would explain its ratio -------------------------

// The app's own city table (frontend/js/city-config.js is a browser script: run it against a stub
// window and use the CityConfigManager it publishes).
function loadCities() {
    const source = readFileSync(new URL('../../frontend/js/city-config.js', import.meta.url), 'utf8');
    const storage = { getItem: () => null, setItem() {}, removeItem() {} };
    const window = { location: { search: '', hostname: 'localhost', reload() {} }, localStorage: storage };
    vm.runInContext(source, vm.createContext({ window, localStorage: storage, URLSearchParams, URL, console }), { filename: 'city-config.js' });
    if (!window.CityConfigManager) throw new Error('city-config.js did not publish CityConfigManager');
    return window.CityConfigManager;
}

function cityCheck(record, cities) {
    if (!record.location) return null;
    const [lon, lat] = record.location;
    const nearest = cities.findNearestCity(lat, lon);
    const km = config => {
        const centre = config && cities.getCityCenter(config);
        return centre ? geodesicDistance([lon, lat], [centre[1], centre[0]]) / 1000 : null;
    };
    const declared = record.city ? cities.getCityConfig(record.city) : null;
    const check = {
        nearestCity: nearest ? nearest.id : null,
        nearestKm: round(km(nearest), 1),
        declaredKnown: !!declared,
        declaredKm: declared && !declared.explore ? round(km(declared), 1) : null
    };
    check.mismatch = !!declared && !declared.explore && !!nearest && nearest.id !== declared.id && check.declaredKm > MISMATCH_KM;
    check.unknownCity = !declared;
    return check;
}

// Every metric CRS the app could have built in: each city's metric (else dataset) CRS, plus
// Leaflet's Web Mercator. A footprint built in a CRS whose scale at the site is k comes out 1/k wide.
function projectionCandidates(cities) {
    const byCrs = new Map([['EPSG:3857', { crs: 'EPSG:3857', definition: 'EPSG:3857', cities: ['Leaflet Web Mercator'] }]]);
    cities.getAvailableCities().forEach(config => {
        const projection = config.projection || {};
        const crs = projection.metricCrs || projection.datasetCrs;
        const definition = projection.metricCrs ? projection.metricDefinition : projection.definition;
        if (!crs || !definition || /proj=longlat/.test(definition)) return;
        if (!byCrs.has(crs)) byCrs.set(crs, { crs, definition, cities: [] });
        byCrs.get(crs).cities.push(config.id);
    });
    return [...byCrs.values()];
}

function expectedRatio(candidate, lon, lat) {
    const frame = frameFor([[lon, lat]]);
    const origin = frame.toLngLat([0, 0]);
    const east = frame.toLngLat([10, 0]);
    const north = frame.toLngLat([0, 10]);
    try {
        const forward = proj4('EPSG:4326', candidate.definition).forward;
        const o = forward(origin);
        const kEast = dist(o, forward(east)) / geodesicDistance(origin, east);
        const kNorth = dist(o, forward(north)) / geodesicDistance(origin, north);
        const k = (kEast + kNorth) / 2;
        return finite(k) && k > 0 ? 1 / k : null;
    } catch (_) {
        return null; // outside the CRS's numeric domain: it cannot have been used here
    }
}

// A wrong frame scales every transect alike and both halves alike; only a record that shows that
// is fitted to a frame (with ~100 candidate CRSs, some factor lies near ANY ratio).
function attribute(record, candidates) {
    const { median: m, min, max } = record.ratio;
    if (record.stations.measured < ATTRIBUTION_MIN_TRANSECTS) {
        return { note: `${record.stations.measured} transect(s): too few to attribute` };
    }
    if ((max - min) / m > ATTRIBUTION_MAX_SPREAD || Math.abs(record.asymmetry) > ATTRIBUTION_MAX_ASYMMETRY) {
        return { note: 'non-uniform or asymmetric: not a projection signature' };
    }
    const [lon, lat] = record.location;
    const fits = candidates
        .map(candidate => ({ crs: candidate.crs, cities: candidate.cities, expected: expectedRatio(candidate, lon, lat) }))
        .filter(fit => fit.expected !== null)
        .map(fit => ({ ...fit, delta: Math.abs(fit.expected - m) }))
        .sort((a, b) => a.delta - b.delta);
    if (!fits.length) return { note: 'no candidate frame is defined here' };
    // Several CRSs can share a factor (UTM 18N and 18S share a meridian), so every one within
    // tolerance is listed, nearest first.
    return { best: fits[0], matching: fits.filter(fit => fit.delta <= PROJECTION_MATCH) };
}

// ---- the report ------------------------------------------------------------------------------

const RATIO_BINS = [0, 0.6, 0.69, 0.705, 0.74, 0.9, 0.98, 0.99, 0.995, 0.999, 1.001, 1.005, 1.01, 1.02, 1.1, 1.3, 1.5, Infinity];
const fmt = (value, digits = 4) => (finite(value) ? value.toFixed(digits) : '—');
const cellOf = location => {
    if (!location) return 'unknown';
    const lat = Math.round(location[1]);
    const lon = Math.round(location[0]);
    return `${Math.abs(lat)}°${lat < 0 ? 'S' : 'N'} ${Math.abs(lon)}°${lon < 0 ? 'W' : 'E'}`;
};
const where = location => (location ? `${location[1].toFixed(4)}, ${location[0].toFixed(4)}` : '—');
const idList = records => (records.length ? records.map(record => record.id).join(', ') : 'none');

function groupTable(title, records, keyOf) {
    const groups = new Map();
    records.forEach(record => {
        const key = keyOf(record);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(record);
    });
    const lines = [`### By ${title}`, '', '| ' + title + ' | records | measured | OK | SUSPECT | no polygon | no transect | median of medians | min median | max median |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
    [...groups.keys()].sort().forEach(key => {
        const group = groups.get(key);
        const measured = group.filter(record => record.status === 'measured');
        const medians = measured.map(record => record.ratio.median);
        lines.push(`| ${key} | ${group.length} | ${measured.length} | ${measured.filter(r => r.verdict === 'OK').length} | ${measured.filter(r => r.verdict === 'SUSPECT').length} | ${group.filter(r => r.polygon === 'absent').length} | ${group.filter(r => r.status === 'no-transect').length} | ${fmt(median(medians))} | ${fmt(medians.length ? Math.min(...medians) : null)} | ${fmt(medians.length ? Math.max(...medians) : null)} |`);
    });
    return lines.join('\n');
}

export function buildReport(records, meta) {
    const measured = records.filter(record => record.status === 'measured');
    const ok = measured.filter(record => record.verdict === 'OK');
    const suspect = measured.filter(record => record.verdict === 'SUSPECT');
    const byStatus = status => records.filter(record => record.status === status);
    const multi = records.filter(record => record.polygon === 'MultiPolygon');
    const noPolygon = records.filter(record => record.polygon === 'absent');
    const noWidth = records.filter(record => record.noDeclaredWidth);
    const variable = records.filter(record => record.declaredWidths && record.declaredWidths.length > 1);
    const transectCount = measured.reduce((total, record) => total + record.stations.measured, 0);
    const lines = [];

    lines.push(`# Road polygon width audit — ${meta.label}`, '');
    lines.push(`Generated ${meta.generatedAt} by \`backend/scripts/audit-road-widths.mjs\` (projections.md §7). Read-only. Source: ${meta.source}.`, '');
    if (meta.notRoad && meta.notRoad.length) {
        lines.push(`Ignored ${meta.notRoad.length} row(s) whose road_proposal is JSON null (not road records): ${meta.notRoad.join(', ')}.`, '');
    }
    lines.push(`Method: stations at 25/50/75 % of each straight centre-line run ≥ ${MIN_EDGE_M} m (collinear vertices within ${STRAIGHT_TOLERANCE_M * 100} cm merged; fully underground stretches skipped), none within ${END_CLEARANCE_M} m of a run end or within width + ${CLEARANCE_MARGIN_M} m of any other centre-line edge of the record (junctions, bends; a wider neighbour needs (w + w′)/2 + ${CLEARANCE_MARGIN_M} m). At each station a perpendicular of ${REACH_FACTOR} × width per side in a local transverse Mercator (metric-frame.js), the nearest polygon boundary crossing on each side, their geodesic (Vincenty) separation ÷ declared width = ratio. A crossing whose boundary runs more than ${MAX_BOUNDARY_ANGLE_DEG}° off the centre line is rejected as oblique; polygon rings under ${MIN_RING_AREA_M2} m² (union slivers) are ignored. OK: |median − 1| ≤ ${OK_TOLERANCE * 100} %.`, '');

    lines.push('## Summary', '', '| | records |', '|---|---:|');
    lines.push(`| road records | ${records.length} |`);
    lines.push(`| measured (≥ 1 clean transect; ${transectCount} transects) | ${measured.length} |`);
    lines.push(`| — OK | ${ok.length} |`);
    lines.push(`| — SUSPECT | ${suspect.length} |`);
    lines.push(`| no polygon | ${noPolygon.length} |`);
    lines.push(`| no measurable transect | ${byStatus('no-transect').length} |`);
    lines.push(`| no declared width (any segment) | ${noWidth.length} (not measured: ${byStatus('no-declared-width').length}) |`);
    lines.push(`| MultiPolygon (measured where possible) | ${multi.length} (measured: ${multi.filter(r => r.status === 'measured').length}) |`);
    lines.push(`| per-segment widths differ | ${variable.length} |`);
    lines.push(`| no centre line (designation) | ${byStatus('no-centreline').length} |`);
    lines.push(`| no definition | ${byStatus('no-definition').length} |`);
    lines.push(`| unreadable polygon | ${byStatus('unreadable-polygon').length} |`);
    lines.push(`| frame error / polygon outside the frame | ${byStatus('frame-error').length} / ${byStatus('polygon-out-of-frame').length} |`, '');

    lines.push('## SUSPECT records', '');
    if (!suspect.length) {
        lines.push('None.', '');
    } else {
        lines.push('| id | proposal_id | city | created | lifecycle | transects | median | min | max | asym | location | nearest city | best-fitting frame (expected) |', '|---:|---|---|---|---|---:|---:|---:|---:|---:|---|---|---|');
        suspect.sort((a, b) => a.ratio.median - b.ratio.median).forEach(record => {
            const frameText = frame => `${frame.crs} [${frame.cities.slice(0, 3).join(', ')}${frame.cities.length > 3 ? ', …' : ''}] (${fmt(frame.expected)})`;
            const attribution = record.attribution;
            const fit = !attribution ? '—'
                : attribution.note ? attribution.note
                    : attribution.matching.length
                        ? `**matches** ${attribution.matching.slice(0, 4).map(frameText).join('; ')}${attribution.matching.length > 4 ? `; +${attribution.matching.length - 4} more` : ''}`
                        : `no match (nearest ${frameText(attribution.best)})`;
            lines.push(`| ${record.id} | ${record.proposalId ?? ''} | ${record.city ?? ''} | ${record.month} | ${record.lifecycle ?? ''} | ${record.stations.measured} | ${fmt(record.ratio.median)} | ${fmt(record.ratio.min)} | ${fmt(record.ratio.max)} | ${fmt(record.asymmetry, 3)} | ${where(record.location)} | ${record.cityCheck ? `${record.cityCheck.nearestCity} (${fmt(record.cityCheck.nearestKm, 1)} km)` : '—'} | ${fit} |`);
        });
        lines.push('', '`asym` = median (left − right half-width) ÷ declared width: a wrong projection scales both halves alike (≈ 0); clipping or a displaced polygon does not.', '');
    }

    lines.push('## Distribution of record medians', '', '| median ratio | records | ids (SUSPECT bins) |', '|---|---:|---|');
    for (let i = 0; i < RATIO_BINS.length - 1; i += 1) {
        const inBin = measured.filter(record => record.ratio.median >= RATIO_BINS[i] && record.ratio.median < RATIO_BINS[i + 1]);
        if (!inBin.length) continue;
        const susp = inBin.filter(record => record.verdict === 'SUSPECT');
        lines.push(`| [${RATIO_BINS[i]}, ${RATIO_BINS[i + 1]}) | ${inBin.length} | ${susp.length ? idList(susp) : ''} |`);
    }
    const near = new Map();
    measured.filter(record => Math.abs(record.ratio.median - 1) <= OK_TOLERANCE).forEach(record => {
        const key = fmt(record.ratio.median);
        near.set(key, (near.get(key) || 0) + 1);
    });
    lines.push('', `Medians within ±${OK_TOLERANCE * 100} % to 4 decimals: ${[...near.keys()].sort().map(key => `${key} × ${near.get(key)}`).join(', ') || 'none'}.`);
    lines.push('', 'Reference factors: EPSG:3765 at a Croatian site ≈ 1.0001 (its k₀ = 0.9999), a Belgrade footprint built in it ≈ 0.999; a Zagreb footprint built in New York\'s UTM 18N ≈ 0.718, in Web Mercator ≈ 0.697 (cos φ); local-frame.js\'s fixed 110 540 m/° ≈ 1.002–1.005.', '');

    const flagged = ok.filter(record => record.outliers > 0);
    lines.push(`## OK records with a transect beyond ±${OUTLIER_TOLERANCE * 100} %`, '');
    lines.push(flagged.length
        ? flagged.map(record => `- ${record.id} (${record.city ?? ''}, ${record.month}): ${record.outliers}/${record.stations.measured} transects, min ${fmt(record.ratio.min)}, max ${fmt(record.ratio.max)}`).join('\n')
        : 'None.', '');

    lines.push('## Groups', '');
    lines.push(groupTable('city', records, record => record.city || '(empty)'), '');
    lines.push(groupTable('created month', records, record => record.month), '');
    lines.push(groupTable('1° cell', records, record => cellOf(record.location)), '');

    const mismatched = records.filter(record => record.cityCheck && (record.cityCheck.mismatch || record.cityCheck.unknownCity));
    lines.push('## Declared city vs location (evidence to investigate, not proof)', '');
    if (!mismatched.length) {
        lines.push(`None: every record lies within ${MISMATCH_KM} km of its declared city's centre or nearest to it.`, '');
    } else {
        lines.push('| id | proposal_id | declared city | location | nearest city | km to declared centre | status |', '|---:|---|---|---|---|---:|---|');
        mismatched.forEach(record => {
            const check = record.cityCheck;
            const declared = check.unknownCity ? `${record.city || '(empty)'} (not a city id)` : record.city;
            lines.push(`| ${record.id} | ${record.proposalId ?? ''} | ${declared} | ${where(record.location)} | ${check.nearestCity} (${fmt(check.nearestKm, 1)} km) | ${fmt(check.declaredKm, 1)} | ${record.status}${record.verdict ? ` ${record.verdict}` : ''} |`);
        });
        lines.push('');
    }

    lines.push('## Not measured, and why', '');
    lines.push(`- **No polygon** (${noPolygon.length}): ${idList(noPolygon)}`);
    lines.push(`- **No declared width** (${noWidth.length}): ${idList(noWidth)}`);
    lines.push(`- **Designations / no centre line** (${byStatus('no-centreline').length}): ${idList(byStatus('no-centreline'))}`);
    ['no-definition', 'unreadable-polygon', 'frame-error', 'polygon-out-of-frame'].forEach(status => {
        const list = byStatus(status);
        if (list.length) lines.push(`- **${status}** (${list.length}): ${list.map(record => `${record.id}${record.error ? ` (${record.error})` : ''}`).join('; ')}`);
    });
    lines.push(`- **No measurable transect** (${byStatus('no-transect').length}):`);
    byStatus('no-transect').forEach(record => lines.push(`  - ${record.id} (${record.city ?? ''}, ${record.month}, ${record.polygon}, ${record.segments} segment(s)): ${record.why}`));
    lines.push(`- **MultiPolygon** (${multi.length}): ${multi.map(record => `${record.id} (${record.status}${record.verdict ? ` ${record.verdict}` : ''})`).join(', ') || 'none'}`, '');
    return lines.join('\n');
}

// ---- running ---------------------------------------------------------------------------------

function parseArgs(argv) {
    const args = { table: 'public.proposal' };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const value = () => {
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
            i += 1;
            return next;
        };
        if (arg === '--help' || arg === '-h') args.help = true;
        else if (arg === '--db') args.db = true;
        else if (arg === '--input') args.input = value();
        else if (arg === '--table') args.table = value();
        else if (arg === '--ids') args.ids = new Set(value().split(',').map(id => id.trim()).filter(Boolean));
        else if (arg === '--label') args.label = value();
        else if (arg === '--out') args.out = value();
        else if (arg === '--json') args.json = value();
        else throw new Error(`unknown argument ${arg}`);
    }
    return args;
}

async function readRowsFromDb(table) {
    if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`--table must be schema.table, got ${table}`);
    dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
    const client = new pg.Client({ options: '-c default_transaction_read_only=on' });
    await client.connect();
    try {
        const { rows } = await client.query(`SELECT id, proposal_id, city, created_at, lifecycle_status, road_proposal
            FROM ${table} WHERE road_proposal IS NOT NULL ORDER BY id`);
        return { rows, source: `${table} on ${client.host}:${client.port}/${client.database}` };
    } finally {
        await client.end();
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || (!args.db && !args.input)) { console.log(USAGE); return; }
    if (args.db && args.input) throw new Error('use either --db or --input, not both');

    const { rows: allRows, source } = args.db
        ? await readRowsFromDb(args.table)
        : { rows: JSON.parse(readFileSync(args.input, 'utf8')), source: `rows exported to ${args.input}` };
    if (!Array.isArray(allRows)) throw new Error('the input must be a JSON array of rows');
    // `road_proposal IS NOT NULL` still admits the JSON value null (building, structure and parcel
    // proposals carry it): those are not road records.
    const selected = args.ids ? allRows.filter(row => args.ids.has(String(row.id))) : allRows;
    const isRoad = row => { const value = parseJson(row.road_proposal); return !!value && typeof value === 'object'; };
    const rows = selected.filter(isRoad);
    const notRoad = selected.filter(row => !isRoad(row)).map(row => row.id);
    log(`read ${allRows.length} rows from ${source}${args.ids ? `; ${selected.length} selected` : ''}; ${notRoad.length} with road_proposal = JSON null ignored; auditing ${rows.length}`);

    const cities = loadCities();
    const candidates = projectionCandidates(cities);
    const started = Date.now();
    const records = rows.map((row, index) => {
        const record = measureRecord(row);
        record.cityCheck = cityCheck(record, cities);
        if (record.verdict === 'SUSPECT') record.attribution = attribute(record, candidates);
        const done = index + 1;
        if (done % 50 === 0 || done === rows.length) {
            const elapsed = (Date.now() - started) / 1000;
            log(`${done}/${rows.length} records · ${Math.round(done / rows.length * 100)} % · ETA ${Math.round(elapsed / done * (rows.length - done))} s`);
        }
        return record;
    });

    const measured = records.filter(record => record.status === 'measured');
    log(`measured ${measured.length} (OK ${measured.filter(r => r.verdict === 'OK').length}, SUSPECT ${measured.filter(r => r.verdict === 'SUSPECT').length}); no polygon ${records.filter(r => r.polygon === 'absent').length}; no transect ${records.filter(r => r.status === 'no-transect').length}; no declared width ${records.filter(r => r.noDeclaredWidth).length}`);

    const report = buildReport(records, { label: args.label || source, source, notRoad, generatedAt: new Date().toISOString() });
    if (args.out) { writeFileSync(args.out, report); log(`report written to ${args.out}`); } else { console.log(report); }
    if (args.json) { writeFileSync(args.json, JSON.stringify(records, null, 1)); log(`records written to ${args.json}`); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => {
        log(`FAILED: ${error.stack || error.message}`);
        process.exit(1);
    });
}
