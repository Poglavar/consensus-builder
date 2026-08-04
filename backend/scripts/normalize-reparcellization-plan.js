// Rebuild a land-readjustment plan as a clean planar subdivision of its pool.
//
// The editor treats a readjustment as "pooled outline + cuts", and re-derives the plots as the
// faces that arrangement encloses. That only works when the plots really do partition the pool:
// every interior boundary shared by exactly the two plots it separates, every crossing carrying a
// node. A plan assembled from separate sources need not be like that. The imported UPU Borovje
// reconstruction has 15 interior edges bounded by a single plot — neighbours abutting without
// sharing the edge — so re-deriving faces from it produces overlapping plots instead of an edit,
// and the editor has to fall back to a weaker per-ring removal.
//
// This normalises the geometry: the pool is cut down by each plot in turn, which produces a true
// partition (faces come from boolean operations against a common parent, so shared boundaries are
// coincident by construction), then the pieces are grouped back by owner. Owner assignments, names
// and colours are preserved — only the geometry is rebuilt.
//
// Fidelity is not the goal; the plan is a reconstruction. A partition that can be edited under the
// rules is worth more than a faithful copy that cannot.
//
// Dry-run by default:
//   node scripts/normalize-reparcellization-plan.js --proposal 633
//   node scripts/normalize-reparcellization-plan.js --proposal 633 --apply

import pkg from 'pg';
import 'dotenv/config';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Pool } = pkg;
const turf = require('@turf/turf');
const topo = require('../../frontend/js/proposals/plot-topology.js');

// Pieces below this are boolean-operation noise, not land.
const MIN_PIECE_M2 = 0.5;

export function parseArgs(argv) {
    const args = { apply: false, proposalId: null };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--apply') args.apply = true;
        else if (argv[i] === '--proposal') args.proposalId = argv[++i];
    }
    return args;
}

function feature(geometry) {
    return geometry ? { type: 'Feature', properties: {}, geometry } : null;
}

function areaOf(geometry) {
    try { return geometry ? (turf.area(feature(geometry)) || 0) : 0; } catch (_) { return 0; }
}

function explode(geometry) {
    if (!geometry) return [];
    if (geometry.type === 'Polygon') return [geometry];
    if (geometry.type === 'MultiPolygon') {
        return (geometry.coordinates || []).map(coordinates => ({ type: 'Polygon', coordinates }));
    }
    return [];
}

function intersect(a, b) {
    try { const r = turf.intersect(feature(a), feature(b)); return r ? r.geometry : null; } catch (_) { return null; }
}

function difference(a, b) {
    try { const r = turf.difference(feature(a), feature(b)); return r ? r.geometry : null; } catch (_) { return null; }
}

function union(a, b) {
    try { const r = turf.union(feature(a), feature(b)); return r ? r.geometry : null; } catch (_) { return null; }
}

function unionAll(geometries) {
    let acc = null;
    for (const geometry of geometries) {
        if (!geometry) continue;
        acc = acc ? (union(acc, geometry) || acc) : geometry;
    }
    return acc;
}

// Cut the pool down by each plot in turn. Every resulting piece lies inside exactly one plot (or
// inside none, where the plan left a gap), and because each piece came from boolean operations on
// a common parent, neighbouring pieces share their boundary exactly.
export function partitionPool(pool, plotGeometries) {
    let pieces = [pool];
    plotGeometries.forEach(plot => {
        if (!plot) return;
        const next = [];
        pieces.forEach(piece => {
            const inside = intersect(piece, plot);
            const outside = difference(piece, plot);
            explode(inside).forEach(part => { if (areaOf(part) >= MIN_PIECE_M2) next.push(part); });
            explode(outside).forEach(part => { if (areaOf(part) >= MIN_PIECE_M2) next.push(part); });
        });
        if (next.length) pieces = next;
    });
    return pieces;
}

