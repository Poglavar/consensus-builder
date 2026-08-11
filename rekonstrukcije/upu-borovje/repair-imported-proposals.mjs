#!/usr/bin/env node
// One-off repair of the imported UPU Borovje plan (rows 633-651 + the split road 699).
//
// The plan itself is authored correctly — measured, not assumed: its 38 readjustment plots are a
// perfect partition (sum = union = 103,150 m², zero overlap), they tessellate the 29 declared input
// parcels exactly, every building sits 100% inside exactly one plot, and every park fills its plot
// to 100.0%. Two things came out of the ArcGIS extraction wrong, and both are repaired here.
//
// 1. ANCHORS. Every member declares the same single parent, HR-335550-1791/25 — and 13 of the 19
//    never touch it (M1-11 is 100% inside 1791/69, a parcel twenty times the size). Declared
//    parents are the ground the replay fetches and the ancestry the app reasons about, so they are
//    rewritten to the cadastral parcels each footprint actually covers.
//
// 2. CORRIDOR WIDTH. The record carries per-segment profiles, and two of the six segments are a
//    single 9 m sidewalk (upu-pjesacka-sjever/-jug) while the collector is 19 m. A corridor built
//    at the record's uniform 19 m therefore wrapped a 9 m footpath in a 19 m parcel, half of it
//    empty — and being cut. The corridor is rebuilt the way the app builds it
//    (buildRoadUnionPolygonForDefinition → per-segment profile width), then clipped to the plan's
//    pool so it stops at the plan boundary instead of spilling 84 m² onto 14 parcels the plan
//    never pooled. Both roads stay ONE connected piece, which the script verifies before writing.
//
// 3. NAMING. The plan is a re-parcellation, not a komasacija — no land was pooled and
//    redistributed between owners here — so "(urbana komasacija)" is struck from every title.
//
// 4. NOTHING STANDS ON THE STREET. A road, once placed, is a parcel, and no body may sit on it.
//    Where the corridor met a neighbour's BODY the neighbour yields: the park/square bodies are
//    clipped by the corridor, and one building — M1-9, a 602 m² block whose plot is 2,506 m² — is
//    TRANSLATED clear instead of being notched, because a building with a bite out of it is not a
//    building.
//
//    What is NOT touched is the readjustment's plots. A readjustment MINTS the ground; the road
//    stands on it and consumes what it needs at apply time. That is the vertical stack, not an
//    overlap, and pre-clipping the plots to "tessellate" them with the street broke the one thing
//    the plan must satisfy — covering every input parcel whole — so the readjustment refused and
//    the road, with no plots under it, refused after it. The plots stay as authored.
//
// Clipping is written to roadProposal.definition.polygon, which is the authoritative cut geometry
// ("the resolver and the parcel cut consume via footprintOf → definition.polygon", apply/road.js)
// and exactly the field the §15b amend pass writes when a taker clips a road. The centerline,
// width and profile are untouched, so the drawn street stays where the UPU put it.
//
// A row stores its sub-records TWICE: in proposal_data and in the mirror columns (road_proposal,
// building_proposal, structure_proposal, reparcellization, ancestor_parcel_ids,
// cadastre_parcel_ids). The API's serializer prefers the COLUMN — `choose(row.road_proposal,
// proposal.roadProposal)` — so writing proposal_data alone changes nothing the app can see. This
// script reads column-first, exactly as the serializer does, and writes both.
//
// Idempotent: re-running finds the anchors already correct and the corridor already clipped, and
// writes nothing. Dry-run by default.
//
//   node rekonstrukcije/upu-borovje/repair-imported-proposals.mjs
//   node rekonstrukcije/upu-borovje/repair-imported-proposals.mjs --apply

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const require = createRequire(path.join(repoRoot, 'backend', 'package.json'));
const pkg = require('pg');
require('dotenv').config({ path: path.join(repoRoot, 'backend', '.env') });
const { Pool } = pkg;

const READJUSTMENT_ID = 633;          // the plan's ground: 38 plots, a perfect partition
const MEMBER_IDS = [634, 635, 636, 637, 638, 639, 640, 641, 642, 643, 644, 645, 646, 647, 648, 649, 650];
const ROAD_IDS = [651, 699];          // the street network, split into two connected stretches
const ALL_IDS = [READJUSTMENT_ID, ...MEMBER_IDS, ...ROAD_IDS];

// Same floor as plan-order.js: below this an intersection is shared-border noise, not a claim.
const MIN_INTERSECTION_M2 = 0.25;
// Coordinates are written at full precision. Rounding a cut result is what manufactured the
// sliver overlaps this codebase spent a session chasing; do not reintroduce it here.
const GEOJSON_DIGITS = 15;
// A plot the corridor covers at least this much of IS street land: the road takes it whole rather
// than leaving a verge sliver on either side of itself.
// A take smaller than this — in area AND as a share of the plot — is a graze, not a taking. Too
// little to mint a remainder from, so the cut cannot conserve the parcel and the road refuses.
// A plot the street bands cover at least this much of WAS street land, and the bands replace it.
const STREET_PLOT_SHARE = 0.5;
const MIN_REAL_TAKE_M2 = 25;
const MIN_REAL_TAKE_SHARE = 0.05;
// (A park that stopped short of the street used to be nudged out to meet it. Seating it on its
// readjustment parcel does that by construction — the plots tile — so the nudge is gone.)
// How far a building's surrounding parcel may reach from its walls before the land stops being
// curtilage and becomes open ground. It also stops earlier wherever it meets a street, a park or
// the next building's parcel — those boundaries win over the margin.
const CURTILAGE_MARGIN_M = 16;
// Boundary sampling for the nearest-building partition: a vertex every this many metres makes the
// point-Voronoi a good stand-in for a true polygon-Voronoi.
const SEED_SPACING_M = 2;
// Marks a plot list this script rebuilt, so the restore step does not mistake it for the earlier
// over-repair and put the authored plots back.
const REPARCEL_MARK = 'repair-upu-borovje/curtilage';
// Below this an offcut is not a parcel; it joins the building parcel it abuts.
const MIN_OPEN_PARCEL_M2 = 150;
// Unioning the corridor with the plots it swallowed can leave a pinhole where their edges very
// nearly meet. A hole this size is debris, not a courtyard, and a road parcel with a 0.9 m² void
// in it is the kind of thing that surfaces two months later as an unexplained refusal.
const MIN_REAL_HOLE_M2 = 5;

const SUB_KEYS = ['roadProposal', 'buildingProposal', 'structureProposal', 'reparcellization', 'decideLaterProposal'];

