// Imports a track drawn in the transit planner (zagreb.lol/prijevoz) into consensus-builder as a
// track proposal, so its land take can be planned against the cadastre.
//
// The planner stores a RELATIVE level (-1 / 0 / +1, fractional on ramps) per centreline vertex —
// enough for land take, which is all consensus-builder itself computes. But relative levels are
// LOSSY exactly over water: between two high shores the solved profile is a 20–30 m bridge while
// the shore-relative levels read near zero, and anything reconstructing rail = terrain + level×10
// mid-crossing drops the deck to the sea (measured on Šibenik project 141, its bay crossing:
// authored 21.7–33.2 m a.s.l., levels 0.62→0). So when the track carries its solved
// verticalProfile, each vertex ALSO gets `elevationM` — the absolute EVRF2000 height sampled at
// its chainage — and the metadata declares the datum. consensus-builder keeps reading `level`
// (acquisition rules); the walk/cab sim reads `elevationM` and renders the authored alignment.
// Fully underground stretches are cut out of the acquisition footprint and out of nothing else —
// the centreline stays whole, so a part-tunnelled line remains ONE proposal under the
// one-contiguous-stretch ruling of 2026-08-07.
//
// The land is built the way every corridor's is (projections.md §3): POST /proposals/prepare's own
// preparation (proposals/prepare.js), in-process — the shared construction in the corridor's own frame,
// bound to the cadastre — so the stored definition carries the server-built land and its construction
// frame, which consensus-builder treats as authoritative. Writing rows directly, it also stores the
// artifact as publication would (consensus.proposal_prepared); a dry run rolls the transaction back.
// Preparing needs the server's PREPARE_SIGNING_KEY (backend/.env). (It used to buffer the line in
// EPSG:3765: right only in Croatia.)
//
// Dry-run by default:
//   node backend/scripts/import-transit-project.mjs --project 141
//   node backend/scripts/import-transit-project.mjs --project 141 --width 12 --apply
//   node backend/scripts/import-transit-project.mjs --project 141 --ko 335533,335541 --apply

import dotenv from 'dotenv';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { prepareProposal, storePreparedArtifact } from '../proposals/prepare.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
const corridorLevels = (await import('../../frontend/js/proposals/corridor-levels.js')).default
    ?? globalThis.__corridorLevels;

const { Pool } = pg;

// consensus-builder's own track width (DEFAULT_CORRIDOR_WIDTHS.track), per parallel track. The
// planner stores no land-take width — its halfWidth is a rendering weight — so this is a stated
// default rather than an inferred engineering figure. Override it with --width.
export const WIDTH_PER_TRACK_M = 3.0;

export function parseArgs(argv) {
    const args = { project: null, width: null, ko: null, city: null, apply: false, help: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--help' || arg === '-h') args.help = true;
        else if (arg === '--apply') args.apply = true;
        else if (arg === '--dry-run') args.apply = false;
        else if (arg === '--project') args.project = Number(argv[++index]);
        else if (arg === '--width') args.width = Number(argv[++index]);
        else if (arg === '--city') args.city = String(argv[++index] || '').trim() || null;
        else if (arg === '--ko') {
            args.ko = String(argv[++index] || '')
                .split(',').map(part => Number(part.trim())).filter(Number.isFinite);
            if (!args.ko.length) args.ko = null;
        } else throw new Error(`Unknown argument: ${arg}`);
    }
    return args;
}

function usage() {
    console.log(`Usage: node backend/scripts/import-transit-project.mjs --project <id> [options]

  --project <id>   transit_project row to import (required)
  --width <m>      corridor width in metres (default ${WIDTH_PER_TRACK_M} m per parallel track)
  --ko <list>      restrict to these cadastral municipalities (maticni_broj_ko, comma separated)
  --city <name>    consensus-builder city tag for the proposal
  --apply          write the proposal; without it nothing is written`);
}

// `db` is this repo's docker-compose service name, so it is as local as localhost is — the point of
// the guard is to refuse a production host, not to insist on one spelling.
const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'db', 'postgres']);

function assertLocalDatabase() {
    const host = String(process.env.PGHOST || 'localhost').trim().toLowerCase();
    if (!LOCAL_DB_HOSTS.has(host)) {
        throw new Error(`Refusing to import into non-local PGHOST=${host || '(empty)'}.`);
    }
}

async function readProject(pool, id) {
    const { rows } = await pool.query(
        `SELECT id, author_name, total_length_km, station_count, project_hash, project_data
         FROM public.transit_project WHERE id = $1`, [id]);
    if (!rows.length) throw new Error(`transit_project ${id} was not found.`);
    return rows[0];
}