// Which plot does a piece belong to? The one it overlaps most. A piece the plan never covered
// (a gap) has no best plot and is handed to the neighbour it shares the most boundary with, so no
// land is left unassigned.
export function assignPieces(pieces, plotGeometries) {
    return pieces.map(piece => {
        let bestIndex = -1;
        let bestArea = 0;
        plotGeometries.forEach((plot, index) => {
            const shared = plot ? intersect(piece, plot) : null;
            const area = shared ? areaOf(shared) : 0;
            if (area > bestArea) { bestArea = area; bestIndex = index; }
        });
        return { piece, plotIndex: bestIndex };
    });
}

function attachOrphans(assigned, plotGeometries) {
    const orphans = assigned.filter(entry => entry.plotIndex < 0);
    if (!orphans.length) return assigned;
    orphans.forEach(entry => {
        let bestIndex = -1;
        let bestScore = 0;
        let probe = entry.piece;
        try {
            const grown = turf.buffer(feature(entry.piece), 0.5, { units: 'meters' });
            if (grown && grown.geometry) probe = grown.geometry;
        } catch (_) { /* the buffer is an optimisation */ }
        plotGeometries.forEach((plot, index) => {
            const shared = plot ? intersect(probe, plot) : null;
            const score = shared ? areaOf(shared) : 0;
            if (score > bestScore) { bestScore = score; bestIndex = index; }
        });
        entry.plotIndex = bestIndex >= 0 ? bestIndex : 0;
    });
    return assigned;
}

// Rebuild the polygon list: same owners, same names, geometry that partitions the pool.
export function normalizePlan(plan, pool) {
    const polygons = Array.isArray(plan.polygons) ? plan.polygons : [];
    const plotGeometries = polygons.map(p => (p && p.geometry) || null);
    const pieces = partitionPool(pool, plotGeometries);
    const assigned = attachOrphans(assignPieces(pieces, plotGeometries), plotGeometries);

    const byPlot = new Map();
    assigned.forEach(entry => {
        const list = byPlot.get(entry.plotIndex) || [];
        list.push(entry.piece);
        byPlot.set(entry.plotIndex, list);
    });

    const rebuilt = [];
    polygons.forEach((polygon, index) => {
        const parts = byPlot.get(index);
        if (!parts || !parts.length) return;   // this plot's land all went elsewhere
        const merged = unionAll(parts);
        if (!merged) return;
        rebuilt.push({
            ...polygon,
            geometry: merged,
            area: Math.round(areaOf(merged))
        });
    });
    return rebuilt;
}