function usage() {
    console.log([
        'Repair the imported UPU Borovje plan: honest anchors, and a street corridor that stops',
        'at the plan boundary and off its siblings.',
        '',
        '  --apply              Write the changes. Without this the script only reports.',
        '  --rebuild-corridors  Derive each road parcel again instead of keeping the stored one.',
        '  --reparcel           Rebuild the plots: one surrounding parcel per building, grown to',
        '                       its neighbours, plus the parks, the streets and what is left over.',
        '  --restore-authored   Put the authored plot list back, undoing --reparcel.',
        '  --street-plots       Re-cut the readjustment street plots as constant-width bands and',
        '                       seat each road inside its own, so the road cuts (almost) nothing.',
        '  --help    Show this message.'
    ].join('\n'));
}

const fmt = n => Math.round(Number(n) || 0).toLocaleString('en-US');
// Anchors are a SET. The app sorts them largest-share-first, the import sorted them by parcel
// number; re-ordering the same parcels is not a repair and must not make the script non-idempotent.
const sameSet = (a, b) => {
    const left = (Array.isArray(a) ? a : []).map(String).sort();
    const right = (Array.isArray(b) ? b : []).map(String).sort();
    return left.length === right.length && left.every((v, i) => v === right[i]);
};

// The centerline as GeoJSON, for the corridor the app derives at apply time.
function corridorCenterline(definition) {
    const groups = Array.isArray(definition && definition.points) ? definition.points : [];
    const lines = groups
        .map(group => (Array.isArray(group) ? group : [])
            .map(pt => (pt && Number.isFinite(pt.lng) && Number.isFinite(pt.lat)) ? [pt.lng, pt.lat] : null)
            .filter(Boolean))
        .filter(line => line.length >= 2);
    return lines.length ? { type: 'MultiLineString', coordinates: lines } : null;
}

// The corridor the APP builds: each stroke buffered at its OWN width, taken from that segment's
// profile strips (corridor-profile.js: corridorSegmentEntries → corridorProfileWidth), falling back
// to the record's uniform width only when a segment has no profile. Building it at the uniform
// width is what put a 19 m parcel around a 9 m footpath.
function corridorSegments(definition) {
    const ids = Array.isArray(definition && definition.segmentIds) ? definition.segmentIds : [];
    const profiles = (definition && definition.segmentProfiles) || {};
    const fallback = Number(definition && definition.width) || 10;
    const groups = Array.isArray(definition && definition.points) ? definition.points : [];
    return groups
        .map((group, index) => {
            const coordinates = (Array.isArray(group) ? group : [])
                .map(pt => (pt && Number.isFinite(pt.lng) && Number.isFinite(pt.lat)) ? [pt.lng, pt.lat] : null)
                .filter(Boolean);
            if (coordinates.length < 2) return null;
            const strips = profiles[ids[index]] && Array.isArray(profiles[ids[index]].strips)
                ? profiles[ids[index]].strips : [];
            const width = strips.length
                ? strips.reduce((sum, strip) => sum + (Number(strip && strip.width) || 0), 0)
                : fallback;
            return { line: { type: 'LineString', coordinates }, width: width > 0 ? width : fallback };
        })
        .filter(Boolean);
}

function footprintGeometries(data) {
    const out = [];
    const push = value => {
        if (!value) return;
        const geometry = value.type === 'Feature' ? value.geometry : value;
        if (geometry && /Polygon/.test(String(geometry.type || ''))) out.push(geometry);
    };
    if (data.reparcellization && Array.isArray(data.reparcellization.polygons)) {
        data.reparcellization.polygons.forEach(slice => push(slice && slice.geometry));
    }
    const definition = data.roadProposal && data.roadProposal.definition;
    if (definition && definition.polygon) push(definition.polygon);
    if (data.structureProposal && data.structureProposal.geometry) push(data.structureProposal.geometry);
    if (data.geometry && /Polygon/.test(String(data.geometry.type || ''))) push(data.geometry);
    if (data.buildingGeometry) push(data.buildingGeometry);
    if (data.geometry && Array.isArray(data.geometry.buildings)) data.geometry.buildings.forEach(push);
    return out;
}