// One proposal per track. A project's tracks are separate alignments, not one graph, so merging
// them would fabricate a connection that the planner never drew.
export function tracksOf(projectData) {
    const tracks = (projectData && Array.isArray(projectData.tracks)) ? projectData.tracks : [];
    return tracks.filter(track => track && Array.isArray(track.latlngs) && track.latlngs.length >= 2);
}

export function trackCountOf(track) {
    const count = Number(track && track.trackCount);
    return Number.isInteger(count) && count > 0 ? count : 1;
}

export function widthForTrack(track, override) {
    if (Number.isFinite(override) && override > 0) return override;
    return WIDTH_PER_TRACK_M * trackCountOf(track);
}

// The planner names gauges ('g1435'); consensus-builder's rail lanes carry millimetres. Monorail
// has no consensus-builder lane type, so its beam imports as a standard-gauge lane — the land-take
// width is what matters here, and the default gauge is the least-wrong rendering.
const PLANNER_GAUGE_MM = { g1000: 1000, g1435: 1435 };

// The stored cross-section: one rail lane per parallel track, splitting the corridor width evenly.
// Without this, consensus-builder's legacy synthesis draws the whole width as ONE rail lane — a
// double-track alignment rendered single-track on the map and in 3D. The strips must sum exactly
// to definition.width (corridorProfileOf's invariant), which even division preserves.
export function trackCrossSectionProfile(track, widthM) {
    const count = trackCountOf(track);
    const gauge = PLANNER_GAUGE_MM[track && track.gauge] ?? 1435;
    return {
        strips: Array.from({ length: count }, () => ({
            type: 'rail',
            width: widthM / count,
            gauge
        }))
    };
}

// ─── Authored absolute elevations (verticalProfile → per-vertex elevationM) ──

// Planar chainage in metres along {lat, lng} vertices — the same running
// distance the planner's profile is stationed by.
export function vertexChainagesM(vertices) {
    const chainages = [0];
    for (let index = 1; index < (vertices || []).length; index += 1) {
        const a = vertices[index - 1];
        const b = vertices[index];
        const dLatM = (b.lat - a.lat) * 111320;
        const dLngM = (b.lng - a.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180);
        chainages.push(chainages[index - 1] + Math.hypot(dLatM, dLngM));
    }
    return chainages;
}

// Linear interpolation of the solved profile (PVIs: { dM, elevAslM }) at a
// chainage, clamped to the profile's ends. Returns null when the profile is
// unusable — the caller then imports bare levels, exactly as before.
export function profileElevationAtM(pvis, dM) {
    const points = (Array.isArray(pvis) ? pvis : [])
        .map(pvi => ({ dM: Number(pvi?.dM), elevAslM: Number(pvi?.elevAslM) }))
        .filter(pvi => Number.isFinite(pvi.dM) && Number.isFinite(pvi.elevAslM))
        .sort((a, b) => a.dM - b.dM);
    if (points.length === 0 || !Number.isFinite(Number(dM))) return null;
    const at = Number(dM);
    if (at <= points[0].dM) return points[0].elevAslM;
    for (let index = 1; index < points.length; index += 1) {
        if (at <= points[index].dM) {
            const a = points[index - 1];
            const b = points[index];
            const span = b.dM - a.dM;
            const t = span > 1e-9 ? (at - a.dM) / span : 0;
            return a.elevAslM + (b.elevAslM - a.elevAslM) * t;
        }
    }
    return points[points.length - 1].elevAslM;
}

// Stamp each vertex with the authored absolute height at its chainage. MUST
// run on the FULL track, before any municipality clipping — a clipped window
// starts its own chainage at zero and would sample the wrong stretch of the
// profile. Without a usable profile the vertices come back untouched.
export function attachAuthoredElevations(vertices, track) {
    const pvis = track?.verticalProfile?.pvis;
    if (!Array.isArray(vertices) || vertices.length === 0) return vertices;
    const chainages = vertexChainagesM(vertices);
    const elevations = chainages.map(dM => profileElevationAtM(pvis, dM));
    if (elevations.some(elevation => elevation === null)) return vertices;
    return vertices.map((vertex, index) => ({ ...vertex, elevationM: elevations[index] }));
}