// The check the editor makes before trusting a plan enough to re-derive its faces.
export function planarityReport(polygons, pool) {
    const plots = polygons.map(p => ({ geometry: p.geometry }));
    const topology = topo.annotateBoundary(topo.buildTopology(plots), topo.boundaryIndexOf(pool));
    const unshared = (topology.edges || []).filter(e => !e.onBoundary && (e.plots || []).length < 2);
    const covered = polygons.reduce((sum, p) => sum + areaOf(p.geometry), 0);
    return {
        plots: polygons.length,
        nodes: topology.nodes.length,
        edges: topology.edges.length,
        unsharedInteriorEdges: unshared.length,
        coveredArea: Math.round(covered),
        poolArea: Math.round(areaOf(pool)),
        driftM2: Math.round(covered - areaOf(pool))
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.proposalId) {
        console.log('Usage: node scripts/normalize-reparcellization-plan.js --proposal <id> [--apply]');
        process.exit(1);
    }
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
        const { rows } = await pool.query('SELECT id, reparcellization FROM proposal WHERE id = $1', [args.proposalId]);
        if (!rows.length) throw new Error(`proposal ${args.proposalId} not found`);
        const plan = rows[0].reparcellization;
        if (!plan || !Array.isArray(plan.polygons) || !plan.polygons.length) {
            throw new Error(`proposal ${args.proposalId} has no reparcellization polygons`);
        }

        // The pool is the union of the parcels the plan says it pooled — the same definition the
        // editor uses, so the normalised plots line up with the outline it will draw.
        // Ids are `HR-<maticni_broj_ko>-<broj_cestice>`; the table keys on those two columns.
        const parcelIds = Array.isArray(plan.parcelIds) ? plan.parcelIds : [];
        const keys = parcelIds
            .map(id => {
                const match = /^HR-(\d+)-(.+)$/.exec(String(id));
                return match ? { ko: match[1], broj: match[2] } : null;
            })
            .filter(Boolean);
        const { rows: parcelRows } = await pool.query(
            `-- parcel.geom is HTRS96/TM (3765); the plan's polygons are WGS84, so transform.
             SELECT ST_AsGeoJSON(ST_Transform(p.geom, 4326))::json AS geometry
               FROM public.parcel p
               JOIN (SELECT unnest($1::text[]) AS ko, unnest($2::text[]) AS broj) w
                 ON p.maticni_broj_ko::text = w.ko AND p.broj_cestice::text = w.broj
              WHERE p.current IS NOT false`,
            [keys.map(k => k.ko), keys.map(k => k.broj)]
        );
        console.log(`[normalize] pool: ${parcelRows.length} of ${parcelIds.length} declared input parcels resolved`);
        let poolGeometry = unionAll(parcelRows.map(r => r.geometry));
        if (!poolGeometry) throw new Error('could not build the pool from the declared input parcels');

        // Cadastral parcels overlap each other slightly, so the union of the declared inputs can
        // overhang a parcel that is NOT one of them — Borovje spills 8 m² onto 1791/68. Plots drawn
        // by hand sat just inside that edge and missed it; plots that follow the pool exactly do
        // not, and the replay-fidelity check then reports the plan taking ground it never declared.
        // The pool is the declared parcels and nothing else, so trim what belongs to the neighbours.
        const { rows: neighbourRows } = await pool.query(
            `SELECT ST_AsGeoJSON(ST_Transform(p.geom, 4326))::json AS geometry,
                    'HR-' || p.maticni_broj_ko || '-' || p.broj_cestice AS id
               FROM public.parcel p
              WHERE p.current IS NOT false
                AND p.geom && ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), 3765)
                AND ST_Intersects(p.geom, ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), 3765))
                AND ('HR-' || p.maticni_broj_ko || '-' || p.broj_cestice) <> ALL($2::text[])`,
            [JSON.stringify(poolGeometry), parcelIds]
        );
        let trimmed = 0;
        neighbourRows.forEach(row => {
            const overlap = intersect(poolGeometry, row.geometry);
            const overlapArea = overlap ? areaOf(overlap) : 0;
            if (overlapArea < 0.01) return;
            const next = difference(poolGeometry, row.geometry);
            if (!next) return;
            poolGeometry = next;
            trimmed += overlapArea;
            console.log(`[normalize] trimmed ${Math.round(overlapArea)} m² belonging to ${row.id}`);
        });
        if (trimmed) console.log(`[normalize] pool trimmed by ${Math.round(trimmed)} m² of undeclared land`);

        console.log('[normalize] before:', planarityReport(plan.polygons, poolGeometry));
        const rebuilt = normalizePlan(plan, poolGeometry);
        const after = planarityReport(rebuilt, poolGeometry);
        console.log('[normalize] after: ', after);

        if (after.unsharedInteriorEdges > 0) {
            console.warn('[normalize] still not a clean planar network — not writing');
        }
        if (!args.apply) {
            console.log('[normalize] dry run — pass --apply to write it back');
            return;
        }
        const nextPlan = { ...plan, polygons: rebuilt, totalArea: after.poolArea, normalizedAt: new Date().toISOString() };
        await pool.query('UPDATE proposal SET reparcellization = $1, updated_at = now() WHERE id = $2',
            [nextPlan, args.proposalId]);
        console.log(`[normalize] wrote ${rebuilt.length} plots to proposal ${args.proposalId}`);
    } finally {
        await pool.end();
    }
}

if (process.argv[1] && process.argv[1].endsWith('normalize-reparcellization-plan.js')) {
    main().catch(error => { console.error(error); process.exit(1); });
}