async function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--help')) { usage(); process.exit(0); }
    const apply = argv.includes('--apply');
    // A stored parcel is normally left alone (it is what the road holds). This forces it to be
    // derived again — for when the stored one is the thing that is wrong.
    const rebuildCorridors = argv.includes('--rebuild-corridors');
    // Rewrites the plan's plot list: one surrounding parcel per building, grown to its neighbours.
    const reparcel = argv.includes('--reparcel');
    // Puts the authored plot list back, undoing --reparcel.
    const restoreAuthored = argv.includes('--restore-authored');
    // Re-cuts the readjustment's STREET plots as constant-width bands around the centrelines, so a
    // road can sit inside its parcel instead of carving an irregular one.
    const streetPlots = argv.includes('--street-plots');

    const pool = new Pool();
    const client = await pool.connect();
    console.log(`database: ${process.env.PGDATABASE || 'geodata'}   mode: ${apply ? 'APPLY' : 'DRY RUN'}\n`);

    let restored = false;
    let reparcelled = false;
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(`
            SELECT id, proposal_id, proposal_data, road_proposal, building_proposal, structure_proposal,
                   reparcellization, ancestor_parcel_ids, cadastre_parcel_ids
            FROM public.proposal WHERE id = ANY($1::int[]) ORDER BY id`, [ALL_IDS]);
        // The record as the APP sees it: column first, proposal_data second (proposals/serializer.js).
        rows.forEach(row => {
            const data = JSON.parse(JSON.stringify(row.proposal_data || {}));
            if (row.road_proposal) data.roadProposal = row.road_proposal;
            if (row.building_proposal) data.buildingProposal = row.building_proposal;
            if (row.structure_proposal) data.structureProposal = row.structure_proposal;
            if (row.reparcellization) data.reparcellization = row.reparcellization;
            if (row.ancestor_parcel_ids) data.parentParcelIds = row.ancestor_parcel_ids;
            if (row.cadastre_parcel_ids) data.cadastreParcelIds = row.cadastre_parcel_ids;
            row.effective = data;
        });
        const byId = new Map(rows.map(r => [r.id, r]));
        const missing = ALL_IDS.filter(id => !byId.has(id));
        if (missing.length) throw new Error(`rows not found: ${missing.join(', ')} — is this the right database?`);

        // The plan's own ground, and the bodies standing on it, as PostGIS geometry in 3765.
        // The plan's TOTAL ground: its plots plus whatever the streets already hold. Once a repair
        // has moved plot land into a road parcel, the plots alone are no longer the plan's extent —
        // taking them as the boundary would clip the street away on the next run.
        await client.query(`
            CREATE TEMP TABLE ground AS
            WITH plots AS (
                SELECT ST_Transform(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(p->'geometry'), 4326)), 3765) AS g
                FROM public.proposal, jsonb_array_elements(
                    COALESCE(reparcellization, proposal_data->'reparcellization')->'polygons') p
                WHERE id = $1
                UNION ALL
                SELECT ST_Transform(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(
                    COALESCE(road_proposal, proposal_data->'roadProposal')->'definition'->'polygon'), 4326)), 3765)
                FROM public.proposal
                WHERE id = ANY($2::int[])
                  AND jsonb_typeof(COALESCE(road_proposal, proposal_data->'roadProposal')->'definition'->'polygon') = 'object')
            SELECT ST_UnaryUnion(ST_Collect(g)) AS pool FROM plots`, [READJUSTMENT_ID, ROAD_IDS]);
        await client.query(`
            CREATE TEMP TABLE bodies AS
            SELECT ST_UnaryUnion(ST_Collect(ST_Transform(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(
                       COALESCE(proposal_data->'structureProposal'->'geometry',
                                proposal_data->'geometry'->'buildings'->0->'geometry')), 4326)), 3765))) AS g
            FROM public.proposal WHERE id = ANY($1::int[])`, [MEMBER_IDS]);

        // --- 0. naming ---------------------------------------------------------------------
        // "urbana komasacija" describes pooling and redistributing land between owners, which is
        // not what this plan does. Struck from the title and name, in the payload and in the
        // columns the API prefers.
        const renameWrites = [];
        {
            const strike = value => (typeof value === 'string')
                ? value.replace(/\s*\((?:urbana\s+)?komasacija\)/gi, '').replace(/\s{2,}/g, ' ').trim()
                : value;
            for (const row of rows) {
                const data = row.effective;
                const title = strike(data.title);
                const name = strike(data.name);
                if (title === data.title && name === data.name) continue;
                console.log(`NAMING\n  #${row.id} "${data.title}" -> "${title}"`);
                data.title = title;
                data.name = name;
                renameWrites.push({ id: row.id, title, name });
            }
        }

        // --- 0. undo an earlier over-repair -------------------------------------------------
        // A previous pass clipped the plan's plots by the street and stamped the record as amended.
        // Both are reverted from the pre-repair backup: the plan must cover its input parcels
        // whole, or the whole-parcel gate refuses it and nothing downstream has ground to stand on.
        {
            const planRecord = byId.get(READJUSTMENT_ID).effective;
            const plots = (planRecord.reparcellization && planRecord.reparcellization.polygons) || [];
            const { rows: [backup] } = await client.query(
                'SELECT reparcellization, backed_up_at FROM public.proposal_reparcellization_backup WHERE id = $1', [READJUSTMENT_ID]);
            const authored = backup && backup.reparcellization && Array.isArray(backup.reparcellization.polygons)
                ? backup.reparcellization.polygons : null;
            const rebuilt = planRecord.reparcellization && planRecord.reparcellization.rebuiltBy === REPARCEL_MARK;
            if (authored && (restoreAuthored || (!rebuilt && (plots.length !== authored.length || planRecord.amendedByTaking === true)))) {
                console.log(`RESTORE\n  #${READJUSTMENT_ID} ${plots.length} plot(s) -> ${authored.length} as authored `
                    + `(backup of ${new Date(backup.backed_up_at).toISOString().slice(0, 10)}); amended stamp dropped`);
                planRecord.reparcellization = { ...planRecord.reparcellization, polygons: JSON.parse(JSON.stringify(authored)) };
                delete planRecord.reparcellization.rebuiltBy;
                delete planRecord.amendedByTaking;
                restored = true;
                // The corridors were merged with plots that are no longer theirs to hold; they are
                // rebuilt from the centerline below.
                ROAD_IDS.forEach(id => {
                    const definition = byId.get(id).effective.roadProposal.definition;
                    if (definition) definition.polygon = null;
                });
            }
        }

        // Read at call time: the street plots are re-cut mid-run, and a park must be seated on the
        // parcel that exists AFTER that, not the one that existed before.
        const currentPlots = () => ((byId.get(READJUSTMENT_ID).effective.reparcellization || {}).polygons || [])
            .filter(slice => slice && slice.geometry);

        // --- 1. corridors: the app's own per-segment width, then stop at the plan boundary ---
        console.log('\nCORRIDORS');
        const roadWrites = [];
        const corridorGeoms = [];
        for (const id of ROAD_IDS) {
            const row = byId.get(id);
            const data = row.effective;
            const definition = data.roadProposal && data.roadProposal.definition;
            const segments = definition ? corridorSegments(definition) : [];
            if (!segments.length) { console.log(`  #${id} no centerline — skipped`); continue; }
            // The parcel is the road. Once one is stored it is what the road holds — shaped by this
            // repair, by an amendment, or by hand — and rebuilding it from the centerline would
            // undo that, which is the same leak the apply path had. Only a road with no parcel yet
            // gets one derived here, so running this twice is a no-op instead of a demolition.
            if (rebuildCorridors) definition.polygon = null;
            if (definition.polygon && typeof definition.polygon === 'object') {
                // Only debris is removed: a pinhole left where the corridor and a plot it absorbed
                // very nearly met is not a courtyard, and a void inside a road parcel resurfaces
                // later as an unexplained refusal.
                const { rows: [tidy] } = await client.query(`
                    WITH g AS (SELECT ST_Transform(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($1)::geometry, 4326)), 3765) AS g),
                    -- one row ALWAYS, or the CROSS JOIN below yields nothing and the caller reads
                    -- a field off undefined. A MultiPolygon simply has no rings to weigh.
                    keep AS (SELECT CASE WHEN GeometryType(g.g) = 'POLYGON'
                                         THEN ARRAY(SELECT ST_InteriorRingN(g.g, i)
                                                    FROM generate_series(1, GREATEST(ST_NumInteriorRings(g.g), 0)) i
                                                    WHERE ST_Area(ST_MakePolygon(ST_InteriorRingN(g.g, i))) >= $3)
                                         ELSE NULL END AS rings
                             FROM g),
                    -- ST_MakePolygon is strict: passing a NULL/empty ring array yields NULL, which
                    -- silently read as "nothing to fill". Drop to the single-argument form instead.
                    filled AS (SELECT CASE
                            WHEN GeometryType(g.g) <> 'POLYGON' OR ST_NumInteriorRings(g.g) = 0 THEN g.g
                            WHEN COALESCE(cardinality(keep.rings), 0) = 0 THEN ST_MakePolygon(ST_ExteriorRing(g.g))
                            ELSE ST_MakePolygon(ST_ExteriorRing(g.g), keep.rings)
                        END AS g FROM g, keep)
                    SELECT round((ST_Area(COALESCE(filled.g, g.g)) - ST_Area(g.g))::numeric, 2) AS filled_m2,
                           ST_AsGeoJSON(ST_Transform(COALESCE(filled.g, g.g), 4326), $2) AS geojson
                    FROM g, filled`, [JSON.stringify(definition.polygon), GEOJSON_DIGITS, MIN_REAL_HOLE_M2]);
                if (Number(tidy.filled_m2) > 0.01) {
                    const geometry = JSON.parse(tidy.geojson);
                    definition.polygon = geometry;
                    corridorGeoms.push(geometry);
                    roadWrites.push({ id, geometry });
                    console.log(`  #${id} already holds a parcel — ${tidy.filled_m2} m² of pinhole void filled`);
                } else {
                    corridorGeoms.push(definition.polygon);
                    console.log(`  #${id} already holds a parcel — left as it is`);
                }
                continue;
            }

            const { rows: [built] } = await client.query(`
                WITH seg AS (
                    SELECT ST_Buffer(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(p->'line')::geometry, 4326), 3765),
                                     (p->>'width')::float8 / 2, 'endcap=flat join=mitre') AS g
                    FROM jsonb_array_elements($1::jsonb) p),
                corridor AS (SELECT ST_UnaryUnion(ST_Collect(g)) AS g FROM seg),
                -- ST_Intersection returns a GeometryCollection wherever the two outlines merely
                -- touch: polygons PLUS the stray lines and points of the contact. Stored as-is that
                -- is not a footprint any consumer can read — the app resolved 0% of it. Keep the
                -- polygonal parts only, and drop sub-1 m² specks.
                pieces AS (SELECT (ST_Dump(ST_CollectionExtract(ST_Intersection(corridor.g, ground.pool), 3))).geom AS g
                           FROM corridor, ground),
                inpool AS (SELECT ST_UnaryUnion(ST_Collect(g)) AS g FROM pieces WHERE ST_Area(g) > 1),
                -- No nibble rule any more: the readjustment cuts the street plots to this very
                -- band (--street-plots), so the road adopts its parcel instead of grazing its
                -- neighbours, and the band keeps the constant width its profile describes.
                clipped AS (SELECT ST_UnaryUnion(ST_Collect(d.geom)) AS g
                            FROM (SELECT (ST_Dump(ST_CollectionExtract(inpool.g, 3))).geom AS geom FROM inpool) d
                            WHERE ST_Area(d.geom) > 1),
                parts AS (SELECT (ST_Dump(clipped.g)).geom AS g FROM clipped)
                SELECT round(ST_Area(corridor.g)::numeric, 0) AS built_m2,
                       round(ST_Area(clipped.g)::numeric, 0) AS after_m2,
                       round(ST_Area(ST_Difference(corridor.g, ground.pool))::numeric, 1) AS outside_pool_m2,
                       (SELECT count(*) FROM parts WHERE ST_Area(g) > 1) AS parts_over_1m2,
                       ST_AsGeoJSON(ST_Transform(clipped.g, 4326), $2) AS geojson
                FROM corridor, clipped, ground`,
            [JSON.stringify(segments), GEOJSON_DIGITS]);

            // A corridor is one road. Refuse rather than write a severed street.
            if (Number(built.parts_over_1m2) !== 1) {
                throw new Error(`#${id}: the corridor comes out in ${built.parts_over_1m2} pieces — not written`);
            }
            const geometry = JSON.parse(built.geojson);
            const widths = segments.map(seg => `${seg.width}m`).join('/');
            const changed = JSON.stringify(definition.polygon || null) !== JSON.stringify(geometry);
            console.log(`  #${id} widths ${widths} -> ${fmt(built.after_m2)} m²` +
                `${Number(built.outside_pool_m2) >= MIN_INTERSECTION_M2 ? `  (${built.outside_pool_m2} m² outside the plan dropped)` : ''}` +
                `${changed ? '' : '  (unchanged)'}`);
            // Seat it on the effective record: the neighbour clip and the anchor pass both read it.
            definition.polygon = geometry;
            corridorGeoms.push(geometry);
            if (changed) roadWrites.push({ id, geometry });
        }

        // --- 2. the readjustment's STREET plots become constant-width bands -----------------
        // The import drew the street land as irregular polygons of wandering width, so a road
        // placed inside one had to carve its own shape out of it — which is why the road parcel
        // came out ragged and stopped agreeing with the band that is drawn. The readjustment makes
        // ALL the parcels including the streets, so its street plots are re-cut as the corridor
        // itself: centreline × that segment's profile width. The road then ADOPTS its parcel and
        // cuts nothing (a bend may still shave a little, which is fine and stays small).
        // The verge those irregular plots used to hold does not vanish — every square metre goes to
        // the neighbouring plot it is NEAREST to, so the plan still tiles its input parcels whole.
        if (streetPlots) {
            console.log('\nSTREET PLOTS');
            const bands = ROAD_IDS
                .map(id => ({ id, geometry: (byId.get(id).effective.roadProposal.definition || {}).polygon }))
                .filter(entry => entry.geometry);
            const planRecord = byId.get(READJUSTMENT_ID).effective;
            const plots = planRecord.reparcellization.polygons;

            const { rows: rebuilt } = await client.query(`
                WITH band AS (SELECT (g->>'id')::int AS id,
                                     ST_Transform(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(g->'geometry')::geometry, 4326)), 3765) AS g
                              FROM jsonb_array_elements($1::jsonb) g),
                allband AS (SELECT ST_UnaryUnion(ST_Collect(g)) AS g FROM band),
                plot AS (SELECT ord, ST_Transform(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(g->'geometry')::geometry, 4326)), 3765) AS g
                         FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS t(g, ord)),
                -- a plot the bands mostly cover WAS street land; the bands replace it. Every other
                -- plot is kept exactly as authored — this recut is about the streets, and quietly
                -- redistributing everyone else's land would be a different plan.
                -- and where a street merely CROSSES a plot, the plot yields that strip — the road
                -- adjusts the readjustment, which is the whole point of doing the streets first.
                -- A plot a street cuts right through becomes two parcels, as a street through a
                -- block should.
                keep AS (SELECT plot.ord,
                                (ST_Dump(ST_CollectionExtract(ST_Difference(plot.g, allband.g), 3))).geom AS g
                         FROM plot, allband
                         WHERE ST_Area(ST_Intersection(plot.g, allband.g)) < $3::float8 * ST_Area(plot.g)),
                -- the verge the old irregular street plots held and the bands do not: its own
                -- parcels, so every square metre stays inside the plan
                verge AS (SELECT (ST_Dump(ST_CollectionExtract(
                             ST_Difference(ST_Difference(ground.pool, allband.g),
                                           (SELECT ST_UnaryUnion(ST_Collect(g)) FROM keep)), 3))).geom AS g
                          FROM ground, allband)
                SELECT ord, round(ST_Area(g)::numeric, 0) AS m2, 'plot'::text AS kind,
                       ST_AsGeoJSON(ST_Transform(g, 4326), $4) AS geojson FROM keep WHERE ST_Area(g) > 1
                UNION ALL
                SELECT -id, round(ST_Area(g)::numeric, 0), 'street', ST_AsGeoJSON(ST_Transform(g, 4326), $4) FROM band
                UNION ALL
                SELECT NULL, round(ST_Area(g)::numeric, 0), 'verge', ST_AsGeoJSON(ST_Transform(g, 4326), $4)
                FROM verge WHERE ST_Area(g) > 1
                ORDER BY 1 NULLS LAST`,
            [JSON.stringify(bands), JSON.stringify(plots), STREET_PLOT_SHARE, GEOJSON_DIGITS]);

            const streets = rebuilt.filter(row => row.kind === 'street');
            const kept = rebuilt.filter(row => row.kind === 'plot');
            const verge = rebuilt.filter(row => row.kind === 'verge');
            console.log(`  ${plots.length - kept.length} irregular street plot(s) replaced by ${streets.length} constant-width band(s)`
                + ` — ${streets.map(row => fmt(row.m2)).join(', ')} m²`);
            console.log(`  ${kept.length} plot(s) kept as authored; ${verge.length} verge parcel(s)`
                + ` — ${verge.map(row => fmt(row.m2)).join(', ')} m²`);

            const first = plots[0] || {};
            const carry = { ownerKey: first.ownerKey || null, displayName: first.displayName || null, color: first.color || null };
            planRecord.reparcellization = {
                ...planRecord.reparcellization,
                polygons: rebuilt.map(row => ({ ...carry, geometry: JSON.parse(row.geojson) })),
                rebuiltBy: REPARCEL_MARK
            };
            reparcelled = true;
        }

        // --- 3. neighbours: nothing stands on the street, and a park sits on its parcel -----
        console.log('\nTESSELLATION');
        const bodyWrites = [];
        if (corridorGeoms.length) {
            await client.query(`
                CREATE TEMP TABLE corridor AS
                SELECT ST_UnaryUnion(ST_Collect(ST_Transform(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(g)::geometry, 4326)), 3765))) AS g
                FROM jsonb_array_elements($1::jsonb) AS g`, [JSON.stringify(corridorGeoms)]);

            // 2a. a building is never notched — it is moved clear of the street, shape intact.
            for (const id of MEMBER_IDS) {
                const data = byId.get(id).effective;
                const buildings = data.geometry && Array.isArray(data.geometry.buildings) ? data.geometry.buildings : null;
                if (!buildings || !buildings.length) continue;
                const { rows: [hit] } = await client.query(`
                    WITH b AS (SELECT ST_UnaryUnion(ST_Collect(ST_Transform(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(g->'geometry')::geometry, 4326)), 3765))) AS g
                               FROM jsonb_array_elements($1::jsonb) AS g)
                    SELECT round(ST_Area(ST_Intersection(b.g, corridor.g))::numeric, 1) AS overlap_m2 FROM b, corridor`,
                [JSON.stringify(buildings)]);
                if (Number(hit.overlap_m2) < MIN_INTERSECTION_M2) continue;

                // Step away from the street along the axis from the corridor to the building,
                // half a metre at a time, until the overlap is gone. A metre of slack keeps the
                // next cut from re-touching it.
                const { rows: [move] } = await client.query(`
                    WITH b AS (SELECT ST_UnaryUnion(ST_Collect(ST_Transform(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(g->'geometry')::geometry, 4326)), 3765))) AS g
                               FROM jsonb_array_elements($1::jsonb) AS g),
                    axis AS (SELECT ST_X(ST_Centroid(b.g)) - ST_X(ST_ClosestPoint(corridor.g, ST_Centroid(b.g))) AS dx,
                                    ST_Y(ST_Centroid(b.g)) - ST_Y(ST_ClosestPoint(corridor.g, ST_Centroid(b.g))) AS dy
                             FROM b, corridor),
                    unit AS (SELECT dx / NULLIF(sqrt(dx*dx + dy*dy), 0) AS ux, dy / NULLIF(sqrt(dx*dx + dy*dy), 0) AS uy FROM axis),
                    steps AS (SELECT generate_series(1, 40) AS n),
                    tries AS (SELECT n, ST_Translate(b.g, unit.ux * n * 0.5, unit.uy * n * 0.5) AS g
                              FROM steps, b, unit),
                    ok AS (SELECT tries.n AS n, tries.g AS g FROM tries, corridor
                           WHERE ST_Area(ST_Intersection(tries.g, corridor.g)) < $2 ORDER BY n LIMIT 1)
                    SELECT ok.n * 0.5 AS moved_m,
                           ST_AsGeoJSON(ST_Transform(ok.g, 4326), $3) AS geojson,
                           (SELECT round(ST_Area(ST_Difference(ok.g, ground.pool))::numeric, 1) FROM ground) AS outside_pool_m2
                    FROM ok`, [JSON.stringify(buildings), MIN_INTERSECTION_M2, GEOJSON_DIGITS]);
                if (!move) throw new Error(`#${id}: no translation under 20 m clears the corridor — not written`);
                if (Number(move.outside_pool_m2) > 1) throw new Error(`#${id}: moving it clear pushes it outside the plan — not written`);
                console.log(`  #${id} building moved ${move.moved_m} m clear of the street (was ${hit.overlap_m2} m² under it)`);
                bodyWrites.push({ id, kind: 'buildings', geometry: JSON.parse(move.geojson) });
            }

            // A park does not carry an outline of its own — it TAKES the parcel the
            // readjustment made for it, minus whatever the street has already taken. Authored
            // separately, its edge lands a few centimetres off the plot's edge, so instead of
            // adopting that parcel it cuts a new one, and the drill then shows the park forming
            // ground directly off the cadastre with no readjustment in between.
            for (const id of MEMBER_IDS) {
                const data = byId.get(id).effective;
                const structure = data.structureProposal && data.structureProposal.geometry;
                if (!structure) continue;
                const { rows: [seat] } = await client.query(`
                    WITH body AS (SELECT ST_Transform(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($1)::geometry, 4326)), 3765) AS g),
                    plots AS (SELECT ST_Transform(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(q->'geometry')::geometry, 4326)), 3765) AS g
                              FROM jsonb_array_elements($2::jsonb) q),
                    -- the plot this body sits in: the one holding most of it
                    plot AS (SELECT plots.g FROM plots, body
                             WHERE ST_Area(ST_Intersection(plots.g, body.g)) > 0
                             ORDER BY ST_Area(ST_Intersection(plots.g, body.g)) DESC LIMIT 1),
                    seated AS (SELECT ST_CollectionExtract(ST_Difference(plot.g, corridor.g), 3) AS g FROM plot, corridor),
                    parts AS (SELECT (ST_Dump(seated.g)).geom AS g FROM seated)
                    SELECT round(ST_Area(body.g)::numeric, 0) AS body_m2,
                           round(ST_Area(seated.g)::numeric, 0) AS seated_m2,
                           round(ST_Area(ST_SymDifference(body.g, seated.g))::numeric, 1) AS moved_m2,
                           (SELECT count(*) FROM parts WHERE ST_Area(g) > 1) AS parts_over_1m2,
                           ST_AsGeoJSON(ST_Transform(seated.g, 4326), $3) AS geojson
                    FROM body, seated`,
                [JSON.stringify(currentPlots()), GEOJSON_DIGITS].length === 0 ? [] : [JSON.stringify(structure), JSON.stringify(currentPlots()), GEOJSON_DIGITS]);
                if (!seat || !seat.geojson) continue;
                if (Number(seat.moved_m2) < MIN_INTERSECTION_M2) continue;
                if (Number(seat.parts_over_1m2) !== 1) {
                    throw new Error(`#${id}: its plot minus the street comes out in ${seat.parts_over_1m2} pieces — not written`);
                }
                console.log(`  #${id} seated on its readjustment parcel: ${fmt(seat.body_m2)} -> ${fmt(seat.seated_m2)} m²`
                    + ` (${seat.moved_m2} m² of edge difference)`);
                data.structureProposal.geometry = JSON.parse(seat.geojson);
                bodyWrites.push({ id, kind: 'structure', geometry: data.structureProposal.geometry });
            }

            // 2b. area features (park, square, recreation) simply give up the strip the street
            // takes — their boundary becomes the street's boundary.
            for (const id of MEMBER_IDS) {
                const data = byId.get(id).effective;
                const structure = data.structureProposal && data.structureProposal.geometry;
                if (!structure) continue;
                const { rows: [clip] } = await client.query(`
                    WITH b AS (SELECT ST_Transform(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($1)::geometry, 4326)), 3765) AS g),
                    cut AS (SELECT ST_Difference(b.g, corridor.g) AS g FROM b, corridor),
                    parts AS (SELECT (ST_Dump(cut.g)).geom AS g FROM cut)
                    SELECT round(ST_Area(ST_Intersection(b.g, corridor.g))::numeric, 1) AS overlap_m2,
                           (SELECT count(*) FROM parts WHERE ST_Area(g) > 1) AS parts_over_1m2,
                           ST_AsGeoJSON(ST_Transform(cut.g, 4326), $2) AS geojson
                    FROM b, cut, corridor`, [JSON.stringify(structure), GEOJSON_DIGITS]);
                if (Number(clip.overlap_m2) < MIN_INTERSECTION_M2) continue;
                if (Number(clip.parts_over_1m2) !== 1) {
                    throw new Error(`#${id}: the street would split it into ${clip.parts_over_1m2} pieces — not written`);
                }
                console.log(`  #${id} yielded ${clip.overlap_m2} m² to the street`);
                bodyWrites.push({ id, kind: 'structure', geometry: JSON.parse(clip.geojson) });
            }

            if (!bodyWrites.length) console.log('  nothing stands on the street');
        }

        // Seat the neighbour changes on the effective records before the anchors are measured.
        bodyWrites.forEach(write => {
            const data = byId.get(write.id).effective;
            if (write.kind === 'structure') data.structureProposal.geometry = write.geometry;
            else {
                const first = data.geometry.buildings[0];
                data.geometry.buildings = [{ ...first, geometry: write.geometry }];
                if (data.buildingProposal && Array.isArray(data.buildingProposal.buildings) && data.buildingProposal.buildings.length) {
                    data.buildingProposal.buildings = [{ ...data.buildingProposal.buildings[0], geometry: write.geometry }];
                }
            }
        });

        // --- 2b. one surrounding parcel per building, grown to its neighbours ---------------
        // A real building sits on its own footprint inside a larger, roughly building-shaped
        // parcel that reaches a few metres past its walls and stops where a street, a park or the
        // next building's parcel begins. The import instead left one 17,383 m² leftover wrapping
        // around the parks. Every square metre of the plan that is not street and not park is
        // given to the building it is NEAREST to (a Voronoi partition over the footprint
        // boundaries, so the divide between two buildings is the midline between their walls),
        // capped at CURTILAGE_MARGIN_M from the walls. What lies beyond every margin stays open
        // ground — but cut by those same divides, so it can no longer be a single blob.
        if (reparcel) {
            console.log('\nREPARCELLATION');
            const buildings = MEMBER_IDS
                .map(id => ({ id, geometry: ((byId.get(id).effective.geometry || {}).buildings || [])[0] }))
                .filter(entry => entry.geometry && entry.geometry.geometry)
                .map(entry => ({ id: entry.id, geometry: entry.geometry.geometry }));
            const parks = MEMBER_IDS
                .map(id => ({ id, geometry: (byId.get(id).effective.structureProposal || {}).geometry }))
                .filter(entry => entry.geometry);
            const roads = ROAD_IDS
                .map(id => (byId.get(id).effective.roadProposal.definition || {}).polygon)
                .filter(Boolean);
            const planRecord = byId.get(READJUSTMENT_ID).effective;
            const authoredPlots = planRecord.reparcellization.polygons;

            await client.query(`
                CREATE TEMP TABLE fixture AS
                WITH road AS (SELECT COALESCE(ST_UnaryUnion(ST_Collect(ST_Transform(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(g)::geometry, 4326)), 3765))),
                                              ST_GeomFromText('POLYGON EMPTY', 3765)) AS g
                              FROM jsonb_array_elements($1::jsonb) g),
                park AS (SELECT COALESCE(ST_UnaryUnion(ST_Collect(ST_Transform(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(g->'geometry')::geometry, 4326)), 3765))),
                                         ST_GeomFromText('POLYGON EMPTY', 3765)) AS g
                         FROM jsonb_array_elements($2::jsonb) g)
                SELECT road.g AS road, park.g AS park,
                       ST_Difference(ST_Difference(ground.pool, road.g), park.g) AS free
                FROM road, park, ground`,
            [JSON.stringify(roads), JSON.stringify(parks)]);

            // Every square metre that is not street and not park belongs to the building it is
            // NEAREST to — a Voronoi partition over the footprint boundaries, so the divide between
            // two buildings is the midline between their walls. Inside its own share, a building
            // takes what lies within CURTILAGE_MARGIN_M of its walls as its surrounding parcel;
            // what lies beyond stays open ground, still bounded by those divides, so it can no
            // longer run around a park and join the land behind the next building. Both come out
            // of intersections and differences of overlapping shapes — never a union of two merely
            // touching ones, which leaves a hairline gap and a two-part "parcel".
            const { rows: parcels } = await client.query(`
                WITH b AS (SELECT (g->>'id')::int AS id,
                                  ST_Transform(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(g->'geometry')::geometry, 4326)), 3765) AS g
                           FROM jsonb_array_elements($1::jsonb) g),
                pts AS (SELECT b.id, (ST_DumpPoints(ST_Segmentize(ST_Boundary(b.g), $2::float8))).geom AS p FROM b),
                cells AS (SELECT (ST_Dump(ST_VoronoiPolygons(ST_Collect(p), 0,
                                    ST_Expand((SELECT ST_Collect(p) FROM pts), 400)))).geom AS cell FROM pts),
                owned AS (SELECT pts.id, cells.cell FROM cells JOIN pts ON ST_Intersects(cells.cell, pts.p)),
                region AS (SELECT id, ST_UnaryUnion(ST_Collect(cell)) AS g FROM owned GROUP BY id),
                share AS (SELECT b.id, b.g AS building,
                                 ST_CollectionExtract(ST_Intersection(region.g, fixture.free), 3) AS g
                          FROM b JOIN region ON region.id = b.id, fixture),
                -- The parcel is an INTERSECTION of the margin with (share ∪ building) — those two
                -- overlap heavily, so that union is safe, unlike welding on a fragment that only
                -- touches. Whatever comes out, the piece holding the building is the parcel: the
                -- building is connected and lies wholly inside, so exactly one piece holds it.
                base AS (SELECT id, building, g AS share, ST_Union(g, building) AS g FROM share),
                cut AS (SELECT id, building, share,
                               (ST_Dump(ST_CollectionExtract(ST_Intersection(base.g, ST_Buffer(base.building, $3::float8)), 3))).geom AS g
                        FROM base),
                parcel AS (SELECT DISTINCT ON (id) id, building, share, g
                           FROM cut ORDER BY id, ST_Area(ST_Intersection(g, building)) DESC),
                -- what is left of the share, and whether it is worth a parcel of its own
                -- What the margin leaves behind, piece by piece. Only pieces big enough to be a
                -- parcel become open ground; the crescents and wedges the margin arc shaves off go
                -- back to the building parcel — by DIFFERENCE, never by welding them on, so no
                -- hairline gap can split the result in two.
                restparts AS (SELECT id, (ST_Dump(ST_CollectionExtract(ST_Difference(share, g), 3))).geom AS g
                              FROM parcel),
                bigrest AS (SELECT id, ST_UnaryUnion(ST_Collect(g)) AS g FROM restparts
                            WHERE ST_Area(g) >= $4::float8 GROUP BY id),
                widened AS (SELECT parcel.id, parcel.building, parcel.share,
                                   CASE WHEN bigrest.g IS NULL THEN parcel.share
                                        ELSE ST_CollectionExtract(ST_Difference(parcel.share, bigrest.g), 3) END AS g,
                                   bigrest.g AS rest
                            FROM parcel LEFT JOIN bigrest ON bigrest.id = parcel.id),
                -- the parcel is the piece the building stands in; any other piece of the widened
                -- share is open ground in its own right, so nothing is dropped
                pick AS (SELECT DISTINCT ON (id) id, building, g AS parcel, rest, share
                         FROM (SELECT id, building, rest, share, (ST_Dump(g)).geom AS g FROM widened) x
                         ORDER BY id, ST_Area(ST_Intersection(g, building)) DESC),
                final AS (SELECT id, building, parcel,
                                 ST_CollectionExtract(ST_Difference(share, parcel), 3) AS rest
                          FROM pick)
                SELECT id, round(ST_Area(building)::numeric, 0) AS building_m2,
                       round(ST_Area(parcel)::numeric, 0) AS parcel_m2,
                       (SELECT count(*) FROM ST_Dump(parcel) d WHERE ST_Area(d.geom) > 1) AS parcel_parts,
                       round(COALESCE(ST_Area(rest), 0)::numeric, 0) AS open_m2,
                       (SELECT count(*) FROM ST_Dump(rest) d WHERE ST_Area(d.geom) > 1) AS open_parts,
                       ST_AsGeoJSON(ST_Transform(parcel, 4326), $5) AS parcel_geojson,
                       CASE WHEN rest IS NULL OR ST_IsEmpty(rest) THEN NULL
                            ELSE ST_AsGeoJSON(ST_Transform(rest, 4326), $5) END AS open_geojson
                FROM final ORDER BY id`,
            [JSON.stringify(buildings), SEED_SPACING_M, CURTILAGE_MARGIN_M, MIN_OPEN_PARCEL_M2, GEOJSON_DIGITS]);

            const broken = parcels.filter(row => Number(row.parcel_parts) !== 1);
            if (broken.length) throw new Error(`surrounding parcel(s) came out in pieces: ${broken.map(r => r.id).join(', ')} — not written`);
            parcels.forEach(row => console.log(`  #${row.id} building ${fmt(row.building_m2)} m² -> parcel ${fmt(row.parcel_m2)} m²`
                + (Number(row.open_m2) ? `  + ${fmt(row.open_m2)} m² open ground` + (Number(row.open_parts) > 1 ? ` in ${row.open_parts} pieces` : '') : '')));
            // Open ground is emitted per piece, so each is one connected parcel.
            const open = [];
            for (const row of parcels) {
                if (!row.open_geojson) continue;
                const { rows: pieces } = await client.query(`
                    SELECT round(ST_Area(d.geom)::numeric, 0) AS m2, ST_AsGeoJSON(ST_Transform(d.geom, 4326), $2) AS geojson
                    FROM ST_Dump(ST_Transform(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($1)::geometry, 4326)), 3765)) d
                    WHERE ST_Area(d.geom) > 1 ORDER BY ST_Area(d.geom) DESC`, [row.open_geojson, GEOJSON_DIGITS]);
                pieces.forEach(piece => open.push(piece));
            }
            console.log(`  open ground: ${open.length} parcel(s) — ${open.map(o => fmt(o.m2)).join(', ')} m²`);

            // The new plot list, in the plan's own shape. Owner/percent are carried from the plot
            // each parcel came out of, so ownership survives the recut.
            const ownerOf = (geojson) => {
                const first = authoredPlots[0] || {};
                return { ownerKey: first.ownerKey || null, displayName: first.displayName || null, color: first.color || null };
            };
            const rebuiltPlots = [
                ...parcels.map(row => ({ ...ownerOf(), geometry: JSON.parse(row.parcel_geojson) })),
                ...parks.map(entry => ({ ...ownerOf(), geometry: entry.geometry })),
                ...roads.map(geometry => ({ ...ownerOf(), geometry })),
                ...open.map(row => ({ ...ownerOf(), geometry: JSON.parse(row.geojson) }))
            ];
            console.log(`  plots ${authoredPlots.length} -> ${rebuiltPlots.length}`
                + ` (${parcels.length} building, ${parks.length} park, ${roads.length} street, ${open.length} open)`);
            planRecord.reparcellization = {
                ...planRecord.reparcellization,
                polygons: rebuiltPlots,
                rebuiltBy: REPARCEL_MARK
            };
            reparcelled = true;
        }

        // --- 2. anchors (after the clip, so a road anchors to the ground it keeps) ---------------------------------------------------------------------
        console.log('ANCHORS');
        const anchorWrites = [];
        for (const row of rows) {
            const data = row.effective;
            const declared = Array.isArray(data.parentParcelIds) ? data.parentParcelIds.map(String) : [];
            const geometries = footprintGeometries(data);
            let covers;
            if (geometries.length) {
                const { rows: [hit] } = await client.query(`
                    WITH fp AS (SELECT ST_UnaryUnion(ST_Collect(ST_Transform(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(g)::geometry, 4326)), 3765))) AS g
                                FROM jsonb_array_elements($1::jsonb) AS g)
                    SELECT COALESCE(array_agg('HR-' || p.maticni_broj_ko || '-' || p.broj_cestice
                                              ORDER BY ST_Area(ST_Intersection(fp.g, p.geom)) DESC), '{}') AS covers
                    FROM fp LEFT JOIN public.parcel p
                      ON p.current AND p.geom && fp.g AND ST_Area(ST_Intersection(fp.g, p.geom)) >= $2`,
                [JSON.stringify(geometries), MIN_INTERSECTION_M2]);
                covers = hit.covers || [];
            } else {
                // A road whose corridor is still derived at apply time: measure the centerline
                // buffered at half-width, the same construction the app cuts with.
                const definition = data.roadProposal && data.roadProposal.definition;
                const centerline = corridorCenterline(definition);
                const width = Number(definition && definition.width);
                if (!centerline || !Number.isFinite(width) || width <= 0) { console.log(`  #${row.id} no geometry — skipped`); continue; }
                const { rows: [hit] } = await client.query(`
                    WITH fp AS (SELECT ST_Buffer(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1)::geometry, 4326), 3765), $2::float8, 'endcap=flat join=mitre') AS g)
                    SELECT COALESCE(array_agg('HR-' || p.maticni_broj_ko || '-' || p.broj_cestice
                                              ORDER BY ST_Area(ST_Intersection(fp.g, p.geom)) DESC), '{}') AS covers
                    FROM fp LEFT JOIN public.parcel p
                      ON p.current AND p.geom && fp.g AND ST_Area(ST_Intersection(fp.g, p.geom)) >= $3`,
                [JSON.stringify(centerline), width / 2, MIN_INTERSECTION_M2]);
                covers = hit.covers || [];
            }
            if (!covers.length) { console.log(`  #${row.id} covers no current parcel — left alone`); continue; }
            // Anchors live in FOUR places on one row — parentParcelIds, cadastreParcelIds, and each
            // sub-record's own parentParcelIds, each mirrored into a column. "Correct" means all of
            // them agree; checking only the first left cadastre_parcel_ids pointing at the old
            // parcel, which is the list the next migration reads.
            const anchorLists = [data.parentParcelIds, data.cadastreParcelIds];
            SUB_KEYS.forEach(key => {
                const sub = data[key];
                if (sub && typeof sub === 'object' && !Array.isArray(sub) && Array.isArray(sub.parentParcelIds)) {
                    anchorLists.push(sub.parentParcelIds);
                }
            });
            if (anchorLists.every(list => sameSet(list, covers))) {
                console.log(`  #${row.id} already correct (${covers.length} parcel(s))`);
                continue;
            }
            console.log(`  #${row.id} ${declared.length} declared -> ${covers.length} covered` +
                (covers.length <= 3 ? `  [${covers.join(', ')}]` : `  [${covers.slice(0, 3).join(', ')}, …]`));
            anchorWrites.push({ id: row.id, covers });
        }

        if (!apply) {
            console.log(`\nDRY RUN — ${roadWrites.length} corridor(s), ${bodyWrites.length} neighbour(s), `
                + `${anchorWrites.length} anchor rewrite(s), ${renameWrites.length} rename(s)`
                + `${restored ? ', plan restored' : ''}${reparcelled ? ', plots rebuilt' : ''}. Re-run with --apply.`);
            await client.query('ROLLBACK');
            return;
        }

        for (const write of anchorWrites) {
            const data = byId.get(write.id).effective;
            data.parentParcelIds = write.covers.slice();
            data.cadastreParcelIds = write.covers.slice();
            SUB_KEYS.forEach(key => {
                const sub = data[key];
                if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return;
                if (Array.isArray(sub.parentParcelIds)) sub.parentParcelIds = write.covers.slice();
            });
        }
        // roadWrites already seated their polygon on the effective record (the anchor pass read it).
        const touched = Array.from(new Set([
            ...anchorWrites.map(w => w.id), ...roadWrites.map(w => w.id),
            ...bodyWrites.map(w => w.id), ...renameWrites.map(w => w.id),
            ...(restored || reparcelled ? [READJUSTMENT_ID] : [])
        ]));
        for (const id of touched) {
            const row = byId.get(id);
            const data = row.effective;
            // Mirror columns are only rewritten where they already exist: creating one would move a
            // row's source of truth, which is a different change from repairing its contents.
            await client.query(`
                UPDATE public.proposal SET
                    proposal_data = $2,
                    ancestor_parcel_ids = $3,
                    cadastre_parcel_ids = $3,
                    road_proposal = CASE WHEN road_proposal IS NULL THEN NULL ELSE $4::jsonb END,
                    building_proposal = CASE WHEN building_proposal IS NULL THEN NULL ELSE $5::jsonb END,
                    structure_proposal = CASE WHEN structure_proposal IS NULL THEN NULL ELSE $6::jsonb END,
                    reparcellization = CASE WHEN reparcellization IS NULL THEN NULL ELSE $7::jsonb END,
                    title = COALESCE($8, title),
                    name = COALESCE($9, name),
                    updated_at = now()
                WHERE id = $1`,
            [id, JSON.stringify(data), JSON.stringify(data.parentParcelIds || []),
                data.roadProposal ? JSON.stringify(data.roadProposal) : null,
                data.buildingProposal ? JSON.stringify(data.buildingProposal) : null,
                data.structureProposal ? JSON.stringify(data.structureProposal) : null,
                data.reparcellization ? JSON.stringify(data.reparcellization) : null,
                typeof data.title === 'string' ? data.title : null,
                typeof data.name === 'string' ? data.name : null]);
        }
        await client.query('COMMIT');
        console.log(`\n${touched.length} row(s) written: ${touched.join(', ')}`);
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) { }
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch(error => { console.error(String(error.message || error)); process.exit(1); });