// Cut the centreline to the requested cadastral municipalities. Returned as runs so a line that
// leaves the window and returns does not silently become a straight line across the gap.
async function clipToMunicipalities(pool, vertices, koList) {
    if (!koList || !koList.length) return [vertices];
    const inside = [];
    for (const vertex of vertices) {
        const { rows } = await pool.query(
            `SELECT EXISTS (
               SELECT 1 FROM public.parcel
               WHERE current = true AND maticni_broj_ko = ANY($1::int[])
                 AND geom && ST_Transform(ST_SetSRID(ST_MakePoint($2, $3), 4326), 3765)
                 AND ST_Intersects(geom, ST_Transform(ST_SetSRID(ST_MakePoint($2, $3), 4326), 3765))
             ) AS hit`, [koList, vertex.lng, vertex.lat]);
        inside.push(Boolean(rows[0]?.hit));
    }
    const runs = [];
    let current = [];
    vertices.forEach((vertex, index) => {
        if (inside[index]) { current.push(vertex); return; }
        if (current.length >= 2) runs.push(current);
        current = [];
    });
    if (current.length >= 2) runs.push(current);
    return runs;
}

// The authored record: the centreline with its levels, the width and the cross-section. Its land and
// declaration are the preparation's (preparedTransitRecord).
export function buildProposal({ project, track, trackIndex, spans, centreline, widthM, city, ko }) {
    const now = new Date().toISOString();
    // The window is part of the identity. Without it, importing one municipality of a line silently
    // REPLACED the whole-line import at the same id — including one already applied on the map.
    const window = (Array.isArray(ko) && ko.length) ? `-ko${[...ko].sort((a, b) => a - b).join('_')}` : '';
    const proposalId = `transit-project-${project.id}-track-${trackIndex + 1}${window}`;
    const summary = corridorLevels.summarizeLevels(centreline);

    // points AND segments carry the same one connected run: the graph shape the corridor editor
    // reads, and the flat shape older readers expect.
    const definition = {
        points: [centreline],
        segments: [centreline],
        width: widthM,
        profile: trackCrossSectionProfile(track, widthM),
        metadata: {
            mode: 'import',
            type: 'track',
            isTrack: true,
            isRoad: false,
            isCorridor: true,
            source: 'transit-project',
            levels: true,
            trackCount: trackCountOf(track),
            // Present only when every point carries elevationM: the sim's
            // proposal-track adapter requires the datum to trust absolute
            // heights, and a datum without heights would be a lie.
            ...(centreline.every(point => Number.isFinite(point.elevationM))
                ? { elevationDatum: 'EVRF2000' }
                : {})
        }
    };

    const provenance = {
        system: 'zagreb.lol/prijevoz',
        transitProjectId: project.id,
        projectHash: project.project_hash || null,
        author: project.author_name || null,
        importedAt: now,
        // A planner project keeps being edited; this proposal is a snapshot of that hash, not a
        // live view of it. Re-importing is a deliberate act, which is what the hash is here for.
        snapshot: true
    };

    return {
        proposalId,
        city: city || null,
        name: `${project.author_name || 'Transit project'} — track ${trackIndex + 1}`,
        title: `${project.author_name || 'Transit project'} — track ${trackIndex + 1}`,
        description: `Imported from transit project ${project.id}.`,
        author: project.author_name || 'prijevoz',
        type: 'road',
        goal: 'road-track',
        primaryType: 'Track',
        isCorridor: true,
        lifecycleStatus: 'Active',
        createdAt: now,
        updatedAt: now,
        acceptedParcelIds: [],
        roadProposal: {
            definition,
            mode: 'import',
            isCorridor: true
        },
        bounds: null,
        source: provenance,
        levelSummary: summary,
        spanCount: spans.length
    };
}

// The record as stored: the authored one with the preparation's land, construction frame, declaration
// (exactly the bound parcels) and reference — as a publication stores it, without the signature or the
// artifact, which goes to its own table — and the description stated from them.
export function preparedTransitRecord(draft, prepared) {
    const record = { ...draft, ...prepared.proposal };
    delete record.preparedArtifact;
    record.preparation = { id: prepared.preparationId, digest: prepared.digest, preparedAt: prepared.preparedAt };
    const definition = record.roadProposal.definition;
    const binding = prepared.artifact.binding;
    const summary = draft.levelSummary;
    record.geometry = definition.polygon;
    record.description = `Imported from transit project ${draft.source.transitProjectId}. `
        + `${((binding.siteM2 || 0) / 10000).toFixed(2)} ha of corridor over ${record.cadastreParcelIds.length} parcels, `
        + `width ${definition.width} m. Edges: ${summary.surface} surface, ${summary.ramp} ramp, `
        + `${summary.elevated} elevated, ${summary.underground} underground (which take no surface).`;
    return record;
}

