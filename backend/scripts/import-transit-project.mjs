// Imports a track drawn in the transit planner (zagreb.lol/prijevoz) into consensus-builder as a
// track proposal, so its land take can be planned against the cadastre.
//
// The planner already stores a RELATIVE level (-1 / 0 / +1, fractional on ramps) per centreline
// vertex, so nothing here converts elevations and consensus-builder needs no terrain model: the
// absolute profile stays in the planner, where the DEM is. Fully underground stretches are cut out
// of the acquisition footprint and out of nothing else — the centreline stays whole, so a
// part-tunnelled line remains ONE proposal under the one-contiguous-stretch ruling of 2026-08-07.
//
// The footprint is buffered in EPSG:3765 (metres) rather than by the browser, and stored on the
// definition, which consensus-builder treats as authoritative.
//
// Dry-run by default:
//   node backend/scripts/import-transit-project.mjs --project 141
//   node backend/scripts/import-transit-project.mjs --project 141 --width 12 --apply
//   node backend/scripts/import-transit-project.mjs --project 141 --ko 335533,335541 --apply

import dotenv from 'dotenv';
import pg from 'pg';
import { fileURLToPath } from 'node:url';

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

export function widthForTrack(track, override) {
    if (Number.isFinite(override) && override > 0) return override;
    const count = Number(track && track.trackCount);
    return WIDTH_PER_TRACK_M * (Number.isFinite(count) && count > 0 ? count : 1);
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

// Buffer the acquiring spans in metres and union them. Underground spans are simply absent, so the
// footprint gets a gap where the line is in tunnel and no boolean subtraction is needed.
async function buildFootprint(pool, spans, widthM) {
    if (!spans.length) return null;
    const lines = spans.map(span => span.map(point => [point.lng, point.lat]));
    const { rows } = await pool.query(
        `WITH spans AS (
           SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(value::text), 4326), 3765) AS g
           FROM jsonb_array_elements($1::jsonb) AS value
         )
         SELECT ST_AsGeoJSON(ST_Transform(ST_Union(ST_Buffer(g, $2 / 2.0, 'endcap=flat join=round')), 4326))::json AS geometry,
                ST_Area(ST_Union(ST_Buffer(g, $2 / 2.0, 'endcap=flat join=round')))::double precision AS area_m2
         FROM spans`,
        [JSON.stringify(lines.map(coordinates => ({ type: 'LineString', coordinates }))), widthM]);
    const row = rows[0];
    if (!row || !row.geometry) return null;
    return { geometry: row.geometry, areaM2: Number(row.area_m2) };
}

async function parcelsUnder(pool, footprintGeoJSON) {
    const { rows } = await pool.query(
        `WITH f AS (
           SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1::text), 4326), 3765) AS g
         )
         SELECT p.cestica_id, p.maticni_broj_ko, p.broj_cestice,
                ST_Area(ST_Intersection(p.geom, f.g))::double precision AS taken_m2,
                ST_Area(p.geom)::double precision AS parcel_m2
         FROM public.parcel p, f
         WHERE p.current = true AND p.geom && f.g AND ST_Intersects(p.geom, f.g)
         ORDER BY 4 DESC`, [JSON.stringify(footprintGeoJSON)]);
    return rows.map(row => ({
        id: `HR-${row.maticni_broj_ko}-${row.broj_cestice}`,
        cesticaId: row.cestica_id,
        ko: row.maticni_broj_ko,
        broj: row.broj_cestice,
        takenM2: Number(row.taken_m2),
        parcelM2: Number(row.parcel_m2)
    }));
}

export function buildProposal({ project, track, trackIndex, spans, centreline, footprint, parcels, widthM, city, ko }) {
    const now = new Date().toISOString();
    // The window is part of the identity. Without it, importing one municipality of a line silently
    // REPLACED the whole-line import at the same id — including one already applied on the map.
    const window = (Array.isArray(ko) && ko.length) ? `-ko${[...ko].sort((a, b) => a - b).join('_')}` : '';
    const proposalId = `transit-project-${project.id}-track-${trackIndex + 1}${window}`;
    const parcelIds = parcels.map(parcel => parcel.id);
    const summary = corridorLevels.summarizeLevels(centreline);

    // points AND segments carry the same one connected run: the graph shape the corridor editor
    // reads, and the flat shape older readers expect.
    const definition = {
        points: [centreline],
        segments: [centreline],
        width: widthM,
        polygon: footprint.geometry,
        metadata: {
            mode: 'import',
            type: 'track',
            isTrack: true,
            isRoad: false,
            isCorridor: true,
            source: 'transit-project',
            levels: true
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
        description: `Imported from transit project ${project.id}. `
            + `${(footprint.areaM2 / 10000).toFixed(2)} ha of corridor over ${parcels.length} parcels, `
            + `width ${widthM} m. Edges: ${summary.surface} surface, ${summary.ramp} ramp, `
            + `${summary.elevated} elevated, ${summary.underground} underground (which take no surface).`,
        author: project.author_name || 'prijevoz',
        type: 'road',
        goal: 'road-track',
        primaryType: 'Track',
        isCorridor: true,
        lifecycleStatus: 'Active',
        createdAt: now,
        updatedAt: now,
        parentParcelIds: parcelIds,
        cadastreParcelIds: parcelIds,
        parcelIds,
        acceptedParcelIds: [],
        roadProposal: {
            definition,
            parentParcelIds: parcelIds.slice(),
            childParcelIds: [],
            mode: 'import',
            isCorridor: true
        },
        geometry: footprint.geometry,
        bounds: null,
        source: provenance,
        levelSummary: summary,
        spanCount: spans.length
    };
}

async function upsertProposal(pool, proposal) {
    const { rows } = await pool.query(
        `INSERT INTO public.proposal (
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
            JSON.stringify(proposal.parentParcelIds), JSON.stringify(proposal.cadastreParcelIds),
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
            const vertices = corridorLevels.verticesFromTrack(track);
            const windows = await clipToMunicipalities(pool, vertices, args.ko);

            if (windows.length > 1) {
                console.log(`  track ${trackIndex + 1}: the window splits it into ${windows.length} `
                    + 'separate runs; importing the longest only (re-run per municipality for the rest)');
            }
            const centreline = windows.sort((a, b) => b.length - a.length)[0] || [];
            if (centreline.length < 2) { console.log(`  track ${trackIndex + 1}: nothing inside the window`); continue; }

            const spans = corridorLevels.acquiringSpans(centreline);
            const summary = corridorLevels.summarizeLevels(centreline);
            const footprint = await buildFootprint(pool, spans, widthM);
            if (!footprint) { console.log(`  track ${trackIndex + 1}: no acquiring span`); continue; }
            const parcels = await parcelsUnder(pool, footprint.geometry);

            const proposal = buildProposal({
                project, track, trackIndex, spans, centreline, footprint, parcels, widthM,
                city: args.city, ko: args.ko
            });
            console.log(JSON.stringify({
                proposalId: proposal.proposalId,
                vertices: centreline.length,
                widthM,
                edges: summary,
                acquiringSpans: spans.length,
                corridorHa: Number((footprint.areaM2 / 10000).toFixed(2)),
                parcels: parcels.length,
                takenM2: Number(parcels.reduce((sum, parcel) => sum + parcel.takenM2, 0).toFixed(0)),
                wholeParcelsTaken: parcels.filter(parcel => parcel.takenM2 >= parcel.parcelM2 - 0.5).length
            }, null, 2));

            if (args.apply) {
                const stored = await upsertProposal(pool, proposal);
                console.log(`  stored proposal row ${stored.id} (${stored.proposal_id})`);
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