async function upsertProposal(pool, proposal) {
    // Unqualified on purpose: the proposal table lives in `public` locally and
    // in `consensus` on production; the connection's search_path resolves it
    // exactly as it does for the backend itself.
    const { rows } = await pool.query(
        `INSERT INTO proposal (
            proposal_id, city, name, title, description, author, type,
            lifecycle_status, created_at, updated_at,
            ancestor_parcel_ids, cadastre_parcel_ids, road_proposal, proposal_data, applied
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,false)
         ON CONFLICT (proposal_id) DO UPDATE SET
            city = EXCLUDED.city, name = EXCLUDED.name, title = EXCLUDED.title,
            description = EXCLUDED.description, author = EXCLUDED.author, type = EXCLUDED.type,
            lifecycle_status = EXCLUDED.lifecycle_status, updated_at = NOW(),
            ancestor_parcel_ids = EXCLUDED.ancestor_parcel_ids,
            cadastre_parcel_ids = EXCLUDED.cadastre_parcel_ids,
            road_proposal = EXCLUDED.road_proposal,
            proposal_data = EXCLUDED.proposal_data,
            applied = false
         RETURNING id, proposal_id`,
        [proposal.proposalId, proposal.city, proposal.name, proposal.title, proposal.description,
            proposal.author, proposal.type, proposal.lifecycleStatus, proposal.createdAt,
            null, JSON.stringify(proposal.cadastreParcelIds),
            JSON.stringify(proposal.roadProposal), JSON.stringify(proposal)]);
    return rows[0];
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !Number.isFinite(args.project)) { usage(); return; }

    assertLocalDatabase();
    const pool = new Pool();
    try {
        const project = await readProject(pool, args.project);
        const tracks = tracksOf(project.project_data);
        console.log(`transit_project ${project.id} — ${project.author_name}, `
            + `${project.total_length_km} km, ${tracks.length} track(s)`);

        for (const [trackIndex, track] of tracks.entries()) {
            const widthM = widthForTrack(track, args.width);
            const vertices = attachAuthoredElevations(
                corridorLevels.verticesFromTrack(track),
                track,
            );
            const windows = await clipToMunicipalities(pool, vertices, args.ko);

            if (windows.length > 1) {
                console.log(`  track ${trackIndex + 1}: the window splits it into ${windows.length} `
                    + 'separate runs; importing the longest only (re-run per municipality for the rest)');
            }
            const centreline = windows.sort((a, b) => b.length - a.length)[0] || [];
            if (centreline.length < 2) { console.log(`  track ${trackIndex + 1}: nothing inside the window`); continue; }

            const spans = corridorLevels.acquiringSpans(centreline);
            const summary = corridorLevels.summarizeLevels(centreline);
            if (!spans.length) { console.log(`  track ${trackIndex + 1}: no acquiring span`); continue; }

            const draft = buildProposal({ project, track, trackIndex, spans, centreline, widthM, city: args.city, ko: args.ko });
            // One transaction per track: the preparation's artifact and the row commit together,
            // and a dry run leaves neither behind.
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const prepared = await prepareProposal(client, draft, { city: args.city || null });
                const proposal = preparedTransitRecord(draft, prepared);
                const binding = prepared.artifact.binding;
                console.log(JSON.stringify({
                    proposalId: proposal.proposalId,
                    city: proposal.city,
                    preparation: prepared.preparationId,
                    vertices: centreline.length,
                    widthM,
                    edges: summary,
                    acquiringSpans: spans.length,
                    corridorHa: Number(((binding.siteM2 || 0) / 10000).toFixed(2)),
                    parcels: proposal.cadastreParcelIds.length,
                    takenM2: Number((binding.parcels || []).reduce((sum, hit) => sum + (hit.overlapM2 || 0), 0).toFixed(0)),
                    coverage: binding.coverage
                }, null, 2));
                if (args.apply) {
                    await storePreparedArtifact(client, prepared);
                    const stored = await upsertProposal(client, proposal);
                    await client.query('COMMIT');
                    console.log(`  stored proposal row ${stored.id} (${stored.proposal_id})`);
                } else {
                    await client.query('ROLLBACK');
                }
            } catch (error) {
                await client.query('ROLLBACK').catch(() => {});
                throw error;
            } finally {
                client.release();
            }
        }
        if (!args.apply) console.log('Dry run only; nothing was written.');
    } finally {
        await pool.end();
    }
}

const invokedDirectly = process.argv[1]
    && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`));
if (invokedDirectly) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
